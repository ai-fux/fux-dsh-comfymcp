/**
 * Boots the FUX runtime with `@fux-mcp/comfy-client` for the MCP host.
 *
 * Booting never touches the network: the client plugin connects on first call,
 * so an unreachable comfy-mcp endpoint is a call-time error, never a boot-time
 * failure. The in-process host re-throws handler exceptions untouched so the
 * caller sees the client plugin's own `E_MCP_*` codes instead of a flattened
 * `E_PLUGIN_ERROR`.
 */
import { manifest as clientManifest, plugin as clientPlugin, resolveConfig } from '@fux-mcp/comfy-client'
import type { ComfyMcpClientConfig } from '@fux-mcp/comfy-client'
import { FuxCore } from '@fux/core'
import type { PluginState } from '@fux/core'
import { ipcFail, ipcOk, newRequestId } from '@fux/protocol'
import type { ExecutionMode, IpcResponse, PluginManifest } from '@fux/protocol'
import { ProvideUndeclaredError, Supervisor } from '@fux/runtime'
import type { CapabilityHandler, FuxPluginModule, PluginContext, PluginHost, PluginHostDeps } from '@fux/runtime'

export const PRODUCT_ID = '@fux-mcp/mcp-host'
export const PRODUCT_NAME = 'FUX comfy-mcp host'
export const PRODUCT_VERSION = '0.1.0'

/** Per-call tool budget when nothing overrides it. */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 120000

export interface HostConfig extends ComfyMcpClientConfig {
  readonly toolCallTimeoutMs: number
}

export interface BootRuntimeOptions {
  /** Highest-precedence plugin config overrides (tests). */
  readonly overrides?: Readonly<Record<string, unknown>>
  /** Environment to read; defaults to `process.env`. Pass `{}` for isolation. */
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly toolCallTimeoutMs?: number
}

export interface BootedRuntime {
  readonly config: HostConfig
  readonly runtime: Awaited<ReturnType<Supervisor['start']>>
  /** Invoke one `mcp-comfy:*` capability as the framework caller. */
  call<T = unknown>(capability: string, payload?: unknown): Promise<T>
  stop(): Promise<void>
}

/**
 * Error-preserving in-process host: a faithful copy of the platform host whose
 * single difference is rethrowing handler exceptions untouched (see the
 * sibling product's rationale — codes and structured detail survive).
 */
class ErrorPreservingInProcessHost implements PluginHost {
  readonly pluginId: string
  readonly mode: ExecutionMode = 'in_process'

  private readonly manifest: PluginManifest
  private readonly config: Record<string, unknown>
  private readonly deps: PluginHostDeps
  private readonly module: FuxPluginModule
  private readonly handlers = new Map<string, CapabilityHandler>()
  private state: PluginState = 'registered'

  constructor(
    manifest: PluginManifest,
    config: Record<string, unknown>,
    deps: PluginHostDeps,
    module: FuxPluginModule,
  ) {
    this.manifest = manifest
    this.config = config
    this.deps = deps
    this.module = module
    this.pluginId = manifest.id
  }

  async start(): Promise<void> {
    if (this.state === 'started') throw new Error(`host for ${this.pluginId} already started`)
    this.state = 'starting'
    try {
      await this.module.activate(this.context())
      this.state = 'started'
    } catch (error) {
      this.state = 'broken'
      throw error
    }
  }

  async stop(): Promise<void> {
    if (this.state !== 'started') return
    this.state = 'stopping'
    try {
      await this.module.deactivate?.()
    } finally {
      this.handlers.clear()
      this.state = 'stopped'
    }
  }

  status(): PluginState {
    return this.state
  }

  async invoke(capability: string, payload?: unknown): Promise<IpcResponse> {
    if (this.state !== 'started') {
      return ipcFail(newRequestId(), 'E_PLUGIN_CRASHED', `plugin "${this.pluginId}" is not running`, true)
    }
    const handler = this.handlers.get(capability)
    if (handler === undefined) {
      return ipcFail(
        newRequestId(),
        'E_CAPABILITY_NOT_FOUND',
        `capability "${capability}" is declared but not provided at runtime by "${this.pluginId}"`,
      )
    }
    const result = await handler(payload)
    return ipcOk(newRequestId(), result)
  }

  providedCapabilities(): string[] {
    return [...this.handlers.keys()]
  }

  private context(): PluginContext {
    const deps = this.deps
    return {
      pluginId: this.pluginId,
      config: this.config,
      provide: (capability, handler) => this.provide(capability, handler),
      call: <T>(capability: string, payload?: unknown) => deps.broker.call<T>(this.pluginId, capability, payload),
      events: {
        on: (topic, handler) => deps.events.on(topic, handler),
        emit: (topic, payload) => deps.events.emit(topic, payload, this.pluginId),
      },
    }
  }

  private provide(capability: string, handler: CapabilityHandler): void {
    if (!this.manifest.capabilities.some((entry) => entry.name === capability)) {
      throw new ProvideUndeclaredError(this.pluginId, capability)
    }
    if (this.handlers.has(capability)) {
      throw new Error(`plugin "${this.pluginId}" provided "${capability}" twice`)
    }
    this.handlers.set(capability, handler)
  }
}

/** Compose and start the product, then expose one call seam. */
export async function bootRuntime(options: BootRuntimeOptions = {}): Promise<BootedRuntime> {
  const env = options.env ?? process.env
  const pluginConfig = resolveConfig(
    { ...(options.overrides ?? {}) },
    env as Record<string, string | undefined>,
  ) as unknown as Record<string, unknown>
  const config: HostConfig = {
    ...pluginConfig,
    toolCallTimeoutMs: options.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS,
  } as HostConfig

  const core = new FuxCore()
  core.register(clientManifest)
  const { graph } = core.compose({
    id: PRODUCT_ID,
    name: PRODUCT_NAME,
    version: PRODUCT_VERSION,
    profile: 'dev',
    plugins: [
      {
        id: clientManifest.id,
        enabled: true,
        config: { ...pluginConfig },
      },
    ],
  })

  const supervisor = new Supervisor(core.events, {
    hostFactory: (manifest, pluginRuntimeConfig, deps) =>
      manifest.id === clientManifest.id
        ? new ErrorPreservingInProcessHost(manifest, pluginRuntimeConfig, deps, clientPlugin)
        : undefined,
  })

  const runtime = await supervisor.start(graph, (pluginId) => {
    if (pluginId === clientManifest.id) return clientPlugin
    throw new Error(`no plugin module is registered for "${pluginId}"`)
  })

  let stopped = false
  return {
    config,
    runtime,
    call: <T>(capability: string, payload?: unknown) => runtime.callAsSystem<T>(capability, payload),
    stop: async () => {
      if (stopped) return
      stopped = true
      await runtime.stop()
    },
  }
}

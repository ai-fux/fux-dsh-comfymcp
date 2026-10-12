import { ipcFail, ipcOk, newRequestId } from '@fux/protocol'
import type { IpcErrorCode, IpcResponse, PluginManifest } from '@fux/protocol'
import type { EventBus, PluginState } from '@fux/core'
import { SandboxRuntime } from './sandbox-runtime.js'
import type { SandboxApi, SandboxScript } from './sandbox-runtime.js'
import { ProvideUndeclaredError } from './errors.js'
import type { CapabilityBroker } from './broker.js'
import type { PluginHost } from './types.js'

export interface SandboxHostOptions {
  /** Shared broker; a sandboxed handler's context.call routes through it with full permission checks. */
  broker: CapabilityBroker
  /** Shared event bus; a sandboxed handler's emit() surfaces here with the plugin as source. */
  events: EventBus
  /** capability -> handler source. Each is compiled into its own isolated vm context. */
  handlers: Record<string, string>
  /** Per-invocation budget (ms). Default 1000. */
  timeoutMs?: number
}

/**
 * G3: a `PluginHost` that runs a plugin's handlers as untrusted source inside a
 * `SandboxRuntime` (L2 `node:vm` boundary) instead of importing a module. It is
 * presented as `in_process` — the restricted context lives in the current process
 * and speaks the same `PluginHost` contract — so no protocol/execution-mode change
 * is needed. The host only *creates* the surface (`broker`, `events`, a frozen
 * JSON-safe `config`); all code under execution is constrained by the runtime.
 */
export class SandboxHost implements PluginHost {
  readonly mode = 'in_process' as const
  readonly pluginId: string

  private readonly manifest: PluginManifest
  private readonly config: Record<string, unknown>
  private readonly options: SandboxHostOptions
  private readonly scripts = new Map<string, SandboxScript>()
  private state: PluginState = 'registered'

  constructor(
    manifest: PluginManifest,
    config: Record<string, unknown>,
    options: SandboxHostOptions,
  ) {
    this.manifest = manifest
    this.pluginId = manifest.id
    this.config = config
    this.options = options
  }

  async start(): Promise<void> {
    if (this.state === 'started' || this.state === 'starting') return
    this.state = 'starting'
    try {
      const runtime = new SandboxRuntime({ timeoutMs: this.options.timeoutMs })
      const api = this.buildApi()
      for (const [capability, source] of Object.entries(this.options.handlers)) {
        if (!this.manifest.capabilities.some((c) => c.name === capability)) {
          throw new ProvideUndeclaredError(this.pluginId, capability)
        }
        this.scripts.set(capability, runtime.load(source, api))
      }
    } catch (error) {
      this.state = 'broken'
      throw error
    }
    this.state = 'started'
  }

  async stop(): Promise<void> {
    if (this.state !== 'started') return
    this.state = 'stopping'
    for (const script of this.scripts.values()) script.dispose()
    this.scripts.clear()
    this.state = 'stopped'
  }

  status(): PluginState {
    return this.state
  }

  async invoke(capability: string, payload?: unknown): Promise<IpcResponse> {
    if (this.state !== 'started') {
      return ipcFail(
        newRequestId(),
        'E_PLUGIN_CRASHED',
        `plugin "${this.pluginId}" is not running`,
        true,
      )
    }
    const script = this.scripts.get(capability)
    if (!script) {
      return ipcFail(
        newRequestId(),
        'E_CAPABILITY_NOT_FOUND',
        `capability "${capability}" has no sandboxed handler for "${this.pluginId}"`,
      )
    }
    try {
      const result = await script.run(payload)
      return ipcOk(newRequestId(), result)
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      const code = (error as { code?: string })?.code
      const retryable = (error as { retryable?: boolean })?.retryable ?? false
      // The wire envelope keeps the closed protocol error codes (FUX_PROTOCOL_VERSION
      // is frozen); the sandbox-specific code rides along in the message.
      const ipcCode: IpcErrorCode =
        code === 'E_SANDBOX_TIMEOUT' && retryable ? 'E_TIMEOUT' : 'E_PLUGIN_ERROR'
      return ipcFail(
        newRequestId(),
        ipcCode,
        code && code !== ipcCode ? `${code}: ${err.message}` : err.message,
        retryable,
      )
    }
  }

  providedCapabilities(): string[] {
    return [...this.scripts.keys()]
  }

  private buildApi(): SandboxApi {
    return {
      call: <T>(capability: string, payload?: unknown) =>
        this.options.broker.call<T>(this.pluginId, capability, payload),
      emit: (topic: string, payload?: unknown) => {
        this.options.events.emit(topic, payload, this.pluginId)
      },
      // Frozen JSON-safe copy: the sandbox reads its config, never mutates it.
      config: freezeDeep(cloneJsonSafe(this.config)) as Readonly<Record<string, unknown>>,
    }
  }
}

function cloneJsonSafe(value: unknown): Record<string, unknown> {
  const raw: unknown = typeof value === 'object' && value !== null ? value : { value }
  return JSON.parse(JSON.stringify(raw)) as Record<string, unknown>
}

function freezeDeep(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value
  if (Array.isArray(value)) {
    for (const item of value) freezeDeep(item)
    return Object.freeze(value)
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) freezeDeep(record[key])
  return Object.freeze(record)
}

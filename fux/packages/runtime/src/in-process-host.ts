import { ipcFail, ipcOk, newRequestId } from '@fux/protocol'
import type { ExecutionMode, IpcResponse, PluginManifest } from '@fux/protocol'
import type { EventBus, PluginState } from '@fux/core'
import { ProvideUndeclaredError } from './errors.js'
import type { HealthRegistry } from './health.js'
import type { CapabilityHandler, ModuleLoader, PluginContext, PluginHost } from './types.js'
import type { CapabilityBroker } from './broker.js'

export interface InProcessHostDeps {
  broker: CapabilityBroker
  events: EventBus
  // FR-02: optional health collection. Absent, context.health is undefined and
  // a plugin that never touches it is unaffected.
  health?: HealthRegistry
}

export class InProcessHost implements PluginHost {
  readonly mode: ExecutionMode = 'in_process'
  readonly pluginId: string

  private readonly manifest: PluginManifest
  private readonly config: Record<string, unknown>
  private readonly loader: ModuleLoader
  private readonly deps: InProcessHostDeps
  private readonly handlers = new Map<string, CapabilityHandler>()
  private module: { deactivate?(): Promise<void> | void } | null = null
  private state: PluginState = 'registered'

  constructor(
    manifest: PluginManifest,
    config: Record<string, unknown>,
    loader: ModuleLoader,
    deps: InProcessHostDeps,
  ) {
    this.manifest = manifest
    this.pluginId = manifest.id
    this.config = config
    this.loader = loader
    this.deps = deps
  }

  async start(): Promise<void> {
    if (this.state === 'started') throw new Error(`host for ${this.pluginId} already started`)
    this.state = 'starting'
    const pluginModule = await this.loader()

    const context: PluginContext = {
      pluginId: this.pluginId,
      config: this.config,
      provide: (capability, handler) => this.provide(capability, handler),
      call: <T>(capability: string, payload?: unknown) =>
        this.deps.broker.call<T>(this.pluginId, capability, payload),
      events: {
        on: (topic, handler) => this.deps.events.on(topic, handler),
        emit: (topic, payload) => this.deps.events.emit(topic, payload, this.pluginId),
      },
      ...(this.deps.health
        ? {
            health: {
              report: (status, detail) => this.deps.health!.report(this.pluginId, status, detail),
              provide: (provider) => this.deps.health!.provide(this.pluginId, provider),
            },
          }
        : {}),
    }

    await pluginModule.activate(context)
    this.module = pluginModule
    this.state = 'started'
  }

  async stop(): Promise<void> {
    if (this.state !== 'started') return
    this.state = 'stopping'
    await this.module?.deactivate?.()
    this.handlers.clear()
    this.module = null
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
    const handler = this.handlers.get(capability)
    if (!handler) {
      return ipcFail(
        newRequestId(),
        'E_CAPABILITY_NOT_FOUND',
        `capability "${capability}" is declared but not provided at runtime by "${this.pluginId}"`,
      )
    }
    try {
      const result = await handler(payload)
      return ipcOk(newRequestId(), result)
    } catch (error) {
      return ipcFail(
        newRequestId(),
        'E_PLUGIN_ERROR',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  providedCapabilities(): string[] {
    return [...this.handlers.keys()]
  }

  private provide(capability: string, handler: CapabilityHandler): void {
    if (!this.manifest.capabilities.some((c) => c.name === capability)) {
      throw new ProvideUndeclaredError(this.pluginId, capability)
    }
    if (this.handlers.has(capability)) {
      throw new Error(`plugin "${this.pluginId}" provided "${capability}" twice`)
    }
    this.handlers.set(capability, handler)
  }
}

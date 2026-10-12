import { EventBus } from '@fux/core'
import { ipcFail, ipcOk, newRequestId } from '@fux/protocol'
import type { IpcResponse, PluginManifest } from '@fux/protocol'
import { ProvideUndeclaredError } from './errors.js'
import type { WorkerMessage } from './worker-host.js'
import type { FuxPluginModule, PluginContext } from './types.js'

/**
 * G1: the child-side brain of a `worker` execution host. It activates a plugin
 * module inside the worker, exposes the standard `PluginContext` (provide / call /
 * events), and answers `invoke` requests from the parent over a `WorkerMessage`
 * channel. Event and cross-capability traffic is forwarded to the parent, which
 * owns the shared broker/event-bus.
 */
export interface WorkerRuntimeOptions {
  /** Deliver a child->parent message (e.g. `process.send` or an in-process route). */
  send: (message: WorkerMessage) => void
  /** Load the plugin module on this side (e.g. `import(moduleRef)` or a loader). */
  load: (moduleRef?: string) => FuxPluginModule | Promise<FuxPluginModule>
}

export class WorkerRuntime {
  private readonly send: WorkerRuntimeOptions['send']
  private readonly load: WorkerRuntimeOptions['load']
  private readonly localEvents = new EventBus()
  private handlers = new Map<string, (payload: unknown) => unknown | Promise<unknown>>()
  private module: { deactivate?(): Promise<void> | void } | null = null
  private pendingCalls = new Map<string, (response: IpcResponse) => void>()
  private active = false

  constructor(options: WorkerRuntimeOptions) {
    this.send = options.send
    this.load = options.load
  }

  /** Dispatch an incoming parent->child message. */
  async dispatch(message: WorkerMessage): Promise<void> {
    switch (message.type) {
      case 'init':
        await this.activate(message.manifest, message.config, message.moduleRef)
        break
      case 'invoke':
        void this.invoke(message.id, message.capability, message.payload)
        break
      case 'stop':
        await this.deactivate()
        this.send({ type: 'stopped' })
        break
      case 'callResponse': {
        const resolve = this.pendingCalls.get(message.id)
        if (resolve) {
          this.pendingCalls.delete(message.id)
          resolve(message.response)
        }
        break
      }
      default:
        break
    }
  }

  private async activate(
    manifest: PluginManifest,
    config: Record<string, unknown>,
    moduleRef?: string,
  ): Promise<void> {
    try {
      const context: PluginContext = {
        pluginId: manifest.id,
        config,
        provide: (capability, handler) => this.provide(manifest, capability, handler),
        call: <T>(capability: string, payload?: unknown) =>
          this.call<T>(capability, payload) as Promise<T>,
        // Worker-internal event subscription is local-only: events the plugin
        // emits are echoed to the parent bus too, but the worker cannot observe
        // the parent's full bus. `emit` is bridged; `on` is deliberately scoped.
        events: {
          on: (topic, handler) => this.localEvents.on(topic, handler),
          emit: (topic, payload) => {
            this.localEvents.emit(topic, payload, manifest.id)
            this.send({ type: 'event', topic, payload })
          },
        },
      }
      const module = await this.load(moduleRef)
      await module.activate(context)
      this.module = module
      this.active = true
      this.send({ type: 'started', capabilities: this.capabilitiesOf(manifest) })
    } catch (error) {
      this.send({
        type: 'startFailed',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private capabilitiesOf(manifest: PluginManifest): string[] {
    const declared = new Set(manifest.capabilities.map((c) => c.name))
    return [...this.handlers.keys()].filter((name) => declared.has(name))
  }

  private provide(
    manifest: PluginManifest,
    capability: string,
    handler: (payload: unknown) => unknown | Promise<unknown>,
  ): void {
    if (!manifest.capabilities.some((c) => c.name === capability)) {
      throw new ProvideUndeclaredError(manifest.id, capability)
    }
    if (this.handlers.has(capability)) {
      throw new Error(`plugin "${manifest.id}" provided "${capability}" twice`)
    }
    this.handlers.set(capability, handler)
  }

  private async call<T>(capability: string, payload?: unknown): Promise<unknown> {
    if (!this.active) throw new Error('worker is not active')
    const id = newRequestId()
    const response = await new Promise<IpcResponse>((resolve) => {
      this.pendingCalls.set(id, resolve)
      this.send({ type: 'call', id, capability, payload })
    })
    if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
    return response.result as T
  }

  private async invoke(id: string, capability: string, payload?: unknown): Promise<void> {
    if (!this.active) {
      this.send({
        type: 'response',
        id,
        response: ipcFail(id, 'E_PLUGIN_CRASHED', 'worker is not active', true),
      })
      return
    }
    const handler = this.handlers.get(capability)
    if (!handler) {
      this.send({
        type: 'response',
        id,
        response: ipcFail(
          id,
          'E_CAPABILITY_NOT_FOUND',
          `capability "${capability}" is not provided by this worker`,
        ),
      })
      return
    }
    try {
      const result = await handler(payload)
      this.send({ type: 'response', id, response: ipcOk(id, result) })
    } catch (error) {
      this.send({
        type: 'response',
        id,
        response: ipcFail(
          id,
          'E_PLUGIN_ERROR',
          error instanceof Error ? error.message : String(error),
        ),
      })
    }
  }

  private async deactivate(): Promise<void> {
    if (!this.active) return
    this.active = false
    await this.module?.deactivate?.()
    this.module = null
    this.handlers = new Map()
    for (const [, reject] of this.pendingCalls) {
      reject(ipcFail(newRequestId(), 'E_PLUGIN_CRASHED', 'worker stopped'))
    }
    this.pendingCalls.clear()
  }
}

/**
 * Wire the current Node process as a worker: deliver child->parent messages via
 * `process.send`, load the plugin module through `import(moduleRef)`, and drive
 * the runtime off `process.on('message')`. This is the bootstrap a
 * `NodeWorkerChannel.entry` should `import()`.
 */
export function runNodeWorker(): void {
  const runtime = new WorkerRuntime({
    send: (message) => {
      process.send?.(message)
    },
    load: async (moduleRef) => {
      if (!moduleRef) throw new Error('worker entry requires a plugin moduleRef to import')
      const mod = await import(moduleRef)
      const module: FuxPluginModule =
        'activate' in mod ? mod : (mod as { default?: FuxPluginModule }).default
      if (!module || typeof module.activate !== 'function') {
        throw new Error(`module "${moduleRef}" does not export an activate() plugin`)
      }
      return module
    },
  })
  process.on('message', (message: unknown) => {
    if (isWorkerMessage(message)) void runtime.dispatch(message)
  })
}

export function isWorkerMessage(value: unknown): value is WorkerMessage {
  if (typeof value !== 'object' || value === null) return false
  const t = (value as { type?: unknown }).type
  return (
    typeof t === 'string' &&
    [
      'init',
      'invoke',
      'stop',
      'started',
      'startFailed',
      'response',
      'stopped',
      'event',
      'call',
      'callResponse',
    ].includes(t)
  )
}

import { fork, type ChildProcess } from 'node:child_process'
import { ipcFail, ipcOk, newRequestId } from '@fux/protocol'
import type { ExecutionMode, IpcResponse, PluginManifest } from '@fux/protocol'
import type { EventBus, PluginState } from '@fux/core'
import { CapabilityNotFoundRuntimeError, WorkerSpawnError, WorkerExitError } from './errors.js'
import type { PluginHost } from './types.js'

/**
 * G1: parent <-> child message protocol for a `worker` execution host. A worker
 * plugin runs its `run`/`activate` logic in a separate sub-process; the parent
 * `WorkerHost` speaks this protocol over a `WorkerChannel`, while the child side
 * (`WorkerRuntime` in `worker-runtime.ts`) runs the plugin and replies. The
 * envelope mirrors the in-process IpcRequest/IpcResponse shape so capabilities
 * stay indistinguishable to callers regardless of the execution mode.
 */
export type WorkerMessage =
  // parent -> child
  | { type: 'init'; manifest: PluginManifest; config: Record<string, unknown>; moduleRef?: string }
  | { type: 'invoke'; id: string; capability: string; payload?: unknown }
  | { type: 'stop' }
  // child -> parent
  | { type: 'started'; capabilities: string[] }
  | { type: 'startFailed'; error: string }
  | { type: 'response'; id: string; response: IpcResponse }
  | { type: 'stopped' }
  | { type: 'event'; topic: string; payload?: unknown }
  // child -> parent (cross-capability call) then parent -> child (reply)
  | { type: 'call'; id: string; capability: string; payload?: unknown }
  | { type: 'callResponse'; id: string; response: IpcResponse }

/**
 * The sub-process communication boundary a `WorkerHost` talks over. The default
 * `NodeWorkerChannel` is a real `child_process` fork; `InProcessWorkerChannel`
 * drives the same protocol in the same process (used for tests and single-host
 * demos). Both carry an identical `WorkerMessage` stream, so the host logic is
 * transport-independent.
 */
export interface WorkerChannel {
  readonly kind: 'fork' | 'in_process'
  open(): Promise<void>
  send(message: WorkerMessage): void
  onMessage(handler: (message: WorkerMessage) => void): () => void
  onExit(handler: (code: number | null, signal: string | null, error?: unknown) => void): () => void
  close(): Promise<void>
}

/** Options for a `worker` host. */
export interface WorkerHostOptions {
  /** The channel that connects this host to the worker sub-process. */
  channel: WorkerChannel
  /** The shared core event bus; worker-emitted events are re-emitted here. */
  events: EventBus
  /**
   * How a capability call *made by* the worker (context.call) is resolved. The
   * supervisor wiring passes `(cap, payload) => broker.call(pluginId, cap, payload)`
   * so cross-mode calls keep full permission checking. Absent, such calls fail
   * with a capability-not-found reply.
   */
  call?: (capability: string, payload?: unknown) => Promise<unknown>
  /**
   * For real `child_process` channels: the plugin module file (path/URL) the
   * worker imports. In-process channels load the module directly and ignore this.
   */
  moduleRef?: string
  /**
   * G1 强化: optional — fired when the worker sub-process exits unexpectedly
   * while the host is running (never during a normal `stop()`). The host is
   * marked 'broken' and in-flight invokes fail fast regardless; this hook lets
   * the supervisor also update runtime state.
   */
  onExit?: (reason?: unknown) => void
  /**
   * G1 强化: optional per-invoke budget (ms). When set, an invoke that gets no
   * reply within the budget fails with `E_TIMEOUT` (retryable) instead of
   * hanging forever. Absent — the unchanged default — invokes wait indefinitely.
   */
  invokeTimeoutMs?: number
}

/**
 * G1: parent-side host for `executionMode: 'worker'`. The plugin's `activate`
 * runs inside a sub-process (`WorkerRuntime` on the other end of the channel);
 * the host proxies `invoke()` to it over the channel and forwards worker-emitted
 * events / cross-capability calls. Local `broker` lookups are skipped for calls
 * that originate in the worker (the worker has no direct broker access).
 */
export class WorkerHost implements PluginHost {
  readonly mode: ExecutionMode = 'worker'
  readonly pluginId: string

  private readonly manifest: PluginManifest
  private readonly config: Record<string, unknown>
  private readonly channel: WorkerChannel
  private readonly events: EventBus
  private readonly pending = new Map<string, (response: IpcResponse) => void>()
  private readonly call?: (capability: string, payload?: unknown) => Promise<unknown>
  private readonly moduleRef?: string
  private readonly onExit?: (reason?: unknown) => void
  private readonly invokeTimeoutMs?: number
  private capabilities: string[] = []
  private state: PluginState = 'registered'
  private startedResolve?: (capabilities: string[]) => void
  private startedReject?: (error: unknown) => void
  private stoppedWaiters: Array<() => void> = []
  private unsubs: Array<() => void> = []

  constructor(
    manifest: PluginManifest,
    config: Record<string, unknown>,
    options: WorkerHostOptions,
  ) {
    this.manifest = manifest
    this.pluginId = manifest.id
    this.config = config
    this.channel = options.channel
    this.events = options.events
    this.call = options.call
    this.moduleRef = options.moduleRef
    this.onExit = options.onExit
    this.invokeTimeoutMs = options.invokeTimeoutMs
  }

  async start(): Promise<void> {
    if (this.state === 'started' || this.state === 'starting') return
    this.state = 'starting'

    this.unsubs.push(
      this.channel.onMessage((message) => {
        this.handleMessage(message)
      }),
      this.channel.onExit((_code, _signal, error) => {
        // An exit while stopping/stopped is the normal teardown path — ignore.
        // Any other exit is unexpected: a worker that dies mid-start rejects
        // the start; one that dies while running is marked broken, all
        // in-flight invokes fail fast (no caller hangs on a dead worker) and
        // the supervisor is told via onExit.
        if (this.state === 'stopping' || this.state === 'stopped') return
        if (this.state === 'starting') {
          this.startedReject?.(new WorkerExitError(this.pluginId, _code, _signal))
          if (error) this.startedReject?.(error)
          this.state = 'broken'
          return
        }
        // state === 'started'
        const failed = ipcFail(
          newRequestId(),
          'E_PLUGIN_CRASHED',
          `plugin "${this.pluginId}" worker exited unexpectedly`,
          true,
        )
        for (const [, resolve] of this.pending) resolve(failed)
        this.pending.clear()
        this.capabilities = []
        this.state = 'broken'
        this.onExit?.(error ?? `worker exited with code ${_code}`)
      }),
    )

    const started = new Promise<string[]>((resolve, reject) => {
      this.startedResolve = resolve
      this.startedReject = reject
    })

    try {
      await this.channel.open()
    } catch (error) {
      this.startedReject = undefined
      this.startedResolve = undefined
      this.state = 'broken'
      throw new WorkerSpawnError(this.pluginId, error)
    }

    this.channel.send({
      type: 'init',
      manifest: this.manifest,
      config: this.config,
      ...(this.moduleRef ? { moduleRef: this.moduleRef } : {}),
    })
    try {
      this.capabilities = await started
    } catch (error) {
      this.state = 'broken'
      throw error
    }
    this.state = 'started'
  }

  async stop(): Promise<void> {
    if (this.state !== 'started' && this.state !== 'starting') return
    this.state = 'stopping'
    const done = new Promise<void>((resolve) => this.stoppedWaiters.push(resolve))
    this.channel.send({ type: 'stop' })
    await Promise.race([done, timeout(2000)])
    this.state = 'stopped'
    await this.channel.close()
    for (const unsub of this.unsubs) unsub()
    this.unsubs = []
    this.capabilities = []
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
    if (!this.capabilities.includes(capability)) {
      return ipcFail(
        newRequestId(),
        'E_CAPABILITY_NOT_FOUND',
        `capability "${capability}" is declared but not registered by the worker for "${this.pluginId}"`,
      )
    }
    const id = newRequestId()
    if (this.invokeTimeoutMs === undefined) {
      return new Promise<IpcResponse>((resolve) => {
        this.pending.set(id, resolve)
        this.channel.send({ type: 'invoke', id, capability, payload })
      })
    }
    // Optional per-invoke budget: a worker that never replies times out with a
    // retryable E_TIMEOUT instead of hanging the caller forever. The timer is a
    // no-op once the reply arrives (the entry is already deleted from pending).
    return new Promise<IpcResponse>((resolve) => {
      this.pending.set(id, resolve)
      this.channel.send({ type: 'invoke', id, capability, payload })
      setTimeout(() => {
        if (this.pending.delete(id)) {
          resolve(
            ipcFail(
              id,
              'E_TIMEOUT',
              `worker invoke timed out after ${this.invokeTimeoutMs}ms`,
              true,
            ),
          )
        }
      }, this.invokeTimeoutMs)
    })
  }

  providedCapabilities(): string[] {
    return this.capabilities
  }

  private handleMessage(message: WorkerMessage): void {
    switch (message.type) {
      case 'started':
        this.startedResolve?.(message.capabilities)
        this.startedResolve = undefined
        this.startedReject = undefined
        break
      case 'startFailed':
        this.startedReject?.(new Error(message.error))
        this.startedReject = undefined
        this.startedResolve = undefined
        break
      case 'response': {
        const resolve = this.pending.get(message.id)
        if (resolve) {
          this.pending.delete(message.id)
          resolve(message.response)
        }
        break
      }
      case 'stopped':
        for (const wait of this.stoppedWaiters) wait()
        this.stoppedWaiters = []
        break
      case 'event':
        // Worker-emitted events surface on the shared bus with the plugin as
        // source, so cross-mode subscribers see identical events.
        this.events.emit(message.topic, message.payload, this.pluginId)
        break
      case 'call':
        // A capability call made *by* the worker (context.call). The parent
        // delegates to the broker on the caller's behalf and writes the reply
        // back to the child. Unable to prove permission here without the caller
        // manifest; the broker handles the deny — surfaced as a failed reply.
        void this.forwardCall(message)
        break
      default:
        break
    }
  }

  private async forwardCall(message: Extract<WorkerMessage, { type: 'call' }>): Promise<void> {
    let response: IpcResponse
    try {
      if (!this.call) throw new CapabilityNotFoundRuntimeError(message.capability)
      const value = await this.call(message.capability, message.payload)
      response = ipcOk(message.id, value)
    } catch (error) {
      response = ipcFail(
        message.id,
        error instanceof CapabilityNotFoundRuntimeError
          ? 'E_CAPABILITY_NOT_FOUND'
          : 'E_PLUGIN_ERROR',
        error instanceof Error ? error.message : String(error),
      )
    }
    this.channel.send({ type: 'callResponse', id: message.id, response })
  }
}

function timeout(ms: number): Promise<'timeout'> {
  return new Promise((resolve) => {
    setTimeout(() => resolve('timeout'), ms)
  })
}

/**
 * G1: a `WorkerChannel` backed by a real `child_process.fork`. The caller points
 * `entry` at a bootstrap module (a JS file) that wires `process.send` to the
 * `WorkerRuntime` from `worker-runtime.ts`; the init message then carries the
 * manifest/config so the child can `import()` the plugin module.
 */
export class NodeWorkerChannel implements WorkerChannel {
  readonly kind = 'fork' as const

  private child?: ChildProcess
  private handler?: (message: WorkerMessage) => void
  private exitHandler?: (code: number | null, signal: string | null, error?: unknown) => void

  constructor(private readonly options: { entry: string; argv?: string[]; execArgv?: string[] }) {}

  async open(): Promise<void> {
    try {
      this.child = fork(this.options.entry, this.options.argv, {
        execArgv: this.options.execArgv,
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      })
    } catch (error) {
      throw new WorkerSpawnError('worker', error)
    }
    const child = this.child
    child.on('message', (message: unknown) => {
      if (isWorkerMessage(message)) this.handler?.(message)
    })
    child.on('error', (error) => {
      this.exitHandler?.(null, null, error)
    })
    child.on('exit', (code, signal) => {
      this.exitHandler?.(code, signal)
    })
  }

  send(message: WorkerMessage): void {
    this.child?.send(message)
  }

  onMessage(handler: (message: WorkerMessage) => void): () => void {
    this.handler = handler
    return () => {
      if (this.handler === handler) this.handler = undefined
    }
  }

  onExit(
    handler: (code: number | null, signal: string | null, error?: unknown) => void,
  ): () => void {
    this.exitHandler = handler
    return () => {
      if (this.exitHandler === handler) this.exitHandler = undefined
    }
  }

  async close(): Promise<void> {
    const child = this.child
    this.child = undefined
    if (!child) return
    child.kill()
  }
}

/**
 * G1: a `WorkerChannel` that drives the worker runtime in the same process, but
 * strictly behind the `WorkerMessage` boundary — no shared memory, no direct
 * handler references. This exercises the exact host protocol without spawning a
 * sub-process, keeping the message contract testable in-process.
 */
export class InProcessWorkerChannel implements WorkerChannel {
  readonly kind = 'in_process' as const

  private parentHandler?: (message: WorkerMessage) => void
  private exitHandler?: (code: number | null, signal: string | null, error?: unknown) => void
  private readonly childHandler: (message: WorkerMessage) => void

  constructor(childHandler: (message: WorkerMessage) => void) {
    this.childHandler = childHandler
  }

  async open(): Promise<void> {
    // nothing to open; the worker runtime exists already
  }

  send(message: WorkerMessage): void {
    this.childHandler(message)
  }

  onMessage(handler: (message: WorkerMessage) => void): () => void {
    this.parentHandler = handler
    return () => {
      if (this.parentHandler === handler) this.parentHandler = undefined
    }
  }

  onExit(
    handler: (code: number | null, signal: string | null, error?: unknown) => void,
  ): () => void {
    this.exitHandler = handler
    return () => {
      if (this.exitHandler === handler) this.exitHandler = undefined
    }
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  /** Route a child-side message to the parent (used by the worker runtime). */
  emitToParent(message: WorkerMessage): void {
    this.parentHandler?.(message)
  }

  /** Simulate an unexpected worker crash from the parent's point of view. */
  emitExit(code: number | null, signal: string | null, error?: unknown): void {
    this.exitHandler?.(code, signal, error)
  }
}

function isWorkerMessage(value: unknown): value is WorkerMessage {
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

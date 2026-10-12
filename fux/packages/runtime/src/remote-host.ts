import { newRequestId, ipcFail } from '@fux/protocol'
import type { ExecutionMode, IpcResponse } from '@fux/protocol'
import type { EventBus, PluginState } from '@fux/core'
import type { PluginHost } from './types.js'
import type { RemoteTransport } from './remote-transport.js'

/**
 * G1: parent-side host for `executionMode: 'remote'`. The plugin runs on a remote
 * endpoint reachable through a `RemoteTransport`; this host proxies `invoke()` to
 * that endpoint and mirrors far-side events/capabilities onto the local bus. The
 * host is transport-agnostic — the concrete wire transport is injected.
 */
export interface RemoteHostOptions {
  /** The transport that reaches the remote plugin endpoint. */
  transport: RemoteTransport
  /** The shared core event bus; far-side events are re-emitted here. */
  events: EventBus
  /**
   * The local plugin id recorded as the `source` of forwarded events. Typically
   * the manifest id, so cross-mode subscribers see a consistent source.
   */
  source: string
  /**
   * G1 强化: optional — fired when the transport reports an unexpected
   * disconnect while the host is running (never during a normal `stop()`). The
   * host is marked 'broken' regardless; this hook lets the supervisor update
   * runtime state. Transport must expose `onDisconnect` for this to fire.
   */
  onExit?: (reason?: unknown) => void
  /**
   * G1 强化: optional per-invoke budget (ms). When set, an invoke that gets no
   * reply within the budget fails with `E_TIMEOUT` (retryable) instead of
   * hanging forever. Absent — the unchanged default — invokes wait indefinitely.
   */
  invokeTimeoutMs?: number
}

export class RemoteHost implements PluginHost {
  readonly mode: ExecutionMode = 'remote'
  readonly pluginId: string

  private readonly transport: RemoteTransport
  private readonly events: EventBus
  private readonly source: string
  private readonly onExit?: (reason?: unknown) => void
  private readonly invokeTimeoutMs?: number
  private state: PluginState = 'registered'
  private capabilities: string[] = []
  private unsubs: Array<() => void> = []

  constructor(pluginId: string, options: RemoteHostOptions) {
    this.pluginId = pluginId
    this.transport = options.transport
    this.events = options.events
    this.source = options.source
    this.onExit = options.onExit
    this.invokeTimeoutMs = options.invokeTimeoutMs
  }

  async start(): Promise<void> {
    if (this.state === 'started' || this.state === 'starting') return
    this.state = 'starting'
    this.unsubs.push(
      this.transport.onEvent((event) => this.events.emit(event.topic, event.payload, this.source)),
      this.transport.onCapabilities((caps) => {
        this.capabilities = caps
      }),
    )
    const offDisconnect = this.transport.onDisconnect?.((reason) => {
      // A disconnect during teardown is the normal close path — ignore. Any
      // other disconnect while running marks the host broken and reports it.
      if (this.state === 'stopping' || this.state === 'stopped') return
      if (this.state !== 'started') return
      this.capabilities = []
      this.state = 'broken'
      this.onExit?.(reason)
    })
    if (offDisconnect) this.unsubs.push(offDisconnect)
    await this.transport.open()
    this.state = 'started'
  }

  async stop(): Promise<void> {
    if (this.state !== 'started' && this.state !== 'starting') return
    this.state = 'stopping'
    await this.transport.close()
    for (const unsub of this.unsubs) unsub()
    this.unsubs = []
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
    const id = newRequestId()
    const call = (): Promise<IpcResponse> => this.transport.call({ id, capability, payload })
    if (this.invokeTimeoutMs === undefined) return call()
    const raced = await Promise.race([call(), timeout(this.invokeTimeoutMs)])
    return raced === 'timeout'
      ? ipcFail(id, 'E_TIMEOUT', `remote invoke timed out after ${this.invokeTimeoutMs}ms`, true)
      : raced
  }

  providedCapabilities(): string[] {
    return this.capabilities
  }
}

function timeout(ms: number): Promise<'timeout'> {
  return new Promise((resolve) => {
    setTimeout(() => resolve('timeout'), ms)
  })
}

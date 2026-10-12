import type { Connector } from './connector.js'
import { ConnectorStateError } from './errors.js'
import type {
  ConnectorKind,
  ConnectorLifecycleEvent,
  ConnectorLifecycleHandler,
  ConnectorMessage,
  ConnectorMessageHandler,
  ConnectorUnsubscribe,
  SendResult,
} from './types.js'

/**
 * A transport that delivers nothing outside the process: an in-process
 * pub/sub loopback. It exists to prove the CR-04 contract is implementable and
 * to give tests/demos a concrete connector, not to serve as a real transport.
 */
export interface InMemoryConnectorOptions {
  readonly id: string
  /** Advisory only; the loopback behaves as pub/sub. Default `publish_subscribe`. */
  readonly kind?: ConnectorKind
  /** Emits `'error'` (and surfaces `ok: false`) when `send` is called closed. */
  readonly errorOnClosedSend?: boolean
}

const ANY_CHANNEL = '*'

export class InMemoryConnector implements Connector {
  readonly id: string
  readonly kind: ConnectorKind

  private _state: Connector['state'] = 'idle'
  private readonly subscribers = new Map<string, Set<ConnectorMessageHandler>>()
  private readonly lifecycle = new Map<ConnectorLifecycleEvent, Set<ConnectorLifecycleHandler>>()
  private readonly errorOnClosedSend: boolean

  constructor(options: InMemoryConnectorOptions) {
    this.id = options.id
    this.kind = options.kind ?? 'publish_subscribe'
    this.errorOnClosedSend = options.errorOnClosedSend ?? true
  }

  get state(): Connector['state'] {
    return this._state
  }

  async open(): Promise<void> {
    if (this._state === 'open') return
    if (this._state === 'connecting' || this._state === 'closing') {
      throw new ConnectorStateError(this.id, 'idle|closed', this._state)
    }
    this._state = 'connecting'
    await Promise.resolve()
    this._state = 'open'
    this.emitLifecycle('open')
  }

  async close(): Promise<void> {
    if (this._state === 'closed') return
    if (this._state === 'connecting' || this._state === 'closing') {
      throw new ConnectorStateError(this.id, 'idle|open', this._state)
    }
    this._state = 'closing'
    await Promise.resolve()
    this._state = 'closed'
    this.emitLifecycle('close')
  }

  async send(message: ConnectorMessage): Promise<SendResult> {
    await Promise.resolve()
    if (this._state !== 'open') {
      const error = new ConnectorStateError(this.id, 'open', this._state)
      if (this.errorOnClosedSend) this.emitLifecycle('error', error)
      return { ok: false, id: message.id, error }
    }
    this.deliver(message)
    return { ok: true, id: message.id }
  }

  subscribe(channel: string, handler: ConnectorMessageHandler): ConnectorUnsubscribe {
    let set = this.subscribers.get(channel)
    if (!set) {
      set = new Set()
      this.subscribers.set(channel, set)
    }
    set.add(handler)
    return () => {
      set.delete(handler)
      if (set.size === 0) this.subscribers.delete(channel)
    }
  }

  on(event: ConnectorLifecycleEvent, handler: ConnectorLifecycleHandler): ConnectorUnsubscribe {
    let set = this.lifecycle.get(event)
    if (!set) {
      set = new Set()
      this.lifecycle.set(event, set)
    }
    set.add(handler)
    return () => {
      set.delete(handler)
      if (set.size === 0) this.lifecycle.delete(event)
    }
  }

  /* ---------------- internals ---------------- */

  private deliver(message: ConnectorMessage): void {
    const seen = new Set<ConnectorMessageHandler>()
    // Exact channel subscribers first, then any wildcard subscribers.
    for (const handler of this.subscribers.get(message.channel) ?? []) {
      seen.add(handler)
      handler(message)
    }
    for (const handler of this.subscribers.get(ANY_CHANNEL) ?? []) {
      if (!seen.has(handler)) handler(message)
    }
  }

  private emitLifecycle(event: ConnectorLifecycleEvent, error?: unknown): void {
    for (const handler of this.lifecycle.get(event) ?? []) {
      try {
        handler(error)
      } catch {
        // observers are pure; never break connector lifecycle
      }
    }
  }
}

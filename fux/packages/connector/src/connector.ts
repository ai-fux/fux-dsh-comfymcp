import {
  CONNECTOR_EVENT,
  type ConnectorEvent,
  type ConnectorEventSink,
  type ConnectorEventType,
} from './events.js'
import { ConnectorNotFoundError, DuplicateConnectorError } from './errors.js'
import type { Discoverable, DiscoveryQuery, FuxResource, ResourceKind } from '@fux/protocol'
import type {
  ConnectorKind,
  ConnectorLifecycleEvent,
  ConnectorLifecycleHandler,
  ConnectorMessage,
  ConnectorMessageHandler,
  ConnectorState,
  ConnectorUnsubscribe,
  SendResult,
} from './types.js'

/**
 * CR-04: the contract an external-pathway implementation must satisfy. A
 * concrete transport (HTTP, MQ, WS, gRPC, …) plugs in behind this interface;
 * the framework never owns one. Semantic behavior for each `kind` is the
 * implementation's responsibility.
 */
export interface Connector {
  readonly id: string
  readonly kind: ConnectorKind
  /** Current lifecycle position; driven by open()/close() and internal errors. */
  readonly state: ConnectorState
  open(): Promise<void>
  close(): Promise<void>
  /** Send an outbound message. Never throws — failures return `ok: false`. */
  send(message: ConnectorMessage): Promise<SendResult>
  /** Subscribe to inbound messages on a channel. Returned fn unsubscribes. */
  subscribe(channel: string, handler: ConnectorMessageHandler): ConnectorUnsubscribe
  /** Observe lifecycle events (`open` / `close` / `error`). */
  on(event: ConnectorLifecycleEvent, handler: ConnectorLifecycleHandler): ConnectorUnsubscribe
}

export interface ConnectorRegistryOptions {
  /** Optional destination for framework events (lifecycle + bridged messages). */
  readonly eventSink?: ConnectorEventSink
}

const ANY_EVENT: ConnectorEventType | '*' = '*'

/**
 * CR-04: an additive registry of connectors. A product that never registers a
 * connector is entirely unaffected — this is a pure-sidecar abstraction. The
 * registry re-emits lifecycle events for registered connectors and can bridge
 * inbound message flow to an optional event sink / listener set.
 */
export class ConnectorRegistry {
  private readonly connectors = new Map<string, Connector>()
  private readonly sink?: ConnectorEventSink
  private readonly listeners = new Set<(event: ConnectorEvent) => void>()

  constructor(options: ConnectorRegistryOptions = {}) {
    this.sink = options.eventSink
  }

  register(connector: Connector): void {
    if (this.connectors.has(connector.id)) throw new DuplicateConnectorError(connector.id)
    this.connectors.set(connector.id, connector)
    // Bridge lifecycle events from the connector into the framework channel.
    connector.on('open', () =>
      this.notify({
        type: CONNECTOR_EVENT.OPEN,
        connectorId: connector.id,
        occurredAt: Date.now(),
      }),
    )
    connector.on('close', () =>
      this.notify({
        type: CONNECTOR_EVENT.CLOSE,
        connectorId: connector.id,
        occurredAt: Date.now(),
      }),
    )
    connector.on('error', (error) =>
      this.notify({
        type: CONNECTOR_EVENT.ERROR,
        connectorId: connector.id,
        error,
        occurredAt: Date.now(),
      }),
    )
  }

  unregister(id: string): boolean {
    return this.connectors.delete(id)
  }

  has(id: string): boolean {
    return this.connectors.has(id)
  }

  get(id: string): Connector | undefined {
    return this.connectors.get(id)
  }

  list(): ReadonlyArray<Connector> {
    return [...this.connectors.values()]
  }

  get size(): number {
    return this.connectors.size
  }

  /**
   * BR-02: an optional unified-discovery view over the registered connectors
   * (kind `connector`). Purely additive — `register/list/get` are unchanged.
   */
  asDiscoverable(): Discoverable {
    return new ConnectorDiscovery(this)
  }

  async open(id: string): Promise<void> {
    await this.require(id).open()
  }

  async close(id: string): Promise<void> {
    await this.require(id).close()
  }

  async openAll(): Promise<void> {
    await Promise.all([...this.connectors.values()].map((connector) => connector.open()))
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.connectors.values()].map((connector) => connector.close()))
  }

  async send(id: string, message: ConnectorMessage): Promise<SendResult> {
    // async turns a synchronous not-found throw into a rejection, matching the
    // open()/close() contract (never throw synchronously for a missing id).
    return this.require(id).send(message)
  }

  /**
   * Bridge inbound messages of a connector into the framework event channel
   * (`connector:message`). Opt-in: lifecycle events are always bridged, message
   * flow is only surfaced when a consumer asks for it. Optionally filter to one
   * channel. Returns an unsubscribe.
   */
  bridgeMessages(id: string, channel?: string): ConnectorUnsubscribe {
    const connector = this.require(id)
    const handler: ConnectorMessageHandler = (message) => {
      if (channel !== undefined && message.channel !== channel) return
      this.notify({
        type: CONNECTOR_EVENT.MESSAGE,
        connectorId: id,
        message,
        occurredAt: Date.now(),
      })
    }
    return connector.subscribe(channel ?? ANY_EVENT, handler)
  }

  /**
   * Subscribe to framework events, optionally filtered by type. The returned
   * function unsubscribes. Omitting a filter subscribes to every type.
   */
  on(
    type: ConnectorEventType | '*' | undefined,
    handler: (event: ConnectorEvent) => void,
  ): ConnectorUnsubscribe {
    const wrapped =
      type === undefined || type === ANY_EVENT
        ? handler
        : (event: ConnectorEvent): void => {
            if (event.type === type) handler(event)
          }
    this.listeners.add(wrapped)
    return () => {
      this.listeners.delete(wrapped)
    }
  }

  private require(id: string): Connector {
    const connector = this.connectors.get(id)
    if (!connector) throw new ConnectorNotFoundError(id)
    return connector
  }

  private notify(event: ConnectorEvent): void {
    this.sink?.emit(event)
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // observers are pure and must never break connector dispatch
      }
    }
  }
}

/** BR-02: read-only adapter from a registry of connectors to `Discoverable`. */
class ConnectorDiscovery implements Discoverable {
  private readonly factory: {
    list(): ReadonlyArray<Connector>
  }

  constructor(registry: { list(): ReadonlyArray<Connector> }) {
    this.factory = registry
  }

  discover(query?: DiscoveryQuery): readonly FuxResource[] {
    const kind: ResourceKind = 'connector'
    const entries = this.factory.list().map((connector): FuxResource => ({
      kind,
      id: connector.id,
      status: connector.state,
      entry: connector.kind,
    }))
    if (!query) return entries
    return entries.filter(
      (resource) =>
        (query.kind === undefined || resource.kind === query.kind) &&
        (query.status === undefined || resource.status === query.status) &&
        (query.text === undefined ||
          contains(resource.id, query.text) ||
          (resource.entry !== undefined && contains(resource.entry, query.text))),
    )
  }
}

function contains(value: string, needle: string): boolean {
  return value.toLowerCase().includes(needle.toLowerCase())
}

/**
 * CR-04: shared vocabulary for external-pathway connectors. These are pure
 * types — the connector package owns the *contract*, never a transport.
 */

/** Lifecycle position of a connector. Forwarded/set by the implementation. */
export type ConnectorState = 'idle' | 'connecting' | 'open' | 'closing' | 'closed' | 'error'

/**
 * Semantic classification only. It is advisory metadata for the framework; the
 * concrete send/receive behavior belongs to the implementation.
 */
export type ConnectorKind = 'request_reply' | 'publish_subscribe' | 'stream'

/** Envelope exchanged across an external pathway (outbound or inbound). */
export interface ConnectorMessage<T = unknown> {
  /** Correlation id; stable across reply/ack for request_reply kinds. */
  readonly id: string
  /** Logical channel / topic within the pathway. */
  readonly channel: string
  readonly payload: T
  readonly headers?: Readonly<Record<string, string>>
}

/**
 * Outcome of an outbound `send`. The contract is: `send` never throws — a
 * failure surfaces as `ok: false` (implementation may also emit an `error`
 * lifecycle event).
 */
export type SendResult =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly id: string; readonly error: unknown }

/**
 * Payload envelope the runtime uses when it serves a `request_reply`
 * connector: an inbound request is routed to a capability and the result (or
 * failure) is sent back to the reply channel as one of these. `message.id`
 * carries the correlation id across request and reply.
 */
export type ConnectorReply<T = unknown> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }

/** Lifecycle events a connector may surface to its owner/registry. */
export type ConnectorLifecycleEvent = 'open' | 'close' | 'error'

export type ConnectorUnsubscribe = () => void

/** Inbound-message handler signature for `Connector.subscribe`. */
export type ConnectorMessageHandler = (message: ConnectorMessage) => void

/** Lifecycle handler signature for `Connector.on`. For `'error'` the reason is passed. */
export type ConnectorLifecycleHandler = (error?: unknown) => void

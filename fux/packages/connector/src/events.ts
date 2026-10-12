import type { ConnectorMessage } from './types.js'

/**
 * CR-04: event contract for external-pathway connectors. These are the events
 * the framework defines (and, via `ConnectorRegistry`, re-emits for registered
 * connectors). Topics follow the platform `domain:action` convention.
 * Concrete transports never appear here — they emit these events through the
 * contract.
 */

export const CONNECTOR_EVENT = {
  OPEN: 'connector:open',
  CLOSE: 'connector:close',
  ERROR: 'connector:error',
  MESSAGE: 'connector:message',
} as const

export type ConnectorEventType = (typeof CONNECTOR_EVENT)[keyof typeof CONNECTOR_EVENT]

export interface ConnectorOpenEvent {
  readonly type: typeof CONNECTOR_EVENT.OPEN
  readonly connectorId: string
  readonly occurredAt: number
}

export interface ConnectorCloseEvent {
  readonly type: typeof CONNECTOR_EVENT.CLOSE
  readonly connectorId: string
  readonly occurredAt: number
}

export interface ConnectorErrorEvent {
  readonly type: typeof CONNECTOR_EVENT.ERROR
  readonly connectorId: string
  readonly error: unknown
  readonly occurredAt: number
}

export interface ConnectorMessageEvent<T = unknown> {
  readonly type: typeof CONNECTOR_EVENT.MESSAGE
  readonly connectorId: string
  readonly message: ConnectorMessage<T>
  readonly occurredAt: number
}

/** Discriminated union of every event this framework defines. */
export type ConnectorEvent =
  ConnectorOpenEvent | ConnectorCloseEvent | ConnectorErrorEvent | ConnectorMessageEvent<unknown>

/**
 * Destination for framework events. A runtime (or product) may adapt this to
 * its own event bus; an absent sink just means events stay in-process.
 */
export interface ConnectorEventSink {
  emit(event: ConnectorEvent): void
}

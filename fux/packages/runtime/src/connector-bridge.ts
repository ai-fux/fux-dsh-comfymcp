import type { EventBus } from '@fux/core'
import type { ConnectorEvent, ConnectorEventSink } from '@fux/connector'

/**
 * CR-04 bridge: adapt a connector framework sink onto the `@fux/core` unified
 * event channel. Each `ConnectorEvent` is replayed as a bus event where:
 *  - `topic` is the connector event type (`connector:open`, `connector:close`,
 *    `connector:error`, `connector:message` — all satisfy the IpcEvent topic
 *    grammar), and
 *  - `payload` is the full `ConnectorEvent` (lossless — topic mirrors
 *    `payload.type`), with `source` attributed to the connector id.
 *
 * This is purely additive: nothing in the runtime emits these by default; a
 * sink is only created when a consumer explicitly wants connector events on
 * the shared bus.
 */
export function createConnectorEventSink(events: EventBus): ConnectorEventSink {
  return {
    emit(event: ConnectorEvent): void {
      events.emit(event.type, event, event.connectorId)
    },
  }
}

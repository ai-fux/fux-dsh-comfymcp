import { z } from 'zod'
import type { IpcEvent } from './ipc.js'

/**
 * BR-04: the unified, versioned event payload schema catalog.
 *
 * Consumers of events depend on these schemas instead of an opaque payload.
 * Any *known* event kind publishes a zod schema for its payload; a consumer can
 * resolve `eventPayloadSchemaFor(topic)` and `parse()` the event's payload.
 *
 * Backward compatibility rules:
 *  - Unknown / legacy topics resolve to `undefined` — their payload stays
 *    free-form (`unknown`) and stays readable unchanged.
 *  - `IpcEvent.schemaVersion` is stamped only for known topics (purely
 *    additive; absent means schema v1 / the legacy shape).
 *  - A version bump for a kind keeps old fields and only adds fields.
 */

/** The current unified event payload-schema version for every kind in the catalog. */
export const EVENT_SCHEMA_VERSION = 1

// --- known event kinds: connector pathway (emitted via createConnectorEventSink) ---

const ConnectorEnvelope = z.object({
  type: z.string(),
  connectorId: z.string().min(1).max(200),
  message: z.object({
    id: z.string().min(1).max(200),
    channel: z.string().min(1).max(200),
    payload: z.unknown(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
  occurredAt: z.number().int().nonnegative(),
})

export const ConnectorOpenEventSchema = z.object({
  type: z.literal('connector:open'),
  connectorId: z.string().min(1).max(200),
  occurredAt: z.number().int().nonnegative(),
})

export const ConnectorCloseEventSchema = z.object({
  type: z.literal('connector:close'),
  connectorId: z.string().min(1).max(200),
  occurredAt: z.number().int().nonnegative(),
})

export const ConnectorErrorEventSchema = z.object({
  type: z.literal('connector:error'),
  connectorId: z.string().min(1).max(200),
  error: z.unknown(),
  occurredAt: z.number().int().nonnegative(),
})

export const ConnectorMessageEventSchema = z.object({
  type: z.literal('connector:message'),
  connectorId: z.string().min(1).max(200),
  message: ConnectorEnvelope.shape.message,
  occurredAt: z.number().int().nonnegative(),
})

/** A registered event kind: topic + the payload-schema version stamped on it. */
export interface KnownEventKind {
  /** Topic in `domain:action` form (matches the IpcEvent topic grammar). */
  readonly topic: string
  /** Version stamped onto `IpcEvent.schemaVersion`; absent means v1. */
  readonly version: number
  readonly payloadSchema: z.ZodType<unknown>
}

/** Every payload schema published by the current unified event schema. */
export const EVENT_KINDS: readonly KnownEventKind[] = [
  {
    topic: 'connector:open',
    version: EVENT_SCHEMA_VERSION,
    payloadSchema: ConnectorOpenEventSchema,
  },
  {
    topic: 'connector:close',
    version: EVENT_SCHEMA_VERSION,
    payloadSchema: ConnectorCloseEventSchema,
  },
  {
    topic: 'connector:error',
    version: EVENT_SCHEMA_VERSION,
    payloadSchema: ConnectorErrorEventSchema,
  },
  {
    topic: 'connector:message',
    version: EVENT_SCHEMA_VERSION,
    payloadSchema: ConnectorMessageEventSchema,
  },
]

/**
 * Resolve the published payload schema for a topic, or `undefined` for a
 * legacy / unknown topic (whose payload must be treated as `unknown`).
 */
export function eventPayloadSchemaFor(topic: string): z.ZodType<unknown> | undefined {
  return EVENT_KINDS.find((kind) => kind.topic === topic)?.payloadSchema
}

/**
 * The version to stamp on an event for a known topic, or `undefined` when the
 * topic is not part of the unified schema (stays unstamped = legacy).
 */
export function schemaVersionFor(topic: string): number | undefined {
  return EVENT_KINDS.find((kind) => kind.topic === topic)?.version
}

/** True when `topic` has a published payload schema. */
export function isKnownEventTopic(topic: string): boolean {
  return schemaVersionFor(topic) !== undefined
}

/**
 * Stamp `schemaVersion` onto a known-kind event. Pure and additive: returns the
 * same event when the topic is unknown or the version is already present.
 */
export function stampSchemaVersion(event: IpcEvent): IpcEvent {
  const version = schemaVersionFor(event.topic)
  if (version === undefined || event.schemaVersion !== undefined) return event
  return { ...event, schemaVersion: version }
}

import { describe, expect, it } from 'vitest'
import {
  EVENT_KINDS,
  EVENT_SCHEMA_VERSION,
  ConnectorCloseEventSchema,
  ConnectorErrorEventSchema,
  ConnectorMessageEventSchema,
  ConnectorOpenEventSchema,
  eventPayloadSchemaFor,
  isKnownEventTopic,
  schemaVersionFor,
  stampSchemaVersion,
} from '../src/event-schema.js'

describe('unified event schema catalog (BR-04)', () => {
  it('exports the current schema version', () => {
    expect(EVENT_SCHEMA_VERSION).toBe(1)
    expect(EVENT_KINDS.length).toBeGreaterThan(0)
  })

  it('resolves a payload schema for every known topic', () => {
    for (const kind of EVENT_KINDS) {
      expect(isKnownEventTopic(kind.topic)).toBe(true)
      expect(schemaVersionFor(kind.topic)).toBe(kind.version)
      expect(eventPayloadSchemaFor(kind.topic)).toBe(kind.payloadSchema)
    }
  })

  it('returns undefined for unknown / legacy topics', () => {
    expect(eventPayloadSchemaFor('app:ready')).toBeUndefined()
    expect(schemaVersionFor('greeter:ready')).toBeUndefined()
    expect(isKnownEventTopic('my:pipeline')).toBe(false)
  })

  it('publishes schemas that accept the framework event shapes', () => {
    expect(
      ConnectorOpenEventSchema.parse({ type: 'connector:open', connectorId: 'c1', occurredAt: 1 }),
    ).toMatchObject({ connectorId: 'c1' })
    expect(
      ConnectorCloseEventSchema.parse({
        type: 'connector:close',
        connectorId: 'c1',
        occurredAt: 2,
      }),
    ).toMatchObject({ connectorId: 'c1' })
    expect(
      ConnectorErrorEventSchema.parse({
        type: 'connector:error',
        connectorId: 'c1',
        error: 'boom',
        occurredAt: 3,
      }),
    ).toMatchObject({ error: 'boom' })
    expect(
      ConnectorMessageEventSchema.parse({
        type: 'connector:message',
        connectorId: 'c1',
        message: { id: 'm1', channel: 'in', payload: 42 },
        occurredAt: 4,
      }),
    ).toMatchObject({ connectorId: 'c1' })
  })

  it('rejects payloads that violate a known schema', () => {
    const parsed = ConnectorOpenEventSchema.safeParse({
      type: 'connector:open',
      occurredAt: 1,
    })
    expect(parsed.success).toBe(false)
  })
})

describe('stampSchemaVersion', () => {
  it('stamps the current version onto a known-kind event', () => {
    const stamped = stampSchemaVersion({
      topic: 'connector:open',
      payload: { type: 'connector:open' },
      occurredAt: 5,
    })
    expect(stamped.schemaVersion).toBe(EVENT_SCHEMA_VERSION)
  })

  it('leaves unknown topics unstamped (legacy stays readable)', () => {
    const event: Record<string, unknown> = stampSchemaVersion({
      topic: 'app:ready',
      payload: { ok: true },
      occurredAt: 5,
    })
    expect(event.schemaVersion).toBeUndefined()
  })

  it('does not overwrite an explicit schemaVersion', () => {
    const event = { topic: 'connector:open', schemaVersion: 7, occurredAt: 5 }
    expect(stampSchemaVersion(event)).toBe(event)
  })
})

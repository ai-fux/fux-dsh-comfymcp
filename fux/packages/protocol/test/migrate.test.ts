import { describe, expect, it } from 'vitest'
import {
  PROTOCOL_VERSION_V2,
  migratePermissionV1toV2,
  migrateManifestV1toV2,
  migrateEventV1toV2,
  migrateConnectorV1toV2,
  migrateProductV1toV2,
  PermissionV2Schema,
  IpcEventV2Schema,
  ConnectorDefinitionV2Schema,
} from '../src/migrate.js'
import { MigrationConflictError } from '../src/errors.js'
import { EVENT_SCHEMA_VERSION } from '../src/event-schema.js'
import type { PluginManifest } from '../src/manifest.js'

const baseManifest = {
  id: '@acme/greeter',
  name: 'Greeter',
  version: '0.0.1',
  protocol: '^0.1.0',
  executionMode: 'in_process',
  capabilities: [{ name: 'greeting:hello', version: '0.0.1' }],
  consumes: [],
  dependencies: [],
} satisfies PluginManifest

describe('PROTOCOL_VERSION_V2', () => {
  it('pins the target protocol version to 0.2.0', () => {
    expect(PROTOCOL_VERSION_V2).toBe('0.2.0')
  })
})

describe('migratePermissionV1toV2', () => {
  it('fills a missing scope with the unscoped fallback', () => {
    const out = migratePermissionV1toV2({ resource: 'greeting:hello', action: 'call' })
    expect(out).toEqual({ resource: 'greeting:hello', action: 'call', scope: '*' })
    expect(PermissionV2Schema.parse(out)).toEqual(out)
  })

  it('passes through an explicit scope', () => {
    const out = migratePermissionV1toV2({ resource: 'r', action: 'a', scope: 'family' })
    expect(out.scope).toBe('family')
  })
})

describe('migrateManifestV1toV2', () => {
  it('maps permission scopes while leaving the rest byte-for-byte', () => {
    const manifest: PluginManifest = {
      ...baseManifest,
      permissions: [
        { resource: 'a', action: 'read' },
        { resource: 'b', action: 'write', scope: 'team' },
      ],
    }
    const out = migrateManifestV1toV2(manifest)
    expect(out.permissions).toEqual([
      { resource: 'a', action: 'read', scope: '*' },
      { resource: 'b', action: 'write', scope: 'team' },
    ])
    expect(out.id).toBe(manifest.id)
    expect(out.capabilities).toBe(manifest.capabilities)
  })

  it('keeps a manifest with no permissions unchanged', () => {
    const out = migrateManifestV1toV2(baseManifest)
    expect(out.permissions).toBeUndefined()
    expect(out.id).toBe(baseManifest.id)
    expect(out.protocol).toBe(baseManifest.protocol)
    expect(out.capabilities).toBe(baseManifest.capabilities)
  })
})

describe('migrateEventV1toV2', () => {
  it('stamps the unified schema version onto a legacy event', () => {
    const event = { topic: 'app:ready', occurredAt: 123 }
    const out = migrateEventV1toV2(event)
    expect(out.schemaVersion).toBe(EVENT_SCHEMA_VERSION)
    expect(IpcEventV2Schema.parse(out).schemaVersion).toBe(EVENT_SCHEMA_VERSION)
  })

  it('keeps an explicit schemaVersion', () => {
    const out = migrateEventV1toV2({ topic: 'app:ready', occurredAt: 1, schemaVersion: 2 })
    expect(out.schemaVersion).toBe(2)
  })
})

describe('migrateConnectorV1toV2', () => {
  it('passes through a connector that already has a kind', () => {
    const out = migrateConnectorV1toV2({ id: 'logs:out', kind: 'publish_subscribe' })
    expect(out).toEqual({ id: 'logs:out', kind: 'publish_subscribe' })
    expect(ConnectorDefinitionV2Schema.parse(out).kind).toBe('publish_subscribe')
  })

  it('throws MigrationConflictError when kind is absent', () => {
    expect(() => migrateConnectorV1toV2({ id: 'health' })).toThrow(MigrationConflictError)
  })
})

describe('migrateProductV1toV2', () => {
  const product = {
    id: 'demo-hello',
    name: 'Demo Hello',
    version: '0.0.1',
    plugins: [{ id: '@fux/example-greeter' }],
  }

  it('migrates connectors that declare a kind', () => {
    const out = migrateProductV1toV2({
      ...product,
      connectors: [{ id: 'logs:out', kind: 'request_reply', config: { channel: 'logs' } }],
    })
    expect(out.connectors[0]).toMatchObject({
      id: 'logs:out',
      kind: 'request_reply',
      config: { channel: 'logs' },
    })
  })

  it('fails loudly on the first connector missing a kind, pinpointing its path', () => {
    let caught: unknown
    try {
      migrateProductV1toV2({
        ...product,
        connectors: [{ id: 'logs:out' }, { id: 'health', kind: 'stream' }],
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(MigrationConflictError)
    const err = caught as MigrationConflictError
    expect(err.path).toBe('connectors[0].kind')
    expect(err.issues[0]?.message).toContain('has no kind')
  })

  it('throws on the first conflicting connector, not a later valid one', () => {
    expect(() =>
      migrateProductV1toV2({
        ...product,
        connectors: [{ id: 'a', kind: 'stream' }, { id: 'b' }, { id: 'c' }],
      }),
    ).toThrow(MigrationConflictError)
  })
})

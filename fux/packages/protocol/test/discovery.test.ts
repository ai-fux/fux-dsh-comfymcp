import { describe, expect, it } from 'vitest'
import type { Discoverable, DiscoveryQuery, FuxResource, ResourceKind } from '../src/discovery.js'

describe('unified discovery contract (BR-02)', () => {
  it('exposes resource-shape and query types', () => {
    const plugin: FuxResource = { kind: 'plugin', id: 'app', status: 'started' }
    const capability: FuxResource = { kind: 'capability', id: 'app:run', entry: 'app' }
    const query: DiscoveryQuery = { kind: 'plugin', status: 'started', text: 'app' }
    const kind: ResourceKind = 'connector'
    expect([plugin.kind, capability.kind, kind]).toEqual(['plugin', 'capability', 'connector'])
    expect(query).toMatchObject({ kind: 'plugin' })
  })

  it('lets a caller compose several Discoverable sources through one view', () => {
    const plugins: Discoverable = {
      discover: () => [
        { kind: 'plugin', id: 'greeter', status: 'started' },
        { kind: 'plugin', id: 'app', status: 'started' },
      ],
    }
    const connectors: Discoverable = {
      discover: () => [{ kind: 'connector', id: 'logs:out', status: 'open' }],
    }
    const unified: Discoverable = {
      discover: (query) =>
        [...plugins.discover(), ...connectors.discover()].filter(
          (r) => query === undefined || query.kind === undefined || r.kind === query.kind,
        ),
    }
    expect(unified.discover().map((r) => r.kind)).toEqual(['plugin', 'plugin', 'connector'])
    expect(unified.discover({ kind: 'connector' }).map((r) => r.id)).toEqual(['logs:out'])
  })
})

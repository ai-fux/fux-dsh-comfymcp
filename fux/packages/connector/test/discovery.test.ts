import { describe, expect, it } from 'vitest'
import { ConnectorRegistry } from '../src/connector.js'
import { InMemoryConnector } from '../src/in-memory-connector.js'

describe('ConnectorRegistry.asDiscoverable (BR-02)', () => {
  it('exposes connectors as uniform resources without changing the registry API', () => {
    const registry = new ConnectorRegistry()
    const connector = new InMemoryConnector({ id: 'logs:out' })
    registry.register(connector)

    const all = registry.asDiscoverable().discover()
    expect(all).toEqual([
      {
        kind: 'connector',
        id: 'logs:out',
        status: connector.state,
        entry: connector.kind,
      },
    ])

    // dedicated methods still work as before
    expect(registry.has('logs:out')).toBe(true)
    expect(registry.list()).toHaveLength(1)
    expect(registry.get('logs:out')).toBe(connector)
  })

  it('filters the unified view by kind, status and text', () => {
    const registry = new ConnectorRegistry()
    registry.register(new InMemoryConnector({ id: 'logs:out' }))
    registry.register(new InMemoryConnector({ id: 'metrics:push' }))

    const discoverable = registry.asDiscoverable()
    expect(
      discoverable
        .discover({ kind: 'connector' })
        .map((r) => r.id)
        .sort(),
    ).toEqual(['logs:out', 'metrics:push'])
    expect(discoverable.discover({ text: 'logs' }).map((r) => r.id)).toEqual(['logs:out'])
    // unknown status yields nothing
    expect(discoverable.discover({ status: 'open' })).toEqual([])
  })
})

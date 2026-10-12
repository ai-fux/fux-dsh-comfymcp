import { describe, expect, it } from 'vitest'
import { FuxCore } from '../src/compose.js'
import { CapabilityLookup, graphSummary } from '../src/graph.js'

const greeterManifest = {
  id: '@fux/example-greeter',
  name: 'Greeter',
  version: '0.0.1',
  protocol: '^0.1.0',
  executionMode: 'in_process',
  capabilities: [{ name: 'greeting:hello', version: '0.0.1' }],
  configSchema: {
    type: 'object',
    properties: { greeting: { type: 'string', default: 'Hello' } },
  },
}

const appManifest = {
  id: '@fux/example-app',
  name: 'App',
  version: '0.0.1',
  protocol: '^0.1.0',
  executionMode: 'in_process',
  consumes: ['greeting:hello'],
}

const product = {
  id: 'demo-hello',
  name: 'Demo Hello',
  version: '0.0.1',
  plugins: [
    { id: '@fux/example-app' },
    { id: '@fux/example-greeter', config: { greeting: '你好' } },
  ],
}

function makeCore() {
  const core = new FuxCore()
  core.register(greeterManifest)
  core.register(appManifest)
  return core
}

describe('FuxCore.compose', () => {
  it('builds a runtime graph with topological order and resolved config', () => {
    const result = makeCore().compose(product)
    expect(result.graph.order).toEqual(['@fux/example-greeter', '@fux/example-app'])
    expect(result.graph.plugins.get('@fux/example-greeter')?.config).toEqual({
      greeting: '你好',
    })
    expect(result.graph.profile).toBe('dev')
    expect(result.resolution.autoIncluded).toEqual([])
  })

  it('exposes O(1) capability lookup', () => {
    const result = makeCore().compose(product)
    const binding = result.lookup.resolve('greeting:hello')
    expect(binding).toEqual({ providerId: '@fux/example-greeter', executionMode: 'in_process' })
    expect(result.lookup.resolve('nope:capability')).toBeUndefined()
    expect(result.lookup.size).toBe(1)
  })

  it('caches composed graphs per product and key', () => {
    const core = makeCore()
    const first = core.compose(product)
    const second = core.compose(product)
    expect(second.cached).toBe(true)
    expect(second.graph).toBe(first.graph)

    const changed = core.compose({
      ...product,
      plugins: [{ id: '@fux/example-app' }, { id: '@fux/example-greeter' }],
    })
    expect(changed.cached).toBe(false)
  })

  it('applies config overrides above product config', () => {
    const result = makeCore().compose(product, {
      configOverrides: { '@fux/example-greeter': { greeting: 'Override' } },
    })
    expect(result.graph.plugins.get('@fux/example-greeter')?.config.greeting).toBe('Override')
  })

  it('rejects invalid product definitions', () => {
    const core = makeCore()
    expect(() => core.compose({ id: 'x', plugins: [] })).toThrow()
  })

  it('rejects products referencing unregistered plugins', () => {
    const core = makeCore()
    expect(() => core.compose({ ...product, plugins: [{ id: '@fux/ghost' }] })).toThrow(
      /not registered/,
    )
  })

  it('propagates declared connectors onto the runtime graph', () => {
    const result = makeCore().compose({
      ...product,
      connectors: [{ id: 'logs:out', kind: 'publish_subscribe' }],
    })
    expect(result.graph.connectors).toEqual([
      { id: 'logs:out', kind: 'publish_subscribe', config: {} },
    ])
  })

  it('keeps connectors empty for products with none', () => {
    expect(makeCore().compose(product).graph.connectors).toEqual([])
  })
})

describe('CapabilityLookup', () => {
  it('can be constructed standalone from a graph', () => {
    const result = makeCore().compose(product)
    const lookup = new CapabilityLookup(result.graph)
    expect(lookup.size).toBe(1)
  })
})

describe('graphSummary', () => {
  it('renders a human readable summary', () => {
    const result = makeCore().compose(product)
    const lines = graphSummary(result.graph)
    expect(lines[0]).toContain('Demo Hello')
    expect(lines.join('\n')).toContain('@fux/example-greeter')
    expect(lines.join('\n')).toContain('greeting:hello')
  })
})

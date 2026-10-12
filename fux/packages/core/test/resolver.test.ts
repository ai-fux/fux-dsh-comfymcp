import { describe, expect, it } from 'vitest'
import { PluginRegistry } from '../src/registry.js'
import { resolveProduct } from '../src/resolver.js'
import type { ProductDefinition } from '@fux/protocol'
import {
  DependencyCycleError,
  DependencyVersionConflictError,
  DuplicateCapabilityError,
  EmptyProductError,
  MissingCapabilityError,
  MissingDependencyError,
  PluginNotRegisteredError,
} from '../src/errors.js'

function makeRegistry() {
  const registry = new PluginRegistry()
  registry.register({
    id: '@fux/base',
    name: 'Base',
    version: '0.0.1',
    protocol: '^0.1.0',
    executionMode: 'in_process',
    capabilities: [{ name: 'base:info', version: '0.0.1' }],
  })
  registry.register({
    id: '@fux/mid',
    name: 'Mid',
    version: '0.0.1',
    protocol: '^0.1.0',
    executionMode: 'in_process',
    capabilities: [{ name: 'mid:work', version: '0.0.1' }],
    consumes: ['base:info'],
    dependencies: ['@fux/base'],
  })
  registry.register({
    id: '@fux/top',
    name: 'Top',
    version: '0.0.1',
    protocol: '^0.1.0',
    executionMode: 'in_process',
    consumes: ['mid:work'],
    dependencies: ['@fux/mid'],
  })
  return registry
}

function product(plugins: Array<{ id: string; enabled?: boolean }>): ProductDefinition {
  return {
    id: 'test-product',
    name: 'Test Product',
    version: '0.0.1',
    profile: 'dev',
    plugins: plugins.map((p) => ({
      id: p.id,
      enabled: p.enabled ?? true,
      config: {},
    })),
    connectors: [],
  }
}

describe('resolveProduct', () => {
  it('produces a topological start order', () => {
    const result = resolveProduct(makeRegistry(), product([{ id: '@fux/top' }]))
    expect(result.order).toEqual(['@fux/base', '@fux/mid', '@fux/top'])
  })

  it('auto-includes transitive dependencies and reports them in discovery order', () => {
    const result = resolveProduct(makeRegistry(), product([{ id: '@fux/top' }]))
    expect(result.autoIncluded).toEqual(['@fux/mid', '@fux/base'])
  })

  it('fails when a plugin is not registered', () => {
    expect(() => resolveProduct(makeRegistry(), product([{ id: '@fux/ghost' }]))).toThrow(
      PluginNotRegisteredError,
    )
  })

  it('fails when the product has no enabled plugins', () => {
    expect(() =>
      resolveProduct(makeRegistry(), product([{ id: '@fux/top', enabled: false }])),
    ).toThrow(EmptyProductError)
  })

  it('fails when a dependency is disabled in the product', () => {
    expect(() =>
      resolveProduct(
        makeRegistry(),
        product([{ id: '@fux/top' }, { id: '@fux/mid', enabled: false }]),
      ),
    ).toThrow(MissingDependencyError)
  })

  it('fails when a consumed capability has no provider', () => {
    const registry = makeRegistry()
    registry.register({
      id: '@fux/hungry',
      name: 'Hungry',
      version: '0.0.1',
      protocol: '^0.1.0',
      executionMode: 'in_process',
      consumes: ['nope:capability'],
    })
    expect(() => resolveProduct(registry, product([{ id: '@fux/hungry' }]))).toThrow(
      MissingCapabilityError,
    )
  })

  it('fails when two plugins provide the same capability', () => {
    const registry = makeRegistry()
    registry.register({
      id: '@fux/base-clone',
      name: 'Base Clone',
      version: '0.0.1',
      protocol: '^0.1.0',
      executionMode: 'in_process',
      capabilities: [{ name: 'base:info', version: '0.0.1' }],
    })
    expect(() =>
      resolveProduct(registry, product([{ id: '@fux/base' }, { id: '@fux/base-clone' }])),
    ).toThrow(DuplicateCapabilityError)
  })

  it('detects dependency cycles and reports the path', () => {
    const registry = new PluginRegistry()
    registry.register({
      id: '@fux/a',
      name: 'A',
      version: '0.0.1',
      protocol: '^0.1.0',
      executionMode: 'in_process',
      dependencies: ['@fux/b'],
    })
    registry.register({
      id: '@fux/b',
      name: 'B',
      version: '0.0.1',
      protocol: '^0.1.0',
      executionMode: 'in_process',
      dependencies: ['@fux/a'],
    })
    try {
      resolveProduct(registry, product([{ id: '@fux/a' }]))
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(DependencyCycleError)
      const cycle = (error as DependencyCycleError).cycle
      expect(cycle[0]).toBe(cycle[cycle.length - 1])
      expect(cycle).toContain('@fux/a')
      expect(cycle).toContain('@fux/b')
    }
  })

  it('maps capabilities to their providers', () => {
    const result = resolveProduct(makeRegistry(), product([{ id: '@fux/top' }]))
    expect(result.capabilityProviders.get('base:info')).toBe('@fux/base')
    expect(result.capabilityProviders.get('mid:work')).toBe('@fux/mid')
  })
})

describe('resolveProduct dependenciesRanges (AR-01)', () => {
  function pickyPlugin(range?: string) {
    const registry = makeRegistry()
    const picky: Record<string, unknown> = {
      id: '@fux/picky',
      name: 'Picky',
      version: '0.0.1',
      protocol: '^0.1.0',
      executionMode: 'in_process',
      dependencies: ['@fux/base'],
    }
    if (range) picky.dependenciesRanges = { '@fux/base': range }
    registry.register(picky)
    return registry
  }

  it('accepts a dependency whose version satisfies the declared range', () => {
    const result = resolveProduct(pickyPlugin('^0.0.1'), product([{ id: '@fux/picky' }]))
    expect(result.order).toContain('@fux/picky')
  })

  it('fails when a dependency version violates the declared range', () => {
    expect(() => resolveProduct(pickyPlugin('^1.0.0'), product([{ id: '@fux/picky' }]))).toThrow(
      DependencyVersionConflictError,
    )
  })

  it('tolerates declared ranges for plugins outside the active set', () => {
    const registry = new PluginRegistry()
    registry.register({
      id: '@fux/solo',
      name: 'Solo',
      version: '0.0.1',
      protocol: '^0.1.0',
      executionMode: 'in_process',
      dependenciesRanges: { '@fux/base': '^9.0.0' }, // not in dependencies, base stays unresolved
    })
    const result = resolveProduct(registry, product([{ id: '@fux/solo' }]))
    expect(result.order).toEqual(['@fux/solo'])
  })
})

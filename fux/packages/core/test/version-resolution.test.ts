import { describe, expect, it } from 'vitest'
import { FuxCore, PluginRegistry } from '../src/index.js'
import { resolveProduct } from '../src/resolver.js'
import { DependencyVersionConflictError, DuplicatePluginError } from '../src/errors.js'
import type { PluginManifest, ProductDefinition } from '@fux/protocol'

/** A canonical 2.0.0 + a candidate 1.5.0; B pins ^1.0.0 (2.0.0 violates it). */
function makeMultiVersionRegistry() {
  const registry = new PluginRegistry()
  registry.register({
    id: '@fux/a',
    name: 'A',
    version: '2.0.0',
    protocol: '^0.1.0',
    executionMode: 'in_process',
    capabilities: [{ name: 'alpha:info', version: '1.0.0' }],
  } as PluginManifest)
  registry.registerVersion({
    id: '@fux/a',
    name: 'A',
    version: '1.5.0',
    protocol: '^0.1.0',
    executionMode: 'in_process',
    capabilities: [{ name: 'alpha:info', version: '1.0.0' }],
  } as PluginManifest)
  registry.register({
    id: '@fux/b',
    name: 'B',
    version: '1.0.0',
    protocol: '^0.1.0',
    executionMode: 'in_process',
    dependencies: ['@fux/a'],
    dependenciesRanges: { '@fux/a': '^1.0.0' },
    capabilities: [{ name: 'beta:work', version: '1.0.0' }],
    consumes: ['alpha:info'],
  } as PluginManifest)
  return registry
}

function product(plugins: Array<{ id: string }>): ProductDefinition {
  return {
    id: 'test-product',
    name: 'Test Product',
    version: '0.0.1',
    profile: 'dev',
    plugins: plugins.map((p) => ({ id: p.id, enabled: true, config: {} })),
    connectors: [],
  }
}

describe('PluginRegistry multi-version candidates (G8)', () => {
  it('registerVersion adds candidates without disturbing the canonical manifest', () => {
    const r = makeMultiVersionRegistry()
    expect(r.get('@fux/a')?.version).toBe('2.0.0')
    expect(r.candidates('@fux/a').map((m) => m.version)).toEqual(['2.0.0', '1.5.0'])
  })

  it('still rejects a duplicate canonical-registered id', () => {
    const r = new PluginRegistry()
    r.register({
      id: '@fux/a',
      name: 'A',
      version: '2.0.0',
      protocol: '^0.1.0',
      executionMode: 'in_process',
    })
    expect(() =>
      r.register({
        id: '@fux/a',
        name: 'A',
        version: '9.9.9',
        protocol: '^0.1.0',
        executionMode: 'in_process',
      }),
    ).toThrow(DuplicatePluginError)
  })

  it('candidates() is empty for unknown ids and drops side table on unregister', () => {
    const r = makeMultiVersionRegistry()
    expect(r.candidates('@fux/nope')).toEqual([])
    expect(r.unregister('@fux/a')).toBe(true)
    expect(r.candidates('@fux/a')).toEqual([])
  })
})

describe('resolveProduct autoResolveDependencyVersions (G8, default off)', () => {
  it('throws DependencyVersionConflictError by default unchanged', () => {
    const result = makeMultiVersionRegistry()
    expect(() => resolveProduct(result, product([{ id: '@fux/b' }]))).toThrow(
      DependencyVersionConflictError,
    )
  })

  it('resolves a conflicting dependency to a candidate that satisfies all ranges', () => {
    const registry = makeMultiVersionRegistry()
    const result = resolveProduct(registry, product([{ id: '@fux/b' }]), {
      autoResolveDependencyVersions: true,
    })
    expect(result.plugins.get('@fux/a')?.version).toBe('1.5.0')
    expect(result.order).toEqual(['@fux/a', '@fux/b'])
    expect(result.capabilityProviders.get('alpha:info')).toBe('@fux/a')
  })

  it('still throws when no single candidate satisfies every referencing range', () => {
    const registry = new PluginRegistry()
    registry.register({
      id: '@fux/a',
      name: 'A',
      version: '1.0.0',
      protocol: '^0.1.0',
      executionMode: 'in_process',
      capabilities: [{ name: 'alpha:info', version: '1.0.0' }],
    } as PluginManifest)
    // B pins ^2, C pins ^1 — mutually exclusive majors, only 1.0.0 exists.
    registry.register({
      id: '@fux/b',
      name: 'B',
      version: '1.0.0',
      protocol: '^0.1.0',
      executionMode: 'in_process',
      capabilities: [],
      dependencies: ['@fux/a'],
      dependenciesRanges: { '@fux/a': '^2.0.0' },
      consumes: ['alpha:info'],
    } as PluginManifest)
    registry.register({
      id: '@fux/c',
      name: 'C',
      version: '1.0.0',
      protocol: '^0.1.0',
      executionMode: 'in_process',
      capabilities: [],
      dependencies: ['@fux/a'],
      dependenciesRanges: { '@fux/a': '^1.0.0' },
      consumes: ['alpha:info'],
    } as PluginManifest)
    expect(() =>
      resolveProduct(registry, product([{ id: '@fux/b' }, { id: '@fux/c' }]), {
        autoResolveDependencyVersions: true,
      }),
    ).toThrow(DependencyVersionConflictError)
  })
})

describe('FuxCore compose autoResolve wiring (G8)', () => {
  function makeCore() {
    const core = new FuxCore()
    core.register({
      id: '@fux/a',
      name: 'A',
      version: '2.0.0',
      protocol: '^0.1.0',
      executionMode: 'in_process',
      capabilities: [{ name: 'alpha:info', version: '1.0.0' }],
    } as PluginManifest)
    core.registerVersion({
      id: '@fux/a',
      name: 'A',
      version: '1.5.0',
      protocol: '^0.1.0',
      executionMode: 'in_process',
      capabilities: [{ name: 'alpha:info', version: '1.0.0' }],
    } as PluginManifest)
    core.register({
      id: '@fux/b',
      name: 'B',
      version: '1.0.0',
      protocol: '^0.1.0',
      executionMode: 'in_process',
      capabilities: [],
      dependencies: ['@fux/a'],
      dependenciesRanges: { '@fux/a': '^1.0.0' },
      consumes: ['alpha:info'],
    } as PluginManifest)
    return core
  }

  it('compose fails without the option and succeeds with it, caching separately', () => {
    const core = makeCore()
    const productDef = product([{ id: '@fux/b' }])
    expect(() => core.compose(productDef)).toThrow(DependencyVersionConflictError)

    const composed = core.compose(productDef, { autoResolveDependencyVersions: true })
    expect(composed.graph.capabilities.get('alpha:info')?.providerId).toBe('@fux/a')
    expect(composed.graph.plugins.get('@fux/a')?.manifest.version).toBe('1.5.0')
    expect(composed.cached).toBe(false)

    // distinct cache entries: recompose with the option hits the resolved cache.
    const again = core.compose(productDef, { autoResolveDependencyVersions: true })
    expect(again.cached).toBe(true)
  })
})

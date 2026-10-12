import { describe, expect, it } from 'vitest'
import { deepMerge, extractDefaults, resolvePluginConfig } from '../src/config.js'
import type { PluginManifest, ProductPluginEntry } from '@fux/protocol'

const manifest = {
  id: '@fux/example-greeter',
  name: 'Greeter',
  version: '0.0.1',
  protocol: '^0.1.0',
  executionMode: 'in_process',
  capabilities: [],
  consumes: [],
  dependencies: [],
  configSchema: {
    type: 'object',
    properties: {
      greeting: { type: 'string', default: 'Hello' },
      punctuation: { type: 'string', default: '!' },
      nested: {
        type: 'object',
        default: { level: 1 },
        properties: {
          level: { type: 'number' },
        },
      },
    },
  },
} as PluginManifest

describe('extractDefaults', () => {
  it('collects default values from a config schema', () => {
    expect(extractDefaults(manifest.configSchema)).toEqual({
      greeting: 'Hello',
      punctuation: '!',
      nested: { level: 1 },
    })
  })

  it('returns empty for missing or malformed schemas', () => {
    expect(extractDefaults(undefined)).toEqual({})
    expect(extractDefaults({})).toEqual({})
    expect(extractDefaults({ type: 'object' })).toEqual({})
  })
})

describe('deepMerge', () => {
  it('merges nested plain objects', () => {
    expect(deepMerge({ a: 1, nested: { x: 1, y: 2 } }, { nested: { y: 3, z: 4 }, b: 2 })).toEqual({
      a: 1,
      b: 2,
      nested: { x: 1, y: 3, z: 4 },
    })
  })

  it('replaces arrays and scalars instead of merging', () => {
    expect(deepMerge({ tags: [1, 2] }, { tags: [3] })).toEqual({ tags: [3] })
    expect(deepMerge({ a: 1 }, { a: 'x' })).toEqual({ a: 'x' })
  })
})

describe('resolvePluginConfig', () => {
  const entry = (config: Record<string, unknown>): ProductPluginEntry => ({
    id: manifest.id,
    enabled: true,
    config,
  })

  it('applies defaults when the product provides nothing', () => {
    const result = resolvePluginConfig(manifest, entry({}))
    expect(result.config).toEqual({ greeting: 'Hello', punctuation: '!', nested: { level: 1 } })
    expect(result.sources['greeting']).toBe('default')
  })

  it('lets product config override defaults and records sources', () => {
    const result = resolvePluginConfig(manifest, entry({ greeting: '你好' }))
    expect(result.config.greeting).toBe('你好')
    expect(result.config.punctuation).toBe('!')
    expect(result.sources['greeting']).toBe('product')
    expect(result.sources['punctuation']).toBe('default')
  })

  it('merges nested objects across layers', () => {
    const result = resolvePluginConfig(manifest, entry({ nested: { level: 2 } }), {
      greeting: 'Override',
    })
    expect(result.config.nested).toEqual({ level: 2 })
    expect(result.config.greeting).toBe('Override')
    expect(result.sources['greeting']).toBe('override')
  })
})

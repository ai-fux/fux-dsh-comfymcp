import { describe, expect, it } from 'vitest'
import {
  SkeletonRegistry,
  UiError,
  builtInSkeleton,
  type Skeleton,
  type SkeletonDefinition,
} from '../src/skeleton.js'

const customDefinition: SkeletonDefinition = {
  id: 'corp:shell',
  name: 'Corporate',
  description: 'A branded corporate shell.',
  regions: [{ name: 'app-bar' }, { name: 'content' }],
}
const customSkeleton: Skeleton = { id: 'corp:shell', describe: () => customDefinition }

describe('built-in skeleton (AR-04)', () => {
  it('is active by default with the classic regions', async () => {
    const def = await builtInSkeleton.describe()
    expect(def.id).toBe('default')
    expect(def.regions.map((r) => r.name)).toEqual(['header', 'main', 'sidebar', 'footer'])
  })
})

describe('SkeletonRegistry (AR-04)', () => {
  it('serves the built-in default when nothing is registered', async () => {
    const registry = new SkeletonRegistry()
    const def = await registry.active().describe()
    expect(def.id).toBe('default')
    expect(registry.skeletons()).toHaveLength(1)
  })

  it('registering makes the new skeleton active without losing the default', () => {
    const registry = new SkeletonRegistry()
    registry.registerSkeleton(customSkeleton)
    expect(registry.active().id).toBe('corp:shell')
    expect(registry.skeletons()).toHaveLength(2)
  })

  it('re-registering an id replaces that skeleton', async () => {
    const registry = new SkeletonRegistry()
    const updated: Skeleton = {
      id: 'corp:shell',
      describe: () => ({ ...customDefinition, regions: [{ name: 'new-slot' }] }),
    }
    registry.registerSkeleton(customSkeleton)
    registry.registerSkeleton(updated)
    const def = await registry.active().describe()
    expect(def.regions.map((r) => r.name)).toEqual(['new-slot'])
  })

  it('activate() switches to a registered skeleton', async () => {
    const registry = new SkeletonRegistry()
    registry.registerSkeleton(customSkeleton)
    registry.activate('default')
    expect((await registry.active().describe()).id).toBe('default')
    registry.activate('corp:shell')
    expect((await registry.active().describe()).id).toBe('corp:shell')
  })

  it('unregister returns the registry to the default skeleton', () => {
    const registry = new SkeletonRegistry()
    registry.registerSkeleton(customSkeleton)
    registry.unregisterSkeleton('corp:shell')
    expect(registry.active().id).toBe('default')
    expect(registry.skeletons()).toHaveLength(1)
  })

  it('throws UiError on unknown unregister and activate targets', () => {
    const registry = new SkeletonRegistry()
    expect(() => registry.unregisterSkeleton('ghost:shell')).toThrowError(UiError)
    expect(() => registry.activate('ghost:shell')).toThrowError(UiError)
  })
})

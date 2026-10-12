import { describe, expect, it } from 'vitest'
import { FuxCore } from '@fux/core'
import type { Skeleton } from '@fux/ui'
import { Supervisor } from '../src/supervisor.js'
import type { FuxPluginModule } from '../src/types.js'

const greeterManifest = {
  id: '@fux/example-greeter',
  name: 'Greeter',
  version: '0.0.1',
  protocol: '^0.1.0',
  executionMode: 'in_process',
  capabilities: [{ name: 'greeting:hello', version: '0.0.1' }],
}

async function startRuntime() {
  const core = new FuxCore()
  core.register(greeterManifest)
  const { graph } = core.compose({
    id: 'skeleton-product',
    name: 'Skeleton',
    version: '0.0.1',
    plugins: [{ id: '@fux/example-greeter' }],
  })
  const module: FuxPluginModule = {
    activate: (ctx) => ctx.provide('greeting:hello', () => 'hi'),
  }
  return new Supervisor(core.events).start(graph, () => module)
}

describe('StartedRuntime skeleton registry (AR-04)', () => {
  it('exposes the built-in default as the active skeleton by default', async () => {
    const runtime = await startRuntime()
    expect((await runtime.describeActiveSkeleton()).id).toBe('default')
    expect(runtime.skeletons()).toHaveLength(1)
    await runtime.stop()
  })

  it('registerSkeleton makes a custom skeleton active; unregisterSkeleton restores default', async () => {
    const runtime = await startRuntime()
    const custom: Skeleton = {
      id: 'corp:shell',
      describe: () => ({
        id: 'corp:shell',
        name: 'Corporate',
        regions: [{ name: 'app-bar' }, { name: 'content' }],
      }),
    }
    runtime.registerSkeleton(custom)
    expect(runtime.activeSkeleton().id).toBe('corp:shell')
    expect((await runtime.describeActiveSkeleton()).regions.map((r) => r.name)).toEqual([
      'app-bar',
      'content',
    ])
    runtime.unregisterSkeleton('corp:shell')
    expect((await runtime.describeActiveSkeleton()).id).toBe('default')
    await runtime.stop()
  })

  it('activateSkeleton switches between registered skeletons', async () => {
    const runtime = await startRuntime()
    const other: Skeleton = { id: 'b:shell', describe: () => ({ id: 'b:shell', regions: [] }) }
    runtime.registerSkeleton(other)
    runtime.activateSkeleton('default')
    expect((await runtime.describeActiveSkeleton()).id).toBe('default')
    runtime.activateSkeleton('b:shell')
    expect((await runtime.describeActiveSkeleton()).id).toBe('b:shell')
    await runtime.stop()
  })

  it('unregistering the active skeleton without a registered default restores the built-in', async () => {
    const runtime = await startRuntime()
    const custom: Skeleton = { id: 'x:shell', describe: () => ({ id: 'x:shell', regions: [] }) }
    runtime.registerSkeleton(custom)
    runtime.unregisterSkeleton('x:shell')
    expect(runtime.activeSkeleton().id).toBe('default')
    await runtime.stop()
  })

  it('keeps plugins running after skeleton operations (additive, no side effects)', async () => {
    const runtime = await startRuntime()
    const custom: Skeleton = { id: 'y:shell', describe: () => ({ id: 'y:shell', regions: [] }) }
    runtime.registerSkeleton(custom)
    const greeting = await runtime.callAsSystem<string>('greeting:hello', { who: 'FUX' })
    expect(greeting).toBe('hi')
    await runtime.stop()
  })
})

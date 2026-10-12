import { describe, expect, it } from 'vitest'
import { FuxCore } from '@fux/core'
import type { Skin, Skeleton } from '@fux/ui'
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
    id: 'theming-product',
    name: 'Theming',
    version: '0.0.1',
    plugins: [{ id: '@fux/example-greeter' }],
  })
  const module: FuxPluginModule = {
    activate: (ctx) => ctx.provide('greeting:hello', () => 'hi'),
  }
  return new Supervisor(core.events).start(graph, () => module)
}

const darkSkin: Skin = {
  id: 'dark',
  describe: () => ({ id: 'dark', tokens: { color: { 'bg.surface': '#111' } } }),
}
const shellB: Skeleton = {
  id: 'shell-b',
  describe: () => ({ id: 'shell-b', regions: [{ name: 'gnav' }] }),
}

describe('StartedRuntime theming protocol (ER-02)', () => {
  it('default theme is active with zero change before registration', async () => {
    const runtime = await startRuntime()
    expect(runtime.activeThemeId()).toBe('default')
    expect(runtime.themes()).toHaveLength(1)
    expect((await runtime.describeActiveSkeleton()).id).toBe('default')
    expect((await runtime.describeActiveSkin()).id).toBe('default')
    await runtime.stop()
  })

  it('registerTheme records without switching; activateTheme applies the whole pack', async () => {
    const runtime = await startRuntime()
    runtime.registerTheme({ id: 'corp', skeleton: shellB, skin: darkSkin })
    expect(runtime.activeThemeId()).toBe('default')
    runtime.activateTheme('corp')
    expect(runtime.activeThemeId()).toBe('corp')
    expect((await runtime.describeActiveSkeleton()).id).toBe('shell-b')
    expect((await runtime.describeActiveSkin()).id).toBe('dark')
    await runtime.stop()
  })

  it('activating the default theme resets both concerns', async () => {
    const runtime = await startRuntime()
    runtime.registerTheme({ id: 'corp', skeleton: shellB, skin: darkSkin })
    runtime.activateTheme('corp')
    runtime.activateTheme('default')
    expect(runtime.activeThemeId()).toBe('default')
    expect((await runtime.describeActiveSkeleton()).id).toBe('default')
    expect((await runtime.describeActiveSkin()).id).toBe('default')
    await runtime.stop()
  })

  it('switching a theme keeps plugins running (additive, no side effects)', async () => {
    const runtime = await startRuntime()
    runtime.registerTheme({ id: 'corp', skeleton: shellB, skin: darkSkin })
    runtime.activateTheme('corp')
    const greeting = await runtime.callAsSystem<string>('greeting:hello', { who: 'FUX' })
    expect(greeting).toBe('hi')
    await runtime.stop()
  })
})

import { describe, expect, it } from 'vitest'
import { FuxCore } from '@fux/core'
import type { Skin } from '@fux/ui'
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
    id: 'theme-product',
    name: 'Theme',
    version: '0.0.1',
    plugins: [{ id: '@fux/example-greeter' }],
  })
  const module: FuxPluginModule = {
    activate: (ctx) => ctx.provide('greeting:hello', () => 'hi'),
  }
  return new Supervisor(core.events).start(graph, () => module)
}

const darkSkin: Skin = {
  id: 'corp:dark',
  describe: () => ({
    id: 'corp:dark',
    name: 'Corporate Dark',
    tokens: { color: { 'bg.surface': '#1c1c1e' } },
    layout: { orientation: 'split' },
  }),
}

describe('StartedRuntime theme provider (ER-01)', () => {
  it('exposes the built-in skin as the active skin by default', async () => {
    const runtime = await startRuntime()
    expect((await runtime.describeActiveSkin()).id).toBe('default')
    expect(runtime.skins()).toHaveLength(1)
    await runtime.stop()
  })

  it('registerSkin makes a custom skin active and describeable', async () => {
    const runtime = await startRuntime()
    runtime.registerSkin(darkSkin)
    expect(runtime.activeSkin().id).toBe('corp:dark')
    const def = await runtime.describeActiveSkin()
    expect(def.tokens.color?.['bg.surface']).toBe('#1c1c1e')
    runtime.unregisterSkin('corp:dark')
    expect((await runtime.describeActiveSkin()).id).toBe('default')
    await runtime.stop()
  })

  it('skins persist alongside a running plugin (additive, no side effects)', async () => {
    const runtime = await startRuntime()
    runtime.registerSkin(darkSkin)
    const greeting = await runtime.callAsSystem<string>('greeting:hello', { who: 'FUX' })
    expect(greeting).toBe('hi')
    expect(runtime.skins()).toHaveLength(2)
    await runtime.stop()
  })
})

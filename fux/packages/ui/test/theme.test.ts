import { describe, expect, it } from 'vitest'
import { ThemeProvider, UiError, builtInSkin, type Skin } from '../src/theme.js'

const darkSkin: Skin = {
  id: 'corp:dark',
  describe: () => ({
    id: 'corp:dark',
    name: 'Corporate Dark',
    tokens: {
      color: { 'bg.surface': '#1c1c1e', 'text.primary': '#f5f5f7' },
      spacing: { 'space.md': '12px' },
    },
    layout: { orientation: 'split' },
  }),
}

describe('built-in skin (ER-01)', () => {
  it('is active by default with a neutral light palette', async () => {
    const def = await builtInSkin.describe()
    expect(def.id).toBe('default')
    expect(def.tokens.color?.['bg.surface']).toBe('#ffffff')
    expect((def.layout?.regions ?? []).includes('sidebar')).toBe(true)
  })
})

describe('ThemeProvider (ER-01)', () => {
  it('serves the built-in skin when nothing is registered', async () => {
    const provider = new ThemeProvider()
    expect(provider.active().id).toBe('default')
    expect(provider.skins()).toHaveLength(1)
  })

  it('registerSkin makes the new skin active without losing the default', async () => {
    const provider = new ThemeProvider()
    provider.registerSkin(darkSkin)
    expect(provider.active().id).toBe('corp:dark')
    expect(provider.skins()).toHaveLength(2)
  })

  it('re-registering an id replaces that skin', async () => {
    const provider = new ThemeProvider()
    const updated: Skin = {
      id: 'corp:dark',
      describe: () => ({
        id: 'corp:dark',
        tokens: { color: { 'text.primary': '#0000ff' } },
      }),
    }
    provider.registerSkin(darkSkin)
    provider.registerSkin(updated)
    const def = await provider.active().describe()
    expect(def.tokens.color?.['text.primary']).toBe('#0000ff')
  })

  it('activate() switches between registered skins', async () => {
    const provider = new ThemeProvider()
    provider.registerSkin(darkSkin)
    provider.activate('default')
    expect((await provider.active().describe()).id).toBe('default')
    provider.activate('corp:dark')
    expect((await provider.active().describe()).id).toBe('corp:dark')
  })

  it('unregistering the active skin returns the provider to the default', () => {
    const provider = new ThemeProvider()
    provider.registerSkin(darkSkin)
    provider.unregisterSkin('corp:dark')
    expect(provider.active().id).toBe('default')
    expect(provider.skins()).toHaveLength(1)
  })

  it('throws UiError on unknown unregister and activate targets', () => {
    const provider = new ThemeProvider()
    expect(() => provider.unregisterSkin('ghost:skin')).toThrowError(UiError)
    expect(() => provider.activate('ghost:skin')).toThrowError(UiError)
  })
})

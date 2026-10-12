import { describe, expect, it } from 'vitest'
import {
  SkeletonRegistry,
  ThemeRegistry,
  ThemeProvider,
  UiError,
  builtInSkin,
  builtInSkeleton,
  type Skeleton,
  type Skin,
} from '../src/index.js'

const darkSkin: Skin = {
  id: 'dark',
  describe: () => ({ id: 'dark', tokens: { color: { 'bg.surface': '#111' } } }),
}
const shellB: Skeleton = {
  id: 'shell-b',
  describe: () => ({ id: 'shell-b', regions: [{ name: 'gnav' }] }),
}

function fresh() {
  const skeletons = new SkeletonRegistry()
  const skins = new ThemeProvider()
  return new ThemeRegistry(skeletons, skins)
}

describe('ThemeRegistry (ER-02)', () => {
  it('default theme is active and no-op before any registration/switch', async () => {
    const registry = fresh()
    expect(registry.activeThemeId()).toBe('default')
    expect(registry.themes()).toHaveLength(1)
    expect((await builtInSkeleton.describe()).id).toBe('default')
    expect((await builtInSkin.describe()).id).toBe('default')
  })

  it('registerTheme records without switching (default stays active)', () => {
    const registry = fresh()
    registry.registerTheme({ id: 'corp', skin: darkSkin, skeleton: shellB })
    expect(registry.themes()).toHaveLength(2)
    expect(registry.activeThemeId()).toBe('default')
  })

  it('activateTheme switches both skeleton and skin to the pack', async () => {
    const skeletons = new SkeletonRegistry()
    const skins = new ThemeProvider()
    const registry = new ThemeRegistry(skeletons, skins)
    const activeSkeleton = (await skeletons.active().describe()).id
    const activeSkin = (await skins.active().describe()).id
    expect(activeSkeleton).toBe('default')
    expect(activeSkin).toBe('default')

    registry.registerTheme({ id: 'corp', skeleton: shellB, skin: darkSkin })
    registry.activateTheme('corp')
    expect(registry.activeThemeId()).toBe('corp')
    expect((await skeletons.active().describe()).id).toBe('shell-b')
    expect((await skins.active().describe()).id).toBe('dark')
  })

  it('a pack may switch only one concern (skin), leaving skeleton default', async () => {
    const skeletons = new SkeletonRegistry()
    const skins = new ThemeProvider()
    const registry = new ThemeRegistry(skeletons, skins)
    registry.registerTheme({ id: 'skin-only', skin: darkSkin })
    registry.activateTheme('skin-only')
    expect((await skeletons.active().describe()).id).toBe('default')
    expect((await skins.active().describe()).id).toBe('dark')
  })

  it('activating the built-in default resets both concerns', async () => {
    const skeletons = new SkeletonRegistry()
    const skins = new ThemeProvider()
    const registry = new ThemeRegistry(skeletons, skins)
    registry.registerTheme({ id: 'corp', skeleton: shellB, skin: darkSkin })
    registry.activateTheme('corp')
    registry.activateTheme('default')
    expect(registry.activeThemeId()).toBe('default')
    expect((await skeletons.active().describe()).id).toBe('default')
    expect((await skins.active().describe()).id).toBe('default')
  })

  it('activateTheme throws UiError for an unknown id', () => {
    const registry = fresh()
    expect(() => registry.activateTheme('ghost')).toThrowError(UiError)
  })

  it('unregisterTheme removes a pack and is inert for the built-in default', async () => {
    const skeletons = new SkeletonRegistry()
    const skins = new ThemeProvider()
    const registry = new ThemeRegistry(skeletons, skins)
    registry.registerTheme({ id: 'corp', skeleton: shellB, skin: darkSkin })
    registry.activateTheme('corp')
    registry.unregisterTheme('corp')
    expect(registry.activeThemeId()).toBe('default')
    registry.unregisterTheme('default')
    expect(registry.themes()).toHaveLength(1)
  })
})

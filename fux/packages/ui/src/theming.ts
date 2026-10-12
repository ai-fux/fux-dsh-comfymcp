/**
 * ER-02: skin / skeleton pluginization protocol. The standalone registries (AR-04
 * `SkeletonRegistry`, ER-01 `ThemeProvider`) each switch one concern; this module
 * coordinates them into a single *theme pack* so a product can register and then
 * switch an entire look + shell in one step — or nothing at all, in which case the
 * built-in defaults stay active and the product looks identical to before. Only
 * the coordinating protocol lives here; neither registry's API changes.
 */

import { UiError, type Skeleton, type SkeletonRegistry } from './skeleton.js'
import type { Skin, ThemeProvider } from './theme.js'

/** The honoured id of the built-in theme pack that is active by default. */
export const DEFAULT_THEME_ID = 'default'

/** A registrable unit of "look": an optional skeleton and/or skin under one id. */
export interface ThemePack {
  readonly id: string
  readonly name?: string
  readonly description?: string
  /** Skeleton to switch to. Omit to keep the current (default) skeleton. */
  readonly skeleton?: Skeleton
  /** Skin to switch to. Omit to keep the current (default) skin. */
  readonly skin?: Skin
}

/**
 * Coordinates the skeleton and skin registries behind a single switch protocol.
 * The built-in `default` theme is pre-active; a product that never registers a
 * pack keeps built-in appearance (zero change). Registering a pack only records
 * it; `activateTheme(id)` applies it, switching any of the provided skeleton or
 * skin onto the shared registries.
 */
export class ThemeRegistry {
  private readonly byId = new Map<string, ThemePack>()
  private activeId = DEFAULT_THEME_ID

  constructor(
    private readonly skeletons: SkeletonRegistry,
    private readonly skins: ThemeProvider,
  ) {
    this.byId.set(DEFAULT_THEME_ID, {
      id: DEFAULT_THEME_ID,
      name: 'Default',
      description: 'The built-in FUX look and shell.',
    })
  }

  /** Record a theme pack under its id (add or replace). Does not switch. */
  registerTheme(pack: ThemePack): void {
    this.byId.set(pack.id, pack)
  }

  /**
   * Apply a theme pack: write its skeleton and/or skin onto the shared
   * registries (making them active there) and mark it as the active theme.
   * Passing the built-in `default` id resets both concerns to their defaults.
   */
  activateTheme(id: string): void {
    const pack = this.byId.get(id)
    if (!pack) throw new UiError('E_THEME_NOT_FOUND', `${id}`)
    if (id === DEFAULT_THEME_ID) {
      // Reset both concerns to their built-in defaults.
      this.skeletons.activate(DEFAULT_THEME_ID)
      this.skins.activate(DEFAULT_THEME_ID)
    } else {
      if (pack.skeleton) this.skeletons.registerSkeleton(pack.skeleton)
      if (pack.skin) this.skins.registerSkin(pack.skin)
    }
    this.activeId = id
  }

  /** Remove a recorded pack; no-op-safe if id is unknown (not active anyway). */
  unregisterTheme(id: string): void {
    if (id === DEFAULT_THEME_ID) return
    this.byId.delete(id)
    if (this.activeId === id) this.activeId = DEFAULT_THEME_ID
  }

  /** The id of the currently applied theme pack. */
  activeThemeId(): string {
    return this.activeId
  }

  themes(): ReadonlyArray<ThemePack> {
    return [...this.byId.values()]
  }
}

export { UiError } from './skeleton.js'

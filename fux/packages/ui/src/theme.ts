/**
 * ER-01: ThemeProvider + Skin contract. A *skin* is the themeable face of a UI
 * shell: design tokens (colour, spacing, type, radius), per-component theme
 * overrides and layout hints, described as data. The framework ships a built-in
 * default and a `ThemeProvider` so a product can register its own skin and make
 * it active — without touching the visual structure. Mechanism only: nothing
 * here renders, resolves CSS, or reads the DOM; the exact semantics of each
 * token are established by the consuming renderer / product (ER-02 layers the
 * switch protocol on top later).
 */

import { UiError } from './skeleton.js'

export { UiError } from './skeleton.js'

/**
 * Design tokens: named scales a renderer resolves into concrete values. Each
 * group is optional; a skin may override only what it needs, inheriting the
 * rest from the renderer's defaults.
 */
export interface SkinTokens {
  /** Colour palette, keyed by role (e.g. `bg.surface`, `text.primary`). */
  readonly color?: Readonly<Record<string, string>>
  /** Type scale (e.g. `font.family.body`, `font.size.md`). */
  readonly typography?: Readonly<Record<string, string>>
  /** Spacing scale (e.g. `space.sm`, `space.md`). */
  readonly spacing?: Readonly<Record<string, string>>
  /** Border radius scale (e.g. `radius.sm`, `radius.md`). */
  readonly radius?: Readonly<Record<string, string>>
  /** Elevation scale (e.g. `shadow.card`, `shadow.raised`). */
  readonly shadow?: Readonly<Record<string, string>>
  /** Any additional token group a product cares to define. */
  readonly [group: string]: unknown
}

/** Per-component theme overrides, keyed by component name (e.g. `Header`). */
export interface ComponentTheme {
  readonly [component: string]: Readonly<Record<string, string>> | undefined
}

/** Layout hints a renderer may consult when mounting a skeleton. */
export interface SkinLayout {
  /** Preferred shell orientation: `stacked` (top/bottom bars) or `split` (sidebar). */
  readonly orientation?: 'stacked' | 'split'
  /** Named regions to emphasize, in display order. */
  readonly regions?: readonly string[]
  readonly [key: string]: unknown
}

/** The readable description of a skin: tokens + components + layout. */
export interface SkinDefinition {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly tokens: SkinTokens
  readonly components?: Readonly<Record<string, ComponentTheme>>
  readonly layout?: SkinLayout
}

/**
 * A UI skin. `describe()` yields the skin's data; the framework never dictates
 * what that data means, only that it carries tokens/components/layout, so any
 * renderer can consume it.
 */
export interface Skin {
  readonly id: string
  describe(): SkinDefinition | Promise<SkinDefinition>
}

/** The honoured id of the built-in skin that is active by default. */
export const DEFAULT_SKIN_ID = 'default'

const BUILT_IN_TOKENS: SkinTokens = {
  color: {
    'bg.surface': '#ffffff',
    'bg.canvas': '#f5f5f7',
    'text.primary': '#1c1c1e',
    'text.secondary': '#48484a',
    'border.default': '#d1d1d6',
    'accent.primary': '#0a84ff',
  },
  typography: {
    'font.family.body': 'system-ui, -apple-system, "Segoe UI", sans-serif',
    'font.size.md': '14px',
    'font.size.lg': '18px',
    'font.weight.strong': '600',
  },
  spacing: {
    'space.sm': '4px',
    'space.md': '8px',
    'space.lg': '16px',
  },
  radius: {
    'radius.sm': '4px',
    'radius.md': '8px',
  },
}

/**
 * The built-in skin supplied out of the box. A product that never registers a
 * custom skin gets exactly this one — unchanged look and feel.
 */
export const builtInSkin: Skin = {
  id: DEFAULT_SKIN_ID,
  describe: () => ({
    id: DEFAULT_SKIN_ID,
    name: 'Default',
    description: 'The built-in FUX skin: a light, neutral palette for the default shell.',
    tokens: BUILT_IN_TOKENS,
    layout: { orientation: 'split', regions: ['header', 'sidebar', 'main', 'footer'] },
  }),
}

/**
 * A provider of UI skins. Registration is additive (ER-01): one id maps to one
 * skin, re-registering replaces it, and exactly one skin is *active* at a time.
 * The built-in default is pre-registered and is the initial active skin, so an
 * unre-themed product keeps current appearance.
 */
export class ThemeProvider {
  private readonly byId = new Map<string, Skin>()
  private activeId: string

  constructor(builtIn: Skin = builtInSkin) {
    this.byId.set(builtIn.id, builtIn)
    this.activeId = builtIn.id
  }

  /** Register (or replace) a skin under its id and select it as active. */
  registerSkin(skin: Skin): void {
    this.byId.set(skin.id, skin)
    this.activeId = skin.id
  }

  /** Remove a skin; throws if the id is unknown, falls back to default. */
  unregisterSkin(id: string): void {
    if (!this.byId.delete(id)) throw new UiError('E_SKIN_NOT_FOUND', `${id}`)
    if (this.activeId === id) this.activeId = DEFAULT_SKIN_ID
  }

  /** Switch the active skin to an already-registered id. */
  activate(id: string): void {
    if (!this.byId.has(id)) throw new UiError('E_SKIN_NOT_FOUND', `${id}`)
    this.activeId = id
  }

  /** The currently active skin. */
  active(): Skin {
    const active = this.byId.get(this.activeId)
    // The provider always keeps at least the built-in skin, so this is set.
    if (!active) return builtInSkin
    return active
  }

  skins(): ReadonlyArray<Skin> {
    return [...this.byId.values()]
  }
}

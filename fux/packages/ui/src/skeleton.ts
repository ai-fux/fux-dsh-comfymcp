/**
 * AR-04: UI skeleton pluginization. A *skeleton* is a named UI shell described
 * as data (its id and the regions/slots a product may mount surfaces into). The
 * framework provides a classic built-in default and a registry so a product can
 * register its own skeleton under an id and switch which one is active, without
 * changing the unregistered default behaviour. Mechanism only: nothing here
 * renders, reads tokens, or touches the DOM — ER-01/ER-02 layer the concrete
 * theme/skin contracts on top in a later release.
 */

/** A mount point a product may place content into. */
export interface SkeletonRegion {
  /** Slot name, e.g. `header`, `main`, `sidebar`. */
  readonly name: string
  readonly description?: string
}

/** The readable description of a skeleton: structure only, no behaviour. */
export interface SkeletonDefinition {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly regions: readonly SkeletonRegion[]
}

/**
 * A UI skeleton. The runtime never presupposes what a skeleton *does* — it only
 * treats the id as a handle and `describe()` as its structure, so any rendering
 * strategy (static, framework-driven, SSR) can plug in equally.
 */
export interface Skeleton {
  readonly id: string
  describe(): SkeletonDefinition | Promise<SkeletonDefinition>
}

/** The honoured id of the built-in skeleton that is active by default. */
export const DEFAULT_SKELETON_ID = 'default'

const BUILT_IN_REGIONS: readonly SkeletonRegion[] = [
  { name: 'header', description: 'Top chrome: branding, global actions, status.' },
  { name: 'main', description: 'The primary content surface.' },
  { name: 'sidebar', description: 'Side navigation / context panel.' },
  { name: 'footer', description: 'Footer chrome: meta, version, links.' },
]

/**
 * The built-in skeleton supplied out of the box. A product that never registers
 * a custom skeleton gets exactly this one — unchanged behaviour.
 */
export const builtInSkeleton: Skeleton = {
  id: DEFAULT_SKELETON_ID,
  describe: () => ({
    id: DEFAULT_SKELETON_ID,
    name: 'Default',
    description: 'The built-in FUX skeleton: a classic header / sidebar / main / footer shell.',
    regions: BUILT_IN_REGIONS,
  }),
}

/**
 * A registry of UI skeletons. Registration is additive (AR-04): one id maps to
 * one skeleton, duplicates are rejected, and exactly one skeleton is *active*
 * at a time. The built-in default is pre-registered and is the initial active
 * skeleton, so an unrestarted product keeps current behaviour.
 */
export class SkeletonRegistry {
  private readonly byId = new Map<string, Skeleton>()
  private activeId: string

  constructor(builtIn: Skeleton = builtInSkeleton) {
    this.byId.set(builtIn.id, builtIn)
    this.activeId = builtIn.id
  }

  /** Register (or replace) a skeleton under its id and select it as active. */
  registerSkeleton(skeleton: Skeleton): void {
    this.byId.set(skeleton.id, skeleton)
    this.activeId = skeleton.id
  }

  /** Remove a skeleton; throws if the id is unknown. */
  unregisterSkeleton(id: string): void {
    if (!this.byId.delete(id)) throw new UiError('E_SKELETON_NOT_FOUND', `${id}`)
    if (this.activeId === id) this.activeId = 'default'
  }

  /** Switch the active skeleton to an already-registered id. */
  activate(id: string): void {
    if (!this.byId.has(id)) throw new UiError('E_SKELETON_NOT_FOUND', `${id}`)
    this.activeId = id
  }

  /** The currently active skeleton. */
  active(): Skeleton {
    const active = this.byId.get(this.activeId)
    // The registry always keeps at least the built-in skeleton, so this is set.
    if (!active) return builtInSkeleton
    return active
  }

  skeletons(): ReadonlyArray<Skeleton> {
    return [...this.byId.values()]
  }
}

/** UI-framework failure with a stable machine-readable code. */
export class UiError extends Error {
  readonly code: string

  constructor(code: string, detail: string) {
    super(`ui:${code} ${detail}`)
    this.name = 'UiError'
    this.code = code
  }
}

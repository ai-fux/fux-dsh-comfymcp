/**
 * BR-02: an optional, unified discovery contract over the framework's three
 * kinds of registries — plugins, capabilities and connectors. Each registry
 * keeps its original, specialized methods; this adds an opt-in `Discoverable`
 * view so a caller queries all three through one interface. A registry that
 * never opts in (or a project that never calls discover) is unaffected.
 */

/** The three resource families a unified discovery can return. */
export type ResourceKind = 'plugin' | 'capability' | 'connector'

/** A single discoverable resource. `id` is unique within its `kind`. */
export interface FuxResource {
  readonly kind: ResourceKind
  readonly id: string
  /** Runtime position when known (a plugin state, connector state, …). */
  readonly status?: string
  /** Owning/backing identity when relevant (e.g. a capability's provider). */
  readonly entry?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** A read-only query over a unified discovery view. */
export interface DiscoveryQuery {
  readonly kind?: ResourceKind
  readonly status?: string
  /** Case-insensitive substring over `id` and `entry`. */
  readonly text?: string
}

/**
 * The unified discovery contract. A registry implementing it returns resources
 * through the same shape; peers compose by aggregating several `Discoverable`s.
 * This is optional: existing `register`/`list`/`get` methods are untouched.
 */
export interface Discoverable {
  discover(query?: DiscoveryQuery): readonly FuxResource[]
}

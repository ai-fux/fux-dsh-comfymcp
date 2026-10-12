import { satisfiesRange, type PluginManifest, type ProductDefinition } from '@fux/protocol'
import type { PluginRegistry } from './registry.js'
import {
  DependencyCycleError,
  DependencyVersionConflictError,
  DuplicateCapabilityError,
  EmptyProductError,
  MissingCapabilityError,
  MissingDependencyError,
  PluginNotRegisteredError,
} from './errors.js'

export interface ResolveResult {
  order: string[]
  plugins: Map<string, PluginManifest>
  autoIncluded: string[]
  capabilityProviders: Map<string, string>
}

export interface ResolveOptions {
  /** G8: default off. When true, a dependency violating one of its referencing
   *  `dependenciesRanges` is replaced by a `registerVersion`ed candidate that
   *  satisfies *every* referencing range; an irresolvable conflict still throws
   *  DependencyVersionConflictError. Off keeps the exact prior strictness — every
   *  violation throws. Off + no candidates behave identically. */
  autoResolveDependencyVersions?: boolean
}

function findCycle(remaining: Map<string, PluginManifest>): string[] {
  const state = new Map<string, 'visiting' | 'done'>()
  const path: string[] = []

  const visit = (pluginId: string): string[] | null => {
    state.set(pluginId, 'visiting')
    path.push(pluginId)
    const dependencies = remaining.get(pluginId)?.dependencies ?? []
    for (const dependencyId of dependencies) {
      if (!remaining.has(dependencyId)) continue
      if (state.get(dependencyId) === 'visiting') {
        const start = path.indexOf(dependencyId)
        return [...path.slice(start), dependencyId]
      }
      if (state.get(dependencyId) === 'done') continue
      const cycle = visit(dependencyId)
      if (cycle) return cycle
    }
    state.set(pluginId, 'done')
    path.pop()
    return null
  }

  for (const pluginId of remaining.keys()) {
    if (state.has(pluginId)) continue
    const cycle = visit(pluginId)
    if (cycle) return cycle
  }
  return [...remaining.keys()]
}

export function resolveProduct(
  registry: PluginRegistry,
  product: ProductDefinition,
  options: ResolveOptions = {},
): ResolveResult {
  const active = new Map<string, PluginManifest>()
  const explicitIds = new Set<string>()
  const disabledIds = new Set<string>()

  for (const entry of product.plugins) {
    if (!entry.enabled) {
      disabledIds.add(entry.id)
      continue
    }
    const manifest = registry.get(entry.id)
    if (!manifest) throw new PluginNotRegisteredError(entry.id)
    active.set(entry.id, manifest)
    explicitIds.add(entry.id)
  }
  if (active.size === 0) throw new EmptyProductError(product.id)

  const autoIncluded: string[] = []
  const queue = [...active.values()]
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) break
    for (const dependencyId of current.dependencies) {
      if (active.has(dependencyId)) continue
      if (disabledIds.has(dependencyId)) {
        throw new MissingDependencyError(
          current.id,
          dependencyId,
          'it is disabled in the product definition',
        )
      }
      const dependency = registry.get(dependencyId)
      if (!dependency) {
        throw new PluginNotRegisteredError(dependencyId, `required by ${current.id}`)
      }
      active.set(dependencyId, dependency)
      if (!explicitIds.has(dependencyId)) autoIncluded.push(dependencyId)
      queue.push(dependency)
    }
  }

  // G8: optional, default-off auto version resolution for `dependenciesRanges`.
  // When enabled, each violating dependency tries to be replaced by a
  // `registerVersion`ed candidate that satisfies *every* referencing range.
  // Selection is iterated to a fixed point (bounded by the graph size); a
  // dependency with no admissible candidate is left for the preflight below to
  // report as DependencyVersionConflictError — identical to the off-path.
  if (options.autoResolveDependencyVersions) {
    for (let pass = 0; pass <= active.size; pass++) {
      const conflicts = new Map<string, string[]>()
      for (const manifest of active.values()) {
        for (const [depId, range] of Object.entries(manifest.dependenciesRanges ?? {})) {
          const chosen = active.get(depId)
          if (!chosen || satisfiesRange(chosen.version, range)) continue
          const ranges = conflicts.get(depId) ?? []
          ranges.push(range)
          conflicts.set(depId, ranges)
        }
      }
      if (conflicts.size === 0) break
      let changed = false
      for (const [depId, ranges] of conflicts) {
        const replacement = registry
          .candidates(depId)
          .find((candidate) => ranges.every((range) => satisfiesRange(candidate.version, range)))
        if (replacement) {
          active.set(depId, replacement)
          changed = true
        }
      }
      if (!changed) break
    }
  }

  const capabilityProviders = new Map<string, string>()
  for (const [pluginId, manifest] of active) {
    for (const capability of manifest.capabilities) {
      const existing = capabilityProviders.get(capability.name)
      if (existing !== undefined) {
        throw new DuplicateCapabilityError(capability.name, existing, pluginId)
      }
      capabilityProviders.set(capability.name, pluginId)
    }
  }
  for (const [pluginId, manifest] of active) {
    for (const capability of manifest.consumes) {
      if (!capabilityProviders.has(capability)) {
        throw new MissingCapabilityError(pluginId, capability)
      }
    }
  }

  // AR-01: optional dependency semver-range preflight. Absent ranges skip the check.
  for (const [pluginId, manifest] of active) {
    for (const [dependencyId, range] of Object.entries(manifest.dependenciesRanges ?? {})) {
      const dependency = active.get(dependencyId)
      if (!dependency) continue
      if (!satisfiesRange(dependency.version, range)) {
        throw new DependencyVersionConflictError(pluginId, dependencyId, dependency.version, range)
      }
    }
  }

  const indegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const pluginId of active.keys()) {
    indegree.set(pluginId, 0)
    dependents.set(pluginId, [])
  }

  const addEdge = (before: string, after: string): void => {
    indegree.set(after, (indegree.get(after) ?? 0) + 1)
    dependents.get(before)?.push(after)
  }
  for (const [pluginId, manifest] of active) {
    for (const dependencyId of manifest.dependencies) {
      addEdge(dependencyId, pluginId)
    }
    for (const capability of manifest.consumes) {
      const providerId = capabilityProviders.get(capability)
      if (providerId !== undefined && providerId !== pluginId) {
        addEdge(providerId, pluginId)
      }
    }
  }

  const ready = [...active.keys()].filter((id) => (indegree.get(id) ?? 0) === 0).sort()
  const order: string[] = []
  while (ready.length > 0) {
    const pluginId = ready.shift()
    if (pluginId === undefined) break
    order.push(pluginId)
    for (const dependentId of dependents.get(pluginId) ?? []) {
      const next = (indegree.get(dependentId) ?? 0) - 1
      indegree.set(dependentId, next)
      if (next === 0) {
        ready.push(dependentId)
        ready.sort()
      }
    }
  }

  if (order.length !== active.size) {
    const inOrder = new Set(order)
    const remaining = new Map([...active].filter(([id]) => !inOrder.has(id)))
    throw new DependencyCycleError(findCycle(remaining))
  }

  return { order, plugins: active, autoIncluded, capabilityProviders }
}

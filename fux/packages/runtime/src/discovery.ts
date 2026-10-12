/**
 * BR-02: a read-only aggregation over several `Discoverable` sources. The
 * runtime composes the three registry families (plugins, capabilities,
 * connectors) plus any caller-injected sources into one `discover()` view.
 * Sources that opt out simply contribute nothing; existing registry methods are
 * untouched.
 */
import type { Discoverable, DiscoveryQuery, FuxResource } from '@fux/protocol'

export class RuntimeDiscovery {
  private readonly sources: readonly Discoverable[]

  constructor(sources: readonly Discoverable[] = []) {
    this.sources = sources
  }

  /** Add an opt-in source (e.g. an external registry) after construction. */
  add(source: Discoverable): void {
    ;(this.sources as Discoverable[]).push(source)
  }

  /** Merge every source and dedupe by `kind + id`, then apply the query. */
  discover(query?: DiscoveryQuery): FuxResource[] {
    const seen = new Set<string>()
    const merged: FuxResource[] = []
    for (const source of this.sources) {
      for (const resource of source.discover()) {
        const key = `${resource.kind}:${resource.id}`
        if (seen.has(key)) continue
        seen.add(key)
        merged.push(resource)
      }
    }
    if (!query) return merged
    return merged.filter(
      (resource) =>
        (query.kind === undefined || resource.kind === query.kind) &&
        (query.status === undefined || resource.status === query.status) &&
        (query.text === undefined ||
          (resource.id && contains(resource.id, query.text)) ||
          (resource.entry !== undefined && contains(resource.entry, query.text))),
    )
  }
}

function contains(value: string, needle: string): boolean {
  return value.toLowerCase().includes(needle.toLowerCase())
}

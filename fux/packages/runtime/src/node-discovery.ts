import type { Discoverable, DiscoveryQuery, FuxResource } from '@fux/protocol'
import { RemoteNodeUnreachableError } from './errors.js'
import type { HealthStatus } from './health.js'

/**
 * G4: cross-host node discovery + health handshake. The runtime's own discovery
 * (BR-02/ADR-0019) is in-process — plugins/capabilities/connectors of *this*
 * node. G4 adds the network half: discovering peer endpoints, learning each
 * node's identity + capabilities, and keeping a live health handshake (periodic
 * probes + staleness expiry) so remote capabilities surface through the unified
 * `Discoverable` view. Like `RemoteTransport`, the probe is a seam: the contract
 * is transport-agnostic, and `HttpNodeHealthProbe` is the reference HTTP
 * implementation over the G2 endpoint (`GET /health`).
 */

/** What a single health probe learns about a peer (registry adds timestamps). */
export interface NodeProbeResult {
  /** Stable identity the peer advertises for itself. */
  readonly id: string
  /** Capabilities the peer can serve (from its /capabilities or /health view). */
  readonly capabilities: readonly string[]
  /** The peer's own reported health status. */
  readonly status: HealthStatus
  readonly detail?: unknown
}

/** A peer known to this runtime, with liveness bookkeeping. */
export interface RemoteNode {
  readonly id: string
  readonly url: string
  readonly capabilities: readonly string[]
  readonly status: HealthStatus
  readonly firstSeen: number
  readonly lastSeen: number
  readonly detail?: unknown
}

/** Lifecycle events a registry subscriber can observe (per node, per change). */
export type NodeEvent =
  | { readonly type: 'registered'; readonly node: RemoteNode }
  | { readonly type: 'updated'; readonly node: RemoteNode }
  | { readonly type: 'removed'; readonly node: RemoteNode }

/** The transport seam: how one peer's identity + health is obtained. */
export interface NodeHealthProbe {
  probe(url: string): Promise<NodeProbeResult>
  close(): Promise<void>
}

export interface HttpNodeHealthProbeOptions {
  /** Per-probe budget (ms). Default 2000. */
  timeoutMs?: number
}

/**
 * G4: the reference `NodeHealthProbe` over HTTP — `GET {url}/health` answered by
 * the G2 `startRemoteEndpoint` route. Uses only the global `fetch`; a failed or
 * timed-out probe surfaces as `RemoteNodeUnreachableError` (retryable).
 */
export class HttpNodeHealthProbe implements NodeHealthProbe {
  private readonly timeoutMs: number

  constructor(options: HttpNodeHealthProbeOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 2000
  }

  async probe(url: string): Promise<NodeProbeResult> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${url}/health`, { signal: controller.signal })
      if (!res.ok) throw new Error(`health probe returned HTTP ${res.status}`)
      const body = (await res.json()) as {
        nodeId?: unknown
        status?: unknown
        capabilities?: unknown
        uptimeMs?: unknown
        protocolVersion?: unknown
      }
      const id = typeof body.nodeId === 'string' && body.nodeId.length > 0 ? body.nodeId : url
      const capabilities = Array.isArray(body.capabilities)
        ? body.capabilities.filter((c): c is string => typeof c === 'string')
        : []
      const detail =
        body.uptimeMs !== undefined || body.protocolVersion !== undefined
          ? {
              ...(body.uptimeMs === undefined ? {} : { uptimeMs: body.uptimeMs }),
              ...(body.protocolVersion === undefined
                ? {}
                : { protocolVersion: body.protocolVersion }),
            }
          : undefined
      return { id, capabilities, status: normalizeHealthStatus(body.status), detail }
    } catch (error) {
      throw new RemoteNodeUnreachableError(url, error)
    } finally {
      clearTimeout(timer)
    }
  }

  close(): Promise<void> {
    return Promise.resolve()
  }
}

export interface RemoteNodeRegistryOptions {
  /** How a peer is probed; `HttpNodeHealthProbe` is the HTTP reference. */
  probe: NodeHealthProbe
  /** Poll interval for re-probing known peers (ms). Default 5000. */
  intervalMs?: number
  /** Expire a peer whose last successful probe is older than this (ms). Default 15000. */
  staleAfterMs?: number
}

/**
 * G4: a live directory of remote nodes. Peers are registered by URL, probed
 * immediately and then re-probed on an interval; unreachable peers keep their
 * entry (marked `down`) until they go stale, then are removed. Remote
 * capabilities are exposed through `discover()` as `capability` resources
 * (`entry` = node id, `status` = node health), so they fold straight into the
 * unified `RuntimeDiscovery` view with no protocol change.
 */
export class RemoteNodeRegistry implements Discoverable {
  private readonly probe: NodeHealthProbe
  private readonly intervalMs: number
  private readonly staleAfterMs: number
  private readonly watched = new Set<string>()
  private readonly nodes = new Map<string, RemoteNode>()
  private readonly listeners = new Set<(event: NodeEvent) => void>()
  private timer?: ReturnType<typeof setInterval>
  private closed = false
  private inFlight = false

  constructor(options: RemoteNodeRegistryOptions) {
    this.probe = options.probe
    this.intervalMs = options.intervalMs ?? 5000
    this.staleAfterMs = options.staleAfterMs ?? 15000
  }

  get size(): number {
    return this.nodes.size
  }

  /** Current peer directory, newest-insertion last. */
  get snapshot(): readonly RemoteNode[] {
    return [...this.nodes.values()]
  }

  get(nodeId: string): RemoteNode | undefined {
    return this.nodes.get(nodeId)
  }

  /**
   * Watch a peer URL: it is probed immediately and kept in the poll set, so a
   * temporarily unreachable seed is retried on subsequent polls (the returned
   * promise rejects on first-contact failure, but the watch persists).
   */
  async register(url: string): Promise<RemoteNode> {
    if (this.closed) throw new Error('remote node registry is closed')
    this.watched.add(url)
    this.ensureTimer()
    return this.probeUrl(url)
  }

  /** Stop watching a node and remove it from the directory. */
  unregister(nodeId: string): boolean {
    const node = this.nodes.get(nodeId)
    if (!node) return false
    this.nodes.delete(nodeId)
    this.watched.delete(node.url)
    this.emit({ type: 'removed', node })
    if (this.watched.size === 0) this.stopTimer()
    return true
  }

  /** Begin periodic polling (lazy — also started on first `register`). */
  start(): void {
    if (this.closed) return
    this.ensureTimer()
  }

  /**
   * One collection pass: re-probe every watched URL, mark known peers that
   * fail as `down`, and expire peers past their staleness window. Returns the
   * refreshed directory.
   */
  async poll(): Promise<readonly RemoteNode[]> {
    if (this.closed || this.inFlight) return this.snapshot
    this.inFlight = true
    try {
      for (const url of [...this.watched]) {
        await this.probeUrl(url).catch(() => {
          // Keep watching; the entry (if any) degrades and ages toward expiry.
          const known = [...this.nodes.values()].find((node) => node.url === url)
          if (known && known.status !== 'down') {
            const down: RemoteNode = { ...known, status: 'down' }
            this.nodes.set(known.id, down)
            this.emit({ type: 'updated', node: down })
          }
        })
      }
      const cutoff = Date.now() - this.staleAfterMs
      for (const [id, node] of this.nodes) {
        if (node.lastSeen < cutoff) {
          this.nodes.delete(id)
          this.watched.delete(node.url)
          this.emit({ type: 'removed', node })
        }
      }
      return this.snapshot
    } finally {
      this.inFlight = false
    }
  }

  /** Subscribe to node lifecycle changes. Returns an unsubscribe fn. */
  onNode(handler: (event: NodeEvent) => void): () => void {
    this.listeners.add(handler)
    return () => this.listeners.delete(handler)
  }

  /**
   * BR-02 view: each remote capability maps to a `capability` resource with
   * `entry` = node id and `status` = the node's liveness. Remote nodes never
   * appear as `plugin` resources — the base's discovery kinds stay unchanged.
   */
  discover(query?: DiscoveryQuery): readonly FuxResource[] {
    const out: FuxResource[] = []
    for (const node of this.nodes.values()) {
      for (const capability of node.capabilities) {
        out.push({
          kind: 'capability',
          id: capability,
          status: node.status,
          entry: node.id,
          metadata: { nodeId: node.id, url: node.url, lastSeen: node.lastSeen },
        })
      }
    }
    return query ? out.filter((resource) => matchesQuery(resource, query)) : out
  }

  /** Stop polling, release the probe and clear the directory. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.stopTimer()
    await this.probe.close()
    this.nodes.clear()
    this.watched.clear()
    this.listeners.clear()
  }

  private async probeUrl(url: string): Promise<RemoteNode> {
    const result = await this.probe.probe(url)
    const now = Date.now()
    const previous = this.nodes.get(result.id)
    const node: RemoteNode = {
      id: result.id,
      url,
      capabilities: result.capabilities,
      status: result.status,
      firstSeen: previous?.firstSeen ?? now,
      lastSeen: now,
      ...(result.detail === undefined ? {} : { detail: result.detail }),
    }
    this.nodes.set(result.id, node)
    this.emit({ type: previous ? 'updated' : 'registered', node })
    return node
  }

  private emit(event: NodeEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  private ensureTimer(): void {
    if (this.timer || this.closed) return
    this.timer = setInterval(() => {
      void this.poll()
    }, this.intervalMs)
    // Never keep the process alive for a background peer directory.
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }
}

function normalizeHealthStatus(value: unknown): HealthStatus {
  return value === 'degraded' || value === 'down' ? value : 'ok'
}

function matchesQuery(resource: FuxResource, query: DiscoveryQuery): boolean {
  if (query.kind !== undefined && resource.kind !== query.kind) return false
  if (query.status !== undefined && resource.status !== query.status) return false
  if (
    query.text !== undefined &&
    !(resource.id && contains(resource.id, query.text)) &&
    !(resource.entry !== undefined && contains(resource.entry, query.text))
  ) {
    return false
  }
  return true
}

function contains(value: string, needle: string): boolean {
  return value.toLowerCase().includes(needle.toLowerCase())
}

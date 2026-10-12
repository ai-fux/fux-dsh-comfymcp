import { afterAll, describe, expect, it, vi } from 'vitest'
import { FuxCore } from '@fux/core'
import type { PluginManifest } from '@fux/protocol'
import { Supervisor } from '../src/supervisor.js'
import { RemoteNodeUnreachableError } from '../src/errors.js'
import { startRemoteEndpoint, type RemoteEndpoint } from '../src/http-remote-endpoint.js'
import {
  HttpNodeHealthProbe,
  RemoteNodeRegistry,
  type NodeHealthProbe,
  type NodeProbeResult,
  type RemoteNode,
} from '../src/node-discovery.js'

/** Controllable probe: per-url results and failure toggles, no network. */
class StubProbe implements NodeHealthProbe {
  readonly state = new Map<string, NodeProbeResult>()
  readonly failing = new Set<string>()
  readonly calls: string[] = []
  closed = false

  async probe(url: string): Promise<NodeProbeResult> {
    this.calls.push(url)
    if (this.failing.has(url)) throw new Error(`down: ${url}`)
    const result = this.state.get(url)
    if (!result) throw new Error(`unknown: ${url}`)
    return result
  }

  async close(): Promise<void> {
    this.closed = true
  }

  seed(url: string, result: NodeProbeResult): void {
    this.state.set(url, result)
  }
}

function stubResult(partial: Partial<NodeProbeResult> = {}): NodeProbeResult {
  return { id: 'node-a', capabilities: ['alpha:count'], status: 'ok', ...partial }
}

function node(node: RemoteNode): RemoteNode {
  return node
}

describe('G4 · /health endpoint + HttpNodeHealthProbe', () => {
  let endpoint: RemoteEndpoint | undefined

  afterAll(async () => {
    await endpoint?.close()
    endpoint = undefined
  })

  it('probes a live endpoint: identity, status, capabilities and protocol version', async () => {
    endpoint = await startRemoteEndpoint({
      capabilities: ['alpha:count'],
      nodeId: 'node-http',
      health: () => 'degraded',
      handler: async () => ({ id: 'req', ok: true, result: 1 }),
    })
    const probe = new HttpNodeHealthProbe({ timeoutMs: 2000 })
    const result = await probe.probe(endpoint.url)
    expect(result.id).toBe('node-http')
    expect(result.status).toBe('degraded')
    expect(result.capabilities).toEqual(['alpha:count'])
    expect(result.detail).toMatchObject({ protocolVersion: '0.1.1' })
    await probe.close()
  })

  it('derives the node id from the url when nodeId is not provided', async () => {
    endpoint = await startRemoteEndpoint({
      handler: async () => ({ id: 'req', ok: true, result: 1 }),
    })
    const probe = new HttpNodeHealthProbe()
    const result = await probe.probe(endpoint.url)
    expect(result.id).toBe(endpoint.url)
    await probe.close()
  })

  it('defaults a healthy status to ok', async () => {
    endpoint = await startRemoteEndpoint({
      capabilities: ['beta:work'],
      handler: async () => ({ id: 'req', ok: true, result: 1 }),
    })
    const probe = new HttpNodeHealthProbe()
    const result = await probe.probe(endpoint.url)
    expect(result.status).toBe('ok')
    await probe.close()
  })

  it('rejects an unreachable endpoint as RemoteNodeUnreachableError (retryable)', async () => {
    const probe = new HttpNodeHealthProbe({ timeoutMs: 300 })
    const error = (await probe.probe('http://127.0.0.1:1').catch((e) => e)) as unknown
    expect(error).toBeInstanceOf(RemoteNodeUnreachableError)
    expect((error as { retryable: boolean }).retryable).toBe(true)
    await probe.close()
  })
})

describe('G4 · RemoteNodeRegistry lifecycle', () => {
  it('registers a peer, probing immediately and emitting a registered event', async () => {
    const probe = new StubProbe()
    probe.seed('http://a', stubResult({ id: 'node-a' }))
    const registry = new RemoteNodeRegistry({ probe })
    const events: string[] = []
    registry.onNode((e) => events.push(e.type))

    const registered = await registry.register('http://a')

    expect(registry.size).toBe(1)
    expect(registry.snapshot[0]).toMatchObject({ id: 'node-a', url: 'http://a' })
    expect(registered.id).toBe('node-a')
    expect(events).toEqual(['registered'])
    await registry.close()
  })

  it('re-registering the same url emits updated and preserves firstSeen', async () => {
    const probe = new StubProbe()
    probe.seed('http://a', stubResult({ id: 'node-a' }))
    const registry = new RemoteNodeRegistry({ probe })
    await registry.register('http://a')
    const first = registry.get('node-a')!

    await registry.register('http://a')

    const second = registry.get('node-a')!
    expect(second.firstSeen).toBe(first.firstSeen)
    expect(second.lastSeen).toBeGreaterThanOrEqual(first.lastSeen)
    await registry.close()
  })

  it('keeps watching a url whose first contact fails (seed retry)', async () => {
    const probe = new StubProbe()
    const registry = new RemoteNodeRegistry({ probe, intervalMs: 100_000 })
    await expect(registry.register('http://down')).rejects.toThrow(/unknown/)
    // The url stays in the watch set even though it never produced a node.
    probe.seed('http://down', stubResult({ id: 'node-recovered' }))
    const recovered = await registry.poll()
    expect(recovered).toHaveLength(1)
    expect(recovered[0]!.id).toBe('node-recovered')
    await registry.close()
  })

  it('unregister removes the peer and emits removed', async () => {
    const probe = new StubProbe()
    probe.seed('http://a', stubResult({ id: 'node-a' }))
    const registry = new RemoteNodeRegistry({ probe })
    await registry.register('http://a')
    const events: string[] = []
    registry.onNode((e) => events.push(e.type))

    expect(registry.unregister('node-a')).toBe(true)
    expect(registry.unregister('node-a')).toBe(false)
    expect(registry.size).toBe(0)
    expect(events).toEqual(['removed'])
    await registry.close()
  })

  it('exposes remote capabilities as capability resources in discover()', async () => {
    const probe = new StubProbe()
    probe.seed('http://a', stubResult({ id: 'node-a', capabilities: ['alpha:count'] }))
    probe.seed(
      'http://b',
      stubResult({ id: 'node-b', capabilities: ['beta:work'], status: 'down' }),
    )
    const registry = new RemoteNodeRegistry({ probe })
    await registry.register('http://a')
    await registry.register('http://b')

    const all = registry.discover()
    expect(all).toEqual([
      expect.objectContaining({ kind: 'capability', id: 'alpha:count', entry: 'node-a' }),
      expect.objectContaining({ kind: 'capability', id: 'beta:work', entry: 'node-b' }),
    ])
    // Query filters: status / text / kind.
    expect(registry.discover({ status: 'down' })).toEqual([
      expect.objectContaining({ id: 'beta:work' }),
    ])
    expect(registry.discover({ text: 'count' })).toEqual([
      expect.objectContaining({ id: 'alpha:count' }),
    ])
    expect(registry.discover({ kind: 'connector' })).toEqual([])
    await registry.close()
  })

  it('poll marks a known peer down on probe failure, then expires it when stale', async () => {
    vi.useFakeTimers()
    try {
      const probe = new StubProbe()
      probe.seed('http://a', stubResult({ id: 'node-a' }))
      const registry = new RemoteNodeRegistry({ probe, intervalMs: 100_000, staleAfterMs: 50 })
      await registry.register('http://a')
      expect(registry.get('node-a')!.status).toBe('ok')

      probe.failing.add('http://a')
      await registry.poll()
      expect(registry.get('node-a')!.status).toBe('down')

      // lastSeen is unchanged by failed probes; advancing time past the window
      // lets the next poll expire the stale peer.
      vi.advanceTimersByTime(100)
      const events: string[] = []
      registry.onNode((e) => events.push(e.type))
      await registry.poll()
      expect(registry.size).toBe(0)
      expect(events).toEqual(['removed'])
      await registry.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('close stops the poll timer and releases the probe', async () => {
    const probe = new StubProbe()
    probe.seed('http://a', stubResult({ id: 'node-a' }))
    const registry = new RemoteNodeRegistry({ probe, intervalMs: 10 })
    registry.start()
    await registry.register('http://a')
    await registry.close()
    expect(probe.closed).toBe(true)
    expect(registry.size).toBe(0)
    // A second close is idempotent.
    await registry.close()
  })
})

describe('G4 · supervisor remoteNodes wiring', () => {
  const manifest: PluginManifest = {
    id: '@fux/local',
    name: 'Local',
    version: '0.0.1',
    protocol: '^0.1.0',
    executionMode: 'in_process',
    capabilities: [{ name: 'alpha:echo', version: '1.0.0' }],
    consumes: [],
    dependencies: [],
  }

  function composeLocal() {
    const core = new FuxCore()
    core.register(manifest)
    const { graph } = core.compose({
      id: 'g4-product',
      name: 'G4 Product',
      version: '0.0.1',
      plugins: [{ id: '@fux/local' }],
    })
    return { core, graph }
  }

  it('folds remote peers into nodes() and the unified discover() view', async () => {
    const { graph } = composeLocal()
    const probe = new StubProbe()
    probe.seed('http://peer', stubResult({ id: 'node-peer', capabilities: ['beta:work'] }))
    const supervisor = new Supervisor(new FuxCore().events, {
      remoteNodes: { probe, urls: ['http://peer'], intervalMs: 100_000 },
    })
    const runtime = await supervisor.start(graph, () => ({ activate: () => {} }))

    await vi.waitFor(() => expect(runtime.nodes()).toHaveLength(1))
    expect(node(runtime.nodes()[0]!)).toMatchObject({ id: 'node-peer', url: 'http://peer' })
    // Remote capability appears in the same discovery view as local ones.
    const caps = runtime.discover({ kind: 'capability' }).map((r) => r.id)
    expect(caps).toContain('beta:work')
    expect(caps).toContain('alpha:echo')
    expect(runtime.discover({ text: 'peer' })).toEqual([
      expect.objectContaining({ id: 'beta:work', entry: 'node-peer' }),
    ])

    await runtime.stop()
    expect(probe.closed).toBe(true)
  })

  it('leaves nodes() empty and performs no probes when remoteNodes is absent', async () => {
    const { graph } = composeLocal()
    const probe = new StubProbe()
    const supervisor = new Supervisor(new FuxCore().events, {})
    const runtime = await supervisor.start(graph, () => ({ activate: () => {} }))

    expect(runtime.nodes()).toEqual([])
    expect(probe.calls).toEqual([])
    await runtime.stop()
  })

  it('does not fail product start when a seed is temporarily unreachable', async () => {
    const { graph } = composeLocal()
    const probe = new StubProbe()
    const supervisor = new Supervisor(new FuxCore().events, {
      // Short poll interval so the periodic pass picks up the recovery below.
      remoteNodes: { probe, urls: ['http://down'], intervalMs: 20 },
    })
    const runtime = await supervisor.start(graph, () => ({ activate: () => {} }))

    expect(runtime.nodes()).toEqual([])
    // Once the peer comes up, the registry recovers it on the next poll pass.
    probe.seed('http://down', stubResult({ id: 'node-recovered' }))
    await vi.waitFor(() => expect(runtime.nodes()).toHaveLength(1), { timeout: 2000 })
    await runtime.stop()
  })
})

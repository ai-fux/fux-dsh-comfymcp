import { describe, expect, it } from 'vitest'
import { EventBus } from '@fux/core'
import type { IpcResponse } from '@fux/protocol'
import { RemoteHost, type RemoteHostOptions } from '../src/remote-host.js'
import { LoopbackRemoteTransport } from '../src/remote-transport.js'

function makeHost(
  farSide?: (request: {
    id: string
    capability: string
    payload?: unknown
  }) => IpcResponse | Promise<IpcResponse>,
  options: Partial<RemoteHostOptions> = {},
) {
  const events = new EventBus()
  const transport = new LoopbackRemoteTransport()
  if (farSide) transport.setFarSide(farSide)
  const host = new RemoteHost('@fux/rstat', { transport, events, source: '@fux/rstat', ...options })
  transport.pushCapabilities(['alpha:count'])
  return { host, transport, events }
}

describe('RemoteHost · status (G1, executionMode: remote)', () => {
  it('reports started after the transport opens and stopped after close', async () => {
    const { host } = makeHost()
    expect(host.status()).toBe('registered')
    await host.start()
    expect(host.status()).toBe('started')
    await host.stop()
    expect(host.status()).toBe('stopped')
  })

  it('reflects far-side capabilities into providedCapabilities', async () => {
    const { host } = makeHost()
    await host.start()
    expect(host.providedCapabilities()).toEqual(['alpha:count'])
  })
})

describe('RemoteHost · invoke round-trip (G1)', () => {
  it('round-trips a capability call and its return value', async () => {
    const { host } = makeHost(async (req) => ({
      id: req.id,
      ok: true,
      result: (req.payload as { n: number }).n * 2,
    }))
    await host.start()
    const res = await host.invoke('alpha:count', { n: 21 })
    expect(res.ok).toBe(true)
    expect((res as { result: unknown }).result).toBe(42)
  })

  it('surfaces a far-side failure as a failed IpcResponse', async () => {
    const { host } = makeHost(async (req) => ({
      id: req.id,
      ok: false,
      error: { code: 'E_PLUGIN_ERROR', message: 'remote boom', retryable: false },
    }))
    await host.start()
    const res = (await host.invoke('alpha:count')) as { ok: false; error: { message: string } }
    expect(res.ok).toBe(false)
    expect(res.error.message).toBe('remote boom')
  })

  it('fails invokes when the far side is unreachable', async () => {
    const { host } = makeHost() // no farSide registered
    await host.start()
    const res = (await host.invoke('alpha:count')) as { ok: false; error: { retryable: boolean } }
    expect(res.ok).toBe(false)
    expect(res.error.retryable).toBe(true)
  })

  it('fails invokes before start without hanging', async () => {
    const { host } = makeHost()
    const res = (await host.invoke('alpha:count')) as { ok: false; error: { retryable: boolean } }
    expect(res.ok).toBe(false)
    expect(res.error.retryable).toBe(true)
  })
})

describe('RemoteHost · event forwarding (G1)', () => {
  it('re-emits far-side events on the core bus with the plugin as source', async () => {
    const { host, transport, events } = makeHost()
    const seen: unknown[] = []
    events.on('alpha:ping', (e) =>
      seen.push({ topic: e.topic, source: e.source, payload: e.payload }),
    )
    await host.start()
    transport.pushEvent({
      topic: 'alpha:ping',
      payload: { ok: true },
      source: 'far-side',
      occurredAt: Date.now(),
    })
    expect(seen).toEqual([{ topic: 'alpha:ping', source: '@fux/rstat', payload: { ok: true } }])
  })

  it('queues far-side events until the transport is open', async () => {
    const { host, transport, events } = makeHost()
    transport.pushEvent({ topic: 'alpha:early', payload: 1, occurredAt: 1 })
    const seen: number[] = []
    events.on('alpha:early', (e) => seen.push(e.payload as number))
    await host.start()
    expect(seen).toEqual([1])
  })

  it('does not duplicate queued events across repeated opens', async () => {
    const { host, transport, events } = makeHost()
    transport.pushEvent({ topic: 'alpha:early', payload: 1, occurredAt: 1 })
    const seen: number[] = []
    events.on('alpha:early', (e) => seen.push(e.payload as number))
    await host.start()
    await host.stop()
    await host.start()
    expect(seen).toEqual([1])
  })
})

describe('RemoteHost · disconnect supervision (G1 强化)', () => {
  it('marks the host broken and reports it on an unexpected disconnect', async () => {
    const exits: unknown[] = []
    const { host, transport } = makeHost(undefined, { onExit: (reason) => exits.push(reason) })
    await host.start()
    const reason = new Error('peer gone')
    transport.pushDisconnect(reason)
    expect(host.status()).toBe('broken')
    expect(host.providedCapabilities()).toEqual([])
    expect(exits).toEqual([reason])
  })

  it('ignores a disconnect during a normal stop', async () => {
    const exits: unknown[] = []
    const { host, transport } = makeHost(undefined, { onExit: (reason) => exits.push(reason) })
    await host.start()
    const stopping = host.stop()
    transport.pushDisconnect(new Error('closing'))
    await stopping
    expect(host.status()).toBe('stopped')
    expect(exits).toHaveLength(0)
  })
})

describe('RemoteHost · per-invoke timeout (G1 强化)', () => {
  it('times out an invoke the far side never replies to', async () => {
    const { host } = makeHost(async () => new Promise(() => {}), { invokeTimeoutMs: 50 })
    await host.start()
    const res = (await host.invoke('alpha:count')) as {
      ok: false
      error: { code: string; retryable: boolean }
    }
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe('E_TIMEOUT')
    expect(res.error.retryable).toBe(true)
  })

  it('still resolves a fast reply within the budget', async () => {
    const { host } = makeHost(async (req) => ({ id: req.id, ok: true, result: 42 }), {
      invokeTimeoutMs: 500,
    })
    await host.start()
    const res = (await host.invoke('alpha:count')) as { ok: true; result?: unknown }
    expect(res.ok).toBe(true)
    expect(res.result).toBe(42)
  })
})

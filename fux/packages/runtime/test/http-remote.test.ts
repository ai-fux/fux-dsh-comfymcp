import { afterAll, describe, expect, it } from 'vitest'
import { EventBus } from '@fux/core'
import { HttpRemoteTransport } from '../src/http-remote-transport.js'
import { startRemoteEndpoint, type RemoteEndpoint } from '../src/http-remote-endpoint.js'
import { RemoteHost } from '../src/remote-host.js'

let endpoint: RemoteEndpoint | undefined

afterAll(async () => {
  await endpoint?.close()
  endpoint = undefined
})

describe('G2 · HTTP/JSON wire transport round-trip', () => {
  it('serves capabilities and round-trips an invoke across HTTP', async () => {
    endpoint = await startRemoteEndpoint({
      capabilities: ['alpha:count'],
      handler: async (req) => ({
        id: req.id,
        ok: true,
        result: (req.payload as { n: number }).n * 2,
      }),
    })
    const transport = new HttpRemoteTransport({ url: endpoint!.url })
    await transport.open()

    const caps: string[] = []
    transport.onCapabilities((c) => caps.push(...c))
    expect(caps).toEqual(['alpha:count'])

    const res = await transport.call({ id: 'req-1', capability: 'alpha:count', payload: { n: 21 } })
    expect(res.ok).toBe(true)
    expect((res as { result: unknown }).result).toBe(42)
    await transport.close()
  })

  it('surfaces a far-side failure as a failed IpcResponse', async () => {
    endpoint = await startRemoteEndpoint({
      handler: async () => ({
        id: 'req-x',
        ok: false,
        error: { code: 'E_PLUGIN_ERROR', message: 'remote boom', retryable: false },
      }),
    })
    const transport = new HttpRemoteTransport({ url: endpoint!.url })
    await transport.open()
    const res = (await transport.call({ id: 'req-x', capability: 'alpha:count' })) as {
      ok: false
      error: { message: string }
    }
    expect(res.ok).toBe(false)
    expect(res.error.message).toBe('remote boom')
    await transport.close()
  })

  it('answers a malformed / missing handler failure as a 5xx-tolerant IpcResponse', async () => {
    endpoint = await startRemoteEndpoint({
      handler: async () => {
        throw new Error('unexpected')
      },
    })
    const transport = new HttpRemoteTransport({ url: endpoint!.url })
    await transport.open()
    const res = await transport.call({ id: 'req-e', capability: 'alpha:count' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.message).toContain('unexpected')
    await transport.close()
  })

  it('reports an unreachable endpoint as a retryable failure without hanging', async () => {
    const transport = new HttpRemoteTransport({ url: 'http://127.0.0.1:1' })
    await transport.open()
    const res = (await transport.call({ id: 'req-n', capability: 'alpha:count' })) as {
      ok: false
      error: { retryable: boolean }
    }
    expect(res.ok).toBe(false)
    expect(res.error.retryable).toBe(true)
    await transport.close()
  })
})

describe('G2 · RemoteHost over HTTP wire (end-to-end)', () => {
  it('mirrors a pushed far-side event onto the shared bus', async () => {
    endpoint = await startRemoteEndpoint({
      capabilities: ['alpha:count'],
      handler: async () => ({ id: 'req', ok: true, result: 1 }),
    })
    const events = new EventBus()
    const seen: unknown[] = []
    events.on('alpha:beacon', (e) => seen.push(e.payload))
    const host = new RemoteHost('@fux/httphost', {
      transport: new HttpRemoteTransport({ url: endpoint!.url }),
      events,
      source: '@fux/httphost',
    })
    await host.start()
    endpoint!.pushEvent({ topic: 'alpha:beacon', payload: { ok: true }, occurredAt: Date.now() })
    // The SSE frame races the assertion; settle on the next tick.
    await new Promise((r) => setTimeout(r, 20))
    expect(seen).toEqual([{ ok: true }])
    expect(host.providedCapabilities()).toEqual(['alpha:count'])
    await host.stop()
  })
})

describe('G2 · startRemoteEndpoint lifecycle (G2)', () => {
  it('starts with an http url and closes cleanly (idempotent)', async () => {
    const ep = await startRemoteEndpoint({
      handler: async () => ({ id: 'req', ok: true, result: 1 }),
    })
    expect(ep.url).toMatch(/^http:\/\//)
    await ep.close()
    await ep.close()
    endpoint = undefined
  })
})

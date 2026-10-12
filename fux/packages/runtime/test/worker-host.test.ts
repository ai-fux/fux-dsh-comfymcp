import { describe, expect, it, vi } from 'vitest'
import type { PluginManifest } from '@fux/protocol'
import { EventBus } from '@fux/core'
import { InProcessWorkerChannel, WorkerHost, type WorkerHostOptions } from '../src/worker-host.js'
import { WorkerRuntime } from '../src/worker-runtime.js'
import type { FuxPluginModule, PluginContext } from '../src/types.js'

const manifest: PluginManifest = {
  id: '@fux/wstat',
  name: 'WorkerStat',
  version: '0.0.1',
  protocol: '^0.1.0',
  executionMode: 'worker',
  capabilities: [{ name: 'alpha:count', version: '1.0.0' }],
  consumes: ['beta:work'],
  dependencies: [],
}

interface Fixture {
  host: WorkerHost
  channel: InProcessWorkerChannel
  events: EventBus
  context: PluginContext
}

function makeWorker(
  activate?: (context: PluginContext) => void | Promise<void>,
  load: (moduleRef?: string) => FuxPluginModule | Promise<FuxPluginModule> = async () => ({
    activate: async () => {},
  }),
  call?: (capability: string, payload?: unknown) => Promise<unknown>,
  options: Partial<Pick<WorkerHostOptions, 'invokeTimeoutMs' | 'onExit'>> = {},
): Fixture {
  const events = new EventBus()
  const child: { runtime?: WorkerRuntime } = {}
  let captured: PluginContext = null as unknown as PluginContext
  const channel = new InProcessWorkerChannel((message) => {
    void child.runtime?.dispatch(message)
  })
  const runtime = new WorkerRuntime({
    send: (message) => channel.emitToParent(message),
    load: async (moduleRef) => {
      const mod = await load(moduleRef)
      return {
        ...mod,
        activate: async (context: PluginContext) => {
          captured = context
          await activate?.(context)
        },
      }
    },
  })
  child.runtime = runtime
  const host = new WorkerHost(
    manifest,
    {},
    {
      channel,
      events,
      call: call ?? (async () => 'unused'),
      ...options,
    },
  )
  return {
    host,
    channel,
    events,
    get context(): PluginContext {
      return captured
    },
  }
}

function ok(res: { ok: true; result?: unknown }): unknown {
  return res.result
}

describe('WorkerHost · start / capabilities (G1)', () => {
  it('starts, activates the child module and exposes registered capabilities', async () => {
    const activated = vi.fn()
    const { host } = makeWorker((ctx) => {
      activated()
      ctx.provide('alpha:count', () => 3)
    })
    await host.start()
    expect(activated).toHaveBeenCalledTimes(1)
    expect(host.status()).toBe('started')
    expect(host.providedCapabilities()).toEqual(['alpha:count'])
  })

  it('is idempotent across an already-started host', async () => {
    const { host } = makeWorker()
    await host.start()
    await host.start()
    expect(host.status()).toBe('started')
  })

  it('starts immediately (no microtask gap keeps the child active) and stops cleanly', async () => {
    const { host } = makeWorker((ctx) => ctx.provide('alpha:count', () => 1))
    await host.start()
    await host.stop()
    expect(host.status()).toBe('stopped')
  })

  it('rejects a start when the child cannot load the module', async () => {
    const { host } = makeWorker(
      () => {},
      async () => {
        throw new Error('module activation failed')
      },
    )
    await expect(host.start()).rejects.toThrow(/module activation failed/)
    expect(host.status()).toBe('broken')
  })

  it('rejects a start when the child reports startFailed', async () => {
    const { host } = makeWorker(() => {
      throw new Error('boom')
    })
    await expect(host.start()).rejects.toThrow(/boom/)
    expect(host.status()).toBe('broken')
  })
})

describe('WorkerHost · invoke round-trip (G1)', () => {
  it('propagates the handler return value across the channel', async () => {
    const { host } = makeWorker((ctx) =>
      ctx.provide('alpha:count', (payload) => (payload as { n: number }).n + 1),
    )
    await host.start()
    const res = await host.invoke('alpha:count', { n: 41 })
    expect(res.ok).toBe(true)
    expect(ok(res as { ok: true; result?: unknown })).toBe(42)
  })

  it('propagates a plugin error as a failed IpcResponse (not a throw)', async () => {
    const { host } = makeWorker((ctx) => {
      ctx.provide('alpha:count', () => {
        throw new Error('boom')
      })
    })
    await host.start()
    const res = (await host.invoke('alpha:count')) as { ok: false; error: { message: string } }
    expect(res.ok).toBe(false)
    expect(res.error.message).toContain('boom')
  })

  it('returns E_CAPABILITY_NOT_FOUND when the declared handler is not provided', async () => {
    const { host } = makeWorker()
    await host.start()
    const res = (await host.invoke('alpha:count')) as { ok: false; error: { code: string } }
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe('E_CAPABILITY_NOT_FOUND')
  })

  it('refuses (locally) a capability the worker never registered', async () => {
    const { host } = makeWorker((ctx) => ctx.provide('alpha:count', () => 1))
    await host.start()
    const res = (await host.invoke('other:cap')) as { ok: false; error: { code: string } }
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe('E_CAPABILITY_NOT_FOUND')
  })

  it('fails invokes before start without hanging', async () => {
    const { host } = makeWorker((ctx) => ctx.provide('alpha:count', () => 1))
    const res = (await host.invoke('alpha:count')) as { ok: false; error: { retryable: boolean } }
    expect(res.ok).toBe(false)
    expect(res.error.retryable).toBe(true)
  })
})

describe('WorkerHost · events and cross-capability calls (G1)', () => {
  it('forwards worker-emitted events to the parent bus with the plugin as source', async () => {
    const { host, events } = makeWorker((ctx) => {
      ctx.provide('alpha:count', () => {
        ctx.events.emit('alpha:ping', { n: 1 })
        return 'ok'
      })
    })
    const seen: unknown[] = []
    events.on('alpha:ping', (e) =>
      seen.push({ topic: e.topic, source: e.source, payload: e.payload }),
    )
    await host.start()
    await host.invoke('alpha:count')
    expect(seen).toEqual([{ topic: 'alpha:ping', source: '@fux/wstat', payload: { n: 1 } }])
  })

  it('routes a worker-originated context.call through the injected call resolver', async () => {
    const calls: string[] = []
    const { host } = makeWorker(
      (ctx) => {
        ctx.provide('alpha:count', async () => (await ctx.call('beta:work')) as string)
      },
      undefined,
      async (capability) => {
        calls.push(capability)
        return 'forwarded'
      },
    )
    await host.start()
    const res = await host.invoke('alpha:count')
    expect(res.ok).toBe(true)
    expect(ok(res as { ok: true; result?: unknown })).toBe('forwarded')
    expect(calls).toEqual(['beta:work'])
  })

  it('surfaces a failed worker-originated call as a plugin error', async () => {
    const { host } = makeWorker(
      (ctx) => {
        ctx.provide('alpha:count', async () => (await ctx.call('beta:work')) as string)
      },
      undefined,
      async () => {
        throw new Error('beta down')
      },
    )
    await host.start()
    const res = (await host.invoke('alpha:count')) as { ok: false; error: { message: string } }
    expect(res.ok).toBe(false)
    expect(res.error.message).toContain('beta down')
  })

  it('notifies the parent when the worker dies mid-start', async () => {
    const { channel, host } = makeWorker((ctx) => ctx.provide('alpha:count', () => 1))
    const pending = host.start()
    // The child never answers; simulate a crash before it could.
    queueMicrotask(() => channel.emitExit(1, 'SIGTERM'))
    await expect(pending).rejects.toThrow(/exited unexpectedly/)
  })
})

describe('WorkerHost · exit supervision (G1 强化)', () => {
  it('marks the host broken and fails in-flight invokes on an unexpected exit', async () => {
    const exits: unknown[] = []
    const { host, channel } = makeWorker(
      (ctx) => ctx.provide('alpha:count', () => 1),
      undefined,
      undefined,
      { onExit: (reason) => exits.push(reason) },
    )
    await host.start()
    const pending = host.invoke('alpha:count')
    channel.emitExit(1, 'SIGKILL', new Error('killed'))
    const res = (await pending) as { ok: false; error: { code: string; retryable: boolean } }

    expect(res.ok).toBe(false)
    expect(res.error.code).toBe('E_PLUGIN_CRASHED')
    expect(res.error.retryable).toBe(true)
    expect(host.status()).toBe('broken')
    expect(host.providedCapabilities()).toEqual([])
    expect(exits).toEqual([expect.any(Error)])
  })

  it('treats a clean unexpected exit while running as a crash too', async () => {
    const exits: unknown[] = []
    const { host, channel } = makeWorker(
      (ctx) => ctx.provide('alpha:count', () => 1),
      undefined,
      undefined,
      { onExit: (reason) => exits.push(reason) },
    )
    await host.start()
    channel.emitExit(0, null)
    expect(host.status()).toBe('broken')
    expect(exits).toEqual(['worker exited with code 0'])
  })

  it('does not report a crash when the worker exits during a normal stop', async () => {
    const exits: unknown[] = []
    const { host, channel } = makeWorker(
      (ctx) => ctx.provide('alpha:count', () => 1),
      undefined,
      undefined,
      { onExit: (reason) => exits.push(reason) },
    )
    await host.start()
    const stopping = host.stop()
    channel.emitExit(0, null)
    await stopping
    expect(host.status()).toBe('stopped')
    expect(exits).toHaveLength(0)
  })
})

describe('WorkerHost · per-invoke timeout (G1 强化)', () => {
  it('times out an invoke the worker never replies to', async () => {
    const { host } = makeWorker(
      (ctx) => ctx.provide('alpha:count', () => new Promise(() => {})),
      undefined,
      undefined,
      { invokeTimeoutMs: 50 },
    )
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
    const { host } = makeWorker(
      (ctx) => ctx.provide('alpha:count', () => 7),
      undefined,
      undefined,
      { invokeTimeoutMs: 500 },
    )
    await host.start()
    const res = (await host.invoke('alpha:count')) as { ok: true; result?: unknown }
    expect(res.ok).toBe(true)
    expect(res.result).toBe(7)
  })
})

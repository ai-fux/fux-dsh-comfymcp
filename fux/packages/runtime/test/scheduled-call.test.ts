import { describe, expect, it } from 'vitest'
import { FuxCore } from '@fux/core'
import { DuplicateTaskError, priority, TaskCancelledError, TaskScheduler } from '@fux/queue'
import { IpcInvocationError } from '../src/errors.js'
import { Supervisor } from '../src/supervisor.js'
import type { SchedulerSetup } from '../src/types.js'
import type { FuxPluginModule, PluginContext } from '../src/types.js'

const pingManifest = {
  id: '@fux/ping-provider',
  name: 'Ping',
  version: '0.0.2',
  protocol: '^0.1.0',
  executionMode: 'in_process' as const,
  capabilities: [{ name: 'ping:ping', version: '0.0.1' }],
}

interface PingPayload {
  tag?: string
  gate?: Promise<void>
  boom?: boolean
}

interface Rec {
  order: string[]
  running: number
  peak: number
}

function pingModule(rec: Rec): FuxPluginModule {
  return {
    activate(ctx: PluginContext) {
      ctx.provide('ping:ping', async (raw: unknown) => {
        const payload = raw as PingPayload
        if (payload.boom) throw new Error('boom')
        rec.running++
        rec.peak = Math.max(rec.peak, rec.running)
        if (payload.gate) await payload.gate
        rec.order.push(payload.tag ?? '')
        rec.running--
        return `pong:${payload.tag ?? ''}`
      })
    },
  }
}

/** A deferred with a stable, hoisted release function (no TDZ surprises). */
function gatePromise(): { gate: Promise<void>; release: () => void } {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  return { gate, release }
}

type Started = Awaited<ReturnType<Supervisor['start']>>

async function startWith(
  scheduler?: TaskScheduler<unknown> | SchedulerSetup,
): Promise<{ rec: Rec; start: Promise<Started> }> {
  const core = new FuxCore()
  core.register(pingManifest)
  const { graph } = core.compose({
    id: 'schedule-product',
    name: 'Schedule',
    version: '0.0.1',
    plugins: [{ id: pingManifest.id }],
  })
  const rec: Rec = { order: [], running: 0, peak: 0 }
  const modules = new Map<string, FuxPluginModule>([[pingManifest.id, pingModule(rec)]])
  const supervisor = scheduler
    ? new Supervisor(core.events, { scheduler })
    : new Supervisor(core.events)
  const start = supervisor.start(graph, (id) => {
    const module = modules.get(id)
    if (!module) throw new Error(`no module for ${id}`)
    return module
  })
  return { rec, start }
}

describe('Supervisor scheduled-execution path (CR-03 wiring)', () => {
  it('falls back to a direct call when no queue is configured (backward compatible)', async () => {
    const { rec, start } = await startWith()
    const runtime = await start
    await expect(runtime.scheduleAsSystem('ping:ping', { tag: 'direct' })).resolves.toBe(
      'pong:direct',
    )
    expect(rec.order).toEqual(['direct'])
    expect(runtime.queueInfo()).toBeUndefined()
    await expect(runtime.drainQueue()).resolves.toBeUndefined()
    await runtime.stop()
  })

  it('mirrors call() result semantics through the queue', async () => {
    const { start } = await startWith({ concurrency: 2 })
    const runtime = await start
    const p1 = runtime.scheduleAsSystem('ping:ping', { tag: 'a' })
    const p2 = runtime.scheduleAsSystem('ping:ping', { tag: 'b' })
    await expect(Promise.all([p1, p2])).resolves.toEqual(['pong:a', 'pong:b'])
    await runtime.drainQueue()
    await runtime.stop()
  })

  it('enforces the configured concurrency cap on scheduled calls', async () => {
    const { rec, start } = await startWith({ concurrency: 2 })
    const runtime = await start
    const { gate, release } = gatePromise()
    for (let i = 1; i <= 6; i++) {
      void runtime.scheduleAsSystem('ping:ping', { tag: `c${i}`, gate })
    }
    await new Promise((r) => setTimeout(r, 10))
    expect(rec.peak).toBe(2)
    release()
    await runtime.drainQueue()
    expect(rec.order).toHaveLength(6)
    await runtime.stop()
  })

  it('runs scheduled calls per priority strategy (higher first)', async () => {
    const { rec, start } = await startWith({ concurrency: 1, strategy: priority() })
    const runtime = await start
    const { gate, release } = gatePromise()

    void runtime.scheduleAsSystem('ping:ping', { tag: 'first', gate })
    void runtime.scheduleAsSystem('ping:ping', { tag: 'low' }, { priority: 1 })
    void runtime.scheduleAsSystem('ping:ping', { tag: 'high' }, { priority: 10 })

    release()
    await runtime.drainQueue()
    expect(rec.order[0]).toBe('first')
    expect(rec.order.indexOf('high')).toBeLessThan(rec.order.indexOf('low'))
    await runtime.stop()
  })

  it('serializes scheduled calls sharing a group', async () => {
    const { rec, start } = await startWith({ concurrency: 4 })
    const runtime = await start
    const { gate, release } = gatePromise()
    for (let i = 1; i <= 5; i++) {
      void runtime.scheduleAsSystem('ping:ping', { tag: `g${i}`, gate }, { group: 'shared' })
    }
    await new Promise((r) => setTimeout(r, 10))
    expect(rec.peak).toBe(1)
    release()
    await runtime.drainQueue()
    expect(rec.order).toHaveLength(5)
    await runtime.stop()
  })

  it('rejects a duplicate explicit taskId while the first is still queued', async () => {
    const { start } = await startWith({ concurrency: 1 })
    const runtime = await start
    const { gate, release } = gatePromise()
    void runtime.scheduleAsSystem('ping:ping', { tag: 'one', gate }, { taskId: 'dup' })
    await expect(
      runtime.scheduleAsSystem('ping:ping', { tag: 'two' }, { taskId: 'dup' }),
    ).rejects.toBeInstanceOf(DuplicateTaskError)
    release()
    await runtime.drainQueue()
    await runtime.stop()
  })

  it('propagates capability errors through the scheduled call', async () => {
    const { start } = await startWith({ concurrency: 1 })
    const runtime = await start
    await expect(runtime.scheduleAsSystem('ping:ping', { boom: true })).rejects.toBeInstanceOf(
      IpcInvocationError,
    )
    await runtime.drainQueue()
    await runtime.stop()
  })

  it('surfaces queue info for a runtime-owned scheduler', async () => {
    const { start } = await startWith({ concurrency: 2 })
    const runtime = await start
    void runtime.scheduleAsSystem('ping:ping', { tag: 'x' })
    await runtime.drainQueue()
    const info = runtime.queueInfo()
    expect(info).toBeDefined()
    expect(info?.owned).toBe(true)
    expect(info?.stats.completed).toBe(1)
    await runtime.stop()
  })

  it('stop() settles a gated call and rejects queued work for a runtime-owned scheduler', async () => {
    const { start } = await startWith({ concurrency: 1 })
    const runtime = await start
    const { gate, release } = gatePromise()
    const runningP = runtime.scheduleAsSystem('ping:ping', { tag: 'run', gate })
    const queuedP = runtime.scheduleAsSystem('ping:ping', { tag: 'queued' })
    await new Promise((r) => setTimeout(r, 10))

    const closing = runtime.stop()
    await expect(queuedP).rejects.toBeInstanceOf(TaskCancelledError)
    release()
    await expect(runningP).resolves.toBe('pong:run')
    await closing
    expect(runtime.queueInfo()?.stats.completed).toBe(1)
  })

  it('does not close an injected scheduler on stop() (caller owns it)', async () => {
    const injected = new TaskScheduler()
    const { start } = await startWith(injected)
    const runtime = await start
    expect(runtime.queueInfo()?.owned).toBe(false)
    await runtime.stop()
    // The injected scheduler is still open and usable by its owner.
    await expect(injected.submit({ id: 'after', run: () => 7 })).resolves.toBe(7)
  })
})

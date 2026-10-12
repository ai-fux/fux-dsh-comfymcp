import { describe, expect, it } from 'vitest'
import type { PendingTaskInfo, Task } from '../src/task.js'
import { compose, priority } from '../src/strategy.js'
import {
  DuplicateTaskError,
  QueueError,
  TaskCancelledError,
  TaskTimeoutError,
} from '../src/errors.js'
import { TaskScheduler } from '../src/scheduler.js'

function task(id: string, run?: () => unknown, extra: Partial<Task<unknown>> = {}): Task<unknown> {
  return { id, run: () => (run ? run() : id), ...extra }
}

function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('default FIFO sequential queue (backward-compatible base behavior)', () => {
  it('runs tasks one at a time, in insertion order', async () => {
    const order: string[] = []
    const s = new TaskScheduler()
    const log = (id: string) => task(id, () => order.push(id))

    const a = s.submit(log('a'))
    const b = s.submit(log('b'))
    const c = s.submit(log('c'))
    await Promise.all([a, b, c])

    expect(order).toEqual(['a', 'b', 'c'])
    expect(s.stats).toEqual({ pending: 0, running: 0, completed: 3, failed: 0 })
  })

  it('propagates the task return value', async () => {
    const s = new TaskScheduler<number>()
    const p = s.submit({ id: 'v', run: () => 42 })
    await expect(p).resolves.toBe(42)
  })

  it('rejects with the task error and keeps scheduling the rest', async () => {
    const order: string[] = []
    const s = new TaskScheduler()
    const good = { id: 'good', run: () => void order.push('good') }
    const bad = {
      id: 'bad',
      run: () => {
        throw new Error('boom')
      },
    }
    const pBad = s.submit(bad)
    await expect(pBad).rejects.toThrow('boom')
    const pGood = s.submit(good)
    await expect(pGood).resolves.toBeUndefined()
    expect(order).toEqual(['good'])
    expect(s.stats.failed).toBe(1)
  })
})

describe('concurrency cap', () => {
  it('never exceeds the configured limit', async () => {
    let running = 0
    let peak = 0
    const s = new TaskScheduler({ concurrency: 3 })
    for (let i = 0; i < 10; i++) {
      void s.submit(
        task(`t${i}`, async () => {
          running++
          peak = Math.max(peak, running)
          await new Promise((r) => setTimeout(r, 5))
          running--
        }),
      )
    }
    await s.drain()
    expect(peak).toBeLessThanOrEqual(3)
    expect(peak).toBe(3)

    // concurrency=1 is strictly sequential
    let overlap = 0
    const seq = new TaskScheduler()
    for (let i = 0; i < 5; i++) {
      void seq.submit(
        task(`s${i}`, async () => {
          overlap++
          expect(overlap).toBe(1)
          await new Promise((r) => setTimeout(r, 2))
          overlap--
        }),
      )
    }
    await seq.drain()
  })

  it('rejects an invalid concurrency at construction', () => {
    expect(() => new TaskScheduler({ concurrency: 0 })).toThrow(QueueError)
    expect(() => new TaskScheduler({ concurrency: -1 })).toThrow(QueueError)
    expect(() => new TaskScheduler({ concurrency: 1.5 })).toThrow(QueueError)
  })
})

describe('priority strategy', () => {
  it('runs higher-priority tasks first once all are queued', async () => {
    const order: string[] = []
    const s = new TaskScheduler<unknown>({ strategy: priority() })
    const gate = deferred()
    void s.submit(task('gate', () => gate.promise))
    const pHigh = s.submit(task('high', () => void order.push('high'), { priority: 10 }))
    const pMid = s.submit(task('mid', () => void order.push('mid'), { priority: 5 }))
    const pLow = s.submit(task('low', () => void order.push('low'), { priority: 1 }))
    gate.resolve(undefined)
    await Promise.all([pHigh, pMid, pLow])
    expect(order.indexOf('high')).toBeLessThan(order.indexOf('mid'))
    expect(order.indexOf('mid')).toBeLessThan(order.indexOf('low'))
  })

  it('keeps FIFO order among equal-priority tasks', async () => {
    const order: string[] = []
    const s = new TaskScheduler<unknown>({ strategy: priority() })
    const gate = deferred()
    void s.submit(task('gate', () => gate.promise))
    const a = s.submit(task('a', () => void order.push('a'), { priority: 1 }))
    const b = s.submit(task('b', () => void order.push('b'), { priority: 1 }))
    gate.resolve(undefined)
    await Promise.all([a, b])
    expect(order).toEqual(['a', 'b'])
  })
})

describe('group exclusivity', () => {
  it('never runs two tasks of the same group concurrently', async () => {
    let running = 0
    let peak = 0
    const s = new TaskScheduler({ concurrency: 4 })
    for (let i = 0; i < 8; i++) {
      void s.submit(
        task(
          `g${i}`,
          async () => {
            running++
            peak = Math.max(peak, running)
            await new Promise((r) => setTimeout(r, 5))
            running--
          },
          { group: 'shared' },
        ),
      )
    }
    await s.drain()
    // concurrency is 4 but the shared group serializes them
    expect(peak).toBe(1)
  })

  it('lets tasks of different groups (and no group) run in parallel', async () => {
    let running = 0
    let peak = 0
    const s = new TaskScheduler({ concurrency: 3 })
    for (let i = 0; i < 3; i++) {
      void s.submit(
        task(
          `a${i}`,
          async () => {
            running++
            peak = Math.max(peak, running)
            await new Promise((r) => setTimeout(r, 5))
            running--
          },
          { group: 'a' },
        ),
      )
      void s.submit(
        task(
          `b${i}`,
          async () => {
            running++
            peak = Math.max(peak, running)
            await new Promise((r) => setTimeout(r, 5))
            running--
          },
          { group: 'b' },
        ),
      )
    }
    await s.drain()
    expect(peak).toBeGreaterThanOrEqual(2)
  })
})

describe('custom strategy', () => {
  it('lets a caller control ordering via a custom (LIFO) strategy', async () => {
    const order: string[] = []
    const lifo = (
      pending: ReadonlyArray<PendingTaskInfo<unknown>>,
    ): ReadonlyArray<PendingTaskInfo<unknown>> => [...pending].reverse()
    const s = new TaskScheduler<unknown>({ strategy: lifo })
    const gate = deferred()
    void s.submit(task('gate', () => gate.promise))
    const a = s.submit(task('a', () => void order.push('a')))
    const b = s.submit(task('b', () => void order.push('b')))
    const c = s.submit(task('c', () => void order.push('c')))
    gate.resolve(undefined)
    await Promise.all([a, b, c])
    expect(order).toEqual(['c', 'b', 'a'])
  })

  it('compose applies strategies left to right', () => {
    const pending = [
      { task: task('a', () => undefined, { priority: 1 }), order: 0, queuedAt: 0 },
      { task: task('b', () => undefined, { priority: 2 }), order: 1, queuedAt: 0 },
    ]
    const combined = compose(priority())
    const out = combined(pending)
    expect(out[0]?.task.id).toBe('b')
  })
})

describe('duplicate detection', () => {
  it('rejects an id that is already pending', () => {
    const s = new TaskScheduler()
    void s.submit(task('dup'))
    expect(() => s.submit(task('dup'))).toThrow(DuplicateTaskError)
  })

  it('rejects an id that is already running', async () => {
    const gate = deferred()
    const s = new TaskScheduler()
    void s.submit(task('run', () => gate.promise))
    // allow the first task to start
    await new Promise((r) => setTimeout(r, 0))
    expect(() => s.submit(task('run'))).toThrow(DuplicateTaskError)
    gate.resolve(undefined)
    await s.drain()
  })
})

describe('drain and clear', () => {
  it('drain resolves once the queue is quiescent', async () => {
    const s = new TaskScheduler({ concurrency: 2 })
    for (let i = 0; i < 6; i++) void s.submit(task(`t${i}`))
    await s.drain()
    expect(s.stats.pending).toBe(0)
    expect(s.stats.running).toBe(0)
  })

  it('drain resolves immediately when already idle', async () => {
    const s = new TaskScheduler()
    await expect(s.drain()).resolves.toBeUndefined()
  })

  it('clear drops pending tasks and rejects them', async () => {
    const s = new TaskScheduler({ concurrency: 1 })
    const gate = deferred()
    void s.submit(task('first', () => gate.promise))
    const dropped1 = s.submit(task('p1'))
    const dropped2 = s.submit(task('p2'))
    await new Promise((r) => setTimeout(r, 0))

    const cleared = s.clear()
    expect(cleared).toEqual(expect.arrayContaining(['p1', 'p2']))
    await expect(dropped1).rejects.toBeInstanceOf(TaskCancelledError)
    await expect(dropped2).rejects.toBeInstanceOf(TaskCancelledError)

    gate.resolve(undefined)
    await s.drain()
    expect(s.stats.completed).toBe(1)
  })

  it('running tasks are allowed to finish after clear', async () => {
    const s = new TaskScheduler({ concurrency: 1 })
    const done = deferred<unknown>()
    const runningP = s.submit(task('run', () => done.promise))
    const pendingP = s.submit(task('pending'))
    await new Promise((r) => setTimeout(r, 0))
    s.clear()
    await expect(pendingP).rejects.toBeInstanceOf(TaskCancelledError)
    done.resolve('finished')
    await expect(runningP).resolves.toBe('finished')
    await s.drain()
  })
})

describe('task timeout', () => {
  it('rejects a task that exceeds taskTimeoutMs and releases its slot', async () => {
    const s = new TaskScheduler({ taskTimeoutMs: 20 })
    const gate = deferred()
    const p = s.submit(task('slow', () => gate.promise))
    await expect(p).rejects.toBeInstanceOf(TaskTimeoutError)
    // the slot freed even though the work never resolved
    const ok = s.submit(task('fast', () => 'done'))
    await expect(ok).resolves.toBe('done')
    // settle the still-pending gate so nothing leaks
    gate.resolve(undefined)
    await s.drain()
  })
})

describe('close', () => {
  it('rejects new submits after close', async () => {
    const s = new TaskScheduler()
    void s.submit(task('a'))
    const closing = s.close()
    expect(() => s.submit(task('b'))).toThrow(QueueError)
    await closing
  })

  it('close awaits running work, dropping pending work', async () => {
    const s = new TaskScheduler({ concurrency: 1 })
    const gate = deferred<string>()
    const runningP = s.submit(task('run', () => gate.promise))
    const pendingP = s.submit(task('pending'))
    await new Promise((r) => setTimeout(r, 0))
    const closing = s.close()
    // pending dropped, running still settling
    await expect(pendingP).rejects.toBeInstanceOf(TaskCancelledError)
    gate.resolve('ok')
    await expect(runningP).resolves.toBe('ok')
    await closing
    expect(s.stats.completed).toBe(1)
  })
})

describe('monitoring events', () => {
  it('emits lifecycle events', async () => {
    const s = new TaskScheduler()
    const seen: string[] = []
    s.on((ev) => seen.push(ev.type))
    void s.submit(task('a'))
    await s.drain()
    expect(seen).toContain('started')
    expect(seen).toContain('completed')
    expect(seen).toContain('idle')
  })

  it('unsubscribe stops delivery', async () => {
    const s = new TaskScheduler()
    let count = 0
    const off = s.on(() => count++)
    off()
    void s.submit(task('a'))
    await s.drain()
    expect(count).toBe(0)
  })
})

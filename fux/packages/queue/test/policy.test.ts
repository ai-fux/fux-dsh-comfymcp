import { describe, expect, it } from 'vitest'
import type { Task } from '../src/task.js'
import {
  TaskCancelledError,
  TaskCapacityError,
  TaskInvalidCostError,
  QueueError,
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('capacity watermark (G6, 算力/并发水位)', () => {
  it('never lets the running cost exceed the budget', async () => {
    const s = new TaskScheduler({ concurrency: 8, capacity: 5 })
    let peak = 0
    for (let i = 0; i < 8; i++) {
      void s.submit(
        task(
          `t${i}`,
          async () => {
            peak = Math.max(peak, s.runningCost)
            await sleep(5)
          },
          { cost: 2 },
        ),
      )
    }
    await s.drain()
    expect(peak).toBeLessThanOrEqual(5)
    // capacity 5 / cost 2 admits exactly two concurrently (2+2=4, never 6)
    expect(peak).toBe(4)
  })

  it('a large task waits until the budget frees', async () => {
    const s = new TaskScheduler({ concurrency: 4, capacity: 2 })
    const started: string[] = []
    const gateA = deferred()
    const pA = s.submit(
      task(
        'a',
        () => {
          started.push('a')
          return gateA.promise
        },
        { cost: 2 },
      ),
    )
    const pB = s.submit(task('b', () => void started.push('b'), { cost: 1 }))
    await sleep(5)
    expect(started).toEqual(['a'])
    gateA.resolve(undefined)
    await Promise.all([pA, pB])
    expect(started).toEqual(['a', 'b'])
  })

  it('rejects at submit a task whose cost exceeds the capacity', () => {
    const s = new TaskScheduler({ capacity: 3 })
    expect(() => s.submit(task('big', () => undefined, { cost: 5 }))).toThrow(TaskCapacityError)
  })

  it('rejects invalid capacity at construction', () => {
    expect(() => new TaskScheduler({ capacity: 0 })).toThrow(QueueError)
    expect(() => new TaskScheduler({ capacity: -1 })).toThrow(QueueError)
    expect(() => new TaskScheduler({ capacity: Number.NaN })).toThrow(QueueError)
  })

  it('rejects an invalid (negative / non-finite) cost even without capacity', () => {
    const s = new TaskScheduler()
    expect(() => s.submit(task('neg', () => undefined, { cost: -1 }))).toThrow(TaskInvalidCostError)
    expect(() => s.submit(task('nan', () => undefined, { cost: Number.NaN }))).toThrow(
      TaskInvalidCostError,
    )
  })

  it('zero-cost tasks are unaffected by the watermark', async () => {
    const s = new TaskScheduler({ concurrency: 1, capacity: 1 })
    const order: string[] = []
    for (let i = 0; i < 3; i++) void s.submit(task(`z${i}`, () => void order.push(`z${i}`)))
    await s.drain()
    expect(order).toEqual(['z0', 'z1', 'z2'])
    expect(s.runningCost).toBe(0)
  })
})

describe('automatic retry (G6)', () => {
  it('retries a failing task until it succeeds', async () => {
    let attempts = 0
    const s = new TaskScheduler({ retry: { maxAttempts: 3, delayMs: 0 } })
    const p = s.submit({
      id: 'r',
      run: () => {
        attempts++
        if (attempts < 3) throw new Error('boom')
        return 'ok'
      },
    })
    await expect(p).resolves.toBe('ok')
    expect(attempts).toBe(3)
    expect(s.stats.completed).toBe(1)
    expect(s.stats.failed).toBe(0)
    expect(s.dead).toBe(0)
  })

  it('gives up and dead-letters after exhausting attempts', async () => {
    const dead: unknown[] = []
    const events: string[] = []
    const s = new TaskScheduler({
      retry: { maxAttempts: 2, delayMs: 0 },
      onDeadLetter: (_t, e) => dead.push(e),
    })
    s.on((ev) => events.push(ev.type))
    const p = s.submit({
      id: 'r',
      run: () =>
        void (() => {
          throw new Error('boom')
        })(),
    })
    await expect(p).rejects.toThrow('boom')
    expect(s.stats.failed).toBe(1)
    expect(s.stats.completed).toBe(0)
    expect(s.dead).toBe(1)
    expect(dead).toHaveLength(1)
    expect(events).toContain('deadlettered')
    expect(s.runningCost).toBe(0)
  })

  it('respects the retryWhen gate', async () => {
    let attempts = 0
    const s = new TaskScheduler({
      retry: { maxAttempts: 3, delayMs: 0, retryWhen: (e) => (e as Error).message !== 'fatal' },
    })
    const p = s.submit({
      id: 'r',
      run: () => {
        attempts++
        throw new Error('fatal')
      },
    })
    await expect(p).rejects.toThrow('fatal')
    expect(attempts).toBe(1)
    expect(s.dead).toBe(1)
  })
})

describe('dead-letter / default boundaries (G6)', () => {
  it('without retry, a failure is immediate and not a dead letter', async () => {
    const s = new TaskScheduler()
    const p = s.submit({
      id: 'r',
      run: () => {
        throw new Error('boom')
      },
    })
    await expect(p).rejects.toThrow('boom')
    expect(s.stats).toEqual({ pending: 0, running: 0, completed: 0, failed: 1 })
    expect(s.dead).toBe(0)
  })

  it('clear() cancels a task waiting between retries (not a dead letter)', async () => {
    let attempts = 0
    const s = new TaskScheduler({ retry: { maxAttempts: 3, delayMs: 50 } })
    const p = s.submit({
      id: 'r',
      run: () => {
        attempts++
        throw new Error('boom')
      },
    })
    await sleep(5) // first attempt failed; task is now in the retry window
    s.clear()
    await expect(p).rejects.toBeInstanceOf(TaskCancelledError)
    expect(s.dead).toBe(0)
    expect(attempts).toBe(1)
  })
})

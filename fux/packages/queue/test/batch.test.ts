import { describe, expect, it } from 'vitest'
import { TaskScheduler } from '../src/scheduler.js'
import type { Task } from '../src/task.js'
import { submitBatch, collectBatch } from '../src/batch.js'

function task(id: string, run: () => unknown, extra: Partial<Task<unknown>> = {}): Task<unknown> {
  return { id, run, ...extra }
}

describe('submitBatch (G-09 tolerant batch submission)', () => {
  it('accepts every task and collects settled values in submission order', async () => {
    const scheduler = new TaskScheduler<unknown>({ concurrency: 2 })
    const submission = submitBatch(scheduler, [
      task('a', () => 1),
      task('b', () => 2),
      task('c', () => 3),
    ])
    expect(submission.rejected).toEqual([])
    expect(submission.entries.map((e) => e.id)).toEqual(['a', 'b', 'c'])

    const outcomes = await collectBatch(submission)
    expect(outcomes).toEqual([
      { id: 'a', ok: true, value: 1 },
      { id: 'b', ok: true, value: 2 },
      { id: 'c', ok: true, value: 3 },
    ])
  })

  it('isolates synchronous rejections (duplicate id) from the rest of the batch', async () => {
    const scheduler = new TaskScheduler<unknown>()
    const first = scheduler.submit(task('dup', () => 'first'))
    const submission = submitBatch(scheduler, [
      task('dup', () => 'second'),
      task('ok', () => 'fine'),
    ])
    await expect(first).resolves.toBe('first')
    expect(submission.entries.map((e) => e.id)).toEqual(['ok'])
    expect(submission.rejected).toHaveLength(1)
    expect(submission.rejected[0]?.id).toBe('dup')
    expect((submission.rejected[0]?.error as { code?: string }).code).toBe('E_DUPLICATE_TASK')

    const outcomes = await collectBatch(submission)
    expect(outcomes).toEqual([{ id: 'ok', ok: true, value: 'fine' }])
  })

  it('never rejects: task failures surface as ok:false outcomes', async () => {
    const scheduler = new TaskScheduler<unknown>()
    const submission = submitBatch(scheduler, [
      task('bad', () => {
        throw new Error('boom')
      }),
      task('good', () => 'v'),
    ])
    const outcomes = await collectBatch(submission)
    expect(outcomes).toHaveLength(2)
    expect(outcomes[0]).toMatchObject({ id: 'bad', ok: false })
    expect((outcomes[0] as { error?: Error }).error).toBeInstanceOf(Error)
    expect(outcomes[1]).toEqual({ id: 'good', ok: true, value: 'v' })
  })

  it('handles the empty batch as a no-op', async () => {
    const scheduler = new TaskScheduler<unknown>()
    const submission = submitBatch(scheduler, [])
    expect(submission.entries).toEqual([])
    expect(submission.rejected).toEqual([])
    await expect(collectBatch(submission)).resolves.toEqual([])
    expect(scheduler.stats).toEqual({ pending: 0, running: 0, completed: 0, failed: 0 })
  })
})

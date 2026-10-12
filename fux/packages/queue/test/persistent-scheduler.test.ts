import { describe, expect, it, vi } from 'vitest'
import { TaskScheduler } from '../src/scheduler.js'
import { DuplicateTaskError, QueueError } from '../src/errors.js'
import type { Task, TaskRecord } from '../src/index.js'
import { PersistentTaskScheduler } from '../src/persistence.js'
import { MemoryBackendLike } from './helpers/memory-backend.js'

function task(id: string, run: () => unknown, extra: Partial<Task<unknown>> = {}): Task<unknown> {
  return { id, run, ...extra }
}

/** Rebuild a runnable task from persisted metadata (stand-in for broker.call). */
function rehydrate(record: TaskRecord): Task<unknown> {
  return { id: record.id, run: () => `ran:${record.id}`, meta: record.meta }
}

async function journalTasks(backend: MemoryBackendLike, key = 'fux/queue/journal'): Promise<TaskRecord[]> {
  const head = await backend.get(key)
  return head ? [...head.value.tasks] : []
}

async function waitForJournal(
  backend: MemoryBackendLike,
  predicate: (tasks: TaskRecord[]) => boolean,
): Promise<TaskRecord[]> {
  return vi.waitFor(async () => {
    const tasks = await journalTasks(backend)
    if (!predicate(tasks)) throw new Error('journal condition not met yet')
    return tasks
  })
}

function deferred<T = unknown>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('PersistentTaskScheduler (G-02 journal-first durability)', () => {
  it('persists records before tasks run and cleans them up on terminal events', async () => {
    const backend = new MemoryBackendLike()
    const inner = new TaskScheduler<unknown>({ concurrency: 1 })
    const persistent = new PersistentTaskScheduler({ scheduler: inner, journal: backend, rehydrate })

    const gate = deferred()
    const blocker = persistent.submit(task('blocker', () => gate.promise))
    void blocker.catch(() => {})
    // journal-first: the record exists as soon as the submit lands
    await waitForJournal(backend, (tasks) => tasks.length === 1)
    const started = await waitForJournal(backend, (tasks) =>
      tasks.some((t) => t.id === 'blocker' && t.state === 'running'),
    )
    expect(started.find((t) => t.id === 'blocker')?.attempts).toBe(1)

    gate.resolve('done')
    await expect(blocker).resolves.toBe('done')
    await waitForJournal(backend, (tasks) => tasks.length === 0)
  })

  it('survives a restart: pending and running records are recovered through rehydrate', async () => {
    const backend = new MemoryBackendLike()
    // "crashed" session: concurrency 1, one blocker running, one task queued
    const crashed = new PersistentTaskScheduler({
      scheduler: new TaskScheduler<unknown>({ concurrency: 1 }),
      journal: backend,
      rehydrate,
    })
    const gate = deferred()
    void crashed.submit(task('blocker', () => gate.promise)).catch(() => {})
    void crashed.submit(task('queued', () => 'queued-result')).catch(() => {})
    await waitForJournal(backend, (tasks) => tasks.length === 2)

    const startedIds: string[] = []
    const recovered = new PersistentTaskScheduler({
      scheduler: new TaskScheduler<unknown>({ concurrency: 1 }),
      journal: backend,
      rehydrate,
    })
    recovered.on((event) => {
      if (event.type === 'started' && event.taskId) startedIds.push(event.taskId)
    })
    const report = await recovered.recover()
    expect(report.recovered).toEqual(['blocker', 'queued'])
    expect(report.dropped).toEqual([])
    expect(report.skipped).toEqual([])

    await recovered.drain()
    expect(startedIds).toEqual(['blocker', 'queued'])
    await waitForJournal(backend, (tasks) => tasks.length === 0)
  })

  it('honors recoverRunning: "drop" discards mid-flight records', async () => {
    const backend = new MemoryBackendLike()
    const crashed = new PersistentTaskScheduler({
      scheduler: new TaskScheduler<unknown>({ concurrency: 1 }),
      journal: backend,
      rehydrate,
    })
    const gate = deferred()
    void crashed.submit(task('blocker', () => gate.promise)).catch(() => {})
    void crashed.submit(task('queued', () => 'x')).catch(() => {})
    await waitForJournal(backend, (tasks) => tasks.length === 2)

    const recovered = new PersistentTaskScheduler({
      scheduler: new TaskScheduler<unknown>({ concurrency: 1 }),
      journal: backend,
      rehydrate,
      recoverRunning: 'drop',
    })
    const report = await recovered.recover()
    expect(report.dropped).toEqual(['blocker'])
    expect(report.recovered).toEqual(['queued'])
    await recovered.drain()
  })

  it('rejects the submit and compensates the journal when the scheduler refuses the task', async () => {
    const backend = new MemoryBackendLike()
    const inner = new TaskScheduler<unknown>({ concurrency: 1 })
    const persistent = new PersistentTaskScheduler({ scheduler: inner, journal: backend, rehydrate })

    // a live running task owns id "a": a duplicate submit is refused and the
    // compensation restores the live task's record
    const gate = deferred()
    const first = persistent.submit(task('a', () => gate.promise))
    void first.catch(() => {})
    await waitForJournal(backend, (tasks) => tasks.length === 1 && tasks[0]?.state === 'running')

    await expect(persistent.submit(task('a', () => 'v'))).rejects.toBeInstanceOf(DuplicateTaskError)
    await waitForJournal(backend, (tasks) => tasks.length === 1 && tasks[0]?.state === 'running')
    expect(inner.stats.completed).toBe(0)

    gate.resolve('v')
    await expect(first).resolves.toBe('v')
    await waitForJournal(backend, (tasks) => tasks.length === 0)
    expect(inner.stats.completed).toBe(1)

    const closed = new PersistentTaskScheduler({
      scheduler: new TaskScheduler<unknown>(),
      journal: backend,
      rehydrate,
    })
    await closed.close()
    await expect(closed.submit(task('b', () => 'v'))).rejects.toBeInstanceOf(QueueError)
    await waitForJournal(backend, (tasks) => tasks.length === 0)
  })

  it('fails the submit without running the task when the journal write fails', async () => {
    const backend = new MemoryBackendLike({ failPut: true })
    const inner = new TaskScheduler<unknown>()
    const persistent = new PersistentTaskScheduler({ scheduler: inner, journal: backend, rehydrate })

    await expect(persistent.submit(task('a', () => 'v'))).rejects.toThrow('journal put failed')
    expect(inner.stats.completed).toBe(0)
    expect(inner.stats.pending).toBe(0)
  })

  it('routes event-driven journal failures to onJournalError instead of breaking scheduling', async () => {
    const failures: string[] = []
    const backend = new MemoryBackendLike({ failDelete: true })
    const inner = new TaskScheduler<unknown>()
    const persistent = new PersistentTaskScheduler({
      scheduler: inner,
      journal: backend,
      rehydrate,
      onJournalError: (_error, op) => {
        failures.push(op)
      },
    })

    await expect(persistent.submit(task('x', () => 'v'))).resolves.toBe('v')
    await vi.waitFor(() => expect(failures).toEqual(['delete']))
    expect(inner.stats.completed).toBe(1)
  })

  it('skips records whose rehydrate throws and drops them from the journal', async () => {
    const backend = new MemoryBackendLike()
    const seed = new PersistentTaskScheduler({
      scheduler: new TaskScheduler<unknown>({ concurrency: 1 }),
      journal: backend,
      rehydrate,
    })
    const gate = deferred()
    void seed.submit(task('live', () => gate.promise)).catch(() => {})
    void seed.submit({ id: 'broken', run: () => 'never', meta: { poisoned: true } }).catch(() => {})
    await waitForJournal(backend, (tasks) => tasks.length === 2)

    const recovered = new PersistentTaskScheduler({
      scheduler: new TaskScheduler<unknown>({ concurrency: 1 }),
      journal: backend,
      rehydrate: (record) => {
        if ((record.meta as { poisoned?: boolean } | undefined)?.poisoned) {
          throw new Error('cannot rebuild')
        }
        return rehydrate(record)
      },
    })
    const report = await recovered.recover()
    expect(report.recovered).toEqual(['live'])
    expect(report.skipped).toEqual(['broken'])
    gate.resolve('x')
    await recovered.drain()
    await waitForJournal(backend, (tasks) => tasks.length === 0)
  })

  it('keeps records whose re-submit hits a duplicate id (task already live)', async () => {
    const backend = new MemoryBackendLike()
    const inner = new TaskScheduler<unknown>({ concurrency: 1 })
    const persistent = new PersistentTaskScheduler({ scheduler: inner, journal: backend, rehydrate })

    const gate = deferred()
    void persistent.submit(task('blocker', () => gate.promise)).catch(() => {})
    void persistent.submit(task('dup', () => 'x')).catch(() => {})
    await waitForJournal(backend, (tasks) => tasks.length === 2)

    // re-covering while both tasks are live in the inner scheduler: the ids
    // collide, so recovery skips them but KEEPS the records for the live
    // tasks' terminal events to clean up.
    const report = await persistent.recover()
    expect(report.recovered).toEqual([])
    expect(report.skipped).toEqual(['blocker', 'dup'])
    expect(backend.syncHas('fux/queue/journal')).toBe(true)

    gate.resolve('x')
    await persistent.drain()
    await waitForJournal(backend, (tasks) => tasks.length === 0)
  })

  it('removes retried task records only at the terminal attempt', async () => {
    const backend = new MemoryBackendLike()
    let attempts = 0
    const inner = new TaskScheduler<unknown>({ retry: { maxAttempts: 2, delayMs: 1 } })
    const persistent = new PersistentTaskScheduler({ scheduler: inner, journal: backend, rehydrate })

    const failing = persistent.submit(
      task('flaky', () => {
        attempts++
        throw new Error(`boom ${attempts}`)
      }),
    )
    await expect(failing).rejects.toThrow('boom 2')
    expect(attempts).toBe(2)
    await waitForJournal(backend, (tasks) => tasks.length === 0)
    expect(inner.dead).toBe(1)
  })

  it('works over an async VersionedBackend-shaped journal (structural compat)', async () => {
    const backend = new MemoryBackendLike({ async: true })
    const inner = new TaskScheduler<unknown>()
    const persistent = new PersistentTaskScheduler({ scheduler: inner, journal: backend, rehydrate })

    await expect(persistent.submit(task('async-1', () => 7))).resolves.toBe(7)
    await waitForJournal(backend, (tasks) => tasks.length === 0)

    const gate = deferred()
    const held = new PersistentTaskScheduler({
      scheduler: new TaskScheduler<unknown>({ concurrency: 1 }),
      journal: backend,
      rehydrate,
    })
    void held.submit(task('held', () => gate.promise)).catch(() => {})
    await waitForJournal(backend, (tasks) => tasks.length === 1)

    const next = new PersistentTaskScheduler({
      scheduler: new TaskScheduler<unknown>(),
      journal: backend,
      rehydrate,
    })
    const report = await next.recover()
    expect(report.recovered).toEqual(['held'])
    gate.resolve('x')
    await next.drain()
    await waitForJournal(backend, (tasks) => tasks.length === 0)
  })

  it('clear() and close() empty the journal through cancelled/completed events', async () => {
    const backend = new MemoryBackendLike()
    const inner = new TaskScheduler<unknown>({ concurrency: 1 })
    const persistent = new PersistentTaskScheduler({ scheduler: inner, journal: backend, rehydrate })

    const gate = deferred()
    void persistent.submit(task('running', () => gate.promise)).catch(() => {})
    void persistent.submit(task('pending', () => 'v')).catch(() => {})
    await waitForJournal(backend, (tasks) => tasks.length === 2)

    expect(persistent.clear()).toEqual(['pending'])
    await waitForJournal(backend, (tasks) => tasks.length === 1)
    gate.resolve('x')
    await persistent.close()
    await waitForJournal(backend, (tasks) => tasks.length === 0)
  })
})

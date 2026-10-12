import type { Task } from './task.js'
import { DuplicateTaskError } from './errors.js'
import type { SchedulerEvent, SchedulerStats } from './scheduler.js'
import type { TaskScheduler } from './scheduler.js'

/**
 * G-02: a durable, opt-in wrapper around a `TaskScheduler`. Submit-time task
 * records are appended to a versioned journal *before* the task can run, and
 * the journal is maintained from the inner scheduler's lifecycle events, so a
 * process restart can recover work that never reached a terminal state.
 *
 * The journal seam is a minimal structural interface: any
 * `VersionedBackend<TaskJournalDoc>` (memory, file, or a product backend)
 * satisfies it without adding a package dependency on `@fux/storage`. Each
 * mutation appends one immutable version under a single journal key, so the
 * backend's version history doubles as an audit log.
 *
 * `Task.run()` is a function and is never serialized — persistence covers task
 * *metadata* only. Recovery rebuilds runnable tasks through the caller-supplied
 * `rehydrate` callback (e.g. `() => broker.call(record.meta...)`); the caller
 * owns idempotency of the rebuilt work.
 */

/** The persisted, serializable view of a task (never carries `run`). */
export interface TaskRecord {
  readonly id: string
  readonly state: 'pending' | 'running'
  readonly priority?: number
  readonly group?: string
  readonly cost?: number
  /** Opaque serializable metadata; recovery rebuilds `run` from it. */
  readonly meta?: unknown
  readonly queuedAt: number
  /** Attempt index observed from the most recent `started` event (1-based). */
  readonly attempts?: number
}

/** The whole journal document: every non-terminal task, one version per mutation. */
export interface TaskJournalDoc {
  readonly tasks: readonly TaskRecord[]
}

/**
 * Minimal journal contract. Structurally satisfied by any
 * `VersionedBackend<TaskJournalDoc>` (its `Version<T>` wraps `.value`), so
 * `@fux/storage` backends plug in directly.
 */
export interface TaskJournalLike {
  put(key: string, value: TaskJournalDoc): unknown
  get(key: string): { value: TaskJournalDoc } | undefined | Promise<{ value: TaskJournalDoc } | undefined>
  delete(key: string): unknown
}

/** Policy for records that were mid-flight (`running`) when the process died. */
export type RecoverRunningPolicy = 'resubmit' | 'drop'

export interface PersistentSchedulerOptions<T = unknown> {
  /** The wrapped scheduler that actually executes tasks. */
  readonly scheduler: TaskScheduler<T>
  /** Versioned journal backend (any `VersionedBackend<TaskJournalDoc>`). */
  readonly journal: TaskJournalLike
  /** Journal key. Defaults to `'fux/queue/journal'`. */
  readonly key?: string
  /** Rebuild a runnable task from its persisted record. Called on recovery. */
  readonly rehydrate: (record: TaskRecord) => Task<T>
  /** Crash policy for `running` records. Default `'resubmit'`. */
  readonly recoverRunning?: RecoverRunningPolicy
  /**
   * Journal write failures raised by event-driven maintenance (started /
   * completed / failed / cancelled bookkeeping). Submit-path failures always
   * propagate to the submitter regardless of this hook.
   */
  readonly onJournalError?: (error: unknown, op: 'put' | 'delete') => void
}

export interface RecoveryReport {
  /** Records re-enqueued into the inner scheduler. */
  readonly recovered: readonly string[]
  /** `running` records discarded under the `drop` policy. */
  readonly dropped: readonly string[]
  /** Records that could not be re-enqueued (rehydrate threw, or duplicate id). */
  readonly skipped: readonly string[]
}

const DEFAULT_JOURNAL_KEY = 'fux/queue/journal'

export class PersistentTaskScheduler<T = unknown> {
  private readonly _inner: TaskScheduler<T>
  private readonly _journal: TaskJournalLike
  private readonly _key: string
  private readonly _rehydrate: (record: TaskRecord) => Task<T>
  private readonly _recoverRunning: RecoverRunningPolicy
  private readonly _onJournalError?: (error: unknown, op: 'put' | 'delete') => void

  private readonly _records = new Map<string, TaskRecord>()
  private readonly _loaded: Promise<void>
  /** Serializes journal mutations (read-modify-write on a single key). */
  private _chain: Promise<void> = Promise.resolve()

  constructor(options: PersistentSchedulerOptions<T>) {
    this._inner = options.scheduler
    this._journal = options.journal
    this._key = options.key ?? DEFAULT_JOURNAL_KEY
    this._rehydrate = options.rehydrate
    this._recoverRunning = options.recoverRunning ?? 'resubmit'
    this._onJournalError = options.onJournalError

    this._loaded = this._hydrate()

    // Journal maintenance mirrors the inner scheduler's lifecycle. Listener
    // exceptions are already isolated by the inner scheduler; the async
    // journal work carries its own error routing.
    this._inner.on((event: SchedulerEvent) => {
      const taskId = event.taskId
      if (!taskId) return
      if (event.type === 'started') {
        void this._mutate(
          (records) => {
            const current = records.get(taskId)
            if (!current) return
            records.set(taskId, { ...current, state: 'running', attempts: event.attempts })
          },
          'put',
          false,
        )
      } else if (event.type === 'completed' || event.type === 'failed' || event.type === 'cancelled') {
        // `deadlettered` is informational — the terminal `failed` already removed it.
        void this._mutate((records) => void records.delete(taskId), 'delete', false)
      }
    })
  }

  get closed(): boolean {
    return this._inner.closed
  }

  get stats(): SchedulerStats {
    return this._inner.stats
  }

  /** Observe the inner scheduler's events (passthrough). */
  on(listener: (event: SchedulerEvent) => void): () => void {
    return this._inner.on(listener)
  }

  /**
   * Journal-first submit: the pending record is durable *before* the task can
   * start. If the inner scheduler rejects the submit synchronously (duplicate,
   * capacity, closed) the record is compensatingly removed. A crash inside the
   * window between the journal write and the inner submit leaves a phantom
   * pending record that recovery re-dispatches — idempotency of the rebuilt
   * work is the `rehydrate` owner's responsibility.
   */
  async submit(task: Task<T>): Promise<T> {
    // A previous record for the same id belongs to a task that is still live
    // in the inner scheduler (duplicate submit) — compensation must restore it.
    const previous = this._records.get(task.id)
    const record: TaskRecord = {
      id: task.id,
      state: 'pending',
      ...(task.priority !== undefined ? { priority: task.priority } : {}),
      ...(task.group !== undefined ? { group: task.group } : {}),
      ...(task.cost !== undefined ? { cost: task.cost } : {}),
      ...(task.meta !== undefined ? { meta: task.meta } : {}),
      queuedAt: Date.now(),
    }
    await this._mutate((records) => void records.set(task.id, record), 'put', true)
    try {
      return await this._inner.submit(task)
    } catch (error) {
      await this._mutate(
        (records) => {
          if (previous) records.set(task.id, previous)
          else records.delete(task.id)
        },
        previous ? 'put' : 'delete',
        false,
      ).catch(() => {})
      throw error
    }
  }

  /** Resolve when the inner scheduler is quiescent (passthrough). */
  drain(): Promise<void> {
    return this._inner.drain()
  }

  /** Drop every not-yet-started task (records are cleaned via cancelled events). */
  clear(): ReadonlyArray<string> {
    return this._inner.clear()
  }

  /** Persistently stop the inner scheduler; terminal events empty the journal. */
  close(): Promise<void> {
    return this._inner.close()
  }

  /**
   * Re-enqueue journaled tasks that never reached a terminal state. Explicit
   * (call once at startup, before submitting new work); re-submitted tasks are
   * fire-and-forget — observe them through `on()` / `stats`.
   */
  async recover(): Promise<RecoveryReport> {
    await this._loaded
    const recovered: string[] = []
    const dropped: string[] = []
    const skipped: string[] = []
    const keep = new Map(this._records)
    let changed = false

    for (const record of [...this._records.values()]) {
      if (record.state === 'running' && this._recoverRunning === 'drop') {
        keep.delete(record.id)
        dropped.push(record.id)
        changed = true
        continue
      }
      let task: Task<T>
      try {
        task = this._rehydrate(record)
      } catch {
        keep.delete(record.id)
        skipped.push(record.id)
        changed = true
        continue
      }
      try {
        const running = this._inner.submit(task)
        // Detached: the original submitter is gone after a restart. Failures
        // surface through the scheduler's events, and the journal record is
        // removed by the terminal-event bookkeeping.
        void running.catch(() => {})
        recovered.push(record.id)
      } catch (error) {
        skipped.push(record.id)
        if (!(error instanceof DuplicateTaskError)) {
          // A duplicate id means the task is already live in the inner
          // scheduler — keep its record so terminal events clean it up.
          keep.delete(record.id)
          changed = true
        }
      }
    }

    if (changed) {
      await this._writeSnapshot(keep)
      this._records.clear()
      for (const [id, record] of keep) this._records.set(id, record)
    }
    return { recovered, dropped, skipped }
  }

  /*
   * ---------- internals ----------
   */

  private async _hydrate(): Promise<void> {
    try {
      const head = await this._journal.get(this._key)
      for (const record of head?.value.tasks ?? []) this._records.set(record.id, record)
    } catch {
      // An unreadable journal must never prevent scheduling; recovery treats
      // the (empty) mirror as the source of truth for this session.
    }
  }

  private _mutate(
    mutate: (records: Map<string, TaskRecord>) => void,
    op: 'put' | 'delete',
    propagate: boolean,
  ): Promise<void> {
    const run = async (): Promise<void> => {
      await this._loaded
      mutate(this._records)
      await this._writeSnapshot(this._records)
    }
    const next = this._chain.then(run, run)
    this._chain = next.then(
      () => undefined,
      () => undefined,
    )
    if (propagate) return next
    return next.catch((error) => {
      this._onJournalError?.(error, op)
    })
  }

  private async _writeSnapshot(records: Map<string, TaskRecord>): Promise<void> {
    if (records.size === 0) {
      await this._journal.delete(this._key)
      return
    }
    await this._journal.put(this._key, { tasks: [...records.values()] })
  }
}

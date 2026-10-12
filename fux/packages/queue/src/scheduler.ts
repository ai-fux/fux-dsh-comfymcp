import type { PendingTaskInfo, Task } from './task.js'
import { fifo, type SchedulingStrategy } from './strategy.js'
import {
  DuplicateTaskError,
  QueueError,
  TaskCancelledError,
  TaskCapacityError,
  TaskInvalidCostError,
  TaskTimeoutError,
} from './errors.js'

/**
 * G6: retry + dead-letter policy for a failing task. Absent (default), a task
 * failure is terminal on its first attempt — exactly the pre-G6 behavior.
 */
export interface RetryPolicy {
  /** Total executions of `run()` before giving up (default 1 = no retry). */
  maxAttempts?: number
  /** Fixed delay between attempts in ms (default 0). */
  delayMs?: number
  /** Gate: return false to stop retrying for this failure (default: retry any). */
  retryWhen?: (error: unknown, attempt: number) => boolean
}

/** Options accepted by `new TaskScheduler()`. */
export interface TaskSchedulerOptions<T = unknown> {
  /** Maximum number of tasks executing at once (default 1). */
  readonly concurrency?: number
  /** Scheduling policy; defaults to FIFO (stable insertion order). */
  readonly strategy?: SchedulingStrategy<T>
  /** Optional per-task timeout in ms; a task exceeding it is rejected. */
  readonly taskTimeoutMs?: number
  /**
   * G6: optional resource watermark. The sum of running tasks' `cost` never
   * exceeds this budget. A task whose `cost` exceeds it is rejected at submit.
   * Absent (default) disables water-marking entirely — costs are ignored.
   */
  readonly capacity?: number
  /** G6: optional automatic retry + dead-letter policy (see `RetryPolicy`). */
  readonly retry?: RetryPolicy
  /** G6: invoked when a task gives up after retries (a dead letter). */
  readonly onDeadLetter?: (task: Task<T>, error: unknown) => void
}

/** Immutable counters describing the scheduler at a point in time. */
export interface SchedulerStats {
  readonly pending: number
  readonly running: number
  readonly completed: number
  readonly failed: number
}

/** Lifecycle events emitted for observability (pure information; no control). */
export interface SchedulerEvent {
  readonly type: 'started' | 'completed' | 'failed' | 'cancelled' | 'idle' | 'deadlettered'
  readonly taskId?: string
  readonly error?: unknown
  /** Attempt index (1-based) for `started` / `failed` under a retry policy. */
  readonly attempts?: number
}

type Listener = (event: SchedulerEvent) => void

const DEFAULT_CONCURRENCY = 1

/**
 * CR-03: a pluggable concurrency / priority scheduling framework. It enforces a
 * hard concurrency cap, group exclusivity (tasks in the same non-empty group
 * never run at once) and an optional per-task timeout, on top of whatever
 * ordering the configured `SchedulingStrategy` produces. With no strategy
 * configured and `concurrency = 1` the behavior is a plain bounded sequential
 * queue — the default keeps old semantics.
 */
export class TaskScheduler<T = unknown> {
  private readonly _concurrency: number
  private readonly _strategy: SchedulingStrategy<T>
  private readonly _taskTimeoutMs: number
  private readonly _capacity?: number
  private readonly _retry?: RetryPolicy
  private readonly _onDeadLetter?: (task: Task<T>, error: unknown) => void
  private readonly _listeners = new Set<Listener>()

  private _pending: Array<PendingTaskInfo<T>> = []
  private readonly _pendingById = new Map<string, PendingTaskInfo<T>>()
  private readonly _runningIds = new Set<string>()
  private readonly _runningGroups = new Map<string, number>()
  private readonly _retryTimers = new Set<ReturnType<typeof setTimeout>>()
  private readonly _retryingIds = new Set<string>()
  private readonly _handles = new Map<
    string,
    { resolve: (value: T) => void; reject: (reason: unknown) => void }
  >()
  private _drainWaiters: Array<() => void> = []

  private _order = 0
  private _running = 0
  private _runningCost = 0
  private _completed = 0
  private _failed = 0
  private _dead = 0
  private _closed = false
  private _closedPromise: Promise<void> | null = null

  constructor(options: TaskSchedulerOptions<T> = {}) {
    const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new QueueError(
        'E_INVALID_CONCURRENCY',
        `concurrency must be a positive integer, got ${String(options.concurrency)}`,
      )
    }
    this._concurrency = concurrency
    this._strategy = options.strategy ?? fifo<T>()
    this._taskTimeoutMs = options.taskTimeoutMs ?? 0
    if (options.capacity !== undefined) {
      if (!Number.isFinite(options.capacity) || options.capacity <= 0) {
        throw new QueueError(
          'E_INVALID_CAPACITY',
          `capacity must be a positive finite number, got ${String(options.capacity)}`,
        )
      }
      this._capacity = options.capacity
    }
    if (options.retry) {
      const maxAttempts = options.retry.maxAttempts ?? 1
      if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
        throw new QueueError(
          'E_INVALID_RETRY',
          `retry.maxAttempts must be a positive integer, got ${String(maxAttempts)}`,
        )
      }
      this._retry = {
        maxAttempts,
        delayMs: options.retry.delayMs ?? 0,
        retryWhen: options.retry.retryWhen,
      }
    }
    this._onDeadLetter = options.onDeadLetter
  }

  get pending(): number {
    return this._pending.length
  }

  get running(): number {
    return this._running
  }

  get closed(): boolean {
    return this._closed
  }

  get stats(): SchedulerStats {
    return {
      pending: this._pending.length,
      running: this._running,
      completed: this._completed,
      failed: this._failed,
    }
  }

  /** G6: configured resource budget (undefined when capacity is disabled). */
  get capacity(): number | undefined {
    return this._capacity
  }

  /** G6: sum of `cost` across currently running tasks (0 when capacity is off). */
  get runningCost(): number {
    return this._runningCost
  }

  /** G6: number of tasks that gave up after retries (dead letters). */
  get dead(): number {
    return this._dead
  }

  /** Minimal state channel for monitoring. Returns an unsubscribe function. */
  on(listener: Listener): () => void {
    this._listeners.add(listener)
    return () => {
      this._listeners.delete(listener)
    }
  }

  /**
   * Enqueue a task. Idempotency guard: an id that is currently pending or
   * running is rejected. The returned promise settles with the task's result
   * (or rejection) once it has actually completed.
   */
  submit(task: Task<T>): Promise<T> {
    if (this._closed) {
      throw new QueueError('E_CLOSED', 'scheduler is closed')
    }
    if (this._pendingById.has(task.id) || this._runningIds.has(task.id)) {
      throw new DuplicateTaskError(task.id)
    }
    const cost = this._readCost(task)
    if (this._capacity !== undefined && cost > this._capacity) {
      throw new TaskCapacityError(task.id, cost, this._capacity)
    }
    return new Promise<T>((resolve, reject) => {
      const info: PendingTaskInfo<T> = {
        task,
        order: this._order++,
        queuedAt: Date.now(),
      }
      this._pendingById.set(task.id, info)
      this._pending.push(info)
      this._handles.set(task.id, { resolve, reject })
      this.pump()
    })
  }

  /**
   * Resolve once the scheduler is quiescent: nothing pending and nothing
   * running at the time the signal is observed. Tasks submitted afterwards
   * form a new (later) quiescent window.
   */
  drain(): Promise<void> {
    if (this._pending.length === 0 && this._running === 0 && this._retryingIds.size === 0) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this._drainWaiters.push(resolve)
    })
  }

  /**
   * Drop every not-yet-started task (running work is allowed to finish). The
   * affected submit promises reject with `TaskCancelledError`. Returns the ids
   * of the discarded tasks.
   */
  clear(): ReadonlyArray<string> {
    const ids: string[] = []
    for (const [id, info] of this._pendingById) {
      void info
      ids.push(id)
      this._finishPending(void 0, id)
    }
    this._pendingById.clear()
    this._pending = []
    this._cancelRetries()
    this._notifyIdle()
    return ids
  }

  /** Persistently stop: reject new submits, drop pending work, wait for running work to settle. */
  close(): Promise<void> {
    if (this._closed) return this._closedPromise ?? Promise.resolve()
    this._closed = true
    this.clear()
    this._closedPromise = this.drain()
    return this._closedPromise
  }

  /*
   * ---------- internals ----------
   */

  private pump(): void {
    if (this._closed) return
    // Keep filling slots up to the concurrency cap — plus the capacity watermark
    // when configured — always walking the (possibly reordered) strategy output
    // and skipping tasks whose group is busy or whose cost would overflow budget.
    while (this._running < this._concurrency && this._pending.length > 0) {
      const ordered = this._strategy(this._pending)
      let chosen: PendingTaskInfo<T> | undefined
      for (const info of ordered) {
        if (this._isFreeGroup(info.task.group) && this._fitsCapacity(info.task)) {
          chosen = info
          break
        }
      }
      if (!chosen) break
      this._start(chosen)
    }
  }

  private _isFreeGroup(group: string | undefined): boolean {
    if (!group) return true
    return (this._runningGroups.get(group) ?? 0) === 0
  }

  private _fitsCapacity(task: Task<T>): boolean {
    if (this._capacity === undefined) return true
    return this._runningCost + this._taskCost(task) <= this._capacity
  }

  private _readCost(task: Task<T>): number {
    const cost = task.cost ?? 0
    if (!Number.isFinite(cost) || cost < 0) throw new TaskInvalidCostError(task.id, cost)
    return cost
  }

  private _taskCost(task: Task<T>): number {
    return task.cost ?? 0
  }

  private _start(info: PendingTaskInfo<T>, attempt = 0): void {
    const { id, group, run } = info.task
    const idx = this._pending.indexOf(info)
    if (idx >= 0) this._pending.splice(idx, 1)
    this._pendingById.delete(id)
    this._runningIds.add(id)
    if (group) this._runningGroups.set(group, (this._runningGroups.get(group) ?? 0) + 1)
    this._running++
    this._runningCost += this._taskCost(info.task)
    this._emit({ type: 'started', taskId: id, attempts: attempt + 1 })

    const runP = Promise.resolve().then(run)
    const settled = this._withTimeout(id, runP)
    settled.then(
      (value) => this._settle(info, true, value, attempt),
      (error) => this._settle(info, false, error, attempt),
    )
  }

  private _withTimeout(id: string, runP: Promise<T>): Promise<T> {
    if (!this._taskTimeoutMs) return runP
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new TaskTimeoutError(id, this._taskTimeoutMs))
      }, this._taskTimeoutMs)
      runP.then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (error) => {
          clearTimeout(timer)
          reject(error)
        },
      )
    })
  }

  private _settle(
    info: PendingTaskInfo<T>,
    ok: boolean,
    value: T | unknown,
    attempt: number,
  ): void {
    const { id, group } = info.task
    this._running--
    this._runningIds.delete(id)
    if (group) {
      const next = (this._runningGroups.get(group) ?? 1) - 1
      if (next <= 0) this._runningGroups.delete(group)
      else this._runningGroups.set(group, next)
    }
    this._runningCost -= this._taskCost(info.task)

    if (!ok && this._shouldRetry(info.task, value, attempt)) {
      this._scheduleRetry(info, value, attempt)
      this.pump()
      this._notifyIdle()
      return
    }

    this._terminal(info, ok, value, attempt)
    this.pump()
    this._notifyIdle()
  }

  private _terminal(
    info: PendingTaskInfo<T>,
    ok: boolean,
    value: T | unknown,
    attempt: number,
  ): void {
    const { id } = info.task
    this._handles.get(id)?.[ok ? 'resolve' : 'reject'](value as T)
    this._handles.delete(id)
    if (ok) {
      this._completed++
      this._emit({ type: 'completed', taskId: id })
    } else {
      this._failed++
      this._emit({ type: 'failed', taskId: id, error: value, attempts: attempt + 1 })
      if (this._retry) {
        this._dead++
        this._emit({ type: 'deadlettered', taskId: id, error: value })
        this._onDeadLetter?.(info.task, value)
      }
    }
  }

  private _shouldRetry(task: Task<T>, error: unknown, attempt: number): boolean {
    const policy = this._retry
    if (!policy) return false
    if (attempt + 1 >= (policy.maxAttempts ?? 1)) return false
    return policy.retryWhen?.(error, attempt) ?? true
  }

  private _scheduleRetry(info: PendingTaskInfo<T>, _error: unknown, attempt: number): void {
    const { id } = info.task
    const delay = this._retry?.delayMs ?? 0
    const timer = setTimeout(() => {
      this._retryTimers.delete(timer)
      this._retryingIds.delete(id)
      this._start(info, attempt + 1)
    }, delay)
    this._retryTimers.add(timer)
    this._retryingIds.add(id)
  }

  private _cancelRetries(): void {
    if (this._retryingIds.size === 0) return
    for (const id of this._retryingIds) {
      this._finishPending(void 0, id)
    }
    this._retryingIds.clear()
    for (const timer of this._retryTimers) clearTimeout(timer)
    this._retryTimers.clear()
  }

  private _finishPending(_value: void, id: string): void {
    const handle = this._handles.get(id)
    if (handle) handle.reject(new TaskCancelledError(id))
    this._handles.delete(id)
    this._emit({ type: 'cancelled', taskId: id })
  }

  private _notifyIdle(): void {
    if (this._pending.length !== 0 || this._running !== 0 || this._retryingIds.size !== 0) return
    if (this._drainWaiters.length === 0) return
    for (const resolve of this._drainWaiters) resolve()
    this._drainWaiters = []
    this._emit({ type: 'idle' })
  }

  private _emit(event: SchedulerEvent): void {
    for (const listener of this._listeners) {
      try {
        listener(event)
      } catch {
        // listeners are pure observers and must never break scheduling
      }
    }
  }
}

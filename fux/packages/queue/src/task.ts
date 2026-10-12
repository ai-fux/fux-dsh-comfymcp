/** A unit of work handed to the scheduler. */
export interface Task<T = unknown> {
  /** Unique among tasks that are pending or running at the same time. */
  readonly id: string
  /** The work to execute. May be sync or async. */
  run(): T | Promise<T>
  /** Higher value runs first under a priority-aware strategy (default 0). */
  readonly priority?: number
  /** Tasks sharing a non-empty group never run concurrently. */
  readonly group?: string
  /**
   * G6: optional resource weight (e.g. GPU/MEM/CPU units). Consumed against a
   * scheduler `capacity` budget when one is configured; ignored otherwise. A
   * negative or non-finite cost is rejected at submit. Specific resource
   * semantics are supplied by the caller — the scheduler only enforces the
   * watermark, it never interprets the unit.
   */
  readonly cost?: number
  /** Opaque caller metadata carried through scheduling. */
  readonly meta?: unknown
}

/** Immutable view of a task that is queued (not yet started). */
export interface PendingTaskInfo<T = unknown> {
  readonly task: Task<T>
  /** Monotonic insertion sequence; lower = enqueued earlier (stable FIFO tie-break). */
  readonly order: number
  readonly queuedAt: number
}

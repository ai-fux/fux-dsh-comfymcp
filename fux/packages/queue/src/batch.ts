import type { Task } from './task.js'
import type { TaskScheduler } from './scheduler.js'

/**
 * G-09: batch submission + aggregation collector primitives. Single-task
 * scheduling semantics (priority / group exclusivity / capacity / retry /
 * dead-letter) are complete, but products repeatedly re-implement "submit
 * many, tolerate per-item rejections, collect every outcome". These reference
 * primitives close that gap without touching the scheduler itself.
 */

/** A task accepted by the scheduler, keyed by id with its settle promise. */
export interface BatchEntry<T> {
  readonly id: string
  readonly promise: Promise<T>
}

/** A task the scheduler rejected synchronously (duplicate / capacity / closed). */
export interface BatchRejection {
  readonly id: string
  readonly error: unknown
}

export interface BatchSubmission<T> {
  readonly entries: readonly BatchEntry<T>[]
  readonly rejected: readonly BatchRejection[]
}

/** Per-task terminal outcome of a batch (discriminated union). */
export type BatchOutcome<T> =
  | { readonly id: string; readonly ok: true; readonly value: T }
  | { readonly id: string; readonly ok: false; readonly error: unknown }

/**
 * Tolerant batch submit: every task is attempted, a synchronous rejection of
 * one item (duplicate id, capacity overflow, closed scheduler) never prevents
 * the rest from being submitted. Entry promises settle when each task actually
 * completes; rejected entries carry the scheduler's synchronous error.
 */
export function submitBatch<T>(
  scheduler: TaskScheduler<T>,
  tasks: ReadonlyArray<Task<T>>,
): BatchSubmission<T> {
  const entries: BatchEntry<T>[] = []
  const rejected: BatchRejection[] = []
  for (const task of tasks) {
    try {
      entries.push({ id: task.id, promise: scheduler.submit(task) })
    } catch (error) {
      rejected.push({ id: task.id, error })
    }
  }
  return { entries, rejected }
}

/**
 * Fan-out/aggregate collector: awaits every entry promise to settlement and
 * resolves with one id-keyed outcome per entry (never rejects — task failures
 * become `ok:false` outcomes).
 */
export async function collectBatch<T>(
  submission: BatchSubmission<T>,
): Promise<readonly BatchOutcome<T>[]> {
  return Promise.all(
    submission.entries.map(async (entry): Promise<BatchOutcome<T>> => {
      try {
        return { id: entry.id, ok: true, value: await entry.promise }
      } catch (error) {
        return { id: entry.id, ok: false, error }
      }
    }),
  )
}

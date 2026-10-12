import type { PendingTaskInfo } from './task.js'

/**
 * CR-03: a pluggable scheduling policy. Semantic policy is owned by the upper
 * layer; the scheduler only enforces its concurrency cap and group exclusivity
 * on top of the ordering a strategy returns. A strategy is pure and must not
 * mutate `pending`.
 */
export type SchedulingStrategy<T = unknown> = (
  pending: ReadonlyArray<PendingTaskInfo<T>>,
) => ReadonlyArray<PendingTaskInfo<T>>

/**
 * Default strategy: FIFO. Returns the queue in native (insertion) order, so a
 * caller that never swaps the strategy gets plain first-in-first-out behavior
 * with the configured concurrency cap — identical to a bounded sequential
 * queue.
 */
export function fifo<T = unknown>(): SchedulingStrategy<T> {
  return (pending) => pending
}

/**
 * Priority strategy: orders by `task.priority` descending (higher first),
 * stable — tasks with equal priority keep FIFO insertion order. Tasks without a
 * priority are treated as 0.
 */
export function priority<T = unknown>(): SchedulingStrategy<T> {
  return (pending) =>
    [...pending].sort((a, b) => {
      const pa = a.task.priority ?? 0
      const pb = b.task.priority ?? 0
      if (pa !== pb) return pb - pa
      return a.order - b.order
    })
}

/** Compose several strategies, applying their ordering left-to-right (stable). */
export function compose<T = unknown>(...strategies: Array<SchedulingStrategy<T>>) {
  return (pending: ReadonlyArray<PendingTaskInfo<T>>): ReadonlyArray<PendingTaskInfo<T>> => {
    let result: ReadonlyArray<PendingTaskInfo<T>> = pending
    for (const strategy of strategies) result = strategy(result)
    return result
  }
}

/** Base class for queue-scheduler failures. */
export class QueueError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'QueueError'
    this.code = code
  }
}

/** A task id that is already pending or running is not allowed. */
export class DuplicateTaskError extends QueueError {
  constructor(taskId: string) {
    super('E_DUPLICATE_TASK', `task "${taskId}" is already pending or running`)
    this.name = 'DuplicateTaskError'
  }
}

/** A pending task removed by `clear()` before it could run. */
export class TaskCancelledError extends QueueError {
  constructor(taskId: string) {
    super('E_TASK_CANCELLED', `task "${taskId}" was cancelled before running`)
    this.name = 'TaskCancelledError'
  }
}

/** A running task exceeded the configured `taskTimeoutMs`. */
export class TaskTimeoutError extends QueueError {
  constructor(taskId: string, timeoutMs: number) {
    super('E_TASK_TIMEOUT', `task "${taskId}" exceeded the ${timeoutMs}ms timeout`)
    this.name = 'TaskTimeoutError'
  }
}

/** A submitted task's `cost` exceeds the scheduler `capacity` budget. */
export class TaskCapacityError extends QueueError {
  constructor(taskId: string, cost: number, capacity: number) {
    super(
      'E_TASK_CAPACITY',
      `task "${taskId}" costs ${cost} which exceeds the capacity budget ${capacity}`,
    )
    this.name = 'TaskCapacityError'
  }
}

/** A task carried an invalid (negative / non-finite) resource `cost`. */
export class TaskInvalidCostError extends QueueError {
  constructor(taskId: string, cost: unknown) {
    super('E_TASK_INVALID_COST', `task "${taskId}" has an invalid resource cost: ${String(cost)}`)
    this.name = 'TaskInvalidCostError'
  }
}

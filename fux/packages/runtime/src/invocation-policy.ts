import { FuxRuntimeError, IpcInvocationError } from './errors.js'

// CR-02: optional invocation hooks for capability calls. Nothing here changes
// the default path — when no `signal` / `retry` is supplied, `invokeWithPolicy`
// simply awaits the operation once, exactly like a plain call.

/** Retry schedule applied to a failing capability call. All fields optional. */
export interface RetryPolicy {
  /** Max retries after the first attempt (default 0 = no retry). */
  maxRetries?: number
  /** Base backoff delay in ms for the first retry (default 100). */
  baseDelayMs?: number
  /** Exponential backoff ceiling in ms (default 2000). */
  maxDelayMs?: number
  /** Extra randomized jitter to spread retries (default true). */
  jitter?: boolean
  /** Optional gate: return false to stop retrying for this failure. */
  retryWhen?: (error: unknown, attempt: number) => boolean
}

/** Per-call invocation hooks (cancel + retry), all optional. */
export interface InvocationOptions {
  signal?: AbortSignal
  retry?: RetryPolicy
}

/** Thrown when a call is cancelled via its AbortSignal before/during retry. */
export class InvocationCancelledError extends FuxRuntimeError {
  constructor() {
    super('E_CALL_CANCELLED', 'capability call was cancelled')
    this.name = 'InvocationCancelledError'
  }
}

/** Default retry predicate: only transient runtime failures are retried. */
export function isRetryable(error: unknown): boolean {
  return error instanceof FuxRuntimeError && error.retryable
}

const DEFAULT_RETRY: Required<Omit<RetryPolicy, 'retryWhen'>> = {
  maxRetries: 0,
  baseDelayMs: 100,
  maxDelayMs: 2000,
  jitter: true,
}

function isAbortSignalError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new InvocationCancelledError()
}

export async function invokeWithPolicy<T>(
  operation: () => Promise<T>,
  options?: InvocationOptions,
): Promise<T> {
  const { signal } = options ?? {}
  const retry = { ...DEFAULT_RETRY, ...(options?.retry ?? {}) }
  let attempts = 0

  for (;;) {
    assertNotAborted(signal)
    try {
      return await operation()
    } catch (error) {
      if (isAbortSignalError(error)) throw new InvocationCancelledError()
      if (retry.maxRetries <= 0 || attempts >= retry.maxRetries) throw error
      if (
        options?.retry?.retryWhen ? !options.retry.retryWhen(error, attempts) : !isRetryable(error)
      ) {
        throw error
      }
      attempts += 1
      await sleep(backoff(attempts, retry), signal)
    }
  }
}

function backoff(attempts: number, retry: Required<Omit<RetryPolicy, 'retryWhen'>>): number {
  const exp = Math.min(retry.baseDelayMs * 2 ** (attempts - 1), retry.maxDelayMs)
  return retry.jitter ? exp / 2 + Math.random() * (exp / 2) : exp
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new InvocationCancelledError())
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new InvocationCancelledError())
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
  })
}

// Re-exported for callers that build a failure to decide retryability.
export { IpcInvocationError }

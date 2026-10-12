/**
 * G-05: broker-level, per-capability call metrics. Every capability invocation
 * that settles through `CapabilityBroker.call` — direct, system, scheduled,
 * connector-served, or worker/remote-originated — is observed at this single
 * funnel and aggregated by capability name.
 *
 * The registry is pure in-memory accounting (no I/O, no timers, no exports of
 * its own): a product that never reads `StartedRuntime.metrics()` behaves
 * exactly as before, and one that does polls the JSON-serializable snapshot
 * (e.g. into its log/event channels) on its own cadence.
 */

import { IpcInvocationError } from './errors.js'

/** Aggregated counters for one capability, as of a snapshot. */
export interface CapabilityMetrics {
  readonly capability: string
  /** Settled invocations (successes and failures alike). */
  readonly invocations: number
  readonly errors: number
  /** Failures whose error was flagged retryable. */
  readonly retryableErrors: number
  readonly totalDurationMs: number
  /** `null` until the first invocation settles. */
  readonly minDurationMs: number | null
  readonly maxDurationMs: number
  readonly lastDurationMs: number
  readonly lastError?: {
    readonly code: string
    readonly message: string
    readonly at: number
  }
}

/** JSON-serializable, capability-sorted point-in-time view of all metrics. */
export type MetricsSnapshot = readonly CapabilityMetrics[]

/** One settled invocation as recorded by the broker. */
export interface InvocationObservation {
  readonly capability: string
  readonly ok: boolean
  readonly retryable: boolean
  readonly durationMs: number
  readonly error?: unknown
}

interface MutableMetrics {
  capability: string
  invocations: number
  errors: number
  retryableErrors: number
  totalDurationMs: number
  minDurationMs: number | null
  maxDurationMs: number
  lastDurationMs: number
  lastError?: { code: string; message: string; at: number }
}

/** Extracts a stable wire-code shape from an arbitrary thrown error. */
function errorCodeOf(error: unknown): { code: string; message: string } {
  // An IPC failure carries the original wire code (e.g. E_TIMEOUT) on its
  // envelope — report that rather than the generic E_IPC_FAILURE wrapper code.
  if (error instanceof IpcInvocationError) {
    return { code: error.ipcError.code, message: error.ipcError.message }
  }
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    return {
      code: typeof code === 'string' ? code : error.name,
      message: error.message,
    }
  }
  return { code: 'E_UNKNOWN', message: String(error) }
}

export class MetricsRegistry {
  private readonly byCapability = new Map<string, MutableMetrics>()

  record(obs: InvocationObservation): void {
    let metrics = this.byCapability.get(obs.capability)
    if (!metrics) {
      metrics = {
        capability: obs.capability,
        invocations: 0,
        errors: 0,
        retryableErrors: 0,
        totalDurationMs: 0,
        minDurationMs: null,
        maxDurationMs: 0,
        lastDurationMs: 0,
      }
      this.byCapability.set(obs.capability, metrics)
    }
    const durationMs = Math.max(0, obs.durationMs)
    metrics.invocations += 1
    metrics.totalDurationMs += durationMs
    metrics.minDurationMs =
      metrics.minDurationMs === null ? durationMs : Math.min(metrics.minDurationMs, durationMs)
    metrics.maxDurationMs = Math.max(metrics.maxDurationMs, durationMs)
    metrics.lastDurationMs = durationMs
    if (!obs.ok) {
      metrics.errors += 1
      if (obs.retryable) metrics.retryableErrors += 1
      const { code, message } = errorCodeOf(obs.error)
      metrics.lastError = { code, message, at: Date.now() }
    }
  }

  /** Aggregates sorted by capability name for a stable, diffable snapshot. */
  snapshot(): MetricsSnapshot {
    return [...this.byCapability.values()]
      .sort((a, b) => (a.capability < b.capability ? -1 : a.capability > b.capability ? 1 : 0))
      .map((m): CapabilityMetrics => {
        const metrics: CapabilityMetrics = {
          capability: m.capability,
          invocations: m.invocations,
          errors: m.errors,
          retryableErrors: m.retryableErrors,
          totalDurationMs: m.totalDurationMs,
          minDurationMs: m.minDurationMs,
          maxDurationMs: m.maxDurationMs,
          lastDurationMs: m.lastDurationMs,
          ...(m.lastError ? { lastError: m.lastError } : {}),
        }
        return metrics
      })
  }

  of(capability: string): CapabilityMetrics | undefined {
    return this.snapshot().find((m) => m.capability === capability)
  }

  reset(): void {
    this.byCapability.clear()
  }
}

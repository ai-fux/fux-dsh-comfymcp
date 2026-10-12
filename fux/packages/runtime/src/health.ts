/**
 * FR-02: framework-level health collection. This is *mechanism only* — it
 * defines what a plugin may report and how the runtime aggregates it, never a
 * dashboard or metric panel (those belong to the product).
 */

export type HealthStatus = 'ok' | 'degraded' | 'down'

export interface HealthSnapshot {
  readonly pluginId: string
  readonly status: HealthStatus
  readonly detail?: unknown
  readonly updatedAt: number
}

/**
 * A pull-based health source. A plugin registers one so the framework can
 * collect a fresh status on demand. It may return a bare status or a report
 * (status + optional detail); the snapshot is completed at collect time.
 */
export interface HealthReport {
  readonly status: HealthStatus
  readonly detail?: unknown
}

export type HealthProvider =
  (() => HealthReport | HealthStatus) | (() => Promise<HealthReport | HealthStatus>)

/**
 * Per-plugin health collection. Pure additive: a plugin that never touches it
 * produces no entries; report() and provide() are the push/pull channels.
 */
export class HealthRegistry {
  private readonly pushed = new Map<string, HealthSnapshot>()
  private readonly providers = new Map<string, HealthProvider>()

  /** Push a point-in-time report for a plugin. */
  report(pluginId: string, status: HealthStatus, detail?: unknown): void {
    this.pushed.set(pluginId, { pluginId, status, detail, updatedAt: Date.now() })
  }

  /** Register a pull source; poll() invokes it to refresh that plugin's report. */
  provide(pluginId: string, provider: HealthProvider): void {
    this.providers.set(pluginId, provider)
  }

  /** Latest pushed report per plugin. Synchronous; providers are not invoked. */
  snapshot(): ReadonlyMap<string, HealthSnapshot> {
    return this.pushed
  }

  healthOf(pluginId: string): HealthSnapshot | undefined {
    return this.pushed.get(pluginId)
  }

  /**
   * Collection pass: invoke every registered provider and store its fresh
   * result (for plugins with a provider). Plugins that only report() keep their
   * latest pushed snapshot.
   */
  async poll(): Promise<ReadonlyMap<string, HealthSnapshot>> {
    for (const [pluginId, provider] of this.providers) {
      const collected = await provider()
      this.pushed.set(pluginId, normalize(pluginId, collected))
    }
    return this.pushed
  }

  clear(pluginId?: string): void {
    if (pluginId !== undefined) {
      this.pushed.delete(pluginId)
      this.providers.delete(pluginId)
      return
    }
    this.pushed.clear()
    this.providers.clear()
  }
}

function normalize(pluginId: string, collected: HealthReport | HealthStatus): HealthSnapshot {
  if (typeof collected === 'string') {
    return { pluginId, status: collected, updatedAt: Date.now() }
  }
  return { pluginId, status: collected.status, detail: collected.detail, updatedAt: Date.now() }
}

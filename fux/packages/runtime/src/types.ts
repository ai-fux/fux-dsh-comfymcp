import type { ExecutionMode, IpcEvent, IpcResponse, PluginManifest } from '@fux/protocol'
import type { EventBus, PluginState } from '@fux/core'
import type { SchedulerStats, SchedulingStrategy } from '@fux/queue'
import type { CapabilityBroker } from './broker.js'
import type { HealthProvider, HealthRegistry, HealthStatus } from './health.js'

export type CapabilityHandler = (payload: unknown) => unknown | Promise<unknown>

/**
 * Per-call controls for the optional scheduled-execution path (CR-03 wiring).
 * Semantics mirror `Task` in @fux/queue; a single capability invocation becomes
 * one scheduled task.
 */
export interface ScheduledCallOptions {
  /** Stable task id; defaults to an auto-generated per-schedule id. */
  readonly taskId?: string
  /** Higher value runs first under a priority-aware strategy (default 0). */
  readonly priority?: number
  /** Calls sharing a non-empty group never run concurrently. */
  readonly group?: string
}

/** Read-only view surfaced when a scheduling queue is active on the runtime. */
export interface QueueInfo {
  /** True when the runtime created (and owns) the scheduler; false when injected. */
  readonly owned: boolean
  readonly stats: SchedulerStats
}

/** Constructor options for a runtime-owned scheduler (omit to stay un-queued). */
export interface SchedulerSetup {
  readonly concurrency?: number
  readonly strategy?: SchedulingStrategy<unknown>
  readonly taskTimeoutMs?: number
}

export interface PluginContextEvents {
  on(topic: string, handler: (event: IpcEvent) => void): () => void
  emit(topic: string, payload?: unknown): void
}

/**
 * FR-02: optional per-plugin health reporting. A plugin uses report() to push a
 * point-in-time status or provide() to let the framework pull one on demand.
 * Purely additive — plugins that ignore it are unaffected.
 */
export interface PluginHealthApi {
  report(status: HealthStatus, detail?: unknown): void
  provide(provider: HealthProvider): void
}

export interface PluginContext {
  readonly pluginId: string
  readonly config: Record<string, unknown>
  provide(capability: string, handler: CapabilityHandler): void
  call<T = unknown>(capability: string, payload?: unknown): Promise<T>
  readonly events: PluginContextEvents
  readonly health?: PluginHealthApi
}

export interface FuxPluginModule {
  activate(context: PluginContext): Promise<void> | void
  deactivate?(): Promise<void> | void
}

export type ModuleLoader = () => FuxPluginModule | Promise<FuxPluginModule>

export interface PluginHost {
  readonly pluginId: string
  readonly mode: ExecutionMode
  start(): Promise<void>
  stop(): Promise<void>
  invoke(capability: string, payload?: unknown): Promise<IpcResponse>
  providedCapabilities(): string[]
  // CR-01: optional lifecycle status. Absent on legacy hosts (framework only).
  status?(): PluginState
}

/**
 * PRD execution-mode extensibility: the ambient services a custom host may need.
 * A resolver-driven host that runs a plugin out of process (worker / remote /
 * any caller-defined mode) still needs to invoke the broker, emit events and
 * (optionally) report health on the product's behalf. Type-only; nothing in the
 * runtime inspects these unless the caller wires a host factory.
 */
export interface PluginHostDeps {
  readonly broker: CapabilityBroker
  readonly events: EventBus
  readonly health?: HealthRegistry
  /**
   * G1 强化: optional — fired when a host's underlying execution channel dies
   * unexpectedly (a worker sub-process exited, a remote transport disconnected)
   * while the plugin was running. The supervisor wires this to mark the plugin
   * 'broken' so runtime state stays truthful and in-flight calls fail fast.
   * Absent (legacy hosts / framework-only), hosts still self-mark 'broken'.
   */
  readonly onHostExit?: (pluginId: string, reason?: unknown) => void
}

/**
 * PRD: optional hook that lets an upstream authority provide a `PluginHost` for
 * an execution mode the runtime does not implement natively. Returning `undefined`
 * defers to the built-in dispatch — `in_process` -> InProcessHost, anything else
 * -> UnsupportedExecutionModeError. The factory is a *mechanism, not a transport*:
 * it never ships IPC / process / remote semantics, matching CR class being a
 * framework-only contract.
 */
export type PluginHostFactory = (
  manifest: PluginManifest,
  config: Record<string, unknown>,
  deps: PluginHostDeps,
) => PluginHost | undefined

export type { ExecutionMode, IpcEvent, IpcResponse, PluginManifest }

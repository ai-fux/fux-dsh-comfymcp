import type { PluginHostFactory } from './types.js'
import { NodeWorkerChannel, WorkerHost } from './worker-host.js'
import { RemoteHost } from './remote-host.js'
import { SandboxHost } from './sandbox-host.js'
import type { RemoteTransport } from './remote-transport.js'

/**
 * G1/G3: options for the opt-in worker / remote / sandbox host factory. Nothing
 * here is wired by default — the built-in Supervisor dispatch (in_process plus
 * UnsupportedExecutionModeError for other modes) is unchanged until a caller opts
 * in via `SupervisorOptions.hostFactory`.
 */
export interface ExecutionHostFactoryOptions {
  /** Enable `executionMode: 'worker'`. Absent, worker plugins fall through. */
  worker?: {
    /**
     * The bootstrap file a `NodeWorkerChannel` forks (a JS module that wires
     * `process.send` to the `WorkerRuntime`, e.g. via `runNodeWorker()`).
     */
    entry: string
    /** Optional map of pluginId -> module file the worker imports. */
    moduleRef?: (pluginId: string) => string | undefined
    /** Forward worker-originated context.call to the shared broker (default true). */
    callThrough?: boolean
    /** G1 强化: per-invoke budget (ms) for worker calls; absent = no timeout. */
    invokeTimeoutMs?: number
  }
  /** Enable `executionMode: 'remote'`. Absent, remote plugins fall through. */
  remote?: {
    /** Build the transport that reaches a plugin's remote endpoint. */
    transport: (pluginId: string) => RemoteTransport
    /** G1 强化: per-invoke budget (ms) for remote calls; absent = no timeout. */
    invokeTimeoutMs?: number
  }
  /**
   * G3: run a plugin's capability handlers as untrusted source inside a
   * `SandboxRuntime` (L2 `node:vm` boundary). When `handlers(pluginId)` returns a
   * capability -> source map, a `SandboxHost` is used for that plugin regardless
   * of its `executionMode`; returning `undefined` keeps the normal dispatch. This
   * is fully opt-in — no manifest/protocol change, default hosts untouched.
   */
  sandbox?: {
    /** capability -> handler source for the given plugin, or undefined to skip. */
    handlers: (pluginId: string) => Record<string, string> | undefined
    /** Per-invocation budget (ms) for sandboxed handlers. Default 1000. */
    timeoutMs?: number
  }
}

/**
 * A `PluginHostFactory` that natively dispatches `worker` / `remote` execution
 * modes. `in_process` (and any unknown mode) returns `undefined`, so the built-in
 * Supervisor dispatch still handles them. Wire it in with:
 *
 * ```ts
 * supervisorOptions = {
 *   hostFactory: createExecutionHostFactory({ worker: { entry }, remote: { transport } }),
 * }
 * ```
 *
 * When a mode is declared in a manifest but no matching option is configured, the
 * factory returns `undefined` for that plugin too, preserving the pre-G1
 * `UnsupportedExecutionModeError` — nothing silently changes.
 */
export function createExecutionHostFactory(
  options: ExecutionHostFactoryOptions,
): PluginHostFactory {
  return (manifest, config, deps) => {
    if (manifest.executionMode === 'worker') {
      const worker = options.worker
      if (!worker?.entry) return undefined
      const call =
        worker.callThrough === false
          ? undefined
          : (capability: string, payload?: unknown) =>
              deps.broker.call(manifest.id, capability, payload)
      return new WorkerHost(manifest, config, {
        channel: new NodeWorkerChannel({ entry: worker.entry }),
        events: deps.events,
        call,
        moduleRef: worker.moduleRef?.(manifest.id),
        invokeTimeoutMs: worker.invokeTimeoutMs,
        onExit: (reason) => deps.onHostExit?.(manifest.id, reason),
      })
    }
    if (manifest.executionMode === 'remote') {
      const remote = options.remote
      if (!remote) return undefined
      return new RemoteHost(manifest.id, {
        transport: remote.transport(manifest.id),
        events: deps.events,
        source: manifest.id,
        invokeTimeoutMs: remote.invokeTimeoutMs,
        onExit: (reason) => deps.onHostExit?.(manifest.id, reason),
      })
    }
    const sandbox = options.sandbox
    if (sandbox) {
      const handlers = sandbox.handlers(manifest.id)
      if (handlers) {
        return new SandboxHost(manifest, config, {
          broker: deps.broker,
          events: deps.events,
          handlers,
          timeoutMs: sandbox.timeoutMs,
        })
      }
    }
    return undefined
  }
}

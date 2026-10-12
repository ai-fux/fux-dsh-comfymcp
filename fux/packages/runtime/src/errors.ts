export class FuxRuntimeError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(code: string, message: string, retryable = false) {
    super(message)
    this.name = 'FuxRuntimeError'
    this.code = code
    this.retryable = retryable
  }
}

export const SYSTEM_CALLER = 'system'

export class CapabilityDeniedError extends FuxRuntimeError {
  constructor(callerId: string, capability: string) {
    super(
      'E_CAPABILITY_DENIED',
      `plugin "${callerId}" is not allowed to call "${capability}" (not declared in manifest consumes)`,
    )
    this.name = 'CapabilityDeniedError'
  }
}

export class CapabilityNotFoundRuntimeError extends FuxRuntimeError {
  readonly capability: string

  constructor(capability: string) {
    super('E_CAPABILITY_NOT_FOUND', `capability "${capability}" is not available in this product`)
    this.name = 'CapabilityNotFoundRuntimeError'
    this.capability = capability
  }
}

export class UnknownCallerError extends FuxRuntimeError {
  constructor(callerId: string) {
    super('E_UNKNOWN_CALLER', `caller "${callerId}" is not part of the active product`)
    this.name = 'UnknownCallerError'
  }
}

export class HostNotRunningError extends FuxRuntimeError {
  constructor(pluginId: string) {
    super('E_HOST_NOT_RUNNING', `plugin host for "${pluginId}" is not running`, true)
    this.name = 'HostNotRunningError'
  }
}

export class IpcInvocationError extends FuxRuntimeError {
  readonly ipcError: { code: string; message: string; retryable: boolean }

  constructor(ipcError: { code: string; message: string; retryable: boolean }) {
    super(`E_IPC_FAILURE`, `${ipcError.code}: ${ipcError.message}`, ipcError.retryable)
    this.name = 'IpcInvocationError'
    this.ipcError = ipcError
  }
}

export class PluginStartError extends FuxRuntimeError {
  readonly pluginId: string
  override readonly cause?: unknown

  constructor(pluginId: string, cause?: unknown) {
    super(
      'E_PLUGIN_START',
      `plugin "${pluginId}" failed to start: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
    this.name = 'PluginStartError'
    this.pluginId = pluginId
    this.cause = cause
  }
}

export class ProvideUndeclaredError extends FuxRuntimeError {
  constructor(pluginId: string, capability: string) {
    super(
      'E_PROVIDE_UNDECLARED',
      `plugin "${pluginId}" tried to provide "${capability}" which is not declared in its manifest`,
    )
    this.name = 'ProvideUndeclaredError'
  }
}

export class UnsupportedExecutionModeError extends FuxRuntimeError {
  constructor(pluginId: string, mode: string) {
    super(
      'E_UNSUPPORTED_MODE',
      `plugin "${pluginId}" requires execution mode "${mode}" which is not implemented yet (worker/remote land in a later release)`,
    )
    this.name = 'UnsupportedExecutionModeError'
  }
}

export class DuplicatePluginRuntimeError extends FuxRuntimeError {
  constructor(pluginId: string) {
    super(
      'E_DUPLICATE_PLUGIN_RUNTIME',
      `plugin already present in the running product: "${pluginId}"`,
    )
    this.name = 'DuplicatePluginRuntimeError'
  }
}

export class PluginNotStartedError extends FuxRuntimeError {
  constructor(pluginId: string) {
    super('E_PLUGIN_NOT_STARTED', `plugin "${pluginId}" is not registered in the running product`)
    this.name = 'PluginNotStartedError'
  }
}

export class DuplicateCapabilityRuntimeError extends FuxRuntimeError {
  constructor(capability: string, firstProvider: string, secondProvider: string) {
    super(
      'E_DUPLICATE_CAPABILITY_RUNTIME',
      `capability "${capability}" at runtime is already provided by "${firstProvider}" (cannot also be provided by "${secondProvider}")`,
    )
    this.name = 'DuplicateCapabilityRuntimeError'
  }
}

export class ConnectorResolverMissingError extends FuxRuntimeError {
  constructor(connectorId: string) {
    super(
      'E_CONNECTOR_RESOLVER_MISSING',
      `product declares connector "${connectorId}" but no connectorResolver was provided to the Supervisor`,
    )
    this.name = 'ConnectorResolverMissingError'
  }
}

export class ConnectorStartError extends FuxRuntimeError {
  constructor(connectorId: string, cause?: unknown) {
    super(
      'E_CONNECTOR_START',
      `connector "${connectorId}" failed to resolve/register: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
    this.name = 'ConnectorStartError'
  }
}

// G1: worker / remote execution hosts. These fail fast with explicit codes so a
// misconfigured sub-process or network host is surfaced, never silently bridged.

/** A `worker` host could not spawn/open its sub-process channel. */
export class WorkerSpawnError extends FuxRuntimeError {
  constructor(pluginId: string, cause?: unknown) {
    super(
      'E_WORKER_SPAWN',
      `worker host for "${pluginId}" failed to start: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
    this.name = 'WorkerSpawnError'
  }
}

/** A spawned worker sub-process exited before it could be cleanly stopped. */
export class WorkerExitError extends FuxRuntimeError {
  constructor(pluginId: string, code: number | null, signal: string | null) {
    super(
      'E_WORKER_EXIT',
      `worker host for "${pluginId}" exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
      true,
    )
    this.name = 'WorkerExitError'
  }
}

// G3: sandbox / restricted-execution boundary. L1 (process isolation) is provided
// by the worker host's OS sub-process; L2 here is `SandboxRuntime` — a good-faith
// `node:vm` restricted context (interface surface + timeout + state isolation),
// not a hardened adversary boundary.

/** Third-party code crossed the restricted runtime boundary (banned global access,
 *  non-function source, or a non-JSON-safe result). Not retryable. */
export class SandboxViolationError extends FuxRuntimeError {
  constructor(message: string) {
    super('E_SANDBOX_VIOLATION', message)
    this.name = 'SandboxViolationError'
  }
}

/** Sandbox source threw while executing (an application error inside the handler). */
export class SandboxExecutionError extends FuxRuntimeError {
  constructor(message: string) {
    super('E_SANDBOX_EXEC', message)
    this.name = 'SandboxExecutionError'
  }
}

/** A sandboxed handler exceeded its time budget. Retryable. */
export class SandboxTimeoutError extends FuxRuntimeError {
  constructor(timeoutMs: number) {
    super('E_SANDBOX_TIMEOUT', `sandboxed handler exceeded the ${timeoutMs}ms budget`, true)
    this.name = 'SandboxTimeoutError'
  }
}

// G4: cross-host node discovery / health handshake.

/** A remote node could not be reached / did not answer its health endpoint. Retryable. */
export class RemoteNodeUnreachableError extends FuxRuntimeError {
  readonly url: string

  constructor(url: string, cause?: unknown) {
    super(
      'E_REMOTE_NODE_UNREACHABLE',
      `remote node at "${url}" is unreachable: ${cause instanceof Error ? cause.message : String(cause)}`,
      true,
    )
    this.name = 'RemoteNodeUnreachableError'
    this.url = url
  }
}

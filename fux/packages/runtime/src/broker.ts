import { newRequestId } from '@fux/protocol'
import type { IpcResponse, Permission, PluginManifest } from '@fux/protocol'
import type { CapabilityBinding, RuntimeGraph } from '@fux/core'
import {
  CapabilityDeniedError,
  CapabilityNotFoundRuntimeError,
  DuplicateCapabilityRuntimeError,
  FuxRuntimeError,
  HostNotRunningError,
  IpcInvocationError,
  SYSTEM_CALLER,
  UnknownCallerError,
} from './errors.js'
import { invokeWithPolicy } from './invocation-policy.js'
import type { InvocationOptions } from './invocation-policy.js'
import type { MetricsRegistry } from './metrics.js'
import type { PluginHost } from './types.js'

export class CapabilityBroker {
  private readonly hosts: Map<string, PluginHost>
  private readonly callerManifests: Map<string, PluginManifest>
  private readonly bindings: Map<string, CapabilityBinding>
  // G-05: optional per-capability metrics sink. Absent, call() is untouched.
  private readonly metrics?: MetricsRegistry

  constructor(
    graph: RuntimeGraph,
    hosts: Map<string, PluginHost>,
    options?: { metrics?: MetricsRegistry },
  ) {
    this.hosts = hosts
    this.callerManifests = new Map([...graph.plugins].map(([id, node]) => [id, node.manifest]))
    this.bindings = new Map(graph.capabilities)
    this.metrics = options?.metrics
  }

  async call<T = unknown>(
    callerId: string,
    capability: string,
    payload?: unknown,
    options?: InvocationOptions,
  ): Promise<T> {
    const startedAt = this.metrics ? Date.now() : 0
    try {
      const result = await this._call<T>(callerId, capability, payload, options)
      if (this.metrics) {
        this.metrics.record({
          capability,
          ok: true,
          retryable: false,
          durationMs: Date.now() - startedAt,
        })
      }
      return result
    } catch (error) {
      if (this.metrics) {
        this.metrics.record({
          capability,
          ok: false,
          retryable: error instanceof FuxRuntimeError && error.retryable,
          durationMs: Date.now() - startedAt,
          error,
        })
      }
      throw error
    }
  }

  private async _call<T = unknown>(
    callerId: string,
    capability: string,
    payload?: unknown,
    options?: InvocationOptions,
  ): Promise<T> {
    const binding = this.bindings.get(capability)
    if (!binding) {
      throw new CapabilityNotFoundRuntimeError(capability)
    }

    if (callerId !== SYSTEM_CALLER) {
      const caller = this.callerManifests.get(callerId)
      if (!caller) throw new UnknownCallerError(callerId)
      if (!caller.consumes.includes(capability)) {
        throw new CapabilityDeniedError(callerId, capability)
      }
    }

    const host = this.hosts.get(binding.providerId)
    if (!host) throw new HostNotRunningError(binding.providerId)

    // CR-02: optional cancel/retry hooks. The retryable unit is the invoke + reply
    // check, so a transient ipc reply (retryable=true) is retried while config/
    // authorization failures throw straight through.
    const response: IpcResponse = await invokeWithPolicy(async () => {
      const reply = await host.invoke(capability, payload)
      if (!reply.ok) throw new IpcInvocationError(reply.error)
      return reply
    }, options)
    return response.result as T
  }

  // AR-02 (runtime hot-plug): capability provider view for a plugin with no
  // existing binding under the same name or an owner that is itself.
  bindProvider(
    capability: string,
    providerId: string,
    executionMode: CapabilityBinding['executionMode'],
  ): void {
    const existing = this.bindings.get(capability)
    if (existing && existing.providerId !== providerId) {
      throw new DuplicateCapabilityRuntimeError(capability, existing.providerId, providerId)
    }
    this.bindings.set(capability, { providerId, executionMode })
  }

  removeProvider(capability: string, providerId: string): boolean {
    const existing = this.bindings.get(capability)
    if (!existing || existing.providerId !== providerId) return false
    return this.bindings.delete(capability)
  }

  addCaller(manifest: PluginManifest): void {
    this.callerManifests.set(manifest.id, manifest)
  }

  removeCaller(pluginId: string): boolean {
    return this.callerManifests.delete(pluginId)
  }

  // BR-03: declarative permission claims are exposed read-only for an upstream
  // authorization policy. The framework never gates on them — the mandatory gate
  // stays `consumes` in call(). Absence means the caller declared no permissions.
  permissionsOf(pluginId: string): readonly Permission[] | undefined {
    return this.callerManifests.get(pluginId)?.permissions
  }

  hasPermission(pluginId: string, resource: string, action: string): boolean {
    const claims = this.permissionsOf(pluginId)
    if (!claims) return false
    return claims.some((p) => p.resource === resource && p.action === action)
  }
}

export { newRequestId }

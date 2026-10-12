import type { EventBus, Logger, PluginState, RuntimeGraph } from '@fux/core'
import { LifecycleManager, ProtocolIncompatibleError } from '@fux/core'
import { noopLogger, type LogChannel, type LogSink } from '@fux/core'
import { createChannel, createLogChannel, type EventChannel, type PersistenceSink } from '@fux/core'
import {
  ConnectorRegistry,
  type Connector,
  type ConnectorMessage,
  type SendResult,
} from '@fux/connector'
import { TaskScheduler } from '@fux/queue'
import {
  SkeletonRegistry,
  ThemeProvider,
  ThemeRegistry,
  type Skeleton,
  type SkeletonDefinition,
  type Skin,
  type SkinDefinition,
  type ThemePack,
} from '@fux/ui'
import {
  FUX_PROTOCOL_VERSION,
  isProtocolCompatible,
  parseManifest,
  type ConnectorDefinition,
  type Discoverable,
  type DiscoveryQuery,
  type FuxResource,
  type PluginManifest,
} from '@fux/protocol'
import { CapabilityBroker } from './broker.js'
import { createConnectorEventSink } from './connector-bridge.js'
import { RuntimeDiscovery } from './discovery.js'
import {
  ConnectorResolverMissingError,
  ConnectorStartError,
  DuplicatePluginRuntimeError,
  PluginNotStartedError,
  PluginStartError,
  SYSTEM_CALLER,
  UnsupportedExecutionModeError,
} from './errors.js'
import { HealthRegistry, type HealthSnapshot } from './health.js'
import { InProcessHost } from './in-process-host.js'
import type { InvocationOptions } from './invocation-policy.js'
import { MetricsRegistry, type MetricsSnapshot } from './metrics.js'
import {
  HttpNodeHealthProbe,
  RemoteNodeRegistry,
  type NodeHealthProbe,
  type RemoteNode,
} from './node-discovery.js'
import type {
  FuxPluginModule,
  PluginHost,
  PluginHostDeps,
  PluginHostFactory,
  QueueInfo,
  ScheduledCallOptions,
  SchedulerSetup,
} from './types.js'

export type ModuleResolver = (pluginId: string) => FuxPluginModule | Promise<FuxPluginModule>

export type ConnectorResolver = (connectorId: string) => Connector | Promise<Connector>

export interface SupervisorOptions {
  logger?: Logger
  /**
   * FR-01: optional persistence hooks for the unified event + log channels.
   * When provided, every event on the core bus and every log record on the log
   * channel is additionally appended to these sinks (side effects only). Omit
   * to keep dispatch/console logging entirely unchanged — the default.
   */
  persistence?: {
    /** Appended with every event emitted on the core bus. */
    events?: PersistenceSink
    /** Appended with every record written through the exposed log channel. */
    logs?: LogSink
  }
  /**
   * CR-03 wiring: an optional scheduling queue for capability calls. Pass a
   * `TaskScheduler` instance to keep ownership (the runtime never closes it),
   * or a `SchedulerSetup` for the runtime to build and own one (closed on
   * `stop()`). Omit to keep every invocation direct — the unchanged default.
   */
  scheduler?: TaskScheduler<unknown> | SchedulerSetup
  /**
   * CR-04 wiring: resolves connectors **declared** in the product (graph's
   * `connectors`). The transport belongs to the caller; this resolver maps a
   * declared connector id to the concrete `Connector`. Required only when a
   * product declares connectors.
   */
  connectorResolver?: ConnectorResolver
  /**
   * BR-02: extra `Discoverable` sources to fold into the unified discovery
   * view (e.g. an external service registry). Optional; built-in plugin,
   * capability and connector sources are always included.
   */
  discovery?: readonly Discoverable[]
  /**
   * PRD: optional host factory that lets the caller provide a `PluginHost` for
   * execution modes the runtime does not implement natively (worker / remote /
   * any caller-defined mode). Return `undefined` to fall back to the built-in
   * dispatch — `in_process` -> InProcessHost, otherwise UnsupportedExecutionModeError.
   * Purely additive: wiring nothing means an unadopted product behaves exactly
   * as before, and no transport / process / IPC semantics are implied.
   */
  hostFactory?: PluginHostFactory
  /**
   * G4: opt-in cross-host node discovery + health handshake. When present, the
   * runtime creates a `RemoteNodeRegistry` (probe = `HttpNodeHealthProbe` unless
   * overridden), watches the seed endpoints on `intervalMs`, folds their remote
   * capabilities into the unified discovery view and exposes the live directory
   * via `StartedRuntime.nodes()`. Absent, no network I/O happens and behavior is
   * byte-for-byte unchanged.
   */
  remoteNodes?: {
    /** Peer endpoints to probe for identity + capabilities + health. */
    urls?: string[]
    /** Custom probe (transport seam); defaults to HTTP `GET /health`. */
    probe?: NodeHealthProbe
    /** Poll interval for re-probing peers (ms). Default 5000. */
    intervalMs?: number
    /** Expire a peer not seen within this window (ms). Default 15000. */
    staleAfterMs?: number
  }
}

export interface StartedRuntime {
  readonly graph: RuntimeGraph
  call<T = unknown>(
    callerId: string,
    capability: string,
    payload?: unknown,
    options?: InvocationOptions,
  ): Promise<T>
  callAsSystem<T = unknown>(
    capability: string,
    payload?: unknown,
    options?: InvocationOptions,
  ): Promise<T>
  states(): ReadonlyMap<string, PluginState>
  stop(): Promise<void>
  // AR-02 / AR-03: hot-plug lifecycle. Static startup path is unchanged; these
  // add optional runtime registration, enable/disable, and removal.
  registerPlugin(input: unknown, options?: { config?: Record<string, unknown> }): Promise<void>
  startPlugin(pluginId: string): Promise<void>
  stopPlugin(pluginId: string): Promise<void>
  unregisterPlugin(pluginId: string): Promise<void>
  // CR-03 wiring: an optional scheduled-execution path. `schedule` equals `call`
  // when no queue is configured (strictly backward compatible); with a queue it
  // routes the invocation through the scheduler's concurrency / priority / group
  // policy.
  schedule<T = unknown>(
    callerId: string,
    capability: string,
    payload?: unknown,
    options?: ScheduledCallOptions,
  ): Promise<T>
  scheduleAsSystem<T = unknown>(
    capability: string,
    payload?: unknown,
    options?: ScheduledCallOptions,
  ): Promise<T>
  queueInfo(): QueueInfo | undefined
  drainQueue(): Promise<void>
  // CR-04 wiring: connectors owned by the runtime. Product-declared connectors
  // are resolved, registered, opened and message-bridged at start; imperative
  // registration is additive. On stop() every registered connector is closed.
  // Events flow onto the core bus via createConnectorEventSink.
  registerConnector(connector: Connector): void
  unregisterConnector(connectorId: string): boolean
  connectors(): ReadonlyArray<Connector>
  send(connectorId: string, message: ConnectorMessage): Promise<SendResult>
  /**
   * Bridge a registered connector's inbound messages onto the core event bus as
   * `connector:message` (opt-in for imperative connectors; declared connectors
   * are bridged automatically at start). Without `channel`, all channels flow.
   */
  bridgeConnector(connectorId: string, channel?: string): void
  // FR-02: framework-level health collection. Plugins may push a status via
  // context.health.report, or expose a pull source via provide() that pollHealth
  // refreshes. A plugin that never reports produces no entry.
  health(): ReadonlyMap<string, HealthSnapshot>
  healthOf(pluginId: string): HealthSnapshot | undefined
  pollHealth(): Promise<ReadonlyMap<string, HealthSnapshot>>
  // G-05: per-capability call metrics (invocations / latency / error rates),
  // aggregated at the broker funnel and exported as a JSON-serializable
  // snapshot. Always-on in-memory accounting; reading is the product's choice.
  metrics(): MetricsSnapshot
  // G4: live cross-host peer directory (empty unless remoteNodes is configured).
  nodes(): readonly RemoteNode[]
  // BR-02: unified discovery across plugins, capabilities and connectors (plus
  // any caller-injected sources). Each underlying registry keeps its own
  // specialized methods; this is a read-only aggregate view.
  discover(query?: DiscoveryQuery): FuxResource[]
  // AR-04: UI skeleton registry. Additive — the built-in skeleton is active by
  // default, so a product that never registers a custom skeleton behaves exactly
  // as before. registerSkeleton selects the value as active; activate switches.
  registerSkeleton(skeleton: Skeleton): void
  activateSkeleton(id: string): void
  unregisterSkeleton(id: string): void
  activeSkeleton(): Skeleton
  describeActiveSkeleton(): SkeletonDefinition | Promise<SkeletonDefinition>
  skeletons(): ReadonlyArray<Skeleton>
  // ER-01: theme provider. Same additive charter — the built-in skin is active
  // by default, so an un-themed product keeps current appearance. registerSkin
  // selects the value as active; activate switches.
  registerSkin(skin: Skin): void
  activateSkin(id: string): void
  unregisterSkin(id: string): void
  activeSkin(): Skin
  describeActiveSkin(): SkinDefinition | Promise<SkinDefinition>
  skins(): ReadonlyArray<Skin>
  // ER-02: skin/skeleton pluginization protocol. Register a ThemePack (a
  // combined skeleton + skin, either optional) then switch the whole look in
  // one step. The built-in `default` theme is active by default, so a product
  // that never registers a pack is unchanged.
  registerTheme(pack: ThemePack): void
  activateTheme(id: string): void
  unregisterTheme(id: string): void
  activeThemeId(): string
  themes(): ReadonlyArray<ThemePack>
  // FR-01: unified event + log channels. Both expose optional persistence (via
  // the supervisor options), are pure bypasses of the underlying bus / logger,
  // and never affect existing dispatch/console behaviour.
  channel(): EventChannel
  logChannel(): LogChannel
}

export class Supervisor {
  private readonly events: EventBus
  private readonly logger: Logger
  private readonly options: SupervisorOptions

  constructor(events: EventBus, options: SupervisorOptions = {}) {
    this.events = events
    this.logger = options.logger ?? noopLogger
    this.options = options
  }

  async start(graph: RuntimeGraph, resolveModule: ModuleResolver): Promise<StartedRuntime> {
    const lifecycle = new LifecycleManager()
    const hosts = new Map<string, PluginHost>()
    // G-05: one metrics registry per start, fed by the broker funnel (every
    // call path — direct, scheduled, connector-served, host-routed — goes
    // through it). Purely additive: nothing reads it unless the product does.
    const metrics = new MetricsRegistry()
    const broker = new CapabilityBroker(graph, hosts, { metrics })
    // FR-02: one health collector per start; hosts report into it and the
    // StartedRuntime exposes it. Inert until a plugin reports or provides.
    const health = new HealthRegistry()
    // AR-04: one UI skeleton registry per start. The built-in skeleton is its
    // initial active value, so a product that never registers a custom skeleton
    // is unchanged. No runtime dependency on any renderer.
    const uiSkeletons = new SkeletonRegistry()
    // ER-01: one theme provider per start. The built-in skin is its initial
    // active value, so an un-themed product keeps current appearance. No runtime
    // dependency on any renderer or token resolver.
    const uiTheme = new ThemeProvider()
    // ER-02: one theme coordinator per start, driving both the skeleton and
    // skin registries behind a single register/switch protocol. Built-in
    // `default` theme is active until a product registers a pack.
    const uiTheming = new ThemeRegistry(uiSkeletons, uiTheme)
    // FR-01: unified channels. The event channel wraps the core bus with an
    // optional persistence sink; the log channel wraps the runtime logger with
    // an optional log sink. Both are pure bypasses — absent a sink they behave
    // exactly like the bus / logger the runtime already used.
    const channel = createChannel(this.events, {
      persistence: this.options.persistence?.events,
    })
    const logChannel = createLogChannel(this.logger, this.options.persistence?.logs)
    const started: string[] = []
    const runtimeManifests = new Map<string, PluginManifest>(
      [...graph.plugins].map(([id, node]) => [id, node.manifest]),
    )
    let stopped = false

    // CR-03 wiring: an optional scheduling queue. An injected TaskScheduler keeps
    // caller ownership (the runtime never closes it); a SchedulerSetup is built
    // into a runtime-owned queue that is drained/closed on stop and is never
    // accepted for schedule() after stop.
    const schedulerInput = this.options.scheduler
    const injectedScheduler =
      schedulerInput instanceof TaskScheduler
        ? (schedulerInput as TaskScheduler<unknown>)
        : undefined
    let runtimeScheduler: TaskScheduler<unknown> | undefined
    if (schedulerInput && !injectedScheduler) {
      runtimeScheduler = new TaskScheduler<unknown>(schedulerInput as SchedulerSetup)
    }
    const activeScheduler: TaskScheduler<unknown> | undefined =
      injectedScheduler ?? runtimeScheduler
    let nextTaskSeq = 0

    // CR-04 wiring: a runtime-owned connector registry that replays connector
    // lifecycle/message events onto the core event bus. It is created up front
    // but stays inert (and the bus untouched) until a connector is registered.
    const connectors = new ConnectorRegistry({ eventSink: createConnectorEventSink(this.events) })

    const connectorDiscovery = connectors.asDiscoverable()
    const runtimeDiscoverySources: Discoverable[] = [
      // BR-02: plugin and capability views are derived from the live manifest /
      // lifecycle snapshot; the connector view comes from the registry.
      {
        discover: () =>
          [...runtimeManifests.keys()].map((pluginId): FuxResource => {
            const manifest = runtimeManifests.get(pluginId)!
            return {
              kind: 'plugin',
              id: pluginId,
              status: lifecycle.get(pluginId),
              entry: manifest.executionMode,
              metadata: { name: manifest.name, version: manifest.version },
            }
          }),
      },
      {
        discover: () => {
          const out: FuxResource[] = []
          for (const [pluginId, manifest] of runtimeManifests) {
            const status = lifecycle.get(pluginId)
            for (const capability of manifest.capabilities) {
              out.push({
                kind: 'capability',
                id: capability.name,
                status,
                entry: pluginId,
                metadata: { version: capability.version },
              })
            }
          }
          return out
        },
      },
      connectorDiscovery,
    ]
    const discovery = new RuntimeDiscovery(runtimeDiscoverySources)
    for (const source of this.options.discovery ?? []) discovery.add(source)

    // G4: opt-in cross-host node discovery + health handshake. The registry is
    // created only when configured, folded into the unified discovery view and
    // closed on stop. A seed that is temporarily unreachable never fails product
    // start — the registry keeps watching and retries it on the poll interval.
    let remoteNodes: RemoteNodeRegistry | undefined
    const remoteOpt = this.options.remoteNodes
    if (remoteOpt) {
      remoteNodes = new RemoteNodeRegistry({
        probe: remoteOpt.probe ?? new HttpNodeHealthProbe(),
        intervalMs: remoteOpt.intervalMs,
        staleAfterMs: remoteOpt.staleAfterMs,
      })
      discovery.add(remoteNodes)
      remoteNodes.start()
      for (const url of remoteOpt.urls ?? []) {
        remoteNodes.register(url).catch((error) => {
          this.logger.warn('remote node seed registration failed', {
            url,
            error: error instanceof Error ? error.message : String(error),
          })
        })
      }
    }

    const bindConnector = (connector: Connector): void => {
      connectors.register(connector)
      this.logger.info('connector registered', {
        connectorId: connector.id,
        kind: connector.kind,
      })
    }

    const resolveDeclaredConnectors = async (): Promise<void> => {
      for (const defn of graph.connectors) {
        const resolver = this.options.connectorResolver
        if (!resolver) throw new ConnectorResolverMissingError(defn.id)
        let connector: Connector
        try {
          connector = await resolver(defn.id)
        } catch (error) {
          throw new ConnectorStartError(defn.id, error)
        }
        try {
          bindConnector(connector)
          // Declared connectors are part of the product bring-up, so they are
          // opened alongside the plugin raster (idempotent for an already-open
          // connector). Imperative registerConnector() leaves lifecycle to the
          // caller; stop() closes every registered connector regardless.
          await connector.open()
          bridgeDeclared(defn)
          serveConnectorRequests(defn, connector)
        } catch (error) {
          throw new ConnectorStartError(defn.id, error)
        }
        this.logger.debug('connector resolved from product', {
          connectorId: defn.id,
          kind: defn.kind ?? connector.kind,
        })
      }
    }

    // CR-04: a declared connector carries its inbound message flow onto the core
    // event bus (as `connector:message`) by default, so subscribers see product
    // traffic without touching the registry. The declaration may narrow this:
    // `config.bridge: false` disables bridging entirely; `config.channels: [...]`
    // bridges only those channels. Both stay out of the declared default (all
    // channels bridged).
    const bridgeDeclared = (defn: ConnectorDefinition): void => {
      const config = defn.config ?? {}
      if (config.bridge === false) {
        this.logger.debug('connector message bridge disabled by config', {
          connectorId: defn.id,
        })
        return
      }
      const channels = Array.isArray(config.channels)
        ? config.channels.filter((c): c is string => typeof c === 'string')
        : undefined
      if (channels && channels.length === 0) {
        this.logger.debug('connector message bridge skipped (empty channel filter)', {
          connectorId: defn.id,
        })
        return
      }
      if (channels) {
        for (const channel of channels) connectors.bridgeMessages(defn.id, channel)
      } else {
        connectors.bridgeMessages(defn.id)
      }
      this.logger.debug('connector message bridge attached', {
        connectorId: defn.id,
        channels: channels ?? '*',
      })
    }

    // CR-04 (request_reply): a declared connector may *serve* a capability. When
    // `config.serve` names a capability, every inbound message on the request
    // channel is routed to it (as the framework/system caller) and the result is
    // written back on the reply channel. Requests and replies must live on
    // distinct channels, otherwise an in-process loopback transport would
    // re-deliver a reply to the same subscription and recurse. The envelope on
    // the reply is a `ConnectorReply`; the request's `id` is the correlation id.
    const serveConnectorRequests = (defn: ConnectorDefinition, connector: Connector): void => {
      const target = defn.config?.serve
      if (typeof target !== 'string' || target.length === 0) return
      const requestChannel = defn.config?.channel
      if (typeof requestChannel !== 'string' || requestChannel.length === 0) {
        throw new ConnectorStartError(defn.id, new Error('config.serve requires config.channel'))
      }
      const replyChannel =
        typeof defn.config?.replyChannel === 'string' && defn.config.replyChannel.length > 0
          ? defn.config.replyChannel
          : `${requestChannel}.reply`
      this.logger.info('connector serving capability requests', {
        connectorId: defn.id,
        target,
        requestChannel,
        replyChannel,
      })
      connector.subscribe(requestChannel, (message) => {
        void dispatchRequest(defn.id, connector, message, target, replyChannel)
      })
    }

    const dispatchRequest = async (
      connectorId: string,
      connector: Connector,
      message: ConnectorMessage,
      target: string,
      replyChannel: string,
    ): Promise<void> => {
      let res: SendResult
      try {
        const value = await broker.call(SYSTEM_CALLER, target, message.payload)
        res = await connector.send({
          id: message.id,
          channel: replyChannel,
          payload: { ok: true, value },
        })
      } catch (error) {
        res = await connector.send({
          id: message.id,
          channel: replyChannel,
          payload: { ok: false, error: String(error) },
        })
      }
      if (!res.ok) {
        this.logger.warn('connector reply delivery failed', { connectorId, id: message.id })
      }
    }

    const queueInfo = (): QueueInfo | undefined => {
      if (!activeScheduler) return undefined
      return { owned: !injectedScheduler, stats: activeScheduler.stats }
    }

    const schedule = async <T>(
      callerId: string,
      capability: string,
      payload?: unknown,
      options?: ScheduledCallOptions,
    ): Promise<T> => {
      if (!activeScheduler) return broker.call<T>(callerId, capability, payload)
      const taskId = options?.taskId ?? `call:${callerId}:${capability}:${++nextTaskSeq}`
      // async keeps a synchronous scheduler rejection (e.g. duplicate taskId) on
      // the returned promise, matching call()'s never-throw contract.
      return activeScheduler.submit({
        id: taskId,
        priority: options?.priority,
        group: options?.group,
        // The scheduler is untyped (T = unknown); the caller's T is applied here.
        run: () => broker.call<T>(callerId, capability, payload),
      }) as Promise<T>
    }

    const drainQueue = async (): Promise<void> => {
      if (!activeScheduler) return
      await activeScheduler.drain()
    }

    for (const pluginId of graph.order) {
      const node = graph.plugins.get(pluginId)
      if (!node) throw new PluginStartError(pluginId, 'missing graph node')
      if (!isProtocolCompatible(node.manifest.protocol)) {
        throw new ProtocolIncompatibleError(pluginId, node.manifest.protocol, FUX_PROTOCOL_VERSION)
      }
    }

    const hostDeps: PluginHostDeps = {
      broker,
      events: this.events,
      health,
      // G1 强化: a host that dies unexpectedly (worker exit, remote disconnect)
      // reports it here so runtime state stays truthful — the plugin is marked
      // 'broken' instead of falsely 'started'. Only a running plugin transitions;
      // teardown via stop() is unaffected.
      onHostExit: (pluginId, reason) => {
        if (lifecycle.get(pluginId) === 'started') {
          lifecycle.transition(pluginId, 'broken')
          this.logger.warn('plugin host exited unexpectedly', {
            pluginId,
            reason: reason instanceof Error ? reason.message : String(reason),
          })
        }
      },
    }

    const hostFor = (manifest: PluginManifest, config: Record<string, unknown>): PluginHost => {
      // PRD: a caller-provided host factory wins. Returning `undefined` means the
      // factory does not claim this plugin — fall through to the built-in mode.
      const resolved = this.options.hostFactory?.(manifest, config, hostDeps)
      if (resolved) return resolved
      if (manifest.executionMode === 'in_process') {
        return new InProcessHost(manifest, config, () => resolveModule(manifest.id), hostDeps)
      }
      throw new UnsupportedExecutionModeError(manifest.id, manifest.executionMode)
    }

    const stopStarted = async (): Promise<void> => {
      if (stopped) return
      stopped = true
      for (const pluginId of [...started].reverse()) {
        // A plugin may already be stopped via stopPlugin(); skip the transition.
        if (lifecycle.get(pluginId) !== 'started') continue
        const host = hosts.get(pluginId)
        lifecycle.transition(pluginId, 'stopping')
        try {
          await host?.stop()
        } catch (error) {
          this.logger.warn('plugin stop failed during rollback', { pluginId, error: String(error) })
        } finally {
          lifecycle.transition(pluginId, 'stopped')
        }
      }
      hosts.clear()
      // Drain the runtime-owned queue so in-flight scheduled calls settle; an
      // injected scheduler is the caller's to manage and is never closed here.
      if (runtimeScheduler && !injectedScheduler) {
        await runtimeScheduler.close()
      }
      // Close every connector the runtime registered (declared + imperative).
      // Registered connector closes surface as connector:close events on the bus.
      await connectors.closeAll()
      // G4: release the peer directory probe + poll timer if one was created.
      if (remoteNodes) await remoteNodes.close()
    }

    for (const pluginId of graph.order) {
      const node = graph.plugins.get(pluginId)
      if (!node) throw new PluginStartError(pluginId, 'missing graph node')
      const { manifest, config } = node

      const host = hostFor(manifest, config)
      lifecycle.init(pluginId)
      hosts.set(pluginId, host)
      lifecycle.transition(pluginId, 'starting')
      try {
        await host.start()
        lifecycle.transition(pluginId, 'started')
        started.push(pluginId)
        this.logger.debug('plugin started', { pluginId })
      } catch (error) {
        lifecycle.transition(pluginId, 'broken')
        await stopStarted()
        throw new PluginStartError(pluginId, error)
      }
    }

    // Resolve product-declared connectors after the plugin raster is up, so a
    // connector cannot start before its provider plugins exist.
    await resolveDeclaredConnectors()

    const registerPlugin = async (
      input: unknown,
      options: { config?: Record<string, unknown> } = {},
    ): Promise<void> => {
      const manifest = parseManifest(input)
      if (!isProtocolCompatible(manifest.protocol)) {
        throw new ProtocolIncompatibleError(manifest.id, manifest.protocol, FUX_PROTOCOL_VERSION)
      }
      if (hosts.has(manifest.id)) {
        throw new DuplicatePluginRuntimeError(manifest.id)
      }
      // Resolve the host first so an unsupported mode never mutates the broker.
      const host = hostFor(manifest, options.config ?? {})
      const bound: string[] = []
      try {
        for (const capability of manifest.capabilities) {
          broker.bindProvider(capability.name, manifest.id, manifest.executionMode)
          bound.push(capability.name)
        }
      } catch (error) {
        for (const name of bound) broker.removeProvider(name, manifest.id)
        throw error
      }
      hosts.set(manifest.id, host)
      runtimeManifests.set(manifest.id, manifest)
      broker.addCaller(manifest)
      lifecycle.init(manifest.id)
      this.logger.info('plugin registered at runtime', { pluginId: manifest.id })
    }

    const startPlugin = async (pluginId: string): Promise<void> => {
      const host = hosts.get(pluginId)
      if (!host) throw new PluginNotStartedError(pluginId)
      if (lifecycle.get(pluginId) === 'started') return
      lifecycle.transition(pluginId, 'starting')
      try {
        await host.start()
        lifecycle.transition(pluginId, 'started')
        started.push(pluginId)
        this.logger.debug('plugin started at runtime', { pluginId })
      } catch (error) {
        lifecycle.transition(pluginId, 'broken')
        throw new PluginStartError(pluginId, error)
      }
    }

    const stopPlugin = async (pluginId: string): Promise<void> => {
      const host = hosts.get(pluginId)
      if (!host) throw new PluginNotStartedError(pluginId)
      if (lifecycle.get(pluginId) !== 'started') return
      lifecycle.transition(pluginId, 'stopping')
      try {
        await host.stop()
        lifecycle.transition(pluginId, 'stopped')
      } catch (error) {
        lifecycle.transition(pluginId, 'broken')
        throw error
      }
    }

    const unregisterPlugin = async (pluginId: string): Promise<void> => {
      const host = hosts.get(pluginId)
      if (!host) throw new PluginNotStartedError(pluginId)
      if (lifecycle.get(pluginId) === 'started') {
        await stopPlugin(pluginId)
      }
      const manifest = runtimeManifests.get(pluginId)
      if (manifest) {
        for (const capability of manifest.capabilities) {
          broker.removeProvider(capability.name, pluginId)
        }
      }
      broker.removeCaller(pluginId)
      hosts.delete(pluginId)
      runtimeManifests.delete(pluginId)
      lifecycle.reset(pluginId)
      health.clear(pluginId)
      this.logger.info('plugin unregistered', { pluginId })
    }

    return {
      graph,
      call: (callerId, capability, payload, options) =>
        broker.call(callerId, capability, payload, options),
      callAsSystem: (capability, payload, options) =>
        broker.call(SYSTEM_CALLER, capability, payload, options),
      states: () => lifecycle.snapshot(),
      stop: stopStarted,
      registerPlugin,
      startPlugin,
      stopPlugin,
      unregisterPlugin,
      schedule,
      scheduleAsSystem: <T>(
        capability: string,
        payload?: unknown,
        options?: ScheduledCallOptions,
      ) => schedule<T>(SYSTEM_CALLER, capability, payload, options),
      queueInfo,
      drainQueue,
      registerConnector: (connector) => bindConnector(connector),
      unregisterConnector: (connectorId) => connectors.unregister(connectorId),
      connectors: () => connectors.list(),
      send: (connectorId, message) => connectors.send(connectorId, message),
      bridgeConnector: (connectorId, channel) => connectors.bridgeMessages(connectorId, channel),
      health: () => health.snapshot(),
      healthOf: (pluginId) => health.healthOf(pluginId),
      pollHealth: () => health.poll(),
      metrics: () => metrics.snapshot(),
      nodes: () => remoteNodes?.snapshot ?? [],
      discover: (query) => discovery.discover(query),
      registerSkeleton: (skeleton) => uiSkeletons.registerSkeleton(skeleton),
      activateSkeleton: (id) => uiSkeletons.activate(id),
      unregisterSkeleton: (id) => uiSkeletons.unregisterSkeleton(id),
      activeSkeleton: () => uiSkeletons.active(),
      describeActiveSkeleton: () => uiSkeletons.active().describe(),
      skeletons: () => uiSkeletons.skeletons(),
      registerSkin: (skin) => uiTheme.registerSkin(skin),
      activateSkin: (id) => uiTheme.activate(id),
      unregisterSkin: (id) => uiTheme.unregisterSkin(id),
      activeSkin: () => uiTheme.active(),
      describeActiveSkin: () => uiTheme.active().describe(),
      skins: () => uiTheme.skins(),
      registerTheme: (pack) => uiTheming.registerTheme(pack),
      activateTheme: (id) => uiTheming.activateTheme(id),
      unregisterTheme: (id) => uiTheming.unregisterTheme(id),
      activeThemeId: () => uiTheming.activeThemeId(),
      themes: () => uiTheming.themes(),
      channel: () => channel,
      logChannel: () => logChannel,
    }
  }
}

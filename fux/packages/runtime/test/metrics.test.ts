import { describe, expect, it } from 'vitest'
import { FuxCore } from '@fux/core'
import type { RuntimeGraph } from '@fux/core'
import { Supervisor } from '../src/supervisor.js'
import { CapabilityBroker } from '../src/broker.js'
import { MetricsRegistry } from '../src/metrics.js'
import { CapabilityDeniedError, CapabilityNotFoundRuntimeError } from '../src/errors.js'
import type { FuxPluginModule, PluginContext, PluginHost } from '../src/types.js'

const greeterManifest = {
  id: '@fux/example-greeter',
  name: 'Greeter',
  version: '0.0.1',
  protocol: '^0.1.0',
  executionMode: 'in_process',
  capabilities: [{ name: 'greeting:hello', version: '0.0.1' }],
  configSchema: {
    type: 'object',
    properties: { greeting: { type: 'string', default: 'Hello' } },
  },
}

const appManifest = {
  id: '@fux/example-app',
  name: 'App',
  version: '0.0.1',
  protocol: '^0.1.0',
  executionMode: 'in_process',
  consumes: ['greeting:hello'],
  capabilities: [{ name: 'app:run', version: '0.0.1' }],
}

function greeterModule(): FuxPluginModule {
  return {
    activate(ctx: PluginContext) {
      ctx.provide('greeting:hello', (payload) => {
        const who = (payload as { who?: string } | undefined)?.who ?? 'FUX'
        return `Hello, ${who}!`
      })
    },
  }
}

function appModule(): FuxPluginModule {
  return {
    activate(ctx: PluginContext) {
      ctx.provide('app:run', () => 'app ran')
    },
  }
}

function setup() {
  const core = new FuxCore()
  core.register(greeterManifest)
  core.register(appManifest)
  const { graph } = core.compose({
    id: 'demo-hello',
    name: 'Demo Hello',
    version: '0.0.1',
    profile: 'dev',
    plugins: [{ id: '@fux/example-app' }, { id: '@fux/example-greeter' }],
  })
  const supervisor = new Supervisor(core.events)
  const resolver = (pluginId: string) => {
    if (pluginId === '@fux/example-greeter') return greeterModule()
    if (pluginId === '@fux/example-app') return appModule()
    throw new Error(`no module for ${pluginId}`)
  }
  return { graph, supervisor, resolver }
}

describe('MetricsRegistry (unit)', () => {
  it('aggregates invocations, latency and error classification per capability', () => {
    const registry = new MetricsRegistry()
    registry.record({ capability: 'a:x', ok: true, retryable: false, durationMs: 5 })
    registry.record({ capability: 'a:x', ok: true, retryable: false, durationMs: 15 })
    registry.record({ capability: 'a:x', ok: false, retryable: true, durationMs: 30, error: new Error('boom') })
    registry.record({ capability: 'b:y', ok: true, retryable: false, durationMs: 1 })

    const snapshot = registry.snapshot()
    expect(snapshot.map((m) => m.capability)).toEqual(['a:x', 'b:y'])
    const a = snapshot[0]!
    expect(a.invocations).toBe(3)
    expect(a.errors).toBe(1)
    expect(a.retryableErrors).toBe(1)
    expect(a.totalDurationMs).toBe(50)
    expect(a.minDurationMs).toBe(5)
    expect(a.maxDurationMs).toBe(30)
    expect(a.lastDurationMs).toBe(30)
    expect(a.lastError?.code).toBe('Error')
    expect(a.lastError?.message).toBe('boom')
    expect(typeof a.lastError?.at).toBe('number')

    expect(registry.of('a:x')?.invocations).toBe(3)
    expect(registry.of('missing')).toBeUndefined()
  })

  it('reports the wire code for IPC failures instead of the wrapper code', () => {
    const registry = new MetricsRegistry()
    registry.record({
      capability: 'a:x',
      ok: false,
      retryable: true,
      durationMs: 10,
      error: Object.assign(new Error('E_TIMEOUT: peer silent'), { name: 'IpcInvocationError' }),
    })
    // non-IpcInvocationError falls back to error.name
    expect(registry.of('a:x')?.lastError?.code).toBe('IpcInvocationError')
  })

  it('resets to an empty snapshot', () => {
    const registry = new MetricsRegistry()
    registry.record({ capability: 'a:x', ok: true, retryable: false, durationMs: 5 })
    expect(registry.snapshot()).toHaveLength(1)
    registry.reset()
    expect(registry.snapshot()).toEqual([])
  })

  it('clamps negative durations into the accounting domain', () => {
    const registry = new MetricsRegistry()
    registry.record({ capability: 'a:x', ok: true, retryable: false, durationMs: -7 })
    expect(registry.of('a:x')?.totalDurationMs).toBe(0)
    expect(registry.of('a:x')?.minDurationMs).toBe(0)
  })
})

describe('CapabilityBroker metrics wiring (G-05)', () => {
  it('counts a retried call as exactly one settled invocation', async () => {
    const registry = new MetricsRegistry()
    const graph = {
      plugins: new Map([
        ['@fux/p', { manifest: greeterManifest, config: {} }],
      ]),
      capabilities: new Map([['greeting:hello', { providerId: '@fux/p', executionMode: 'in_process' }]]),
    } as unknown as RuntimeGraph
    let failOnce = true
    let alwaysFail = false
    const host: PluginHost = {
      pluginId: '@fux/p',
      mode: 'in_process',
      start: async () => {},
      stop: async () => {},
      providedCapabilities: () => ['greeting:hello'],
      invoke: async () => {
        if (alwaysFail || failOnce) {
          failOnce = false
          return { id: 'r1', ok: false, error: { code: 'E_TIMEOUT', message: 'silent peer', retryable: true } }
        }
        return { id: 'r2', ok: true, result: 'hello' }
      },
    }
    const broker = new CapabilityBroker(graph, new Map([['@fux/p', host]]), { metrics: registry })

    await expect(
      broker.call('system', 'greeting:hello', undefined, { retry: { maxRetries: 2, baseDelayMs: 1, jitter: false } }),
    ).resolves.toBe('hello')
    // one broker.call (with its internal retries) = one invocation
    expect(registry.of('greeting:hello')).toMatchObject({ invocations: 1, errors: 0 })

    // an exhausted retryable failure lands as one invocation + one retryable error
    alwaysFail = true
    await expect(
      broker.call('system', 'greeting:hello', undefined, { retry: { maxRetries: 0 } }),
    ).rejects.toThrow()
    const metrics = registry.of('greeting:hello')
    expect(metrics).toMatchObject({ invocations: 2, errors: 1, retryableErrors: 1 })
    expect(metrics?.lastError?.code).toBe('E_TIMEOUT')
  })
})

describe('StartedRuntime.metrics (G-05 end-to-end)', () => {
  it('records direct, system, denied and unknown-capability calls', async () => {
    const { graph, supervisor, resolver } = setup()
    const runtime = await supervisor.start(graph, resolver)
    try {
      await runtime.callAsSystem('app:run')
      await runtime.callAsSystem('greeting:hello', { who: 'Metrics' })
      await expect(runtime.call('@fux/example-app', 'greeting:hello', { who: 'X' })).resolves.toBe('Hello, X!')
      await expect(runtime.callAsSystem('nope:missing')).rejects.toBeInstanceOf(CapabilityNotFoundRuntimeError)
      await expect(runtime.call('@fux/example-greeter', 'greeting:hello')).rejects.toBeInstanceOf(
        CapabilityDeniedError,
      )

      const snapshot = runtime.metrics()
      const byName = new Map(snapshot.map((m) => [m.capability, m]))
      expect(byName.get('app:run')?.invocations).toBe(1)
      expect(byName.get('greeting:hello')?.invocations).toBe(3)
      expect(byName.get('greeting:hello')?.errors).toBe(1)
      expect(byName.get('greeting:hello')?.lastError?.code).toBe('E_CAPABILITY_DENIED')
      expect(byName.get('nope:missing')?.errors).toBe(1)
      expect(byName.get('nope:missing')?.lastError?.code).toBe('E_CAPABILITY_NOT_FOUND')
      // JSON-exportable
      expect(JSON.parse(JSON.stringify(snapshot))).toHaveLength(snapshot.length)
    } finally {
      await runtime.stop()
    }
  })

  it('records scheduled calls through the same funnel', async () => {
    const { graph, supervisor, resolver } = setup()
    const runtime = await supervisor.start(graph, resolver)
    try {
      await runtime.scheduleAsSystem('app:run')
      expect(runtime.metrics().find((m) => m.capability === 'app:run')?.invocations).toBe(1)
    } finally {
      await runtime.stop()
    }
  })
})

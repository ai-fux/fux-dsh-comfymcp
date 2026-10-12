import { describe, expect, it } from 'vitest'
import type { PluginManifest } from '@fux/protocol'
import { EventBus, type RuntimeGraph } from '@fux/core'
import { SandboxRuntime } from '../src/sandbox-runtime.js'
import { SandboxExecutionError, SandboxTimeoutError, SandboxViolationError } from '../src/errors.js'
import { CapabilityBroker } from '../src/broker.js'
import { createExecutionHostFactory } from '../src/execution-hosts.js'
import { SandboxHost } from '../src/sandbox-host.js'
import type { SandboxApi, SandboxValue } from '../src/sandbox-runtime.js'
import type { PluginHost } from '../src/types.js'

function api(overrides: Partial<SandboxApi> = {}): SandboxApi {
  return {
    call: <T = unknown>(_capability: string, _payload?: SandboxValue) =>
      Promise.resolve('unused' as T),
    emit: () => undefined,
    config: { n: 1 },
    ...overrides,
  }
}

describe('SandboxRuntime · compile & invoke (G3)', () => {
  it('compiles a function source, runs it and returns a JSON-cloned value', async () => {
    const runtime = new SandboxRuntime()
    const script = runtime.load('(payload, a) => a.config.n + payload.n', api())
    const result = await script.run({ n: 41 })
    script.dispose()
    expect(result).toBe(42)
  })

  it('returns a plain host-realm value, not a vm-realm object', async () => {
    const runtime = new SandboxRuntime()
    const script = runtime.load('(payload) => ({ x: payload.x, list: [1, 2] })', api())
    const result = (await script.run({ x: 1 })) as { x: number }
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
    expect(result).toEqual({ x: 1, list: [1, 2] })
  })

  it('rejects source that does not evaluate to a function (violation)', async () => {
    const runtime = new SandboxRuntime()
    expect(() => runtime.load('42', api())).toThrow(SandboxViolationError)
    expect(() => runtime.load('(payload) => (1 + 1)', api())).not.toThrow()
  })

  it('rejects syntactically invalid source at load', async () => {
    const runtime = new SandboxRuntime()
    expect(() => runtime.load('(payload => {', api())).toThrow(SandboxViolationError)
  })

  it('rejects a non-JSON-safe return value (violation)', async () => {
    const runtime = new SandboxRuntime()
    const script = runtime.load('() => () => 1', api())
    await expect(script.run(undefined)).rejects.toThrow(SandboxViolationError)
  })

  it('rejects non-finite numbers and bare undefined at the boundary', async () => {
    const runtime = new SandboxRuntime()
    await expect(runtime.load('() => NaN', api()).run(undefined)).rejects.toThrow(
      SandboxViolationError,
    )
    await expect(runtime.load('() => ({ a: undefined })', api()).run(undefined)).rejects.toThrow(
      SandboxViolationError,
    )
  })

  it('surfaces an application error thrown inside the handler as SandboxExecutionError', async () => {
    const runtime = new SandboxRuntime()
    const script = runtime.load('() => { throw new Error("kaboom") }', api())
    await expect(script.run(undefined)).rejects.toThrow(SandboxExecutionError)
  })

  it('blocks ambient globals: process / require are absent from the context', async () => {
    const runtime = new SandboxRuntime()
    // Accessing a missing global throws inside the vm -> app error (not a leak).
    const blocked1 = runtime.load('(payload, a) => a.call("x").then(() => process.env)', api())
    await expect(blocked1.run(undefined)).rejects.toThrow(SandboxExecutionError)
    const blocked2 = runtime.load('() => require("fs")', api())
    await expect(blocked2.run(undefined)).rejects.toThrow(SandboxExecutionError)
  })

  it('enforces the invocation timeout (retryable SandboxTimeoutError)', async () => {
    const runtime = new SandboxRuntime({ timeoutMs: 20 })
    // Async handler that never settles; the cooperative race wins with a timeout.
    const script = runtime.load('() => new Promise(() => {})', api())
    const start = Date.now()
    await expect(script.run(undefined)).rejects.toBeInstanceOf(SandboxTimeoutError)
    expect(Date.now() - start).toBeLessThan(2000)
  })

  it('is state-isolated across two loaded scripts', async () => {
    const runtime = new SandboxRuntime()
    const s1 = runtime.load('() => ({ counter: 0 })', api())
    const s2 = runtime.load('() => ({ counter: 0 })', api())
    const r1 = await s1.run(undefined)
    await s2.run(undefined)
    // Mutating one result must not affect the other's fresh copy.
    ;(r1 as { counter: number }).counter = 99
    const r2b = await s2.run(undefined)
    expect((r2b as { counter: number }).counter).toBe(0)
  })
})

function sandboxManifest(): PluginManifest {
  return {
    id: '@fux/sbx',
    name: 'SandboxSafe',
    version: '0.0.1',
    protocol: '^0.1.0',
    executionMode: 'in_process',
    capabilities: [{ name: 'alpha:echo', version: '1.0.0' }],
    consumes: ['beta:work'],
    dependencies: [],
  }
}

const echoSource = '(payload) => ({ echo: payload })'

function makeHost(
  handlers: Record<string, string> = { 'alpha:echo': echoSource },
  timeoutMs?: number,
): SandboxHost {
  return new SandboxHost(sandboxManifest(), { magic: 7 }, { broker, events, handlers, timeoutMs })
}

const events = new EventBus()
// A provider plugin whose handler resolves `beta:work` for the api.call test.
const providerHost: PluginHost = {
  pluginId: '@fux/prov',
  mode: 'in_process',
  start: async () => undefined,
  stop: async () => undefined,
  invoke: async (capability) => ({ ok: true, id: 'x', result: `forwarded:${capability}` }),
  providedCapabilities: () => ['beta:work'],
}
const graph: RuntimeGraph = {
  productId: 'p',
  productName: 'p',
  productVersion: '0.0.1',
  profile: 'dev',
  builtAt: Date.now(),
  protocolVersion: '0.1.0',
  order: ['@fux/prov', '@fux/sbx'],
  plugins: new Map([
    ['@fux/prov', { manifest: { ...sandboxManifest() }, config: {} }],
    ['@fux/sbx', { manifest: sandboxManifest(), config: {} }],
  ]),
  capabilities: new Map([['beta:work', { providerId: '@fux/prov', executionMode: 'in_process' }]]),
  connectors: [],
}
function fakeGraph(): RuntimeGraph {
  return graph
}
const broker = new CapabilityBroker(fakeGraph(), new Map([['@fux/prov', providerHost]]))

describe('SandboxHost · lifecycle & invoke (G3)', () => {
  it('starts, compiles each handler into its own context and exposes capabilities', async () => {
    const host = makeHost()
    await host.start()
    expect(host.status()).toBe('started')
    expect(host.mode).toBe('in_process')
    expect(host.providedCapabilities()).toEqual(['alpha:echo'])
    const res = (await host.invoke('alpha:echo', { n: 1 })) as { ok: true; result?: unknown }
    expect(res.ok).toBe(true)
    expect(res.result).toEqual({ echo: { n: 1 } })
    await host.stop()
    expect(host.status()).toBe('stopped')
  })

  it('rejects a start for a handler not declared in the manifest', async () => {
    const host = makeHost({ 'unknown:cap': '(payload) => payload' })
    await expect(host.start()).rejects.toThrow(/not declared/)
  })

  it('fails invokes before start without hanging (retryable crash)', async () => {
    const host = makeHost()
    const res = (await host.invoke('alpha:echo')) as { ok: false; error: { code: string } }
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe('E_PLUGIN_CRASHED')
  })

  it('returns E_CAPABILITY_NOT_FOUND for an undeclared-but-provided capability call', async () => {
    const host = makeHost()
    await host.start()
    const res = (await host.invoke('other:cap')) as { ok: false; error: { code: string } }
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe('E_CAPABILITY_NOT_FOUND')
  })

  it('maps a handler app-error to a failed E_PLUGIN_ERROR reply, not a throw', async () => {
    const host = makeHost({ 'alpha:echo': '() => { throw new Error("boom") }' })
    await host.start()
    const res = (await host.invoke('alpha:echo')) as { ok: false; error: { message: string } }
    expect(res.ok).toBe(false)
    expect(res.error.message).toContain('boom')
  })

  it('maps a sandbox timeout to a retryable E_TIMEOUT reply', async () => {
    const host = makeHost({ 'alpha:echo': '() => new Promise(() => {})' }, 20)
    await host.start()
    const res = (await host.invoke('alpha:echo')) as {
      ok: false
      error: { code: string; retryable: boolean }
    }
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe('E_TIMEOUT')
    expect(res.error.retryable).toBe(true)
  })

  it('lets a sandboxed handler call another capability through the broker', async () => {
    const host = makeHost({
      'alpha:echo': '(payload, a) => a.call("beta:work", { q: 1 })',
    })
    await host.start()
    const res = (await host.invoke('alpha:echo')) as { ok: true; result?: unknown }
    expect(res.ok).toBe(true)
    expect(res.result).toBe('forwarded:beta:work')
  })

  it('lets a sandboxed handler emit onto the shared event bus with the plugin as source', async () => {
    const seen: unknown[] = []
    const bus = new EventBus()
    bus.on('bx:ping', (e) => seen.push({ topic: e.topic, source: e.source, payload: e.payload }))
    const host = new SandboxHost(
      sandboxManifest(),
      {},
      {
        broker,
        events: bus,
        handlers: { 'alpha:echo': '(payload, a) => (a.emit("bx:ping", { n: 2 }), 1)' },
      },
    )
    await host.start()
    await host.invoke('alpha:echo')
    expect(seen).toEqual([{ topic: 'bx:ping', source: '@fux/sbx', payload: { n: 2 } }])
  })

  it('freezes config so sandboxed mutation does not escape', async () => {
    const host = makeHost({
      'alpha:echo': '(p, a) => { try { a.config.magic = 999 } catch {} return a.config.magic }',
    })
    await host.start()
    const res = (await host.invoke('alpha:echo')) as { ok: true; result?: unknown }
    expect(res.result).toBe(7)
  })
})

describe('creationExecutionHostFactory · sandbox integration (G3)', () => {
  it('routes a plugin to a SandboxHost when handlers are configured', async () => {
    const factory = createExecutionHostFactory({
      sandbox: {
        handlers: (pluginId) =>
          pluginId === '@fux/sbx' ? { 'alpha:echo': echoSource } : undefined,
      },
    })
    const host = factory(sandboxManifest(), {}, { broker, events, health: undefined })
    expect(host).toBeInstanceOf(SandboxHost)
    await host!.start()
    const res = (await host!.invoke('alpha:echo', { x: 1 })) as { ok: true; result?: unknown }
    expect(res.ok).toBe(true)
    expect(res.result).toEqual({ echo: { x: 1 } })
  })

  it('defers to the built-in dispatch when no handlers match (returns undefined)', async () => {
    const factory = createExecutionHostFactory({})
    const plugin = createExecutionHostFactory({
      sandbox: { handlers: () => undefined },
    })
    expect(factory(sandboxManifest(), {}, { broker, events, health: undefined })).toBeUndefined()
    expect(plugin(sandboxManifest(), {}, { broker, events, health: undefined })).toBeUndefined()
  })
})

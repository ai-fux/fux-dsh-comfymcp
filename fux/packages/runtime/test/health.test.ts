import { describe, expect, it } from 'vitest'
import { FuxCore } from '@fux/core'
import { HealthRegistry, type HealthProvider } from '../src/health.js'
import { Supervisor } from '../src/supervisor.js'
import type { FuxPluginModule, PluginContext } from '../src/types.js'

const greeterManifest = {
  id: '@fux/example-greeter',
  name: 'Greeter',
  version: '0.0.1',
  protocol: '^0.1.0',
  executionMode: 'in_process',
  capabilities: [{ name: 'greeting:hello', version: '0.0.1' }],
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

function healthModule(
  use: (health: NonNullable<PluginContext['health']>) => void,
): FuxPluginModule {
  return {
    activate(ctx) {
      if (ctx.health) use(ctx.health)
    },
  }
}

function setup(
  modules: Record<string, FuxPluginModule>,
  product = {
    id: 'health-product',
    name: 'Health',
    version: '0.0.1',
    plugins: [{ id: '@fux/example-app' }, { id: '@fux/example-greeter' }],
  },
) {
  const core = new FuxCore()
  core.register(greeterManifest)
  core.register(appManifest)
  const { graph } = core.compose(product)
  const supervisor = new Supervisor(core.events)
  const resolver = (pluginId: string) => {
    const module = modules[pluginId]
    if (!module) throw new Error(`no module for ${pluginId}`)
    return module
  }
  return { core, graph, supervisor, resolver }
}

describe('HealthRegistry (FR-02)', () => {
  it('stores a pushed report with status, detail and timestamp', () => {
    const registry = new HealthRegistry()
    registry.report('p1', 'ok', { region: 'cn' })
    const snapshot = registry.healthOf('p1')
    expect(snapshot?.status).toBe('ok')
    expect(snapshot?.detail).toEqual({ region: 'cn' })
    expect(typeof snapshot?.updatedAt).toBe('number')
    expect(registry.snapshot().size).toBe(1)
  })

  it('returns undefined for an unknown plugin', () => {
    const registry = new HealthRegistry()
    expect(registry.healthOf('ghost')).toBeUndefined()
    expect(registry.snapshot().size).toBe(0)
  })

  it('snapshot never invokes pull providers', () => {
    const registry = new HealthRegistry()
    let calls = 0
    registry.provide('p1', () => {
      calls += 1
      return 'ok'
    })
    expect(registry.snapshot().size).toBe(0)
    expect(calls).toBe(0)
  })

  it('poll refreshes from providers, accepting a bare status', async () => {
    const registry = new HealthRegistry()
    registry.provide('p1', () => 'degraded')
    registry.provide('p2', async () => ({ status: 'down' as const }))
    await registry.poll()
    expect(registry.healthOf('p1')?.status).toBe('degraded')
    expect(registry.healthOf('p2')?.status).toBe('down')
  })

  it('clear removes one plugin or everything', () => {
    const registry = new HealthRegistry()
    registry.report('p1', 'ok')
    registry.report('p2', 'down')
    registry.clear('p1')
    expect(registry.healthOf('p1')).toBeUndefined()
    expect(registry.healthOf('p2')).toBeDefined()
    registry.clear()
    expect(registry.snapshot().size).toBe(0)
  })
})

describe('Supervisor health collection (FR-02)', () => {
  it('collects pushed reports from context.health', async () => {
    const modules: Record<string, FuxPluginModule> = {
      '@fux/example-greeter': healthModule((health) => health.report('ok', { mode: 'in_process' })),
      '@fux/example-app': healthModule((health) => health.report('degraded')),
    }
    const { graph, supervisor, resolver } = setup(modules)
    const runtime = await supervisor.start(graph, resolver)
    expect(runtime.healthOf('@fux/example-greeter')?.status).toBe('ok')
    expect(runtime.healthOf('@fux/example-greeter')?.detail).toEqual({ mode: 'in_process' })
    expect(runtime.healthOf('@fux/example-app')?.status).toBe('degraded')
    expect(runtime.health().size).toBe(2)
    await runtime.stop()
  })

  it('exposes no entries for plugins that never report (zero impact)', async () => {
    const modules: Record<string, FuxPluginModule> = {
      '@fux/example-greeter': healthModule(() => {}),
      '@fux/example-app': {
        activate: (ctx) => ctx.provide('app:run', () => 'ok'),
      },
    }
    const { graph, supervisor, resolver } = setup(modules)
    const runtime = await supervisor.start(graph, resolver)
    expect(runtime.health().size).toBe(0)
    expect(runtime.healthOf('@fux/example-greeter')).toBeUndefined()
    await runtime.stop()
  })

  it('pollHealth pulls fresh status from providers', async () => {
    const provider: HealthProvider = () => ({ status: 'down', detail: { retries: 3 } })
    const modules: Record<string, FuxPluginModule> = {
      '@fux/example-greeter': healthModule((health) => health.provide(provider)),
      '@fux/example-app': healthModule((health) => health.report('ok')),
    }
    const { graph, supervisor, resolver } = setup(modules)
    const runtime = await supervisor.start(graph, resolver)
    await runtime.pollHealth()
    expect(runtime.healthOf('@fux/example-greeter')?.status).toBe('down')
    expect(runtime.healthOf('@fux/example-greeter')?.detail).toEqual({ retries: 3 })
    expect(runtime.healthOf('@fux/example-app')?.status).toBe('ok')
    await runtime.stop()
  })

  it('clears a plugin health entry on unregister', async () => {
    const modules: Record<string, FuxPluginModule> = {
      '@fux/example-greeter': healthModule((health) => health.report('ok')),
      '@fux/example-app': healthModule((health) => health.report('ok')),
    }
    const { graph, supervisor, resolver } = setup(modules)
    const runtime = await supervisor.start(graph, resolver)
    await runtime.stopPlugin('@fux/example-greeter')
    await runtime.unregisterPlugin('@fux/example-greeter')
    expect(runtime.healthOf('@fux/example-greeter')).toBeUndefined()
    expect(runtime.healthOf('@fux/example-app')).toBeDefined()
    await runtime.stop()
  })
})

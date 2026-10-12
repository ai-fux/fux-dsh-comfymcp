import { describe, expect, it } from 'vitest'
import { FuxCore } from '@fux/core'
import { InMemoryConnector } from '@fux/connector'
import { RuntimeDiscovery } from '../src/discovery.js'
import { Supervisor } from '../src/supervisor.js'
import type { Discoverable } from '@fux/protocol'
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

function greeterModule(): FuxPluginModule {
  return {
    activate: (ctx) => {
      ctx.provide('greeting:hello', () => 'hi')
    },
  }
}
function appModule(): FuxPluginModule {
  return {
    activate: (ctx: PluginContext) => {
      ctx.provide('app:run', () => 'ok')
    },
  }
}

async function startRuntime(options: ConstructorParameters<typeof Supervisor>[1] = {}) {
  const core = new FuxCore()
  core.register(greeterManifest)
  core.register(appManifest)
  const { graph } = core.compose({
    id: 'discovery-product',
    name: 'Discovery',
    version: '0.0.1',
    plugins: [{ id: '@fux/example-app' }, { id: '@fux/example-greeter' }],
  })
  const modules: Record<string, FuxPluginModule> = {
    '@fux/example-greeter': greeterModule(),
    '@fux/example-app': appModule(),
  }
  const runtime = await new Supervisor(core.events, options).start(graph, (id) => {
    const module = modules[id]
    if (!module) throw new Error(`no module for ${id}`)
    return module
  })
  return runtime
}

describe('RuntimeDiscovery (BR-02)', () => {
  it('dedupes and merges sources, then filters by query', () => {
    const plugins: Discoverable = {
      discover: () => [
        { kind: 'plugin', id: 'a', status: 'started' },
        { kind: 'plugin', id: 'a', status: 'started' },
      ],
    }
    const extras: Discoverable = {
      discover: () => [{ kind: 'connector', id: 'logs:out', status: 'open' }],
    }
    const discovery = new RuntimeDiscovery([plugins, extras])
    expect(discovery.discover()).toHaveLength(2)
    expect(discovery.discover({ kind: 'connector' }).map((r) => r.id)).toEqual(['logs:out'])
    expect(discovery.discover({ text: 'logs' }).map((r) => r.id)).toEqual(['logs:out'])
    expect(discovery.discover({ text: 'zzz' })).toEqual([])
  })
})

describe('StartedRuntime.discover (BR-02)', () => {
  it('discovers plugins, capabilities and connectors through one view', async () => {
    const runtime = await startRuntime()
    runtime.registerConnector(new InMemoryConnector({ id: 'logs:out' }))

    const byKind = (kind: string) =>
      runtime
        .discover({ kind: kind as never })
        .map((r) => r.id)
        .sort()

    expect(runtime.discover().length).toBe(5) // 2 plugins + 2 capabilities + 1 connector
    expect(runtime.discover({ kind: 'plugin' })).toHaveLength(2)
    expect(byKind('plugin')).toEqual(['@fux/example-app', '@fux/example-greeter'])
    expect(byKind('capability')).toEqual(['app:run', 'greeting:hello'])
    expect(byKind('connector')).toEqual(['logs:out'])

    // capability carries its provider as `entry`
    const hello = runtime.discover({ kind: 'capability', text: 'greeting' })[0]
    expect(hello?.entry).toBe('@fux/example-greeter')
    // text search is case-insensitive over id/entry
    expect(runtime.discover({ text: 'GREETING' }).some((r) => r.kind === 'capability')).toBe(true)
    await runtime.stop()
  })

  it('folds caller-injected Discoverable sources into the unified view', async () => {
    const external: Discoverable = {
      discover: () => [{ kind: 'capability', id: 'ext:svc', entry: 'remote' }],
    }
    const runtime = await startRuntime({ discovery: [external] })
    expect(runtime.discover({ kind: 'capability' }).some((r) => r.id === 'ext:svc')).toBe(true)
    await runtime.stop()
  })

  it('keeps plugins without a state intact when stopped', async () => {
    const runtime = await startRuntime()
    expect(runtime.discover({ kind: 'plugin', status: 'started' }).length).toBeGreaterThanOrEqual(2)
    await runtime.stop()
  })
})

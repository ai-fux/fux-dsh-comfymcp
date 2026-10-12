import { describe, expect, it } from 'vitest'
import { FuxCore } from '@fux/core'
import { ProtocolIncompatibleError } from '@fux/core'
import { Supervisor } from '../src/supervisor.js'
import {
  CapabilityDeniedError,
  CapabilityNotFoundRuntimeError,
  HostNotRunningError,
  IpcInvocationError,
  PluginStartError,
  ProvideUndeclaredError,
  UnknownCallerError,
  UnsupportedExecutionModeError,
} from '../src/errors.js'
import type { FuxPluginModule, PluginContext } from '../src/types.js'

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
  let greeting = 'Hello'
  return {
    activate(ctx: PluginContext) {
      greeting = String(ctx.config['greeting'] ?? greeting)
      ctx.provide('greeting:hello', (payload) => {
        const who = (payload as { who?: string } | undefined)?.who ?? 'FUX'
        return `${greeting}, ${who}!`
      })
    },
  }
}

function appModule(options: { eager?: boolean } = {}): FuxPluginModule {
  let ctxRef: PluginContext | null = null
  const module: FuxPluginModule & { run?: () => Promise<string> } = {
    activate(ctx) {
      ctxRef = ctx
      ctx.provide('app:run', async () => {
        return ctx.call<string>('greeting:hello', { who: 'World' })
      })
      if (options.eager) void ctx.call('greeting:hello').catch(() => {})
    },
  }
  module.run = () => ctxRef!.call<string>('greeting:hello', { who: 'Runtime' })
  return module
}

function setup(
  modules: Record<string, FuxPluginModule>,
  product = {
    id: 'demo-hello',
    name: 'Demo Hello',
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

describe('Supervisor', () => {
  it('starts plugins in topological order', async () => {
    const order: string[] = []
    const track = (id: string): FuxPluginModule => ({
      activate() {
        order.push(id)
      },
    })
    const { graph, supervisor, resolver } = setup({
      '@fux/example-greeter': track('@fux/example-greeter'),
      '@fux/example-app': track('@fux/example-app'),
    })
    const runtime = await supervisor.start(graph, resolver)
    expect(order).toEqual(['@fux/example-greeter', '@fux/example-app'])
    expect(runtime.states().get('@fux/example-greeter')).toBe('started')
    expect(runtime.states().get('@fux/example-app')).toBe('started')
    await runtime.stop()
  })

  it('supports capability calls during activation thanks to ordering', async () => {
    const { graph, supervisor, resolver } = setup({
      '@fux/example-greeter': greeterModule(),
      '@fux/example-app': appModule({ eager: true }),
    })
    await expect(supervisor.start(graph, resolver)).resolves.toBeDefined()
  })

  it('applies product config when starting hosts', async () => {
    const core = new FuxCore()
    core.register(greeterManifest)
    core.register(appManifest)
    const { graph } = core.compose({
      id: 'demo-hello',
      name: 'Demo Hello',
      version: '0.0.1',
      plugins: [
        { id: '@fux/example-app' },
        { id: '@fux/example-greeter', config: { greeting: '你好' } },
      ],
    })
    const modules: Record<string, FuxPluginModule> = {
      '@fux/example-greeter': greeterModule(),
      '@fux/example-app': appModule(),
    }
    const runtime = await new Supervisor(core.events).start(graph, (id) => {
      const module = modules[id]
      if (!module) throw new Error(`no module for ${id}`)
      return module
    })
    await expect(runtime.callAsSystem<string>('app:run')).resolves.toBe('你好, World!')
    await runtime.stop()
  })

  it('executes the full capability chain via callAsSystem', async () => {
    const { graph, supervisor, resolver } = setup({
      '@fux/example-greeter': greeterModule(),
      '@fux/example-app': appModule(),
    })
    const runtime = await supervisor.start(graph, resolver)
    await expect(runtime.callAsSystem<string>('app:run')).resolves.toBe('Hello, World!')
    await expect(
      runtime.call<string>('@fux/example-app', 'greeting:hello', { who: 'Plugin' }),
    ).resolves.toBe('Hello, Plugin!')
    await runtime.stop()
  })

  it('denies calls to undeclared capabilities', async () => {
    const sneakyManifest = {
      ...appManifest,
      id: '@fux/sneaky',
      consumes: [],
    }
    const core = new FuxCore()
    core.register(greeterManifest)
    core.register(sneakyManifest)
    const { graph } = core.compose({
      id: 'sneaky-product',
      name: 'Sneaky',
      version: '0.0.1',
      plugins: [{ id: '@fux/sneaky' }, { id: '@fux/example-greeter' }],
    })
    const runtime = await new Supervisor(core.events).start(graph, (id) =>
      id === '@fux/sneaky' ? appModule() : greeterModule(),
    )
    await expect(runtime.call('@fux/sneaky', 'greeting:hello')).rejects.toBeInstanceOf(
      CapabilityDeniedError,
    )
    await runtime.stop()
  })

  it('surfaces plugin handler errors as IpcInvocationError', async () => {
    const core = new FuxCore()
    core.register({
      ...greeterManifest,
      id: '@fux/broken-greeter',
      executionMode: 'in_process',
    })
    const { graph } = core.compose({
      id: 'broken-product',
      name: 'Broken',
      version: '0.0.1',
      plugins: [{ id: '@fux/broken-greeter' }],
    })
    const runtime = await new Supervisor(core.events).start(graph, () => ({
      activate: (ctx: PluginContext) => {
        ctx.provide('greeting:hello', () => {
          throw new Error('handler exploded')
        })
      },
    }))
    await expect(runtime.callAsSystem('greeting:hello')).rejects.toSatisfy((error) => {
      const e = error as IpcInvocationError
      return e instanceof IpcInvocationError && e.ipcError.code === 'E_PLUGIN_ERROR'
    })
    await runtime.stop()
  })

  it('reports unknown capabilities and callers', async () => {
    const { graph, supervisor, resolver } = setup({
      '@fux/example-greeter': greeterModule(),
      '@fux/example-app': appModule(),
    })
    const runtime = await supervisor.start(graph, resolver)
    await expect(runtime.callAsSystem('nope:capability')).rejects.toBeInstanceOf(
      CapabilityNotFoundRuntimeError,
    )
    await expect(runtime.call('ghost', 'greeting:hello')).rejects.toBeInstanceOf(UnknownCallerError)
    await runtime.stop()
  })

  it('rolls back started plugins when activation fails', async () => {
    const deactivated: string[] = []
    const greeter: FuxPluginModule = {
      activate: (ctx) => {
        ctx.provide('greeting:hello', () => 'hi')
      },
      deactivate: () => {
        deactivated.push('@fux/example-greeter')
      },
    }
    const failing: FuxPluginModule = {
      activate: () => {
        throw new Error('activation boom')
      },
    }
    const { graph, supervisor, resolver } = setup({
      '@fux/example-greeter': greeter,
      '@fux/example-app': failing,
    })
    const promise = supervisor.start(graph, resolver)
    await expect(promise).rejects.toBeInstanceOf(PluginStartError)
    expect(deactivated).toEqual(['@fux/example-greeter'])
  })

  it('rejects undeclared capability providers at activation', async () => {
    const { graph, supervisor, resolver } = setup({
      '@fux/example-greeter': greeterModule(),
      '@fux/example-app': {
        activate: (ctx) => {
          ctx.provide('hack:capability', () => 'nope')
        },
      },
    })
    try {
      await supervisor.start(graph, resolver)
      expect.unreachable()
    } catch (error) {
      const startError = error as PluginStartError
      expect(startError).toBeInstanceOf(PluginStartError)
      expect(startError.cause).toBeInstanceOf(ProvideUndeclaredError)
    }
  })

  it('refuses worker and remote execution modes', async () => {
    const core = new FuxCore()
    core.register({
      ...greeterManifest,
      id: '@fux/worker-plugin',
      executionMode: 'worker',
    })
    const { graph } = core.compose({
      id: 'worker-product',
      name: 'Worker',
      version: '0.0.1',
      plugins: [{ id: '@fux/worker-plugin' }],
    })
    await expect(
      new Supervisor(core.events).start(graph, () => greeterModule()),
    ).rejects.toBeInstanceOf(UnsupportedExecutionModeError)
  })

  it('verifies protocol compatibility before starting even for hand-built graphs', async () => {
    const core = new FuxCore()
    core.register(greeterManifest)
    core.register(appManifest)
    const { graph } = core.compose({
      id: 'compat-product',
      name: 'Compat',
      version: '0.0.1',
      plugins: [{ id: '@fux/example-greeter' }],
    })
    const incompatible = {
      ...graph,
      plugins: new Map(
        [...graph.plugins].map(([id, node]) => [
          id,
          { ...node, manifest: { ...node.manifest, protocol: '^9.0.0' } },
        ]),
      ),
    }
    await expect(
      new Supervisor(core.events).start(incompatible, () => greeterModule()),
    ).rejects.toSatisfy((error) => {
      const e = error as ProtocolIncompatibleError
      return (
        e instanceof ProtocolIncompatibleError &&
        e.pluginId === '@fux/example-greeter' &&
        e.requiredRange === '^9.0.0'
      )
    })
  })

  it('stops all plugins in reverse order', async () => {
    const stopped: string[] = []
    const { graph, supervisor, resolver } = setup({
      '@fux/example-greeter': {
        activate: (ctx) => ctx.provide('greeting:hello', () => 'hi'),
        deactivate: () => {
          stopped.push('@fux/example-greeter')
        },
      },
      '@fux/example-app': {
        activate: (ctx) => ctx.provide('app:run', () => 'ok'),
        deactivate: () => {
          stopped.push('@fux/example-app')
        },
      },
    })
    const runtime = await supervisor.start(graph, resolver)
    await runtime.stop()
    expect(stopped).toEqual(['@fux/example-app', '@fux/example-greeter'])
    expect(runtime.states().get('@fux/example-greeter')).toBe('stopped')
    await expect(runtime.callAsSystem('greeting:hello')).rejects.toBeInstanceOf(HostNotRunningError)
  })

  it('ignores duplicate stop calls', async () => {
    const { graph, supervisor, resolver } = setup({
      '@fux/example-greeter': greeterModule(),
      '@fux/example-app': appModule(),
    })
    const runtime = await supervisor.start(graph, resolver)
    await runtime.stop()
    await expect(runtime.stop()).resolves.toBeUndefined()
  })
})

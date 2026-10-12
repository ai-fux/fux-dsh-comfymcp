import { describe, expect, it } from 'vitest'
import { FuxCore } from '@fux/core'
import { Supervisor } from '../src/supervisor.js'
import {
  CapabilityNotFoundRuntimeError,
  DuplicateCapabilityRuntimeError,
  DuplicatePluginRuntimeError,
  IpcInvocationError,
  PluginNotStartedError,
  UnsupportedExecutionModeError,
} from '../src/errors.js'
import type { FuxPluginModule, PluginContext } from '../src/types.js'

const greeterManifest = {
  id: '@fux/example-greeter',
  name: 'Greeter',
  version: '0.0.2',
  protocol: '^0.1.0',
  executionMode: 'in_process' as const,
  capabilities: [{ name: 'greeting:hello', version: '0.0.1' }],
}

const extraManifest = {
  id: '@fux/extra',
  name: 'Extra',
  version: '0.0.2',
  protocol: '^0.1.0',
  executionMode: 'in_process' as const,
  capabilities: [{ name: 'extra:ping', version: '0.0.1' }],
  consumes: [],
  dependencies: [],
}

function extraModule(tag = 'pong'): FuxPluginModule {
  return {
    activate(ctx: PluginContext) {
      ctx.provide('extra:ping', () => `pong:${tag}`)
    },
  }
}

async function startBase() {
  const core = new FuxCore()
  core.register(greeterManifest)
  const { graph } = core.compose({
    id: 'hot-product',
    name: 'Hot',
    version: '0.0.1',
    plugins: [{ id: '@fux/example-greeter' }],
  })
  const modules = new Map<string, FuxPluginModule>([
    [
      '@fux/example-greeter',
      {
        activate: (ctx) =>
          ctx.provide('greeting:hello', (payload) => {
            const who = (payload as { who?: string } | undefined)?.who ?? 'World'
            return `Hello, ${who}!`
          }),
      },
    ],
  ])
  const promising = new Supervisor(core.events).start(graph, (id) => {
    const module = modules.get(id)
    if (!module) throw new Error(`no module for ${id}`)
    return module
  })
  return { modules, start: promising }
}

describe('Supervisor hot-plug (AR-02 / AR-03)', () => {
  it('registers, starts, and calls a runtime plugin', async () => {
    const { modules, start } = await startBase()
    const runtime = await start
    await runtime.registerPlugin(extraManifest)
    modules.set('@fux/extra', extraModule())
    expect(runtime.states().get('@fux/extra')).toBe('registered')
    await runtime.startPlugin('@fux/extra')
    expect(runtime.states().get('@fux/extra')).toBe('started')
    await expect(runtime.callAsSystem('extra:ping')).resolves.toBe('pong:pong')
    await runtime.stop()
  })

  it('is loadable-but-disabled until startPlugin (host returns crashed)', async () => {
    const { modules, start } = await startBase()
    const runtime = await start
    await runtime.registerPlugin(extraManifest)
    modules.set('@fux/extra', extraModule())
    await expect(runtime.callAsSystem('extra:ping')).rejects.toSatisfy((error) => {
      const e = error as IpcInvocationError
      return e instanceof IpcInvocationError && e.ipcError.code === 'E_PLUGIN_CRASHED'
    })
    await runtime.stop()
  })

  it('is idempotent when starting an already-started plugin', async () => {
    const { modules, start } = await startBase()
    const runtime = await start
    await runtime.registerPlugin(extraManifest)
    modules.set('@fux/extra', extraModule())
    await runtime.startPlugin('@fux/extra')
    await runtime.startPlugin('@fux/extra')
    expect(runtime.states().get('@fux/extra')).toBe('started')
    await runtime.stop()
  })

  it('stops and re-enables a plugin without restarting the runtime', async () => {
    const { modules, start } = await startBase()
    const runtime = await start
    await runtime.registerPlugin(extraManifest)
    modules.set('@fux/extra', extraModule())
    await runtime.startPlugin('@fux/extra')
    await expect(runtime.callAsSystem('extra:ping')).resolves.toBe('pong:pong')

    await runtime.stopPlugin('@fux/extra')
    expect(runtime.states().get('@fux/extra')).toBe('stopped')
    await expect(runtime.callAsSystem('extra:ping')).rejects.toSatisfy((error) => {
      const e = error as IpcInvocationError
      return e instanceof IpcInvocationError && e.ipcError.code === 'E_PLUGIN_CRASHED'
    })

    await runtime.startPlugin('@fux/extra')
    await expect(runtime.callAsSystem('extra:ping')).resolves.toBe('pong:pong')
    await runtime.stop()
  })

  it('unregisters a plugin and its capability, then allows re-registration', async () => {
    const { modules, start } = await startBase()
    const runtime = await start
    await runtime.registerPlugin(extraManifest)
    modules.set('@fux/extra', extraModule())
    await runtime.startPlugin('@fux/extra')

    await runtime.unregisterPlugin('@fux/extra')
    expect(runtime.states().has('@fux/extra')).toBe(false)
    await expect(runtime.callAsSystem('extra:ping')).rejects.toBeInstanceOf(
      CapabilityNotFoundRuntimeError,
    )

    await runtime.registerPlugin(extraManifest)
    modules.set('@fux/extra', extraModule())
    await runtime.startPlugin('@fux/extra')
    await expect(runtime.callAsSystem('extra:ping')).resolves.toBe('pong:pong')
    await runtime.stop()
  })

  it('rejects registering the same plugin id twice', async () => {
    const { start } = await startBase()
    const runtime = await start
    await runtime.registerPlugin(extraManifest)
    await expect(runtime.registerPlugin(extraManifest)).rejects.toBeInstanceOf(
      DuplicatePluginRuntimeError,
    )
    await runtime.stop()
  })

  it('rejects a capability whose name is already provided', async () => {
    const { start } = await startBase()
    const runtime = await start
    const clash = {
      ...extraManifest,
      id: '@fux/clash',
      capabilities: [{ name: 'greeting:hello', version: '0.0.1' }],
    }
    await expect(runtime.registerPlugin(clash)).rejects.toBeInstanceOf(
      DuplicateCapabilityRuntimeError,
    )
    await expect(runtime.callAsSystem('greeting:hello')).resolves.toBe('Hello, World!')
    await runtime.stop()
  })

  it('rejects start/stop/unregister for unknown plugins', async () => {
    const { start } = await startBase()
    const runtime = await start
    await expect(runtime.startPlugin('ghost')).rejects.toBeInstanceOf(PluginNotStartedError)
    await expect(runtime.stopPlugin('ghost')).rejects.toBeInstanceOf(PluginNotStartedError)
    await expect(runtime.unregisterPlugin('ghost')).rejects.toBeInstanceOf(PluginNotStartedError)
    await runtime.stop()
  })

  it('rejects unsupported execution modes without mutating the broker', async () => {
    const { start } = await startBase()
    const runtime = await start
    const worker = {
      ...extraManifest,
      id: '@fux/worker',
      executionMode: 'worker' as const,
      capabilities: [{ name: 'worker:run', version: '0.0.1' }],
    }
    await expect(runtime.registerPlugin(worker)).rejects.toBeInstanceOf(
      UnsupportedExecutionModeError,
    )
    await expect(runtime.callAsSystem('worker:run')).rejects.toBeInstanceOf(
      CapabilityNotFoundRuntimeError,
    )
    await runtime.stop()
  })

  it('lets a hot-registered caller consume an existing capability', async () => {
    const { modules, start } = await startBase()
    const runtime = await start
    const callerManifest = {
      id: '@fux/caller',
      name: 'Caller',
      version: '0.0.2',
      protocol: '^0.1.0',
      executionMode: 'in_process' as const,
      capabilities: [{ name: 'caller:run', version: '0.0.1' }],
      consumes: ['greeting:hello'],
      dependencies: [],
    }
    await runtime.registerPlugin(callerManifest)
    modules.set('@fux/caller', {
      activate: (ctx: PluginContext) => {
        ctx.provide('caller:run', () => ctx.call('greeting:hello', { who: 'Hot' }))
      },
    })
    await runtime.startPlugin('@fux/caller')
    await expect(runtime.callAsSystem('caller:run')).resolves.toBe('Hello, Hot!')
    await runtime.stop()
  })
})

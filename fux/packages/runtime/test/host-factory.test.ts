import { describe, expect, it } from 'vitest'
import { FuxCore, EventBus } from '@fux/core'
import { ipcOk, newRequestId } from '@fux/protocol'
import { Supervisor } from '../src/supervisor.js'
import { HealthRegistry } from '../src/health.js'
import { UnsupportedExecutionModeError } from '../src/errors.js'
import type {
  ExecutionMode,
  IpcResponse,
  PluginHost,
  PluginHostDeps,
  PluginHostFactory,
} from '../src/types.js'

const workerManifest = {
  id: '@fux/worker-svc',
  name: 'Worker Svc',
  version: '0.0.1',
  protocol: '^0.1.0',
  executionMode: 'worker',
  capabilities: [{ name: 'svc:compute', version: '0.0.1' }],
} as const

const workerProduct = {
  id: 'worker-product',
  name: 'Worker Product',
  version: '0.0.1',
  plugins: [{ id: '@fux/worker-svc' }],
}

/** A minimal, framework-only stand-in for an out-of-process host. */
class FakeWorkerHost implements PluginHost {
  readonly pluginId: string
  readonly mode: ExecutionMode = 'worker'
  readonly deps: PluginHostDeps
  private started = false

  constructor(manifest: { id: string }, _config: Record<string, unknown>, deps: PluginHostDeps) {
    this.pluginId = manifest.id
    this.deps = deps
  }

  async start(): Promise<void> {
    this.started = true
  }

  async stop(): Promise<void> {
    this.started = false
  }

  async invoke(capability: string, payload?: unknown): Promise<IpcResponse> {
    return ipcOk(newRequestId(), `worker:${capability}:${JSON.stringify(payload)}`)
  }

  providedCapabilities(): string[] {
    return ['svc:compute']
  }

  status(): 'started' | 'stopped' {
    return this.started ? 'started' : 'stopped'
  }
}

function composeWorker() {
  const core = new FuxCore()
  core.register(workerManifest)
  const { graph } = core.compose(workerProduct)
  return { core, graph }
}

describe('PluginHostFactory wiring (PRD)', () => {
  it('hosts a worker-mode plugin through a caller-provided factory', async () => {
    const { core, graph } = composeWorker()
    const releasedDeps: PluginHostDeps[] = []
    const factory: PluginHostFactory = (manifest, config, deps) => {
      releasedDeps.push(deps)
      if (manifest.executionMode === 'in_process') return undefined
      return new FakeWorkerHost(manifest, config, deps)
    }
    const supervisor = new Supervisor(core.events, { hostFactory: factory })
    const runtime = await supervisor.start(graph, () => ({ activate: () => {} }))

    expect(runtime.states().get('@fux/worker-svc')).toBe('started')
    expect(await runtime.callAsSystem('svc:compute', { n: 1 })).toBe('worker:svc:compute:{"n":1}')
    expect(releasedDeps).toHaveLength(1)

    await runtime.stop()
    expect(runtime.states().get('@fux/worker-svc')).toBe('stopped')
  })

  it('passes the broker, event bus and health registry to the factory', async () => {
    const { core, graph } = composeWorker()
    const captured: PluginHostDeps[] = []
    const supervisor = new Supervisor(core.events, {
      hostFactory: (m, c, deps) => {
        captured.push(deps)
        return new FakeWorkerHost(m, c, deps)
      },
    })
    await supervisor.start(graph, () => ({ activate: () => {} }))
    expect(captured).toHaveLength(1)
    expect(captured[0]!.events).toBeInstanceOf(EventBus)
    expect(captured[0]!.health).toBeInstanceOf(HealthRegistry)
    expect(typeof captured[0]!.broker.call).toBe('function')
  })

  it('rejects worker/remote modes when no factory claims them (default unchanged)', async () => {
    const { core, graph } = composeWorker()
    const supervisor = new Supervisor(core.events) // no hostFactory
    await expect(supervisor.start(graph, () => ({ activate: () => {} }))).rejects.toBeInstanceOf(
      UnsupportedExecutionModeError,
    )
  })

  it('falls through to the built-in dispatch when the factory returns undefined', async () => {
    const { core, graph } = composeWorker()
    const supervisor = new Supervisor(core.events, { hostFactory: () => undefined })
    await expect(supervisor.start(graph, () => ({ activate: () => {} }))).rejects.toBeInstanceOf(
      UnsupportedExecutionModeError,
    )
  })
})

describe('Host exit supervision wiring (G1 强化)', () => {
  it('marks a plugin broken when its host reports an unexpected exit', async () => {
    const { core, graph } = composeWorker()
    let deps: PluginHostDeps | undefined
    const supervisor = new Supervisor(core.events, {
      hostFactory: (m, c, d) => {
        if (m.executionMode === 'in_process') return undefined
        deps = d
        return new FakeWorkerHost(m, c, d)
      },
    })
    const runtime = await supervisor.start(graph, () => ({ activate: () => {} }))
    expect(runtime.states().get('@fux/worker-svc')).toBe('started')

    // Simulate the worker sub-process dying after start.
    deps!.onHostExit?.('@fux/worker-svc', new Error('worker died'))
    expect(runtime.states().get('@fux/worker-svc')).toBe('broken')

    await runtime.stop()
  })
})

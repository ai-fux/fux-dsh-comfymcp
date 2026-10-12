import { describe, expect, it } from 'vitest'
import type { PluginManifest } from '@fux/protocol'
import { EventBus } from '@fux/core'
import { InProcessHost } from '../src/in-process-host.js'
import type { CapabilityBroker } from '../src/broker.js'

const manifest: PluginManifest = {
  id: '@fux/stat',
  name: 'Stat',
  version: '0.0.1',
  protocol: '^0.1.0',
  executionMode: 'in_process',
  capabilities: [],
  consumes: [],
  dependencies: [],
}

const broker = { call: async () => ({}) } as unknown as CapabilityBroker

function makeHost(activate: () => void | Promise<void> = () => {}) {
  return new InProcessHost(manifest, {}, async () => ({ activate }), {
    broker,
    events: new EventBus(),
  })
}

describe('InProcessHost.status (CR-01)', () => {
  it('reports registered before start and started after start', async () => {
    const host = makeHost()
    expect(host.status()).toBe('registered')
    await host.start()
    expect(host.status()).toBe('started')
  })

  it('reports stopped after deactivation', async () => {
    const host = makeHost()
    await host.start()
    await host.stop()
    expect(host.status()).toBe('stopped')
  })

  it('tracks the starting phase while activation is pending', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const host = makeHost(() => gate)
    const started = host.start()
    expect(host.status()).toBe('starting')
    release()
    await started
    expect(host.status()).toBe('started')
  })

  it('is idempotent across repeated stops', async () => {
    const host = makeHost()
    await host.start()
    await host.stop()
    await host.stop()
    expect(host.status()).toBe('stopped')
  })
})

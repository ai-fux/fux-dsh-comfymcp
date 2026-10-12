import { describe, expect, it } from 'vitest'
import { FuxCore } from '@fux/core'
import type { LogEntry } from '@fux/core'
import { Supervisor } from '../src/supervisor.js'
import type { FuxPluginModule } from '../src/types.js'

const greeterManifest = {
  id: '@fux/example-greeter',
  name: 'Greeter',
  version: '0.0.1',
  protocol: '^0.1.0',
  executionMode: 'in_process',
  capabilities: [{ name: 'greeting:hello', version: '0.0.1' }],
}

function makeRuntime(options: ConstructorParameters<typeof Supervisor>[1]) {
  const core = new FuxCore()
  core.register(greeterManifest)
  const { graph } = core.compose({
    id: 'channel-product',
    name: 'Channels',
    version: '0.0.1',
    plugins: [{ id: '@fux/example-greeter' }],
  })
  const module: FuxPluginModule = {
    activate: (ctx) => ctx.provide('greeting:hello', () => 'hi'),
  }
  return new Supervisor(core.events, options).start(graph, () => module)
}

describe('StartedRuntime unified channels (FR-01)', () => {
  it('channel() mirrors the core bus and persists events when a sink is configured', async () => {
    const events: unknown[] = []
    const runtime = await makeRuntime({
      persistence: { events: { append: (event) => void events.push(event) } },
    })
    const channel = runtime.channel()
    channel.emit('app:ready', { ok: true }, 'src')
    expect(events).toHaveLength(1)
    expect((events[0] as { topic: string }).topic).toBe('app:ready')
    expect(channel.listenerCount('app:ready')).toBe(0)
    await runtime.stop()
  })

  it('channel() stays a pure bypass with no persistence configured', async () => {
    const runtime = await makeRuntime({})
    const handler = () => {}
    const channel = runtime.channel()
    channel.on('app:ready', handler)
    expect(channel.listenerCount('app:ready')).toBe(1)
    channel.off('app:ready', handler)
    expect(channel.listenerCount('app:ready')).toBe(0)
    await runtime.stop()
  })

  it('logChannel() persists records when a log sink is configured', async () => {
    const logs: LogEntry[] = []
    const runtime = await makeRuntime({
      persistence: { logs: { append: (entry) => void logs.push(entry) } },
    })
    runtime.logChannel().info('booted')
    expect(logs).toHaveLength(1)
    expect(logs[0]!).toMatchObject({ level: 'info', message: 'booted' })
    await runtime.stop()
  })

  it('persistence sinks never break runtime behaviour (server still answers)', async () => {
    const runtime = await makeRuntime({
      persistence: {
        events: {
          append: () => {
            throw new Error('sink down')
          },
        },
      },
    })
    const greeting = await runtime.callAsSystem<string>('greeting:hello', { who: 'FUX' })
    expect(greeting).toBe('hi')
    // The throwing sink throws synchronously inside emit; dispatch still runs.
    expect(() => runtime.channel().emit('app:ready')).not.toThrow()
    await runtime.stop()
  })
})

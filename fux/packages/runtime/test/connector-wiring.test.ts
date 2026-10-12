import { describe, expect, it } from 'vitest'
import { FuxCore } from '@fux/core'
import { DuplicateConnectorError, InMemoryConnector } from '@fux/connector'
import { ConnectorResolverMissingError, ConnectorStartError } from '../src/errors.js'
import { Supervisor } from '../src/supervisor.js'
import type { ConnectorMessageEvent } from '@fux/connector'
import type { FuxPluginModule } from '../src/types.js'

const greeterManifest = {
  id: '@fux/example-greeter',
  name: 'Greeter',
  version: '0.0.1',
  protocol: '^0.1.0',
  executionMode: 'in_process' as const,
  capabilities: [{ name: 'greeting:hello', version: '0.0.1' }],
}

function startableCore(connectors?: Array<Record<string, unknown>>) {
  const core = new FuxCore()
  core.register(greeterManifest)
  const { graph } = core.compose({
    id: 'conn-product',
    name: 'Conn',
    version: '0.0.1',
    plugins: [{ id: '@fux/example-greeter' }],
    connectors,
  })
  const byId = new Map<string, FuxPluginModule>([
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
  const resolveModule = (pluginId: string): FuxPluginModule => {
    const module = byId.get(pluginId)
    if (!module) throw new Error(`no module for ${pluginId}`)
    return module
  }
  return { graph, core, resolveModule }
}

describe('Supervisor connector wiring (CR-04 declarative)', () => {
  it('resolves, registers and opens product-declared connectors', async () => {
    const { graph, core, resolveModule } = startableCore([
      { id: 'logs:out', kind: 'publish_subscribe' },
    ])
    const runtime = await new Supervisor(core.events, {
      connectorResolver: (id) => Promise.resolve(new InMemoryConnector({ id })),
    }).start(graph, resolveModule)

    const connectors = runtime.connectors()
    expect(connectors.map((c) => c.id)).toEqual(['logs:out'])
    expect(connectors[0]?.state).toBe('open')
    await runtime.stop()
  })

  it('lets the runtime send through a declared connector', async () => {
    const { graph, core, resolveModule } = startableCore([{ id: 'out' }])
    const runtime = await new Supervisor(core.events, {
      connectorResolver: (id) => new InMemoryConnector({ id }),
    }).start(graph, resolveModule)

    const res = await runtime.send('out', { id: 'm1', channel: 'orders:new', payload: { n: 1 } })
    expect(res.ok).toBe(true)
    await runtime.stop()
  })

  it('throws a resolver-missing error when a declared connector has no resolver', async () => {
    const { graph, core, resolveModule } = startableCore([{ id: 'orphan' }])
    await expect(new Supervisor(core.events).start(graph, resolveModule)).rejects.toBeInstanceOf(
      ConnectorResolverMissingError,
    )
  })

  it('wraps a failing resolver or failing open in a connector-start error', async () => {
    const { graph, core, resolveModule } = startableCore([{ id: 'bad' }])
    await expect(
      new Supervisor(core.events, {
        connectorResolver: () => {
          throw new Error('transport unavailable')
        },
      }).start(graph, resolveModule),
    ).rejects.toBeInstanceOf(ConnectorStartError)
  })

  it('emits connector lifecycle events on the core bus and closes on stop', async () => {
    const { graph, core, resolveModule } = startableCore([{ id: 'evt' }])
    const topics: string[] = []
    core.events.on('connector:open', (ipc) => topics.push(`open:${ipc.source}`))
    core.events.on('connector:close', (ipc) => topics.push(`close:${ipc.source}`))

    const runtime = await new Supervisor(core.events, {
      connectorResolver: (id) => new InMemoryConnector({ id }),
    }).start(graph, resolveModule)
    await runtime.stop()

    expect(topics).toContain('open:evt')
    expect(topics).toContain('close:evt')
  })

  it('auto-bridges declared connector inbound messages onto the core bus', async () => {
    const { graph, core, resolveModule } = startableCore([{ id: 'feed' }])
    const inbound: Array<{ source?: string; channel?: string }> = []
    core.events.on('connector:message', (ipc) => {
      const ev = ipc.payload as ConnectorMessageEvent
      inbound.push({ source: ipc.source, channel: ev.message.channel })
    })
    let resolved!: InMemoryConnector

    const runtime = await new Supervisor(core.events, {
      connectorResolver: (id) => {
        resolved = new InMemoryConnector({ id })
        return resolved
      },
    }).start(graph, resolveModule)

    await resolved.send({ id: 'm1', channel: 'orders:new', payload: { n: 1 } })
    expect(inbound).toEqual([{ source: 'feed', channel: 'orders:new' }])
    await runtime.stop()
  })

  it('bridges only the channels listed in a declared connector config', async () => {
    const { graph, core, resolveModule } = startableCore([
      { id: 'filtered', config: { channels: ['logs'] } },
    ])
    const channels: string[] = []
    core.events.on('connector:message', (ipc) => {
      channels.push((ipc.payload as ConnectorMessageEvent).message.channel)
    })
    let resolved!: InMemoryConnector

    const runtime = await new Supervisor(core.events, {
      connectorResolver: (id) => {
        resolved = new InMemoryConnector({ id })
        return resolved
      },
    }).start(graph, resolveModule)

    await resolved.send({ id: 'm1', channel: 'logs', payload: 1 })
    await resolved.send({ id: 'm2', channel: 'audit', payload: 2 })
    expect(channels).toEqual(['logs'])
    await runtime.stop()
  })

  it('skips message bridging when a declared connector sets bridge: false', async () => {
    const { graph, core, resolveModule } = startableCore([
      { id: 'quiet', config: { bridge: false } },
    ])
    let messages = 0
    core.events.on('connector:message', () => {
      messages += 1
    })
    let resolved!: InMemoryConnector

    const runtime = await new Supervisor(core.events, {
      connectorResolver: (id) => {
        resolved = new InMemoryConnector({ id })
        return resolved
      },
    }).start(graph, resolveModule)

    await resolved.send({ id: 'm1', channel: 'c', payload: 1 })
    expect(messages).toBe(0)
    await runtime.stop()
  })
})

describe('Supervisor request_reply serving', () => {
  it('routes an inbound request to a capability and writes the reply back', async () => {
    const { graph, core, resolveModule } = startableCore([
      {
        id: 'gate',
        kind: 'request_reply',
        config: { serve: 'greeting:hello', channel: 'req', replyChannel: 'rep' },
      },
    ])
    let connector!: InMemoryConnector
    const runtime = await new Supervisor(core.events, {
      connectorResolver: (id) => {
        connector = new InMemoryConnector({ id, kind: 'request_reply' })
        return connector
      },
    }).start(graph, resolveModule)

    const replies: Array<{ id: string; payload: unknown }> = []
    connector.subscribe('rep', (m) => replies.push({ id: m.id, payload: m.payload }))

    await connector.send({ id: 'q1', channel: 'req', payload: { who: 'Bob' } })
    await settle()
    expect(replies).toEqual([{ id: 'q1', payload: { ok: true, value: 'Hello, Bob!' } }])
    await runtime.stop()
  })

  it('replies ok:false when the target capability is missing', async () => {
    const { graph, core, resolveModule } = startableCore([
      {
        id: 'gate',
        kind: 'request_reply',
        config: { serve: 'nope:missing', channel: 'req', replyChannel: 'rep' },
      },
    ])
    let connector!: InMemoryConnector
    const runtime = await new Supervisor(core.events, {
      connectorResolver: (id) => {
        connector = new InMemoryConnector({ id, kind: 'request_reply' })
        return connector
      },
    }).start(graph, resolveModule)

    const replies: Array<{ id: string; payload: unknown }> = []
    connector.subscribe('rep', (m) => replies.push({ id: m.id, payload: m.payload }))

    await connector.send({ id: 'q2', channel: 'req', payload: { who: 'Bob' } })
    await settle()
    expect(replies).toHaveLength(1)
    expect(replies[0]?.id).toBe('q2')
    expect(replies[0]?.payload).toMatchObject({ ok: false })
    expect(typeof (replies[0]?.payload as { error?: unknown }).error).toBe('string')
    await runtime.stop()
  })

  it('rejects a serve config that names no request channel', async () => {
    const { graph, core, resolveModule } = startableCore([
      { id: 'bad', kind: 'request_reply', config: { serve: 'greeting:hello' } },
    ])
    await expect(
      new Supervisor(core.events, {
        connectorResolver: (id) => new InMemoryConnector({ id, kind: 'request_reply' }),
      }).start(graph, resolveModule),
    ).rejects.toBeInstanceOf(ConnectorStartError)
  })
})

describe('Supervisor imperative connector lifecycle', () => {
  it('registers and sends through an imperative connector (not auto-opened)', async () => {
    const { graph, core, resolveModule } = startableCore()
    const runtime = await new Supervisor(core.events).start(graph, resolveModule)

    const connector = new InMemoryConnector({ id: 'imp' })
    runtime.registerConnector(connector)
    expect(runtime.connectors().map((c) => c.id)).toEqual(['imp'])
    // imperative registration does not auto-open
    expect(connector.state).toBe('idle')

    await connector.open()
    const res = await runtime.send('imp', { id: 'm', channel: 'a', payload: 1 })
    expect(res.ok).toBe(true)
    await runtime.stop()
  })

  it('opt-in bridges an imperative connector via bridgeConnector', async () => {
    const { graph, core, resolveModule } = startableCore()
    const channels: string[] = []
    core.events.on('connector:message', (ipc) => {
      channels.push((ipc.payload as ConnectorMessageEvent).message.channel)
    })
    const runtime = await new Supervisor(core.events).start(graph, resolveModule)

    const connector = new InMemoryConnector({ id: 'imp' })
    runtime.registerConnector(connector)
    await connector.open()
    runtime.bridgeConnector('imp')

    await connector.send({ id: 'm1', channel: 'sys', payload: 1 })
    expect(channels).toEqual(['sys'])
    await runtime.stop()
  })

  it('rejects a duplicate connector id with a connector error', async () => {
    const { graph, core, resolveModule } = startableCore()
    const runtime = await new Supervisor(core.events).start(graph, resolveModule)
    runtime.registerConnector(new InMemoryConnector({ id: 'dup' }))
    expect(() => runtime.registerConnector(new InMemoryConnector({ id: 'dup' }))).toThrow(
      DuplicateConnectorError,
    )
    await runtime.stop()
  })

  it('unregisters a connector and removes it from the runtime list', async () => {
    const { graph, core, resolveModule } = startableCore()
    const runtime = await new Supervisor(core.events).start(graph, resolveModule)
    runtime.registerConnector(new InMemoryConnector({ id: 'gone' }))
    expect(runtime.unregisterConnector('gone')).toBe(true)
    expect(runtime.connectors().map((c) => c.id)).toEqual([])
    await runtime.stop()
  })

  it('is unaffected by a product that declares no connectors', async () => {
    const { graph, core, resolveModule } = startableCore()
    const runtime = await new Supervisor(core.events).start(graph, resolveModule)
    expect(runtime.connectors()).toEqual([])
    await runtime.stop()
  })
})

// Yield a macrotask so microtask-only async chains (capability call -> reply
// send -> reply delivery) settle deterministically in tests.
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

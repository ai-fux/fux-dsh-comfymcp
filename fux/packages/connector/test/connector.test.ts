import { describe, expect, it } from 'vitest'
import {
  ConnectorNotFoundError,
  ConnectorRegistry,
  ConnectorStateError,
  DuplicateConnectorError,
  InMemoryConnector,
  type ConnectorMessage,
} from '../src/index.js'

const msg = (overrides: Partial<ConnectorMessage> = {}): ConnectorMessage => ({
  id: 'm1',
  channel: 'orders:new',
  payload: { order: 1 },
  ...overrides,
})

describe('InMemoryConnector state machine', () => {
  it('starts idle, moves through connecting to open, then closing to closed', async () => {
    const c = new InMemoryConnector({ id: 'c1' })
    expect(c.state).toBe('idle')
    await c.open()
    expect(c.state).toBe('open')
    await c.close()
    expect(c.state).toBe('closed')
  })

  it('reopens after a close (closed -> open)', async () => {
    const c = new InMemoryConnector({ id: 'c1' })
    await c.open()
    await c.close()
    await c.open()
    expect(c.state).toBe('open')
  })

  it('is idempotent when opened or closed twice', async () => {
    const c = new InMemoryConnector({ id: 'c1' })
    await c.open()
    await c.open()
    expect(c.state).toBe('open')
    await c.close()
    await c.close()
    expect(c.state).toBe('closed')
  })

  it('rejects a concurrent in-flight transition', async () => {
    const c = new InMemoryConnector({ id: 'c1' })
    const first = c.open()
    await expect(c.open()).rejects.toBeInstanceOf(ConnectorStateError)
    await first
    expect(c.state).toBe('open')
  })
})

describe('InMemoryConnector send / subscribe', () => {
  it('delivers a sent message to subscribers of the exact channel', async () => {
    const c = new InMemoryConnector({ id: 'c1' })
    await c.open()
    const got: ConnectorMessage[] = []
    c.subscribe('orders:new', (m) => got.push(m))
    const res = await c.send(msg())
    expect(res).toEqual({ ok: true, id: 'm1' })
    expect(got).toHaveLength(1)
    expect(got[0]?.payload).toEqual({ order: 1 })
  })

  it('delivers to wildcard subscribers but not other channels', async () => {
    const c = new InMemoryConnector({ id: 'c1' })
    await c.open()
    const wild: ConnectorMessage[] = []
    const other: ConnectorMessage[] = []
    c.subscribe('*', (m) => wild.push(m))
    c.subscribe('orders:old', (m) => other.push(m))
    await c.send(msg({ channel: 'orders:new' }))
    expect(wild).toHaveLength(1)
    expect(other).toHaveLength(0)
  })

  it('unsubscribing stops delivery', async () => {
    const c = new InMemoryConnector({ id: 'c1' })
    await c.open()
    let count = 0
    const off = c.subscribe('orders:new', () => count++)
    await c.send(msg({ id: 'a' }))
    off()
    await c.send(msg({ id: 'b' }))
    expect(count).toBe(1)
  })

  it('returns ok:false (and emits error) when sending while closed', async () => {
    const c = new InMemoryConnector({ id: 'c1' })
    const errors: unknown[] = []
    c.on('error', (e) => errors.push(e))
    const res = await c.send(msg())
    if (res.ok) throw new Error('expected send to fail while closed')
    expect(res.error).toBeInstanceOf(ConnectorStateError)
    expect(errors).toHaveLength(1)
  })

  it('does not emit an error on closed send when opted out', async () => {
    const c = new InMemoryConnector({ id: 'c1', errorOnClosedSend: false })
    const errors: unknown[] = []
    c.on('error', (e) => errors.push(e))
    const res = await c.send(msg())
    expect(res.ok).toBe(false)
    expect(errors).toHaveLength(0)
  })
})

describe('ConnectorRegistry registration', () => {
  it('registers, finds, lists and unregisters connectors', async () => {
    const reg = new ConnectorRegistry()
    const c = new InMemoryConnector({ id: 'c1' })
    reg.register(c)
    expect(reg.has('c1')).toBe(true)
    expect(reg.get('c1')).toBe(c)
    expect(reg.size).toBe(1)
    expect(reg.list().map((x) => x.id)).toEqual(['c1'])
    expect(reg.unregister('c1')).toBe(true)
    expect(reg.has('c1')).toBe(false)
    expect(reg.size).toBe(0)
  })

  it('rejects a duplicate id', () => {
    const reg = new ConnectorRegistry()
    reg.register(new InMemoryConnector({ id: 'c1' }))
    expect(() => reg.register(new InMemoryConnector({ id: 'c1' }))).toThrow(DuplicateConnectorError)
  })

  it('throws a connector-not-found error for unknown ids', async () => {
    const reg = new ConnectorRegistry()
    await expect(reg.open('missing')).rejects.toBeInstanceOf(ConnectorNotFoundError)
    await expect(reg.send('missing', msg())).rejects.toBeInstanceOf(ConnectorNotFoundError)
  })

  it('forwards open/close to the underlying connector', async () => {
    const reg = new ConnectorRegistry()
    const c = new InMemoryConnector({ id: 'c1' })
    reg.register(c)
    await reg.open('c1')
    expect(c.state).toBe('open')
    await reg.close('c1')
    expect(c.state).toBe('closed')
  })

  it('opens and closes every registered connector', async () => {
    const reg = new ConnectorRegistry()
    const a = new InMemoryConnector({ id: 'a' })
    const b = new InMemoryConnector({ id: 'b' })
    reg.register(a)
    reg.register(b)
    await reg.openAll()
    expect(a.state).toBe('open')
    expect(b.state).toBe('open')
    await reg.closeAll()
    expect(a.state).toBe('closed')
    expect(b.state).toBe('closed')
  })
})

describe('ConnectorRegistry events', () => {
  it('emits open/close lifecycle events through a sink', async () => {
    const received: string[] = []
    const reg = new ConnectorRegistry({
      eventSink: { emit: (e) => received.push(e.type) },
    })
    reg.register(new InMemoryConnector({ id: 'c1' }))
    await reg.open('c1')
    await reg.close('c1')
    expect(received).toEqual(['connector:open', 'connector:close'])
  })

  it('emits error events through a sink', async () => {
    const events: Array<{ type: string; error: unknown }> = []
    const reg = new ConnectorRegistry({
      eventSink: {
        emit: (e) =>
          events.push({
            type: e.type,
            error: e.type === 'connector:error' ? (e as { error: unknown }).error : undefined,
          }),
      },
    })
    reg.register(new InMemoryConnector({ id: 'c1' }))
    await reg.send('c1', msg()) // closed send -> error event
    expect(
      events.some((e) => e.type === 'connector:error' && e.error instanceof ConnectorStateError),
    ).toBe(true)
  })

  it('forwards messages bridged with bridgeMessages to the sink', async () => {
    const messages: ConnectorMessage[] = []
    const reg = new ConnectorRegistry({
      eventSink: {
        emit: (e) => {
          if (e.type === 'connector:message')
            messages.push((e as { message: ConnectorMessage }).message)
        },
      },
    })
    reg.register(new InMemoryConnector({ id: 'c1' }))
    reg.bridgeMessages('c1')
    await reg.open('c1')
    await reg.send('c1', msg({ channel: 'orders:new' }))
    expect(messages).toHaveLength(1)
    expect(messages[0]?.id).toBe('m1')
  })

  it('filters bridged messages by channel', async () => {
    const channels: string[] = []
    const reg = new ConnectorRegistry({
      eventSink: {
        emit: (e) => {
          if (e.type === 'connector:message')
            channels.push((e as { message: ConnectorMessage }).message.channel)
        },
      },
    })
    reg.register(new InMemoryConnector({ id: 'c1' }))
    reg.bridgeMessages('c1', 'orders:new')
    await reg.open('c1')
    await reg.send('c1', msg({ id: 'x', channel: 'orders:new' }))
    await reg.send('c1', msg({ id: 'y', channel: 'billing:x' }))
    expect(channels).toEqual(['orders:new'])
  })

  it('lets consumers subscribe to all or to a single event type', async () => {
    const reg = new ConnectorRegistry()
    reg.register(new InMemoryConnector({ id: 'c1' }))
    const all: string[] = []
    const onlyClose: string[] = []
    reg.on(undefined, (e) => all.push(e.type))
    reg.on('connector:close', (e) => onlyClose.push(e.type))
    await reg.open('c1')
    await reg.close('c1')
    expect(all).toContain('connector:open')
    expect(all).toContain('connector:close')
    expect(onlyClose).toEqual(['connector:close'])
  })

  it('unsubscribing stops listener notifications', async () => {
    const reg = new ConnectorRegistry()
    reg.register(new InMemoryConnector({ id: 'c1' }))
    const seen: string[] = []
    const off = reg.on(undefined, (e) => seen.push(e.type))
    off()
    await reg.open('c1')
    expect(seen).toHaveLength(0)
  })
})

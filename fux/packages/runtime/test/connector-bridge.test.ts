import { describe, expect, it } from 'vitest'
import { EventBus } from '@fux/core'
import { ConnectorRegistry, InMemoryConnector, type ConnectorEvent } from '@fux/connector'
import { createConnectorEventSink } from '../src/connector-bridge.js'

describe('createConnectorEventSink', () => {
  it('replays a connector:open event with topic = type and full event payload', () => {
    const events = new EventBus()
    let received: ConnectorEvent | undefined
    events.on('connector:open', (ipc) => {
      received = ipc.payload as ConnectorEvent
    })
    const sink = createConnectorEventSink(events)
    sink.emit({
      type: 'connector:open',
      connectorId: 'c1',
      occurredAt: 123,
    })
    expect(received?.type).toBe('connector:open')
    expect(received?.connectorId).toBe('c1')
    expect(received?.occurredAt).toBe(123)
  })

  it('attributes the connector id as the bus source', () => {
    const events = new EventBus()
    const sources: Array<string | undefined> = []
    events.on('connector:error', (ipc) => sources.push(ipc.source))
    createConnectorEventSink(events).emit({
      type: 'connector:error',
      connectorId: 'orders-out',
      error: new Error('boom'),
      occurredAt: 1,
    })
    expect(sources).toEqual(['orders-out'])
  })

  it('emits every connector event type on its matching topic', () => {
    const events = new EventBus()
    const topics: string[] = []
    events.on('*', (ipc) => topics.push(ipc.topic))
    const sink = createConnectorEventSink(events)
    const base = { connectorId: 'c1', occurredAt: 0 }
    sink.emit({ type: 'connector:open', ...base })
    sink.emit({ type: 'connector:close', ...base })
    sink.emit({ type: 'connector:error', ...base, error: 'x' })
    sink.emit({
      type: 'connector:message',
      ...base,
      message: { id: 'm', channel: 'orders:new', payload: 1 },
    })
    expect(topics).toEqual([
      'connector:open',
      'connector:close',
      'connector:error',
      'connector:message',
    ])
  })

  it('accepts an embedded Error instance without tripping the IpcEvent schema', () => {
    const events = new EventBus()
    expect(() => {
      createConnectorEventSink(events).emit({
        type: 'connector:error',
        connectorId: 'c1',
        error: new Error('boom'),
        occurredAt: 1,
      })
    }).not.toThrow()
  })
})

describe('wiring a real ConnectorRegistry onto the core bus', () => {
  it('surfaces lifecycle and bridged message events on the bus', async () => {
    const events = new EventBus()
    const received: Array<{ topic: string; payload: ConnectorEvent }> = []
    events.on('connector:open', (ipc) =>
      received.push({ topic: ipc.topic, payload: ipc.payload as ConnectorEvent }),
    )
    events.on('connector:message', (ipc) =>
      received.push({ topic: ipc.topic, payload: ipc.payload as ConnectorEvent }),
    )

    const registry = new ConnectorRegistry({ eventSink: createConnectorEventSink(events) })
    registry.register(new InMemoryConnector({ id: 'c1' }))
    registry.bridgeMessages('c1')
    await registry.open('c1')
    await registry.send('c1', { id: 'm1', channel: 'orders:new', payload: { order: 1 } })

    expect(received.map((r) => r.topic)).toEqual(['connector:open', 'connector:message'])
    expect(received[0]?.payload.type).toBe('connector:open')
    const messageEvent = received[1]?.payload
    expect(messageEvent?.type === 'connector:message' && messageEvent.message.id).toBe('m1')
  })

  it('does not put connector events on the bus without a bridge', async () => {
    const events = new EventBus()
    const registry = new ConnectorRegistry()
    let busCount = 0
    events.on('*', () => busCount++)
    registry.register(new InMemoryConnector({ id: 'c1' }))
    // no bridge sink attached — open is not observable on the core bus
    await registry.open('c1')
    expect(registry.size).toBe(1) // registry remains functional and isolated
    expect(busCount).toBe(0)
  })
})

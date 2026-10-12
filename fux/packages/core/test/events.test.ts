import { describe, expect, it, vi } from 'vitest'
import { createChannel, EventBus } from '../src/events.js'

describe('EventBus', () => {
  it('delivers events to exact subscribers', () => {
    const bus = new EventBus()
    const handler = vi.fn()
    bus.on('app:ready', handler)

    const event = bus.emit('app:ready', { ok: true }, '@fux/example-app')
    expect(handler).toHaveBeenCalledExactlyOnceWith(event)
    expect(event.topic).toBe('app:ready')
    expect(event.source).toBe('@fux/example-app')
    expect(typeof event.occurredAt).toBe('number')
  })

  it('does not deliver events across topics', () => {
    const bus = new EventBus()
    const handler = vi.fn()
    bus.on('app:ready', handler)
    bus.emit('app:done')
    expect(handler).not.toHaveBeenCalled()
  })

  it('supports wildcard subscription', () => {
    const bus = new EventBus()
    const handler = vi.fn()
    bus.on('*', handler)
    bus.emit('app:ready')
    bus.emit('app:done')
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('unsubscribes via the returned disposer', () => {
    const bus = new EventBus()
    const handler = vi.fn()
    const dispose = bus.on('app:ready', handler)
    dispose()
    bus.emit('app:ready')
    expect(handler).not.toHaveBeenCalled()
    expect(bus.listenerCount('app:ready')).toBe(0)
  })

  it('isolates handler failures from other subscribers', () => {
    const bus = new EventBus()
    const good = vi.fn()
    const bad = vi.fn(() => {
      throw new Error('boom')
    })
    bus.on('app:ready', bad)
    bus.on('app:ready', good)

    expect(() => bus.emit('app:ready')).not.toThrow()
    expect(good).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ topic: 'app:ready' }))
  })

  it('rejects malformed topics', () => {
    const bus = new EventBus()
    expect(() => bus.emit('not-a-topic')).toThrow(TypeError)
  })

  it('counts listeners and clears all subscriptions', () => {
    const bus = new EventBus()
    bus.on('a:b', () => {})
    bus.on('a:b', () => {})
    bus.on('*', () => {})
    expect(bus.listenerCount()).toBe(3)
    expect(bus.listenerCount('a:b')).toBe(2)
    bus.clear()
    expect(bus.listenerCount()).toBe(0)
  })

  it('off returns false for unknown handlers', () => {
    const bus = new EventBus()
    expect(bus.off('a:b', () => {})).toBe(false)
  })
})

describe('EventBus unified event schema stamping (BR-04)', () => {
  it('stamps schemaVersion on a known-kind topic', () => {
    const bus = new EventBus()
    const event = bus.emit('connector:open')
    expect(event.schemaVersion).toBe(1)
  })

  it('keeps legacy topics unstamped (old fields stay readable)', () => {
    const bus = new EventBus()
    const event = bus.emit('app:ready', { ok: true })
    expect(event.topic).toBe('app:ready')
    expect(event.payload).toEqual({ ok: true })
    expect(event.schemaVersion).toBeUndefined()
  })

  it('delivers the stamped event to subscribers', () => {
    const bus = new EventBus()
    const handler = vi.fn()
    bus.on('connector:message', handler)
    bus.emit('connector:message', { type: 'connector:message', connectorId: 'c1' })
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'connector:message', schemaVersion: 1 }),
    )
  })

  it('propagates stamping through createChannel', () => {
    const bus = new EventBus()
    const channel = createChannel(bus)
    const event = channel.emit('connector:error')
    expect(event.schemaVersion).toBe(1)
  })
})

describe('createChannel (FR-01)', () => {
  it('mirrors EventBus semantics without a persistence sink', () => {
    const channel = createChannel(new EventBus())
    const handler = vi.fn()
    channel.on('app:ready', handler)
    channel.emit('app:ready', { ok: true }, 'src')
    expect(handler).toHaveBeenCalledTimes(1)
    expect(channel.listenerCount('app:ready')).toBe(1)
    channel.clear()
    expect(channel.listenerCount()).toBe(0)
  })

  it('forwards emitted events to a persistence sink', () => {
    const appended: unknown[] = []
    const channel = createChannel(new EventBus(), {
      persistence: { append: (event) => void appended.push(event) },
    })
    channel.emit('app:ready', { ok: true })
    expect(appended).toHaveLength(1)
    expect((appended[0] as { topic: string }).topic).toBe('app:ready')
  })

  it('keeps dispatching when a synchronous sink throws', () => {
    const handler = vi.fn()
    const bus = new EventBus()
    bus.on('app:ready', handler)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const failing = createChannel(bus, {
        persistence: {
          append: () => {
            throw new Error('disk full')
          },
        },
      })
      expect(() => failing.emit('app:ready')).not.toThrow()
      expect(handler).toHaveBeenCalledTimes(1)
      expect(error).toHaveBeenCalled()
    } finally {
      error.mockRestore()
    }
  })

  it('does not fail emit when an async sink rejects', async () => {
    const handler = vi.fn()
    const bus = new EventBus()
    bus.on('app:ready', handler)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const channel = createChannel(bus, {
      persistence: {
        append: async () => {
          throw new Error('backend down')
        },
      },
    })
    channel.emit('app:ready')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(handler).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})

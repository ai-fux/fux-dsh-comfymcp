import { IpcEventSchema, stampSchemaVersion, type IpcEvent } from '@fux/protocol'

export type EventHandler = (event: IpcEvent) => void

export const WILDCARD_TOPIC = '*'

// FR-01: optional durability sink for a unified event channel. Writes are a
// side effect; a failure here must never break in-memory dispatch.
export interface PersistenceSink {
  append(event: IpcEvent): Promise<void> | void
}

// FR-01: unified event channel abstraction wrapping an EventBus with an
// optional persistence hook. Every method preserves EventBus semantics.
export interface EventChannel {
  on(topic: string, handler: EventHandler): () => void
  off(topic: string, handler: EventHandler): boolean
  emit(topic: string, payload?: unknown, source?: string): IpcEvent
  listenerCount(topic?: string): number
  clear(): void
}

export class EventBus {
  private readonly handlers = new Map<string, Set<EventHandler>>()

  on(topic: string, handler: EventHandler): () => void {
    let set = this.handlers.get(topic)
    if (!set) {
      set = new Set()
      this.handlers.set(topic, set)
    }
    set.add(handler)
    return () => this.off(topic, handler)
  }

  off(topic: string, handler: EventHandler): boolean {
    return this.handlers.get(topic)?.delete(handler) ?? false
  }

  emit(topic: string, payload?: unknown, source?: string): IpcEvent {
    // BR-04: stamp the unified schema version for known topics. Purely additive
    // (a new `schemaVersion` field); legacy readers still see the event as-is.
    const stamp = stampSchemaVersion({ topic, payload, source, occurredAt: Date.now() })
    const parsed = IpcEventSchema.safeParse(stamp)
    if (!parsed.success) {
      throw new TypeError(
        `invalid event: ${topic} (${parsed.error.issues[0]?.message ?? 'unknown'})`,
      )
    }

    for (const handler of this.subscribersFor(topic)) {
      try {
        handler(stamp)
      } catch (error) {
        console.error(`[fux:events] handler failed for topic "${topic}"`, error)
      }
    }
    return stamp
  }

  listenerCount(topic?: string): number {
    if (topic !== undefined) return this.handlers.get(topic)?.size ?? 0
    let total = 0
    for (const set of this.handlers.values()) total += set.size
    return total
  }

  clear(): void {
    this.handlers.clear()
  }

  private *subscribersFor(topic: string): Iterable<EventHandler> {
    const exact = this.handlers.get(topic)
    if (exact) yield* exact
    if (topic !== WILDCARD_TOPIC) {
      const wildcard = this.handlers.get(WILDCARD_TOPIC)
      if (wildcard) yield* wildcard
    }
  }
}

// FR-01: build a unified EventChannel over a bus. Without a persistence sink
// the channel behaves exactly like the underlying EventBus.
export function createChannel(
  bus: EventBus,
  options: { persistence?: PersistenceSink } = {},
): EventChannel {
  const persistence = options.persistence
  return {
    on: (topic, handler) => bus.on(topic, handler),
    off: (topic, handler) => bus.off(topic, handler),
    emit: (topic, payload, source) => {
      const event = bus.emit(topic, payload, source)
      if (persistence) {
        try {
          const result = persistence.append(event)
          if (
            result &&
            typeof result === 'object' &&
            typeof (result as Promise<void>).catch === 'function'
          ) {
            void (result as Promise<void>).catch((error) =>
              console.error('[fux:events] persistence append failed', error),
            )
          }
        } catch (error) {
          console.error('[fux:events] persistence append failed', error)
        }
      }
      return event
    },
    listenerCount: (topic) => bus.listenerCount(topic),
    clear: () => bus.clear(),
  }
}

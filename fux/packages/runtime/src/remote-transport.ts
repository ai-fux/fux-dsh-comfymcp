import type { IpcEvent, IpcResponse } from '@fux/protocol'

/**
 * G1: the transport abstraction a `remote` execution host talks over. The host is
 * transport-agnostic (it proxies capability invokes + forward/collect events);
 * the concrete wire transport is supplied by the caller. `LoopbackRemoteTransport`
 * is a reference that completes the contract in-process (tests / single-host
 * demos); real HTTP/WS/SSE wire transports land in the G2 change.
 */
export interface RemoteCallRequest {
  readonly id: string
  readonly capability: string
  readonly payload?: unknown
}

export interface RemoteTransport {
  readonly mode: 'remote'
  open(): Promise<void>
  close(): Promise<void>
  call(request: RemoteCallRequest): Promise<IpcResponse>
  /** Far-side events are surfaced to the host so they reach the core bus. */
  onEvent(handler: (event: IpcEvent) => void): () => void
  /** The far side reports which capabilities it can serve (best-effort). */
  onCapabilities(handler: (capabilities: string[]) => void): () => void
  /**
   * G1 强化: optional — a transport may report an unexpected far-side
   * disconnect (SSE stream dropped, peer gone) so the host can mark itself
   * broken instead of letting calls hang. Transports that cannot observe death
   * simply omit it.
   */
  onDisconnect?(handler: (reason?: unknown) => void): () => void
}

export type LoopbackHandler = (request: RemoteCallRequest) => IpcResponse | Promise<IpcResponse>

/**
 * A remote transport whose far side is reached in the same transport instance.
 * `setFarSide()` wires the responder; collected events / capability lists are
 * replayed to the host. This is the concrete reference that makes `remote` mode
 * fully runnable without any network.
 */
export class LoopbackRemoteTransport implements RemoteTransport {
  readonly mode = 'remote' as const

  private farSide?: LoopbackHandler
  private opened = false
  private eventHandlers = new Set<(event: IpcEvent) => void>()
  private capabilityHandlers = new Set<(capabilities: string[]) => void>()
  private disconnectHandlers = new Set<(reason?: unknown) => void>()
  private readonly queuedEvents: IpcEvent[] = []
  private readonly queuedCapabilities: string[][] = []

  async open(): Promise<void> {
    this.opened = true
    this.replayQueued()
  }

  async close(): Promise<void> {
    this.opened = false
  }

  setFarSide(handler: LoopbackHandler): void {
    this.farSide = handler
  }

  async call(request: RemoteCallRequest): Promise<IpcResponse> {
    if (!this.farSide) {
      return {
        id: request.id,
        ok: false,
        error: {
          code: 'E_PLUGIN_CRASHED',
          message: 'remote far side is not reachable',
          retryable: true,
        },
      }
    }
    try {
      return await this.farSide(request)
    } catch (error) {
      return {
        id: request.id,
        ok: false,
        error: {
          code: 'E_PLUGIN_ERROR',
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        },
      }
    }
  }

  onEvent(handler: (event: IpcEvent) => void): () => void {
    this.eventHandlers.add(handler)
    if (this.opened) for (const event of this.queuedEvents) handler(event)
    return () => this.eventHandlers.delete(handler)
  }

  onCapabilities(handler: (capabilities: string[]) => void): () => void {
    this.capabilityHandlers.add(handler)
    if (this.opened) for (const caps of this.queuedCapabilities) handler(caps)
    return () => this.capabilityHandlers.delete(handler)
  }

  onDisconnect(handler: (reason?: unknown) => void): () => void {
    this.disconnectHandlers.add(handler)
    return () => this.disconnectHandlers.delete(handler)
  }

  /** Simulate an unexpected far-side disconnect (used by hosts / tests). */
  pushDisconnect(reason?: unknown): void {
    for (const handler of this.disconnectHandlers) handler(reason)
  }

  /** Far side pushes an event; delivered now or on next `open()`. */
  pushEvent(event: IpcEvent): void {
    if (this.opened) for (const handler of this.eventHandlers) handler(event)
    else this.queuedEvents.push(event)
  }

  /** Far side reports its capabilities; delivered now or on next `open()`. */
  pushCapabilities(capabilities: string[]): void {
    if (this.opened) for (const handler of this.capabilityHandlers) handler(capabilities)
    else this.queuedCapabilities.push(capabilities)
  }

  private replayQueued(): void {
    for (const event of this.queuedEvents.splice(0)) {
      for (const handler of this.eventHandlers) handler(event)
    }
    for (const caps of this.queuedCapabilities.splice(0)) {
      for (const handler of this.capabilityHandlers) handler(caps)
    }
  }
}

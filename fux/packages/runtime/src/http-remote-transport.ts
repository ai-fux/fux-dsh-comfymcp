import type { IpcErrorCode, IpcEvent, IpcResponse } from '@fux/protocol'
import type { RemoteCallRequest, RemoteTransport } from './remote-transport.js'

/**
 * G2: a concrete, real-network `RemoteTransport` speaking an HTTP/JSON wire
 * protocol. The endpoint side is `startRemoteEndpoint` in `http-remote-endpoint.ts`.
 *
 * Wire contract (request/response both `application/json`):
 *   GET  /capabilities -> { capabilities: string[] }
 *   POST /invoke       -> `RemoteCallRequest`, answers `IpcResponse`
 *   GET  /events       -> SSE stream: `data: <IpcEvent JSON>` lines (kept open)
 *
 * The transport is dependency-free (Node global `fetch`), so it bridges the two
 * sides (client `RemoteHost` <-> endpoint) with no new runtime dependencies.
 */
export interface HttpRemoteTransportOptions {
  /** Base URL of the remote endpoint, e.g. `http://127.0.0.1:3987`. */
  url: string
  /** Inject a fetch for tests; defaults to the global `fetch`. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>
}

export class HttpRemoteTransport implements RemoteTransport {
  readonly mode = 'remote' as const

  private readonly baseUrl: string
  private readonly doFetch: (input: string, init?: RequestInit) => Promise<Response>
  private opened = false
  private abort?: AbortController
  private eventHandlers = new Set<(event: IpcEvent) => void>()
  private capabilityHandlers = new Set<(capabilities: string[]) => void>()
  private disconnectHandlers = new Set<(reason?: unknown) => void>()
  private capabilities: string[] = []

  constructor(options: HttpRemoteTransportOptions) {
    this.baseUrl = options.url.replace(/\/+$/, '')
    this.doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  }

  async open(): Promise<void> {
    this.opened = true
    // Populate capabilities from the endpoint (best-effort; a non-2xx simply
    // leaves them empty until `onCapabilities` replays a later report).
    try {
      const res = await this.doFetch(`${this.baseUrl}/capabilities`)
      if (res.ok) {
        const data = (await res.json()) as { capabilities?: unknown }
        if (Array.isArray(data.capabilities)) {
          this.capabilities = data.capabilities.filter((c): c is string => typeof c === 'string')
          for (const handler of this.capabilityHandlers) handler(this.capabilities)
        }
      }
    } catch {
      // non-fatal: capabilities are best-effort
    }
    this.startEventStream()
  }

  async close(): Promise<void> {
    this.opened = false
    this.abort?.abort()
    this.abort = undefined
  }

  async call(request: RemoteCallRequest): Promise<IpcResponse> {
    try {
      const res = await this.doFetch(`${this.baseUrl}/invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal: this.abort?.signal,
      })
      if (!res.ok) {
        // The endpoint answers handler failures with an IpcResponse body; fall
        // back to a generic message when that body is absent/unparseable.
        try {
          const payload = (await res.json()) as unknown
          const normalized = normalizeResponse(request.id, payload)
          if (!normalized.ok && normalized.error.message !== 'unknown remote error') {
            return normalized
          }
        } catch {
          // fall through to the generic failure below
        }
        return {
          id: request.id,
          ok: false,
          error: {
            code: 'E_PLUGIN_CRASHED',
            message: `remote invoke failed (HTTP ${res.status})`,
            retryable: true,
          },
        }
      }
      const payload = (await res.json()) as unknown
      return normalizeResponse(request.id, payload)
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError'
      return {
        id: request.id,
        ok: false,
        error: {
          code: 'E_PLUGIN_CRASHED',
          message: aborted
            ? 'remote invoke aborted'
            : error instanceof Error
              ? error.message
              : String(error),
          retryable: !aborted,
        },
      }
    }
  }

  onEvent(handler: (event: IpcEvent) => void): () => void {
    this.eventHandlers.add(handler)
    return () => this.eventHandlers.delete(handler)
  }

  onCapabilities(handler: (capabilities: string[]) => void): () => void {
    this.capabilityHandlers.add(handler)
    if (this.opened && this.capabilities.length > 0) handler(this.capabilities)
    return () => this.capabilityHandlers.delete(handler)
  }

  onDisconnect(handler: (reason?: unknown) => void): () => void {
    this.disconnectHandlers.add(handler)
    return () => this.disconnectHandlers.delete(handler)
  }

  private startEventStream(): void {
    this.abort?.abort()
    this.abort = new AbortController()
    void (async () => {
      try {
        const res = await this.doFetch(`${this.baseUrl}/events`, {
          signal: this.abort?.signal,
        })
        if (!res.ok || !res.body) return
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let nl: number
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl)
            buffer = buffer.slice(nl + 1)
            if (!line.startsWith('data: ')) continue
            const json = line.slice(6).trim()
            if (!json) continue
            try {
              const event = JSON.parse(json) as IpcEvent
              for (const handler of this.eventHandlers) handler(event)
            } catch {
              // skip malformed frame
            }
          }
        }
        // G1 强化: the stream ended without an explicit close() — the far side
        // is gone (or its SSE channel dropped), so report the disconnect.
        if (this.opened) this.notifyDisconnect('event stream ended')
      } catch {
        // G1 强化: closed during teardown (abort) is not a disconnect; any
        // other failure of an established stream means the far side is down.
        if (this.opened) this.notifyDisconnect('event stream failed')
      }
    })()
  }

  private notifyDisconnect(reason: unknown): void {
    for (const handler of this.disconnectHandlers) handler(reason)
  }
}

function normalizeResponse(id: string, payload: unknown): IpcResponse {
  const p = payload as Partial<IpcResponse> & { ok?: unknown; id?: unknown }
  if (typeof p !== 'object' || p === null || p.id !== id || typeof p.ok !== 'boolean') {
    return {
      id,
      ok: false,
      error: { code: 'E_INTERNAL', message: 'malformed remote response', retryable: false },
    }
  }
  if (p.ok) return { id, ok: true, ...(p.result !== undefined ? { result: p.result } : {}) }
  const err = (p as { error?: { code?: unknown; message?: unknown; retryable?: unknown } }).error
  return {
    id,
    ok: false,
    error: {
      code: typeof err?.code === 'string' ? (err.code as IpcErrorCode) : 'E_INTERNAL',
      message: typeof err?.message === 'string' ? err.message : 'unknown remote error',
      retryable: err?.retryable === true,
    },
  }
}

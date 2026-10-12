import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { type AddressInfo } from 'node:net'
import { FUX_PROTOCOL_VERSION, type IpcEvent, type IpcResponse } from '@fux/protocol'
import type { HealthStatus } from './health.js'
import type { RemoteCallRequest } from './remote-transport.js'

/**
 * G2: server side of the HTTP/JSON wire transport. It services the endpoint a
 * `HttpRemoteTransport` (client) talks to:
 *   GET  /capabilities -> { capabilities: string[] }
 *   POST /invoke       -> routes a `RemoteCallRequest` to `options.handler`,
 *                         answers the `IpcResponse` it returns
 *   GET  /events       -> SSE stream that delivers `data: <IpcEvent>` lines
 *   GET  /health       -> G4: identity + health handshake answered by the app's
 *                         optional `health` provider (default `ok`)
 * The handler is supplied by the app (typically `(req) => broker.call(...)`), so
 * the base kernel只搬数据不固化业务语义.
 */
export interface RemoteEndpointHandler {
  (request: RemoteCallRequest): IpcResponse | Promise<IpcResponse>
}

export interface RemoteEndpointOptions {
  /** Resolve a remote invoke; e.g. call a local broker/host for the plugin. */
  handler: RemoteEndpointHandler
  /** Capabilities this endpoint can serve (reported via /capabilities). */
  capabilities?: string[]
  host?: string
  port?: number
  /** G4: stable node identity advertised via /health. Defaults to the endpoint url. */
  nodeId?: string
  /** G4: optional health status provider for /health (default 'ok'). */
  health?: () => HealthStatus | Promise<HealthStatus>
}

export interface RemoteEndpoint {
  readonly url: string
  pushEvent(event: IpcEvent): void
  setCapabilities(capabilities: string[]): void
  close(): Promise<void>
}

export async function startRemoteEndpoint(options: RemoteEndpointOptions): Promise<RemoteEndpoint> {
  const handler = options.handler
  let capabilities = [...(options.capabilities ?? [])]
  const health = options.health ?? (() => 'ok' as const)
  const startedAt = Date.now()
  const clients = new Set<ServerResponse>()
  // Keep a small replay buffer so events pushed before a client's SSE request
  // lands are not lost — same contract as the loopback reference transport.
  const recentEvents: IpcEvent[] = []
  const MAX_REPLAY = 100

  const server = createServer((req, res) => {
    void dispatch(req, res).catch((error) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
      }
      res.end(
        JSON.stringify(
          failureResponse('E_INTERNAL', error instanceof Error ? error.message : String(error)),
        ),
      )
    })
  })

  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = (req.url ?? '').split('?')[0]

    if (req.method === 'GET' && pathname === '/capabilities') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ capabilities }))
      return
    }

    if (req.method === 'GET' && pathname === '/health') {
      // G4 health handshake: identity + liveness + served capabilities. The
      // status is app-supplied (default 'ok'); the nodeId falls back to the url.
      const status = await health()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          nodeId,
          status,
          capabilities,
          uptimeMs: Date.now() - startedAt,
          protocolVersion: FUX_PROTOCOL_VERSION,
        }),
      )
      return
    }

    if (req.method === 'POST' && pathname === '/invoke') {
      const request = normalizeRequest(await readJson<Partial<RemoteCallRequest>>(req))
      let response: IpcResponse
      try {
        response = await handler(request)
      } catch (error) {
        response = {
          id: request.id,
          ok: false,
          error: {
            code: 'E_INTERNAL',
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
          },
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(response))
      return
    }

    if (req.method === 'GET' && pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.flushHeaders()
      for (const event of recentEvents) {
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      }
      req.on('close', () => {
        clients.delete(res)
      })
      clients.add(res)
      return
    }

    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
      resolve()
    })
  })

  const address = server.address() as AddressInfo
  const url = `http://${options.host ?? '127.0.0.1'}:${address.port}`
  // The default node identity cannot be known until the port is bound.
  const nodeId = options.nodeId ?? url

  return {
    url,
    pushEvent(event) {
      recentEvents.push(event)
      if (recentEvents.length > MAX_REPLAY) recentEvents.shift()
      const frame = `data: ${JSON.stringify(event)}\n\n`
      for (const client of clients) {
        if (!client.writableEnded) client.write(frame)
      }
    },
    setCapabilities(next) {
      capabilities = [...next]
    },
    async close() {
      for (const client of clients) {
        client.destroy()
      }
      clients.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

function normalizeRequest(body: Partial<RemoteCallRequest>): RemoteCallRequest {
  return {
    id: typeof body.id === 'string' ? body.id : 'req-unknown',
    capability: typeof body.capability === 'string' ? body.capability : '',
    ...(body.payload === undefined ? {} : { payload: body.payload }),
  }
}

function failureResponse(
  code: string,
  message: string,
): { id: string; ok: false; error: { code: string; message: string } } {
  // Dispatch-level failures (bad route / body parse) carry no request id; the
  // invoke route itself returns a correlated failure via its own try/catch.
  return { id: 'req-unknown', ok: false, error: { code, message } }
}

function readJson<T>(req: IncomingMessage): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve((raw ? JSON.parse(raw) : {}) as T)
      } catch (error) {
        reject(
          new Error(`invalid JSON body: ${error instanceof Error ? error.message : String(error)}`),
        )
      }
    })
    req.on('error', reject)
  })
}

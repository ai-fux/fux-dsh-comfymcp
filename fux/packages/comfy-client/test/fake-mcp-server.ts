/**
 * A conformant fake comfy-mcp server (MCP Streamable HTTP) for tests.
 *
 * Scripted per test: the handler receives parsed JSON-RPC requests plus the
 * raw request (for session-header assertions) and answers with plain JSON or
 * an SSE stream. Session semantics match the protocol: `initialize` mints a
 * `Mcp-Session-Id`; later calls with a wrong header get 404.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'

export interface FakeRequest {
  readonly body: Record<string, unknown>
  readonly req: IncomingMessage
  readonly res: ServerResponse
}

export interface FakeServerHandle {
  readonly server: Server
  url: string
  /** Every parsed JSON-RPC request, in arrival order. */
  readonly requests: FakeRequest[]
  close(): Promise<void>
}

export type FakeHandler = (request: FakeRequest) => void

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString()
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

export function startFakeMcpServer(handler: FakeHandler): Promise<FakeServerHandle> {
  const server = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req)
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(raw) as Record<string, unknown>
      } catch {
        body = {}
      }
      const request: FakeRequest = { body, req, res }
      handle.requests.push(request)
      handler(request)
    })().catch((error) => {
      res.statusCode = 500
      res.end(String(error))
    })
  })
  const handle: FakeServerHandle = {
    server,
    url: '',
    requests: [],
    close: async () => {
      server.close()
      await once(server, 'close')
    },
  }
  return new Promise((resolveHandle, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('fake server has no port'))
        return
      }
      handle.url = `http://127.0.0.1:${address.port}/mcp`
      resolveHandle(handle)
    })
  })
}

/** Standard session-aware handler factory covering the common flows. */
export function scriptedHandler(options: {
  /** Called for tools/call; returns the MCP result object. */
  onCall?: (name: string, args: Record<string, unknown>, request: FakeRequest) => unknown
  tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>
  /** How tools/call answers: 'json' (default) or 'sse'. */
  callMode?: 'json' | 'sse'
  serverName?: string
  /** GET routes answered before JSON-RPC dispatch (artifact bytes). */
  onGet?: (url: string, res: ServerResponse) => boolean
}): FakeHandler {
  let session = 0
  return (request) => {
    const { body, req, res } = request
    if (req.method === 'GET') {
      if (options.onGet?.(req.url ?? '', res) === true) return
      res.statusCode = 404
      res.end('not found')
      return
    }
    const method = String(body['method'] ?? '')
    const id = body['id']
    if (method === 'initialize') {
      session += 1
      res.setHeader('mcp-session-id', `session-${session}`)
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2025-03-26',
            serverInfo: { name: options.serverName ?? 'fake-comfy-mcp', version: '0.1.0' },
          },
        }),
      )
      return
    }
    if (method === 'notifications/initialized') {
      res.statusCode = 202
      res.end()
      return
    }
    const header = req.headers['mcp-session-id']
    const expected = `session-${session}`
    if (header !== expected) {
      res.statusCode = 404
      res.end('session not found')
      return
    }
    if (method === 'tools/list') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { tools: options.tools ?? [] } }))
      return
    }
    if (method === 'tools/call') {
      const params = (body['params'] ?? {}) as Record<string, unknown>
      const result = options.onCall?.(String(params['name'] ?? ''), (params['arguments'] ?? {}) as Record<string, unknown>, request)
      if (options.callMode === 'sse') {
        res.setHeader('content-type', 'text/event-stream')
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`)
        res.end()
        return
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }))
      return
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } }))
  }
}

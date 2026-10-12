/**
 * comfy-mcp 参考服务端：MCP Streamable HTTP ⇄ stdio/mock 后端。
 *
 * - POST {path}：`initialize`（发会话）→ JSON；`notifications/*` → 202；
 *   `tools/list` / `tools/call` / `ping` → 代理到后端；未知会话 → 404。
 * - GET {path}（SSE 语义本实现不推送流式中间帧，单帧 JSON 应答即合规）。
 * - GET /artifacts/<id>：成果物字节流（协议 §2）。
 * - GET /health：运维探针。
 *
 * 响应一律 `application/json`（协议允许服务端二选一；客户端两种都必须支持）。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import { contentTypeFor, ArtifactStore } from './artifacts-store.js'
import { resolveServerConfig, mockStageDir } from './config.js'
import { MockBackend } from './mock-backend.js'
import { StdioBackend } from './backend.js'
import type { ComfyMcpServerConfig, McpBackend } from './types.js'
import { injectArtifacts } from './wrap.js'

const MAX_BODY_BYTES = 8 * 1024 * 1024

interface Session {
  readonly token: string
  createdAt: number
}

export interface ComfyMcpServerHandle {
  readonly server: Server
  readonly config: ComfyMcpServerConfig
  readonly store: ArtifactStore
  readonly url: string
  status(): Record<string, unknown>
  stop(): Promise<void>
}

export interface CreateServerOptions {
  readonly config?: ComfyMcpServerConfig
  readonly env?: Record<string, string | undefined>
  readonly backend?: McpBackend
  readonly store?: ArtifactStore
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let data = ''
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString()
      if (data.length > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
      }
    })
    req.on('end', () => resolveBody(data))
    req.on('error', reject)
  })
}

function json(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value)
  res.end(body)
}

export async function createComfyMcpServer(options: CreateServerOptions = {}): Promise<ComfyMcpServerHandle> {
  const config = options.config ?? resolveServerConfig(options.env ?? process.env)
  const store = options.store ?? new ArtifactStore()
  const backend: McpBackend =
    options.backend ??
    (config.backendKind === 'mock'
      ? new MockBackend(mockStageDir(options.env ?? process.env))
      : new StdioBackend({
          command: config.backendCommand,
          args: config.backendArgs,
          requestTimeoutMs: config.callTimeoutMs,
          logger: { error: (message) => process.stderr.write(`comfy-mcp-server: ${message}\n`) },
        }))

  const sessions = new Map<string, Session>()
  const startedAt = Date.now()

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) })
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, {
        ok: true,
        uptimeMs: Date.now() - startedAt,
        backend: backend.kind,
        artifacts: store.size,
        sessions: sessions.size,
      })
      return
    }
    if (req.method === 'GET' && url.pathname.startsWith('/artifacts/')) {
      await serveArtifact(url.pathname.slice('/artifacts/'.length), res)
      return
    }
    if (req.method === 'POST' && url.pathname === config.path) {
      await handlePost(req, res)
      return
    }
    json(res, 404, { error: `no route: ${req.method} ${url.pathname}` })
  }

  async function serveArtifact(id: string, res: ServerResponse): Promise<void> {
    const entry = store.get(id)
    if (entry === undefined) {
      json(res, 404, { error: 'artifact not found (expired or unknown id)' })
      return
    }
    try {
      const stats = statSync(entry.path)
      res.statusCode = 200
      res.setHeader('content-type', contentTypeFor(entry.filename))
      res.setHeader('content-length', stats.size)
      const stream = createReadStream(entry.path)
      stream.on('error', () => {
        if (!res.headersSent) json(res, 500, { error: 'artifact read failed' })
        else res.destroy()
      })
      stream.pipe(res)
    } catch {
      json(res, 404, { error: 'artifact file is gone' })
    }
  }

  async function handlePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req)
    let message: Record<string, unknown>
    try {
      message = JSON.parse(raw) as Record<string, unknown>
    } catch {
      json(res, 400, { error: 'invalid JSON body' })
      return
    }
    const method = typeof message['method'] === 'string' ? message['method'] : ''
    const id = message['id']

    if (method === 'initialize') {
      const token = randomUUID()
      sessions.set(token, { token, createdAt: Date.now() })
      json(
        res,
        200,
        {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2025-03-26',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: config.serverName, version: config.serverVersion },
            ...(config.instructions.length > 0 ? { instructions: config.instructions } : {}),
          },
        },
        { 'mcp-session-id': token },
      )
      return
    }

    if (method.startsWith('notifications/')) {
      res.statusCode = 202
      res.end()
      return
    }

    const sessionToken = req.headers['mcp-session-id']
    const token = Array.isArray(sessionToken) ? sessionToken[0] : sessionToken
    if (typeof token !== 'string' || !sessions.has(token)) {
      json(res, 404, { jsonrpc: '2.0', id: id ?? null, error: { code: -32001, message: 'unknown or expired session' } })
      return
    }
    sessions.get(token)!.createdAt = Date.now()

    try {
      if (method === 'tools/list') {
        const tools = await backend.listTools()
        json(res, 200, { jsonrpc: '2.0', id, result: { tools } })
        return
      }
      if (method === 'tools/call') {
        const params = (message['params'] ?? {}) as Record<string, unknown>
        const name = String(params['name'] ?? '')
        const args = (params['arguments'] ?? undefined) as Record<string, unknown> | undefined
        const outcome = await backend.callTool(name, args)
        const structured =
          outcome.structuredContent ??
          (typeof (outcome.content ?? []).find((block) => block.type === 'text')?.text === 'string'
            ? safeParse((outcome.content ?? []).find((block) => block.type === 'text')!.text!)
            : undefined)
        const data =
          structured !== undefined && typeof structured === 'object'
            ? (structured as Record<string, unknown>)
            : { text: typeof structured === 'string' ? structured : '' }
        const wrapped = injectArtifacts(data, store, config.maxArtifactsPerResult)
        const result: Record<string, unknown> = {
          content: outcome.content ?? [],
          isError: outcome.isError === true,
          structuredContent: wrapped.data,
        }
        json(res, 200, { jsonrpc: '2.0', id, result })
        return
      }
      if (method === 'ping') {
        json(res, 200, { jsonrpc: '2.0', id, result: {} })
        return
      }
      json(res, 200, {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `method not found: ${method}` },
      })
    } catch (error) {
      json(res, 200, {
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
      })
    }
  }

  function safeParse(text: string): unknown {
    try {
      return JSON.parse(text) as unknown
    } catch {
      return text
    }
  }

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(config.port, config.host, () => resolveListen())
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : config.port

  return {
    server,
    config,
    store,
    url: `http://${config.host}:${port}${config.path}`,
    status() {
      return {
        ok: true,
        url: `http://${config.host}:${port}${config.path}`,
        backend: backend.kind,
        artifacts: store.size,
        sessions: sessions.size,
        uptimeMs: Date.now() - startedAt,
      }
    },
    async stop() {
      await backend.stop()
      server.close()
    },
  }
}

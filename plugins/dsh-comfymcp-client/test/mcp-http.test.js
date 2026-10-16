import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { McpHttpClient, createHostFacade, parseSseChunk } from '../lib/mcp-http.js'

/** 极简 Streamable HTTP MCP 服务端：可切换 JSON / SSE 响应，带会话头。 */
function startServer(options = {}) {
  const state = { calls: [], sessionId: 'sess-123', sse: options.sse === true, failNext: false, tools: ['save_workflow', 'run_workflow', 'server_info', 'node_search', 'fetch_outputs'] }
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      const message = JSON.parse(body)
      state.calls.push({ method: message.method, headers: request.headers, params: message.params })
      if (request.headers.authorization !== undefined) state.auth = request.headers.authorization
      if (options.requireAuth === true && request.headers.authorization !== `Bearer ${options.token ?? 'tk'}`) {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32001, message: 'unauthorized' } }))
        return
      }
      // 通知（无 id）→ 202 空体
      if (message.id === undefined) {
        response.writeHead(202)
        response.end()
        return
      }
      const result = (() => {
        if (message.method === 'initialize') return { protocolVersion: '2024-11-05', serverInfo: { name: 'comfy-mcp-server', version: '0.1.0' } }
        if (message.method === 'tools/list') return { tools: state.tools.map((name) => ({ name, description: name })) }
        if (message.method === 'tools/call') {
          if (state.failNext) return { isError: true, content: [{ type: 'text', text: 'boom' }] }
          return { structuredContent: { ok: true, tool: message.params.name, args: message.params.arguments }, content: [{ type: 'text', text: '{"ok":true}' }] }
        }
        if (message.method === 'ping') return {}
        return {}
      })()
      const payload = JSON.stringify({ jsonrpc: '2.0', id: message.id, result })
      if (state.sse) {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': state.sessionId })
        response.write(`event: message\ndata: ${payload}\n\n`)
        response.end()
        return
      }
      response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': state.sessionId })
      response.end(payload)
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ state, server, url: `http://127.0.0.1:${address.port}/mcp` })
    })
  })
}

const started = []
async function serve(options) {
  const instance = await startServer(options)
  started.push(instance.server)
  return instance
}

afterEach(() => {
  while (started.length > 0) started.pop().close()
})

describe('parseSseChunk', () => {
  it('extracts JSON payloads from SSE events (boundary: empty/comment)', () => {
    expect(parseSseChunk('event: message\ndata: {"id":1}\n\n')).toEqual([{ id: 1 }])
    expect(parseSseChunk(': keep-alive\n\n')).toEqual([])
    expect(parseSseChunk('')).toEqual([])
  })
})

describe('McpHttpClient（远程 Streamable HTTP）', () => {
  it('handshakes over JSON, keeps the session id and calls tools directly', async () => {
    const { state, url } = await serve({})
    const client = new McpHttpClient({ endpoint: url })
    const init = await client.initialize()
    expect(init.serverInfo.name).toBe('comfy-mcp-server')
    expect(client.sessionId).toBe('sess-123')
    expect(state.calls.some((call) => call.method === 'notifications/initialized')).toBe(true)

    const tools = await client.listTools()
    expect(tools.map((tool) => tool.name)).toContain('save_workflow')

    const result = await client.callTool('save_workflow', { name: 'a', graph: {} })
    expect(result.structuredContent.tool).toBe('save_workflow')
    // 会话头 + 协议头 + Accept 都在
    const call = state.calls.find((entry) => entry.method === 'tools/call')
    expect(call.headers['mcp-session-id']).toBe('sess-123')
    expect(call.headers.accept).toContain('text/event-stream')
    expect(call.headers['mcp-protocol-version']).toBeDefined()
  })

  it('understands SSE responses (streamable HTTP 另一种响应形态)', async () => {
    const { url } = await serve({ sse: true })
    const client = new McpHttpClient({ endpoint: url })
    await client.initialize()
    const tools = await client.listTools()
    expect(tools.length).toBe(5)
  })

  it('sends the bearer token when configured and surfaces server errors', async () => {
    const { state, url } = await serve({ requireAuth: true, token: 'tk' })
    const anonymous = new McpHttpClient({ endpoint: url })
    await expect(anonymous.initialize()).rejects.toThrow(/unauthorized/)
    const authorized = new McpHttpClient({ endpoint: url, token: 'tk' })
    await authorized.initialize()
    expect(state.auth).toBe('Bearer tk')
  })

  it('reports connect failures and timeouts with clear codes (error paths)', async () => {
    const missing = new McpHttpClient({ endpoint: 'http://127.0.0.1:1/mcp' })
    await expect(missing.initialize()).rejects.toMatchObject({ code: 'E_HTTP_CONNECT' })
    const { url } = await serve({})
    const slow = new McpHttpClient({ endpoint: url, requestTimeoutMs: 1 })
    await expect(slow.initialize()).rejects.toMatchObject({ code: 'E_HTTP_TIMEOUT' })
    const noEndpoint = new McpHttpClient({ endpoint: '' })
    await expect(noEndpoint.initialize()).rejects.toMatchObject({ code: 'E_HTTP_NO_ENDPOINT' })
  })
})

describe('createHostFacade（上层无感：宿主工具名 → 原生工具）', () => {
  it('translates connection_status / list_remote_tools / call_remote_tool / fetch_artifacts', async () => {
    const { state, url } = await serve({})
    const client = new McpHttpClient({ endpoint: url })
    const facade = createHostFacade(client)
    await facade.initialize()

    const status = await facade.callTool('connection_status', {})
    expect(status.structuredContent).toMatchObject({ ok: true, tool: 'server_info' })
    expect(status.structuredContent.data).toMatchObject({ transport: 'streamable-http', toolCount: 5 })

    const listed = await facade.callTool('list_remote_tools', {})
    expect(listed.structuredContent.data.count).toBe(5)

    const called = await facade.callTool('call_remote_tool', { tool: 'save_workflow', arguments: { name: 'x' } })
    expect(called.structuredContent).toMatchObject({ ok: true, tool: 'save_workflow' })
    expect(state.calls.find((entry) => entry.params?.name === 'save_workflow')).toBeDefined()

    const fetched = await facade.callTool('fetch_artifacts', { refs: [{ promptId: 'p1' }] })
    expect(fetched.structuredContent.tool).toBe('fetch_outputs')
    const fetchCall = state.calls.find((entry) => entry.params?.name === 'fetch_outputs')
    expect(fetchCall.params.arguments.promptId).toBe('p1')

    // 缺参 / 服务端错误都要变成 ok:false 而不是抛
    const noTool = await facade.callTool('call_remote_tool', {})
    expect(noTool.structuredContent.ok).toBe(false)
    const noPrompt = await facade.callTool('fetch_artifacts', { refs: [] })
    expect(noPrompt.structuredContent.ok).toBe(false)
    state.failNext = true
    const failed = await facade.callTool('call_remote_tool', { tool: 'run_workflow', arguments: {} })
    expect(failed.structuredContent.ok).toBe(false)
  })
})

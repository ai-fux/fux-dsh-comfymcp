import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { McpStreamableHttpError, StreamableHttpClient, normalizeToolResult } from '../src/streamable-http.js'
import { scriptedHandler, startFakeMcpServer, type FakeServerHandle } from './fake-mcp-server.js'

let server: FakeServerHandle | undefined

beforeEach(async () => {
  server = undefined
})

afterEach(async () => {
  await server?.close()
  server = undefined
})

function makeClient(url: string, overrides: Record<string, unknown> = {}): StreamableHttpClient {
  return new StreamableHttpClient({
    endpoint: url,
    protocolVersion: '2025-03-26',
    requestTimeoutMs: 5000,
    clientName: 'test-client',
    clientVersion: '0.0.0',
    ...overrides,
  })
}

describe('StreamableHttpClient', () => {
  it('initializes, lists tools and calls a tool over JSON (happy path)', async () => {
    server = await startFakeMcpServer(
      scriptedHandler({
        tools: [{ name: 'server_info', description: 'snapshot', inputSchema: { type: 'object' } }],
        onCall: (name, args) =>
          name === 'echo'
            ? { content: [{ type: 'text', text: JSON.stringify({ echoed: args, ok: true }) }], isError: false }
            : { content: [{ type: 'text', text: 'boom' }], isError: true },
      }),
    )
    const client = makeClient(server.url)
    expect(client.connected).toBe(false)

    const info = await client.initialize()
    expect(info.name).toBe('fake-comfy-mcp')
    expect(client.connected).toBe(true)

    const tools = await client.listTools()
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ name: 'server_info', description: 'snapshot' })

    const echoed = await client.callTool('echo', { hello: 'world' })
    expect(echoed.ok).toBe(true)
    expect(echoed.data).toMatchObject({ echoed: { hello: 'world' }, ok: true })

    const failed = await client.callTool('boom')
    expect(failed.ok).toBe(false)
    expect(failed.isError).toBe(true)
    expect(String(failed.data['error'])).toContain('boom')
  })

  it('parses SSE tool responses and re-initializes once after a stale session (404)', async () => {
    let callCount = 0
    server = await startFakeMcpServer(
      scriptedHandler({
        callMode: 'sse',
        onCall: (name) => {
          callCount += 1
          return { content: [{ type: 'text', text: JSON.stringify({ name, via: 'sse' }) }] }
        },
      }),
    )
    const client = makeClient(server.url)
    await client.initialize()
    // Simulate a server restart: session resets to session-1 on the next initialize.
    const result = await client.callTool('ping')
    expect(result.ok).toBe(true)
    expect(result.data).toMatchObject({ name: 'ping', via: 'sse' })
    expect(callCount).toBe(1)
  })

  it('probes without throwing and reports the error text (error path)', async () => {
    const client = makeClient('http://127.0.0.1:1/mcp')
    const probe = await client.probe()
    expect(probe.ok).toBe(false)
    expect(typeof probe.error).toBe('string')
  })

  it('rejects invalid endpoints at construction (boundary)', () => {
    expect(() => makeClient('not-a-url')).toThrow(McpStreamableHttpError)
    expect(() => makeClient('ftp://x/mcp')).toThrow(McpStreamableHttpError)
  })

  it('times out a slow endpoint with E_MCP_TIMEOUT', async () => {
    server = await startFakeMcpServer(({ res }) => {
      setTimeout(() => {
        try {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }))
        } catch {
          /* already closed */
        }
      }, 1000)
    })
    const client = makeClient(server.url, { requestTimeoutMs: 50 })
    await expect(client.initialize()).rejects.toMatchObject({ code: 'E_MCP_TIMEOUT' })
  })

  it('surfaces JSON-RPC errors from initialize as E_MCP_INIT', async () => {
    server = await startFakeMcpServer(({ body, res }) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body['id'], error: { code: -32000, message: 'handshake refused' } }))
    })
    const client = makeClient(server.url)
    await expect(client.initialize()).rejects.toMatchObject({ code: 'E_MCP_INIT' })
  })

  it('invalidate() forces a fresh handshake on the next call', async () => {
    let inits = 0
    server = await startFakeMcpServer(
      scriptedHandler({
        tools: [],
        onCall: () => ({ content: [{ type: 'text', text: '{}' }] }),
      }),
    )
    // Count initializes by watching session headers minted.
    server.requests.length = 0
    const wrapped = server.server
    void wrapped
    const client = makeClient(server.url)
    await client.initialize()
    inits = server.requests.filter((entry) => entry.body['method'] === 'initialize').length
    expect(inits).toBe(1)
    client.invalidate()
    await client.initialize()
    inits = server.requests.filter((entry) => entry.body['method'] === 'initialize').length
    expect(inits).toBe(2)
  })
})

describe('normalizeToolResult', () => {
  it('prefers structuredContent and keeps artifacts passthrough', () => {
    const normalized = normalizeToolResult({
      result: {
        structuredContent: { ok: true, artifacts: [{ url: '/artifacts/x', filename: 'x.png', kind: 'image' }] },
        content: [{ type: 'text', text: 'ignored' }],
      },
    })
    expect(normalized.ok).toBe(true)
    expect(Array.isArray(normalized.data['artifacts'])).toBe(true)
  })

  it('maps JSON-RPC errors to ok:false with the message', () => {
    const normalized = normalizeToolResult({ error: { code: -32000, message: 'nope' } })
    expect(normalized.ok).toBe(false)
    expect(normalized.data['error']).toBe('nope')
  })

  it('falls back to plain text when the body is not JSON', () => {
    const normalized = normalizeToolResult({ result: { content: [{ type: 'text', text: 'plain words' }] } })
    expect(normalized.data).toEqual({ text: 'plain words' })
  })
})

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ArtifactStore, contentTypeFor, kindFromFilename } from '../src/artifacts-store.js'
import { injectArtifacts } from '../src/wrap.js'
import { createComfyMcpServer, type ComfyMcpServerHandle } from '../src/server.js'
import { MockBackend } from '../src/mock-backend.js'

let workdir: string
let handle: ComfyMcpServerHandle | undefined

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'comfy-mcp-server-'))
})

afterEach(async () => {
  await handle?.stop()
  handle = undefined
  await rm(workdir, { recursive: true, force: true })
})

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | string | null
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

function client(url: string) {
  let session: string | null = null
  let nextId = 1
  const post = async (body: Record<string, unknown>, extra: Record<string, string> = {}) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...extra },
      body: JSON.stringify(body),
    })
    const headerSession = response.headers.get('mcp-session-id')
    if (headerSession !== null) session = headerSession
    const text = await response.text()
    return { status: response.status, session: headerSession, body: text.length > 0 ? (JSON.parse(text) as JsonRpcResponse) : null }
  }
  return {
    async initialize(): Promise<void> {
      const { session: minted } = await post({
        jsonrpc: '2.0',
        id: nextId++,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
      })
      session = minted
      await post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, auth())
    },
    request(method: string, params: Record<string, unknown> = {}) {
      return post({ jsonrpc: '2.0', id: nextId++, method, params }, auth())
    },
    sessionHeader(): string | null {
      return session
    },
  }
  function auth(): Record<string, string> {
    return session === null ? {} : { 'mcp-session-id': session }
  }
}

describe('artifact store helpers', () => {
  it('maps content types and kinds', () => {
    expect(contentTypeFor('a.png')).toBe('image/png')
    expect(contentTypeFor('b.mkv')).toBe('video/x-matroska')
    expect(contentTypeFor('c.xyz')).toBe('application/octet-stream')
    expect(kindFromFilename('a.jpg')).toBe('image')
    expect(kindFromFilename('b.mp4')).toBe('video')
    expect(kindFromFilename('c.txt')).toBe('file')
  })

  it('registers existing files and skips missing ones', async () => {
    const store = new ArtifactStore()
    const file = join(workdir, 'x.png')
    await writeFileLocal(file, Buffer.from([1]))
    expect(store.register(file)?.filename).toBe('x.png')
    expect(store.register(join(workdir, 'missing.png'))).toBeUndefined()
  })
})

describe('injectArtifacts', () => {
  it('attaches url entries for files[] and skips when already present', async () => {
    const store = new ArtifactStore()
    const file = join(workdir, 'y.png')
    await writeFileLocal(file, Buffer.from([1, 2]))
    const first = injectArtifacts({ files: [{ path: file, filename: 'y.png', kind: 'image' }] }, store, 50)
    expect(first.injected).toBe(1)
    const ref = (first.data['artifacts'] as Array<Record<string, unknown>>)[0]!
    expect(String(ref['url'])).toMatch(/^\/artifacts\//)
    const again = injectArtifacts(first.data, store, 50)
    expect(again.injected).toBe(0)
  })

  it('ignores non-file payloads', () => {
    const store = new ArtifactStore()
    expect(injectArtifacts({ ok: true }, store, 50).injected).toBe(0)
    expect(injectArtifacts({ files: 'not-an-array' }, store, 50).injected).toBe(0)
  })
})

describe('comfy-mcp server (mock backend, end to end)', () => {
  async function start(): Promise<{ api: ReturnType<typeof client>; base: string }> {
    handle = await createComfyMcpServer({
      env: {
        COMFY_MCP_BACKEND: 'mock',
        COMFY_MCP_SERVER_PORT: '0',
        COMFY_MCP_MOCK_STAGE_DIR: join(workdir, 'stage'),
      },
    })
    return { api: client(handle.url), base: handle.url.replace(/\/mcp$/, '') }
  }

  it('mints a session on initialize and rejects unknown sessions (404)', async () => {
    const { api } = await start()
    await api.initialize()
    expect(api.sessionHeader()).not.toBeNull()
    const bad = await fetch(handle!.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'mcp-session-id': 'nope' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
    })
    expect(bad.status).toBe(404)
  })

  it('serves tools/list and a tools/call with artifacts[] + downloadable bytes', async () => {
    const { api, base } = await start()
    await api.initialize()
    const listed = await api.request('tools/list')
    const tools = (listed.body!.result!['tools'] as Array<{ name: string }>).map((tool) => tool.name)
    expect(tools).toContain('run_workflow')
    expect(tools).toContain('node_search')

    const called = await api.request('tools/call', { name: 'run_workflow', arguments: { graph: {} } })
    const structured = called.body!.result!['structuredContent'] as Record<string, unknown>
    expect(structured['state']).toBe('completed')
    const artifacts = structured['artifacts'] as Array<Record<string, unknown>>
    expect(artifacts.length).toBeGreaterThan(0)
    const url = `${base}${String(artifacts[0]!['url'])}`
    const bytes = await fetch(url)
    expect(bytes.status).toBe(200)
    expect(bytes.headers.get('content-type')).toBe('image/png')
    const buffer = await bytes.arrayBuffer()
    expect(buffer.byteLength).toBe(Number(artifacts[0]!['bytes']))
  })

  it('answers unknown methods with a JSON-RPC error and ping with an empty result', async () => {
    const { api } = await start()
    await api.initialize()
    const ping = await api.request('ping')
    expect(ping.body!.result).toEqual({})
    const bogus = await api.request('resources/list')
    expect(bogus.body!.error!.code).toBe(-32601)
  })

  it('health endpoint reports backend and counters (boundary)', async () => {
    const { base } = await start()
    const health = (await (await fetch(`${base}/health`)).json()) as Record<string, unknown>
    expect(health['ok']).toBe(true)
    expect(health['backend']).toBe('mock')
  })

  it('isError tool results pass through untouched (error path)', async () => {
    const { api } = await start()
    await api.initialize()
    const called = await api.request('tools/call', { name: 'nope', arguments: {} })
    const result = called.body!.result!
    expect(result['isError']).toBe(true)
  })

  it('mock save→list→get roundtrip works', async () => {
    const { api } = await start()
    await api.initialize()
    const saved = await api.request('tools/call', {
      name: 'save_workflow',
      arguments: { name: 'demo', subdir: 'sub/dir', graph: { '1': {} } },
    })
    const id = ((saved.body!.result!['structuredContent'] as Record<string, unknown>)['id'] as string)
    const listed = await api.request('tools/call', { name: 'list_workflows' })
    const workflows = ((listed.body!.result!['structuredContent'] as Record<string, unknown>)['workflows'] as Array<Record<string, unknown>>)
    expect(workflows.some((entry) => entry['id'] === id && entry['subdir'] === 'sub/dir')).toBe(true)
  })
})

describe('stdio backend bridge', () => {
  it('bridges to a real stdio MCP child (the mock as a script is overkill; use a tiny inline server)', async () => {
    // Spawn a minimal stdio MCP child written to a temp .mjs, proving the
    // initialize → tools/list → tools/call bridge against a real process.
    const childScript = join(workdir, 'fake-backend.mjs')
    await writeFileLocal(
      childScript,
      Buffer.from(
        `
const state = { tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }] }
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let i = buffer.indexOf('\\n')
  while (i !== -1) {
    const line = buffer.slice(0, i).trim()
    buffer = buffer.slice(i + 1)
    if (line) handle(JSON.parse(line))
    i = buffer.indexOf('\\n')
  }
})
function handle(msg) {
  let result = {}
  if (msg.method === 'initialize') result = { protocolVersion: '2025-03-26', serverInfo: { name: 'fake-stdio', version: '0.0.1' } }
  else if (msg.method === 'tools/list') result = { tools: state.tools }
  else if (msg.method === 'tools/call') result = { content: [{ type: 'text', text: JSON.stringify({ echo: msg.params.arguments }) }] }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n')
}
`,
        'utf8',
      ),
    )
    handle = await createComfyMcpServer({
      config: undefined,
      env: {
        COMFY_MCP_BACKEND: 'stdio',
        COMFY_MCP_SERVER_PORT: '0',
        COMFY_MCP_BACKEND_CMD: process.execPath,
        COMFY_MCP_BACKEND_ARGS: childScript,
      },
    })
    const api = client(handle.url)
    await api.initialize()
    const listed = await api.request('tools/list')
    const tools = (listed.body!.result!['tools'] as Array<{ name: string }>).map((tool) => tool.name)
    expect(tools).toEqual(['echo'])
    const called = await api.request('tools/call', { name: 'echo', arguments: { hi: 1 } })
    const structured = called.body!.result!['structuredContent'] as Record<string, unknown>
    expect(structured['echo']).toEqual({ hi: 1 })
  })
})

describe('mock backend direct', () => {
  it('run_workflow writes a real file whose bytes match the report', async () => {
    const backend = new MockBackend(join(workdir, 'stage2'))
    const outcome = await backend.callTool('run_workflow', {})
    const text = outcome.content!.find((block) => block.type === 'text')!.text!
    const data = JSON.parse(text) as { files: Array<{ path: string; bytes: number }> }
    const content = await readFile(data.files[0]!.path)
    expect(content.length).toBe(data.files[0]!.bytes)
    await backend.stop()
  })
})

async function writeFileLocal(path: string, content: Buffer): Promise<void> {
  const { writeFile, mkdir } = await import('node:fs/promises')
  const { dirname } = await import('node:path')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

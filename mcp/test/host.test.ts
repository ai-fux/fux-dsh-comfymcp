/**
 * Four-layer chain test: fake comfy-mcp service (Streamable HTTP, mock backend
 * semantics) -> client plugin (FUX runtime) -> host catalog -> stdio JSON-RPC.
 */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bootRuntime } from '../src/boot.js'
import { createServer as createHostServer, handleMessage } from '../src/main.js'
import type { ServerHandle } from '../src/main.js'
import { CATALOG_TOOLS, HOST_TOOL_NAMES } from '../src/catalog.js'

/* ---------------------------------------------------------- fake endpoint */

let fake: Server | undefined
let fakeUrl = ''

/** Emulate the reference comfy-mcp service: files[] -> artifacts[] + GET /artifacts/<id>. */
const fakeArtifacts = new Map<string, { filename: string; bytes: number; data: Buffer }>()

async function startFakeEndpoint(stageDir: string): Promise<string> {
  fake = createServer((req, res) => {
    void (async () => {
      if (req.method === 'GET' && (req.url ?? '').startsWith('/artifacts/')) {
        const entry = fakeArtifacts.get((req.url ?? '').slice('/artifacts/'.length))
        if (entry === undefined) {
          res.statusCode = 404
          res.end()
          return
        }
        res.setHeader('content-type', 'image/png')
        res.end(entry.data)
        return
      }
      const body = await readBody(req)
      const message = body.length > 0 ? (JSON.parse(body) as Record<string, unknown>) : {}
      const method = String(message['method'] ?? '')
      const id = message['id']
      const answer = (result: unknown, headers: Record<string, string> = {}): void => {
        res.setHeader('content-type', 'application/json')
        for (const [key, value] of Object.entries(headers)) res.setHeader(key, value)
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result }))
      }
      if (method === 'initialize') {
        answer({ protocolVersion: '2025-03-26', serverInfo: { name: 'fake-comfy-mcp', version: '0.1.0' } }, { 'mcp-session-id': 'fake-session-1' })
        return
      }
      if (method.startsWith('notifications/')) {
        res.statusCode = 202
        res.end()
        return
      }
      if (method === 'tools/list') {
        answer({ tools: [{ name: 'echo', description: 'echo tool' }] })
        return
      }
      if (method === 'tools/call') {
        const params = (message['params'] ?? {}) as Record<string, unknown>
        if (params['name'] === 'make_artifact') {
          const { writeFile, mkdir } = await import('node:fs/promises')
          const { randomUUID } = await import('node:crypto')
          await mkdir(stageDir, { recursive: true })
          const target = join(stageDir, 'out.png')
          const data = Buffer.from([7, 8, 9])
          await writeFile(target, data)
          const artifactId = randomUUID()
          fakeArtifacts.set(artifactId, { filename: 'out.png', bytes: data.length, data })
          answer({
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ok: true,
                  files: [{ path: target, filename: 'out.png', kind: 'image', bytes: data.length }],
                  artifacts: [
                    { id: artifactId, filename: 'out.png', kind: 'image', bytes: data.length, url: `/artifacts/${artifactId}` },
                  ],
                }),
              },
            ],
          })
          return
        }
        answer({ content: [{ type: 'text', text: JSON.stringify({ echoed: params['arguments'] ?? {} }) }] })
        return
      }
      res.statusCode = 404
      res.end('{}')
    })().catch(() => {
      res.statusCode = 500
      res.end('{}')
    })
  })
  fake.listen(0, '127.0.0.1')
  await once(fake, 'listening')
  const address = fake.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  fakeUrl = `http://127.0.0.1:${port}/mcp`
  return fakeUrl
}

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let data = ''
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString()
    })
    req.on('end', () => resolveBody(data))
    req.on('error', reject)
  })
}

/* ------------------------------------------------------------------ tests */

let workdir: string
let handle: ServerHandle | undefined

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'fux-comfymcp-host-'))
})

afterEach(async () => {
  await handle?.close()
  handle = undefined
  fake?.close()
  fake = undefined
  await rm(workdir, { recursive: true, force: true })
})

describe('host boot + catalog', () => {
  it('boots the FUX runtime and resolves config from env', async () => {
    const endpoint = await startFakeEndpoint(join(workdir, 'stage'))
    handle = await createHostServer({
      env: { COMFY_MCP_ENDPOINT: endpoint, COMFY_MCP_ARTIFACTS_DIR: join(workdir, 'art') },
    })
    expect(handle.booted.config.endpoint).toBe(endpoint)
    expect(handle.booted.config.toolCallTimeoutMs).toBe(120000)
  })

  it('catalog drives exactly the declared capabilities and answers JSON-RPC', async () => {
    const endpoint = await startFakeEndpoint(join(workdir, 'stage'))
    handle = await createHostServer({
      env: { COMFY_MCP_ENDPOINT: endpoint, COMFY_MCP_ARTIFACTS_DIR: join(workdir, 'art') },
    })
    expect(HOST_TOOL_NAMES).toEqual(['connection_status', 'list_remote_tools', 'call_remote_tool', 'fetch_artifacts'])
    expect(CATALOG_TOOLS.map((tool) => tool.capability)).toEqual([
      'mcp-comfy:health',
      'mcp-comfy:tools',
      'mcp-comfy:call',
      'mcp-comfy:artifact-fetch',
    ])

    const lines: string[] = []
    const write = (line: string): void => {
      lines.push(line)
    }
    await handleMessage(handle.booted, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, write)
    await handleMessage(handle.booted, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, write)
    await handleMessage(
      handle.booted,
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'connection_status', arguments: {} } },
      write,
    )
    await handleMessage(
      handle.booted,
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'call_remote_tool', arguments: { tool: 'echo', arguments: { hi: 1 } } } },
      write,
    )
    expect(lines).toHaveLength(4)
    const status = JSON.parse(lines[2]!) as { result: { structuredContent: Record<string, unknown> } }
    expect(status.result.structuredContent['ok']).toBe(true)
    const echo = JSON.parse(lines[3]!) as { result: { structuredContent: Record<string, unknown> } }
    expect(echo.result.structuredContent['data']).toMatchObject({ echoed: { hi: 1 } })
  })

  it('artifact download chain: remote files[] 鈫?artifacts[] 鈫?local files', async () => {
    const endpoint = await startFakeEndpoint(join(workdir, 'stage'))
    handle = await createHostServer({
      env: { COMFY_MCP_ENDPOINT: endpoint, COMFY_MCP_ARTIFACTS_DIR: join(workdir, 'art') },
    })
    const lines: string[] = []
    await handleMessage(
      handle.booted,
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'call_remote_tool', arguments: { tool: 'make_artifact', downloadArtifacts: true } },
      },
      (line) => lines.push(line),
    )
    const answer = JSON.parse(lines[0]!) as { result: { structuredContent: Record<string, unknown> } }
    const data = answer.result.structuredContent['data'] as Record<string, unknown>
    expect(Array.isArray(data['artifacts'])).toBe(true)
    const localFiles = answer.result.structuredContent['localFiles'] as Array<{ path: string; bytes: number }>
    expect(localFiles[0]!.bytes).toBe(3)
    expect(resolve(localFiles[0]!.path).startsWith(resolve(workdir))).toBe(true)
  })

  it('unknown tool names answer isError instead of crashing (error path)', async () => {
    const endpoint = await startFakeEndpoint(join(workdir, 'stage'))
    handle = await createHostServer({
      env: { COMFY_MCP_ENDPOINT: endpoint, COMFY_MCP_ARTIFACTS_DIR: join(workdir, 'art') },
    })
    const lines: string[] = []
    await handleMessage(
      handle.booted,
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope', arguments: {} } },
      (line) => lines.push(line),
    )
    const answer = JSON.parse(lines[0]!) as { result: { isError: boolean } }
    expect(answer.result.isError).toBe(true)
  })
})

describe('process selftest', () => {
  it('spawns the launcher and gets a passing report (boundary)', async () => {
    const bin = fileURLToPath(new URL('../bin/fux-comfymcp-host.mjs', import.meta.url))
    const child = spawn(process.execPath, [bin, '--selftest'], { windowsHide: true })
    let out = ''
    child.stdout!.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    child.stderr!.on('data', () => {})
    const [code] = await once(child, 'exit')
    expect(code).toBe(0)
    const report = JSON.parse(out.trim()) as { ok: boolean; tools: string[] }
    expect(report.ok).toBe(true)
    expect(report.tools).toContain('connection_status')
  }, 60000)
})

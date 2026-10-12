import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseManifest } from '@fux/protocol'
import { activatePluginForTest } from './helpers.js'
import { extractArtifacts } from '../src/index.js'
import { manifest, plugin } from '../src/index.js'
import { resolveConfig, defaultArtifactsDir } from '../src/config.js'
import { scriptedHandler, startFakeMcpServer, type FakeServerHandle } from './fake-mcp-server.js'

let workdir: string
let server: FakeServerHandle | undefined

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'mcp-comfy-plugin-'))
})

afterEach(async () => {
  await server?.close()
  server = undefined
  await rm(workdir, { recursive: true, force: true })
})

describe('manifest contract', () => {
  it('parses against @fux/protocol and matches the provided capability set', async () => {
    const parsed = parseManifest(manifest)
    const handlers = await activatePluginForTest(plugin, { endpoint: 'http://127.0.0.1:1/mcp' })
    const provided = Object.keys(handlers)
    expect(new Set(provided)).toEqual(new Set(parsed.capabilities.map((capability) => capability.name)))
    expect(provided).toEqual([
      'mcp-comfy:health',
      'mcp-comfy:status',
      'mcp-comfy:tools',
      'mcp-comfy:call',
      'mcp-comfy:artifact-fetch',
    ])
  })

  it('package.json and manifest versions stay in sync', async () => {
    const pkg = await import('../package.json', { with: { type: 'json' } })
    expect(pkg.default.version).toBe(manifest.version)
  })
})

describe('config resolution', () => {
  it('layers environment over row config over defaults', () => {
    const bareEnv: Record<string, string | undefined> = {}
    const defaults = resolveConfig({}, bareEnv)
    expect(defaults.endpoint).toBe('http://127.0.0.1:18800/mcp')
    expect(defaults.artifactsDir).toBe(defaultArtifactsDir(bareEnv))

    const layered = resolveConfig({ endpoint: 'http://row:1/mcp', headers: { 'x-a': '1' } }, {
      COMFY_MCP_ENDPOINT: 'http://env:2/mcp',
      COMFY_MCP_ARTIFACTS_DIR: 'F:/tmp/art',
      COMFY_MCP_TIMEOUT_MS: '12345',
      COMFY_MCP_HEADERS: '{"x-b":"2"}',
    })
    expect(layered.endpoint).toBe('http://env:2/mcp')
    expect(layered.artifactsDir).toBe(resolve('F:/tmp/art'))
    expect(layered.requestTimeoutMs).toBe(12345)
    expect(layered.headers).toEqual({ 'x-b': '2' })
  })
})

describe('capability handlers', () => {
  it('health reports ok with serverInfo; status lists tools; tools returns schemas', async () => {
    server = await startFakeMcpServer(
      scriptedHandler({
        serverName: 'comfy-mcp-ref',
        tools: [{ name: 'node_search', description: 'search nodes', inputSchema: { type: 'object' } }],
        onCall: () => ({ content: [{ type: 'text', text: '{"ok":true}' }] }),
      }),
    )
    const handlers = await activatePluginForTest(plugin, { endpoint: server.url, artifactsDir: join(workdir, 'art') })
    const health = (await handlers['mcp-comfy:health']!({})) as Record<string, unknown>
    expect(health['ok']).toBe(true)
    expect((health['serverInfo'] as Record<string, unknown>)['name']).toBe('comfy-mcp-ref')

    const status = (await handlers['mcp-comfy:status']!({})) as Record<string, unknown>
    expect(status['ok']).toBe(true)
    expect(status['toolCount']).toBe(1)
    expect(status['tools']).toEqual([{ name: 'node_search', description: 'search nodes' }])

    const tools = (await handlers['mcp-comfy:tools']!({})) as Record<string, unknown>
    expect(tools['count']).toBe(1)
    expect((tools['tools'] as Array<Record<string, unknown>>)[0]!['inputSchema']).toEqual({ type: 'object' })
  })

  it('call normalizes tool results and surfaces server errors without throwing', async () => {
    server = await startFakeMcpServer(
      scriptedHandler({
        onCall: (name) =>
          name === 'bad'
            ? { content: [{ type: 'text', text: 'invalid graph' }], isError: true }
            : { content: [{ type: 'text', text: '{"files":[]}' }] },
      }),
    )
    const handlers = await activatePluginForTest(plugin, { endpoint: server.url })
    const good = (await handlers['mcp-comfy:call']!({ tool: 'list_workflows' })) as Record<string, unknown>
    expect(good['ok']).toBe(true)

    const bad = (await handlers['mcp-comfy:call']!({ tool: 'bad' })) as Record<string, unknown>
    expect(bad['ok']).toBe(false)
    expect(bad['isError']).toBe(true)
    expect(String(bad['data'] && (bad['data'] as Record<string, unknown>)['error'])).toContain('invalid graph')
  })

  it('call rejects a missing tool name (error path)', async () => {
    const handlers = await activatePluginForTest(plugin, { endpoint: 'http://127.0.0.1:1/mcp' })
    await expect(handlers['mcp-comfy:call']!({})).rejects.toThrow(/payload\.tool/)
  })

  it('health/status degrade to ok:false when the endpoint is unreachable', async () => {
    const handlers = await activatePluginForTest(plugin, { endpoint: 'http://127.0.0.1:1/mcp' })
    const health = (await handlers['mcp-comfy:health']!({})) as Record<string, unknown>
    expect(health['ok']).toBe(false)
    expect(typeof health['error']).toBe('string')
    const status = (await handlers['mcp-comfy:status']!({})) as Record<string, unknown>
    expect(status['ok']).toBe(false)
  })

  it('artifact-fetch downloads listed artifacts (happy path via call passthrough)', async () => {
    server = await startFakeMcpServer(
      scriptedHandler({
        onGet: (url, res) => {
          if (url === '/artifacts/a1.png') {
            res.setHeader('content-type', 'image/png')
            res.setHeader('content-length', '2')
            res.end(Buffer.from([9, 9]))
            return true
          }
          return false
        },
        onCall: () => ({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: true,
                artifacts: [{ id: 'a1', url: '/artifacts/a1.png', filename: 'a1.png', kind: 'image', bytes: 2 }],
              }),
            },
          ],
        }),
      }),
    )
    const handlers = await activatePluginForTest(plugin, { endpoint: server.url })
    const result = (await handlers['mcp-comfy:call']!({ tool: 'fetch_outputs' })) as Record<string, unknown>
    expect(result['artifacts']).toHaveLength(1)

    const fetched = (await handlers['mcp-comfy:artifact-fetch']!({
      refs: [{ url: '/artifacts/a1.png', filename: 'a1.png' }],
      outDir: join(workdir, 'dl'),
    })) as Record<string, unknown>
    expect(fetched['ok']).toBe(true)
    expect(fetched['count']).toBe(1)
  })
})

describe('extractArtifacts', () => {
  it('collects only entries with urls and drops junk (boundary)', () => {
    const refs = extractArtifacts({
      artifacts: [
        { url: '/a', filename: 'a.png' },
        { filename: 'no-url.png' },
        'junk',
        { url: 'http://abs/b.png', kind: 'image', bytes: 3 },
      ],
    })
    expect(refs).toEqual([
      { url: '/a', filename: 'a.png' },
      { url: 'http://abs/b.png', kind: 'image', bytes: 3 },
    ])
    expect(extractArtifacts({})).toEqual([])
  })
})

import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRpcMethods, registerConnectionSurface, RPC_CHANNEL, ARTIFACT_ROUTE } from '../lib/rpc.js'
import { overlayPath, readOverlay, writeOverlay, sanitizeOverlayPatch, OVERLAY_KEYS } from '../lib/persist.js'

let workdir

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'comfymcp-rpc-'))
})

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true })
})

function fakeBridge() {
  const config = { endpoint: 'http://x/mcp', saveSubdir: 'sub', workflowDirs: [], artifactsDir: '', autoUnloadModel: true, hostEntry: '' }
  return {
    probe: async () => ({ ok: true }),
    listRuns: (limit) => [{ id: 'r1', limit }],
    getRun: (id) => (id === 'r1' ? { id, state: 'completed' } : null),
    config,
    applyOverlay: (patch) => Object.assign(config, patch),
    readArtifactBytes: (params) => {
      const path = params.get('path')
      if (path === '/allowed/x.png') return { bytes: Buffer.from([9]), contentType: 'image/png' }
      return { error: 'path outside the artifacts directories' }
    },
  }
}

describe('rpc methods', () => {
  it('serves status/runs/run/config endpoints and unknown-endpoint errors', async () => {
    const bridge = fakeBridge()
    const methods = createRpcMethods({ bridge, persist: { sanitizeOverlayPatch: (p) => p, writeOverlay: () => true } })
    expect((await methods.status({})).ok).toBe(true)
    expect((await methods.runs({ limit: 3 })).runs[0].limit).toBe(3)
    expect((await methods.run({ id: 'r1' })).state).toBe('completed')
    expect((await methods.run({ id: 'nope' })).error).toMatch(/not found/)
    expect((await methods.configRead({})).endpoint).toBe('http://x/mcp')
    const written = await methods.configWrite({ endpoint: 'http://new/mcp', bogus: 'x' })
    expect(written.applied.endpoint).toBe('http://new/mcp')
  })
})

describe('registerConnectionSurface', () => {
  it('registers rpc + fetch when the services exist and disposes cleanly', async () => {
    const bridge = fakeBridge()
    const methods = createRpcMethods({ bridge, persist: { sanitizeOverlayPatch: (p) => p, writeOverlay: () => true } })
    const rpcHandlers = []
    const fetchRoutes = []
    const ctx = {
      get(name) {
        if (name === 'connection') {
          return {
            rpc: { handle: (channel, handler) => { rpcHandlers.push({ channel, handler }); return () => {} } },
            fetch: { register: (route) => { fetchRoutes.push(route); return async () => {} } },
          }
        }
        return undefined
      },
    }
    const disposers = registerConnectionSurface({ ctx, methods, bridge })
    expect(disposers).toHaveLength(1)
    expect(rpcHandlers[0].channel).toBe(RPC_CHANNEL)
    expect(fetchRoutes[0].path).toBe(ARTIFACT_ROUTE)

    const handler = rpcHandlers[0].handler
    const okResult = await handler('status', {})
    expect(okResult.ok).toBe(true)
    const badEndpoint = await handler('nope', {})
    expect(badResultCheck(badEndpoint)).toBe(true)
    const writeResult = await handler('configWrite', { endpoint: 'http://w/mcp' })
    expect(writeResult.ok).toBe(true)

    const route = fetchRoutes[0]
    const response = await route.fetch(new Request(`http://x${ARTIFACT_ROUTE}?path=${encodeURIComponent('/allowed/x.png')}`))
    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())[0]).toBe(9)
    const missing = await route.fetch(new Request(`http://x${ARTIFACT_ROUTE}?path=/elsewhere.png`))
    expect(missing.status).toBe(404)

    for (const dispose of disposers) await dispose()
  })

  it('retries until the webServer-backed channel mounts (boundary)', () => {
    const logs = []
    let attempts = 0
    let disposed = false
    const ctx = {
      get(name) {
        if (name !== 'connection') return undefined
        attempts += 1
        if (attempts < 3) throw new Error('cannot get property "webServer" without inject')
        return {
          rpc: { handle: () => () => {} },
          fetch: { register: () => () => {} },
        }
      },
    }
    const disposers = registerConnectionSurface({
      ctx,
      methods: {},
      bridge: fakeBridge(),
      options: {
        attempts: 5,
        log: (line) => logs.push(line),
        schedule: (fn) => { if (!disposed) fn(); return () => {} },
      },
    })
    expect(disposers).toHaveLength(1)
    expect(attempts).toBe(3)
    expect(logs.some((entry) => entry.includes('panel channel /comfymcp ready'))).toBe(true)
    disposers[0]()
    disposed = true
  })

  it('gives up with a log after exhausting attempts (boundary)', () => {
    const logs = []
    let scheduled = 0
    const disposers = registerConnectionSurface({
      ctx: { get: () => { throw new Error('not registered') } },
      methods: {},
      bridge: fakeBridge(),
      options: {
        attempts: 3,
        log: (line) => logs.push(line),
        schedule: (fn) => { scheduled += 1; fn(); return () => {} },
      },
    })
    expect(scheduled).toBe(2)
    expect(logs.some((entry) => entry.includes('unavailable after 3 attempts'))).toBe(true)
    disposers[0]()
  })

  it('stops retrying after disposal', () => {
    const queued = []
    const disposers = registerConnectionSurface({
      ctx: { get: () => { throw new Error('gone') } },
      methods: {},
      bridge: fakeBridge(),
      options: {
        attempts: 10,
        schedule: (fn) => { queued.push(fn); return () => {} },
      },
    })
    expect(queued.length).toBe(1)
    disposers[0]()
    queued[0]() // post-disposal retry must be a no-op (disposed flag)
    expect(queued.length).toBe(1)
  })
})

function badResultCheck(result) {
  return result.ok === false && result.error.code === 'E_NO_METHOD'
}

describe('persist overlay', () => {
  it('writes, reads, and sanitizes patches atomically', async () => {
    const path = overlayPath(workdir)
    expect(readOverlay(path)).toEqual({})
    expect(writeOverlay(path, { endpoint: 'http://a/mcp', junk: undefined })).toBe(true)
    expect(readOverlay(path)).toEqual({ endpoint: 'http://a/mcp' })
    expect(writeOverlay(path, { endpoint: 'http://b/mcp', workflowDirs: 'C:\\x' })).toBe(true)
    expect(readOverlay(path).endpoint).toBe('http://b/mcp')
    expect(readOverlay(path).workflowDirs).toBe('C:\\x')
    const sanitized = sanitizeOverlayPatch({ endpoint: ' http://c/mcp ', autoUnloadModel: false, drop: 1, empty: '' })
    expect(sanitized).toEqual({ endpoint: 'http://c/mcp', autoUnloadModel: false })
    expect(OVERLAY_KEYS).toContain('hostEntry')
  })
})

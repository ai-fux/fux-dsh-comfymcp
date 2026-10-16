import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ComfymcpBridge } from '../lib/bridge.js'

let workdir

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'comfymcp-bridge-'))
})

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true })
})

function makeBridge(overrides = {}, options = {}) {
  const config = {
    endpoint: 'http://127.0.0.1:18800/mcp',
    hostCommand: 'node',
    hostEntry: join(workdir, 'fake-host.mjs'),
    workflowDirs: [join(workdir, 'wf')],
    saveSubdir: 'dsh-generated',
    artifactsDir: join(workdir, 'art'),
    autoUnloadModel: true,
    autoConnect: false,
    requestTimeoutMs: 5000,
    callTimeoutMs: 10000,
    ...overrides,
  }
  return new ComfymcpBridge(config, options)
}

describe('ComfymcpBridge.runs', () => {
  it('records runs, caps history, and lists newest first', () => {
    const bridge = makeBridge()
    for (let i = 0; i < 60; i++) {
      bridge.recordRun({ id: `run-${i}`, name: `w${i}`, state: 'completed' })
    }
    const runs = bridge.listRuns(5)
    expect(runs).toHaveLength(5)
    expect(runs[0].id).toBe('run-59')
    expect(bridge.getRun('run-0')).toBeNull()
    expect(bridge.getRun('run-59').name).toBe('w59')
  })

  it('normalizes recorded fields', () => {
    const bridge = makeBridge()
    const run = bridge.recordRun({ name: 'demo' })
    expect(run.state).toBe('failed')
    expect(run.artifacts).toEqual([])
    expect(run.subdir).toBe('dsh-generated')
    expect(typeof run.id).toBe('string')
  })

  it('persists structured run records to dataDir and restores them in a new bridge', async () => {
    const dataDir = join(workdir, 'data')
    const first = makeBridge({ dataDir })
    first.recordRun({ id: 'run-1', name: 'demo', state: 'completed', prompt: '夕阳西下' })
    const { existsSync, readFileSync } = await import('node:fs')
    expect(existsSync(join(dataDir, 'runs.json'))).toBe(true)
    expect(readFileSync(join(dataDir, 'runs.json'), 'utf8')).toContain('夕阳西下')
    const second = makeBridge({ dataDir })
    expect(second.getRun('run-1')?.name).toBe('demo')
    expect(second.listRuns(5).map((run) => run.id)).toEqual(['run-1'])
  })
})

describe('ComfymcpBridge.embeddedServer', () => {
  it('starts once, rewrites the endpoint, and kills the child on close', async () => {
    let started = 0
    let killed = 0
    const bridge = makeBridge({ embeddedServer: true, endpoint: 'http://127.0.0.1:18800/mcp' }, {
      embeddedSpawner: async () => {
        started += 1
        return { url: 'http://127.0.0.1:41234/mcp', kill: () => { killed += 1 } }
      },
      clientFactory: () => ({ serverInfo: null, initialize: async () => {}, close: async () => {}, status: () => ({}) }),
    })
    expect(bridge.config.endpoint).toBe('http://127.0.0.1:18800/mcp')
    await bridge.ensureReady()
    await bridge.ensureReady()
    expect(started).toBe(1)
    expect(bridge.config.endpoint).toBe('http://127.0.0.1:41234/mcp')
    expect(bridge.publicConfig().embeddedServer).toBe(true)
    expect(bridge.publicConfig().embeddedUrl).toBe('http://127.0.0.1:41234/mcp')
    expect(bridge.publicConfig().autoAcceptForm).toBe(false) // 默认关：表单一直等待
    expect(bridge.publicConfig().autoAcceptFormSec).toBe(30)
    await bridge.close()
    expect(killed).toBe(1)
    expect(bridge.embedded).toBeNull()
  })

  it('publicConfig exposes the form auto-accept policy for the generation flow skill', async () => {
    const bridge = makeBridge({ autoAcceptForm: true, autoAcceptFormSec: 45 })
    expect(bridge.publicConfig()).toMatchObject({ autoAcceptForm: true, autoAcceptFormSec: 45 })
    await bridge.close()
  })

  it('propagates a failed embedded start as a thrown error (boundary)', async () => {
    const bridge = makeBridge({ embeddedServer: true }, {
      embeddedSpawner: async () => {
        throw new Error('内嵌服务端入口不存在：C:\\nope.mjs')
      },
    })
    await expect(bridge.ensureReady()).rejects.toThrow(/入口不存在/)
    expect(bridge.embedded).toBeNull()
  })

  it('skips embedding when disabled', async () => {
    let started = 0
    const bridge = makeBridge({ embeddedServer: false }, {
      embeddedSpawner: async () => { started += 1; return { url: 'http://x/mcp', kill: () => {} } },
      clientFactory: () => ({ serverInfo: { name: 'x', version: '1' }, close: async () => {}, status: () => ({}) }),
    })
    await bridge.ensureReady()
    expect(started).toBe(0)
    expect(bridge.config.endpoint).toBe('http://127.0.0.1:18800/mcp')
  })

  it('restarts the embedded server when embedded-affecting config changes on applyOverlay', async () => {
    let started = 0
    let killed = 0
    const bridge = makeBridge({ embeddedServer: true, comfyuiUrl: 'http://127.0.0.1:8000' }, {
      embeddedSpawner: async () => {
        started += 1
        return { url: `http://127.0.0.1:41${String(started).padStart(3, '0')}/mcp`, kill: () => { killed += 1 } }
      },
      clientFactory: () => ({ serverInfo: null, initialize: async () => {}, close: async () => {}, status: () => ({}) }),
    })
    await bridge.ensureReady()
    expect(started).toBe(1)
    bridge.applyOverlay({ comfyuiUrl: 'http://192.168.1.7:8000' })
    expect(bridge.embedded).toBeNull()
    expect(killed).toBe(1)
    await bridge.ensureReady()
    expect(started).toBe(2)
    expect(bridge.config.endpoint).toBe('http://127.0.0.1:41002/mcp')
  })

  it('passes COMFYUI_URL to the embedded server child env', async () => {
    let capturedEnv = null
    const fakeChild = {
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: (event, handler) => { if (event === 'exit') setTimeout(() => handler(1), 5) },
    }
    const entry = join(workdir, 'fake-server.mjs')
    await writeFile(entry, '// fake server entry\n')
    const bridge = makeBridge({ embeddedServer: true, comfyuiUrl: 'http://10.0.0.8:8000', serverEntry: entry }, {
      spawn: (command, args, opts) => {
        capturedEnv = opts.env
        return fakeChild
      },
      clientFactory: () => ({ serverInfo: null, initialize: async () => {}, close: async () => {}, status: () => ({}) }),
    })
    await expect(bridge.ensureReady()).rejects.toThrow(/提前退出|未报告监听地址/)
    expect(capturedEnv.COMFYUI_URL).toBe('http://10.0.0.8:8000')
  })

  it('resolves the bundled vendor entry when pluginDir is set', async () => {
    const { resolveServerEntry } = await import('../lib/config.js')
    const entry = resolveServerEntry({}, '', join(workdir, 'fake-host.mjs'), 'F:/deploy/profile/node_modules/dsh-comfymcp-client')
    expect(entry).toBe('F:/deploy/profile/node_modules/dsh-comfymcp-client/vendor/comfy-mcp-server.mjs')
    // 显式 serverEntry 仍优先于内置包
    const explicit = resolveServerEntry({}, 'C:/keep.mjs', join(workdir, 'fake-host.mjs'), 'F:/deploy/profile/node_modules/dsh-comfymcp-client')
    expect(explicit).toBe('C:/keep.mjs')
    const bridge = makeBridge({}, { pluginDir: 'F:/deploy/profile/node_modules/dsh-comfymcp-client' })
    expect(bridge.pluginDir).toBe('F:/deploy/profile/node_modules/dsh-comfymcp-client')
  })

  it('detects the unload node in real rows/nodes shapes and both key casings', async () => {
    const makeProbeBridge = (data) =>
      makeBridge({ autoConnect: false }, {
        clientFactory: () => ({
          serverInfo: { name: 'x', version: '1' },
          initialize: async () => {},
          close: async () => {},
          status: () => ({ running: true }),
          callTool: async (tool) => {
            if (tool === 'connection_status') return { structuredContent: { ok: true } }
            return { structuredContent: { data } }
          },
        }),
      })
    // 真实后端：宿主转发 data.rows + 驼峰 classType
    const realRows = await makeProbeBridge({ rows: [{ classType: 'UnloadAllModels' }] }).probeUnload(true)
    expect(realRows.available).toBe(true)
    // mock：data.nodes + 蛇形 class_type
    const snake = await makeProbeBridge({ nodes: [{ class_type: 'UnloadAllModels' }] }).probeUnload(true)
    expect(snake.available).toBe(true)
    const camel = await makeProbeBridge({ nodes: [{ classType: 'UnloadAllModels' }] }).probeUnload(true)
    expect(camel.available).toBe(true)
    const miss = await makeProbeBridge({ rows: [{ classType: 'KSampler' }] }).probeUnload(true)
    expect(miss.available).toBe(false)
  })
})

describe('ComfymcpBridge.readArtifactBytes', () => {
  it('serves files inside the artifacts dir and refuses outside paths', async () => {
    const bridge = makeBridge()
    await mkdir(bridge.config.artifactsDir, { recursive: true })
    const file = join(bridge.config.artifactsDir, 'x.png')
    await writeFile(file, Buffer.from([1, 2, 3]))
    const ok = bridge.readArtifactBytes(new URLSearchParams({ path: file }))
    expect(ok.bytes).toEqual(Buffer.from([1, 2, 3]))
    expect(ok.contentType).toBe('image/png')
    const outside = bridge.readArtifactBytes(new URLSearchParams({ path: join(tmpdir(), 'elsewhere.png') }))
    expect(outside.error).toMatch(/path outside/i)
    const missing = bridge.readArtifactBytes(new URLSearchParams({ path: join(bridge.config.artifactsDir, 'nope.png') }))
    expect(missing.error).toMatch(/gone/)
  })

  it('explains how to handle remote refs (boundary)', () => {
    const bridge = makeBridge()
    const ref = bridge.readArtifactBytes(new URLSearchParams({ ref: '/artifacts/abc' }))
    expect(ref.error).toMatch(/comfymcp_fetch_artifacts/)
    const empty = bridge.readArtifactBytes(new URLSearchParams({}))
    expect(empty.error).toMatch(/path=/)
  })
})

describe('ComfymcpBridge.applyOverlay', () => {
  it('mutates the effective config and resets the probe cache', () => {
    const bridge = makeBridge()
    bridge.unloadProbe = { at: 1, available: true, reason: 'x' }
    const next = bridge.applyOverlay({ endpoint: 'http://changed:9/mcp', workflowDirs: 'C:\\new' })
    expect(next.endpoint).toBe('http://changed:9/mcp')
    expect(bridge.config.workflowDirs).toEqual(['C:\\new'])
    expect(bridge.unloadProbe.at).toBe(0)
  })

  it('applies a devMode patch immediately（设置页保存路径，无需重启）', () => {
    const bridge = makeBridge()
    expect(bridge.config.devMode === true).toBe(false)
    const next = bridge.applyOverlay({ devMode: true })
    expect(bridge.config.devMode).toBe(true)
    expect(next.devMode).toBe(true)
    bridge.applyOverlay({ devMode: false })
    expect(bridge.config.devMode).toBe(false)
  })
})

describe('ComfymcpBridge 传输选择（远程＝Streamable HTTP，内置＝stdio 宿主）', () => {
  it('uses streamable-http in remote mode and does not require a host entry', () => {
    const bridge = makeBridge({ embeddedServer: false, hostEntry: '' })
    expect(bridge.transport()).toBe('streamable-http')
    const client = bridge.clientOrNull()
    expect(client.status().transport).toBe('http')
    // 上层拿到的仍是宿主工具门面
    expect(typeof client.callTool).toBe('function')
    expect(client.serverInfo).toBe(null)
  })

  it('keeps the stdio transport for the built-in server mode', () => {
    const bridge = makeBridge({ embeddedServer: true })
    expect(bridge.transport()).toBe('stdio')
  })

  it('remote probe reports the HTTP transport and never asks for hostEntry', async () => {
    const calls = []
    const bridge = makeBridge(
      { embeddedServer: false, hostEntry: '', endpoint: 'http://127.0.0.1:9/mcp' },
      {
        fetchImpl: async (url, init) => {
          const body = JSON.parse(init.body)
          calls.push(body.method)
          if (body.method === 'initialize') {
            return {
              status: 200,
              headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'application/json' : name.toLowerCase() === 'mcp-session-id' ? 's1' : '') },
              text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'comfy-mcp-server', version: '1' } } }),
            }
          }
          if (body.method === 'tools/call') {
            const tool = body.params.name
            return {
              status: 200,
              headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'application/json' : '') },
              text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { structuredContent: { ok: true, tool } } }),
            }
          }
          return {
            status: 200,
            headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'application/json' : '') },
            text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'node_search' }, { name: 'server_info' }] } }),
          }
        },
      },
    )
    const probe = await bridge.probe()
    expect(probe.ok).toBe(true)
    expect(probe.host.transport).toBe('streamable-http')
    expect(probe.error).not.toMatch(/hostEntry|DSH_COMFYMCP_HOST_ENTRY/)
    expect(calls).toContain('initialize')
    expect(calls).toContain('tools/call')
  })

  it('drops the cached client when the transport switches (config apply)', () => {
    const bridge = makeBridge({ embeddedServer: true })
    const first = bridge.clientOrNull()
    expect(bridge.transport()).toBe('stdio')
    bridge.applyOverlay({ embeddedServer: false })
    expect(bridge.client).toBe(null)
    const second = bridge.clientOrNull()
    expect(second).not.toBe(first)
    expect(bridge.transport()).toBe('streamable-http')
  })
})

describe('ComfymcpBridge.probe without a host entry（仅内置/stdio 模式才需要宿主入口）', () => {
  it('answers ok:false with an actionable message and never throws', async () => {
    const bridge = makeBridge({ embeddedServer: true, hostEntry: '' })
    const probe = await bridge.probe()
    expect(probe.ok).toBe(false)
    expect(probe.error).toMatch(/hostEntry|DSH_COMFYMCP_HOST_ENTRY/)
    expect(probe.unload.available).toBe(false)
  })
})

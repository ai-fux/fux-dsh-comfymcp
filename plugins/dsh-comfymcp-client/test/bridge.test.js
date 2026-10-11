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
})

describe('ComfymcpBridge.probe without a host entry', () => {
  it('answers ok:false with an actionable message and never throws', async () => {
    const bridge = makeBridge({ hostEntry: '' })
    const probe = await bridge.probe()
    expect(probe.ok).toBe(false)
    expect(probe.error).toMatch(/hostEntry|DSH_COMFYMCP_HOST_ENTRY/)
    expect(probe.unload.available).toBe(false)
  })
})

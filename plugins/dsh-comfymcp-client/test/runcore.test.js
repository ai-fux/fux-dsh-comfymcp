import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRunExecutor, distributeArtifacts } from '../lib/runcore.js'

let workdir

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'comfymcp-runcore-'))
  await mkdir(join(workdir, 'artifacts'), { recursive: true })
  await writeFile(join(workdir, 'artifacts', 'out.png'), 'PNGDATA', 'utf8')
})

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true }).catch(() => {})
})

function fakeBridge(config) {
  return {
    config,
    readArtifactBytes: (params) => {
      const path = params.get('path')
      if (path === 'missing') return { error: 'gone' }
      return { bytes: Buffer.from(`bytes-of-${path}`), contentType: 'image/png' }
    },
  }
}

function filesFor() {
  return [
    { path: join(workdir, 'artifacts', 'out.png'), filename: 'out.png', kind: 'image' },
    { path: 'missing', filename: 'missing.png', kind: 'image' },
  ]
}

describe('distributeArtifacts', () => {
  it('mirrors files into the configured downloadDir (relative to homeDir)', async () => {
    const bridge = fakeBridge({ storage: 'local', homeDir: workdir, downloadDir: 'downloads' })
    const result = await distributeArtifacts(bridge, filesFor())
    expect(result.download.dir).toBe(join(workdir, 'downloads'))
    expect(result.download.mirrored).toBe(1)
    const entries = await readdir(join(workdir, 'downloads'))
    expect(entries).toEqual(['out.png'])
  })

  it('reports storage push errors as annotations without throwing (boundary)', async () => {
    const bridge = fakeBridge({ storage: 'minio', homeDir: workdir, downloadDir: '' })
    const result = await distributeArtifacts(bridge, filesFor())
    expect(result.storage.error).toContain('endpoint') // 失败只附注，不影响运行
  })

  it('returns null when nothing to distribute', async () => {
    expect(await distributeArtifacts(fakeBridge({ storage: 'local' }), [])).toBeNull()
    expect(await distributeArtifacts(fakeBridge({ storage: 'local', downloadDir: 'dl' }), null)).toBeNull()
  })
})

describe('runCore 卸载开关处置（真正落到保存的图上）', () => {
  // 带 SaveImage 终端输出链（卸载节点整合插在输出链路上）
  const GRAPH = {
    '3': { class_type: 'KSampler', inputs: { seed: 42, steps: 20 } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0] } },
    '9': { class_type: 'SaveImage', inputs: { images: ['8', 0] } },
  }

  function makeRunBridge({ autoUnloadModel = false, unloadAvailable = true } = {}) {
    const savedGraphs = []
    const bridge = {
      config: { dataDir: workdir, saveSubdir: 'gen', autoUnloadModel, storage: 'local' },
      ensureReady: async () => ({
        callTool: async (_name, args) => {
          const tool = args?.tool
          if (tool === 'save_workflow') savedGraphs.push(args.arguments.graph)
          const data = tool === 'run_workflow'
            ? { promptId: 'p1' }
            : tool === 'job_wait'
              ? { state: 'completed' }
              : tool === 'fetch_outputs'
                ? { files: [] }
                : {}
          return { structuredContent: { ok: true, isError: false, data } }
        },
      }),
      probeUnload: async () => ({ available: unloadAvailable, reason: unloadAvailable ? 'node_search hit UnloadAllModels' : 'no node' }),
      recordRun: (run) => run,
      updateRun: () => null,
      log: () => {},
    }
    return { bridge, savedGraphs }
  }

  it('switch OFF: strips workflow-provided unload nodes before save', async () => {
    const { bridge, savedGraphs } = makeRunBridge({ autoUnloadModel: false })
    const executeRun = createRunExecutor({ bridge })
    const graph = { ...GRAPH, '94': { class_type: 'UnloadAllModels', inputs: { value: ['3', 0] } } }
    const result = await executeRun({ name: 'beach', graph })
    expect(result.ok).toBe(true)
    expect(result.unload).toMatchObject({ requested: false, applied: false })
    expect(result.unload.reason).toMatch(/移除工作流自带的 1 个卸载节点/)
    expect(savedGraphs[0]['94']).toBeUndefined() // 保存/执行的图已不含卸载节点
    expect(savedGraphs[0]['3'].inputs.seed).toBe(42)
  })

  it('switch OFF without any unload node explains itself (boundary)', async () => {
    const { bridge } = makeRunBridge({ autoUnloadModel: false })
    const executeRun = createRunExecutor({ bridge })
    const result = await executeRun({ name: 'beach', graph: { ...GRAPH } })
    expect(result.unload.reason).toMatch(/未启用，且工作流不含卸载节点/)
  })

  it('switch ON: integrates the unload node into the saved graph', async () => {
    const { bridge, savedGraphs } = makeRunBridge({ autoUnloadModel: true })
    const executeRun = createRunExecutor({ bridge })
    const result = await executeRun({ name: 'beach', graph: { ...GRAPH } })
    expect(result.unload).toMatchObject({ requested: true, applied: true })
    const saved = savedGraphs[0]
    const unloadId = Object.keys(saved).find((id) => saved[id].class_type === 'UnloadAllModels')
    expect(unloadId).toBeDefined() // 已插入 UnloadAllModels
  })
})

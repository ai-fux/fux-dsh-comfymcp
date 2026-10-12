import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkbenchMethods } from '../lib/workbench.js'

let workdir
let workflowDir

const GRAPH = {
  '3': { class_type: 'KSampler', inputs: { seed: 42, steps: 20 } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: '夕阳西下' } },
}

async function makeBridge(overrides = {}) {
  return {
    config: { saveSubdir: 'gen', autoUnloadModel: false },
    listRuns: () => [],
    recordRun(run) {
      this.lastRecord = { ...run, id: 'run-1' }
      return this.lastRecord
    },
    callRemote: async () => ({
      structuredContent: { nodes: { KSampler: { inputs: [{ name: 'seed', type: 'INT', required: true }] } } },
    }),
    ensureReady: async () => {
      throw new Error('no backend in test')
    },
    ...overrides,
  }
}

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'comfymcp-wb-'))
  workflowDir = join(workdir, 'workflows')
  await mkdir(workflowDir, { recursive: true })
  await writeFile(join(workflowDir, 'beach.json'), JSON.stringify(GRAPH), 'utf8')
})

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true }).catch(() => {})
})

function makeWorkbench(bridge, config = {}) {
  return createWorkbenchMethods({ bridge, config: { workflowDirs: [workflowDir], dataDir: join(workdir, 'data'), ...config } })
}

describe('workbench pages', () => {
  it('index lists workflow files; pageWorkflow builds the descriptor html', async () => {
    const workbench = makeWorkbench(await makeBridge())
    const index = await workbench.pageIndex({ token: 'tk' })
    expect(index.html).toContain('/ui/wf/beach?token=tk')
    const page = await workbench.pageWorkflow('beach', { token: 'tk' })
    expect(page.html).toContain('data-field="3:seed"')
    expect(page.html).toContain('KSampler (3)')
    expect(await workbench.pageWorkflow('missing', {})).toMatchObject({ error: /不存在/ })
  })

  it('getPage returns the descriptor via node_info', async () => {
    const workbench = makeWorkbench(await makeBridge())
    const descriptor = await workbench.getPage('beach')
    expect(descriptor.workflow).toBe('beach')
    expect(descriptor.sections[0].fields[0].field).toBe('seed')
  })

  it('rejects traversal names (boundary)', async () => {
    const workbench = makeWorkbench(await makeBridge())
    expect(await workbench.getPage('../secret')).toBeNull()
    expect(await workbench.getPage('a\\b')).toBeNull()
  })
})

describe('workbench runPage / quickRun', () => {
  it('applies composite-key values onto the graph before executing', async () => {
    const bridge = await makeBridge()
    const workbench = makeWorkbench(bridge)
    const result = await workbench.runPage({ workflow: 'beach', values: { '3:seed': 777, '6:text': '海边' }, name: 'beach-01' })
    expect(result.ok).toBe(false) // 测试桩无后端，但图已应用并入记录
    expect(result.error).toContain('no backend')
    expect(bridge.lastRecord.form.graph['3'].inputs.seed).toBe(777)
    expect(bridge.lastRecord.form.graph['6'].inputs.text).toBe('海边')
    expect(bridge.lastRecord.form.values['3:seed']).toBe(777)
    expect(bridge.lastRecord.name).toBe('beach-01')
  })

  it('quickRun reruns the last completed run with only the seed rolled', async () => {
    const appliedGraph = { '3': { class_type: 'KSampler', inputs: { seed: 42, steps: 20 } }, '6': { class_type: 'CLIPTextEncode', inputs: { text: '旧词' } } }
    const bridge = await makeBridge({
      listRuns: () => [
        { id: 'r0', name: 'beach-01', state: 'completed', form: { values: { '3:seed': 42, '6:text': '旧词' }, graph: appliedGraph } },
      ],
    })
    const workbench = makeWorkbench(bridge, { quickCommands: JSON.stringify([{ name: '抽卡', seed: { mode: 'range', min: 9, max: 9 } }]) })
    const result = await workbench.quickRun({ workflow: 'beach', command: '抽卡' })
    expect(result.ok).toBe(false) // 无后端；但记录已生成
    expect(bridge.lastRecord.name).toBe('beach-01-reroll')
    expect(bridge.lastRecord.form.graph['3'].inputs.seed).toBe(9)
    expect(bridge.lastRecord.form.graph['6'].inputs.text).toBe('旧词')
  })

  it('quickRun without prior completed run explains itself (boundary)', async () => {
    const workbench = makeWorkbench(await makeBridge())
    const result = await workbench.quickRun({ workflow: 'beach', command: '抽卡' })
    expect(result).toMatchObject({ ok: false })
    expect(result.reason).toContain('没有可复用')
  })
})

describe('workbench tags', () => {
  it('updateTags persists via the tag store', async () => {
    const workbench = makeWorkbench(await makeBridge())
    const record = await workbench.updateTags({ key: 'k1', patch: { tags: ['夕阳'], fields: { 尺寸: '768' } } })
    expect(record.tags).toEqual(['夕阳'])
    const second = makeWorkbench(await makeBridge())
    const artifacts = await second.listArtifacts()
    expect(artifacts.tags.k1.tags).toEqual(['夕阳'])
    await expect(workbench.updateTags({ key: '', patch: {} })).rejects.toThrow(/key/)
  })
})

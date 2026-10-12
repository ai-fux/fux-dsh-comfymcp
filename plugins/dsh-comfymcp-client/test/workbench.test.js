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

const REMOTE_GRAPH = {
  '3': { class_type: 'KSampler', inputs: { seed: 1, steps: 25, sampler_name: 'euler' } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'library 提示词' } },
}

async function makeBridge(overrides = {}) {
  return {
    config: { saveSubdir: 'gen', autoUnloadModel: false },
    listRuns: () => [],
    recordRun(run) {
      this.lastRecord = { ...run, id: 'run-1' }
      return this.lastRecord
    },
    // 宿主转发包装实证形状：structuredContent = { ok, isError, tool, data, ... }
    callRemote: async (tool, args = {}) => {
      if (tool === 'node_info') {
        return {
          structuredContent: {
            ok: true,
            isError: false,
            tool,
            data: {
              nodes: {
                KSampler: {
                  classType: 'KSampler',
                  inputs: [
                    { name: 'seed', group: 'required', type: 'INT', required: true, min: 0 },
                    { name: 'sampler_name', group: 'required', type: 'COMBO', required: true, options: ['euler', 'heun'] },
                  ],
                },
              },
              missing: [],
            },
          },
        }
      }
      if (tool === 'get_workflow') {
        if (args.id !== 'library:demo.json') return { structuredContent: { ok: false, isError: true, tool, data: { error: 'not found' } } }
        return { structuredContent: { ok: true, isError: false, tool, data: { id: args.id, format: 'ui', converted: true, graph: REMOTE_GRAPH } } }
      }
      if (tool === 'list_workflows') {
        return { structuredContent: { ok: true, isError: false, tool, data: { total: 1, workflows: [{ id: 'library:demo.json', name: 'demo', source: 'library' }] } } }
      }
      return { structuredContent: { ok: true, isError: false, tool, data: {} } }
    },
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

  it('falls back to the remote template library and adapts COMBO fields (official shape)', async () => {
    const workbench = makeWorkbench(await makeBridge())
    const index = await workbench.pageIndex({ token: '' })
    expect(index.html).toContain('/ui/wf/library%3Ademo.json')
    expect(index.html).toContain('模板库')
    const page = await workbench.pageWorkflow('library:demo.json', { token: '' })
    expect(page.error).toBeUndefined()
    expect(page.html).toContain('data-field="3:seed"')
    // 官方 COMBO+options → 下拉，含当前值
    expect(page.html).toContain('data-field="3:sampler_name"')
    expect(page.html).toContain('<option value="euler" selected>')
    // 远端图执行：复合键应用后走共享运行核心（桩无后端，但记录已生成）
    const result = await workbench.runPage({ workflow: 'library:demo.json', values: { '3:seed': 3 } })
    expect(result.error).toContain('no backend')
    expect(result.runId).toBe('run-1')
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

describe('workbench tabs / pull / refresh', () => {
  it('groups mine vs library and dedupes by name with local priority', async () => {
    const bridge = await makeBridge({
      // 带「同名远端工作流」的 callRemote：非 library 条目 name=beach
      callRemote: async (tool, args = {}) => {
        if (tool === 'node_info') {
          return { structuredContent: { ok: true, isError: false, tool, data: { nodes: { KSampler: { classType: 'KSampler', inputs: [{ name: 'seed', group: 'required', type: 'INT', required: true }] } }, missing: [] } } }
        }
        if (tool === 'list_workflows') {
          return {
            structuredContent: {
              ok: true, isError: false, tool,
              data: {
                total: 2,
                workflows: [
                  { id: 'ws:beach', name: 'beach', source: 'workspace' },
                  { id: 'library:demo.json', name: 'demo', source: 'library' },
                ],
              },
            },
          }
        }
        if (tool === 'get_workflow' && args.id === 'library:demo.json') {
          return { structuredContent: { ok: true, isError: false, tool, data: { id: args.id, converted: true, graph: REMOTE_GRAPH } } }
        }
        return { structuredContent: { ok: true, isError: false, tool, data: {} } }
      },
    })
    const workbench = makeWorkbench(bridge)
    const groups = await workbench.listWorkflows()
    const beaches = groups.mine.filter((page) => String(page.title ?? page.name).toLowerCase() === 'beach')
    expect(beaches).toHaveLength(1) // 同名去重，本地优先
    expect(beaches[0].origin).toBe('local')
    expect(groups.mine.some((page) => page.name === 'library:demo.json')).toBe(false)
    expect(groups.library).toEqual([expect.objectContaining({ name: 'library:demo.json', title: 'demo' })])
  })

  it('pulls a library workflow into my local dir and refresh re-parses', async () => {
    const workbench = makeWorkbench(await makeBridge())
    const pulled = await workbench.pullWorkflow({ id: 'library:demo.json' })
    expect(pulled).toMatchObject({ ok: true, name: 'demo' })
    const page = await workbench.pageWorkflow('demo', { token: '' }) // 拉取后本地可解析
    expect(page.error).toBeUndefined()
    expect(page.html).toContain('data-field="3:seed"')
    const refreshed = await workbench.refreshWorkflow({ workflow: 'demo' })
    expect(refreshed.ok).toBe(true)
    expect(refreshed.sections).toBeGreaterThanOrEqual(2)
    await expect(workbench.pullWorkflow({ id: 'missing:1.json' })).resolves.toMatchObject({ ok: false })
    await expect(workbench.refreshWorkflow({ workflow: '' })).resolves.toMatchObject({ ok: false })
  })
})

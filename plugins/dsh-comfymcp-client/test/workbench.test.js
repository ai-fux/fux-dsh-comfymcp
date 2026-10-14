import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
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
  const runs = new Map()
  const order = []
  const bridge = {
    config: { saveSubdir: 'gen', autoUnloadModel: false },
    listRuns: (limit = 20) => order.slice(-limit).reverse().map((id) => runs.get(id)).filter(Boolean),
    getRun: (id) => runs.get(id) ?? null,
    recordRun(run) {
      const id = run.id ?? `run-${order.length + 1}`
      const record = { ...run, id, state: run.state ?? 'failed' }
      runs.set(id, record)
      if (!order.includes(id)) order.push(id)
      this.lastRecord = record
      return record
    },
    updateRun(id, patch) {
      const current = runs.get(id)
      if (current === undefined) return null
      const next = { ...current, ...patch, id }
      runs.set(id, next)
      return next
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
  return bridge
}

/** 等待异步运行结束（守护把结果写进运行记录，状态需轮询获取）。 */
async function waitForFinish(workbench, workflow, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const status = await workbench.runStatus({ workflow })
    const value = status?.value ?? null
    if (value !== null && value.state !== 'running') return value
    if (Date.now() > deadline) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
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

function makeWorkbench(bridge, config = {}, extra = {}) {
  return createWorkbenchMethods({
    bridge,
    config: { workflowDirs: [workflowDir], homeDir: join(workdir, 'comfymcp-test-workflows'), dataDir: join(workdir, 'data'), ...config },
    ...extra,
  })
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
    expect(index.html).toContain('我的工作流') // 三 Tab 齐平
    const library = await workbench.pageLibrary({ token: '' })
    expect(library.html).toContain('/ui/wf/library%3Ademo.json')
    expect(library.html).toContain('执行一次即自动保存')
    const page = await workbench.pageWorkflow('library:demo.json', { token: '' })
    expect(page.error).toBeUndefined()
    expect(page.html).toContain('data-field="3:seed"')
    // 官方 COMBO+options → 下拉，含当前值
    expect(page.html).toContain('data-field="3:sampler_name"')
    expect(page.html).toContain('<option value="euler" selected>')
    // 远端图执行：复合键应用后异步启动（桩无后端，状态轮询到失败）
    const started = await workbench.runPage({ workflow: 'library:demo.json', values: { '3:seed': 3 } })
    expect(started.ok).toBe(true)
    expect(started.workflow).toBe('demo') // 运行名统一为文件词干，便于下次匹配上次参数
    const finished = await waitForFinish(workbench, 'demo')
    expect(finished.state).toBe('failed')
    expect(finished.error).toContain('no backend')
  })
})

describe('workbench runPage / quickRun', () => {
  it('applies composite-key values onto the graph before executing', async () => {
    const bridge = await makeBridge()
    const workbench = makeWorkbench(bridge)
    const started = await workbench.runPage({ workflow: 'beach', values: { '3:seed': 777, '6:text': '海边' }, name: 'beach-01' })
    expect(started.ok).toBe(true)
    expect(typeof started.runId).toBe('string')
    const finished = await waitForFinish(workbench, 'beach-01')
    expect(finished.state).toBe('failed') // 测试桩无后端
    expect(finished.error).toContain('no backend')
    const record = bridge.getRun(started.runId)
    expect(record.form.graph['3'].inputs.seed).toBe(777)
    expect(record.form.graph['6'].inputs.text).toBe('海边')
    expect(record.form.values['3:seed']).toBe(777)
    expect(record.name).toBe('beach-01')
  })

  it('refuses a second run for the same workflow while one is active (boundary)', async () => {
    const bridge = await makeBridge({
      ensureReady: () => new Promise(() => {}), // 永不返回：保持运行中
    })
    const workbench = makeWorkbench(bridge)
    const first = await workbench.runPage({ workflow: 'beach', values: {}, name: 'beach-01' })
    expect(first.ok).toBe(true)
    const second = await workbench.runPage({ workflow: 'beach', values: {}, name: 'beach-01' })
    expect(second).toMatchObject({ ok: false })
    expect(second.reason).toContain('正在执行中')
    const status = await workbench.runStatus({ workflow: 'beach-01' })
    expect(status.value.state).toBe('running')
  })

  it('quickRun reruns the last completed run with only the seed rolled', async () => {
    const appliedGraph = { '3': { class_type: 'KSampler', inputs: { seed: 42, steps: 20 } }, '6': { class_type: 'CLIPTextEncode', inputs: { text: '旧词' } } }
    const bridge = await makeBridge({
      listRuns: () => [
        { id: 'r0', name: 'beach-01', state: 'completed', finishedAt: Date.now(), form: { values: { '3:seed': 42, '6:text': '旧词' }, graph: appliedGraph } },
      ],
    })
    const workbench = makeWorkbench(bridge, { quickCommands: JSON.stringify([{ name: '抽卡', seed: { mode: 'range', min: 9, max: 9 } }]) })
    const started = await workbench.quickRun({ workflow: 'beach', command: '抽卡' })
    expect(started.ok).toBe(true)
    const finished = await waitForFinish(workbench, 'beach-01-reroll')
    expect(finished.state).toBe('failed') // 无后端；但图已按种子策略重滚
    const record = bridge.getRun(started.runId)
    expect(record.name).toBe('beach-01-reroll')
    expect(record.form.graph['3'].inputs.seed).toBe(9)
    expect(record.form.graph['6'].inputs.text).toBe('旧词')
  })

  it('quickRun without prior completed run explains itself (boundary)', async () => {
    const workbench = makeWorkbench(await makeBridge())
    const result = await workbench.quickRun({ workflow: 'beach', command: '抽卡' })
    expect(result).toMatchObject({ ok: false })
    expect(result.reason).toContain('没有可复用')
  })
})

describe('template run persistence and last-run prefill', () => {
  it('saves a template into my workflows on first run and remembers its params', async () => {
    const bridge = await makeBridge()
    const workbench = makeWorkbench(bridge)
    const started = await workbench.runPage({ workflow: 'library:demo.json', values: { '3:seed': 99 } })
    expect(started.ok).toBe(true)
    // 落库到插件自有 workflows 目录（模板跑过即进入「我的工作流」）
    const saved = join(workdir, 'comfymcp-test-workflows', 'workflows', 'demo.json')
    expect(existsSync(saved)).toBe(true)
    const savedGraph = JSON.parse(readFileSync(saved, 'utf8'))
    expect(savedGraph['3'].class_type).toBe('KSampler')
    // 落库后「我的工作流」里出现本地条目
    const groups = await workbench.listWorkflows()
    expect(groups.mine.some((page) => page.name === 'demo' && page.origin === 'local')).toBe(true)
    await waitForFinish(workbench, 'library:demo.json')

    // 造一条历史成功记录 → 打开页面时带出上次参数并标记来源
    const history = [
      {
        id: 'h1', name: 'demo', state: 'completed', finishedAt: Date.now(), startedAt: Date.now() - 1000,
        localFiles: [{ path: join(workdir, 'h.png'), filename: 'h.png', kind: 'image' }],
        form: { values: { '3:seed': 42, '3:sampler_name': 'heun' }, graph: JSON.parse(JSON.stringify(REMOTE_GRAPH)) },
      },
    ]
    bridge.listRuns = () => history
    const page = await workbench.pageWorkflow('demo', { token: '' })
    expect(page.error).toBeUndefined()
    expect(page.html).toContain('已带出上一次运行的参数')
    expect(page.html).toContain('value="42"')
    expect(page.html).toContain('>上次<')
    expect(page.html).toContain('<option value="heun" selected>')
  })
})

describe('workbench prompt assign / export', () => {
  it('stores a pending prompt assignment and consumes it once', async () => {
    const workbench = makeWorkbench(await makeBridge())
    await expect(workbench.takePrompt({ workflow: 'beach' })).resolves.toMatchObject({ value: null })
    await expect(workbench.assignPrompt({ workflow: 'beach', field: '6:text', value: '夕阳', kind: 'positive' })).resolves.toMatchObject({ ok: true })
    await expect(workbench.assignPrompt({ workflow: '', field: 'x', value: 'y' })).resolves.toMatchObject({ ok: false })
    const taken = await workbench.takePrompt({ workflow: 'beach' })
    expect(taken.value).toMatchObject({ field: '6:text', value: '夕阳', kind: 'positive' })
    await expect(workbench.takePrompt({ workflow: 'beach' })).resolves.toMatchObject({ value: null }) // 一次性消费
  })

  it('exports runs as JSON with inline base64 file payloads', async () => {
    const bytes = Buffer.from('png-bytes')
    const bridge = await makeBridge({
      readArtifactBytes: () => ({ bytes, contentType: 'image/png' }),
      listRuns: () => [
        {
          id: 'r1', name: 'beach', state: 'completed', seed: 7, startedAt: 1, finishedAt: 11, durationMs: 10,
          prompts: { positive: '夕阳', negative: '模糊', positiveField: '6:text', negativeField: '7:text' },
          localFiles: [{ path: join(workdir, 'a.png'), filename: 'a.png', kind: 'image', bytes: bytes.byteLength }],
        },
        { id: 'r2', name: 'no-media', state: 'failed', localFiles: [] },
      ],
    })
    const workbench = makeWorkbench(bridge)
    const exported = await workbench.exportArtifacts({})
    expect(exported.runs).toBe(1) // 无模态数据不入库
    const payload = JSON.parse(exported.json)
    expect(payload.runs[0]).toMatchObject({ id: 'r1', name: 'beach', seed: 7, durationMs: 10 })
    expect(payload.runs[0].prompts).toMatchObject({ positive: '夕阳', negative: '模糊' })
    expect(payload.runs[0].files[0]).toMatchObject({ filename: 'a.png', encoding: 'base64', data: bytes.toString('base64') })
    expect(exported.filename).toMatch(/^comfymcp-artifacts-.*\.json$/)
    const only = await workbench.exportArtifacts({ ids: 'r2' })
    expect(only.runs).toBe(0)
  })
})

describe('workbench artifact removal', () => {
  it('removes a registered artifact and optionally deletes the file', async () => {
    const file = join(workdir, 'out.png')
    await writeFile(file, 'png', 'utf8')
    const bridge = await makeBridge({
      getRun: (id) => (id === 'r1' ? { id: 'r1', name: 'beach', state: 'completed', localFiles: [{ path: file, filename: 'out.png', kind: 'image', bytes: 3 }] } : null),
    })
    const updates = []
    bridge.updateRun = (id, patch) => {
      updates.push({ id, patch })
      return { id, ...patch }
    }
    const workbench = makeWorkbench(bridge)
    const removed = await workbench.removeArtifact({ runId: 'r1', path: file, deleteFile: true })
    expect(removed).toMatchObject({ ok: true, deleted: true, remaining: 0 })
    expect(updates[0].patch.localFiles).toEqual([])
    expect(existsSync(file)).toBe(false)
  })

  it('refuses unregistered paths and missing runs (boundary)', async () => {
    const bridge = await makeBridge({
      getRun: (id) => (id === 'r1' ? { id: 'r1', localFiles: [{ path: join(workdir, 'a.png') }] } : null),
    })
    const workbench = makeWorkbench(bridge)
    await expect(workbench.removeArtifact({ runId: 'nope', path: 'x' })).resolves.toMatchObject({ ok: false })
    await expect(workbench.removeArtifact({ runId: 'r1', path: 'C:\\windows\\system32\\cmd.exe' })).resolves.toMatchObject({ ok: false })
    expect((await workbench.removeArtifact({ runId: 'r1', path: 'C:\\x' })).reason).toContain('未登记')
    await expect(workbench.removeArtifact({ runId: '' })).resolves.toMatchObject({ ok: false })
  })

  it('drops a whole run group without deleting files', async () => {
    const dropped = []
    const bridge = await makeBridge({
      getRun: () => ({ id: 'r9', name: 'beach', localFiles: [{ path: join(workdir, 'keep.png') }] }),
      removeRun: (id) => {
        dropped.push(id)
        return true
      },
    })
    const workbench = makeWorkbench(bridge)
    await expect(workbench.removeArtifact({ runId: 'r9', dropRun: true })).resolves.toMatchObject({ ok: true, dropped: 'r9' })
    expect(dropped).toEqual(['r9'])
  })
})

describe('workbench artifact search and batch removal', () => {
  const runA = {
    id: 'r1', name: 'beach', state: 'completed', seed: 1, durationMs: 10,
    prompts: { positive: 'sunset beach couple', negative: 'blurry' },
    params: [{ node: '3', field: 'steps', value: '25' }],
    localFiles: [{ path: 'C:\\a\\one.png', filename: 'one.png', kind: 'image', key: 'k1' }],
  }
  const runB = {
    id: 'r2', name: 'night', state: 'completed', seed: 2, durationMs: 20,
    prompts: { positive: 'night city', negative: '' },
    params: [{ node: '3', field: 'steps', value: '50' }],
    localFiles: [{ path: 'C:\\a\\two.png', filename: 'two.png', kind: 'image', key: 'k2' }],
  }

  it('queries with the compound syntax (fuzzy, qualifiers, AND/OR/NOT, comparisons)', async () => {
    const bridge = await makeBridge({ listRuns: () => [runA, runB] })
    const workbench = makeWorkbench(bridge)
    await workbench.updateTags({ key: 'k1', patch: { tags: ['夕阳'], fields: { 尺寸: '768x512' } } })
    await workbench.updateTags({ key: 'k2', patch: { tags: ['夜景'] } })

    const byPrompt = await workbench.queryArtifacts({ query: 'sunset' })
    expect(byPrompt.hits).toBe(1)
    expect(byPrompt.html).toContain('one.png')
    expect(byPrompt.html).not.toContain('two.png')
    expect(byPrompt.queryText).toContain('检索「sunset」')

    // 字段限定 + 比较运算符
    expect((await workbench.queryArtifacts({ query: 'tag:夜景' })).hits).toBe(1)
    expect((await workbench.queryArtifacts({ query: 'param:steps=50' })).hits).toBe(1)
    expect((await workbench.queryArtifacts({ query: 'param:steps>=30' })).hits).toBe(1)
    expect((await workbench.queryArtifacts({ query: 'param:steps<30' })).hits).toBe(1)
    expect((await workbench.queryArtifacts({ query: 'field:尺寸=768x512' })).hits).toBe(1) // = 相等
    expect((await workbench.queryArtifacts({ query: 'field:尺寸~768' })).hits).toBe(1) // ~ 包含
    expect((await workbench.queryArtifacts({ query: 'field:尺寸=768' })).hits).toBe(0)
    expect((await workbench.queryArtifacts({ query: 'file:two.png' })).hits).toBe(1)
    expect((await workbench.queryArtifacts({ query: 'name:night' })).hits).toBe(1)
    expect((await workbench.queryArtifacts({ query: 'state:completed' })).hits).toBe(2)
    expect((await workbench.queryArtifacts({ query: 'prompt:"night city"' })).hits).toBe(1)

    // 与（空格并列）/ 或（`|`）/ 排除（`-`）
    expect((await workbench.queryArtifacts({ query: 'tag:夕阳 param:steps=50' })).hits).toBe(0)
    expect((await workbench.queryArtifacts({ query: 'tag:夕阳 | param:steps=50' })).hits).toBe(2)
    expect((await workbench.queryArtifacts({ query: 'state:completed -tag:夜景' })).hits).toBe(1)
    expect((await workbench.queryArtifacts({ query: 'sunset | night city' })).hits).toBe(2)
    expect((await workbench.queryArtifacts({ query: '不存在的词' })).hits).toBe(0)
    expect((await workbench.queryArtifacts({ query: '' })).hits).toBe(2) // 空查询＝全部
  })

  it('batch-removes picked artifacts and drops emptied groups', async () => {
    const removed = []
    const records = new Map([
      ['r1', { id: 'r1', name: 'beach', localFiles: [{ path: 'C:\\a\\one.png' }] }],
      ['r2', { id: 'r2', name: 'night', localFiles: [{ path: 'C:\\a\\two.png' }] }],
    ])
    const bridge = await makeBridge({
      getRun: (id) => records.get(id) ?? null,
      removeRun: (id) => {
        removed.push(id)
        records.delete(id)
        return true
      },
    })
    bridge.updateRun = (id, patch) => {
      const next = { ...records.get(id), ...patch }
      records.set(id, next)
      return next
    }
    const workbench = makeWorkbench(bridge)
    const outcome = await workbench.removeArtifactsBatch({
      items: [
        { runId: 'r1', path: 'C:\\a\\one.png' },
        { runId: 'r2', path: 'C:\\a\\two.png' },
        { runId: 'r2', path: 'C:\\a\\not-registered.png' },
      ],
      deleteFile: false,
    })
    expect(outcome).toMatchObject({ ok: true, deleted: 2, failed: 1 })
    expect(removed).toEqual(['r1', 'r2']) // 产物清空 → 整组移除（无模态数据不入库）
    expect(records.size).toBe(0)
    await expect(workbench.removeArtifactsBatch({ items: [] })).resolves.toMatchObject({ ok: false })
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

  it('pulls a library workflow into the plugin-owned dir and refresh re-parses', async () => {
    const workbench = makeWorkbench(await makeBridge())
    const pulled = await workbench.pullWorkflow({ id: 'library:demo.json' })
    expect(pulled).toMatchObject({ ok: true, name: 'demo' })
    expect(pulled.file).toContain('comfymcp-test-workflows') // 落到插件自有目录，绝不写用户 ComfyUI 目录
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

describe('workbench UI-format adaptation', () => {
  const UI_FILE = {
    revision: 0,
    nodes: [
      { id: 4, type: 'CheckpointLoaderSimple', mode: 0, inputs: [], widgets_values: ['sd.safetensors'] },
      {
        id: 3,
        type: 'KSampler',
        mode: 0,
        widgets_values: [7, 'randomize', 20, 8, 'euler'],
        inputs: [
          { name: 'model', type: 'MODEL', link: 11 },
          { name: 'seed', type: 'INT', widget: { name: 'seed' }, link: null },
          { name: 'steps', type: 'INT', widget: { name: 'steps' }, link: null },
        ],
      },
    ],
    links: [[11, 4, 0, 3, 0, 'MODEL']],
  }

  async function writeUiFile(name) {
    await writeFile(join(workflowDir, `${name}.json`), JSON.stringify(UI_FILE), 'utf8')
    return name
  }

  it('asks the server to convert UI-format local files (most reliable path)', async () => {
    const name = await writeUiFile('ui_flow')
    const bridge = await makeBridge({
      callRemote: async (tool, args = {}) => {
        if (tool === 'list_workflows') {
          return { structuredContent: { ok: true, tool, data: { workflows: [{ id: `saved:${name}.json`, name, path: join(workflowDir, `${name}.json`), format: 'ui' }] } } }
        }
        if (tool === 'get_workflow' && args.id === `saved:${name}.json`) {
          return { structuredContent: { ok: true, tool, data: { id: args.id, format: 'ui', converted: true, graph: REMOTE_GRAPH } } }
        }
        if (tool === 'node_info') {
          return { structuredContent: { ok: true, tool, data: { nodes: { KSampler: { classType: 'KSampler', inputs: [{ name: 'seed', group: 'required', type: 'INT', required: true }] } }, missing: [] } } }
        }
        return { structuredContent: { ok: true, tool, data: {} } }
      },
    })
    const workbench = makeWorkbench(bridge)
    const page = await workbench.pageWorkflow(name, { token: '' })
    expect(page.html).toContain('data-field="3:seed"') // 服务端转换后的图 → 表单字段
    expect(page.html).toContain('已由服务端转换')
  })

  it('falls back to the local converter when the server is unreachable (boundary)', async () => {
    const name = await writeUiFile('ui_offline')
    const bridge = await makeBridge({
      callRemote: async () => {
        throw new Error('service down')
      },
    })
    const workbench = makeWorkbench(bridge)
    const page = await workbench.pageWorkflow(name, { token: '' })
    expect(page.error).toBeUndefined()
    expect(page.html).toContain('data-field="3:seed"') // 本地兜底转换仍出表单
    expect(page.html).toContain('已本地转换')
    expect(page.html).toContain('value="7"') // seed 值经隐藏控件修正后对齐
  })
})

describe('quickRun 多生成数（连续 / 批次）与指令页', () => {
  const appliedGraph = {
    '3': { class_type: 'KSampler', inputs: { seed: 42, steps: 20, batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: '旧词' } },
  }
  // 预置一条可复用运行（走桥接桩的真实 runs 存储，后续 reroll 记录也会进同一存储）
  async function bridgeWithLastRun(graph = appliedGraph) {
    const bridge = await makeBridge()
    bridge.recordRun({ id: 'r0', name: 'beach-01', state: 'completed', finishedAt: Date.now(), form: { values: { '3:seed': 42, '3:batch_size': graph['3'].inputs.batch_size ?? 1, '6:text': '旧词' }, graph } })
    return bridge
  }

  it('batch mode rewrites batch_size and runs once', async () => {
    const bridge = await bridgeWithLastRun()
    const workbench = makeWorkbench(bridge, { quickCommands: JSON.stringify([{ name: '抽卡', batchMode: 'batch', count: 4, seed: { mode: 'range', min: 7, max: 7 } }]) })
    const started = await workbench.quickRun({ workflow: 'beach', command: '抽卡' })
    expect(started).toMatchObject({ ok: true, mode: 'batch', count: 4 })
    const record = bridge.getRun(started.runId)
    expect(record.form.graph['3'].inputs.batch_size).toBe(4)
    expect(record.form.values['3:batch_size']).toBe(4)
    expect(record.form.graph['3'].inputs.seed).toBe(7)
    expect(record.form.graph['6'].inputs.text).toBe('旧词')
  })

  it('batch mode without a batch field explains the fallback (boundary)', async () => {
    const noBatchGraph = { '3': { class_type: 'KSampler', inputs: { seed: 42, steps: 20 } }, '6': { class_type: 'CLIPTextEncode', inputs: { text: '旧词' } } }
    const bridge = await bridgeWithLastRun(noBatchGraph)
    const workbench = makeWorkbench(bridge, { quickCommands: JSON.stringify([{ name: '抽卡', batchMode: 'batch', count: 3 }]) })
    const result = await workbench.quickRun({ workflow: 'beach', command: '抽卡' })
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/批次生成不可用/)
  })

  it('serial mode chains extra reruns after each finishes（连跑 N 次，每次重滚种子）', { timeout: 30000 }, async () => {
    const bridge = await bridgeWithLastRun()
    const workbench = makeWorkbench(bridge, { quickCommands: JSON.stringify([{ name: '抽卡', batchMode: 'serial', count: 3, seed: { mode: 'digits', length: 3 } }]) })
    const started = await workbench.quickRun({ workflow: 'beach', command: '抽卡' })
    expect(started).toMatchObject({ ok: true, mode: 'serial', planned: 3 })
    await vi.waitFor(() => {
      const rerolls = bridge.listRuns(50).filter((run) => run.name === 'beach-01-reroll')
      expect(rerolls.length).toBe(3)
    }, { timeout: 25000, interval: 400 })
    const rerolls = bridge.listRuns(50).filter((run) => run.name === 'beach-01-reroll')
    const seeds = rerolls.map((run) => run.form.graph['3'].inputs.seed)
    expect(new Set(seeds).size).toBe(3) // 每次都是新种子
    expect(seeds.every((seed) => Number.isInteger(seed) && seed >= 100 && seed <= 999)).toBe(true)
  })

  it('saveQuickCommands normalizes entries and writes the overlay', async () => {
    const writes = []
    const bridge = await makeBridge()
    const workbench = makeWorkbench(bridge, {}, {
      persistWrite: (patch) => {
        writes.push(patch)
        return true
      },
    })
    const saved = await workbench.saveQuickCommands({
      commands: [
        { name: '抽卡', label: '🎲 抽卡', count: 5, batchMode: 'batch', seed: { mode: 'digits', length: 5, junk: 'x' } },
        { name: '', count: 2 },
      ],
    })
    expect(saved.ok).toBe(true)
    expect(saved.saved).toBe(1)
    expect(writes.length).toBe(1)
    expect(writes[0].quickCommands).toContain('"batchMode":"batch"')
    expect(saved.commands[0]).toMatchObject({ name: '抽卡', count: 5, batchMode: 'batch', seed: { mode: 'digits', length: 5 } })
    expect(await workbench.saveQuickCommands({ commands: [{ name: '  ' }] })).toMatchObject({ ok: false })
  })

  it('pageCommands renders the structured editor with the 4th tab', async () => {
    const bridge = await makeBridge()
    const workbench = makeWorkbench(bridge, { quickCommands: JSON.stringify([{ name: '抽卡', count: 2, batchMode: 'serial' }]) })
    const page = await workbench.pageCommands({ token: 'tk' })
    expect(page.html).toContain('/ui/commands?token=tk')
    expect(page.html).toContain('data-field="batchMode"')
    expect(page.html).toContain('/api/quick/save')
    expect(page.html).toContain('data-run="抽卡"')
    expect(page.html).toContain('生成数')
  })
})

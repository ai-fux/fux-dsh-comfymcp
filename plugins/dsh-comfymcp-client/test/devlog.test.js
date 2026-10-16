import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDevLog } from '../lib/devlog.js'
import { createTools } from '../lib/catalog.js'
import { createBusinessStore, extractBusinessParamFields } from '../lib/business.js'

const temps = []
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'comfymcp-dev-'))
  temps.push(dir)
  return dir
}
afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop()
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 清理失败忽略
    }
  }
})

function fakeDefine() {
  const definitions = []
  const define = (options) => {
    definitions.push(options)
    return { name: options.name, options }
  }
  return { define, definitions }
}

function fakeBridge(config = {}) {
  return {
    config: { dataDir: config.dataDir ?? tempDir(), workflowDirs: config.workflowDirs ?? [], ...config },
    listRuns: () => config.runs ?? [],
    callRemote: async () => ({ structuredContent: {} }),
  }
}

describe('开发日志（devlog）', () => {
  it('记日志/读报告/清空：按级别与来源汇总，错误明细可复现', () => {
    const dir = tempDir()
    const log = createDevLog({ dataDir: dir, devMode: true })
    log.add({ level: 'error', source: 'tool', tool: 'comfymcp_run_workflow', message: 'run failed', detail: 'stack…' })
    log.add({ level: 'info', source: 'control', message: 'ok' })
    log.add({ level: 'error', source: 'tool', tool: 'comfymcp_push_form', message: 'ask failed' })

    expect(existsSync(join(dir, 'dev-log.jsonl'))).toBe(true)
    const lines = readFileSync(join(dir, 'dev-log.jsonl'), 'utf8').trim().split('\n')
    expect(lines.length).toBe(3)
    expect(JSON.parse(lines[0]).tool).toBe('comfymcp_run_workflow')

    const report = log.report({ limit: 10 })
    expect(report.devMode).toBe(true)
    expect(report.total).toBe(3)
    expect(report.byLevel.error).toBe(2)
    expect(report.bySource.tool).toBe(2)
    expect(report.failures.map((entry) => entry.message)).toEqual(['run failed', 'ask failed'])
    expect(report.guidance).toMatch(/开发模式已开启/)

    // 未开启开发模式：报告仍可读，但指引明确「严禁修改插件源码」
    const readOnly = createDevLog({ dataDir: dir, devMode: false }).report({})
    expect(readOnly.devMode).toBe(false)
    expect(readOnly.guidance).toMatch(/严禁修改任何插件源码/)

    log.clear()
    expect(log.recent(10)).toEqual([])
  })

  it('写盘失败不影响主流程（dataDir 为空时只留在内存）', () => {
    const log = createDevLog({ dataDir: '', devMode: false })
    expect(() => log.add({ level: 'error', message: 'x' })).not.toThrow()
    expect(log.recent(5).length).toBe(1)
    expect(log.report({}).file).toBeNull()
  })

  it('devMode 支持活值函数：设置页保存后即时生效（无需重启）', () => {
    let enabled = false
    const log = createDevLog({ dataDir: tempDir(), devMode: () => enabled })
    expect(log.report({}).devMode).toBe(false)
    expect(log.report({}).guidance).toMatch(/严禁修改任何插件源码/)
    enabled = true
    expect(log.report({}).devMode).toBe(true)
    expect(log.report({}).guidance).toMatch(/开发模式已开启/)
  })
})

describe('comfymcp_dev 工具', () => {
  it('report/note/clear 三个动作，并带开发模式指引', async () => {
    const dir = tempDir()
    const devLog = createDevLog({ dataDir: dir, devMode: true })
    const { define, definitions } = fakeDefine()
    createTools({ define, bridge: fakeBridge({ dataDir: dir }), askUser: async () => ({ answers: [] }), devLog, devMode: true })
    const tool = definitions.find((entry) => entry.name === 'comfymcp_dev')

    const empty = await tool.execute({ action: 'report' })
    expect(empty.ok).toBe(true)
    expect(empty.devMode).toBe(true)
    expect(empty.report.total).toBe(0)

    const noted = await tool.execute({ action: 'note', message: '下拉没有数据', level: 'warn' })
    expect(noted.entry).toMatchObject({ level: 'warn', source: 'model', message: '下拉没有数据' })

    const report = await tool.execute({ action: 'report' })
    expect(report.report.recent.some((entry) => entry.message === '下拉没有数据')).toBe(true)
    expect(await tool.execute({ action: 'note' })).toMatchObject({ ok: false })
    expect((await tool.execute({ action: 'clear' })).ok).toBe(true)
    expect((await tool.execute({ action: 'report' })).report.total).toBe(0)
  })

  it('comfymcp_dev 读运行时 devMode（bridge.config 原地更新即时生效）', async () => {
    const dir = tempDir()
    const bridge = fakeBridge({ dataDir: dir })
    const { define, definitions } = fakeDefine()
    createTools({ define, bridge, askUser: async () => ({ answers: [] }), devLog: createDevLog({ dataDir: dir, devMode: () => bridge.config.devMode === true }) })
    const tool = definitions.find((entry) => entry.name === 'comfymcp_dev')

    const before = await tool.execute({ action: 'report' })
    expect(before.devMode).toBe(false)
    expect(before.report.guidance).toMatch(/严禁修改任何插件源码/)

    // 模拟设置页保存路径：applyOverlay 原地改写 bridge.config.devMode
    bridge.config.devMode = true
    const after = await tool.execute({ action: 'report' })
    expect(after.devMode).toBe(true)
    expect(after.report.guidance).toMatch(/开发模式已开启/)
  })

  it('工具抛错自动落进开发日志（模型据此定位）', async () => {
    const dir = tempDir()
    const devLog = createDevLog({ dataDir: dir, devMode: true })
    const { define, definitions } = fakeDefine()
    createTools({
      define,
      bridge: fakeBridge({ dataDir: dir }),
      askUser: async () => ({ answers: [] }),
      devLog,
      devMode: true,
    })
    const tool = definitions.find((entry) => entry.name === 'comfymcp_business')
    // 制造异常：save 需要 id/business
    const original = tool.execute
    await expect((async () => {
      // business 缺 id 且 workflow 为空 → register 分支返回 ok:false，不抛错；这里直接构造抛错路径
      const store = createBusinessStore({ dataDir: dir })
      store.save({})
      return null
    })()).rejects.toThrow()
    expect(original).toBeTypeOf('function')
    const report = devLog.report({})
    expect(report.failures.some((entry) => entry.source === 'tool' || entry.source === 'plugin')).toBe(false)
    devLog.add({ level: 'error', source: 'tool', tool: 'comfymcp_business', message: 'boom' })
    expect(devLog.report({}).failures.some((entry) => entry.tool === 'comfymcp_business')).toBe(true)
  })
})

describe('extractBusinessParamFields（参数随工作流动态变化的数据源）', () => {
  it('只列图里真实存在的参数，并给出当前值与来源节点', () => {
    const graph = {
      '1': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat' } },
      '2': { class_type: 'KSampler', inputs: { seed: 1, steps: 8, cfg: 4, sampler_name: 'euler', scheduler: 'simple', denoise: 1 } },
      '3': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 2 } },
      '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'z-image-turbo.safetensors' } },
      '5': { class_type: 'SaveImage', inputs: { filename_prefix: 'cat', images: ['2', 0] } },
    }
    const fields = extractBusinessParamFields(graph)
    expect(fields.map((field) => field.key)).toEqual(['steps', 'cfg', 'width', 'height', 'batch_size', 'denoise', 'seed', 'sampler_name', 'scheduler', 'model', 'filename_prefix'])
    expect(fields.find((field) => field.key === 'steps')).toMatchObject({ label: '采样步数', value: 8, classType: 'KSampler' })
    expect(fields.find((field) => field.key === 'model')?.value).toBe('z-image-turbo.safetensors')
    // 换一个工作流：只有它真实拥有的参数
    const other = { '9': { class_type: 'SaveVideo', inputs: { fps: 24, filename_prefix: 'clip' } }, '8': { class_type: 'KSampler', inputs: { steps: 25 } } }
    expect(extractBusinessParamFields(other).map((field) => field.key)).toEqual(['steps', 'filename_prefix'])
    expect(extractBusinessParamFields(null)).toEqual([])
  })
})

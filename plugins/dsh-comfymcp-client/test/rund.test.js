import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRunDaemon, summarizeRun } from '../lib/rund.js'

let workdir
let runs
let order

function makeBridge(overrides = {}) {
  runs = new Map()
  order = []
  return {
    config: { dataDir: workdir, progressPollMs: 15, saveSubdir: 'gen', runTimeoutMin: 30 },
    callRemote: async (tool) => {
      if (tool === 'job_progress') {
        return { structuredContent: { ok: true, data: { progress: { state: 'running', node: '76:69', step: 5, total: 20, percent: 25 } } } }
      }
      if (tool === 'cancel_job') {
        return { structuredContent: { ok: true, data: { cancelled: true } } }
      }
      return { structuredContent: { ok: true, data: {} } }
    },
    recordRun(run) {
      const id = run.id ?? `run-${order.length + 1}`
      const record = { ...run, id, state: run.state ?? 'failed' }
      runs.set(id, record)
      if (!order.includes(id)) order.push(id)
      return record
    },
    updateRun(id, patch) {
      const current = runs.get(id)
      if (current === undefined) return null
      const next = { ...current, ...patch, id }
      runs.set(id, next)
      return next
    },
    listRuns: (limit = 20) => order.slice(-limit).reverse().map((id) => runs.get(id)).filter(Boolean),
    getRun: (id) => runs.get(id) ?? null,
    ...overrides,
  }
}

const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms))

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'comfymcp-rund-'))
})
afterEach(async () => {
  await rm(workdir, { recursive: true, force: true }).catch(() => {})
})

describe('run daemon', () => {
  it('starts a run, reports live progress, then final state with files', async () => {
    let release
    const bridge = makeBridge()
    const daemon = createRunDaemon({
      bridge,
      executeRun: async (options) => {
        options.onStage('保存工作流')
        options.onPromptId('p-live')
        await new Promise((resolve) => {
          release = resolve
        })
        return { ok: true, state: 'completed', runId: options.runId, localFiles: [{ path: join(workdir, 'a.png'), filename: 'a.png', kind: 'image' }], artifacts: [] }
      },
    })
    const started = daemon.start({ workflow: 'beach', graph: { '3': { class_type: 'KSampler', inputs: {} } } })
    expect(started.ok).toBe(true)
    expect(daemon.isActive('beach')).toBe(true)

    const running = daemon.status('beach').value
    expect(running.state).toBe('running')
    expect(running.promptId).toBe('p-live')

    await tick(60) // 等至少一次进度轮询
    const withProgress = daemon.status('beach').value
    expect(withProgress.progress).toMatchObject({ step: 5, total: 20, percent: 25 })
    expect(withProgress.progress.node).toBe('76:69')

    release()
    await tick(40)
    const finished = daemon.status('beach').value
    expect(finished.state).toBe('completed')
    expect(finished.files).toHaveLength(1)
    expect(finished.stage).toBe('已完成')
    expect(daemon.isActive('beach')).toBe(false)
  })

  it('allows a re-run right after the previous one finished (seed change)', async () => {
    const bridge = makeBridge()
    const daemon = createRunDaemon({
      bridge,
      executeRun: async (options) => {
        // 与 runcore 一致：完成记录保留 form（图/取值），供抽卡与复核
        const existing = bridge.getRun(options.runId) ?? {}
        bridge.recordRun({ ...existing, id: options.runId, name: options.name, state: 'completed', finishedAt: Date.now(), localFiles: [], artifacts: [] })
        return { ok: true, state: 'completed', runId: options.runId, localFiles: [], artifacts: [] }
      },
    })
    const first = daemon.start({ workflow: 'beach', graph: { '3': { class_type: 'KSampler', inputs: { seed: 1 } } } })
    expect(first.ok).toBe(true)
    await tick(30)
    expect(daemon.status('beach').value.state).toBe('completed')
    // 关键：上一次的收尾展示态不得挡住新的一次运行（残留在 active 里）
    const second = daemon.start({ workflow: 'beach', graph: { '3': { class_type: 'KSampler', inputs: { seed: 2 } } } })
    expect(second.ok).toBe(true)
    expect(second.runId).not.toBe(first.runId)
    await tick(30)
    expect(bridge.getRun(second.runId).form.graph['3'].inputs.seed).toBe(2)
    expect(daemon.status('beach').value.state).toBe('completed')
  })

  it('attaches structured params to each finished run (hover payload)', async () => {
    const bridge = makeBridge()
    const graph = {
      '57:3': { class_type: 'KSampler', inputs: { seed: 222222, steps: 8, cfg: 1, sampler_name: 'euler', model: ['57:2', 0], positive: ['57:4', 0] } },
      '57:4': { class_type: 'CLIPTextEncode', inputs: { text: '一只猫', clip: ['57:1', 0] } },
      '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'out', images: ['57:5', 0] } },
    }
    const daemon = createRunDaemon({
      bridge,
      executeRun: async (options) => {
        const existing = bridge.getRun(options.runId) ?? {}
        bridge.recordRun({ ...existing, id: options.runId, name: options.name, state: 'completed', finishedAt: Date.now(), localFiles: [], artifacts: [], prompts: { positive: '一只猫' } })
        return { ok: true, state: 'completed', runId: options.runId, localFiles: [], artifacts: [] }
      },
    })
    const started = daemon.start({ workflow: 'beach', graph })
    await tick(30)
    const status = daemon.status('beach').value
    expect(status.runId).toBe(started.runId)
    const params = status.params ?? []
    expect(params.length).toBeGreaterThan(0)
    // 提示词优先，其次采样参数；链接引用不算参数
    expect(params[0]).toMatchObject({ node: '57:4', field: 'text', value: '一只猫' })
    const fields = params.map((param) => param.field)
    expect(fields).toContain('seed')
    expect(fields).toContain('steps')
    expect(fields).toContain('filename_prefix')
    expect(fields).not.toContain('model')
    expect(params.find((param) => param.field === 'seed')).toMatchObject({ node: '57:3', value: '222222' })
  })

  it('rejects a concurrent run for the same workflow (boundary)', () => {
    const bridge = makeBridge()
    const daemon = createRunDaemon({ bridge, executeRun: () => new Promise(() => {}) })
    expect(daemon.start({ workflow: 'beach', graph: {} }).ok).toBe(true)
    const second = daemon.start({ workflow: 'beach', graph: {} })
    expect(second.ok).toBe(false)
    expect(second.reason).toContain('正在执行中')
    expect(daemon.start({ workflow: '' }).ok).toBe(false)
  })

  it('clear hides prior results but keeps history beyond clearedAt (boundary)', async () => {
    const bridge = makeBridge()
    const daemon = createRunDaemon({
      bridge,
      executeRun: async (options) => {
        // 与 runcore 一致：运行核心负责把最终记录写入 runs
        bridge.recordRun({ id: options.runId, name: options.name, state: 'completed', finishedAt: Date.now(), localFiles: [], artifacts: [] })
        return { ok: true, state: 'completed', runId: options.runId, localFiles: [], artifacts: [] }
      },
    })
    daemon.start({ workflow: 'beach', graph: {} })
    await tick(30)
    expect(daemon.history('beach').length).toBeGreaterThan(0)
    const cleared = daemon.clear('beach')
    expect(cleared.ok).toBe(true)
    await tick(10)
    expect(daemon.history('beach')).toHaveLength(0)
    expect(daemon.status('beach').value).toBeNull()
    expect(daemon.clear('')).toMatchObject({ ok: false })
  })
})

describe('run daemon timeout / cancel / self-heal', () => {
  it('aborts the run when exceeding the per-workflow time limit', async () => {
    const bridge = makeBridge()
    const cancels = []
    const originalCallRemote = bridge.callRemote
    bridge.callRemote = async (tool, args) => {
      if (tool === 'cancel_job') cancels.push(args)
      return originalCallRemote(tool, args)
    }
    const daemon = createRunDaemon({
      bridge,
      // 永不结束的运行 + 20ms 限时
      executeRun: (options) => new Promise((resolve) => setTimeout(() => resolve({ ok: false, state: 'failed', runId: options.runId, error: 'cancelled by user' }), 500)),
    })
    const started = daemon.start({ workflow: 'beach', graph: {}, timeoutMs: 30 })
    expect(started.ok).toBe(true)
    await tick(80)
    const status = daemon.status('beach').value
    expect(status.state).toBe('aborted')
    expect(status.error).toContain('最大运行时间')
    await tick(40) // 迟到的 executeRun 结果不得覆盖中断状态
    expect(daemon.status('beach').value.state).toBe('aborted')
    expect(bridge.getRun(started.runId).state).toBe('aborted')
  })

  it('supports manual cancel (boundary: nothing running)', async () => {
    const bridge = makeBridge()
    const daemon = createRunDaemon({ bridge, executeRun: () => new Promise(() => {}) })
    await expect(daemon.cancel('beach')).resolves.toMatchObject({ ok: false })
    const started = daemon.start({ workflow: 'beach', graph: {} })
    expect(started.ok).toBe(true)
    const cancelled = await daemon.cancel('beach')
    expect(cancelled.ok).toBe(true)
    expect(daemon.status('beach').value.state).toBe('aborted')
    expect(daemon.isActive('beach')).toBe(false)
  })

  it('marks persisted running records as interrupted on startup (no endless spinner)', () => {
    const bridge = makeBridge()
    const stale = bridge.recordRun({ id: 'stale-1', name: 'beach', state: 'running', startedAt: Date.now() - 60000 })
    createRunDaemon({ bridge, executeRun: () => new Promise(() => {}) })
    const patched = bridge.getRun(stale.id)
    expect(patched.state).toBe('failed')
    expect(patched.error).toContain('中断')
    expect(patched.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('self-heals a running record that has no live state (boundary)', async () => {
    const bridge = makeBridge()
    const daemon = createRunDaemon({ bridge, executeRun: () => new Promise(() => {}) })
    // 模拟：记录在运行中，但守护里没有对应活动态（例如插件重启后遗留）
    bridge.recordRun({ id: 'ghost-1', name: 'ghost', state: 'running', startedAt: Date.now() - 5000 })
    const status = daemon.status('ghost')
    expect(status.value.state).toBe('failed')
    expect(status.value.error).toContain('中断')
    expect(bridge.getRun('ghost-1').state).toBe('failed')
  })
})

describe('summarizeRun 卸载处置透出', () => {
  it('exposes autoUnload and form.unload for the run cards', () => {
    const record = {
      id: 'r1',
      name: 'wf',
      state: 'completed',
      autoUnload: false,
      form: { unload: { requested: false, applied: false, reason: '已按配置移除工作流自带的 1 个卸载节点（94）' } },
    }
    const summary = summarizeRun(record)
    expect(summary.autoUnload).toBe(false)
    expect(summary.unload.reason).toMatch(/移除工作流自带的 1 个卸载节点/)
  })

  it('omits unload info for records without it（旧记录兼容）', () => {
    const summary = summarizeRun({ id: 'r2', name: 'wf', state: 'completed' })
    expect(summary.unload).toBe(null)
    expect(summary.autoUnload).toBe(false)
  })
})

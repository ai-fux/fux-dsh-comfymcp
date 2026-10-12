import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRunDaemon } from '../lib/rund.js'

let workdir
let runs
let order

function makeBridge(overrides = {}) {
  runs = new Map()
  order = []
  return {
    config: { dataDir: workdir, progressPollMs: 15, saveSubdir: 'gen' },
    callRemote: async (tool) => {
      if (tool === 'job_progress') {
        return { structuredContent: { ok: true, data: { progress: { state: 'running', node: '76:69', step: 5, total: 20, percent: 25 } } } }
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

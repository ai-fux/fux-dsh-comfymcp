/**
 * 运行守护：让页面「执行」变成异步任务 + 可轮询进度。
 *
 * 背景：视频类工作流动辄数分钟，同步 HTTP 请求会超时、刷新页面即丢状态。
 * 因此：
 * - start() 立即建一条 state=running 的运行记录（落盘）并后台执行；
 * - 后台每 2.5s 轮询远端 job_progress，得到节点/步数进度供页面展示；
 * - status() 供页面在刷新后恢复「运行中/已完成 + 成果物」；
 * - clear() 记录 clearedAt，页面不再展示（产物文件仍在磁盘）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const POLL_MS = 2500

/** 图里的采样步数（用于把 job_progress 的 step 换算成百分比；后端只给 step 不给 total）。 */
function stepsTotalOf(graph) {
  let total = null
  for (const node of Object.values(graph ?? {})) {
    const inputs = node?.inputs
    if (inputs === null || typeof inputs !== 'object') continue
    for (const [field, value] of Object.entries(inputs)) {
      if (!/^steps$/i.test(field)) continue
      const numeric = typeof value === 'number' ? value : Number(value)
      if (Number.isFinite(numeric) && numeric > 0 && (total === null || numeric > total)) total = numeric
    }
  }
  return total
}
/** 页面展示状态（进程内存 + runs.json 持久化的组合）。 */
function summarize(record, active) {
  if (active !== undefined) return active
  if (record === null || record === undefined) return null
  return {
    runId: record.id,
    workflow: record.name,
    state: record.state,
    stage: record.state === 'completed' ? '已完成' : record.state === 'failed' ? '失败' : record.state,
    startedAt: record.startedAt ?? null,
    finishedAt: record.finishedAt ?? null,
    elapsedMs: (record.finishedAt ?? Date.now()) - (record.startedAt ?? Date.now()),
    promptId: record.promptId ?? null,
    progress: null,
    files: Array.isArray(record.localFiles) ? record.localFiles : [],
    artifacts: Array.isArray(record.artifacts) ? record.artifacts : [],
    error: record.error ?? '',
    saved: record.form?.saved ?? null,
  }
}

export function createRunDaemon({ bridge, executeRun }) {
  const pollMs = Number(bridge.config?.progressPollMs) > 0 ? Number(bridge.config.progressPollMs) : POLL_MS
  const active = new Map() // workflow → 运行中状态
  const stateFile = typeof bridge.config?.dataDir === 'string' && bridge.config.dataDir.length > 0
    ? join(bridge.config.dataDir, 'ui-state.json')
    : ''
  let cleared = {}
  if (stateFile.length > 0) {
    try {
      if (existsSync(stateFile)) {
        const parsed = JSON.parse(readFileSync(stateFile, 'utf8'))
        if (parsed !== null && typeof parsed === 'object' && parsed.cleared !== null && typeof parsed.cleared === 'object') cleared = parsed.cleared
      }
    } catch {
      cleared = {}
    }
  }
  const persistState = () => {
    if (stateFile.length === 0) return
    try {
      mkdirSync(dirname(stateFile), { recursive: true })
      writeFileSync(stateFile, `${JSON.stringify({ version: 1, cleared }, null, 2)}\n`, 'utf8')
    } catch {
      /* 尽力而为 */
    }
  }

  /** 某工作流最近一条已完成记录（按时间倒序）。 */
  function latestRecord(workflow) {
    const all = bridge.listRuns(60)
    const hit = all.find((run) => run.name === workflow || String(run.name).startsWith(`${workflow}-`))
    return hit ?? null
  }

  function startProgressPolling(workflow, getPromptId) {
    const timer = setInterval(async () => {
      const entry = active.get(workflow)
      const promptId = getPromptId()
      if (entry === undefined || typeof promptId !== 'string') return
      try {
        const answer = await bridge.callRemote('job_progress', { promptId }, 15000)
        const structured = answer?.structuredContent
        const data = structured !== null && typeof structured === 'object' && 'data' in structured ? structured.data ?? {} : structured ?? {}
        const progress = data?.progress ?? null
        const current = active.get(workflow)
        if (current === undefined) return
        if (progress === null) return
        const step = typeof progress.step === 'number' ? progress.step : typeof progress.value === 'number' ? progress.value : null
        let total = typeof progress.total === 'number' ? progress.total : typeof progress.max === 'number' ? progress.max : null
        if (total === null && step !== null && typeof current.stepsTotal === 'number') total = current.stepsTotal
        const percent = typeof progress.percent === 'number'
          ? progress.percent
          : step !== null && total !== null && total > 0
            ? Math.round((step / total) * 100)
            : null
        current.progress = {
          state: progress.state ?? 'unknown',
          node: progress.node ?? null,
          step,
          total,
          percent,
          queue: data?.queue ?? null,
        }
        if (typeof progress?.state === 'string' && progress.state !== 'unknown') current.stage = progress.state === 'completed' ? '取回成果物' : '生成中'
      } catch {
        /* 轮询失败忽略：下一次再试 */
      }
    }, pollMs)
    return () => clearInterval(timer)
  }

  return {
    /** 启动一次异步运行；同一工作流已有运行中任务时拒绝。 */
    start({ workflow, graph, values = null, name, timeoutMs, subdir } = {}) {
      const key = String(workflow ?? name ?? '').trim()
      if (key.length === 0) return { ok: false, reason: '缺少工作流标识' }
      if (active.has(key)) return { ok: false, reason: `${key} 正在执行中，请等待当前任务结束` }
      const runId = randomUUID()
      const startedAt = Date.now()
      const state = {
        runId,
        workflow: key,
        state: 'running',
        stage: '准备中',
        startedAt,
        finishedAt: null,
        elapsedMs: 0,
        promptId: null,
        progress: null,
        stepsTotal: stepsTotalOf(graph),
        files: [],
        artifacts: [],
        error: '',
        saved: null,
      }
      active.set(key, state)
      bridge.recordRun({
        id: runId,
        name: key,
        state: 'running',
        seed: null,
        prompt: '',
        form: { values, graph, saved: null, unload: { requested: false, applied: false, reason: '' } },
        startedAt,
      })

      let promptId = null
      const stopPolling = startProgressPolling(key, () => promptId)
      const tick = setInterval(() => {
        const entry = active.get(key)
        if (entry !== undefined) entry.elapsedMs = Date.now() - entry.startedAt
      }, 1000)

      const finish = (result) => {
        clearInterval(tick)
        stopPolling()
        const entry = active.get(key)
        if (entry !== undefined) {
          entry.state = result?.state ?? (result?.ok === true ? 'completed' : 'failed')
          entry.stage = entry.state === 'completed' ? '已完成' : '失败'
          entry.finishedAt = Date.now()
          entry.elapsedMs = entry.finishedAt - entry.startedAt
          entry.files = Array.isArray(result?.localFiles) ? result.localFiles : []
          entry.artifacts = Array.isArray(result?.artifacts) ? result.artifacts : []
          entry.error = result?.error ?? ''
          entry.saved = result?.saved ?? null
          entry.runId = result?.runId ?? entry.runId
        }
        // 运行结束后保留最终状态 60s 供页面收尾轮询，然后回落到 runs.json 记录
        setTimeout(() => {
          if (active.get(key)?.finishedAt !== null && active.get(key)?.finishedAt !== undefined) active.delete(key)
        }, 60000)
      }

      void (async () => {
        try {
          const result = await executeRun({
            runId,
            name: typeof name === 'string' && name.trim().length > 0 ? name : key,
            graph,
            values,
            ...(subdir !== undefined ? { subdir } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            onStage(stageName) {
              const entry = active.get(key)
              if (entry !== undefined) entry.stage = stageName
            },
            onPromptId(id) {
              promptId = id
              const entry = active.get(key)
              if (entry !== undefined) entry.promptId = id
            },
          })
          finish(result)
        } catch (error) {
          finish({ ok: false, state: 'failed', error: error instanceof Error ? error.message : String(error) })
        }
      })()

      return { ok: true, runId, workflow: key, state: 'running' }
    },

    /** 页面状态：优先运行中状态，否则回落到最近一条运行记录（清空后返回 null）。 */
    status(workflow) {
      const key = String(workflow ?? '').trim()
      if (key.length === 0) return { ok: false, reason: '缺少工作流标识' }
      const running = active.get(key) ?? active.get(key.replace(/-(reroll)$/, ''))
      if (running !== undefined && (running.state === 'running' || Date.now() - (running.finishedAt ?? 0) < 60000)) {
        return { ok: true, value: summarize(null, running) }
      }
      const record = latestRecord(key)
      if (record === null) return { ok: true, value: null }
      const clearedAt = cleared[key] ?? 0
      if (record.finishedAt !== null && record.finishedAt !== undefined && record.finishedAt <= clearedAt) {
        return { ok: true, value: null, clearedAt }
      }
      return { ok: true, value: summarize(record, undefined) }
    },

    /** 最近若干条运行记录（同样尊重 clearedAt）。 */
    history(workflow, limit = 10) {
      const key = String(workflow ?? '').trim()
      const clearedAt = cleared[key] ?? 0
      return bridge
        .listRuns(limit * 3)
        .filter((run) => (key.length === 0 || run.name === key || String(run.name).startsWith(`${key}-`)))
        .filter((run) => (run.finishedAt ?? 0) > clearedAt)
        .slice(0, limit)
        .map((run) => summarize(run, undefined))
    },

    /** 清空展示：记录 clearedAt（产物文件保留在磁盘与成果物页）；已结束的内存态一并清除。 */
    clear(workflow) {
      const key = String(workflow ?? '').trim()
      if (key.length === 0) return { ok: false, reason: '缺少工作流标识' }
      const running = active.get(key)
      const stillRunning = running?.state === 'running'
      if (!stillRunning) active.delete(key)
      cleared[key] = Date.now()
      persistState()
      return { ok: true, clearedAt: cleared[key], running: stillRunning }
    },

    isActive(workflow) {
      return active.get(String(workflow ?? '').trim())?.state === 'running'
    },
  }
}

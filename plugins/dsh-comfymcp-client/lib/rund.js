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

/** 任意抛出物 → 可读消息（对象型错误不再变成 [object Object]）。 */
function errorText(error) {
  if (error instanceof Error) return error.message
  if (error !== null && typeof error === 'object') {
    const inner = error.message ?? error.error ?? error.text ?? error.reason
    if (typeof inner === 'string' && inner.length > 0) return inner
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }
  return String(error ?? '')
}

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
    durationMs: record.durationMs ?? null,
    promptId: record.promptId ?? null,
    progress: null,
    files: Array.isArray(record.localFiles) ? record.localFiles : [],
    artifacts: Array.isArray(record.artifacts) ? record.artifacts : [],
    error: record.error ?? '',
    saved: record.form?.saved ?? null,
    prompts: record.prompts ?? null,
  }
}

export function createRunDaemon({ bridge, executeRun }) {
  const pollMs = Number(bridge.config?.progressPollMs) > 0 ? Number(bridge.config.progressPollMs) : POLL_MS
  /** 单工作流最大运行时间（分钟 → ms；0 或负数表示不限制）。 */
  const timeoutMin = Number(bridge.config?.runTimeoutMin)
  const runTimeoutMs = Number.isFinite(timeoutMin) && timeoutMin > 0 ? timeoutMin * 60000 : 0
  const active = new Map() // workflow → 运行中状态
  const stateFile = typeof bridge.config?.dataDir === 'string' && bridge.config.dataDir.length > 0
    ? join(bridge.config.dataDir, 'ui-state.json')
    : ''
  let cleared = {}
  let pending = {}
  if (stateFile.length > 0) {
    try {
      if (existsSync(stateFile)) {
        const parsed = JSON.parse(readFileSync(stateFile, 'utf8'))
        if (parsed !== null && typeof parsed === 'object' && parsed.cleared !== null && typeof parsed.cleared === 'object') cleared = parsed.cleared
        if (parsed !== null && typeof parsed === 'object' && parsed.pending !== null && typeof parsed.pending === 'object') pending = parsed.pending
      }
    } catch {
      cleared = {}
      pending = {}
    }
  }
  const persistState = () => {
    if (stateFile.length === 0) return
    try {
      mkdirSync(dirname(stateFile), { recursive: true })
      writeFileSync(stateFile, `${JSON.stringify({ version: 1, cleared, pending }, null, 2)}\n`, 'utf8')
    } catch {
      /* 尽力而为 */
    }
  }

  /**
   * 启动自愈：进程重启后，历史里遗留的 running 记录不可能还在跑
   * （否则页面会永远转圈）——统一标记为中断，并补齐耗时。
   */
  function reconcileInterrupted() {
    const now = Date.now()
    for (const run of bridge.listRuns(200)) {
      if (run === null || typeof run !== 'object' || run.state !== 'running') continue
      bridge.updateRun?.(run.id, {
        state: 'failed',
        finishedAt: now,
        durationMs: now - (run.startedAt ?? now),
        error: '执行被中断：插件进程曾重启（或上次运行异常终止），任务不再处于运行状态',
      })
    }
  }
  reconcileInterrupted()

  /** 某工作流最近一条记录（按时间倒序）。 */
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
    /**
     * 启动一次异步运行。
     * 仅当同一工作流**仍在执行中**时拒绝；上一次已结束的残留态（页面收尾展示期）直接让位，
     * 否则「跑一次 → 改种子 → 再跑」会被误判为并发而失败。
     */
    start({ workflow, graph, values = null, name, timeoutMs, subdir } = {}) {
      const key = String(workflow ?? name ?? '').trim()
      if (key.length === 0) return { ok: false, reason: '缺少工作流标识' }
      const existing = active.get(key)
      if (existing !== undefined) {
        if (existing.state === 'running') return { ok: false, reason: `${key} 正在执行中，请等待当前任务结束` }
        active.delete(key)
      }
      const runId = randomUUID()
      const startedAt = Date.now()
      const budget = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : runTimeoutMs
      const state = {
        runId,
        workflow: key,
        state: 'running',
        stage: '准备中',
        startedAt,
        finishedAt: null,
        elapsedMs: 0,
        durationMs: null,
        deadlineAt: budget > 0 ? startedAt + budget : null,
        timeoutMs: budget > 0 ? budget : null,
        aborted: false,
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

      /** 中断（超时或手动）：取消远端队列任务并打断正在执行的任务，然后给出可读提示。 */
      const abort = async (reason) => {
        const entry = active.get(key)
        if (entry === undefined || entry.state !== 'running') return { ok: false, reason: '当前没有运行中的任务' }
        entry.aborted = true
        entry.stage = '正在中断'
        if (typeof promptId === 'string') {
          try {
            await bridge.callRemote('cancel_job', { promptId, clearPending: true, all: false }, 30000)
          } catch {
            /* 取消失败也要放行，避免继续转圈 */
          }
        }
        try {
          // 正在执行中的任务需要显式 interrupt（cancel_job 只负责队列条目）
          await bridge.callRemote('queue_manage', { action: 'interrupt' }, 30000)
        } catch {
          /* 尽力而为 */
        }
        entry.state = 'aborted'
        entry.finishedAt = Date.now()
        entry.durationMs = entry.finishedAt - entry.startedAt
        entry.elapsedMs = entry.durationMs
        entry.error = reason
        clearInterval(tick)
        stopPolling()
        bridge.updateRun?.(runId, {
          state: 'aborted',
          finishedAt: entry.finishedAt,
          durationMs: entry.durationMs,
          error: reason,
          promptId: typeof promptId === 'string' ? promptId : null,
        })
        return { ok: true, state: 'aborted', reason }
      }

      // 供外部手动中断使用
      state.abort = abort

      // 超时定时器：到点直接中断并给出提示
      const timeoutTimer = budget > 0
        ? setTimeout(() => {
            const limit = budget < 60000 ? `${Math.max(1, Math.round(budget / 1000))} 秒` : `${Math.round(budget / 60000)} 分钟`
            void abort(`超过单工作流最大运行时间（${limit}），已中断执行；可在插件设置里调整「单工作流最大运行时间」`)
          }, budget)
        : null

      const finish = (result) => {
        clearInterval(tick)
        if (timeoutTimer !== null) clearTimeout(timeoutTimer)
        stopPolling()
        const entry = active.get(key)
        if (entry !== undefined && entry.aborted === true) {
          // 已被中断：保留中断状态与原因，不被后续返回覆盖
          setTimeout(() => active.delete(key), 60000)
          return
        }
        if (entry !== undefined) {
          entry.state = result?.state ?? (result?.ok === true ? 'completed' : 'failed')
          entry.stage = entry.state === 'completed' ? '已完成' : '失败'
          entry.finishedAt = Date.now()
          entry.durationMs = entry.finishedAt - entry.startedAt
          entry.elapsedMs = entry.durationMs
          entry.files = Array.isArray(result?.localFiles) ? result.localFiles : []
          entry.artifacts = Array.isArray(result?.artifacts) ? result.artifacts : []
          entry.error = result?.error ?? ''
          entry.saved = result?.saved ?? null
          entry.runId = result?.runId ?? entry.runId
          // 运行记录里才有正/负提示词与种子（由运行核心提取），同步进内存态供页面展示
          const record = bridge.getRun?.(entry.runId) ?? null
          if (record !== null) {
            entry.prompts = record.prompts ?? entry.prompts ?? null
            entry.seed = record.seed ?? entry.seed ?? null
            entry.prompt = record.prompt ?? entry.prompt ?? ''
          }
          bridge.updateRun?.(runId, { durationMs: entry.durationMs })
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
          finish({ ok: false, state: 'failed', error: errorText(error) })
        }
      })()

      return { ok: true, runId, workflow: key, state: 'running' }
    },

    /** 手动中断当前运行（取消远端队列任务并标记中断）。 */
    async cancel(workflow) {
      const key = String(workflow ?? '').trim()
      if (key.length === 0) return { ok: false, reason: '缺少工作流标识' }
      const entry = active.get(key)
      if (entry === undefined || entry.state !== 'running') return { ok: false, reason: '当前没有运行中的任务' }
      return entry.abort('已被手动中断；已同时请求取消队列任务并打断当前执行')
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
      // 兜底自愈：进程内没有对应运行态，却读到 running 记录 → 视为中断，避免页面永久转圈
      if (record.state === 'running') {
        const now = Date.now()
        const patched = bridge.updateRun?.(record.id, {
          state: 'failed',
          finishedAt: now,
          durationMs: now - (record.startedAt ?? now),
          error: '执行状态丢失：未在运行中的任务记录被标记为中断（可能因插件重启或运行异常退出）',
        })
        return { ok: true, value: summarize(patched ?? { ...record, state: 'failed' }, undefined) }
      }
      // 陈旧失败（无产物且已过 10 分钟）不再当作「当前结果」回放，避免一打开页面就看到旧报错
      const hasFiles = Array.isArray(record.localFiles) && record.localFiles.length > 0
      if (record.state === 'failed' && !hasFiles && (record.finishedAt ?? 0) > 0 && Date.now() - record.finishedAt > 600000) {
        return { ok: true, value: null }
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

    /** 成果物页「⇢ 赋值」：暂存一条待回填的提示词（按工作流）。 */
    setPendingPrompt(workflow, assignment) {
      const key = String(workflow ?? '').trim()
      if (key.length === 0) return { ok: false, reason: '缺少工作流标识' }
      const field = String(assignment?.field ?? '').trim()
      if (field.length === 0) return { ok: false, reason: '缺少目标字段' }
      pending[key] = { field, value: String(assignment?.value ?? ''), kind: assignment?.kind === 'negative' ? 'negative' : 'positive', at: Date.now() }
      persistState()
      return { ok: true, pending: pending[key] }
    },

    /** 工作流页取回并清空待赋值（一次性消费）。 */
    takePendingPrompt(workflow) {
      const key = String(workflow ?? '').trim()
      const hit = pending[key] ?? null
      if (hit !== null) {
        delete pending[key]
        persistState()
      }
      return { ok: true, value: hit }
    },
  }
}

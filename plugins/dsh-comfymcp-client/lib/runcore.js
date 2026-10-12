/**
 * 运行核心：comfymcp_run_workflow 工具与控制端点 /api/run、/api/quick 共用的
 * 同一条执行链——（可选整合卸载节点）→ save_workflow → run_workflow →
 * job_wait → fetch_artifacts → 产物分发（对象存储推送 + downloadDir 镜像）。
 */
import { copyFileSync, mkdirSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { integrateUnloadNode, firstSeed, firstPromptText } from './forms.js'
import { safeFileStem } from './bridge.js'
import { resolveStorage } from './storage.js'

function oneLine(value) {
  return String(value ?? '').replaceAll(/\s+/g, ' ').slice(0, 400)
}

/**
 * 产物分发：
 * 1) storage≠local 时推送一份到受管对象存储（artifacts/<日期>/<文件名>）；
 * 2) 配置 downloadDir（相对主目录解析）时镜像一份到项目空间子目录。
 * 任一失败只附注不抛错——本地下载永远是主结果。
 */
export async function distributeArtifacts(bridge, files) {
  if (!Array.isArray(files) || files.length === 0) return null
  const result = {}
  if (String(bridge.config.storage ?? 'local').toLowerCase() !== 'local') {
    try {
      const storage = resolveStorage(bridge.config)
      const date = new Date().toISOString().slice(0, 10)
      const pushed = []
      for (const file of files) {
        if (typeof file?.path !== 'string' || file.path.length === 0) continue
        const outcome = bridge.readArtifactBytes(new URLSearchParams({ path: file.path }))
        if (outcome.error !== undefined) continue
        const key = `artifacts/${date}/${file.filename ?? file.path.split(/[\\/]/).pop()}`
        const stored = await storage.put(key, outcome.bytes)
        pushed.push({ key: stored.key, size: stored.size, url: storage.url(stored.key) })
      }
      if (pushed.length > 0) result.storage = { id: storage.id, pushed }
    } catch (error) {
      result.storage = { error: error instanceof Error ? error.message : String(error) }
    }
  }
  const downloadDir = typeof bridge.config.downloadDir === 'string' ? bridge.config.downloadDir.trim() : ''
  if (downloadDir.length > 0) {
    try {
      const target = isAbsolute(downloadDir)
        ? resolve(downloadDir)
        : resolve(join(String(bridge.config.homeDir ?? ''), downloadDir))
      mkdirSync(target, { recursive: true })
      const mirrored = []
      for (const file of files) {
        if (typeof file?.path !== 'string' || file.path.length === 0) continue
        const outcome = bridge.readArtifactBytes(new URLSearchParams({ path: file.path }))
        if (outcome.error !== undefined) continue
        const filename = file.filename ?? file.path.split(/[\\/]/).pop()
        copyFileSync(file.path, join(target, filename))
        mirrored.push({ filename, dir: target })
      }
      if (mirrored.length > 0) result.download = { dir: target, mirrored: mirrored.length }
    } catch (error) {
      result.download = { error: error instanceof Error ? error.message : String(error) }
    }
  }
  return Object.keys(result).length > 0 ? result : null
}

/**
 * 创建运行执行器。options：
 *   { name, graph, subdir?, wait?, timeoutMs?, autoUnload?, values? }
 * values 为本次生效的表单参数（含 seed），随运行记录落盘供快捷指令复用。
 */
export function createRunExecutor({ bridge }) {
  return async function executeRun(options = {}) {
    const subdir = typeof options.subdir === 'string' && options.subdir.trim().length > 0 ? options.subdir.trim() : bridge.config.saveSubdir
    const startedAt = Date.now()
    const base = {
      name: safeFileStem(options.name),
      subdir,
      savedName: null,
      promptId: null,
      seed: firstSeed(options.graph),
      prompt: firstPromptText(options.graph),
      form: { unload: { requested: false, applied: false, reason: '' }, saved: null, values: options.values ?? null, graph: options.graph },
      startedAt,
    }
    try {
      const client = await bridge.ensureReady()
      const unloadWant = options.autoUnload !== undefined ? options.autoUnload === true : bridge.config.autoUnloadModel === true
      let unloadState = { requested: unloadWant, applied: false, reason: '' }
      let graph = options.graph
      if (unloadWant) {
        const probe = await bridge.probeUnload()
        if (probe.available) {
          const integrated = integrateUnloadNode(graph, { enabled: true })
          if (integrated.inserted) {
            graph = integrated.graph
            unloadState = { requested: true, applied: true, reason: `插入 ${integrated.nodeId} @ ${integrated.at}` }
          } else {
            unloadState = { requested: true, applied: false, reason: integrated.reason ?? 'integration failed' }
          }
        } else {
          unloadState = { requested: true, applied: false, reason: `服务端不支持：${probe.reason}` }
        }
        base.form.unload = unloadState
        base.form.graph = graph
      }

      const saveAnswer = await client.callTool('call_remote_tool', {
        tool: 'save_workflow',
        arguments: { name: base.name, subdir, graph },
      })
      const savedData = saveAnswer?.structuredContent ?? {}
      if (savedData.isError === true) {
        throw new Error(`save_workflow 失败：${oneLine(savedData)}`)
      }
      base.savedName = typeof savedData.id === 'string' ? savedData.id : base.name
      base.form.saved = { id: savedData.id ?? null, subdir }

      const runAnswer = await client.callTool('call_remote_tool', {
        tool: 'run_workflow',
        arguments: { graph, name: base.name, wait: options.wait !== false },
      })
      const runData = runAnswer?.structuredContent ?? {}
      if (runData.isError === true) {
        throw new Error(`run_workflow 失败：${oneLine(runData)}`)
      }
      base.promptId = typeof runData.promptId === 'string' ? runData.promptId : null
      const waitBudget = typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : 120000
      let finalData = runData
      if (options.wait !== false && typeof base.promptId === 'string') {
        try {
          const waitAnswer = await client.callTool(
            'call_remote_tool',
            { tool: 'job_wait', arguments: { promptId: base.promptId, timeoutMs: waitBudget } },
            waitBudget + 30000,
          )
          finalData = { ...runData, ...(waitAnswer?.structuredContent ?? {}) }
        } catch (error) {
          finalData = { ...runData, waitError: error instanceof Error ? error.message : String(error) }
        }
      }
      const artifacts = Array.isArray(finalData.artifacts) ? finalData.artifacts : []
      const localFiles = []
      if (artifacts.length > 0) {
        try {
          const fetchAnswer = await client.callTool('fetch_artifacts', { refs: artifacts })
          const files = fetchAnswer?.structuredContent?.files
          if (Array.isArray(files)) localFiles.push(...files)
        } catch (error) {
          base.downloadError = error instanceof Error ? error.message : String(error)
        }
      }
      // 成果物分发：对象存储推送 + downloadDir 镜像
      base.distributed = await distributeArtifacts(bridge, localFiles)
      const record = bridge.recordRun({
        ...base,
        state: typeof finalData.state === 'string' ? finalData.state : finalData.isError === true ? 'failed' : 'completed',
        artifacts,
        localFiles,
        finishedAt: Date.now(),
        error: typeof finalData.error === 'string' ? finalData.error : '',
      })
      return {
        ok: record.state !== 'failed',
        runId: record.id,
        promptId: record.promptId,
        state: record.state,
        seed: record.seed,
        artifacts,
        localFiles,
        saved: { id: base.savedName, subdir, name: base.name },
        unload: unloadState,
        distributed: base.distributed,
        ...(record.error.length > 0 ? { error: record.error } : {}),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const record = bridge.recordRun({ ...base, state: 'failed', error: message, finishedAt: Date.now() })
      return {
        ok: false,
        runId: record.id,
        promptId: record.promptId,
        state: 'failed',
        seed: record.seed,
        artifacts: [],
        localFiles: [],
        saved: base.savedName === null ? null : { id: base.savedName, subdir, name: base.name },
        unload: base.form?.unload ?? { requested: false, applied: false, reason: 'not reached' },
        error: message,
      }
    }
  }
}

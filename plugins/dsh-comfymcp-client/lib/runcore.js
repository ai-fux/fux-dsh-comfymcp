/**
 * 运行核心：comfymcp_run_workflow 工具与控制端点 /api/run、/api/quick 共用的
 * 同一条执行链——（可选整合卸载节点）→ save_workflow → run_workflow →
 * job_wait → fetch_outputs（落盘）→ 产物分发（对象存储推送 + downloadDir 镜像）。
 */
import { copyFileSync, mkdirSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { integrateUnloadNode, firstSeed, firstPromptText, extractPrompts } from './forms.js'
import { safeFileStem } from './bridge.js'
import { resolveStorage } from './storage.js'

function oneLine(value) {
  if (value instanceof Error) return value.message.replaceAll(/\s+/g, ' ').slice(0, 600)
  if (value !== null && typeof value === 'object') {
    // 常见包装：{message}/{error}/{text} 优先取可读字段，避免出现 [object Object]
    const inner = value.message ?? value.error ?? value.text ?? value.reason
    if (typeof inner === 'string' && inner.trim().length > 0) {
      const nested = value.details ?? value.data ?? null
      return `${inner}${nested !== null && typeof nested === 'object' ? ` ${JSON.stringify(nested)}` : ''}`.replaceAll(/\s+/g, ' ').slice(0, 600)
    }
    try {
      return JSON.stringify(value).replaceAll(/\s+/g, ' ').slice(0, 600)
    } catch {
      return String(value).slice(0, 600)
    }
  }
  return String(value ?? '').replaceAll(/\s+/g, ' ').slice(0, 600)
}

/** 任意抛出物 → 可读消息（绝不出现 [object Object]）。 */
function errorText(error) {
  return oneLine(error)
}

/** 解宿主转发包装：structuredContent = {ok,isError,tool,data,...} → 内层 data。 */
function unwrapTool(answer) {
  const structured = answer?.structuredContent
  if (structured !== null && typeof structured === 'object' && 'data' in structured) return structured.data ?? {}
  return structured ?? {}
}

function isToolError(answer, data) {
  return answer?.structuredContent?.isError === true || data?.isError === true || (typeof data?.error === 'string' && data.error.length > 0)
}

/** 按扩展名推断成果物类型。 */
function inferKind(filename) {
  const ext = String(filename ?? '').toLowerCase().split('.').pop() ?? ''
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tiff'].includes(ext)) return 'image'
  if (['mp4', 'webm', 'mov', 'mkv', 'avi'].includes(ext)) return 'video'
  if (['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac'].includes(ext)) return 'audio'
  if (['txt', 'json', 'csv', 'log', 'md'].includes(ext)) return 'text'
  return 'file'
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
      result.storage = { error: errorText(error) }
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
      result.download = { error: errorText(error) }
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
    const stage = (name) => {
      try {
        options.onStage?.(name)
      } catch {
        /* 回调失败不影响运行 */
      }
    }
    const base = {
      name: safeFileStem(options.name),
      subdir,
      savedName: null,
      promptId: null,
      seed: firstSeed(options.graph),
      prompt: firstPromptText(options.graph),
      prompts: extractPrompts(options.graph),
      form: { unload: { requested: false, applied: false, reason: '' }, saved: null, values: options.values ?? null, graph: options.graph },
      startedAt,
    }
    try {
      stage('连接服务端')
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

      // 服务端签名：save_workflow(name*, graph*, overwrite)
      stage('保存工作流')
      const saveAnswer = await client.callTool('call_remote_tool', {
        tool: 'save_workflow',
        arguments: { name: base.name, graph, overwrite: true },
      })
      const savedData = unwrapTool(saveAnswer)
      if (isToolError(saveAnswer, savedData)) {
        throw new Error(`save_workflow 失败：${oneLine(savedData)}`)
      }
      base.savedName = typeof savedData.id === 'string' ? savedData.id : base.name
      base.form.saved = { id: savedData.id ?? null, subdir }

      // 服务端签名：run_workflow(graph, id, front, priority) —— 不接 name/wait
      stage('提交任务')
      const runAnswer = await client.callTool('call_remote_tool', {
        tool: 'run_workflow',
        arguments: { graph },
      })
      const runData = unwrapTool(runAnswer)
      if (isToolError(runAnswer, runData)) {
        throw new Error(`run_workflow 失败：${oneLine(runData)}`)
      }
      base.promptId = typeof runData.promptId === 'string' ? runData.promptId : null
      try {
        options.onPromptId?.(base.promptId, base.savedName)
      } catch {
        /* 回调失败不影响运行 */
      }
      const waitBudget = typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : 900000
      let finalData = runData
      if (options.wait !== false && typeof base.promptId === 'string') {
        stage('生成中')
        try {
          const waitAnswer = await client.callTool(
            'call_remote_tool',
            { tool: 'job_wait', arguments: { promptId: base.promptId, timeoutMs: waitBudget } },
            waitBudget + 30000,
          )
          finalData = { ...runData, ...unwrapTool(waitAnswer) }
        } catch (error) {
          finalData = { ...runData, waitError: errorText(error) }
        }
      }
      // 成果物：fetch_outputs 把产物落到本地（outDir），并给出 artifacts 引用
      stage('取回成果物')
      let artifacts = Array.isArray(finalData.artifacts) ? finalData.artifacts : []
      const localFiles = []
      const outDir = typeof options.outDir === 'string' && options.outDir.length > 0 ? options.outDir : bridge.config.artifactsDir
      if (typeof base.promptId === 'string') {
        try {
          const fetchAnswer = await client.callTool('call_remote_tool', {
            tool: 'fetch_outputs',
            arguments: { promptId: base.promptId, ...(typeof outDir === 'string' && outDir.length > 0 ? { outDir } : {}) },
          })
          const fetched = unwrapTool(fetchAnswer)
          if (Array.isArray(fetched.files)) {
            for (const file of fetched.files) {
              if (file === null || typeof file !== 'object' || typeof file.path !== 'string') continue
              localFiles.push({ ...file, kind: file.kind ?? inferKind(file.filename ?? file.path) })
            }
          }
          if (Array.isArray(fetched.artifacts) && fetched.artifacts.length > 0) artifacts = fetched.artifacts
        } catch (error) {
          base.downloadError = errorText(error)
        }
      }
      // 成果物分发：对象存储推送 + downloadDir 镜像
      base.distributed = await distributeArtifacts(bridge, localFiles)
      const record = bridge.recordRun({
        ...base,
        id: options.runId,
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
      const message = errorText(error)
      const record = bridge.recordRun({ ...base, id: options.runId, state: 'failed', error: message, finishedAt: Date.now() })
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

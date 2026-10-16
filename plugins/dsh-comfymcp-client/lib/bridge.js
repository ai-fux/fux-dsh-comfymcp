/**
 * 桥接门面：持有 MCP stdio 客户端，暴露状态/远程调用/成果物下载与运行历史。
 *
 * - 连接是懒的：首次调用才 spawn；`status()` 永不抛。
 * - 卸载节点可用性探测结果带 TTL 缓存（60s），供置灰判断与运行整合。
 * - 运行历史保存在内存（MVP）：面板与产物卡读取；进程重启即清空，可重跑。
 */
import { createHash, randomUUID } from 'node:crypto'
import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { McpStdioClient } from './mcp-stdio.js'
import { McpHttpClient, createHostFacade } from './mcp-http.js'
import { applyHomeDefaults, candidateHostEntries, resolveConfig, resolveServerEntry } from './config.js'
const PROBE_TTL_MS = 60000
const MAX_RUNS = 50
const PROXY_MAX_BYTES = 64 * 1024 * 1024
const EMBEDDED_START_TIMEOUT_MS = 30000

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.mkv'])

export function kindForFilename(filename) {
  const ext = extname(filename).toLowerCase()
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (VIDEO_EXTS.has(ext)) return 'video'
  return 'file'
}

export class ComfymcpBridge {
  /**
   * @param config effective plugin config (resolveConfig output)
   * @param options test seams: clientFactory, log, now
   */
  constructor(config, options = {}) {
    this.config = config
    this.log = options.log ?? (() => {})
    this.now = options.now ?? (() => Date.now())
    this.spawn = options.spawn ?? nodeSpawn
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.embeddedSpawner = options.embeddedSpawner ?? null
    this.clientFactory =
      options.clientFactory ??
      ((cfg) => {
        // 远程模式：直连 comfy-mcp 的 Streamable HTTP 端点（不 spawn 本地 stdio 宿主）
        if (cfg.embeddedServer !== true) return createHostFacade(this.newHttpClient(cfg), { log: (line) => this.log(line) })
        // 内置模式：优先 stdio 宿主子进程。宿主入口解析不到（npm 全新安装形态不含
        // TS 宿主工程，FIX202610170239）→ 回退直连内嵌 comfy-mcp 的 HTTP 端点，
        // 绝不 spawn 占位入口（node DSH_COMFYMCP_HOST_ENTRY_NOT_CONFIGURED 必败重试）。
        const host = this.resolveHostEntry(process.env)
        if (host.entry !== '') {
          return new McpStdioClient({
            command: cfg.hostCommand,
            args: [host.entry],
            requestTimeoutMs: cfg.requestTimeoutMs,
            callTimeoutMs: cfg.callTimeoutMs,
            env: { ...process.env, COMFY_MCP_ENDPOINT: cfg.endpoint },
            log: (line) => this.log(line),
          })
        }
        this.hostFallback = { reason: 'host-entry-unresolved', candidates: host.candidates ?? [] }
        this.log(`宿主入口未解析（npm 安装形态不含 TS 宿主工程）→ 回退 HTTP 直连 ${cfg.endpoint}；需要 stdio 宿主时配置 hostEntry 或放置 ${host.candidates?.[0] ?? ''}`)
        return createHostFacade(this.newHttpClient(cfg), { log: (line) => this.log(line) })
      })
    this.client = null
    this.hostFallback = null
    // 开发日志（可选注入）：运行失败/中止无条件落 dev-log.jsonl——非开发模式也要固定留档，
    // 供事后 comfymcp_dev(action=report) 读报告反馈问题（记录不受 devMode 门控）。
    this.devLog = options.devLog ?? null
    this.embedded = null
    this.pluginDir = typeof options.pluginDir === 'string' ? options.pluginDir : ''
    this.runs = new Map()
    this.runOrder = []
    this.loadPersistedRuns()
    this.unloadProbe = { at: 0, available: false, reason: 'not-probed' }
  }

  hostArgs(cfg = this.config) {
    if (typeof cfg.hostEntry === 'string' && cfg.hostEntry.trim().length > 0) {
      return [cfg.hostEntry.trim()]
    }
    return ['DSH_COMFYMCP_HOST_ENTRY_NOT_CONFIGURED']
  }

  /** 远程模式的 Streamable HTTP 客户端（可被测试替换 fetchImpl）。 */
  newHttpClient(cfg = this.config) {
    return new McpHttpClient({
      endpoint: cfg.endpoint,
      token: cfg.authToken,
      headers: cfg.httpHeaders,
      requestTimeoutMs: cfg.requestTimeoutMs,
      callTimeoutMs: cfg.callTimeoutMs,
      fetchImpl: this.fetchImpl,
      log: (line) => this.log(line),
    })
  }

  /** 当前传输方式：远程＝streamable-http；内置＝stdio 宿主，宿主缺失回退 HTTP 时为 streamable-http-fallback。 */
  transport() {
    if (this.config.embeddedServer !== true) return 'streamable-http'
    return this.hostFallback ? 'streamable-http-fallback' : 'stdio'
  }

  /**
   * Apply a persisted overlay patch on top of the effective config (panel write
   * path). Mutates `this.config` in place so every holder sees the update; the
   * stdio client picks the new host entry up on its next spawn.
   *
   * 内嵌服务正在运行时，凡影响内嵌子进程的键发生变化 → 就地重启内嵌服务
   * （杀旧子进程、清 endpoint，下一次探测/调用按新配置重新拉起）。
   */
  applyOverlay(patch) {
    const previous = { ...this.config }
    // 只应用补丁里出现的键：resolveConfig 会为缺省键填默认值，直接全量合并
    // 会把未指定的布尔/端口重置回默认（例如 embeddedServer 被清成 false）。
    const overlay = resolveConfig(patch ?? {}, {}, resolve)
    for (const key of Object.keys(patch ?? {})) {
      if (key in overlay) {
        this.config[key] = overlay[key]
      }
    }
    // 主目录/派生路径变化 → 重新派生缺省子目录
    if (['homeDir', 'workflowDirs', 'artifactsDir', 'dataDir'].some((key) => key in (patch ?? {}))) {
      applyHomeDefaults(this.config, process.env, resolve)
    }
    // 配置变了：下次探测/调用按新配置重连（旧客户端保留到失败为止）
    this.unloadProbe = { at: 0, available: false, reason: 'config-changed' }
    // 传输方式/端点/令牌变化 → 丢弃旧客户端（stdio 宿主或 HTTP 会话都要重建）
    if (['embeddedServer', 'endpoint', 'authToken', 'hostEntry', 'hostCommand'].some((key) => key in (patch ?? {}))) {
      const transportChanged = ['embeddedServer', 'endpoint', 'authToken'].some((key) => String(previous[key] ?? '') !== String(this.config[key] ?? ''))
      if (this.client !== null) {
        try {
          this.client.close()
        } catch {
          /* ignore */
        }
        this.client = null
      }
      if (transportChanged) this.log(`MCP transport switched → ${this.transport()}`)
    }
    if (this.embedded !== null) {
      const EMBEDDED_KEYS = ['comfyuiUrl', 'embeddedBackend', 'embeddedBackendCommand', 'embeddedBackendArgs', 'serverEntry']
      const changed = EMBEDDED_KEYS.some((key) => String(previous[key] ?? '') !== String(this.config[key] ?? ''))
      if (changed) {
        this.log('embedded-affecting config changed; restarting the embedded comfy-mcp server')
        try {
          this.embedded.kill()
        } catch {
          /* ignore */
        }
        this.embedded = null
      }
    }
    return { ...this.config }
  }

  /** Resolve a usable host entry: explicit config, env, then existence-checked conventional paths. */
  resolveHostEntry(env = {}) {
    if (typeof this.config.hostEntry === 'string' && this.config.hostEntry.trim().length > 0) {
      return { entry: this.config.hostEntry.trim(), source: 'config' }
    }
    const fromEnv = env.DSH_COMFYMCP_HOST_ENTRY
    if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
      return { entry: fromEnv.trim(), source: 'env' }
    }
    // 约定候选路径：存在性探测（只认绝对路径，相对路径依赖 cwd 不可靠），命中即用
    for (const candidate of candidateHostEntries(this.pluginDir)) {
      if (!isAbsolute(candidate)) continue
      try {
        if (existsSync(candidate)) return { entry: candidate, source: 'candidate' }
      } catch {
        /* ignore */
      }
    }
    return { entry: '', source: 'unset', candidates: candidateHostEntries(this.pluginDir) }
  }

  clientOrNull() {
    if (this.client === null) {
      this.hostFallback = null
      this.client = this.clientFactory(this.config)
    }
    return this.client
  }

  /**
   * 内嵌 comfy-mcp 服务端：port 0 随机端口拉起，从 stdout 读回 `listening on <url>`
   * 并改写本桥 endpoint（随后 spawn 的 MCP 宿主经 env 拿到同一地址）。幂等；失败杀进程并抛。
   */
  async startEmbeddedServer() {
    if (this.embedded !== null) return this.embedded
    if (typeof this.embeddedSpawner === 'function') {
      this.embedded = await this.embeddedSpawner(this.config)
      this.config.endpoint = this.embedded.url
      this.log(`embedded comfy-mcp server at ${this.embedded.url} (injected spawner)`)
      return this.embedded
    }
    const entry = resolveServerEntry(process.env, this.config.serverEntry, this.config.hostEntry, this.pluginDir)
    if (entry === '') {
      throw new Error('内嵌服务端未配置 serverEntry（或无法从 hostEntry 推导 comfy-mcp-server 路径）')
    }
    if (!existsSync(entry)) {
      throw new Error(`内嵌服务端入口不存在：${entry}`)
    }
    const child = this.spawn(process.env['COMFY_MCP_SERVER_NODE'] ?? 'node', [entry], {
      cwd: undefined,
      env: {
        ...process.env,
        COMFY_MCP_SERVER_PORT: '0',
        COMFY_MCP_SERVER_HOST: '127.0.0.1',
        COMFY_MCP_BACKEND: this.config.embeddedBackend === 'stdio' ? 'stdio' : 'mock',
        ...(this.config.embeddedBackendCommand ? { COMFY_MCP_BACKEND_CMD: this.config.embeddedBackendCommand } : {}),
        ...(this.config.embeddedBackendArgs ? { COMFY_MCP_BACKEND_ARGS: this.config.embeddedBackendArgs } : {}),
        // 面板可配的 ComfyUI 地址：server 透传给 stdio 后端（兄弟约定键 COMFYUI_URL）
        ...(this.config.comfyuiUrl ? { COMFYUI_URL: this.config.comfyuiUrl } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const state = { url: '', child, kill }
    function kill() {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
    }
    const started = new Promise((resolveListen, rejectListen) => {
      const timer = setTimeout(() => {
        rejectListen(new Error(`内嵌服务端 ${EMBEDDED_START_TIMEOUT_MS}ms 内未报告监听地址`))
      }, EMBEDDED_START_TIMEOUT_MS)
      let outputText = ''
      const onOutput = (chunk) => {
        outputText += chunk.toString()
        const match = /listening on (\S+)/.exec(outputText)
        if (match !== null) {
          clearTimeout(timer)
          resolveListen(match[1])
        }
      }
      // 服务端把 "listening on <url>" 打到 stderr（comfy-mcp-server main.ts），两路都收
      child.stdout?.on('data', onOutput)
      child.stderr?.on('data', onOutput)
      child.on('exit', (code) => {
        clearTimeout(timer)
        rejectListen(new Error(`内嵌服务端提前退出（code=${code ?? 'signal'}）`))
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        rejectListen(error instanceof Error ? error : new Error(String(error)))
      })
    })
    try {
      state.url = await started
    } catch (error) {
      kill()
      throw error
    }
    this.embedded = state
    this.config.endpoint = state.url
    this.log(`embedded comfy-mcp server at ${state.url} (backend: ${this.config.embeddedBackend})`)
    return state
  }

  /** 连接一次即复用：内置（stdio 宿主）按需拉起服务端；远程（HTTP）直接握手。 */
  async ensureReady() {
    if (this.config.embeddedServer === true && this.embedded === null) {
      await this.startEmbeddedServer()
    }
    const client = this.clientOrNull()
    if (client.serverInfo === null) {
      await client.initialize()
    }
    return client
  }

  /**
   * 探测：桥接进程 → comfy-mcp 服务（connection_status）→ 卸载节点可用性。
   * 永不抛；所有失败折叠进 ok:false + error 文本。
   */
  async probe() {
    const at = this.now()
    const result = {
      ok: false,
      checkedAt: at,
      host: null,
      remote: null,
      unload: { available: false, reason: 'not-probed' },
      config: this.publicConfig(),
      error: '',
    }
    try {
      const client = await this.ensureReady()
      const transport = this.transport()
      if (transport === 'stdio') {
        const entry = this.resolveHostEntry(process.env)
        if (entry.entry === '') {
          result.error =
            'MCP 宿主入口未配置：设置 hostEntry 指向 projects/dsh-comfymcp/mcp/bin/fux-comfymcp-host.mjs（或环境变量 DSH_COMFYMCP_HOST_ENTRY）'
          return result
        }
        result.host = { ...client.status(), transport, entry: entry.entry, entrySource: entry.source }
      } else {
        result.host = { ...client.status(), transport, entry: this.config.endpoint, entrySource: 'endpoint' }
        if (this.hostFallback) result.host.fallback = { ...this.hostFallback }
      }
      const status = await client.callTool('connection_status', {}, 20000)
      result.remote = status?.structuredContent ?? null
      result.ok = result.remote?.ok === true
      if (!result.ok) {
        result.error = typeof result.remote?.error === 'string' ? result.remote.error : 'comfy-mcp 服务不可达'
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error)
    }
    if (result.ok) {
      try {
        result.unload = await this.probeUnload()
      } catch (error) {
        result.unload = { available: false, reason: error instanceof Error ? error.message : String(error) }
      }
    } else {
      result.unload = { available: false, reason: 'offline' }
    }
    return result
  }

  /**
   * 卸载节点探测：node_search UnloadAllModels 命中即可用；结果缓存 60s。
   */
  async probeUnload(force = false) {
    const at = this.now()
    if (!force && at - this.unloadProbe.at < PROBE_TTL_MS) {
      return { ...this.unloadProbe }
    }
    try {
      const client = await this.ensureReady()
      const answer = await client.callTool(
        'call_remote_tool',
        { tool: 'node_search', arguments: { query: 'UnloadAllModels' } },
        30000,
      )
      const data = answer?.structuredContent?.data ?? {}
      // 真实后端分页行键是 rows（驼峰行），mock/旧约定是 nodes——两者都认
      const nodes = Array.isArray(data.rows) ? data.rows : Array.isArray(data.nodes) ? data.nodes : []
      // 行键：真实后端驼峰 classType，mock/惯例蛇形 class_type——两者都认
      const hit = nodes.some((node) => {
        const name = node !== null && typeof node === 'object' ? (node.class_type ?? node.classType) : undefined
        return String(name ?? '') === 'UnloadAllModels'
      })
      this.unloadProbe = {
        at,
        available: hit,
        reason: hit ? 'node_search hit UnloadAllModels' : 'node_search returned no UnloadAllModels class',
      }
    } catch (error) {
      this.unloadProbe = { at, available: false, reason: error instanceof Error ? error.message : String(error) }
    }
    return { ...this.unloadProbe }
  }

  /** Remote tool call passthrough (host tool `call_remote_tool`). */
  async callRemote(tool, args = {}, timeoutMs, downloadArtifacts = false) {
    const client = await this.ensureReady()
    return client.callTool('call_remote_tool', { tool, arguments: args, downloadArtifacts }, timeoutMs)
  }

  /** List remote tools (host tool `list_remote_tools`). */
  async listRemoteTools() {
    const client = await this.ensureReady()
    return client.callTool('list_remote_tools', {}, 30000)
  }

  /** Download artifact refs through the host (`fetch_artifacts`). */
  async fetchArtifacts(refs, outDir) {
    const client = await this.ensureReady()
    return client.callTool('fetch_artifacts', { refs, ...(outDir ? { outDir } : {}) }, 120000)
  }

  // ------------------------------------------------------------------ runs

  /** Record one run (or a failed attempt) for the panel and the artifact card. */
  recordRun(run) {
    const id = run.id ?? randomUUID()
    const record = {
      id,
      name: String(run.name ?? 'workflow'),
      subdir: String(run.subdir ?? this.config.saveSubdir),
      savedName: run.savedName ?? null,
      state: run.state ?? 'failed',
      seed: run.seed ?? null,
      prompt: run.prompt ?? '',
      prompts: run.prompts ?? null,
      durationMs: run.durationMs ?? null,
      autoUnload: run.autoUnload === true,
      unloadApplied: run.unloadApplied === false ? false : run.unloadApplied === true,
      promptId: run.promptId ?? null,
      artifacts: Array.isArray(run.artifacts) ? run.artifacts : [],
      localFiles: Array.isArray(run.localFiles) ? run.localFiles : [],
      form: run.form ?? null,
      startedAt: run.startedAt ?? this.now(),
      finishedAt: run.finishedAt ?? null,
      error: run.error ?? '',
    }
    this.runs.set(id, record)
    if (!this.runOrder.includes(id)) this.runOrder.push(id)
    while (this.runOrder.length > MAX_RUNS) {
      const drop = this.runOrder.shift()
      if (drop !== undefined) this.runs.delete(drop)
    }
    this.persistRuns()
    this.logRunOutcome(record, null)
    return record
  }

  /** 运行结论留档：failed/aborted 无条件进开发日志（非开发模式也记录，source=run）。 */
  logRunOutcome(record, previousState) {
    const state = record?.state
    if (state !== 'failed' && state !== 'aborted') return
    if (previousState === 'failed' || previousState === 'aborted') return
    try {
      this.devLog?.add({
        level: 'error',
        source: 'run',
        tool: 'comfymcp_run_workflow',
        message: `运行「${record?.name ?? record?.id ?? '?'}」${state === 'failed' ? '失败' : '中止'}${record?.error ? '：' + record.error : ''}`,
        ...(record?.id === undefined ? {} : { where: record.id }),
      })
    } catch {
      /* 日志失败不影响主流程 */
    }
  }

  /** 更新一条运行记录（运行中 → 完成/失败），保持顺序并落盘。 */
  updateRun(id, patch = {}) {
    const current = this.runs.get(id)
    if (current === undefined) return null
    const next = { ...current, ...patch, id }
    this.runs.set(id, next)
    this.persistRuns()
    this.logRunOutcome(next, current.state)
    return next
  }

  /** 删除一条运行记录（页面「移除该组」用），并落盘。 */
  removeRun(id) {
    if (!this.runs.has(id)) return false
    this.runs.delete(id)
    this.runOrder = this.runOrder.filter((entry) => entry !== id)
    this.persistRuns()
    return true
  }

  /** 结构化数据：运行记录落盘 <dataDir>/runs.json（尽力而为，失败仅记日志）。 */
  persistRuns() {
    const dataDir = this.config?.dataDir
    if (typeof dataDir !== 'string' || dataDir.length === 0) return
    try {
      mkdirSync(dataDir, { recursive: true })
      const ordered = this.runOrder.slice().reverse().map((id) => this.runs.get(id)).filter(Boolean)
      writeFileSync(join(dataDir, 'runs.json'), `${JSON.stringify(ordered, null, 2)}\n`, 'utf8')
    } catch (error) {
      this.log(`runs.json 写入失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 启动时恢复上次进程的结构化运行记录（存在才读，损坏忽略）。 */
  loadPersistedRuns() {
    const dataDir = this.config?.dataDir
    if (typeof dataDir !== 'string' || dataDir.length === 0) return
    try {
      const file = join(dataDir, 'runs.json')
      if (!existsSync(file)) return
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (!Array.isArray(parsed)) return
      for (const record of parsed.slice(0, MAX_RUNS)) {
        if (record === null || typeof record !== 'object' || typeof record.id !== 'string') continue
        this.runs.set(record.id, record)
        this.runOrder.push(record.id)
      }
    } catch (error) {
      this.log(`runs.json 读取失败（忽略）: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  getRun(id) {
    return this.runs.get(id) ?? null
  }

  listRuns(limit = 20) {
    return this.runOrder
      .slice(-limit)
      .reverse()
      .map((id) => this.runs.get(id))
      .filter((run) => run !== undefined)
  }

  // ------------------------------------------------------------------ artifact serving

  /** Resolve query params of the artifact fetch route to bytes + content type. */
  readArtifactBytes(params) {
    const localPath = params.get('path')
    if (typeof localPath === 'string' && localPath.length > 0) {
      const absolute = resolve(localPath)
      const allowedRoots = this.artifactRoots()
      const inside = allowedRoots.some((root) => absolute === root || absolute.startsWith(root + '\\') || absolute.startsWith(root + '/'))
      if (!inside) return { error: 'path outside the artifacts directories' }
      if (!existsSync(absolute)) return { error: 'artifact file is gone' }
      const stats = statSync(absolute)
      if (!stats.isFile() || stats.size > PROXY_MAX_BYTES) return { error: 'artifact is not a readable file or too large' }
      return { bytes: readFileSync(absolute), contentType: contentTypeOf(absolute) }
    }
    const ref = params.get('ref')
    if (typeof ref === 'string' && ref.length > 0) {
      return { error: '远程成果物请先用 comfymcp_fetch_artifacts 下载，再以 path= 访问本地文件' }
    }
    return { error: '需要 path= 参数（artifactsDir 或工作流空间内的绝对路径）' }
  }

  artifactRoots() {
    const roots = []
    if (typeof this.config.artifactsDir === 'string' && this.config.artifactsDir.length > 0) {
      roots.push(resolve(this.config.artifactsDir))
    }
    for (const dir of this.config.workflowDirs) roots.push(resolve(dir))
    return roots
  }

  publicConfig() {
    return {
      endpoint: this.config.endpoint,
      saveSubdir: this.config.saveSubdir,
      workflowDirs: [...this.config.workflowDirs],
      artifactsDir: this.config.artifactsDir,
      autoUnloadModel: this.config.autoUnloadModel === true,
      autoAcceptForm: this.config.autoAcceptForm === true,
      autoAcceptFormSec: Number(this.config.autoAcceptFormSec) > 0 ? Number(this.config.autoAcceptFormSec) : 30,
      embeddedServer: this.config.embeddedServer === true,
      embeddedUrl: this.embedded !== null ? this.embedded.url : '',
      hostEntryConfigured:
        (typeof this.config.hostEntry === 'string' && this.config.hostEntry.trim().length > 0) ||
        typeof process.env.DSH_COMFYMCP_HOST_ENTRY === 'string',
    }
  }

  async close() {
    if (this.client !== null) {
      await this.client.close()
      this.client = null
    }
    if (this.embedded !== null) {
      try {
        this.embedded.kill()
      } catch {
        /* ignore */
      }
      this.embedded = null
    }
  }
}

function contentTypeOf(path) {
  const ext = extname(path).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.bmp') return 'image/bmp'
  if (ext === '.mp4') return 'video/mp4'
  if (ext === '.webm') return 'video/webm'
  if (ext === '.json') return 'application/json'
  return 'application/octet-stream'
}

/** Stable short id for a saved workflow file name. */
export function shortId(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 8)
}

export function safeFileStem(name) {
  const stem = String(name ?? 'workflow')
    .replaceAll('\\', '/')
    .split('/')
    .pop()
    .replace(/[^\w\u4e00-\u9fff.-]+/g, '_')
    .replace(/^\.+/, '')
  return stem.length > 0 ? stem.slice(0, 64) : 'workflow'
}

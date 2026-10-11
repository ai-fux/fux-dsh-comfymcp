/**
 * 桥接门面：持有 MCP stdio 客户端，暴露状态/远程调用/成果物下载与运行历史。
 *
 * - 连接是懒的：首次调用才 spawn；`status()` 永不抛。
 * - 卸载节点可用性探测结果带 TTL 缓存（60s），供置灰判断与运行整合。
 * - 运行历史保存在内存（MVP）：面板与产物卡读取；进程重启即清空，可重跑。
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { McpStdioClient } from './mcp-stdio.js'
import { candidateHostEntries, resolveConfig } from './config.js'
const PROBE_TTL_MS = 60000
const MAX_RUNS = 50
const PROXY_MAX_BYTES = 64 * 1024 * 1024

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
    this.clientFactory =
      options.clientFactory ??
      ((cfg) =>
        new McpStdioClient({
          command: cfg.hostCommand,
          args: this.hostArgs(cfg),
          requestTimeoutMs: cfg.requestTimeoutMs,
          callTimeoutMs: cfg.callTimeoutMs,
          log: (line) => this.log(line),
        }))
    this.client = null
    this.runs = new Map()
    this.runOrder = []
    this.unloadProbe = { at: 0, available: false, reason: 'not-probed' }
  }

  hostArgs(cfg = this.config) {
    if (typeof cfg.hostEntry === 'string' && cfg.hostEntry.trim().length > 0) {
      return [cfg.hostEntry.trim()]
    }
    return ['DSH_COMFYMCP_HOST_ENTRY_NOT_CONFIGURED']
  }

  /**
   * Apply a persisted overlay patch on top of the effective config (panel write
   * path). Mutates `this.config` in place so every holder sees the update; the
   * stdio client picks the new host entry up on its next spawn.
   */
  applyOverlay(patch) {
    const overlay = resolveConfig(patch ?? {}, {}, resolve)
    for (const [key, value] of Object.entries(overlay)) {
      this.config[key] = value
    }
    // 配置变了：下次探测/调用按新配置重连（旧客户端保留到失败为止）
    this.unloadProbe = { at: 0, available: false, reason: 'config-changed' }
    return { ...this.config }
  }

  /** Resolve a usable host entry: explicit config, env, then conventional workspace paths. */
  resolveHostEntry(env = {}) {
    if (typeof this.config.hostEntry === 'string' && this.config.hostEntry.trim().length > 0) {
      return { entry: this.config.hostEntry.trim(), source: 'config' }
    }
    const fromEnv = env.DSH_COMFYMCP_HOST_ENTRY
    if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
      return { entry: fromEnv.trim(), source: 'env' }
    }
    return { entry: '', source: 'unset', candidates: candidateHostEntries('') }
  }

  clientOrNull() {
    if (this.client === null) {
      this.client = this.clientFactory(this.config)
    }
    return this.client
  }

  /** Connected once per client lifetime; subsequent calls reuse the child. */
  async ensureReady() {
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
      const entry = this.resolveHostEntry()
      if (entry.entry === '') {
        result.error =
          'MCP 宿主入口未配置：设置 hostEntry 指向 projects/dsh-comfymcp/mcp/bin/fux-comfymcp-host.mjs（或环境变量 DSH_COMFYMCP_HOST_ENTRY）'
        return result
      }
      const client = await this.ensureReady()
      result.host = { ...client.status(), entry: entry.entry, entrySource: entry.source }
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
      const nodes = Array.isArray(data.nodes) ? data.nodes : []
      const hit = nodes.some((node) => String(node?.class_type ?? '') === 'UnloadAllModels')
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
    this.runOrder.push(id)
    while (this.runOrder.length > MAX_RUNS) {
      const drop = this.runOrder.shift()
      if (drop !== undefined) this.runs.delete(drop)
    }
    return record
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

/**
 * 工作台方法集：控制端点 /ui 静态页与 /api 页面 API 的宿主半区实现。
 *
 * 与模型工具共享同一条运行核心（runcore.createRunExecutor），因此页面上的
 * 「执行 / 抽卡」与聊天里的 comfymcp_run_workflow 行为完全一致：
 * 保存 → （可选卸载节点）→ 运行 → 等待 → 下载 → 产物分发（对象存储 + 镜像目录）。
 *
 * 节点解析适配（实证形状见 lib/nodecat.js 顶部注释）：
 * - 宿主转发包装 {ok,isError,tool,data,...} → 先解 .data 再取 nodes；
 * - 官方 COMBO+options / 旧约定数组枚举 / object_info 裸形状 → nodecat 统一；
 * - 工作流来源：本地主目录 JSON 优先，缺省回落远端模板库（get_workflow，
 *   服务端已把 UI 格式转换为 API 图）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildPageDescriptor, renderIndexHtml, renderPageHtml, renderArtifactsHtml } from './wfpage.js'
import { createTagStore } from './tags.js'
import { parseQuickCommands, buildQuickRerun } from './quick.js'
import { createRunExecutor } from './runcore.js'
import { createRunDaemon } from './rund.js'
import { normalizeNodeCatalog } from './nodecat.js'
import { safeFileStem } from './bridge.js'
import { apiGraphFromUi, hasSubgraphs, isUiWorkflow } from './wfgraph.js'
const REMOTE_TTL_MS = 5 * 60 * 1000

function isPlainStem(name) {
  const stem = String(name ?? '').trim()
  return stem.length > 0 && !/[\\/]/.test(stem) && !stem.includes('..')
}

/** 目录列表归一：数组或分隔字符串（兼容未经 config.js 归一化的调用方）。 */
function dirList(value) {
  if (Array.isArray(value)) return value.filter((dir) => typeof dir === 'string' && dir.trim().length > 0)
  if (typeof value === 'string') return value.split(/[,;\r\n]+/).map((dir) => dir.trim()).filter((dir) => dir.length > 0)
  return []
}

/** 扫描目录：插件自有 workflows 目录优先，其次用户配置目录（拉取只写自有目录）。 */
function scanDirs(config) {
  const dirs = []
  const managed = typeof config.homeDir === 'string' && config.homeDir.length > 0 ? join(config.homeDir, 'workflows') : ''
  if (managed.length > 0) dirs.push(managed)
  for (const dir of dirList(config.workflowDirs)) {
    if (!dirs.includes(dir)) dirs.push(dir)
  }
  return dirs
}

function readLocalGraph(config, name) {
  if (!isPlainStem(name)) return null
  for (const dir of scanDirs(config)) {
    try {
      const file = join(dir, `${name}.json`)
      if (!existsSync(file)) continue
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      return parsed !== null && typeof parsed === 'object' ? parsed : null
    } catch {
      continue
    }
  }
  return null
}

/** 本地文件路径（首个命中），供服务端 id 匹配。 */
function localFilePath(config, name) {
  if (!isPlainStem(name)) return ''
  for (const dir of scanDirs(config)) {
    const file = join(dir, `${name}.json`)
    if (existsSync(file)) return file
  }
  return ''
}

function scanWorkflows(config) {
  const pages = []
  for (const dir of scanDirs(config)) {
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/\.json$/i.test(entry.name)) continue
      const name = entry.name.replace(/\.json$/i, '')
      let updatedAt = ''
      try {
        updatedAt = statSync(join(dir, entry.name)).mtime.toISOString()
      } catch {
        /* ignore */
      }
      if (!pages.some((page) => page.name === name)) pages.push({ name, title: name, source: 'local', updatedAt })
    }
  }
  return pages
}

/** 宿主包装解包：structuredContent = {ok,isError,tool,data,...} → 内层 data。 */
function unwrapHost(answer) {
  const structured = answer?.structuredContent
  if (structured !== null && typeof structured === 'object' && 'data' in structured) {
    return structured.data ?? {}
  }
  return structured ?? {}
}

/** 拉取远端模板库节点解析 + 工作流图（带 TTL 缓存）。 */
function createRemoteSource(bridge) {
  const cache = new Map()
  return {
    async nodeCatalog(classes) {
      const key = classes.join('|')
      const hit = cache.get(`cat:${key}`)
      if (hit !== undefined && Date.now() - hit.at < REMOTE_TTL_MS) return hit.value
      let catalog = {}
      try {
        const answer = await bridge.callRemote('node_info', { classTypes: classes }, 30000)
        catalog = normalizeNodeCatalog(unwrapHost(answer))
      } catch {
        catalog = {}
      }
      cache.set(`cat:${key}`, { at: Date.now(), value: catalog })
      return catalog
    },
    async workflow(name) {
      const hit = cache.get(`wf:${name}`)
      if (hit !== undefined && Date.now() - hit.at < REMOTE_TTL_MS) return hit.value
      let graph = null
      try {
        const answer = await bridge.callRemote('get_workflow', { id: name }, 60000)
        const data = unwrapHost(answer)
        graph = data?.graph !== null && typeof data?.graph === 'object' ? data.graph : null
      } catch {
        graph = null
      }
      cache.set(`wf:${name}`, { at: Date.now(), value: graph })
      return graph
    },
    async remoteList() {
      try {
        const answer = await bridge.callRemote('list_workflows', {}, 30000)
        const data = unwrapHost(answer)
        return Array.isArray(data.workflows) ? data.workflows : []
      } catch {
        return []
      }
    },
    /** 丢弃解析缓存（工作流图 + 节点目录），供「重新解析」。 */
    invalidate(name) {
      if (typeof name === 'string' && name.length > 0) cache.delete(`wf:${name}`)
      else {
        cache.clear()
      }
    },
  }
}

/** Tab 内按名称去重（大小写不敏感；先到先得，本地优先由调用序保证）。 */
function dedupeByName(pages) {
  const seen = new Set()
  const result = []
  for (const page of pages) {
    const key = String(page.title ?? page.name ?? '').trim().toLowerCase()
    if (key.length === 0 || seen.has(key)) continue
    seen.add(key)
    result.push(page)
  }
  return result
}

/** library 判定：source 标注或 id 前缀，两者都认。 */
function isLibraryEntry(workflow) {
  return workflow?.source === 'library' || String(workflow?.id ?? '').startsWith('library:')
}

/**
 * 把页面提交的 values（复合键 `nodeId:field`）应用回图。
 * 注意：展平后的子图节点 id 自身含冒号（如 `128:127`），故按**最后一个冒号**切分；
 * 自动增长组输入名也含点号（`values.a`），整段作为字段名保留。
 */
function applyValues(graph, values) {
  let applied = 0
  if (values === null || typeof values !== 'object') return applied
  for (const [key, value] of Object.entries(values)) {
    const separator = key.lastIndexOf(':')
    if (separator <= 0) continue
    const node = graph[key.slice(0, separator)]
    const field = key.slice(separator + 1)
    if (node === null || typeof node !== 'object' || node.inputs === null || typeof node.inputs !== 'object') continue
    if (!(field in node.inputs)) continue
    if (value === null && typeof node.inputs[field] === 'number') continue // 空数字不覆盖
    node.inputs[field] = value
    applied += 1
  }
  return applied
}

/**
 * @param deps { bridge, config }
 * @returns 控制端点方法：pageIndex/pageWorkflow/pageArtifacts/listWorkflows/getPage/runPage/quickRun/listArtifacts/updateTags
 */
export function createWorkbenchMethods({ bridge, config }) {
  const executeRun = createRunExecutor({ bridge })
  const daemon = createRunDaemon({ bridge, executeRun })
  const tagStore = createTagStore({ dataDir: config.dataDir })
  const remote = createRemoteSource(bridge)

  /**
   * 图来源与格式适配：
   * 1) 本地文件是 API 格式 → 直接用；
   * 2) 本地文件是 ComfyUI UI 格式 → 优先用服务端转换（同一目录服务端索引为 saved:*，
   *    转换含子图与前端隐藏控件，最可靠）；服务端不可用时本地兜底转换；
   * 3) 本地没有 → 远端 id（library:xxx）。
   */
  async function resolveGraph(name) {
    const local = readLocalGraph(config, name)
    if (local !== null) {
      if (!isUiWorkflow(local)) return { graph: local, origin: 'local', notes: [] }
      // 含内联子图的 UI 文件服务端无法转换（E_CUI_CONVERT），直接走本地展平
      if (hasSubgraphs(local) !== true) {
        const serverId = await savedIdFor(name)
        if (serverId !== null) {
          const converted = await remote.workflow(serverId)
          if (converted !== null) {
            return { graph: converted, origin: 'converted-remote', notes: [`本地文件为 ComfyUI UI 格式，已由服务端转换为可执行图（${serverId}）`] }
          }
        }
      }
      const fallback = apiGraphFromUi(local)
      if (fallback.graph !== null && Object.keys(fallback.graph).length > 0) {
        const notes = [`本地文件为 ComfyUI UI 格式，已本地转换为可执行图${fallback.subgraphs > 0 ? `（展开 ${fallback.subgraphs} 个子图）` : ''}`]
        if (fallback.skipped.length > 0) notes.push(`已跳过 ${fallback.skipped.length} 个非执行节点（笔记/旁路）`)
        if (fallback.incomplete.length > 0) notes.push(`⚠ ${fallback.incomplete.length} 个节点的控件值未能命名（旧格式），可能沿用默认值`)
        if (fallback.unsupported.length > 0) notes.push(`⚠ 含 ${fallback.unsupported.length} 个未能展开的子图节点；请确认服务端可用后点「重新解析」`)
        return { graph: fallback.graph, origin: 'converted-local', notes }
      }
      return {
        graph: {},
        origin: 'ui-unconverted',
        notes: [
          fallback.unsupported.length > 0
            ? `该工作流使用子图（${fallback.unsupported.length} 个），必须由服务端转换：请确认 comfy-mcp 服务端可用后点「重新解析」`
            : '无法解析该工作流文件，请确认它是 ComfyUI 工作流（UI 或 API 格式）',
        ],
      }
    }
    const remoteGraph = await remote.workflow(name)
    if (remoteGraph !== null) return { graph: remoteGraph, origin: 'remote', notes: [] }
    return null
  }

  /** 为本地文件匹配服务端 id：优先路径一致，其次同名，最后 saved:<stem>.json。 */
  async function savedIdFor(name) {
    const file = localFilePath(config, name)
    const list = await remote.remoteList()
    const byPath = list.find((workflow) => file.length > 0 && String(workflow?.path ?? '').toLowerCase() === file.toLowerCase())
    if (byPath !== undefined) return String(byPath.id)
    const byName = list.find((workflow) => String(workflow?.name ?? '').toLowerCase() === name.toLowerCase())
    if (byName !== undefined) return String(byName.id)
    const guess = `saved:${name}.json`
    return list.some((workflow) => String(workflow?.id ?? '') === guess) ? guess : null
  }

  async function descriptorFor(name) {
    const resolved = await resolveGraph(name)
    if (resolved === null) return null
    const classes = [...new Set(Object.values(resolved.graph).map((node) => node?.class_type).filter((cls) => typeof cls === 'string' && cls.length > 0))]
    const catalog = classes.length > 0 ? await remote.nodeCatalog(classes) : {}
    return buildPageDescriptor({ name, title: name, graph: resolved.graph, nodeInfos: catalog, notes: resolved.notes })
  }

  /** Tab 分组：我的工作流 = 本地主目录 + 远端非模板库条目（参与过 DSH 交互的）；模板库 = 远端 library。组内按名称去重。 */
  function tabGroups(remoteWorkflows) {
    const locals = scanWorkflows(config)
    const remoteMine = remoteWorkflows
      .filter((workflow) => !isLibraryEntry(workflow))
      .map((workflow) => ({
        name: String(workflow?.id ?? ''),
        title: String(workflow?.name ?? workflow?.id ?? ''),
        origin: 'remote',
        updatedAt: String(workflow?.modifiedAt ?? ''),
      }))
      .filter((page) => page.name.length > 0)
    const library = remoteWorkflows
      .filter((workflow) => isLibraryEntry(workflow))
      .map((workflow) => ({
        name: String(workflow?.id ?? ''),
        title: String(workflow?.name ?? workflow?.id ?? ''),
        origin: 'remote',
        updatedAt: String(workflow?.modifiedAt ?? ''),
      }))
      .filter((page) => page.name.length > 0)
    return {
      mine: dedupeByName([...locals.map((page) => ({ ...page, origin: 'local' })), ...remoteMine]),
      library: dedupeByName(library),
    }
  }

  return {
    async pageIndex({ token = '' } = {}) {
      const groups = tabGroups(await remote.remoteList())
      return { html: renderIndexHtml({ mine: groups.mine, library: groups.library, token }) }
    },

    async pageWorkflow(name, { token = '' } = {}) {
      const descriptor = await descriptorFor(name)
      if (descriptor === null) return { error: `工作流 ${name} 不存在（本地与远端模板库都没有）` }
      return { html: renderPageHtml(descriptor, { token, quickCommands: parseQuickCommands(config.quickCommands) }) }
    },

    async pageArtifacts({ token = '' } = {}) {
      return { html: renderArtifactsHtml({ runs: bridge.listRuns(30), tags: tagStore.all(), token }) }
    },

    async listWorkflows() {
      return tabGroups(await remote.remoteList())
    },

    /**
     * 手动从服务端拉取工作流，落到插件自有目录 <homeDir>/workflows（绝不写用户
     * ComfyUI 目录，避免覆盖其 UI 格式原文件）；保存的是可执行 API 图。
     */
    async pullWorkflow({ id } = {}) {
      const workflowId = String(id ?? '').trim()
      if (workflowId.length === 0) return { ok: false, reason: '缺少工作流 id' }
      const graph = await remote.workflow(workflowId)
      if (graph === null) {
        return { ok: false, reason: `服务端无法提供 ${workflowId}（未索引或含内联子图）；若该工作流就在本地目录，直接打开即可，无需拉取` }
      }
      if (typeof config.homeDir !== 'string' || config.homeDir.length === 0) return { ok: false, reason: '未配置插件主目录（homeDir）' }
      const targetDir = join(config.homeDir, 'workflows')
      const baseName = String((await remote.remoteList()).find((workflow) => String(workflow?.id ?? '') === workflowId)?.name ?? workflowId.replace(/^(library|saved):/, ''))
      const stem = safeFileStem(baseName.replace(/\.json$/i, '')) || `workflow-${Date.now()}`
      const file = join(targetDir, `${stem}.json`)
      try {
        mkdirSync(targetDir, { recursive: true })
        writeFileSync(file, JSON.stringify(graph, null, 2), 'utf8')
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
      remote.invalidate(workflowId)
      return { ok: true, name: stem, file }
    },

    /** 重新解析：丢弃缓存后重建描述符（返回统计，页面随后刷新）。 */
    async refreshWorkflow({ workflow } = {}) {
      const name = String(workflow ?? '').trim()
      if (name.length === 0) return { ok: false, reason: '缺少工作流名' }
      remote.invalidate(name)
      const descriptor = await descriptorFor(name)
      if (descriptor === null) return { ok: false, reason: `工作流 ${name} 不存在` }
      const fields = descriptor.sections.reduce((sum, section) => sum + section.fields.length, 0)
      return { ok: true, nodeCount: descriptor.nodeCount, sections: descriptor.sections.length, fields }
    },

    async getPage(name) {
      return descriptorFor(name)
    },

    /** 页面「执行」：values（复合键）应用回图后异步启动（立即返回，由守护轮询进度）。 */
    async runPage({ workflow, values, name, timeoutMs } = {}) {
      const resolved = await resolveGraph(workflow)
      if (resolved === null) return { ok: false, error: `工作流 ${workflow} 不存在` }
      applyValues(resolved.graph, values)
      const runName = typeof name === 'string' && name.trim().length > 0 ? name : isPlainStem(workflow) ? workflow : 'workflow'
      return daemon.start({
        workflow: runName,
        name: runName,
        graph: resolved.graph,
        values,
        subdir: config.saveSubdir,
        ...(typeof timeoutMs === 'number' && timeoutMs > 0 ? { timeoutMs } : {}),
      })
    },

    /** 页面状态：运行中状态或最近一次结果（刷新后恢复展示）。 */
    async runStatus({ workflow } = {}) {
      return daemon.status(workflow)
    },

    /** 手动中断当前运行（取消远端队列任务并标记中断）。 */
    async cancelRun({ workflow } = {}) {
      return daemon.cancel(workflow)
    },

    /** 最近运行历史（供页面展示成果物列表）。 */
    async runHistory({ workflow, limit } = {}) {
      return { ok: true, value: daemon.history(workflow, typeof limit === 'number' && limit > 0 ? limit : 5) }
    },

    /** 清空展示区域（产物文件保留）。 */
    async clearRuns({ workflow } = {}) {
      return daemon.clear(workflow)
    },

    /** 快捷指令（如抽卡）：复用上次成功运行的参数，仅重滚种子；同样异步执行。 */
    async quickRun({ workflow, command } = {}) {
      const commands = parseQuickCommands(config.quickCommands)
      const entry = commands.find((item) => item.name === command) ?? commands[0]
      if (entry === undefined) return { ok: false, reason: '没有可用的快捷指令' }
      const lastRun = bridge
        .listRuns(50)
        .find((run) => run.state === 'completed' && run.form?.graph !== undefined && (workflow === undefined || workflow === null || run.name === workflow || String(run.name).startsWith(String(workflow))))
      const rerun = buildQuickRerun(lastRun ?? null, entry)
      if (rerun.ok !== true) return { ok: false, reason: rerun.reason }
      return daemon.start({ workflow: rerun.name, name: rerun.name, graph: rerun.graph, values: rerun.values, subdir: config.saveSubdir })
    },

    async listArtifacts() {
      return { runs: bridge.listRuns(30), tags: tagStore.all() }
    },

    async updateTags({ key, patch } = {}) {
      return tagStore.update(key, patch ?? {})
    },
  }
}

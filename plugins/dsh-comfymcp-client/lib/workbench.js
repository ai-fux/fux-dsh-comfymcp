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
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildPageDescriptor, renderIndexHtml, renderLibraryHtml, renderPageHtml, renderArtifactsHtml, renderCommandsHtml, renderBusinessHtml, artifactsRunsHtml } from './wfpage.js'
import { renderCreateHtml } from './createpage.js'
import * as providerApi from './providers/index.js'
import { createTagStore } from './tags.js'
import { createBusinessStore, BUSINESS_KINDS, businessLabel, extractBusinessParamFields, inferBusiness, matchBusiness, businessRanking, workflowOutcomeStats } from './business.js'
import { parseQuickCommands, buildQuickRerun, applyBatchSize } from './quick.js'
import { createRunExecutor } from './runcore.js'
import { createRunDaemon, summarizeRun } from './rund.js'
import { normalizeNodeCatalog } from './nodecat.js'
import { matchRun, matchRunQuery, parseQuery } from './artifactsearch.js'
import { safeFileStem } from './bridge.js'
import { apiGraphFromUi, hasSubgraphs, isUiWorkflow } from './wfgraph.js'
const REMOTE_TTL_MS = 5 * 60 * 1000

/**
 * 「一键登记」候选：把已经跑过、但当前业务类还没登记（或主配置是别的工作流）的运行列出来，
 * 供工作台手动登记——这就是「加载过的数据自动配置」的手动兜底入口。
 */
export function businessCandidates(runs = [], profiles = [], kinds = null) {
  const grouped = new Map()
  for (const run of runs) {
    const graph = run?.form?.graph
    if (graph === undefined || graph === null) continue
    const business = inferBusiness(graph)
    if (business === 'other') continue
    const workflow = String(run.name ?? '').trim()
    if (workflow.length === 0) continue
    const profile = profiles.find((entry) => entry.business === business) ?? null
    if (profile !== null && profile.workflow === workflow) continue
    const key = `${business}:${workflow}`
    const found = grouped.get(key)
    if (found === undefined) {
      grouped.set(key, {
        business,
        label: businessLabel(business, kinds ?? undefined),
        workflow,
        runs: 1,
        lastAt: run.startedAt ?? null,
        current: profile === null ? null : profile.workflow,
      })
    } else {
      found.runs += 1
      if ((run.startedAt ?? 0) > (found.lastAt ?? 0)) found.lastAt = run.startedAt
    }
  }
  return [...grouped.values()].sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0)).slice(0, 12)
}

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
/**
 * 连续抽卡的后台链：等上一次跑完（status 不再是 running）再补跑下一次。
 * 火后不理（页面可关闭）；总等待上限取单次运行预算 + 60s，防止链卡死。
 */
async function chainSerialReruns({ daemon, lastRun, entry, count, name, subdir, runTimeoutMin = 30, log, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const perRunWaitMs = (Number(runTimeoutMin) > 0 ? Number(runTimeoutMin) : 30) * 60 * 1000 + 60 * 1000
  for (let i = 1; i < count; i++) {
    let waited = 0
    while (waited < perRunWaitMs) {
      const status = daemon.status(name)
      if (status?.ok !== true || status.value === null || status.value.state !== 'running') break
      await sleep(1500)
      waited += 1500
    }
    const next = buildQuickRerun(lastRun, entry)
    if (next.ok !== true) {
      log(`连续抽卡第 ${i + 1}/${count} 次中止：${next.reason}`)
      return
    }
    const start = daemon.start({ workflow: next.name, name: next.name, graph: next.graph, values: next.values, subdir })
    if (start.ok !== true) {
      log(`连续抽卡第 ${i + 1}/${count} 次启动失败：${start.reason ?? ''}`)
      return
    }
    log(`连续抽卡 ${i + 1}/${count} 已启动（seed=${next.seed}）`)
  }
}

export function createWorkbenchMethods({ bridge, config, persistWrite = null, business = null, providersStore = null, creationService = null }) {
  const executeRun = createRunExecutor({ bridge })
  const daemon = createRunDaemon({ bridge, executeRun })
  const tagStore = createTagStore({ dataDir: config.dataDir })
  const businessStore = business ?? createBusinessStore({ dataDir: config.dataDir })
  const remote = createRemoteSource(bridge)

  /**
   * 可选工作流候选（业务配置页用）：合并多来源，避免「没有数据」——
   * ① 本地工作流文件 ② 服务端（我的工作流 / 模板库）③ 跑过的（只保留**能真正打开**的名字，
   * 否则选了读参数时会报「工作流不存在」）④ 已在业务配置里引用过的。
   * 返回 { list, hiddenRuns }：hiddenRuns＝只有运行记录、没有对应文件/模板而被隐藏的数量（页面提示用）。
   */
  const knownWorkflows = async () => {
    const resolvable = new Map()
    const addResolvable = (name, origin) => {
      const value = String(name ?? '').trim()
      if (value.length === 0 || resolvable.has(value)) return
      resolvable.set(value, origin)
    }
    for (const dir of config.workflowDirs ?? []) {
      try {
        for (const file of readdirSync(dir)) {
          if (/\.json$/i.test(file)) addResolvable(file.replace(/\.json$/i, ''), '本地文件')
        }
      } catch {
        // 目录不存在/不可读：跳过
      }
    }
    try {
      const groups = tabGroups(await remote.remoteList())
      for (const page of groups.mine) addResolvable(page?.name, '我的工作流')
      for (const page of groups.library) addResolvable(page?.name, '模板库')
    } catch {
      // 服务端不可达：至少还有本地文件
    }
    const list = [...resolvable.entries()].map(([name, origin]) => ({ name, origin }))
    let hiddenRuns = 0
    for (const run of bridge.listRuns(80)) {
      const name = String(run?.name ?? '').trim()
      if (name.length === 0) continue
      const hit = list.find((entry) => entry.name === name)
      if (hit !== undefined) {
        hit.origin = '跑过的'
        hit.runs = (Number(hit.runs) || 0) + 1
      } else if (businessStore.all().some((profile) => profile.workflow === name)) {
        list.push({ name, origin: '已配置' })
      } else {
        hiddenRuns += 1
      }
    }
    const order = { 跑过的: 0, 我的工作流: 1, 本地文件: 2, 模板库: 3, 已配置: 4 }
    return {
      list: list
        .sort((a, b) => (order[a.origin] ?? 9) - (order[b.origin] ?? 9) || a.name.localeCompare(b.name))
        .slice(0, 400),
      hiddenRuns,
    }
  }

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

  /** 该工作流上一次成功运行的参数（复合键 values），用于「已存在则沿用上次参数」。 */
  function lastValuesFor(name) {
    const record = bridge
      .listRuns(80)
      .find((run) => run.state === 'completed' && run.form?.values !== null && run.form?.values !== undefined && (run.name === name || String(run.name).startsWith(`${name}-`)))
    if (record === undefined) return null
    const values = record.form.values
    return values !== null && typeof values === 'object' && Object.keys(values).length > 0 ? values : null
  }

  async function descriptorFor(name) {
    const resolved = await resolveGraph(name)
    if (resolved === null) return null
    const classes = [...new Set(Object.values(resolved.graph).map((node) => node?.class_type).filter((cls) => typeof cls === 'string' && cls.length > 0))]
    const catalog = classes.length > 0 ? await remote.nodeCatalog(classes) : {}
    // 已有历史运行 → 表单优先带出上一次的参数（含种子/提示词等）
    const prefill = lastValuesFor(name)
    const notes = [...resolved.notes]
    if (prefill !== null) notes.push(`已带出上一次运行的参数（${Object.keys(prefill).length} 项）；如需回到工作流文件原值，点上方「↻ 重新解析」。`)
    return buildPageDescriptor({ name, title: name, graph: resolved.graph, nodeInfos: catalog, notes, prefill: prefill ?? {} })
  }

  /** 模板首次执行时落库到「我的工作流」（插件自有目录，API 图）。 */
  function persistLocalGraph(name, graph) {
    if (typeof config.homeDir !== 'string' || config.homeDir.length === 0) return null
    const stem = safeFileStem(String(name).replace(/^(library|saved):/, '').replace(/\.json$/i, ''))
    if (stem.length === 0) return null
    const dir = join(config.homeDir, 'workflows')
    const file = join(dir, `${stem}.json`)
    try {
      mkdirSync(dir, { recursive: true })
      if (!existsSync(file)) writeFileSync(file, JSON.stringify(graph, null, 2), 'utf8')
      return file
    } catch {
      return null
    }
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

    /** 模板页（三 Tab 之一）：只列远端模板库条目。 */
    async pageLibrary({ token = '' } = {}) {
      const groups = tabGroups(await remote.remoteList())
      return { html: renderLibraryHtml({ library: groups.library, mine: groups.mine, token }) }
    },

    /** 快捷指令页（第 4 个 Tab）：结构化管理指令 + 就地执行。 */
    async pageCommands({ token = '' } = {}) {
      const commands = parseQuickCommands(config.quickCommands)
      const lastRun = bridge
        .listRuns(50)
        .find((run) => run.state === 'completed' && run.form?.graph !== undefined) ?? null
      return {
        html: renderCommandsHtml({
          token,
          commands,
          lastRun: lastRun === null ? null : { name: lastRun.name, seed: lastRun.seed ?? null },
        }),
      }
    },

    async pageWorkflow(name, { token = '' } = {}) {
      const descriptor = await descriptorFor(name)
      if (descriptor === null) return { error: `工作流 ${name} 不存在（本地与远端模板库都没有）` }
      // 业务参数预设：该工作流是某条业务配置的首选（或候选）时，页面顶部给出预设一键套用条
      const stem = safeFileStem(String(name).replace(/^(library|saved):/, '').replace(/\.json$/i, ''))
      const profile = businessStore.all().find((entry) => entry.workflow === name || (stem.length > 0 && entry.workflow === stem)) ?? null
      return {
        html: renderPageHtml(descriptor, {
          token,
          quickCommands: parseQuickCommands(config.quickCommands),
          businessLabel: profile === null ? '' : String(profile.label ?? profile.business ?? ''),
          presets: profile === null ? [] : (Array.isArray(profile.presets) ? profile.presets : []),
        }),
      }
    },

    async pageArtifacts({ token = '' } = {}) {
      // 无模态数据不入库由渲染层过滤（并统计忽略条数）；这里给出全部近期记录
      return { html: renderArtifactsHtml({ runs: bridge.listRuns(60), tags: tagStore.all(), token }) }
    },

    /**
     * 业务配置页（第 5 个 Tab）：把「跑过/加载过」的工作流按业务类沉淀下来，
     * 后续会话用自然语言直接命中，不再每次去服务端捞模板、枚举模型。
     */
    async pageBusiness({ token = '' } = {}) {
      const profiles = businessStore.all()
      const kinds = businessStore.kinds()
      const workflows = await knownWorkflows()
      // 各工作流的运行战绩（成功/失败次数）：候选条按它展示，并支撑「设为主配置」的判断
      const stats = {}
      for (const [name, entry] of workflowOutcomeStats(bridge.listRuns(200))) stats[name] = entry
      return {
        html: renderBusinessHtml({
          token,
          profiles,
          kinds,
          workflows: workflows.list,
          hiddenRuns: workflows.hiddenRuns,
          runStats: stats,
        }),
      }
    },

    /** 业务配置读写（工具层与工作台共用同一份存储）。 */
    async listBusiness() {
      const profiles = businessStore.all()
      const kinds = businessStore.kinds()
      return { profiles, kinds, candidates: businessCandidates(bridge.listRuns(80), profiles, kinds) }
    },

    /** 业务类动态增删：新增/改名/改触发词，或删除没被引用的类。 */
    async saveBusinessKind({ kind } = {}) {
      const outcome = businessStore.saveKind(kind ?? {})
      return { ...outcome, profiles: businessStore.all(), kinds: businessStore.kinds() }
    },

    /**
     * 读取某个工作流**实际存在**的可调参数（供业务配置页按所选工作流动态渲染参数区）：
     * 本地 API 图直接读；远端模板走 get_workflow；读不到就给明确原因，不猜参数。
     */
    async businessSchema({ workflow } = {}) {
      const name = String(workflow ?? '').trim()
      if (name.length === 0) return { ok: false, error: '缺少工作流名' }
      const resolved = await resolveGraph(name)
      if (resolved === null) return { ok: false, error: `工作流 ${name} 不存在（本地与远端模板库都没有）` }
      return {
        ok: true,
        workflow: name,
        origin: resolved.origin,
        fields: extractBusinessParamFields(resolved.graph),
      }
    },

    async removeBusinessKind({ id } = {}) {
      const outcome = businessStore.removeKind(id)
      return { ...outcome, profiles: businessStore.all(), kinds: businessStore.kinds() }
    },

    async saveBusiness({ profile, profiles } = {}) {
      const list = Array.isArray(profiles) ? profiles : (profile === undefined || profile === null ? [] : [profile])
      if (list.length === 0) return { ok: false, error: '缺少业务配置内容' }
      const saved = []
      for (const entry of list) {
        if (entry === null || typeof entry !== 'object') continue
        saved.push(businessStore.save(entry))
      }
      if (saved.length === 0) return { ok: false, error: '没有可保存的业务配置' }
      return { ok: true, saved, profiles: businessStore.all() }
    },

    async removeBusiness({ id } = {}) {
      const removed = businessStore.remove(id)
      return { ok: removed, profiles: businessStore.all() }
    },

    /** 设为主配置：把候选工作流提升为首选（原首选退回候选）；带出该配置的运行战绩排序供参考。 */
    async promoteBusiness({ id, workflow } = {}) {
      const outcome = businessStore.promote(id, workflow)
      const profile = businessStore.all().find((entry) => entry.id === String(id ?? '')) ?? null
      const ranking = profile === null ? null : businessRanking(profile, bridge.listRuns(200))
      return {
        ...(outcome.ok === false ? outcome : { ok: true, swapped: outcome.swapped === true, from: outcome.from ?? null }),
        profile,
        ranking,
        profiles: businessStore.all(),
      }
    },

    /** 参数预设：保存（同名覆盖）/ 删除，供业务配置页与模型侧共用。 */
    async saveBusinessPreset({ id, preset } = {}) {
      const outcome = businessStore.savePreset({ id, preset })
      return { ...outcome, profiles: businessStore.all() }
    },

    async removeBusinessPreset({ id, presetId } = {}) {
      const outcome = businessStore.removePreset({ id, presetId })
      return { ...outcome, profiles: businessStore.all() }
    },

    /** 登记候选：把某个已跑过的工作流手动登记到指定业务类。 */
    async registerBusiness({ workflow, business, label, keywords, notes, params } = {}) {
      const name = String(workflow ?? '').trim()
      if (name.length === 0) return { ok: false, error: '缺少工作流名' }
      const kind = String(business ?? '').trim() || inferBusiness(config.businessGraphs?.[name])
      const saved = businessStore.save({
        id: kind,
        business: kind,
        label,
        workflow: name,
        source: 'saved',
        keywords,
        notes,
        params,
        auto: false,
      })
      return { ok: true, profile: saved, profiles: businessStore.all() }
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
      // 名统一为「文件词干」：模板 id（library:x.json）跑完后与「我的工作流」条目同名，
      // 这样下次打开才能匹配到上次运行的参数。
      const stem = safeFileStem(String(workflow).replace(/^(library|saved):/, '').replace(/\.json$/i, '')) || 'workflow'
      const runName = typeof name === 'string' && name.trim().length > 0 ? name : stem
      // 模板（远端）跑过即落库到「我的工作流」，之后从本地文件解析（已存在则沿用上次参数）
      if (resolved.origin === 'remote') persistLocalGraph(runName, resolved.graph)
      // 业务配置自动登记：这次跑的工作流按推断出的业务类沉淀下来，后续会话自然语言即可直接命中；
      // 带上近期运行记录，auto=true 的配置按「成功率/得分」自动换主（候选明显更好才提升）
      try {
        businessStore.autoRegister({
          workflow: runName,
          graph: resolved.graph,
          source: resolved.origin === 'remote' ? 'library' : 'saved',
          runs: bridge.listRuns(200),
        })
      } catch (error) {
        console.error(`[dsh-comfymcp-client] 业务配置自动登记失败: ${String(error)}`)
      }
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

    /** 成果物页「⇢ 赋值」：暂存提示词，工作流页加载时回填。 */
    async assignPrompt({ workflow, field, value, kind } = {}) {
      return daemon.setPendingPrompt(workflow, { field, value, kind })
    },

    /** 工作流页取回待赋值（一次性消费）。 */
    async takePrompt({ workflow } = {}) {
      return daemon.takePendingPrompt(workflow)
    },

    /**
     * 导出成果物 JSON：当前已有字段 + 文件字节（base64 内嵌）。
     * ids 传运行 id（逗号分隔）时只导出选中项。
     */
    async exportArtifacts({ ids, limit } = {}) {
      const wanted = typeof ids === 'string' && ids.trim().length > 0 ? new Set(ids.split(',').map((id) => id.trim()).filter(Boolean)) : null
      const all = bridge.listRuns(200).filter((run) => Array.isArray(run.localFiles) && run.localFiles.length > 0)
      const selected = (wanted === null ? all : all.filter((run) => wanted.has(String(run.id)))).slice(0, Math.max(1, Number(limit) || 50))
      const payload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        fields: ['id', 'name', 'state', 'seed', 'prompts', 'startedAt', 'finishedAt', 'durationMs', 'promptId', 'error', 'tags', 'collections', 'fields'],
        runs: selected.map((run) => ({
          id: run.id,
          name: run.name,
          state: run.state,
          seed: run.seed ?? null,
          prompts: run.prompts ?? { positive: run.prompt ?? '', negative: '' },
          startedAt: run.startedAt ?? null,
          finishedAt: run.finishedAt ?? null,
          durationMs: run.durationMs ?? (run.finishedAt && run.startedAt ? run.finishedAt - run.startedAt : null),
          promptId: run.promptId ?? null,
          error: run.error ?? '',
          saved: run.form?.saved ?? null,
          files: (run.localFiles ?? []).map((file) => {
            const key = file.key ?? file.path ?? file.filename
            const meta = tagStore.get(key) ?? {}
            const outcome = typeof file.path === 'string' ? bridge.readArtifactBytes(new URLSearchParams({ path: file.path })) : { error: 'no path' }
            return {
              key,
              filename: file.filename ?? null,
              kind: file.kind ?? null,
              bytes: file.bytes ?? (outcome.bytes !== undefined ? outcome.bytes.byteLength : null),
              mime: file.mime ?? null,
              tags: Array.isArray(meta.tags) ? meta.tags : [],
              collections: Array.isArray(meta.collections) ? meta.collections : [],
              fields: meta.fields ?? {},
              prompt: meta.prompt ?? '',
              source: meta.source ?? '',
              ...(outcome.bytes !== undefined
                ? { encoding: 'base64', data: Buffer.from(outcome.bytes).toString('base64') }
                : { encoding: null, data: null, readError: outcome.error ?? 'unreadable' }),
            }
          }),
        })),
      }
      const filename = `comfymcp-artifacts-${new Date().toISOString().replaceAll(/[:.]/g, '-').slice(0, 19)}.json`
      return { filename, json: JSON.stringify(payload, null, 2), runs: payload.runs.length }
    },

    /** 最近运行历史（供页面展示成果物列表）。 */
    async runHistory({ workflow, limit } = {}) {
      return { ok: true, value: daemon.history(workflow, typeof limit === 'number' && limit > 0 ? limit : 5) }
    },

    /** 清空展示区域（产物文件保留）。 */
    async clearRuns({ workflow } = {}) {
      return daemon.clear(workflow)
    },

    /**
     * 快捷指令（如抽卡）：复用上次成功运行的参数，仅重滚种子；支持多生成数。
     * - batchMode='serial'（默认）：连续调 count 次，每次重滚种子；第 1 次立即启动，
     *   其余在上一次结束后由后台链式补跑（页面可关闭，链路在插件进程内继续）。
     * - batchMode='batch'：工作流批次生成 —— 直接把图里的 batch_size 改为 count，一次执行。
     * 生成数缺省 1（未提及默认 1 即单次）。
     */
    async quickRun({ workflow, command, count: countOverride } = {}) {
      const commands = parseQuickCommands(config.quickCommands)
      const entry = commands.find((item) => item.name === command) ?? commands[0]
      if (entry === undefined) return { ok: false, reason: '没有可用的快捷指令' }
      const requested = Number(countOverride ?? entry.count ?? 1)
      const count = Number.isFinite(requested) && requested >= 1 ? Math.min(64, Math.round(requested)) : 1
      const lastRun = bridge
        .listRuns(50)
        .find((run) => run.state === 'completed' && run.form?.graph !== undefined && (workflow === undefined || workflow === null || run.name === workflow || String(run.name).startsWith(String(workflow))))
      const rerun = buildQuickRerun(lastRun ?? null, entry)
      if (rerun.ok !== true) return { ok: false, reason: rerun.reason }
      if (entry.batchMode === 'batch' && count > 1) {
        const batched = applyBatchSize(rerun.graph, rerun.values, count)
        if (batched.ok !== true) {
          return { ok: false, reason: `批次生成不可用：${batched.reason}；可改用「连续」模式` }
        }
        const start = daemon.start({ workflow: rerun.name, name: rerun.name, graph: batched.graph, values: batched.values, subdir: config.saveSubdir })
        return start.ok === true
          ? { ok: true, mode: 'batch', count, runId: start.runId, detail: batched.reason }
          : start
      }
      const start = daemon.start({ workflow: rerun.name, name: rerun.name, graph: rerun.graph, values: rerun.values, subdir: config.saveSubdir })
      if (start.ok !== true) return start
      if (count > 1) {
        void chainSerialReruns({ daemon, lastRun, entry, count, name: rerun.name, subdir: config.saveSubdir, runTimeoutMin: config.runTimeoutMin, log: (line) => (typeof bridge.log === 'function' ? bridge.log(line) : console.log(`[dsh-comfymcp-client] ${line}`)) })
      }
      return { ok: true, mode: 'serial', count, runId: start.runId, planned: count }
    },

    /** 指令页保存：结构化指令列表 → quickCommands 配置（覆盖层持久化 + 即时生效）。 */
    async saveQuickCommands({ commands } = {}) {
      if (!Array.isArray(commands)) return { ok: false, reason: 'commands 需要是数组' }
      const clean = []
      for (const entry of commands) {
        if (entry === null || typeof entry !== 'object') continue
        const name = typeof entry.name === 'string' ? entry.name.trim() : ''
        if (name.length === 0) continue
        const mode = String(entry.batchMode ?? 'serial').toLowerCase() === 'batch' ? 'batch' : 'serial'
        const command = { name, count: Math.min(64, Math.max(1, Math.round(Number(entry.count) || 1))), batchMode: mode }
        if (typeof entry.label === 'string' && entry.label.trim().length > 0) command.label = entry.label.trim()
        if (entry.seed !== null && typeof entry.seed === 'object') {
          const seed = { mode: String(entry.seed.mode ?? 'range').toLowerCase() }
          for (const key of ['min', 'max', 'length', 'extraDigits']) {
            if (entry.seed[key] !== undefined && Number.isFinite(Number(entry.seed[key]))) seed[key] = Number(entry.seed[key])
          }
          command.seed = seed
        }
        clean.push(command)
      }
      if (clean.length === 0) return { ok: false, reason: '至少需要一条指令（保留名称非空的条目）' }
      const json = JSON.stringify(clean)
      if (typeof persistWrite === 'function') {
        const written = persistWrite({ quickCommands: json })
        if (written !== true) return { ok: false, reason: '覆盖层写入失败，指令未保存' }
      }
      config.quickCommands = json
      bridge.applyOverlay?.({ quickCommands: json })
      return { ok: true, commands: parseQuickCommands(config.quickCommands), saved: clean.length }
    },

    /**
     * 删除成果物（成果区「✕ 删除」与「移除该组」）：
     * - dropRun=true → 仅移除该次运行记录（磁盘文件保留）；
     * - 指定 path → 从记录移除该文件，deleteFile=true 时一并删盘。
     * 安全：只允许删除「确实登记在这条运行记录里」的路径，避免任意路径删除。
     */
    async removeArtifact({ runId, path: targetPath, deleteFile = false, dropRun = false } = {}) {
      const id = String(runId ?? '').trim()
      if (id.length === 0) return { ok: false, reason: '缺少运行标识' }
      const record = bridge.getRun(id)
      if (record === null || record === undefined) return { ok: false, reason: `找不到运行记录 ${id}` }
      if (dropRun === true) {
        bridge.removeRun?.(id)
        return { ok: true, dropped: id }
      }
      const path = String(targetPath ?? '')
      const files = Array.isArray(record.localFiles) ? record.localFiles : []
      const hit = files.find((file) => file?.path === path)
      if (hit === undefined) return { ok: false, reason: '该文件不属于这条运行记录（拒绝删除未登记的路径）' }
      const kept = files.filter((file) => file?.path !== path)
      bridge.updateRun?.(id, { localFiles: kept })
      let deleted = false
      if (deleteFile === true) {
        try {
          rmSync(path, { force: true })
          deleted = true
        } catch (error) {
          return { ok: false, reason: `已从记录移除，但删除文件失败：${error instanceof Error ? error.message : String(error)}` }
        }
      }
      return { ok: true, runId: id, removed: path, deleted, remaining: kept.length }
    },

    /**
     * 成果物检索：单输入框复合语法（字段限定 tag/param/field/prompt/file/name/state/seed/kind，
     * 空格＝与、`|`＝或、`-`＝排除，值比较 = != ~ > >= < <=），另兼容旧的分类条件参数。
     */
    async queryArtifacts({ query, text: fuzzy, tags: tagText, params: paramText, fields: fieldText, mode } = {}) {
      const records = bridge.listRuns(200)
      const tagRecords = tagStore.all()
      // 记录里的 params 由 summarize 从终图提取 —— 检索前先富化，否则参数条件永不命中
      const enriched = records.map((run) => summarizeRun(run))
      const withMedia = enriched.filter((run) => Array.isArray(run.files) && run.files.length > 0)
      const parsed = parseQuery(query)
      const usesLegacy = parsed.isEmpty && [fuzzy, tagText, paramText, fieldText].some((value) => typeof value === 'string' && value.trim().length > 0)
      const matched = withMedia
        .map((run) => {
          const outcome = usesLegacy
            ? matchRun(run, { text: fuzzy, tagText, paramText, fieldText, mode: mode === 'or' ? 'or' : 'and' }, tagRecords)
            : matchRunQuery(run, parsed, tagRecords)
          return { ...run, hits: outcome.hits, matched: outcome.matched }
        })
        .filter((run) => run.matched === true)
      const rendered = artifactsRunsHtml({ runs: matched, tags: tagRecords, token: '' })
      return {
        ok: true,
        html: rendered.html,
        summary: `${rendered.shown} 条命中 · 共 ${withMedia.length} 条有产物记录`,
        queryText: parsed.isEmpty ? '' : `检索「${parsed.raw}」`,
        runIds: matched.map((run) => run.id).filter(Boolean),
        // 多张收集卡要靠它开画廊逐张看：检索后前端要用同一份索引
        galleries: rendered.galleries ?? {},
        hits: matched.length,
        groups: parsed.groups.length,
      }
    },

    /** 批量删除成果物：逐条移除并按需删盘；该组清空后自动移除记录（无模态数据不入库）。 */
    async removeArtifactsBatch({ items, deleteFile = true } = {}) {
      const list = Array.isArray(items) ? items : []
      if (list.length === 0) return { ok: false, reason: '没有选中任何成果物' }
      let deleted = 0
      let failed = 0
      const errors = []
      for (const item of list) {
        const outcome = await this.removeArtifact({ runId: item?.runId, path: item?.path, deleteFile })
        if (outcome?.ok === true) deleted += 1
        else {
          failed += 1
          if (errors.length < 3) errors.push(outcome?.reason ?? 'unknown')
        }
        const record = bridge.getRun(String(item?.runId ?? ''))
        if (record !== null && record !== undefined && Array.isArray(record.localFiles) && record.localFiles.length === 0) {
          bridge.removeRun?.(record.id)
        }
      }
      return { ok: true, deleted, failed, errors }
    },

    async listArtifacts() {
      return { runs: bridge.listRuns(30), tags: tagStore.all() }
    },

    // ---- 创作（多模态服务商）----
    /** 创作页：服务商（掩码）+ 最近创作历史 + 预设模板。 */
    async pageCreate({ token } = {}) {
      if (providersStore === null || creationService === null) return { error: '创作服务未初始化' }
      const state = providersStore.list()
      return {
        html: renderCreateHtml({
          providers: state.providers,
          creations: creationService.history(20),
          defaultId: state.defaultId,
          token: token ?? '',
        }),
      }
    },
    async providersList() {
      return providersStore.list()
    },
    async providersUpsert(payload) {
      const outcome = providersStore.upsert(payload ?? {})
      if (outcome.ok !== true) return { ok: false, error: outcome.reason ?? '保存失败' }
      return { ok: true, value: providersStore.list() }
    },
    async providersRemove(payload) {
      const outcome = providersStore.remove(String(payload?.id ?? ''))
      if (outcome.ok !== true) return { ok: false, error: outcome.reason ?? '删除失败' }
      return { ok: true, value: providersStore.list() }
    },
    async providersSetDefault(payload) {
      const outcome = providersStore.setDefault(String(payload?.id ?? ''))
      if (outcome.ok !== true) return { ok: false, error: outcome.reason ?? '设置默认失败' }
      return { ok: true, value: providersStore.list() }
    },
    async providersTest(payload) {
      const provider = providersStore.find(String(payload?.id ?? ''))
      if (provider === null) return { ok: false, error: `服务商 ${payload?.id ?? ''} 不存在` }
      return providerApi.testProvider(provider, { store: providersStore })
    },
    async createStart(payload) {
      const outcome = creationService.start(payload ?? {})
      if (outcome.ok !== true) return { ok: false, error: outcome.reason ?? '无法启动创作' }
      return outcome
    },
    async createJob(payload) {
      return creationService.job(String(payload?.id ?? ''))
    },
    async createCancel(payload) {
      return creationService.cancel(String(payload?.id ?? ''))
    },
    async createHistory(payload) {
      return creationService.history(payload?.limit)
    },
    async createRemove(payload) {
      return creationService.remove(String(payload?.id ?? ''), { deleteFiles: payload?.deleteFiles === true })
    },

    async updateTags({ key, patch } = {}) {
      return tagStore.update(key, patch ?? {})
    },
  }
}

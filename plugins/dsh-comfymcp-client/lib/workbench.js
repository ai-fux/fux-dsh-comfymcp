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
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { buildPageDescriptor, renderIndexHtml, renderPageHtml, renderArtifactsHtml } from './wfpage.js'
import { createTagStore } from './tags.js'
import { parseQuickCommands, buildQuickRerun } from './quick.js'
import { createRunExecutor } from './runcore.js'
import { normalizeNodeCatalog } from './nodecat.js'

const REMOTE_TTL_MS = 5 * 60 * 1000

function isPlainStem(name) {
  const stem = String(name ?? '').trim()
  return stem.length > 0 && !/[\\/]/.test(stem) && !stem.includes('..')
}

function readLocalGraph(config, name) {
  if (!isPlainStem(name)) return null
  for (const dir of Array.isArray(config.workflowDirs) ? config.workflowDirs : []) {
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

function scanWorkflows(config) {
  const pages = []
  for (const dir of Array.isArray(config.workflowDirs) ? config.workflowDirs : []) {
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
  }
}

/** 把页面提交的 values（复合键 nodeId:field）应用回图。 */
function applyValues(graph, values) {
  let applied = 0
  if (values === null || typeof values !== 'object') return applied
  for (const [key, value] of Object.entries(values)) {
    const separator = key.indexOf(':')
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
  const tagStore = createTagStore({ dataDir: config.dataDir })
  const remote = createRemoteSource(bridge)

  /** 图来源：本地主目录优先，未命中回落远端模板库（UI 格式已由服务端转 API 图）。 */
  async function resolveGraph(name) {
    const local = readLocalGraph(config, name)
    if (local !== null) return { graph: local, origin: 'local' }
    const remoteGraph = await remote.workflow(name)
    if (remoteGraph !== null) return { graph: remoteGraph, origin: 'remote' }
    return null
  }

  async function descriptorFor(name) {
    const resolved = await resolveGraph(name)
    if (resolved === null) return null
    const classes = [...new Set(Object.values(resolved.graph).map((node) => node?.class_type).filter((cls) => typeof cls === 'string' && cls.length > 0))]
    const catalog = classes.length > 0 ? await remote.nodeCatalog(classes) : {}
    return buildPageDescriptor({ name, title: name, graph: resolved.graph, nodeInfos: catalog })
  }

  return {
    async pageIndex({ token = '' } = {}) {
      const locals = scanWorkflows(config)
      const remotes = []
      for (const workflow of await remote.remoteList()) {
        const name = String(workflow?.id ?? '')
        if (name.length === 0 || locals.some((page) => page.name === name)) continue
        remotes.push({
          name,
          title: String(workflow?.name ?? name),
          source: 'library',
          updatedAt: String(workflow?.modifiedAt ?? ''),
        })
      }
      return { html: renderIndexHtml({ pages: [...locals, ...remotes], token }) }
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
      const locals = scanWorkflows(config)
      const remotes = (await remote.remoteList())
        .map((workflow) => ({ name: String(workflow?.id ?? ''), title: String(workflow?.name ?? ''), source: 'library' }))
        .filter((workflow) => workflow.name.length > 0)
      return { workflows: [...locals, ...remotes] }
    },

    async getPage(name) {
      return descriptorFor(name)
    },

    /** 页面「执行」：values（复合键）应用回图后走共享运行核心。 */
    async runPage({ workflow, values, name } = {}) {
      const resolved = await resolveGraph(workflow)
      if (resolved === null) return { ok: false, error: `工作流 ${workflow} 不存在` }
      applyValues(resolved.graph, values)
      return executeRun({
        name: typeof name === 'string' && name.trim().length > 0 ? name : isPlainStem(workflow) ? workflow : 'workflow',
        graph: resolved.graph,
        values,
      })
    },

    /** 快捷指令（如抽卡）：复用上次成功运行的参数，仅重滚种子。 */
    async quickRun({ workflow, command } = {}) {
      const commands = parseQuickCommands(config.quickCommands)
      const entry = commands.find((item) => item.name === command) ?? commands[0]
      if (entry === undefined) return { ok: false, reason: '没有可用的快捷指令' }
      const lastRun = bridge
        .listRuns(50)
        .find((run) => run.state === 'completed' && run.form?.graph !== undefined && (workflow === undefined || workflow === null || run.name === workflow || String(run.name).startsWith(String(workflow))))
      const rerun = buildQuickRerun(lastRun ?? null, entry)
      if (rerun.ok !== true) return { ok: false, reason: rerun.reason }
      return executeRun({ name: rerun.name, graph: rerun.graph, values: rerun.values })
    },

    async listArtifacts() {
      return { runs: bridge.listRuns(30), tags: tagStore.all() }
    },

    async updateTags({ key, patch } = {}) {
      return tagStore.update(key, patch ?? {})
    },
  }
}

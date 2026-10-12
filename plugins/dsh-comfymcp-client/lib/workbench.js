/**
 * 工作台方法集：控制端点 /ui 静态页与 /api 页面 API 的宿主半区实现。
 *
 * 与模型工具共享同一条运行核心（runcore.createRunExecutor），因此页面上的
 * 「执行 / 抽卡」与聊天里的 comfymcp_run_workflow 行为完全一致：
 * 保存 → （可选卸载节点）→ 运行 → 等待 → 下载 → 产物分发（对象存储 + 镜像目录）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { buildPageDescriptor, renderIndexHtml, renderPageHtml, renderArtifactsHtml } from './wfpage.js'
import { createTagStore } from './tags.js'
import { parseQuickCommands, buildQuickRerun } from './quick.js'
import { createRunExecutor } from './runcore.js'

/** 安全读取工作流图：name 只允许文件名词干（拒绝路径穿越）。 */
function readWorkflowGraph(config, name) {
  const stem = String(name ?? '').trim()
  if (stem.length === 0 || /[\\/]/.test(stem) || stem.includes('..')) return null
  for (const dir of Array.isArray(config.workflowDirs) ? config.workflowDirs : []) {
    try {
      const file = join(dir, `${stem}.json`)
      if (!existsSync(file)) continue
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      return parsed !== null && typeof parsed === 'object' ? parsed : null
    } catch {
      continue
    }
  }
  return null
}

/** 扫描工作流目录里的 .json 文件（索引页/列表用）。 */
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
      if (!pages.some((page) => page.name === name)) pages.push({ name, title: name, updatedAt })
    }
  }
  return pages
}

/** 拉取图内全部节点类的 node_info（尽力而为；失败返回空 → 描述符退化为图内标量）。 */
async function nodeInfosFor(bridge, graph) {
  const classes = [...new Set(Object.values(graph ?? {}).map((node) => node?.class_type).filter((cls) => typeof cls === 'string' && cls.length > 0))]
  if (classes.length === 0) return {}
  try {
    const answer = await bridge.callRemote('node_info', { classTypes: classes }, 30000)
    const data = answer?.structuredContent ?? {}
    return data.nodes ?? data ?? {}
  } catch {
    return {}
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

  async function descriptorFor(name) {
    const graph = readWorkflowGraph(config, name)
    if (graph === null) return null
    const nodeInfos = await nodeInfosFor(bridge, graph)
    return buildPageDescriptor({ name, title: name, graph, nodeInfos })
  }

  return {
    async pageIndex({ token = '' } = {}) {
      return { html: renderIndexHtml({ pages: scanWorkflows(config), token }) }
    },

    async pageWorkflow(name, { token = '' } = {}) {
      const descriptor = await descriptorFor(name)
      if (descriptor === null) return { error: `工作流 ${name} 不存在或不是有效的 API 格式 JSON` }
      return { html: renderPageHtml(descriptor, { token, quickCommands: parseQuickCommands(config.quickCommands) }) }
    },

    async pageArtifacts({ token = '' } = {}) {
      return { html: renderArtifactsHtml({ runs: bridge.listRuns(30), tags: tagStore.all(), token }) }
    },

    async listWorkflows() {
      return { workflows: scanWorkflows(config) }
    },

    async getPage(name) {
      return descriptorFor(name)
    },

    /** 页面「执行」：values（复合键）应用回图后走共享运行核心。 */
    async runPage({ workflow, values, name } = {}) {
      const graph = readWorkflowGraph(config, workflow)
      if (graph === null) return { ok: false, error: `工作流 ${workflow} 不存在` }
      applyValues(graph, values)
      return executeRun({ name: typeof name === 'string' && name.trim().length > 0 ? name : workflow, graph, values })
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

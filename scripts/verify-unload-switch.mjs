/**
 * 活体验证卸载开关语义：
 *   关闭 → 图里不能有卸载节点（工作流自带的也要移除）；
 *   开启 → 恰好一个卸载节点（自带则沿用，不重复插入）。
 * 用法：node scripts/verify-unload-switch.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ComfymcpBridge } from '../plugins/dsh-comfymcp-client/lib/bridge.js'
import { createRunExecutor } from '../plugins/dsh-comfymcp-client/lib/runcore.js'
import { resolveConfig } from '../plugins/dsh-comfymcp-client/lib/config.js'
import { unloadNodeIds } from '../plugins/dsh-comfymcp-client/lib/forms.js'
import { apiGraphFromUi } from '../plugins/dsh-comfymcp-client/lib/wfgraph.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const overlay = JSON.parse(readFileSync(join(process.env.DSH_HOME ?? '', 'comfymcp', 'config-overlay.json'), 'utf8'))
const config = resolveConfig({ ...overlay, embeddedBackend: 'stdio', artifactsDir: join(root, 'tmp', 'verify-unload') })
const bridge = new ComfymcpBridge(config, { log: () => {} })

// 取一个真实工作流文件（本地 UI 格式或 API 图都支持）
const dirs = String(overlay.workflowDirs ?? '').split(';').filter(Boolean)
const target = process.argv[2] ?? 'image_z_image'
let graph = null
let sourceName = ''
for (const dir of dirs) {
  try {
    const file = readFileSync(join(dir, `${target}.json`), 'utf8')
    const parsed = JSON.parse(file)
    graph = parsed.nodes !== undefined ? apiGraphFromUi(parsed).graph : parsed
    sourceName = join(dir, `${target}.json`)
    break
  } catch {
    /* 继续找 */
  }
}
if (graph === null) {
  console.log(`[!] 找不到工作流文件：${target}`)
  process.exit(0)
}
console.log(`[0] 源工作流 → ${sourceName}`)
console.log(`[1] 源图自带卸载节点 → ${JSON.stringify(unloadNodeIds(graph))}（这就是「关掉也卸载」的根因）`)

// 直接观察执行器在两种配置下交给服务端的图
const seen = []
const stubClient = {
  async callTool(_tool, args) {
    if (args.tool === 'save_workflow') seen.push({ stage: 'save', graph: args.arguments.graph })
    if (args.tool === 'run_workflow') return { structuredContent: { ok: true, data: { promptId: 'stub-1' } } }
    if (args.tool === 'job_wait') return { structuredContent: { ok: true, data: { state: 'completed', outputs: {} } } }
    if (args.tool === 'fetch_outputs') return { structuredContent: { ok: true, data: { files: [], artifacts: [] } } }
    return { structuredContent: { ok: true, data: {} } }
  },
}
const stubBridge = {
  config,
  async ensureReady() { return stubClient },
  async probeUnload() { return { available: true, reason: 'stub' } },
  recordRun(record) { return { id: 'stub-run', ...record } },
  updateRun(_id, patch) { return { id: 'stub-run', ...patch } },
  getRun() { return null },
  artifactDirs: () => [join(root, 'tmp', 'verify-unload')],
  listRuns: () => [],
  log() {},
}
const execute = createRunExecutor({ bridge: stubBridge })

for (const autoUnload of [false, true]) {
  seen.length = 0
  const result = await execute({
    name: `unload-verify-${autoUnload}`,
    graph: JSON.parse(JSON.stringify(graph)),
    values: {},
    subdir: 'dsh-generated',
    autoUnload,
    timeoutMs: 20000,
  })
  await new Promise((resolve) => setTimeout(resolve, 400))
  const savedGraph = seen.find((entry) => entry.stage === 'save')?.graph ?? {}
  const ids = unloadNodeIds(savedGraph)
  console.log(`[2] autoUnload=${String(autoUnload).padEnd(5)} → 提交给服务端的卸载节点 ${JSON.stringify(ids)} · ${autoUnload === false ? (ids.length === 0 ? '✓ 已按配置移除' : '✗ 仍会卸载') : (ids.length === 1 ? '✓ 恰好一个' : `✗ 数量异常 ${ids.length}`)} · 说明「${result?.unload?.reason ?? result?.reason ?? ''}」`)
}
await bridge.close?.().catch?.(() => {})
process.exit(0)

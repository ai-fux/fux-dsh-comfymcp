/**
 * 端到端验证：① 模板执行一次即落库到「我的工作流」；② 再次打开沿用上次参数；
 * ③ 成果物多张时按重叠（扑克牌）样式渲染。
 * 用法：node scripts/verify-template-flow.mjs [模板 id，默认 library:demo 系]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ComfymcpBridge } from '../plugins/dsh-comfymcp-client/lib/bridge.js'
import { createWorkbenchMethods } from '../plugins/dsh-comfymcp-client/lib/workbench.js'
import { resolveConfig } from '../plugins/dsh-comfymcp-client/lib/config.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const overlay = JSON.parse(readFileSync(join(process.env.DSH_HOME ?? '', 'comfymcp', 'config-overlay.json'), 'utf8'))
const libraryId = process.argv[2] ?? 'library:image_z_image_turbo.json'
const home = join(root, 'tmp', 'template-flow-home')
const config = resolveConfig({
  ...overlay,
  embeddedBackend: 'stdio',
  homeDir: home,
  workflowDirs: [join(home, 'workflows')],
  artifactsDir: join(root, 'tmp', 'template-flow-artifacts'),
  dataDir: join(root, 'tmp', 'template-flow-data'),
  saveSubdir: 'dsh-generated',
})
const bridge = new ComfymcpBridge(config, { log: () => {} })
const workbench = createWorkbenchMethods({ bridge, config })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(name, timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const status = (await workbench.runStatus({ workflow: name }))?.value ?? null
    if (status !== null && status.state !== 'running') return status
    if (Date.now() > deadline) return status
    await sleep(1500)
  }
}

try {
  mkdirSync(join(home, 'workflows'), { recursive: true })
  console.log(`[1] 我的工作流（执行前）→ ${readdirSync(join(home, 'workflows')).join(', ') || '（空）'}`)
  const page = await workbench.pageWorkflow(libraryId, { token: 'demo' })
  if (page.error !== undefined) throw new Error(page.error)
  console.log(`[2] 模板页解析 → ${page.html.includes('data-field=') ? '含表单 ✓' : '无表单 ✗'} · 提示带出上次参数：${/已带出上一次运行的参数/.test(page.html) ? '是' : '否（首次）'}`)

  const seedField = (page.html.match(/data-field="([^"]*:seed)"/) ?? [])[1]
  const started = await workbench.runPage({ workflow: libraryId, values: seedField ? { [seedField]: 13579 } : {} })
  if (started.ok !== true) throw new Error(`启动失败：${started.reason ?? started.error}`)
  const status = await waitFor(started.workflow ?? libraryId)
  console.log(`[3] 执行结果 → state=${status.state} 种子=${status.seed} 产物=${(status.files ?? []).length} 件`)

  const files = readdirSync(join(home, 'workflows'))
  console.log(`[4] 我的工作流（执行后）→ ${files.join(', ') || '（空）'} ${files.length > 0 ? '✓ 已落库' : '✗ 未落库'}`)

  const reopened = await workbench.pageWorkflow(files[0].replace(/\.json$/, ''), { token: 'demo' })
  const remembered = /已带出上一次运行的参数/.test(reopened.html)
  const chips = (reopened.html.match(/>上次</g) ?? []).length
  console.log(`[5] 再次打开（本地条目）→ 带出上次参数：${remembered ? '是 ✓' : '否 ✗'} · 标记「上次」字段 ${chips} 个 · 种子值 ${(reopened.html.match(/data-field="[^"]*:seed"[^>]*value="([^"]*)"/) ?? [])[1] ?? '-'}`)

  // 重叠渲染：造 5 件产物的一组，检查页面用 fan 布局
  const many = [1, 2, 3, 4, 5].map((index) => ({ path: `F:\\out\\f${index}.png`, filename: `f${index}.png`, kind: 'image', bytes: 100 }))
  bridge.recordRun({ id: 'fan-run', name: 'fan-demo', state: 'completed', seed: 1, startedAt: Date.now() - 1000, finishedAt: Date.now(), localFiles: many, form: { graph: {} } })
  const artifacts = await workbench.pageArtifacts({ token: 'demo' })
  const fanBlocks = (artifacts.html.match(/class="fan"/g) ?? []).length
  const fanCards = (artifacts.html.match(/class="mediacard"/g) ?? []).length
  console.log(`[6] 成果物页重叠渲染 → fan 分组 ${fanBlocks} 个 · 媒体卡 ${fanCards} 张 · 样式含扇开 ${artifacts.html.includes('.fan .mediacard') ? '✓' : '✗'}`)
  writeFileSync(join(root, 'tmp', 'artifacts-fan-sample.html'), artifacts.html, 'utf8')
  console.log('样本页: tmp/artifacts-fan-sample.html')
} catch (error) {
  console.log('[!] 失败：', error instanceof Error ? error.message : String(error))
} finally {
  await bridge.close?.().catch?.(() => {})
  process.exit(0)
}

/**
 * 复现用户场景：工作流执行一次后，改种子立即再执行一次。
 * 断言：第二次不被误判为并发、能真正跑完，且两次种子与产物不同。
 * 用法：node scripts/verify-rerun.mjs [工作流名，默认 image_z_image_turbo]
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ComfymcpBridge } from '../plugins/dsh-comfymcp-client/lib/bridge.js'
import { createWorkbenchMethods } from '../plugins/dsh-comfymcp-client/lib/workbench.js'
import { resolveConfig } from '../plugins/dsh-comfymcp-client/lib/config.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const overlay = JSON.parse(readFileSync(join(process.env.DSH_HOME ?? '', 'comfymcp', 'config-overlay.json'), 'utf8'))
const workflow = process.argv[2] ?? 'image_z_image_turbo'
const config = resolveConfig({
  ...overlay,
  embeddedBackend: 'stdio',
  artifactsDir: join(root, 'tmp', 'rerun-artifacts'),
  dataDir: join(root, 'tmp', 'rerun-data'),
  saveSubdir: 'dsh-generated',
})
const bridge = new ComfymcpBridge(config, { log: () => {} })
const workbench = createWorkbenchMethods({ bridge, config })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(workflowName, timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const status = (await workbench.runStatus({ workflow: workflowName }))?.value ?? null
    if (status !== null && status.state !== 'running') return status
    if (Date.now() > deadline) return status
    await sleep(1500)
  }
}

try {
  const descriptor = await workbench.getPage(workflow)
  const seedField = descriptor?.sections?.flatMap((section) => section.fields.map((field) => ({ ...field, key: `${section.nodeId}:${field.field}` }))).find((field) => field.type === 'seed')
  if (!seedField) throw new Error('该工作流没有种子字段')
  console.log(`[1] 种子字段 → ${seedField.key}（当前 ${seedField.value}）`)

  const firstSeed = 111111
  const first = await workbench.runPage({ workflow, values: { [seedField.key]: firstSeed } })
  console.log('[2] 第一次执行 →', JSON.stringify(first))
  if (first.ok !== true) throw new Error(`第一次启动失败：${first.reason ?? first.error}`)
  const firstStatus = await waitFor(workflow)
  console.log(`    结果 → state=${firstStatus.state} seed=${firstStatus.seed} 用时=${firstStatus.elapsedMs}ms 产物=${(firstStatus.files ?? []).map((file) => file.filename).join(',') || '无'}`)

  // 用户操作：改种子后立即再点执行（上一轮刚结束，运行态仍在页面收尾展示期）
  const secondSeed = 222222
  const second = await workbench.runPage({ workflow, values: { [seedField.key]: secondSeed } })
  console.log('[3] 改种子后立即再执行 →', JSON.stringify(second))
  if (second.ok !== true) throw new Error(`第二次被拒（这就是用户看到的失败）：${second.reason ?? second.error}`)
  const secondStatus = await waitFor(workflow)
  console.log(`    结果 → state=${secondStatus.state} seed=${secondStatus.seed} 用时=${secondStatus.elapsedMs}ms 产物=${(secondStatus.files ?? []).map((file) => file.filename).join(',') || '无'}`)

  const size = secondStatus.files?.[0]?.path && existsSync(secondStatus.files[0].path) ? statSync(secondStatus.files[0].path).size : 0
  console.log(`[4] 判定 → 第二次 ${secondStatus.state === 'completed' ? '执行成功 ✓' : '未成功 ✗'} · 种子 ${firstStatus.seed} → ${secondStatus.seed}${firstStatus.seed !== secondStatus.seed ? '（已变 ✓）' : '（未变 ✗）'} · 产物 ${size} 字节`)

  // 成果区分组数据：多次运行 + 每次附带的参数（页面按组渲染，悬浮可见）
  const history = (await workbench.runHistory({ workflow, limit: 6 }))?.value ?? []
  console.log(`[5] 历史分组 → ${history.length} 组`)
  history.slice(0, 3).forEach((run, index) => {
    const top = (run.params ?? []).slice(0, 6).map((param) => `${param.field}=${String(param.value).slice(0, 18)}`).join(', ')
    console.log(`    #${index + 1} ${run.state} · 种子 ${run.seed} · 用时 ${run.durationMs ?? run.elapsedMs}ms · 参数 ${(run.params ?? []).length} 项 · 产物 ${(run.files ?? []).length} 件`)
    console.log(`        参数示例: ${top}`)
    console.log(`        提示词: 正「${String(run.prompts?.positive ?? '').slice(0, 30)}」`)
  })
} catch (error) {
  console.log('[!] 失败：', error instanceof Error ? error.message : String(error))
} finally {
  await bridge.close?.().catch?.(() => {})
  process.exit(0)
}

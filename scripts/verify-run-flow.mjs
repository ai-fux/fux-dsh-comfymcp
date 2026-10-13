/**
 * 端到端实证：真实 bridge（内嵌服务 + 宿主 + ComfyUI）跑完整异步运行链，
 * 观察 状态/进度/成果物落盘/历史/清空。
 * 用法：node scripts/verify-run-flow.mjs [本地工作流名，默认 image_z_image]
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ComfymcpBridge } from '../plugins/dsh-comfymcp-client/lib/bridge.js'
import { createWorkbenchMethods } from '../plugins/dsh-comfymcp-client/lib/workbench.js'
import { resolveConfig } from '../plugins/dsh-comfymcp-client/lib/config.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const overlayPath = join(process.env.DSH_HOME ?? '', 'comfymcp', 'config-overlay.json')
const overlay = JSON.parse(readFileSync(overlayPath, 'utf8'))
const workflow = process.argv[2] ?? 'image_z_image'
const artifactsDir = join(root, 'tmp', 'run-flow-artifacts')
const config = resolveConfig({
  ...overlay,
  embeddedBackend: 'stdio', // 与活进程一致：真实 ComfyUI 后端
  artifactsDir,
  dataDir: join(root, 'tmp', 'run-flow-data'),
  saveSubdir: 'dsh-generated',
})

const bridge = new ComfymcpBridge(config, { log: (line) => console.log('[bridge]', line) })
const workbench = createWorkbenchMethods({ bridge, config })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

try {
  const timeoutMs = Number(process.env.TIMEOUT_MS) > 0 ? Number(process.env.TIMEOUT_MS) : undefined
  console.log(`[1] 启动异步执行：${workflow}${timeoutMs !== undefined ? `（限时 ${timeoutMs}ms）` : ''}`)
  const started = await workbench.runPage({ workflow, ...(timeoutMs !== undefined ? { timeoutMs } : {}) })
  console.log('    启动结果 →', JSON.stringify(started))
  if (started.ok !== true) throw new Error(`启动失败：${started.reason ?? started.error}`)

  let lastStage = ''
  let printedRaw = false
  const deadline = Date.now() + 300000
  let status = null
  while (Date.now() < deadline) {
    const answer = await workbench.runStatus({ workflow })
    status = answer?.value ?? null
    if (status !== null && status.stage !== lastStage) {
      lastStage = status.stage
      console.log(`[2] 阶段 → ${status.stage}（${Math.round((status.elapsedMs ?? 0) / 1000)}s）`)
    }
    if (status !== null && status.progress !== null && status.progress !== undefined) {
      process.stdout.write(`\r    进度 ${status.progress.step ?? '-'}/${status.progress.total ?? '-'} 节点 ${status.progress.node ?? '-'}   `)
      if (process.env.RAW_PROGRESS === '1' && !printedRaw) {
        printedRaw = true
        console.log('\n[raw progress]', JSON.stringify(status.progress))
      }
    }
    if (status !== null && status.state !== 'running') break
    await sleep(2000)
  }
  console.log('')
  console.log('[3] 最终状态 →', JSON.stringify({ state: status?.state, stage: status?.stage, error: status?.error, files: (status?.files ?? []).length, elapsedMs: status?.elapsedMs }))
  for (const file of status?.files ?? []) {
    const ok = typeof file.path === 'string' && existsSync(file.path)
    console.log(`    成果物 ${file.filename} · ${file.kind} · ${ok ? `${statSync(file.path).size} bytes ✓ 已落盘` : '缺失 ✗'}`, file.path)
  }
  const history = await workbench.runHistory({ workflow, limit: 3 })
  console.log('[4] 历史条数 →', (history.value ?? []).length)
  const artifactsPage = await workbench.pageArtifacts({ token: 'demo' })
  const cards = (artifactsPage.html.match(/class="mediacard"/g) ?? []).length
  const runsShown = (artifactsPage.html.match(/<section class="run">/g) ?? []).length
  const ignored = /已忽略 (\d+) 次无成果物记录/.exec(artifactsPage.html)?.[1] ?? '0'
  console.log(`[4b] 成果物页 → ${runsShown} 次运行 / ${cards} 张媒体卡 · 忽略无产物记录 ${ignored} 条 · 预览弹层 ${artifactsPage.html.includes('id="preview"') ? '有' : '无'}`)
  const page = await workbench.pageWorkflow(workflow, { token: 'demo' })
  console.log(`[4c] 工作流页 → spinner 可隐藏 ${page.html.includes('.spinner[hidden]{display:none}') ? '✓' : '✗'} · 中断按钮 ${page.html.includes('id="cancel-btn"') ? '✓' : '✗'} · 文本展开 ${page.html.includes('data-expand=') ? '✓' : '✗'}`)
  const prompts = status?.prompts ?? null
  console.log(`[4d] 提示词 → 正「${String(prompts?.positive ?? '').slice(0, 40) || '(空)'}」 负「${String(prompts?.negative ?? '').slice(0, 40) || '(空)'}」 正字段 ${prompts?.positiveField ?? '-'} 负字段 ${prompts?.negativeField ?? '-'}`)
  const exported = await workbench.exportArtifacts({ ids: status?.runId ?? '' })
  const payload = JSON.parse(exported.json)
  const file = payload.runs[0]?.files?.[0]
  const onDisk = status?.files?.[0]?.path && existsSync(status.files[0].path) ? statSync(status.files[0].path).size : 0
  const base64Bytes = file?.data ? Buffer.from(file.data, 'base64').byteLength : 0
  console.log(`[4e] 导出 → ${exported.filename} · ${payload.runs.length} 次运行 · base64 ${base64Bytes} 字节（磁盘 ${onDisk} 字节）→ ${base64Bytes === onDisk ? '✓ 一致' : '✗ 不一致'}`)
  const assigned = await workbench.assignPrompt({ workflow, field: prompts?.positiveField ?? 'x:y', value: '赋值测试', kind: 'positive' })
  const taken = await workbench.takePrompt({ workflow })
  console.log(`[4f] 赋值往返 → ${assigned.ok === true && taken.value?.value === '赋值测试' ? '✓ 成功' : `✗ ${JSON.stringify({ assigned, taken })}`}`)
  const cleared = await workbench.clearRuns({ workflow })
  console.log('[5] 清空 →', JSON.stringify(cleared))
  const afterClear = await workbench.runStatus({ workflow })
  console.log('    清空后状态 →', JSON.stringify(afterClear?.value))
} catch (error) {
  console.log('[!] 失败：', error instanceof Error ? error.stack : String(error))
} finally {
  await bridge.close?.().catch?.(() => {})
  process.exit(0)
}

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
  console.log(`[1] 启动异步执行：${workflow}`)
  const started = await workbench.runPage({ workflow, values: { '76:69:steps': undefined } })
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

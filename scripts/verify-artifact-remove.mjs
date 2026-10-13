/**
 * 端到端验证成果物删除：真实运行 → 删除单件（含删盘）→ 移除整组。
 * 用法：node scripts/verify-artifact-remove.mjs [工作流名]
 */
import { existsSync, readFileSync } from 'node:fs'
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
  artifactsDir: join(root, 'tmp', 'remove-artifacts'),
  dataDir: join(root, 'tmp', 'remove-data'),
  saveSubdir: 'dsh-generated',
})
const bridge = new ComfymcpBridge(config, { log: () => {} })
const workbench = createWorkbenchMethods({ bridge, config })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

try {
  const started = await workbench.runPage({ workflow })
  if (started.ok !== true) throw new Error(`启动失败：${started.reason ?? started.error}`)
  let status = null
  for (let i = 0; i < 120; i += 1) {
    status = (await workbench.runStatus({ workflow }))?.value ?? null
    if (status !== null && status.state !== 'running') break
    await sleep(1500)
  }
  const file = status?.files?.[0]
  if (!file) throw new Error('本次没有产物，无法验证删除')
  console.log(`[1] 运行完成 → runId=${status.runId} 产物=${file.filename} 存在=${existsSync(file.path)}`)

  const dropped = await workbench.removeArtifact({ runId: status.runId, dropRun: true })
  console.log('[2] 移除该组 →', JSON.stringify(dropped), '· 记录仍在 =', bridge.getRun(status.runId) !== null)
  console.log('    说明：移除该组只清记录，文件应保留 → 存在 =', existsSync(file.path), '（应为 true）')

  // 再跑一次，用单件删除（含删盘）验证
  const second = await workbench.runPage({ workflow })
  if (second.ok !== true) throw new Error(`第二次启动失败：${second.reason ?? second.error}`)
  for (let i = 0; i < 120; i += 1) {
    status = (await workbench.runStatus({ workflow }))?.value ?? null
    if (status !== null && status.state !== 'running') break
    await sleep(1500)
  }
  const file2 = status?.files?.[0]
  if (!file2) throw new Error('第二次没有产物，无法验证单件删除')
  console.log(`[3] 第二次运行 → runId=${status.runId} 产物=${file2.filename}`)

  const rejected = await workbench.removeArtifact({ runId: status.runId, path: 'C:\\Windows\\System32\\drivers\\etc\\hosts', deleteFile: true })
  console.log('[4] 未登记路径删除 →', JSON.stringify(rejected), '（应为 ok:false，拒绝越权删除）')

  const removed = await workbench.removeArtifact({ runId: status.runId, path: file2.path, deleteFile: true })
  console.log('[5] 单件删除（含删盘）→', JSON.stringify(removed))
  const record = bridge.getRun(status.runId)
  console.log(`    判定 → 文件已删 = ${!existsSync(file2.path)} · 记录中剩余产物 = ${(record?.localFiles ?? []).length}`)
} catch (error) {
  console.log('[!] 失败：', error instanceof Error ? error.message : String(error))
} finally {
  await bridge.close?.().catch?.(() => {})
  process.exit(0)
}

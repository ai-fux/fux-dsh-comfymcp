/**
 * 成果物检索实证：用真实运行记录 + 真实标签库验证模糊/标签/参数/字段与「与·或」。
 * 用法：node scripts/verify-artifact-search.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ComfymcpBridge } from '../plugins/dsh-comfymcp-client/lib/bridge.js'
import { createWorkbenchMethods } from '../plugins/dsh-comfymcp-client/lib/workbench.js'
import { resolveConfig } from '../plugins/dsh-comfymcp-client/lib/config.js'
import { summarizeRun } from '../plugins/dsh-comfymcp-client/lib/rund.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const home = join(process.env.DSH_HOME ?? '', 'comfymcp')
const overlay = JSON.parse(readFileSync(join(home, 'config-overlay.json'), 'utf8'))
const config = resolveConfig({ ...overlay, dataDir: join(home, 'data'), artifactsDir: join(home, 'artifacts'), homeDir: home })
const bridge = new ComfymcpBridge(config, { log: () => {} })
const workbench = createWorkbenchMethods({ bridge, config })

try {
  const all = bridge.listRuns(200).filter((run) => Array.isArray(run.localFiles) && run.localFiles.length > 0)
  const tags = workbench.listArtifacts ? (await workbench.listArtifacts()).tags : {}
  console.log(`[0] 真实有产物记录 → ${all.length} 条 · 标签库 ${Object.keys(tags).length} 条`)
  const sample = summarizeRun(all[0])
  if (sample === null) throw new Error('没有可用记录')
  const seed = sample.seed
  const step = (sample.params ?? []).find((param) => param.field === 'steps')?.value
  console.log(`[1] 取样记录 → ${sample.name} · 种子 ${seed} · steps ${step} · 文件 ${(sample.files ?? []).length} 件`)

  const cases = [
    ['模糊-提示词', 'fashion'],
    ['模糊-或', 'fashion | 不存在的词zzz'],
    ['模糊-文件名', `file:${sample.localFiles[0].filename.split('.')[0]}`],
    ['参数-相等', `param:steps=${step}`],
    ['参数-比较', `param:steps>=${step}`],
    ['参数+提示词（与）', `param:steps=${step} fashion`],
    ['参数+不存在（与）', `param:steps=${step} 不存在的关键词zzz`],
    ['参数|不存在（或）', `param:steps=${step} | 不存在的关键词zzz`],
    ['排除-不存在标签', 'state:completed -tag:不存在的标签'],
    ['状态', 'state:completed'],
  ]
  for (const [label, query] of cases) {
    const outcome = await workbench.queryArtifacts({ query })
    const first = (outcome.html.match(/class="fname" title="([^"]+)"/) ?? [])[1] ?? '-'
    console.log(`[2] ${label.padEnd(16)} → 命中 ${String(outcome.hits).padStart(2)} 条 · ${outcome.queryText} · 首个 ${first}`)
  }

  // 三种卡片样式下的渲染检查（同一份 HTML，样式由前端切换）
  const page = await workbench.pageArtifacts({ token: 'demo' })
  const checks = {
    '瀑布流': page.html.includes('id="runs" class="style-masonry"') && page.html.includes('style-masonry{column-count:2'),
    '两列平铺': page.html.includes('style-grid2{display:grid;grid-template-columns:repeat(2'),
    '重叠摊开': page.html.includes('.fan .mediacard'),
    '语法帮助': page.html.includes('id="q-help"') && page.html.includes('param:steps'),
    '竖向卡片': page.html.includes('#runs.style-masonry .mediacard .thumb'),
  }
  console.log('[3] 渲染检查 →', Object.entries(checks).map(([label, ok]) => `${label}${ok ? '✓' : '✗'}`).join(' · '))
} catch (error) {
  console.log('[!] 失败：', error instanceof Error ? error.message : String(error))
} finally {
  await bridge.close?.().catch?.(() => {})
  process.exit(0)
}

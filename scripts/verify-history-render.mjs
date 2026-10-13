/**
 * 成果分组渲染实证：取真实页面脚本里的 groupHtml/paramSummaryText，喂真实运行历史，
 * 产出 HTML 样本（页面脚本为浏览器代码，这里用最小 DOM 桩执行，不改动被测代码）。
 * 用法：node scripts/verify-history-render.mjs [工作流名]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRunDaemon } from '../plugins/dsh-comfymcp-client/lib/rund.js'
import { buildPageDescriptor, renderPageHtml } from '../plugins/dsh-comfymcp-client/lib/wfpage.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const home = join(process.env.DSH_HOME ?? '', 'comfymcp')
const workflow = process.argv[2] ?? 'image_z_image'

// 1) 真实运行记录（含参数提取逻辑：直接用守护的 summarize）
const records = JSON.parse(readFileSync(join(home, 'data', 'runs.json'), 'utf8'))
const bridge = {
  config: { dataDir: join(root, 'tmp', 'history-render'), runTimeoutMin: 30 },
  listRuns: (limit = 60) => records.slice(0, limit),
  getRun: (id) => records.find((record) => record.id === id) ?? null,
  updateRun: () => null,
  recordRun: (run) => run,
  callRemote: async () => ({ structuredContent: { ok: true, data: {} } }),
}
const daemon = createRunDaemon({ bridge, executeRun: async () => ({ ok: true, state: 'completed' }) })
const groups = daemon.history(workflow, 6)
console.log(`[1] 真实历史 → ${groups.length} 组（工作流 ${workflow}）`)

// 2) 真实页面脚本 + 最小 DOM 桩，取出渲染函数
const page = renderPageHtml(buildPageDescriptor({ name: workflow, title: workflow, graph: {}, nodeInfos: {} }), { token: 'demo' })
const code = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]).join('\n')
const stubElement = () => ({
  hidden: false, value: '', textContent: '', innerHTML: '', style: {},
  classList: { add() {}, remove() {}, toggle() {} },
  addEventListener() {}, appendChild() {}, setAttribute() {}, querySelector: () => null, closest: () => null,
})
const documentStub = { addEventListener() {}, getElementById: stubElement, querySelectorAll: () => [] }
const windowStub = {}
const fetchStub = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, value: [] }) })
const factory = new Function('document', 'window', 'fetch', 'setTimeout', `${code}\n;return { groupHtml: groupHtml, paramSummaryText: paramSummaryText };`)
const render = factory(documentStub, windowStub, fetchStub, () => {})

const html = groups.map((run, index) => render.groupHtml(run, index + 1)).join('\n')
console.log('[2] 渲染样例（每组含：状态/种子/用时 + 提示词 + 参数折叠 + 悬浮摘要）:')
groups.slice(0, 2).forEach((run, index) => {
  console.log(`    #${index + 1} 悬浮摘要 → ${render.paramSummaryText(run).slice(0, 150)}`)
})
console.log(`[3] 生成 HTML ${html.length} 字符 · 参数表行数 ${(html.match(/<tr>/g) ?? []).length} · 媒体卡 ${(html.match(/class="item"/g) ?? []).length}`)
mkdirSync(join(root, 'tmp'), { recursive: true })
const sample = `<!doctype html><meta charset="utf-8"><title>成果分组样例</title>${page.match(/<style>[\s\S]*?<\/style>/)[0]}<div class="wrap"><h1>成果分组样例（${workflow}）</h1><div class="history">${html}</div></div>`
writeFileSync(join(root, 'tmp', 'history-sample.html'), sample, 'utf8')
console.log('样本页: tmp/history-sample.html')

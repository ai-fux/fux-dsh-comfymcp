/** 用真实主目录的 runs.json 渲染成果物页，核对「无模态数据不入库」过滤。 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderArtifactsHtml } from '../plugins/dsh-comfymcp-client/lib/wfpage.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const home = join(process.env.DSH_HOME ?? '', 'comfymcp')
const runs = JSON.parse(readFileSync(join(home, 'data', 'runs.json'), 'utf8'))
const withMedia = runs
const html = renderArtifactsHtml({ runs: withMedia, tags: {}, token: 'demo' })
const cards = html.split('class="mediacard"').length - 1
const ignored = /已忽略 (\d+) 次无成果物记录/.exec(html)?.[1] ?? '0'
console.log(`记录总数 ${runs.length} · 有产物 ${withMedia.length} · 页面卡片 ${cards} · 忽略 ${ignored}`)
writeFileSync(join(root, 'tmp', 'artifacts-live.html'), html, 'utf8')
console.log('样本页: tmp/artifacts-live.html')

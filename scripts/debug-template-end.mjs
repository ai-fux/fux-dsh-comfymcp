/** 诊断：定位 renderArtifactsHtml 里 body 模板的真实结束位置（排查游离反引号）。 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const file = join(root, 'plugins', 'dsh-comfymcp-client', 'lib', 'wfpage.js')
const source = readFileSync(file, 'utf8')
const anchor = source.indexOf('export function renderArtifactsHtml')
const seg = source.slice(anchor, anchor + 3000)
const open = seg.indexOf('const body = `')
const start = open + 'const body = `'.length
let index = start
let prev = ''
while (index < seg.length) {
  const char = seg[index]
  if (prev === '\\') {
    prev = ''
    index += 1
    continue
  }
  if (char === '`') break
  prev = char
  index += 1
}
console.log('模板起点:', start, '结束:', index, '长度:', index - start)
console.log('模板末尾 120 字符:', JSON.stringify(seg.slice(Math.max(start, index - 120), index)))
console.log('反引号后 120 字符:', JSON.stringify(seg.slice(index, index + 120)))

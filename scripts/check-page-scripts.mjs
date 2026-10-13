/**
 * 页面脚本体检：抽出 /ui 页面里的 <script> 内容做语法检查（提交监听挂不上时，
 * 点「执行」会退化成表单默认跳转），并统计关键监听是否存在。
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPageDescriptor, renderPageHtml, renderArtifactsHtml, renderIndexHtml } from '../plugins/dsh-comfymcp-client/lib/wfpage.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(root, 'tmp'), { recursive: true })

const GRAPH = {
  '76:67': { class_type: 'CLIPTextEncode', inputs: { text: '正向提示词', clip: ['76:62', 0] } },
  '76:69': { class_type: 'KSampler', inputs: { seed: 1, steps: 20, positive: ['76:67', 0], negative: ['76:71', 0] } },
  '76:71': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['76:62', 0] } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'x', images: ['76:65', 0] } },
}
const NODE_INFOS = {
  'KSampler': { classType: 'KSampler', inputs: [{ name: 'seed', type: 'INT', required: true }, { name: 'steps', type: 'INT', required: true }] },
  'CLIPTextEncode': { classType: 'CLIPTextEncode', inputs: [{ name: 'text', type: 'STRING', required: true }] },
  'SaveImage': { classType: 'SaveImage', inputs: [{ name: 'filename_prefix', type: 'STRING', required: true }] },
}

const pages = {
  workflow: renderPageHtml(buildPageDescriptor({ name: 'demo', title: 'demo', graph: GRAPH, nodeInfos: NODE_INFOS }), { token: 'tk' }),
  artifacts: renderArtifactsHtml({
    runs: [{ id: 'r1', name: 'demo', state: 'completed', seed: 1, prompts: { positive: '正', negative: '负', positiveField: '76:67:text', negativeField: '76:71:text' }, localFiles: [{ path: 'C:\\a\\x.png', filename: 'x.png', kind: 'image', bytes: 3 }] }],
    tags: {},
    token: 'tk',
  }),
  index: renderIndexHtml({ mine: [{ name: 'demo', title: 'demo', origin: 'local' }], library: [{ name: 'library:x.json', title: 'x', origin: 'remote' }], token: 'tk' }),
}

let failed = false
for (const [name, html] of Object.entries(pages)) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1])
  const code = scripts.join('\n;\n')
  const file = join(root, 'tmp', `page-${name}.js`)
  writeFileSync(file, code, 'utf8')
  let syntax = 'OK'
  try {
    // 仅语法检查：不执行（页面脚本依赖 DOM）
    new Function(code)
  } catch (error) {
    syntax = `✗ ${error.message}`
    failed = true
  }
  const checks = {
    'run-form submit 监听': /getElementById\('run-form'\)\.addEventListener\('submit'/.test(code),
    '提交时 preventDefault': /preventDefault\(\)/.test(code),
    '取消按钮处理': /cancel-btn/.test(code),
    '展开编辑器处理': /data-expand/.test(code),
    '页面加载恢复状态': /api\/run\/status\?workflow=/.test(code),
    '提示词赋值取回': /api\/prompt\/take/.test(code),
  }
  console.log(`${name.padEnd(9)} 脚本 ${code.length} 字符 · 语法 ${syntax}`)
  for (const [label, ok] of Object.entries(checks)) {
    if (name !== 'workflow' && !label.includes('run') && !label.includes('cancel') && !label.includes('expand')) continue
    console.log(`  ${ok ? '✓' : '✗'} ${label}`)
  }
}
process.exit(failed ? 1 : 0)

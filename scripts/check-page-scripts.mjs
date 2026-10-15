/**
 * 页面脚本体检：抽出 /ui 页面里的 <script> 内容做语法检查（提交监听挂不上时，
 * 点「执行」会退化成表单默认跳转），并统计关键监听是否存在。
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPageDescriptor, renderPageHtml, renderArtifactsHtml, renderCommandsHtml, renderIndexHtml } from '../plugins/dsh-comfymcp-client/lib/wfpage.js'

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
  commands: renderCommandsHtml({
    commands: [{ name: '抽卡', label: '🎲 抽卡', count: 2, batchMode: 'serial', seed: { mode: 'range', min: 1, max: 4294967295 } }],
    lastRun: { name: 'demo', seed: 1 },
    token: 'tk',
  }),
}

/** 每页各自的关键监听（不做跨页统一断言，避免用表单页的检查去评判画廊页）。 */
const PAGE_CHECKS = {
  workflow: {
    'run-form submit 监听': /getElementById\('run-form'\)\.addEventListener\('submit'/,
    '提交时 preventDefault': /preventDefault\(\)/,
    '取消按钮处理': /cancel-btn/,
    '展开编辑器处理': /data-expand/,
    '页面加载恢复状态': /api\/run\/status\?workflow=/,
    '提示词赋值取回': /api\/prompt\/take/,
  },
  artifacts: {
    '预览事件绑定': /bindPreviewEvents\('preview'\)/,
    '灯箱整屏遮罩（打开/关闭/锁滚动）': /function showPreview\([\s\S]*lb-open[\s\S]*function closePreviewModal\(/,
    '灯箱内缩放（锚点+适应窗口+1:1）': /function viewZoomTo\([\s\S]*function viewFit\([\s\S]*function viewActual\(/,
    '卡片操作主次（⋯ 更多 就地展开）': /ops-more[\s\S]*more-open/,
    '瀑布流轮转填充（每排从最左开始）': /function layoutMasonry\([\s\S]*index % columns/,
    '样式切换与记忆': /function applyStyle\([\s\S]*comfymcp\.artifactStyle/,
    '复合检索请求': /api\/artifacts\/query/,
    '批量删除请求': /api\/artifacts\/remove-batch/,
  },
  commands: {
    '种子策略显隐': /function syncSeedFields\(/,
    '卡片取值归一': /function cardValues\(/,
    '保存指令监听': /api\/quick\/save/,
    '立即执行监听': /api\/quick'/,
    '卡片集合查询': /#cmd-list \.cmdcard/,
  },
  index: {
    'Tab 切换处理': /data-tab/,
    '拉取模板请求': /api\/workflows\/pull/,
  },
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
  const checks = PAGE_CHECKS[name] ?? {}
  console.log(`${name.padEnd(9)} 脚本 ${code.length} 字符 · 语法 ${syntax}`)
  for (const [label, pattern] of Object.entries(checks)) {
    const ok = pattern.test(code)
    if (!ok) failed = true
    console.log(`  ${ok ? '✓' : '✗'} ${label}`)
  }
}
process.exit(failed ? 1 : 0)

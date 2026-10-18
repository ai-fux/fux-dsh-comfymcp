/**
 * 页面脚本体检：抽出 /ui 页面里的 <script> 内容做语法检查（提交监听挂不上时，
 * 点「执行」会退化成表单默认跳转），并统计关键监听是否存在。
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPageDescriptor, renderPageHtml, renderArtifactsHtml, renderCommandsHtml, renderBusinessHtml, renderIndexHtml } from '../plugins/dsh-comfymcp-client/lib/wfpage.js'
import { renderCreateHtml } from '../plugins/dsh-comfymcp-client/lib/createpage.js'
import { BUSINESS_KINDS } from '../plugins/dsh-comfymcp-client/lib/business.js'

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
  workflow: renderPageHtml(buildPageDescriptor({ name: 'demo', title: 'demo', graph: GRAPH, nodeInfos: NODE_INFOS }), {
    token: 'tk',
    businessLabel: '文生图',
    presets: [{ id: 'preset-1', name: '高清', params: { steps: 30, width: 1024 } }],
  }),
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
  business: renderBusinessHtml({
    profiles: [{ id: 'text2img', business: 'text2img', label: '文生图', workflow: 'z-image-turbo', keywords: ['画'], params: { steps: 8 }, uses: 2, presets: [{ id: 'preset-1', name: '高清', params: { steps: 30 } }], candidates: [{ workflow: 'flux-schnell', source: 'saved', uses: 3 }] }],
    kinds: BUSINESS_KINDS,
    candidates: [{ business: 'image2video', label: '图生视频', workflow: 'svd', runs: 2, current: null }],
    workflows: ['z-image-turbo', 'svd'],
    runStats: { 'z-image-turbo': { runs: 2, ok: 2, failed: 0, lastOkAt: null }, 'flux-schnell': { runs: 3, ok: 3, failed: 0, lastOkAt: null } },
    token: 'tk',
  }),
  create: renderCreateHtml({
    providers: [{ id: 'ms-qwen-image', label: '魔搭 · Qwen-Image', kind: 'modelscope', kindLabel: '魔搭 ModelScope（异步任务）', baseUrl: 'https://api-inference.modelscope.cn', model: 'Qwen/Qwen-Image', apiKey: 'sk-****abcd', apiKeyIsEnv: false, enabled: true, capabilities: ['t2i', 'i2i'], defaults: { size: '1024x1024' } }],
    creations: [{ id: 'c1', status: 'succeeded', providerId: 'ms-qwen-image', providerLabel: '魔搭 · Qwen-Image', model: 'Qwen/Qwen-Image', mode: 't2i', prompt: '电影感海报', images: [{ path: 'C:\\a\\x.png', mime: 'image/png', bytes: 3 }], elapsedMs: 12000, createdAt: '2026-10-17T00:00:00.000Z' }],
    defaultId: 'ms-qwen-image',
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
    '业务预设条渲染（数据随页下发）': /var BIZ_PRESETS = \[\{/,
    '业务预设套用监听（按字段名匹配填表单）': /getAttribute\('data-biz-preset'\)[\s\S]*lastIndexOf\(':'\)/,
  },
  artifacts: {
    '预览事件绑定': /bindPreviewEvents\('preview'\)/,
    '灯箱整屏遮罩（打开/关闭/锁滚动）': /function showPreview\([\s\S]*lb-open[\s\S]*function closePreviewModal\(/,
    '灯箱内缩放（锚点+适应窗口+1:1）': /function viewZoomTo\([\s\S]*function viewFit\([\s\S]*function viewActual\(/,
    '卡片操作主次（⋯ 更多 就地展开）': /ops-more[\s\S]*more-open/,
    '多张收集卡（逐张画廊 + 文件列表）': /showGallery\('preview'[\s\S]*data-toggle-files[\s\S]*layoutMasonry\(\)/,
    '画廊 ← → 切换': /galleryStep\(-1\)[\s\S]*galleryStep\(1\)/,
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
  business: {
    '保存业务配置': /api\/business\/save/,
    '删除业务配置': /api\/business\/remove/,
    '业务类动态新增': /api\/business\/kind\/save/,
    '业务类动态删除': /api\/business\/kind\/remove/,
    '参数按所选工作流动态读取': /function bizLoadParams\(card, options\)[\s\S]*api\('\/api\/business\/schema'/,
    '工作流变更即刷新参数': /!== 'workflow'[\s\S]*bizLoadParams\(card/,
    '卡片取值（业务类/工作流/触发词/参数）': /function bizValues\(card\)[\s\S]*data-param/,
    '新增卡片': /function bizAddCard\(/,
    '设为主配置请求': /api\/business\/promote/,
    '候选渲染（点击设为主）': /getAttribute\('data-biz-promote'\)/,
    '预设保存请求': /api\/business\/preset\/save/,
    '预设删除请求': /api\/business\/preset\/remove/,
    '预设一键套用': /function bizApplyPreset\(card, preset\)/,
    '预设数据随卡片下发': /var BIZ_PRESETS = \{/,
  },
  index: {
    'Tab 切换处理': /data-tab/,
    '拉取模板请求': /api\/workflows\/pull/,
  },
  create: {
    '服务商保存请求': /api\/providers'/,
    '服务商测试请求': /api\/providers\/test/,
    '生成任务请求': /api\/create'/,
    '任务轮询': /api\/create\/job\?id=/,
    '创作历史刷新': /function loadHistory\(\)[\s\S]*api\/create\/history/,
    '模式切换显隐': /function syncModeUi\(/,
    '图生图参考图（上传与成果物）': /FileReader[\s\S]*gen-artifact/,
    '灯箱事件绑定': /bindPreviewEvents\('preview'\)/,
    '结果画廊渲染': /function renderResults\(images\)/,
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

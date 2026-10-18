/**
 * 页面模板体检：确保所有页面渲染函数里的 HTML 模板没有「游离反引号」被提前截断
 * （典型来源：在 HTML 里写 markdown 反引号），并顺带核对关键元素是否存在。
 */
import { renderIndexHtml, renderLibraryHtml, renderPageHtml, renderArtifactsHtml, renderCommandsHtml, renderBusinessHtml, buildPageDescriptor } from '../plugins/dsh-comfymcp-client/lib/wfpage.js'
import { renderCreateHtml } from '../plugins/dsh-comfymcp-client/lib/createpage.js'
import { BUSINESS_KINDS } from '../plugins/dsh-comfymcp-client/lib/business.js'

const GRAPH = { '3': { class_type: 'KSampler', inputs: { seed: 1 } } }
const cases = {
  index: renderIndexHtml({ mine: [{ name: 'a', title: 'a' }], library: [], token: 'tk' }),
  library: renderLibraryHtml({ library: [{ name: 'library:x.json', title: 'x' }], mine: [], token: 'tk' }),
  workflow: renderPageHtml(buildPageDescriptor({ name: 'a', title: 'a', graph: GRAPH, nodeInfos: {} }), { token: 'tk' }),
  artifacts: renderArtifactsHtml({
    runs: [{ id: 'r1', name: 'a', state: 'completed', localFiles: [{ path: 'C:/a.png', filename: 'a.png', kind: 'image' }] }],
    tags: {},
    token: 'tk',
  }),
  commands: renderCommandsHtml({
    commands: [{ name: '抽卡', label: '🎲 抽卡', count: 1, batchMode: 'serial', seed: { mode: 'range', min: 1, max: 4294967295 } }],
    lastRun: { name: 'a', seed: 1 },
    token: 'tk',
  }),
  business: renderBusinessHtml({
    profiles: [{ id: 'text2img', business: 'text2img', label: '文生图', workflow: 'wf', keywords: ['画'], params: { steps: 8 } }],
    kinds: BUSINESS_KINDS,
    candidates: [{ business: 'image2img', label: '图生图', workflow: 'wf2', runs: 1, current: null }],
    workflows: ['wf', 'wf2'],
    token: 'tk',
  }),
  create: renderCreateHtml({
    providers: [{ id: 'ms-qwen-image', label: '魔搭 · Qwen-Image', kind: 'modelscope', baseUrl: 'https://api-inference.modelscope.cn', model: 'Qwen/Qwen-Image', apiKey: 'sk-****abcd', enabled: true, capabilities: ['t2i', 'i2i'] }],
    creations: [{ id: 'c1', status: 'succeeded', providerId: 'ms-qwen-image', providerLabel: '魔搭', model: 'Qwen/Qwen-Image', prompt: '测试', images: [{ path: 'C:/a.png' }], elapsedMs: 1000 }],
    defaultId: 'ms-qwen-image',
    token: 'tk',
  }),
}
let failed = false
for (const [name, html] of Object.entries(cases)) {
  const bodyLength = (html.match(/class="wrap[^"]*">([\s\S]*?)<script/) ?? [])[1]?.length ?? 0
  let ok = bodyLength > 200
  let extra = ''
  if (name === 'create') {
    // 创作页必须带灯箱标记与 PREVIEW_JS（缺一即预览/画廊失效）
    const hasLightbox = html.includes('id="preview-body"')
    const hasPreviewJs = /function viewZoomTo\([\s\S]*function showPreview\(/.test(html)
    if (!hasLightbox || !hasPreviewJs) ok = false
    extra = ` · 灯箱标记 ${hasLightbox ? '✓' : '✗'} · 灯箱脚本 ${hasPreviewJs ? '✓' : '✗'}`
  }
  if (!ok) failed = true
  console.log(`${name.padEnd(9)} body ${String(bodyLength).padStart(6)} 字符 · ${ok ? '完整 ✓' : '疑似被模板截断 ✗'}${extra}`)
}
process.exit(failed ? 1 : 0)

import { describe, expect, it } from 'vitest'
import { buildPageDescriptor, renderArtifactsHtml, renderIndexHtml, renderPageHtml } from '../lib/wfpage.js'

const NODE_INFOS = {
  KSampler: {
    inputs: [
      { name: 'seed', type: 'INT', required: true, min: 0, max: 4294967295 },
      { name: 'steps', type: 'INT', required: true, default: 20, min: 1, max: 100 },
      { name: 'cfg', type: 'FLOAT', required: false, default: 7, min: 0, max: 20 },
      { name: 'model', type: 'MODEL', required: true },
      { name: 'denoise', type: 'FLOAT', required: false, default: 1 },
    ],
  },
  CLIPTextEncode: {
    inputs: [{ name: 'text', type: 'STRING', required: true }],
  },
  EmptyLatentImage: {
    inputs: [
      { name: 'width', type: 'INT', required: true, default: 512 },
      { name: 'height', type: 'INT', required: true, default: 512 },
      { name: 'batch_size', type: 'INT', required: true, default: 1 },
    ],
  },
  SaveImage: {
    inputs: [{ name: 'filename_prefix', type: 'STRING', required: false, default: 'ComfyUI' }],
  },
  CheckpointLoaderSimple: {
    inputs: [{ name: 'ckpt_name', type: ['model1.safetensors', 'model2.safetensors'], required: true }],
  },
}

const GRAPH = {
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model1.safetensors' } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: '夕阳<西下>，沙滩' } },
  '3': { class_type: 'KSampler', inputs: { seed: 42, steps: 25, cfg: 7.5, model: ['4', 0], denoise: 1 } },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: 768, height: 512, batch_size: 1 } },
}

describe('buildPageDescriptor', () => {
  it('orchestrates nodes into sections with typed fields, skipping links', () => {
    const descriptor = buildPageDescriptor({ name: 'beach', title: '海滩出图', graph: GRAPH, nodeInfos: NODE_INFOS })
    expect(descriptor.version).toBe(1)
    expect(descriptor.nodeCount).toBe(4)
    const byClass = Object.fromEntries(descriptor.sections.map((section) => [section.classType, section]))
    const sampler = byClass.KSampler
    expect(sampler.nodeId).toBe('3')
    const seedField = sampler.fields.find((field) => field.field === 'seed')
    expect(seedField.type).toBe('seed')
    expect(seedField.value).toBe('42')
    expect(sampler.fields.find((field) => field.field === 'cfg').step).toBe(0.01)
    expect(sampler.fields.find((field) => field.field === 'model')).toBeUndefined() // 链接字段
    const encode = byClass.CLIPTextEncode
    expect(encode.fields[0]).toMatchObject({ field: 'text', type: 'text', value: '夕阳<西下>，沙滩' })
    const loader = byClass.CheckpointLoaderSimple
    expect(loader.fields[0]).toMatchObject({ type: 'choice', options: ['model1.safetensors', 'model2.safetensors'] })
  })

  it('falls back to graph scalars when node_info is unavailable (boundary)', () => {
    const descriptor = buildPageDescriptor({ name: 'b', graph: { '6': { class_type: 'UnknownCls', inputs: { text: 'hi', model: ['4', 0] } } }, nodeInfos: {} })
    const fields = descriptor.sections[0].fields
    expect(fields).toHaveLength(1)
    expect(fields[0]).toMatchObject({ field: 'text', type: 'text', value: 'hi' })
  })
})

describe('renderPageHtml', () => {
  it('renders deterministic html with composite keys, escaping and quick commands', () => {
    const descriptor = buildPageDescriptor({ name: 'beach', title: '海滩出图', graph: GRAPH, nodeInfos: NODE_INFOS })
    const a = renderPageHtml(descriptor, { token: 't&<1', quickCommands: [{ name: '抽卡', label: '🎲 抽卡' }] })
    const b = renderPageHtml(descriptor, { token: 't&<1', quickCommands: [{ name: '抽卡', label: '🎲 抽卡' }] })
    expect(a).toBe(b) // 同描述符必得同页面
    expect(a).toContain('data-field="3:seed"')
    expect(a).toContain('data-field="6:text"')
    expect(a).toContain('夕阳&lt;西下&gt;，沙滩')
    expect(a).toContain('data-quick="抽卡"')
    expect(a).toContain('token=t%26%3C1')
    expect(a).toContain('data-dice=')
    expect(a).toContain('/api/run')
    expect(a).toContain('/artifact?path=')
    // 回归：spinner 必须能被 hidden 隐藏，否则执行按钮永远像在 loading
    expect(a).toContain('.spinner[hidden]{display:none}')
    expect(a).toContain('id="cancel-btn"')
    // 文本字段：区分 textarea、自动增高、可展开大域编辑全文
    expect(a).toContain('class="textwrap"')
    expect(a).toContain('rows="3"')
    expect(a).toContain('data-expand=')
    expect(a).toContain('id="textmodal"')
    expect(a).toContain('id="assign-hint"')
  })
})

describe('page scripts stay parseable', () => {
  const pages = () => ({
    workflow: renderPageHtml(buildPageDescriptor({ name: 'demo', title: 'demo', graph: GRAPH, nodeInfos: NODE_INFOS }), { token: 'tk' }),
    artifacts: renderArtifactsHtml({
      runs: [{ id: 'r1', name: 'demo', state: 'completed', prompts: { positive: '正', negative: '负' }, localFiles: [{ path: 'C:\\a\\x.png', filename: 'x.png', kind: 'image', bytes: 3 }] }],
      tags: {},
      token: 'tk',
    }),
    index: renderIndexHtml({ mine: [{ name: 'demo', title: 'demo' }], library: [], token: 'tk' }),
  })

  it('every rendered page script parses (a broken script would break the run button)', () => {
    for (const [name, html] of Object.entries(pages())) {
      const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1])
      expect(scripts.length, `${name} 页应有脚本`).toBeGreaterThan(0)
      for (const code of scripts) {
        // 语法错误（例如模板串里未转义的 \n）会让整段脚本失效 → 提交退化为表单跳转
        expect(() => new Function(code), `${name} 页脚本语法错误`).not.toThrow()
      }
    }
  })

  it('workflow page renders multi-run history groups with attached params', () => {
    const html = pages().workflow
    const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]).join('\n')
    // 成果区：多次运行分组容器 + 历史加载 + 参数（折叠 + 悬浮）
    expect(html).toContain('id="history"')
    expect(html).toContain('class="history"')
    expect(html).toContain('id="history-reload"')
    expect(code).toContain("api('/api/run/history?workflow=")
    expect(code).toContain('function groupHtml(')
    expect(code).toContain('function paramSummaryText(')
    expect(code).toContain('details class="params"')
    expect(code).toContain('data-preview2=')
    expect(code).toContain('data-history-export=')
    expect(code).toContain('loadHistory(); // 结束后刷新成果分组')
  })

  it('workflow page binds submit and blocks native navigation (boundary)', () => {
    const html = pages().workflow
    const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]).join('\n')
    expect(code).toContain("getElementById('run-form').addEventListener('submit'")
    expect(code).toContain('event.preventDefault()')
    // 双保险：即使脚本异常，原生表单提交也不跳转
    expect(html).toContain('<form id="run-form" onsubmit="return false">')
  })
})

describe('renderIndexHtml / renderArtifactsHtml', () => {
  it('renders mine/library tabs with pull buttons and reload (boundary: empty)', () => {
    const html = renderIndexHtml({
      mine: [
        { name: 'beach', title: 'beach', origin: 'local', updatedAt: '2026-10-11' },
        { name: 'ws:gen-1', title: 'gen-1', origin: 'remote' },
      ],
      library: [{ name: 'library:x.json', title: 'x', origin: 'remote' }],
      token: 'tk',
    })
    expect(html).toContain('data-tab="mine"')
    expect(html).toContain('data-tab="library"')
    expect(html).toContain('我的工作流（2）')
    expect(html).toContain('模板库（1）')
    expect(html).toContain('/ui/wf/beach?token=tk')
    expect(html).toContain('/ui/wf/library%3Ax.json')
    expect(html).toContain('data-pull="ws:gen-1"')
    expect(html).toContain('↻ 重新加载')
    const empty = renderIndexHtml({ mine: [], library: [], token: '' })
    expect(empty).toContain('还没有我的工作流')
    expect(empty).toContain('模板库暂不可达')
  })

  it('renders runs with tags chips, dynamic fields and binding (boundary: empty)', () => {
    const runs = [
      {
        name: 'beach', state: 'completed', seed: 7, prompt: '夕阳西下',
        localFiles: [{ path: 'C:\\a\\out.png', filename: 'out.png', kind: 'image', bytes: 12, key: 'k1' }],
      },
    ]
    const tags = { k1: { tags: ['夕阳'], collections: ['旅拍'], fields: { 尺寸: '768x512' }, prompt: 'p', source: '项目A' } }
    const videoRun = { name: 'video-wf', state: 'completed', seed: 1, localFiles: [{ path: 'C:\\a\\clip.mp4', filename: 'clip.mp4', kind: 'video', bytes: 2048 }] }
    const html = renderArtifactsHtml({ runs: [...runs, videoRun], tags, token: 'tk' })
    expect(html).toContain('/artifact?path=C%3A%5Ca%5Cout.png&token=tk')
    expect(html).toContain('夕阳')
    expect(html).toContain('🗃 旅拍')
    expect(html).toContain('尺寸=768x512')
    expect(html).toContain('data-op="prompt"')
    expect(html).toContain('来源：项目A')
    // 卡片化 + 预览弹层（图片放大 / 视频音频播放）
    expect(html).toContain('class="mediacard"')
    expect(html).toContain('class="mediaList"') // 一列卡片布局
    expect(html).toContain('data-preview="C:\\a\\out.png"')
    expect(html).toContain('data-kind="video"')
    expect(html).toContain('id="preview"')
    expect(html).toContain("body.innerHTML = '<video")
    // 导出：单个运行 + 整体（JSON / base64）
    expect(html).toContain('data-export-run=')
    expect(html).toContain('id="export-all"')
    expect(html).toContain('/export?runs=')
    // 提示词正/负：分列、折叠箭头、悬浮全文、快捷赋值
    const promptRun = {
      id: 'r9', name: 'beach', state: 'completed', seed: 3,
      prompts: { positive: '夕阳 沙滩', negative: '模糊', positiveField: '6:text', negativeField: '7:text' },
      localFiles: [{ path: 'C:\\a\\p.png', filename: 'p.png', kind: 'image', bytes: 1 }],
    }
    const withPrompt = renderArtifactsHtml({ runs: [promptRun], tags: {}, token: 'tk' })
    expect(withPrompt).toContain('>正<')
    expect(withPrompt).toContain('>负<')
    expect(withPrompt).toContain('data-prompt-toggle=')
    expect(withPrompt).toContain('class="promptFull hidden"')
    expect(withPrompt).toContain('title="夕阳 沙滩"') // 悬浮全文
    expect(withPrompt).toContain('data-assign-field="6:text"')
    expect(withPrompt).toContain('data-assign-field="7:text"')
    // 无模态数据不入库：没有产物的运行不出现在成果物页
    const empty = renderArtifactsHtml({ runs: [{ name: 'x', state: 'failed', localFiles: [] }], tags: {}, token: '' })
    expect(empty).toContain('还没有带成果物的运行')
    expect(empty).toContain('已忽略 1 次无成果物记录')
    expect(empty).not.toContain('x</b>')
  })
})

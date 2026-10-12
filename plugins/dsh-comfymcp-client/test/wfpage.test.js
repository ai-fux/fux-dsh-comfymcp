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
  })
})

describe('renderIndexHtml / renderArtifactsHtml', () => {
  it('lists pages with tokenized links (boundary: empty)', () => {
    const html = renderIndexHtml({ pages: [{ name: 'beach', title: 'beach', nodeCount: 5, updatedAt: '2026-10-11' }], token: 'tk' })
    expect(html).toContain('/ui/wf/beach?token=tk')
    expect(html).toContain('/ui/artifacts?token=tk')
    expect(html).toContain('5 节点')
    expect(renderIndexHtml({ pages: [], token: '' })).toContain('还没有可编排的工作流')
  })

  it('renders runs with tags chips, dynamic fields and binding (boundary: empty)', () => {
    const runs = [
      {
        name: 'beach', state: 'completed', seed: 7, prompt: '夕阳西下',
        localFiles: [{ path: 'C:\\a\\out.png', filename: 'out.png', kind: 'image', bytes: 12, key: 'k1' }],
      },
    ]
    const tags = { k1: { tags: ['夕阳'], collections: ['旅拍'], fields: { 尺寸: '768x512' }, prompt: 'p', source: '项目A' } }
    const html = renderArtifactsHtml({ runs, tags, token: 'tk' })
    expect(html).toContain('/artifact?path=C%3A%5Ca%5Cout.png&token=tk')
    expect(html).toContain('夕阳')
    expect(html).toContain('🗃 旅拍')
    expect(html).toContain('尺寸=768x512')
    expect(html).toContain('data-op="prompt"')
    expect(html).toContain('来源：项目A')
    expect(renderArtifactsHtml({ runs: [], tags: {}, token: '' })).toContain('还没有运行记录')
  })
})

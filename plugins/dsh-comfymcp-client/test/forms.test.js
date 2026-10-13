import { describe, expect, it } from 'vitest'
import {
  applyAnswers,
  buildQuestions,
  deriveFields,
  extractPrompts,
  firstPromptText,
  firstSeed,
  FormError,
  integrateUnloadNode,
  stripUnloadNodes,
  unloadNodeIds,
  normalizeNodeInfos,
  randomizeSeeds,
  resolveAnswer,
} from '../lib/forms.js'

describe('normalizeNodeInfos', () => {
  it('converts the real backend inputs-array shape into the API shape', () => {
    const normalized = normalizeNodeInfos({
      nodes: {
        KSampler: {
          classType: 'KSampler',
          inputs: [
            { name: 'seed', group: 'required', type: 'INT', required: true, default: 0, min: 0, max: 100 },
            { name: 'cfg', group: 'required', type: 'FLOAT', required: true, default: 8 },
            { name: 'model', group: 'required', type: 'MODEL', required: true },
            { name: 'image', group: 'optional', type: 'IMAGE', required: false },
          ],
        },
      },
    })
    const required = normalized['KSampler'].input.required
    expect(required['seed']).toEqual(['INT', { default: 0, min: 0, max: 100 }])
    expect(required['cfg']).toEqual(['FLOAT', { default: 8 }])
    expect(required['model']).toEqual(['MODEL', {}])
    expect(required['image']).toBeUndefined()
  })

  it('passes the legacy classes shape through untouched', () => {
    const legacy = { classes: { KSampler: { input: { required: { seed: ['INT', { min: 1 }] } } } } }
    expect(normalizeNodeInfos(legacy)).toEqual(legacy.classes)
  })
})

const SAMPLE_GRAPH = {
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a girl in the rain', clip: ['5', 1] } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry', clip: ['5', 1] } },
  '3': {
    class_type: 'KSampler',
    inputs: {
      seed: 42,
      steps: 20,
      cfg: 8,
      sampler_name: 'euler',
      scheduler: 'normal',
      denoise: 1,
      model: ['4', 0],
      positive: ['6', 0],
      negative: ['7', 0],
      latent_image: ['5', 0],
    },
  },
  '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['5', 2] } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'ComfyUI', images: ['8', 0] } },
}

const NODE_INFOS = {
  KSampler: {
    input: {
      required: {
        seed: ['INT', { min: 0, max: 4294967295 }],
        steps: ['INT', { min: 1, max: 100 }],
        cfg: ['FLOAT', { min: 0, max: 20 }],
        sampler_name: [['euler', 'dpmpp_2m', 'ddim']],
        scheduler: [['normal', 'karras']],
      },
    },
  },
}

describe('deriveFields', () => {
  it('derives prompt, seed, numbers, and enums; skips link inputs', () => {
    const fields = deriveFields(SAMPLE_GRAPH, NODE_INFOS, ['model-a.safetensors'])
    const byId = new Map(fields.map((field) => [field.id, field]))
    expect(byId.get('6.text').kind).toBe('text')
    expect(byId.get('3.seed').kind).toBe('seed')
    expect(byId.get('3.steps').kind).toBe('number')
    expect(byId.get('3.steps').min).toBe(1)
    expect(byId.get('3.steps').max).toBe(100)
    expect(byId.get('3.sampler_name').kind).toBe('enum')
    expect(byId.get('3.sampler_name').options).toContain('dpmpp_2m')
    expect(byId.has('6.clip')).toBe(false)
    // prompts sort before seeds
    const kinds = fields.map((field) => field.kind)
    expect(kinds.indexOf('text')).toBeLessThan(kinds.indexOf('seed'))
  })

  it('model fields take server choices', () => {
    const graph = { '4': { class_type: 'CheckpointLoaderSimple', inputs: { model_name: 'old.safetensors' } } }
    const fields = deriveFields(graph, {}, ['a.safetensors', 'b.safetensors'])
    expect(fields[0].kind).toBe('enum')
    expect(fields[0].options).toContain('a.safetensors')
    expect(fields[0].options).toContain('old.safetensors')
  })

  it('caps the field count (boundary)', () => {
    const big = {}
    for (let i = 0; i < 30; i++) {
      big[String(i)] = { class_type: 'CLIPTextEncode', inputs: { text: `t${i}` } }
    }
    expect(deriveFields(big, {}, [], { maxFields: 5 })).toHaveLength(5)
  })
})

describe('seed policy', () => {
  it('randomizeSeeds rerolls only seed fields', () => {
    const fields = deriveFields(SAMPLE_GRAPH, NODE_INFOS, [])
    const seeded = randomizeSeeds(fields, () => 0.5)
    const seedField = seeded.find((field) => field.kind === 'seed')
    expect(seedField.value).toBe(Math.floor(0.5 * 4294967296))
    const steps = seeded.find((field) => field.id === '3.steps')
    expect(steps.value).toBe(20)
  })

  it('buildQuestions offers use/reroll for seeds and keeps prompts preset', () => {
    const fields = deriveFields(SAMPLE_GRAPH, NODE_INFOS, [])
    const { questions, prepared } = buildQuestions(fields, () => 0.25)
    const seedQuestion = questions.find((entry) => entry.id === 'field:3.seed')
    expect(seedQuestion.options.map((entry) => entry.label)[0]).toContain('使用随机种子')
    expect(seedQuestion.options[1].label).toBe('重新随机')
    const textQuestion = questions.find((entry) => entry.id === 'field:6.text')
    expect(textQuestion.question).toContain('a girl in the rain')
    expect(prepared.find((field) => field.kind === 'seed').value).toBe(Math.floor(0.25 * 4294967296))
  })

  it('resolveAnswer handles keep/reroll/custom', () => {
    const field = { kind: 'seed', value: 111, min: undefined, max: undefined, label: 'Seed' }
    expect(resolveAnswer(field, { id: 'x', selected: ['使用随机种子 111'] })).toBe(111)
    expect(resolveAnswer(field, { id: 'x', selected: ['重新随机'] }, () => 0.5)).toBe(Math.floor(0.5 * 4294967296))
    expect(resolveAnswer(field, { id: 'x', selected: [], custom: ' 777 ' })).toBe(777)
    expect(() => resolveAnswer(field, { id: 'x', selected: [], custom: 'abc' })).toThrow(FormError)
    expect(() => resolveAnswer(field, { id: 'x', selected: [], custom: '-1' })).toThrow(/种子/)
  })

  it('numbers honor bounds', () => {
    const field = { kind: 'number', value: 20, min: 1, max: 100, label: 'Steps' }
    expect(resolveAnswer(field, { id: 'x', selected: [], custom: '30' })).toBe(30)
    expect(resolveAnswer(field, { id: 'x', selected: ['使用当前值 20'] })).toBeUndefined()
    expect(() => resolveAnswer(field, { id: 'x', selected: [], custom: '999' })).toThrow(/最大/)
  })
})

describe('applyAnswers', () => {
  it('writes answers into the graph and keeps unanswered fields', () => {
    const graph = JSON.parse(JSON.stringify(SAMPLE_GRAPH))
    const fields = deriveFields(graph, NODE_INFOS, [])
    const seeded = randomizeSeeds(fields, () => 0.5)
    const answers = [
      { id: 'field:6.text', selected: [], custom: 'new prompt' },
      { id: 'field:3.seed', selected: ['重新随机'] },
      { id: 'field:3.steps', selected: ['使用当前值 20'] },
    ]
    const result = applyAnswers(graph, seeded, answers, () => 0.5)
    expect(result.graph['6'].inputs.text).toBe('new prompt')
    expect(result.graph['3'].inputs.seed).toBe(Math.floor(0.5 * 4294967296))
    expect(result.applied).toBe(2)
    expect(result.kept).toContain('3.steps')
    expect(result.graph['3'].inputs.steps).toBe(20)
  })

  it('throws for unknown nodes (error path)', () => {
    const fields = [{ id: '99.text', nodeId: '99', field: 'text', kind: 'text', value: 'x', label: 'X' }]
    expect(() => applyAnswers({ '1': { class_type: 'A', inputs: {} } }, fields, [{ id: 'field:99.text', selected: [], custom: 'y' }])).toThrow(/99/)
  })
})

describe('integrateUnloadNode', () => {
  it('splices UnloadAllModels into the save chain (upstream -> value -> original input)', () => {
    const graph = JSON.parse(JSON.stringify(SAMPLE_GRAPH))
    const result = integrateUnloadNode(graph, { enabled: true })
    expect(result.inserted).toBe(true)
    const unloadId = result.nodeId
    expect(graph[unloadId].class_type).toBe('UnloadAllModels')
    // 9.SaveImage.images now consumes the unload node
    expect(graph['9'].inputs.images[0]).toBe(unloadId)
    // the unload node's value carries the original link
    expect(graph[unloadId].inputs.value).toEqual(['8', 0])
  })

  it('is a no-op when disabled or when the graph has no links', () => {
    expect(integrateUnloadNode(SAMPLE_GRAPH, { enabled: false }).inserted).toBe(false)
    const linkless = { '1': { class_type: 'A', inputs: { x: 1 } } }
    const result = integrateUnloadNode(linkless, { enabled: true })
    expect(result.inserted).toBe(false)
    expect(result.reason).toBe('no upstream link found')
  })

  it('reuses an unload node the workflow already carries (no duplicate)', () => {
    const graph = JSON.parse(JSON.stringify(SAMPLE_GRAPH))
    graph['94'] = { class_type: 'UnloadAllModels', inputs: { value: ['8', 0] } }
    const result = integrateUnloadNode(graph, { enabled: true })
    expect(result.inserted).toBe(false)
    expect(result.reason).toBe('already present')
    expect(result.nodeId).toBe('94')
    expect(unloadNodeIds(graph).length).toBe(1)
  })
})

describe('stripUnloadNodes（开关关闭时必须真的不卸载）', () => {
  it('removes workflow-provided unload nodes and their references', () => {
    const graph = JSON.parse(JSON.stringify(SAMPLE_GRAPH))
    graph['94'] = { class_type: 'UnloadAllModels', inputs: { value: ['8', 0] } }
    graph['9'].inputs.images = ['94', 0] // 极端情况：输出被接到卸载节点
    const result = stripUnloadNodes(graph)
    expect(result.removed).toEqual(['94'])
    expect(graph['94']).toBeUndefined()
    expect(graph['9'].inputs.images).toBeUndefined()
    expect(unloadNodeIds(graph)).toEqual([])
  })

  it('is a no-op when the workflow has no unload node (boundary)', () => {
    const graph = JSON.parse(JSON.stringify(SAMPLE_GRAPH))
    const result = stripUnloadNodes(graph)
    expect(result.removed).toEqual([])
    expect(Object.keys(graph).length).toBe(Object.keys(SAMPLE_GRAPH).length)
  })
})

describe('graph helpers', () => {
  it('extracts the first prompt and seed', () => {
    expect(firstPromptText(SAMPLE_GRAPH)).toBe('a girl in the rain')
    expect(firstSeed(SAMPLE_GRAPH)).toBe(42)
    expect(firstSeed({ '1': { class_type: 'A', inputs: {} } })).toBeNull()
  })

  it('splits positive/negative prompts with assignable field keys', () => {
    const prompts = extractPrompts(SAMPLE_GRAPH)
    expect(prompts.positive).toBe('a girl in the rain')
    expect(prompts.negative).toBe('blurry')
    expect(prompts.positiveField).toBe('6:text')
    expect(prompts.negativeField).toBe('7:text')
    expect(prompts.others).toEqual([])
  })

  it('falls back to text order when sampler links are absent (boundary)', () => {
    const graph = {
      '1': { class_type: 'CLIPTextEncode', inputs: { text: 'first' } },
      '2': { class_type: 'CLIPTextEncode', inputs: { text: 'second' } },
      '3': { class_type: 'CLIPTextEncode', inputs: { text: 'third' } },
    }
    const prompts = extractPrompts(graph)
    expect(prompts.positive).toBe('first')
    expect(prompts.negative).toBe('second')
    expect(prompts.others.map((entry) => entry.text)).toEqual(['third'])
    expect(extractPrompts({ '1': { class_type: 'KSampler', inputs: { seed: 1 } } })).toMatchObject({ positive: '', negative: '' })
  })
})

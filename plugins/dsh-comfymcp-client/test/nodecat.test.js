import { describe, expect, it } from 'vitest'
import { normalizeNodeCatalog, resolveNodeInfo } from '../lib/nodecat.js'

/** 形状 1：内嵌链路实证（scripts/probe-node-info.mjs 抓取的精简样本）。 */
const LIVE_SHAPED = {
  nodes: {
    KSampler: {
      classType: 'KSampler',
      displayName: 'KSampler',
      category: 'model/sampling',
      inputs: [
        { name: 'model', group: 'required', type: 'MODEL', required: true },
        { name: 'seed', group: 'required', type: 'INT', required: true, default: 0, min: 0, max: 18446744073709552000 },
        { name: 'cfg', group: 'required', type: 'FLOAT', required: true, default: 8, min: 0, max: 100, step: 0.1 },
        { name: 'sampler_name', group: 'required', type: 'COMBO', required: true, options: ['euler', 'res_multistep', 'heun'] },
        { name: 'denoise', group: 'required', type: 'FLOAT', required: true, default: 1 },
      ],
    },
    CLIPTextEncode: {
      classType: 'CLIPTextEncode',
      inputs: [{ name: 'text', group: 'required', type: 'STRING', required: true }],
    },
  },
  missing: [],
}

describe('normalizeNodeCatalog', () => {
  it('adapts the live embedded shape (COMBO + options, link types kept)', () => {
    const catalog = normalizeNodeCatalog(LIVE_SHAPED)
    const sampler = resolveNodeInfo(catalog, 'KSampler')
    expect(sampler.classType).toBe('KSampler')
    const combo = sampler.inputs.find((input) => input.name === 'sampler_name')
    expect(combo).toMatchObject({ type: 'COMBO', options: ['euler', 'res_multistep', 'heun'], required: true })
    expect(sampler.inputs.find((input) => input.name === 'seed').max).toBe(18446744073709552000)
    expect(sampler.inputs).toHaveLength(5)
  })

  it('adapts the legacy array-type enum shape', () => {
    const catalog = normalizeNodeCatalog({
      nodes: { Old: { class_type: 'Old', inputs: [{ name: 'mode', type: ['a', 'b'], required: false, default: 'a' }] } },
    })
    expect(resolveNodeInfo(catalog, 'Old').inputs[0]).toMatchObject({ type: 'COMBO', options: ['a', 'b'], default: 'a' })
  })

  it('adapts the official object_info shape (required/optional maps, tuple specs)', () => {
    const catalog = normalizeNodeCatalog({
      OfficialNode: {
        input: {
          required: {
            image: ['IMAGE'],
            size: ['INT', { default: 512, min: 64, max: 2048, step: 8 }],
            mode: [['fast', 'slow'], { default: 'fast' }],
          },
          optional: {
            mask: ['MASK'],
          },
        },
        input_order: { required: ['image', 'size', 'mode'] },
        output: ['IMAGE'],
        output_name: ['IMAGE'],
      },
    })
    const entry = resolveNodeInfo(catalog, 'OfficialNode')
    const byName = Object.fromEntries(entry.inputs.map((input) => [input.name, input]))
    expect(byName.image).toMatchObject({ type: 'IMAGE', required: true, group: 'required' })
    expect(byName.size).toMatchObject({ type: 'INT', default: 512, min: 64, max: 2048, step: 8 })
    expect(byName.mode).toMatchObject({ type: 'COMBO', options: ['fast', 'slow'], default: 'fast' })
    expect(byName.mask).toMatchObject({ type: 'MASK', required: false, group: 'optional' })
  })

  it('adapts the paged rows shape with snake/camel class keys (boundary)', () => {
    const catalog = normalizeNodeCatalog({
      rows: [
        { classType: 'UnloadAllModels', inputs: [{ name: 'value', type: '*', required: true }] },
        { class_type: 'SnakeNode', classType: 'SnakeNode', inputs: [] },
      ],
    })
    expect(resolveNodeInfo(catalog, 'UnloadAllModels').classType).toBe('UnloadAllModels')
    expect(resolveNodeInfo(catalog, 'SnakeNode')).not.toBeNull()
  })

  it('degrades to an empty catalog on unknown/garbage payloads (boundary)', () => {
    expect(normalizeNodeCatalog({ error: 'backend exited' })).toEqual({})
    expect(normalizeNodeCatalog(null)).toEqual({})
    expect(normalizeNodeCatalog('nope')).toEqual({})
    expect(resolveNodeInfo({}, 'X')).toBeNull()
    // 大小写兜底
    expect(resolveNodeInfo(normalizeNodeCatalog(LIVE_SHAPED), 'ksampler').classType).toBe('KSampler')
  })
})

import { describe, expect, it } from 'vitest'
import { apiGraphFromUi, hasSubgraphs, isApiGraph, isUiWorkflow } from '../lib/wfgraph.js'

const SUBGRAPH_ID = 'cb63cc72-d82e-4c9b-988d-6807f538d6ab'

/** ComfyUI UI 格式夹具：结构对齐实机 image_z_image.json / video_wan2_2_14B_t2v.json。 */
const UI_GRAPH = {
  revision: 0,
  nodes: [
    {
      id: 128,
      type: SUBGRAPH_ID,
      mode: 0,
      widgets_values: ['花园里的小猫', 640, 480],
      inputs: [
        { name: 'text', link: null, widget: { name: 'text' } },
        { name: 'width', link: null, widget: { name: 'width' } },
        { name: 'steps', link: 231 },
      ],
      outputs: [{ name: 'VIDEO', type: 'VIDEO', links: [301] }],
    },
    {
      id: 200,
      type: 'SaveVideo',
      mode: 0,
      widgets_values: ['wan_out'],
      inputs: [
        { name: 'video', type: 'VIDEO', link: 301 },
        { name: 'filename_prefix', type: 'STRING', widget: { name: 'filename_prefix' }, link: null },
      ],
    },
    { id: 35, type: 'MarkdownNote', mode: 0, inputs: [], widgets_values: ['## 说明'] },
    {
      id: 9,
      type: 'KSampler',
      mode: 0,
      // 前端在 seed 后插入隐藏控件 "randomize"
      widgets_values: [942500763821827, 'randomize', 30, 4, 'res_multistep', 'simple', 1],
      inputs: [
        { name: 'seed', type: 'INT', widget: { name: 'seed' }, link: null },
        { name: 'steps', type: 'INT', widget: { name: 'steps' }, link: null },
        { name: 'cfg', type: 'FLOAT', widget: { name: 'cfg' }, link: null },
        { name: 'sampler_name', type: 'COMBO', widget: { name: 'sampler_name' }, link: null },
      ],
    },
  ],
  links: [[231, 9, 0, 128, 2, 'INT'], [301, 128, 0, 200, 0, 'VIDEO']],
  definitions: {
    subgraphs: [
      {
        id: SUBGRAPH_ID,
        name: 'wan 生成',
        inputNode: { id: -10 },
        outputNode: { id: -20 },
        inputs: [
          { name: 'text', type: 'STRING', linkIds: [508] },
          { name: 'width', type: 'INT', linkIds: [510] },
          { name: 'steps', type: 'INT', linkIds: [512] },
        ],
        outputs: [{ name: 'VIDEO', type: 'VIDEO', linkIds: [579] }],
        widgets: [],
        nodes: [
          {
            id: 66,
            type: 'CLIPLoader',
            mode: 0,
            widgets_values: ['qwen_3_4b.safetensors', 'lumina2'],
            inputs: [
              { name: 'clip_name', type: 'COMBO', widget: { name: 'clip_name' }, link: null },
              { name: 'type', type: 'COMBO', widget: { name: 'type' }, link: null },
            ],
          },
          {
            id: 127,
            type: 'CLIPTextEncode',
            mode: 0,
            widgets_values: [''],
            inputs: [
              { name: 'text', type: 'STRING', widget: { name: 'text' }, link: 508 },
              { name: 'clip', type: 'CLIP', link: 209 },
            ],
          },
          {
            id: 348,
            type: 'ComfyMathExpression',
            mode: 0,
            widgets_values: ['floor(a * b) + 1'],
            inputs: [
              { name: 'values.a', type: 'FLOAT,INT', link: 210 },
              { name: 'values.b', type: 'FLOAT,INT', link: 510 },
              { name: 'expression', type: 'STRING', widget: { name: 'expression' }, link: null },
            ],
          },
          {
            id: 269,
            type: 'KSampler',
            mode: 0,
            widgets_values: [7, 'randomize', 20, 8, 'euler'],
            inputs: [
              { name: 'seed', type: 'INT', widget: { name: 'seed' }, link: null },
              { name: 'steps', type: 'INT', widget: { name: 'steps' }, link: 512 },
            ],
          },
          { id: 87, type: 'MarkdownNote', mode: 0, inputs: [], widgets_values: ['- Steps: 30~50'] },
        ],
        links: [
          { id: 209, origin_id: 66, origin_slot: 0, target_id: 127, target_slot: 1, type: 'CLIP' },
          { id: 210, origin_id: 66, origin_slot: 0, target_id: 348, target_slot: 0, type: 'FLOAT,INT' },
          { id: 508, origin_id: -10, origin_slot: 0, target_id: 127, target_slot: 0, type: 'STRING' },
          { id: 510, origin_id: -10, origin_slot: 1, target_id: 348, target_slot: 1, type: 'INT' },
          { id: 512, origin_id: -10, origin_slot: 2, target_id: 269, target_slot: 1, type: 'INT' },
          { id: 579, origin_id: 269, origin_slot: 0, target_id: -20, target_slot: 0, type: 'VIDEO' },
        ],
      },
    ],
  },
}

describe('wfgraph format adaptation', () => {
  it('detects UI vs API formats and subgraphs', () => {
    expect(isUiWorkflow(UI_GRAPH)).toBe(true)
    expect(isApiGraph({ '3': { class_type: 'KSampler', inputs: {} } })).toBe(true)
    expect(isApiGraph(UI_GRAPH)).toBe(false)
    expect(isUiWorkflow({ '3': { class_type: 'KSampler', inputs: {} } })).toBe(false)
    expect(hasSubgraphs(UI_GRAPH)).toBe(true)
    expect(hasSubgraphs({ nodes: [] })).toBe(false)
  })

  it('flattens inline subgraphs and rewires promoted inputs and outputs', () => {
    const { graph, subgraphs, skipped } = apiGraphFromUi(UI_GRAPH)
    expect(subgraphs).toBe(1)
    // 内部节点带外层前缀
    expect(graph['128:127'].class_type).toBe('CLIPTextEncode')
    expect(graph['128:269'].class_type).toBe('KSampler')
    expect(graph['200'].class_type).toBe('SaveVideo')
    // 子图输出重映射：SaveVideo.video → 内部产出节点
    expect(graph['200'].inputs.video).toEqual(['128:269', 0])
    // promoted 输入：外节点 widget 值 → 内部节点输入
    expect(graph['128:127'].inputs.text).toBe('花园里的小猫')
    expect(graph['128:269'].inputs.steps).toEqual(['9', 0]) // 外节点 steps 走链路
    expect(graph['128:348'].inputs['values']).toEqual({ a: ['128:66', 0], b: 640 }) // 含点号虚拟输入折叠为对象；b 取 promoted width
    // 内部 widget：隐藏控件位剔除后对齐
    expect(graph['128:269'].inputs.seed).toBe(7)
    expect(graph['128:348'].inputs.expression).toBe('floor(a * b) + 1')
    // 笔记节点被跳过，且不再作为 unsupported 报出
    expect(skipped.some((entry) => entry.includes('MarkdownNote'))).toBe(true)
    expect(graph['128:87']).toBeUndefined()
  })

  it('keeps top-level widgets aligned and drops unknown link targets (boundary)', () => {
    const { graph } = apiGraphFromUi(UI_GRAPH)
    expect(graph['9'].inputs.seed).toBe(942500763821827)
    expect(graph['9'].inputs.steps).toBe(30)
    expect(graph['9'].inputs.sampler_name).toBe('res_multistep')
    const orphan = apiGraphFromUi({ nodes: [{ id: 1, type: 'KSampler', inputs: [{ name: 'model', link: 9 }] }], links: [[9, 999, 0, 1, 0, 'MODEL']] })
    expect(orphan.graph['1'].inputs.model).toBeUndefined()
  })

  it('passes API graphs through unchanged and rejects garbage (boundary)', () => {
    const api = { '3': { class_type: 'KSampler', inputs: { seed: 1 } } }
    const result = apiGraphFromUi(api)
    expect(result).toMatchObject({ converted: false, subgraphs: 0, skipped: [] })
    expect(result.graph).toBe(api)
    expect(apiGraphFromUi({ hello: 'world' }).graph).toBeNull()
    expect(apiGraphFromUi(null).graph).toBeNull()
  })
})

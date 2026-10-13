import { describe, expect, it } from 'vitest'
import { haystackOf, matchRun, parseConditions } from '../lib/artifactsearch.js'

const TAG_RECORDS = {
  k1: { tags: ['夕阳', '旅拍'], collections: ['海边'], fields: { 尺寸: '768x512', 模型: 'z-image' }, prompt: '沙滩情侣', source: '项目A' },
  k2: { tags: ['夜景'], collections: [], fields: { 尺寸: '1024x1024' }, prompt: '', source: '' },
}

const RUN = {
  id: 'r1',
  name: 'image_z_image',
  state: 'completed',
  seed: 2000230530,
  prompts: { positive: 'A fashion photography work with sunset beach', negative: 'blurry, low quality' },
  params: [
    { node: '57:3', field: 'steps', value: '25' },
    { node: '57:3', field: 'cfg', value: '4' },
    { node: '57:3', field: 'sampler_name', value: 'res_multistep' },
    { node: '57:4', field: 'text', value: 'A fashion photography work with sunset beach' },
  ],
  localFiles: [
    { path: 'F:\\out\\a.png', filename: 'a.png', kind: 'image', key: 'k1' },
    { path: 'F:\\out\\b.png', filename: 'b.png', kind: 'image', key: 'k2' },
  ],
}

describe('parseConditions', () => {
  it('parses field=value / field!=value lists (boundary: empty)', () => {
    expect(parseConditions('steps=25, cfg=4')).toEqual([
      { field: 'steps', op: '=', value: '25' },
      { field: 'cfg', op: '=', value: '4' },
    ])
    expect(parseConditions('sampler_name!=euler')).toEqual([{ field: 'sampler_name', op: '!=', value: 'euler' }])
    expect(parseConditions('尺寸')).toEqual([{ field: '尺寸', op: '~', value: '' }])
    expect(parseConditions('')).toEqual([])
    expect(parseConditions(null)).toEqual([])
  })
})

describe('matchRun', () => {
  it('fuzzy-matches prompts, params, tags and file names', () => {
    expect(matchRun(RUN, { text: 'sunset beach' }, TAG_RECORDS).matched).toBe(true)
    expect(matchRun(RUN, { text: 'low quality' }, TAG_RECORDS).matched).toBe(true) // 负向提示词也参与
    expect(matchRun(RUN, { text: 'a.png' }, TAG_RECORDS).matched).toBe(true)
    expect(matchRun(RUN, { text: '夕阳' }, TAG_RECORDS).matched).toBe(true) // 标签
    expect(matchRun(RUN, { text: 'res_multistep' }, TAG_RECORDS).matched).toBe(true) // 参数值
    expect(matchRun(RUN, { text: '不存在的词' }, TAG_RECORDS).matched).toBe(false)
    // 命中来源可解释
    expect(matchRun(RUN, { text: '夕阳' }, TAG_RECORDS).hits[0]).toContain('模糊:夕阳')
  })

  it('matches tag and param conditions, honouring AND/OR', () => {
    expect(matchRun(RUN, { tagText: '夕阳' }, TAG_RECORDS).matched).toBe(true)
    expect(matchRun(RUN, { tagText: '夜景' }, TAG_RECORDS).matched).toBe(true) // 第二件文件带夜景
    expect(matchRun(RUN, { tagText: '夕阳,夜景' }, TAG_RECORDS).matched).toBe(true)
    expect(matchRun(RUN, { tagText: '夕阳,不存在' }, TAG_RECORDS).matched).toBe(false)
    expect(matchRun(RUN, { tagText: '夕阳,不存在', mode: 'or' }, TAG_RECORDS).matched).toBe(true)
    // 标签 + 参数：AND 需同时满足
    expect(matchRun(RUN, { tagText: '夕阳', paramText: 'steps=25' }, TAG_RECORDS).matched).toBe(true)
    expect(matchRun(RUN, { tagText: '夕阳', paramText: 'steps=99' }, TAG_RECORDS).matched).toBe(false)
    expect(matchRun(RUN, { tagText: '夕阳', paramText: 'steps=99', mode: 'or' }, TAG_RECORDS).matched).toBe(true)
    // 参数不等于
    expect(matchRun(RUN, { paramText: 'sampler_name!=euler' }, TAG_RECORDS).matched).toBe(true)
    expect(matchRun(RUN, { paramText: 'sampler_name!=res_multistep' }, TAG_RECORDS).matched).toBe(false)
  })

  it('matches dynamic field conditions and no-criteria passes (boundary)', () => {
    expect(matchRun(RUN, { fieldText: '尺寸=768' }, TAG_RECORDS).matched).toBe(true)
    expect(matchRun(RUN, { fieldText: '模型=z-image' }, TAG_RECORDS).matched).toBe(true)
    expect(matchRun(RUN, { fieldText: '模型=sd15' }, TAG_RECORDS).matched).toBe(false)
    expect(matchRun(RUN, {}, TAG_RECORDS)).toEqual({ matched: true, hits: [] })
    expect(haystackOf(RUN, TAG_RECORDS)).toContain('sunset beach')
    expect(haystackOf(RUN, TAG_RECORDS)).toContain('768x512')
  })
})

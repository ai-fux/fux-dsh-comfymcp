import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BUSINESS_KINDS,
  businessKind,
  businessLabel,
  createBusinessStore,
  extractBusinessParams,
  inferBusiness,
  matchBusiness,
} from '../lib/business.js'

const graphs = {
  text2img: {
    '1': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat' } },
    '2': { class_type: 'KSampler', inputs: { seed: 1, steps: 8, width: 1024, height: 1024, cfg: 4, sampler_name: 'euler' } },
    '3': { class_type: 'SaveImage', inputs: { filename_prefix: 'cat' } },
  },
  image2img: {
    '1': { class_type: 'LoadImage', inputs: { image: 'in.png' } },
    '2': { class_type: 'KSampler', inputs: {} },
    '3': { class_type: 'SaveImage', inputs: {} },
  },
  text2video: {
    '1': { class_type: 'CLIPTextEncode', inputs: {} },
    '2': { class_type: 'WanVideoSampler', inputs: {} },
    '3': { class_type: 'SaveVideo', inputs: {} },
  },
  image2video: {
    '1': { class_type: 'LoadImage', inputs: {} },
    '2': { class_type: 'SVD_img2vid_Conditioning', inputs: {} },
    '3': { class_type: 'VHS_VideoCombine', inputs: {} },
  },
  upscale: {
    '1': { class_type: 'LoadImage', inputs: {} },
    '2': { class_type: 'UpscaleModelLoader', inputs: {} },
    '3': { class_type: 'ImageUpscaleWithModel', inputs: {} },
    '4': { class_type: 'SaveImage', inputs: {} },
  },
  edit: {
    '1': { class_type: 'LoadImage', inputs: {} },
    '2': { class_type: 'VAEEncodeForInpaint', inputs: {} },
    '3': { class_type: 'SaveImage', inputs: {} },
  },
  audio: {
    '1': { class_type: 'AceStepSampler', inputs: {} },
    '2': { class_type: 'SaveAudio', inputs: {} },
  },
}

const temps = []
function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'comfymcp-biz-'))
  temps.push(dir)
  return { dir, store: createBusinessStore({ dataDir: dir }) }
}
afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop()
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 清理失败不影响断言
    }
  }
})

describe('inferBusiness', () => {
  it('按输出/输入模态判定业务类（含边界：非图节点与空图）', () => {
    expect(inferBusiness(graphs.text2img)).toBe('text2img')
    expect(inferBusiness(graphs.image2img)).toBe('image2img')
    expect(inferBusiness(graphs.text2video)).toBe('text2video')
    expect(inferBusiness(graphs.image2video)).toBe('image2video')
    expect(inferBusiness(graphs.upscale)).toBe('upscale')
    expect(inferBusiness(graphs.edit)).toBe('edit')
    expect(inferBusiness(graphs.audio)).toBe('audio')
    expect(inferBusiness({})).toBe('other')
    expect(inferBusiness(null)).toBe('other')
    // UI 格式 nodes 数组同样能判
    expect(inferBusiness({ nodes: [{ type: 'LoadImage' }, { type: 'KSampler' }, { type: 'SaveImage' }] })).toBe('image2img')
  })

  it('摘取默认参数：只拿找到的标量，不猜（模型字段映射到 model）', () => {
    const params = extractBusinessParams(graphs.text2img)
    expect(params).toMatchObject({ steps: 8, width: 1024, height: 1024, cfg: 4, sampler_name: 'euler' })
    expect(extractBusinessParams({})).toEqual({})
    const withModel = { '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'z-image-turbo.safetensors' } } }
    expect(extractBusinessParams(withModel).model).toBe('z-image-turbo.safetensors')
  })
})

describe('matchBusiness', () => {
  const profiles = BUSINESS_KINDS.filter((kind) => kind.id !== 'other').map((kind) => ({
    id: kind.id,
    business: kind.id,
    label: kind.label,
    keywords: kind.keywords.slice(0, 4),
    workflow: `wf-${kind.id}`,
  }))

  it('自然语言命中对应业务类（含中文插入字与模态提示）', () => {
    expect(matchBusiness('帮我画一只猫', profiles)?.profile.business).toBe('text2img')
    expect(matchBusiness('做个视频', profiles)?.profile.business).toBe('text2video')
    expect(matchBusiness('让这张图动起来', profiles)?.profile.business).toBe('image2video')
    expect(matchBusiness('把这张照片放大成高清', profiles)?.profile.business).toBe('upscale')
    expect(matchBusiness('抹掉照片里的路人', profiles)?.profile.business).toBe('edit')
    expect(matchBusiness('生成一段背景音乐', profiles)?.profile.business).toBe('audio')
    expect(matchBusiness('把这张图换个风格', profiles)?.profile.business).toBe('image2img')
  })

  it('无关句子不硬匹配；自定义触发词优先于预置词', () => {
    expect(matchBusiness('今天天气不错', profiles)).toBeNull()
    expect(matchBusiness('', profiles)).toBeNull()
    const custom = [
      { id: 'text2img', business: 'text2img', label: '文生图', keywords: ['出图'], workflow: 'a' },
      { id: 'image2img', business: 'image2img', label: '图生图', keywords: ['机甲海报'], workflow: 'b' },
    ]
    const hit = matchBusiness('来一张机甲海报', custom)
    expect(hit?.profile.id).toBe('image2img')
    expect(hit?.hits).toContain('机甲海报')
  })
})

describe('createBusinessStore', () => {
  it('保存 / 匹配 / 记使用 / 删除，并落盘 business.json', () => {
    const { dir, store } = tempStore()
    expect(store.all()).toEqual([])
    const saved = store.save({ id: 'text2img', business: 'text2img', workflow: 'z-image-turbo', params: { steps: 8 } })
    expect(saved.label).toBe('文生图') // 缺省名取业务类名
    expect(saved.keywords.length).toBeGreaterThan(0) // 缺省触发词取预置词
    expect(existsSync(join(dir, 'business.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, 'business.json'), 'utf8')).version).toBe(1)

    const hit = store.match('帮我画一张图')
    expect(hit?.profile.workflow).toBe('z-image-turbo')
    const touched = store.touch('text2img')
    expect(touched.uses).toBe(1)
    expect(touched.lastUsedAt).not.toBeNull()

    expect(store.save({ id: 'text2img', workflow: 'z-image-turbo-2' }).workflow).toBe('z-image-turbo-2')
    expect(store.all().length).toBe(1) // 同 id 合并
    expect(store.remove('text2img')).toBe(true)
    expect(store.all()).toEqual([])
    expect(store.remove('nope')).toBe(false)
  })

  it('自动登记：首个跑过的按业务类建档，之后同业务类只记候选不抢占', () => {
    const { store } = tempStore()
    const first = store.autoRegister({ workflow: 'z-image-turbo', graph: graphs.text2img, source: 'library' })
    expect(first).toMatchObject({ business: 'text2img', workflow: 'z-image-turbo', auto: true, uses: 1 })
    expect(first.params.steps).toBe(8)

    const second = store.autoRegister({ workflow: 'flux-schnell', graph: graphs.text2img })
    expect(second.workflow).toBe('z-image-turbo') // 主配置不被抢
    expect(second.candidates.map((entry) => entry.workflow)).toContain('flux-schnell')
    expect(store.all().length).toBe(1)

    // 另一个业务类各建各的
    store.autoRegister({ workflow: 'svd', graph: graphs.image2video })
    expect(store.all().map((profile) => profile.id).sort()).toEqual(['image2video', 'text2img'])
    // 同一个工作流再跑一次 → 记使用次数
    expect(store.autoRegister({ workflow: 'z-image-turbo', graph: graphs.text2img }).uses).toBe(2)
    // 没工作流名不建档
    expect(store.autoRegister({ workflow: '' })).toBeNull()
  })

  it('辅助函数：业务类名与 id 映射（未知 id 原样返回）', () => {
    expect(businessKind('text2img')?.label).toBe('文生图')
    expect(businessKind('nope')).toBeNull()
    expect(businessLabel('image2video')).toBe('图生视频')
    expect(businessLabel('custom-x')).toBe('custom-x')
  })
})

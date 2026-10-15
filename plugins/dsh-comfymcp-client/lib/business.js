/**
 * 业务配置（首次生成的工作流选择优化）。
 *
 * 目的：把「跑过 / 加载过」的工作流按**业务类**沉淀成配置，后续新会话用自然语言直接命中，
 * 不再每次去服务端捞模板、枚举模型挑最优解（省 token、少绕路）。
 *
 * 存储：<dataDir>/business.json
 *   { version: 1,
 *     kinds:    [{ id, label, keywords[] }],       ← 业务类本身也落盘，可动态增删（不写死）
 *     profiles: [{ id, business, label, workflow, source, params, keywords, notes,
 *                  auto, uses, lastUsedAt, updatedAt, candidates[] }] }
 * 约定：
 *   - 一个业务类只保留一条**主配置**（profile.workflow 即首选工作流）；
 *     同一个业务类跑过的其它工作流进 candidates，供工作台一键切换。
 *   - auto=true 表示由运行/加载自动登记（用户可在工作台改成手动或删除）。
 *   - kinds 首次读取用内置预置类播种，之后以文件为准（可加「换脸」「商品图」「3D」等自定义类）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 内置预置业务类（首次播种；之后以 business.json 的 kinds 为准，可自由增删）。 */
export const DEFAULT_BUSINESS_KINDS = [
  {
    id: 'text2img',
    label: '文生图',
    keywords: ['文生图', '画', '画一张', '画个', '图片', '生成图片', '出图', '作图', '帮我画', 'text to image', 't2i'],
  },
  {
    id: 'image2img',
    label: '图生图',
    keywords: ['图生图', '改图', '重绘', '参考图', '垫图', '换风格', 'image to image', 'i2i'],
  },
  {
    id: 'text2video',
    label: '文生视频',
    keywords: ['文生视频', '生成视频', '做视频', '视频', '短片', '动画', 'text to video', 't2v'],
  },
  {
    id: 'image2video',
    label: '图生视频',
    keywords: ['图生视频', '让图动', '动起来', '图片转视频', 'image to video', 'i2v'],
  },
  {
    id: 'edit',
    label: '局部重绘 / 编辑',
    keywords: ['局部重绘', '重绘', '编辑', '修图', '换背景', '抹掉', 'inpaint', 'inpainting'],
  },
  {
    id: 'upscale',
    label: '放大 / 高清',
    keywords: ['放大', '高清', '超分', '增强清晰度', 'upscale', 'hires'],
  },
  {
    id: 'audio',
    label: '音频',
    keywords: ['音频', '配音', '音乐', '语音', '生成音乐', 'audio', 'tts', 'music'],
  },
  { id: 'other', label: '其它', keywords: [] },
]

/** 兼容旧名（预置业务类的种子值）。 */
export const BUSINESS_KINDS = DEFAULT_BUSINESS_KINDS

/** 业务类 id 规整：小写，空格与中文标点折成连字符（自定义类沿用同一套 id）。 */
export function normalizeKindId(raw) {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replaceAll(/[\s·/、，,]+/g, '-')
    .replaceAll(/[^\w\u4e00-\u9fa5-]/g, '')
    .replaceAll(/-+/g, '-')
    .replaceAll(/^-|-$/g, '')
}

/** 在给定业务类清单里按 id 查（清单可以是存储里的动态 kinds）。 */
export function kindOf(kinds, id) {
  return (Array.isArray(kinds) ? kinds : []).find((kind) => kind.id === String(id ?? '')) ?? null
}

export function businessKind(id, kinds = DEFAULT_BUSINESS_KINDS) {
  return kindOf(kinds, id)
}

export function businessLabel(id, kinds = DEFAULT_BUSINESS_KINDS) {
  const kind = kindOf(kinds, id)
  return kind === null ? String(id ?? '') : kind.label
}

/** 图里出现的所有 class_type（兼容对象图与 UI 格式 nodes 数组）。 */
function classTypes(graph) {
  if (graph === null || typeof graph !== 'object') return []
  const source = Array.isArray(graph.nodes) ? graph.nodes : Object.values(graph)
  return source
    .map((node) => (node !== null && typeof node === 'object' ? String(node.class_type ?? node.type ?? '') : ''))
    .filter((value) => value.length > 0)
}

const VIDEO_OUT = /^(savevideo|savewebm|saveanimatedwebp|vhs_videocombine|videocombine|createvideo|savevid|savegif)$/i
const VIDEO_ANY = /(video|animated|svd|animatediff|mochi|hunyuanvideo|cogvideo|ltx|wanvideo|wan_)/i
const AUDIO_OUT = /^(saveaudio|saveaudioflac|saveaudioopus|previewaudio|saveaudiompeg)$/i
const AUDIO_ANY = /(audio|tts|music|ace_step|stableaudio|vocal|speech)/i
const IMAGE_IN = /^(loadimage|loadimagemask|loadimageoutput|loadimagedirectory|imageload|loadimagefromurl|loadimagebase64)$/i
const VIDEO_IN = /^(loadvideo|vhs_loadvideo|loadvideoupload)$/i
const INPAINT = /(inpaint|setlatentnoisemask|vaeencodeforinpaint|inpaintmodelconditioning)/i
const UPSCALE = /(upscalemodelloader|imageupscalewithmodel|ultimatesdupscale|imagescaleby|imagescaling|upscalemodel)/i
const SAMPLER = /(ksampler|samplercustom|sampler|samplerselect|kSamplerAdvanced|basicguider|fluxguidance)/i

/**
 * 由工作流图推断业务类：先看输出/输入模态，再看特殊处理（重绘/放大）。
 * 返回 BUSINESS_KINDS 的 id。
 */
export function inferBusiness(graph) {
  const types = classTypes(graph)
  if (types.length === 0) return 'other'
  const has = (pattern) => types.some((type) => pattern.test(type))
  const isVideo = has(VIDEO_OUT) || has(VIDEO_ANY)
  const isAudio = has(AUDIO_OUT) || has(AUDIO_ANY)
  if (isVideo) {
    if (has(VIDEO_IN)) return 'image2video'
    return has(IMAGE_IN) ? 'image2video' : 'text2video'
  }
  if (isAudio) return 'audio'
  if (has(INPAINT)) return 'edit'
  if (has(UPSCALE) && !has(SAMPLER)) return 'upscale'
  if (has(IMAGE_IN)) return 'image2img'
  return 'text2img'
}

/** 参数键 → 人类可读名（业务配置页与表单共用同一套说法）。 */
export const BUSINESS_PARAM_LABELS = {
  steps: '采样步数',
  cfg: '提示词强度 CFG',
  width: '宽',
  height: '高',
  batch_size: '生成数',
  denoise: '重绘幅度',
  seed: '随机种子',
  sampler_name: '采样器',
  scheduler: '调度器',
  model: '模型',
  filename_prefix: '文件名前缀',
}

/**
 * 逐个列出图里**实际存在**的可调参数（含当前值），供业务配置页按所选工作流动态渲染参数区。
 * 与 extractBusinessParams 的区别：保留顺序与节点信息，页面用它生成输入框。
 */
export function extractBusinessParamFields(graph) {
  const fields = []
  if (graph === null || typeof graph !== 'object') return fields
  const entries = Array.isArray(graph.nodes)
    ? graph.nodes.map((item, index) => [String(index), item])
    : Object.entries(graph)
  const scalarKeys = ['steps', 'cfg', 'width', 'height', 'batch_size', 'denoise', 'seed', 'sampler_name', 'scheduler', 'filename_prefix']
  const modelKeys = ['ckpt_name', 'unet_name', 'model', 'model_name']
  for (const [nodeId, node] of entries) {
    const inputs = node !== null && typeof node === 'object' ? node.inputs : null
    if (inputs === null || typeof inputs !== 'object') continue
    const classType = String(node.class_type ?? node.type ?? '')
    for (const key of scalarKeys) {
      const value = inputs[key]
      if (value === undefined || value === null || typeof value === 'object') continue
      if (fields.some((field) => field.key === key)) continue
      fields.push({ key, label: BUSINESS_PARAM_LABELS[key] ?? key, value, nodeId, classType })
    }
    if (!fields.some((field) => field.key === 'model')) {
      for (const key of modelKeys) {
        const value = inputs[key]
        if (typeof value !== 'string' || value.length === 0) continue
        fields.push({ key: 'model', label: BUSINESS_PARAM_LABELS.model, value, nodeId, classType })
        break
      }
    }
  }
  const order = ['steps', 'cfg', 'width', 'height', 'batch_size', 'denoise', 'seed', 'sampler_name', 'scheduler', 'model', 'filename_prefix']
  return fields.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
}

/** 从图里摘出可复用的默认参数（找到了才带上，找不到不猜）。 */
export function extractBusinessParams(graph) {
  const params = {}
  for (const field of extractBusinessParamFields(graph)) {
    if (params[field.key] === undefined) params[field.key] = field.value
  }
  return params
}

function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replaceAll(/\s+/g, '')
    .replaceAll(/[，。！？、,.!?"'（）()【】\[\]]/g, '')
}

/** 最长公共子串长度：中文常有多字插入（「做个视频」vs 关键词「做视频」），子串兜底比包含更耐用。 */
function longestCommonRun(a, b) {
  if (a.length === 0 || b.length === 0) return 0
  let best = 0
  const previous = new Array(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i += 1) {
    let last = 0
    for (let j = 1; j <= b.length; j += 1) {
      const keep = previous[j]
      previous[j] = a[i - 1] === b[j - 1] ? last + 1 : 0
      last = keep
      if (previous[j] > best) best = previous[j]
    }
  }
  return best
}

/** 关键词命中得分：完全包含给足分；否则按最长公共子串给部分分（≥2 字，且按覆盖率打折）。 */
function keywordScore(keyword, needle) {
  const key = normalize(keyword)
  if (key.length === 0) return 0
  if (needle.includes(key)) return Math.min(8, key.length)
  const run = longestCommonRun(key, needle)
  if (run < 2) return 0
  // 覆盖率打折：关键词「图生视频」与「做个视频」只共有「视频」，不足以判成图生视频
  return Math.min(4, run) * (run / key.length)
}

/** 文本里的模态提示：提到图/照片 → 偏「图输入」类；否则偏「文输入」类。 */
const IMAGE_HINT = /(图|照片|相片|参考|这张|上面|那只|原图|png|jpg|jpeg|webp)/

/**
 * 自然语言 → 业务配置匹配。
 * 打分：自定义触发词（越长越可信）> 业务类名 > 业务类触发词，再按模态提示微调。返回 { profile, score, hits } 或 null。
 */
export function matchBusiness(text, profiles = [], kinds = DEFAULT_BUSINESS_KINDS) {
  const needle = normalize(text)
  if (needle.length === 0) return null
  const imageHint = IMAGE_HINT.test(needle)
  let best = null
  for (const profile of Array.isArray(profiles) ? profiles : []) {
    if (profile === null || typeof profile !== 'object') continue
    let score = 0
    const hits = []
    for (const keyword of profile.keywords ?? []) {
      const gained = keywordScore(keyword, needle)
      if (gained > 0) {
        score += gained
        hits.push(String(keyword))
      }
    }
    const kind = kindOf(kinds, profile.business)
    const names = [profile.label, kind === null ? '' : kind.label]
    for (const name of names) {
      const gained = keywordScore(name, needle)
      if (gained > 0) {
        score += gained + 2
        hits.push(String(name))
      }
    }
    for (const keyword of kind === null ? [] : (kind.keywords ?? [])) {
      const gained = keywordScore(keyword, needle)
      if (gained > 0) {
        score += gained
        hits.push(String(keyword))
      }
    }
    if (score <= 0) continue
    // 模态微调：文本提到图 → 图输入类加分；没提图 → 文输入类加分
    const imageInput = profile.business === 'image2img' || profile.business === 'image2video' || profile.business === 'edit'
    score += (imageHint === imageInput) ? 2.5 : 0
    if (best === null || score > best.score) {
      best = { profile, score: Math.round(score * 100) / 100, hits: [...new Set(hits)] }
    }
  }
  return best
}

/** 业务配置存储（结构化数据 <dataDir>/business.json：kinds 可动态增删 + profiles）。 */
export function createBusinessStore({ dataDir, now = () => new Date().toISOString() }) {
  const file = join(dataDir ?? '', 'business.json')

  function readFile() {
    try {
      if (typeof dataDir !== 'string' || dataDir.length === 0 || !existsSync(file)) return { kinds: null, profiles: [] }
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      return {
        kinds: Array.isArray(parsed?.kinds) && parsed.kinds.length > 0 ? parsed.kinds : null,
        profiles: Array.isArray(parsed?.profiles) ? parsed.profiles : [],
      }
    } catch {
      return { kinds: null, profiles: [] }
    }
  }

  function load() {
    return readFile().profiles
  }

  /** 业务类清单：文件里有就用文件里的（可动态增删），否则用内置预置类。 */
  function kinds() {
    const stored = readFile().kinds
    if (stored === null) return DEFAULT_BUSINESS_KINDS.map((kind) => ({ ...kind, keywords: [...kind.keywords] }))
    return stored.map((kind) => ({
      id: String(kind?.id ?? '').trim(),
      label: String(kind?.label ?? kind?.id ?? '').trim(),
      keywords: Array.isArray(kind?.keywords) ? kind.keywords.map((item) => String(item ?? '').trim()).filter(Boolean) : [],
    })).filter((kind) => kind.id.length > 0)
  }

  function persist(next) {
    if (typeof dataDir !== 'string' || dataDir.length === 0) return
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(file, `${JSON.stringify({ version: 1, kinds: next.kinds, profiles: next.profiles }, null, 2)}\n`, 'utf8')
  }

  /** 保存业务类清单 + 配置（各自可单独更新，合并写回）。 */
  function saveAll({ kinds: nextKinds, profiles: nextProfiles }) {
    const current = readFile()
    persist({
      kinds: nextKinds ?? current.kinds ?? DEFAULT_BUSINESS_KINDS,
      profiles: nextProfiles ?? current.profiles,
    })
  }

  function cleanList(value) {
    if (Array.isArray(value)) return value.map((item) => String(item ?? '').trim()).filter((item) => item.length > 0)
    if (typeof value === 'string') return value.split(/[,，\n]/).map((item) => item.trim()).filter((item) => item.length > 0)
    return []
  }

  function normalizeProfile(input, previous = null) {
    const business = String(input.business ?? previous?.business ?? 'other').trim() || 'other'
    const workflow = String(input.workflow ?? previous?.workflow ?? '').trim()
    const label = String(input.label ?? previous?.label ?? businessLabel(business, kinds())).trim() || businessLabel(business, kinds())
    const keywords = cleanList(input.keywords ?? previous?.keywords ?? [])
    const fallbackKeywords = kindOf(kinds(), business)?.keywords?.slice(0, 4) ?? []
    return {
      id: String(input.id ?? previous?.id ?? business),
      business,
      label,
      workflow,
      source: String(input.source ?? previous?.source ?? 'saved'),
      params: { ...(previous?.params ?? {}), ...(input.params ?? {}) },
      keywords: keywords.length > 0 ? keywords : fallbackKeywords,
      notes: String(input.notes ?? previous?.notes ?? ''),
      auto: input.auto === undefined ? previous?.auto !== false : input.auto !== false,
      uses: Number(input.uses ?? previous?.uses ?? 0) || 0,
      lastUsedAt: input.lastUsedAt ?? previous?.lastUsedAt ?? null,
      updatedAt: input.updatedAt ?? now(),
      candidates: Array.isArray(input.candidates) ? input.candidates : (previous?.candidates ?? []),
    }
  }

  function upsertCandidate(profile, workflow, source) {
    if (workflow.length === 0 || workflow === profile.workflow) return profile.candidates ?? []
    const candidates = Array.isArray(profile.candidates) ? [...profile.candidates] : []
    const found = candidates.find((entry) => entry.workflow === workflow)
    if (found === undefined) candidates.push({ workflow, source, uses: 1, seenAt: now() })
    else {
      found.uses = (Number(found.uses) || 0) + 1
      found.seenAt = now()
    }
    return candidates.slice(-8)
  }

  return {
    all() {
      return load()
    },
    /** 业务类清单（文件里有就用文件里的，可动态增删）。 */
    kinds,
    get(id) {
      return load().find((profile) => profile.id === String(id ?? '')) ?? null
    },
    /** 自然语言匹配：命中返回 { profile, score, hits }，否则 null（用当前动态业务类打分）。 */
    match(text) {
      return matchBusiness(text, load(), kinds())
    },
    /** 新增或更新一条业务配置（按 id 合并）。 */
    save(input = {}) {
      const profiles = load()
      const id = String(input.id ?? input.business ?? '').trim()
      if (id.length === 0) throw new Error('业务配置需要 id 或 business')
      const index = profiles.findIndex((profile) => profile.id === id)
      const next = normalizeProfile({ ...input, id }, index >= 0 ? profiles[index] : null)
      if (index >= 0) profiles[index] = next
      else profiles.push(next)
      saveAll({ profiles })
      return next
    },
    remove(id) {
      const profiles = load()
      const next = profiles.filter((profile) => profile.id !== String(id ?? ''))
      const removed = next.length !== profiles.length
      if (removed) saveAll({ profiles: next })
      return removed
    },
    /**
     * 业务类增删（动态配置的入口）：
     * - 新增/更新：id 规整后合并，label 缺省取 id；kw 支持数组或逗号串。
     * - 删除：仍被业务配置引用的类拒绝删除（返回 { ok:false, reason }），避免留下孤儿配置。
     */
    saveKind(input = {}) {
      const id = normalizeKindId(input.id ?? input.business ?? input.label)
      if (id.length === 0) return { ok: false, reason: '业务类需要 id 或名称' }
      const label = String(input.label ?? '').trim() || id
      const keywords = cleanList(input.keywords)
      const list = kinds()
      const index = list.findIndex((kind) => kind.id === id)
      const next = { id, label, keywords: keywords.length > 0 ? keywords : (index >= 0 ? list[index].keywords : []) }
      if (index >= 0) list[index] = next
      else list.push(next)
      saveAll({ kinds: list })
      return { ok: true, kind: next, kinds: list }
    },
    removeKind(id) {
      const target = String(id ?? '').trim()
      const used = load().filter((profile) => profile.business === target)
      if (used.length > 0) return { ok: false, reason: `还有 ${used.length} 条业务配置在用「${target}」，先改掉或删除它们`, kinds: kinds() }
      const list = kinds().filter((kind) => kind.id !== target)
      saveAll({ kinds: list })
      return { ok: true, kinds: list }
    },
    /**
     * 自动登记：工作流跑过 / 被加载过就按推断出的业务类落一条配置；
     * 同业务类已有主配置时不抢占，只把这次的工作流记进 candidates。
     */
    autoRegister({ workflow, graph, source = 'saved' } = {}) {
      const name = String(workflow ?? '').trim()
      if (name.length === 0) return null
      const business = inferBusiness(graph)
      const profiles = load()
      const index = profiles.findIndex((profile) => profile.business === business)
      if (index < 0) {
        const created = normalizeProfile({
          id: business,
          business,
          workflow: name,
          source,
          params: extractBusinessParams(graph),
          keywords: kindOf(kinds(), business)?.keywords?.slice(0, 4) ?? [],
          notes: '自动登记：首次跑过的该业务类工作流',
          auto: true,
          uses: 1,
          lastUsedAt: now(),
        })
        profiles.push(created)
        saveAll({ profiles })
        return created
      }
      const current = profiles[index]
      const candidates = upsertCandidate(current, name, source)
      profiles[index] = {
        ...current,
        candidates,
        uses: name === current.workflow ? (Number(current.uses) || 0) + 1 : current.uses,
        lastUsedAt: name === current.workflow ? now() : current.lastUsedAt,
        updatedAt: now(),
      }
      saveAll({ profiles })
      return profiles[index]
    },
    /** 命中后记一次使用（供工作台展示「最近使用」）。 */
    touch(id) {
      const profiles = load()
      const index = profiles.findIndex((profile) => profile.id === String(id ?? ''))
      if (index < 0) return null
      profiles[index] = {
        ...profiles[index],
        uses: (Number(profiles[index].uses) || 0) + 1,
        lastUsedAt: now(),
      }
      saveAll({ profiles })
      return profiles[index]
    },
  }
}

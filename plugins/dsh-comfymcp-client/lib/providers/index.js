/**
 * 多模态服务商注册中心：kind → 适配器、统一 generate()、连接测试、预设模板。
 */
import { ProviderError, messageForStatus, errorMessageOf } from './errors.js'
import * as modelscope from './modelscope.js'
import * as huggingface from './huggingface.js'
import * as openaiImages from './openai-images.js'
import * as ollama from './ollama.js'
import * as vllm from './vllm.js'
import * as sdwebui from './sdwebui.js'
import { PROVIDER_KINDS, PROVIDER_KIND_LABELS } from './store.js'

const ADAPTERS = Object.freeze({
  modelscope,
  huggingface,
  'openai-images': openaiImages,
  ollama,
  vllm,
  sdwebui,
})

export function adapterFor(kind) {
  const adapter = ADAPTERS[kind]
  if (adapter === undefined) throw new ProviderError(`未知服务商类型：${kind}`, { code: 'bad_request' })
  return adapter
}

/** 服务商预设模板：创作页「+ 添加」的一键填充来源。 */
export const PROVIDER_PRESETS = Object.freeze([
  {
    id: 'ms-qwen-image',
    label: '魔搭 · Qwen-Image（文生图/图生图）',
    kind: 'modelscope',
    baseUrl: 'https://api-inference.modelscope.cn',
    model: 'Qwen/Qwen-Image',
    capabilities: ['t2i', 'i2i'],
    defaults: { size: '1024x1024', negativePrompt: '低质量, 模糊, 变形' },
    allowPrivateHosts: false,
    note: '魔搭 API-Inference，需在 ModelScope 个人设置创建访问令牌（SDK 令牌）。',
  },
  {
    id: 'hf-sdxl',
    label: 'HuggingFace · SDXL（Inference Providers）',
    kind: 'huggingface',
    baseUrl: 'https://router.huggingface.co/v1',
    model: 'stabilityai/stable-diffusion-xl-base-1.0',
    capabilities: ['t2i'],
    defaults: { size: '1024x1024', negativePrompt: '' },
    allowPrivateHosts: false,
    note: 'HF 需要 Inference Providers 权限的 Token；国内网络可能需要代理。',
  },
  {
    id: 'ollama-z-image',
    label: 'Ollama · Z-Image Turbo（本机，实验性）',
    kind: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    model: 'x/z-image-turbo',
    capabilities: ['t2i'],
    defaults: { size: '1024x1024' },
    allowPrivateHosts: true,
    note: 'Ollama 文生图为实验性能力（macOS/MLX 先行；Windows/Linux 支持在途）。',
  },
  {
    id: 'vllm-omni',
    label: 'vLLM-omni（自建，OpenAI 兼容）',
    kind: 'vllm',
    baseUrl: 'http://localhost:8000/v1',
    model: 'black-forest-labs/FLUX.1-schnell',
    capabilities: ['t2i'],
    defaults: { size: '1024x1024' },
    allowPrivateHosts: true,
    note: '需 vllm-omni 部署（原生 vLLM 不产图）；模型名以部署为准。',
  },
  {
    id: 'sdwebui-local',
    label: 'A1111 / SD WebUI（本机）',
    kind: 'sdwebui',
    baseUrl: 'http://127.0.0.1:7860',
    model: '',
    capabilities: ['t2i', 'i2i'],
    defaults: { size: '512x512', steps: 25, guidance: 7 },
    allowPrivateHosts: true,
    note: 'A1111 默认端口 7860；需开启 API（--api）；「模型」可留空用当前加载模型。',
  },
  {
    id: 'openai-gateway',
    label: 'OpenAI 兼容网关（自定义）',
    kind: 'openai-images',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-image-1',
    capabilities: ['t2i', 'i2i'],
    defaults: { size: '1024x1024' },
    allowPrivateHosts: false,
    note: '任意 OpenAI 兼容图像接口：one-api/new-api 网关、其他兼容服务填对应 baseUrl。',
  },
])

/** 是否本地类服务（测试连接提示用）。 */
export function isLocalKind(kind) {
  return kind === 'ollama' || kind === 'vllm' || kind === 'sdwebui'
}

function trimSlash(url) {
  return String(url ?? '').trim().replace(/\/+$/, '')
}

/** 服务商名（错误信息用）。 */
function providerName(provider) {
  return provider?.label || provider?.id || provider?.kind || '服务商'
}

/**
 * 统一生成入口。
 * @param {object} provider 归一化 provider（store.all() 里的真实密钥版本）
 * @param {object} request { mode, prompt, negativePrompt, size, steps, guidance, seed, n, image }
 * @param {{ store, fetchImpl?, abortSignal?, onProgress? }} deps
 */
export async function generate(provider, request, deps = {}) {
  if (provider === null || provider === undefined) throw new ProviderError('未指定服务商', { code: 'bad_request' })
  if (provider.enabled === false) throw new ProviderError(`服务商「${providerName(provider)}」已禁用`, { code: 'disabled', providerId: provider.id })
  const prompt = String(request?.prompt ?? '').trim()
  if (prompt.length === 0) throw new ProviderError('提示词不能为空', { code: 'bad_request', providerId: provider.id })
  const adapter = adapterFor(provider.kind)
  const apiKey = typeof deps.store?.resolveKey === 'function' ? deps.store.resolveKey(provider) : String(provider.apiKey ?? '')
  if (apiKey.length === 0 && provider.kind !== 'ollama' && provider.kind !== 'vllm' && provider.kind !== 'sdwebui') {
    throw new ProviderError(`服务商「${providerName(provider)}」未配置 API key（或在环境变量中未找到）`, {
      code: 'invalid_key',
      providerId: provider.id,
    })
  }
  return adapter.generate(
    { ...provider, defaults: { ...(provider.defaults ?? {}) } },
    {
      mode: request.mode === 'i2i' ? 'i2i' : 't2i',
      prompt,
      negativePrompt: String(request.negativePrompt ?? ''),
      size: request.size,
      steps: request.steps,
      guidance: request.guidance,
      seed: request.seed,
      n: request.n,
      image: request.image,
      model: request.model,
    },
    { ...deps, apiKey },
  )
}

/**
 * 连接测试：能列出模型列表视为通过；404/405 视为「端点可达但列表不可用」的通过（附提示）。
 * @returns {Promise<{ok: boolean, message: string, models?: string[], kind?: string}>}
 */
export async function testProvider(provider, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const apiKey = typeof deps.store?.resolveKey === 'function' ? deps.store.resolveKey(provider) : String(provider.apiKey ?? '')
  const base = trimSlash(provider.baseUrl)
  const timeoutMs = Math.min(15000, Number(provider.timeoutMs) > 0 ? Number(provider.timeoutMs) : 15000)
  const authHeaders = typeof apiKey === 'string' && apiKey.length > 0 ? { authorization: `Bearer ${apiKey}` } : {}
  const signal = AbortSignal.timeout(timeoutMs)

  async function getJson(url) {
    const response = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json', ...authHeaders }, signal })
    const text = await response.text()
    let payload = null
    try {
      payload = text.length > 0 ? JSON.parse(text) : null
    } catch {
      payload = text
    }
    return { response, payload }
  }

  try {
    if (provider.kind === 'sdwebui') {
      const { response, payload } = await getJson(`${base}/sdapi/v1/sd-models`)
      if (!response.ok) {
        return { ok: false, message: response.status === 404 ? '未找到 /sdapi/v1/sd-models：确认已加 --api 启动参数' : messageForStatus(response.status, payload) }
      }
      const models = Array.isArray(payload) ? payload.map((entry) => entry?.title ?? entry?.model_name ?? '').filter(Boolean).slice(0, 20) : []
      return { ok: true, message: models.length > 0 ? `连接成功，已加载 ${models.length} 个模型` : '连接成功（未返回模型列表）', models }
    }
    if (provider.kind === 'ollama') {
      const tagsBase = base.replace(/\/v1$/, '')
      const { response, payload } = await getJson(`${tagsBase}/api/tags`)
      if (!response.ok) return { ok: false, message: messageForStatus(response.status, payload) }
      const models = Array.isArray(payload?.models) ? payload.models.map((entry) => entry?.name ?? entry?.model ?? '').filter(Boolean).slice(0, 20) : []
      const hasImageModel = models.some((name) => /z-image|flux/i.test(name))
      return {
        ok: true,
        message: `连接成功（${models.length} 个本地模型${hasImageModel ? '' : '；未发现文生图模型，可 pull x/z-image-turbo'}）`,
        models,
      }
    }
    if (provider.kind === 'modelscope') {
      const { response, payload } = await getJson(`${base}/v1/models`)
      if (!response.ok) {
        if (response.status === 404 || response.status === 405) return { ok: true, message: '端点可达（/v1/models 未开放，生成接口另行测试）' }
        return { ok: false, message: messageForStatus(response.status, payload) }
      }
      const models = Array.isArray(payload?.data) ? payload.data.map((entry) => entry?.id ?? '').filter(Boolean).slice(0, 20) : []
      return { ok: true, message: models.length > 0 ? `连接成功（${models.length} 个可用模型）` : '连接成功', models }
    }
    // OpenAI 兼容族（openai-images / huggingface / vllm）
    const { response, payload } = await getJson(`${base}/models`)
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) return { ok: false, message: messageForStatus(response.status, payload) }
      if (response.status === 404 || response.status === 405) return { ok: true, message: '端点可达（/models 未开放，生成接口另行测试）' }
      return { ok: false, message: messageForStatus(response.status, payload) }
    }
    const models = Array.isArray(payload?.data) ? payload.data.map((entry) => entry?.id ?? '').filter(Boolean).slice(0, 20) : []
    return { ok: true, message: models.length > 0 ? `连接成功（${models.length} 个可用模型）` : '连接成功', models }
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return { ok: false, message: `连接超时（${timeoutMs}ms），检查地址/网络/服务是否已启动` }
    return { ok: false, message: `无法连接：${error instanceof Error ? error.message : String(error)}` }
  }
}

export { PROVIDER_KINDS, PROVIDER_KIND_LABELS, errorMessageOf }

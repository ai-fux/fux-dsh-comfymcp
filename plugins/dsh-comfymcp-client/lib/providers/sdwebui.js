/**
 * A1111 / SD WebUI 图像接口（自建 SD 生态最常见形态）。
 *
 * - 文生图：POST {base}/sdapi/v1/txt2img
 *   body { prompt, negative_prompt, steps, width, height, cfg_scale, seed, batch_size }
 *   → { images: [b64, ...] }
 * - 图生图：POST {base}/sdapi/v1/img2img
 *   body { init_images: [b64], denoising_strength, prompt, negative_prompt, steps, ... }
 * - 连接测试：GET {base}/sdapi/v1/sd-models（返回已加载模型列表）
 */
import { ProviderError, requestJson, timeoutSignal } from './errors.js'
import { detectMime } from './image.js'

export const kind = 'sdwebui'

function trimSlash(url) {
  return String(url ?? '').trim().replace(/\/+$/, '')
}

function sizeParts(size) {
  const match = /^(\d{2,4})x(\d{2,4})$/i.exec(String(size ?? '').trim())
  return { width: match ? Number(match[1]) : 1024, height: match ? Number(match[2]) : 1024 }
}

export async function generate(provider, request, deps = {}) {
  const started = Date.now()
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const base = trimSlash(provider.baseUrl)
  const timeoutMs = Number(provider.timeoutMs) > 0 ? Number(provider.timeoutMs) : 600000
  const meta = { providerId: provider.id, model: request.model ?? provider.model, timeoutMs }
  const size = String(request.size ?? provider.defaults?.size ?? '1024x1024')
  const { width, height } = sizeParts(size)
  const model = String(request.model ?? provider.model ?? '')

  const common = {
    prompt: String(request.prompt ?? ''),
    negative_prompt: String(request.negativePrompt ?? provider.defaults?.negativePrompt ?? ''),
    steps: Math.min(150, Math.max(1, Number(request.steps ?? provider.defaults?.steps ?? 30))),
    cfg_scale: Number(request.guidance ?? provider.defaults?.guidance ?? 7),
    width,
    height,
    seed: request.seed !== undefined ? Math.trunc(Number(request.seed)) : Number(provider.defaults?.seed ?? -1),
  }
  if (typeof model === 'string' && model.length > 0) {
    // SD WebUI 用 override_settings 选模型（可选）
    common.override_settings = { sd_model_checkpoint: model }
  }

  let path
  let body
  if (request.mode === 'i2i') {
    if (request.image === undefined) throw new ProviderError('图生图需要提供参考图片', { code: 'bad_request', providerId: provider.id })
    path = '/sdapi/v1/img2img'
    body = {
      ...common,
      init_images: [request.image.bytes.toString('base64')],
      denoising_strength: Math.min(0.95, Math.max(0.05, Number(request.denoise ?? provider.defaults?.denoise ?? 0.6))),
      ...(request.n && Number(request.n) > 1 ? { batch_size: Math.min(4, Number(request.n)) } : {}),
    }
  } else {
    path = '/sdapi/v1/txt2img'
    body = { ...common, ...(request.n && Number(request.n) > 1 ? { batch_size: Math.min(4, Number(request.n)) } : {}) }
  }

  deps.onProgress?.({ stage: 'request', elapsedMs: 0 })
  const payload = await requestJson(
    fetchImpl,
    `${base}${path}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(typeof deps.apiKey === 'string' && deps.apiKey.length > 0 ? { authorization: `Bearer ${deps.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: timeoutSignal(deps.abortSignal, timeoutMs),
    },
    meta,
  )
  const list = Array.isArray(payload?.images) ? payload.images : []
  if (list.length === 0) {
    throw new ProviderError('SD WebUI 未返回图片', { code: 'bad_response', providerId: provider.id, detail: JSON.stringify(payload ?? null).slice(0, 600) })
  }
  const images = list
    .filter((entry) => typeof entry === 'string' && entry.length > 0)
    .map((entry) => {
      const bytes = Buffer.from(entry.replace(/^data:[^;]+;base64,/, ''), 'base64')
      return { bytes, mime: detectMime(bytes) }
    })
  return { images, taskId: '', elapsedMs: Date.now() - started, model, width, height }
}

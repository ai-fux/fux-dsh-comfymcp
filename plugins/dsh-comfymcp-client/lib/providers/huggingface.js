/**
 * HuggingFace Inference Providers（router.huggingface.co/v1）：OpenAI 兼容图像协议。
 * 也支持 legacy 推理端点模式：POST https://api-inference.huggingface.co/models/{model}
 * （body {inputs}，返回二进制图片）——由 provider.legacy === true 开启。
 */
import { ProviderError, requestJson, timeoutSignal, errorMessageOf } from './errors.js'
import { readImageResult } from './image.js'
import { generateOpenAICompat } from './openai-compat.js'

export const kind = 'huggingface'

function trimSlash(url) {
  return String(url ?? '').trim().replace(/\/+$/, '')
}

export async function generate(provider, request, deps = {}) {
  if (provider.legacy === true) return generateLegacy(provider, request, deps)
  return generateOpenAICompat(provider, request, deps)
}

async function generateLegacy(provider, request, deps = {}) {
  const started = Date.now()
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const base = trimSlash(provider.baseUrl) || 'https://api-inference.huggingface.co'
  const model = String(request.model ?? provider.model ?? '')
  const url = `${base}/models/${model}`
  const body = {
    inputs: String(request.prompt ?? ''),
    ...(request.negativePrompt ? { parameters: { negative_prompt: request.negativePrompt } } : {}),
  }
  const headers = { 'content-type': 'application/json', accept: 'image/png' }
  if (typeof deps.apiKey === 'string' && deps.apiKey.length > 0) headers.authorization = `Bearer ${deps.apiKey}`
  let response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: timeoutSignal(deps.abortSignal, Number(provider.timeoutMs) > 0 ? Number(provider.timeoutMs) : 600000),
    })
  } catch (error) {
    throw new ProviderError(`无法连接 HuggingFace 推理端点：${error instanceof Error ? error.message : String(error)}`, { code: 'unreachable', providerId: provider.id })
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let payload = text
    try {
      payload = JSON.parse(text)
    } catch {
      /* 非 JSON */
    }
    throw new ProviderError(
      response.status === 503 ? '模型正在加载或额度不足（503），请稍后重试' : `HuggingFace 返回 HTTP ${response.status}：${errorMessageOf(payload, '')}`,
      { code: response.status === 401 || response.status === 403 ? 'invalid_key' : 'http_error', status: response.status, providerId: provider.id, model },
    )
  }
  const contentType = String(response.headers?.get?.('content-type') ?? '')
  if (contentType.includes('application/json')) {
    const payload = await response.text().catch(() => '')
    throw new ProviderError(`HuggingFace 未返回图片：${payload.slice(0, 200)}`, { code: 'bad_response', providerId: provider.id, model })
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  const { detectMime } = await import('./image.js')
  return { images: [{ bytes, mime: detectMime(bytes) }], taskId: '', elapsedMs: Date.now() - started, model }
}

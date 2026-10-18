/**
 * OpenAI 兼容图像协议族：openai-images / huggingface（router）/ vllm / ollama 共用。
 *
 * 协议（官方文档核对）：
 * - 文生图：POST {base}/images/generations，body { model, prompt, n, size, response_format, negative_prompt?, num_inference_steps?, guidance_scale? }
 * - 图生图：POST {base}/images/edits（multipart：image + prompt + model + size + response_format）
 * - 异步网关（new-api 等）：响应含 task_id → GET {base}/tasks/{id} 轮询
 * - Ollama 兼容端点：POST http://host:11434/v1/images/generations（实验性，返回 b64_json）
 *
 * 响应归一化：{ images: [{ b64, mime }], raw, taskId?, elapsedMs }。
 */
import { ProviderError, requestJson, timeoutSignal, errorMessageOf } from './errors.js'
import { readImageResult, detectMime } from './image.js'

function trimSlash(url) {
  return String(url ?? '').trim().replace(/\/+$/, '')
}

function buildHeaders(apiKey) {
  const headers = { 'content-type': 'application/json', accept: 'application/json' }
  if (typeof apiKey === 'string' && apiKey.length > 0) headers.authorization = `Bearer ${apiKey}`
  return headers
}

function sizeParts(size) {
  const match = /^(\d{2,4})x(\d{2,4})$/i.exec(String(size ?? '').trim())
  return { width: match ? Number(match[1]) : 0, height: match ? Number(match[2]) : 0 }
}

/** 把响应里的 data 数组归一化为图片字节。 */
async function collectImages(payload, deps, meta) {
  const data = payload?.data ?? payload?.images ?? payload?.outputs
  if (!Array.isArray(data) || data.length === 0) {
    throw new ProviderError('服务商未返回图片数据', {
      code: 'bad_response',
      providerId: meta.providerId,
      model: meta.model,
      detail: JSON.stringify(payload ?? null).slice(0, 800),
    })
  }
  const images = []
  for (const entry of data) {
    if (typeof entry === 'string') {
      const image = await readImageResult(entry, { fetchImpl: deps.fetchImpl, timeoutMs: meta.timeoutMs, abortSignal: deps.abortSignal })
      images.push(image)
      continue
    }
    if (entry !== null && typeof entry === 'object') {
      const source = entry.b64_json ?? entry.b64 ?? entry.base64 ?? entry.url ?? null
      if (source === null) continue
      const image = await readImageResult(source, { fetchImpl: deps.fetchImpl, timeoutMs: meta.timeoutMs, abortSignal: deps.abortSignal })
      images.push({ ...image, revisedPrompt: typeof entry.revised_prompt === 'string' ? entry.revised_prompt : undefined })
    }
  }
  if (images.length === 0) {
    throw new ProviderError('服务商返回的图片字段为空', { code: 'bad_response', providerId: meta.providerId, model: meta.model })
  }
  return images
}

/** 轮询异步网关任务（{base}/tasks/{id}）。 */
async function pollTask(base, taskId, deps, meta) {
  const started = Date.now()
  const pollInterval = Number(meta.pollIntervalMs) > 0 ? Number(meta.pollIntervalMs) : 3000
  let interval = pollInterval
  let last = null
  while (Date.now() - started < meta.timeoutMs) {
    if (deps.abortSignal?.aborted === true) throw new ProviderError('请求已取消', { code: 'aborted', providerId: meta.providerId })
    await new Promise((resolve) => setTimeout(resolve, interval))
    interval = Math.min(Math.round(interval * 1.4), 10000)
    last = await requestJson(
      deps.fetchImpl,
      `${base}/tasks/${encodeURIComponent(taskId)}`,
      { method: 'GET', headers: buildHeaders(meta.apiKey), signal: timeoutSignal(deps.abortSignal, 30000) },
      meta,
    )
    const status = String(last?.status ?? last?.task_status ?? '').toLowerCase()
    if (['succeed', 'succeeded', 'success', 'completed', 'done'].includes(status)) return last
    if (['failed', 'error', 'canceled', 'cancelled'].includes(status)) {
      throw new ProviderError(`服务商任务失败：${errorMessageOf(last, '未知原因')}`, { code: 'task_failed', providerId: meta.providerId, detail: JSON.stringify(last ?? null).slice(0, 600) })
    }
    deps.onProgress?.({ stage: 'task', status: status || 'pending', elapsedMs: Date.now() - started })
  }
  throw new ProviderError(`服务商任务超时（>${Math.round(meta.timeoutMs / 1000)} 秒）`, { code: 'timeout', providerId: meta.providerId, model: meta.model, detail: JSON.stringify(last ?? null).slice(0, 400) })
}

/**
 * 生成图片（OpenAI 兼容协议）。
 * @param {object} provider 归一化 provider
 * @param {object} request { mode, prompt, negativePrompt, size, steps, guidance, seed, n, image?{bytes,mime} }
 * @param {object} deps { fetchImpl, abortSignal, apiKey, onProgress }
 */
export async function generateOpenAICompat(provider, request, deps = {}) {
  const started = Date.now()
  const base = trimSlash(provider.baseUrl)
  const meta = {
    providerId: provider.id,
    model: provider.model,
    apiKey: deps.apiKey,
    timeoutMs: Number(provider.timeoutMs) > 0 ? Number(provider.timeoutMs) : 600000,
    pollIntervalMs: Number(provider.pollIntervalMs) > 0 ? Number(provider.pollIntervalMs) : 0,
  }
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const mode = request.mode === 'i2i' ? 'i2i' : 't2i'
  const size = String(request.size ?? provider.defaults?.size ?? '1024x1024')
  const model = String(request.model ?? provider.model ?? '')

  if (mode === 'i2i' && request.image === undefined) {
    throw new ProviderError('图生图需要提供参考图片', { code: 'bad_request', providerId: provider.id })
  }

  let payload
  if (mode === 't2i') {
    const body = {
      model,
      prompt: request.prompt,
      n: Math.min(4, Math.max(1, Number(request.n ?? provider.defaults?.n ?? 1))),
      size,
      response_format: 'b64_json',
      ...(request.negativePrompt || provider.defaults?.negativePrompt ? { negative_prompt: request.negativePrompt || provider.defaults?.negativePrompt } : {}),
      ...(request.steps ? { num_inference_steps: Number(request.steps) } : {}),
      ...(request.guidance !== undefined ? { guidance_scale: Number(request.guidance) } : {}),
      ...(request.seed !== undefined && Number(request.seed) >= 0 ? { seed: Math.trunc(Number(request.seed)) } : {}),
    }
    deps.onProgress?.({ stage: 'request', elapsedMs: 0 })
    payload = await requestJson(
      fetchImpl,
      `${base}/images/generations`,
      { method: 'POST', headers: buildHeaders(deps.apiKey), body: JSON.stringify(body), signal: timeoutSignal(deps.abortSignal, meta.timeoutMs) },
      meta,
    )
  } else {
    const form = new FormData()
    const image = request.image
    form.append('image', new Blob([image.bytes], { type: image.mime || 'image/png' }), `input${image.mime === 'image/jpeg' ? '.jpg' : '.png'}`)
    form.append('model', model)
    form.append('prompt', request.prompt)
    form.append('size', size)
    form.append('n', String(Math.min(4, Math.max(1, Number(request.n ?? 1)))))
    form.append('response_format', 'b64_json')
    if (request.negativePrompt) form.append('negative_prompt', request.negativePrompt)
    deps.onProgress?.({ stage: 'request', elapsedMs: 0 })
    payload = await requestJson(
      fetchImpl,
      `${base}/images/edits`,
      {
        method: 'POST',
        headers: { accept: 'application/json', ...(deps.apiKey ? { authorization: `Bearer ${deps.apiKey}` } : {}) },
        body: form,
        signal: timeoutSignal(deps.abortSignal, meta.timeoutMs),
      },
      meta,
    )
  }

  let taskId = ''
  let finalPayload = payload
  if (payload !== null && typeof payload === 'object' && (typeof payload.task_id === 'string' || typeof payload.id === 'string') && Array.isArray(payload.data) !== true) {
    taskId = String(payload.task_id ?? payload.id)
    finalPayload = await pollTask(base, taskId, deps, meta)
  }
  const images = await collectImages(finalPayload, deps, meta)
  const elapsedMs = Date.now() - started
  return { images, taskId, elapsedMs, model, size, width: sizeParts(size).width, height: sizeParts(size).height }
}

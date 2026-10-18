/**
 * 魔搭 ModelScope API-Inference（异步任务）：
 *
 * - POST {base}/v1/images/generations
 *   headers: Authorization: Bearer <token>、Content-Type: application/json、
 *            X-ModelScope-Async-Mode: true
 *   body: { model, prompt, negative_prompt?, size?, image_url?（图生图） }
 *   → { task_id }
 * - GET {base}/v1/tasks/{task_id}
 *   headers: X-ModelScope-Task-Type: image_generation
 *   → { task_status: 'SUCCEED' | 'FAILED' | 'RUNNING', output_images: [url], errors }
 *
 * 官方实现依据：modelscope/ms-agent ms_agent/tools/image_generator/ms_image_gen.py。
 */
import { ProviderError, requestJson, timeoutSignal, errorMessageOf } from './errors.js'
import { readImageResult } from './image.js'

export const kind = 'modelscope'

function trimSlash(url) {
  return String(url ?? '').trim().replace(/\/+$/, '') || 'https://api-inference.modelscope.cn'
}

function headersFor(apiKey, extra = {}) {
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    ...(typeof apiKey === 'string' && apiKey.length > 0 ? { authorization: `Bearer ${apiKey}` } : {}),
    ...extra,
  }
}

async function downloadAll(urls, deps, timeoutMs) {
  const images = []
  for (const url of urls) {
    const image = await readImageResult(url, { fetchImpl: deps.fetchImpl, timeoutMs, abortSignal: deps.abortSignal })
    images.push(image)
  }
  return images
}

export async function generate(provider, request, deps = {}) {
  const started = Date.now()
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const base = trimSlash(provider.baseUrl)
  const model = String(request.model ?? provider.model ?? '')
  const timeoutMs = Number(provider.timeoutMs) > 0 ? Number(provider.timeoutMs) : 600000
  const meta = { providerId: provider.id, model, timeoutMs }

  const body = {
    model,
    prompt: String(request.prompt ?? ''),
    ...(request.negativePrompt || provider.defaults?.negativePrompt ? { negative_prompt: request.negativePrompt || provider.defaults?.negativePrompt } : {}),
    ...(request.size || provider.defaults?.size ? { size: String(request.size ?? provider.defaults?.size) } : {}),
  }
  if (request.mode === 'i2i') {
    if (request.image === undefined) throw new ProviderError('图生图需要提供参考图片', { code: 'bad_request', providerId: provider.id })
    // 魔搭图生图（Qwen-Image-Edit 等）通过 image_url 传入参考图；本地文件转 data URL 尝试直传
    const b64 = request.image.bytes.toString('base64')
    body.image_url = `data:${request.image.mime || 'image/png'};base64,${b64}`
  }

  deps.onProgress?.({ stage: 'request', elapsedMs: 0 })
  const submitted = await requestJson(
    fetchImpl,
    `${base}/v1/images/generations`,
    { method: 'POST', headers: headersFor(deps.apiKey, { 'X-ModelScope-Async-Mode': 'true' }), body: JSON.stringify(body), signal: timeoutSignal(deps.abortSignal, Math.min(timeoutMs, 120000)) },
    meta,
  )

  const taskId = typeof submitted?.task_id === 'string' ? submitted.task_id : ''
  // 同步模型可能直接返回 data
  if (taskId.length === 0) {
    const outputImages = submitted?.output_images ?? submitted?.data
    if (Array.isArray(outputImages) && outputImages.length > 0) {
      const images = await downloadAll(outputImages.map((entry) => (typeof entry === 'string' ? entry : entry?.url ?? entry?.b64_json)), deps, timeoutMs)
      return { images, taskId: '', elapsedMs: Date.now() - started, model }
    }
    throw new ProviderError('魔搭未返回 task_id 或图片数据', { code: 'bad_response', providerId: provider.id, model, detail: JSON.stringify(submitted ?? null).slice(0, 600) })
  }

  let interval = Number(provider.pollIntervalMs) > 0 ? Number(provider.pollIntervalMs) : 2000
  let last = null
  let elapsed = 0
  while (elapsed < timeoutMs) {
    if (deps.abortSignal?.aborted === true) throw new ProviderError('请求已取消', { code: 'aborted', providerId: provider.id })
    await new Promise((resolve) => setTimeout(resolve, interval))
    elapsed = Date.now() - started
    interval = Math.min(Math.round(interval * 1.5), 10000)
    deps.onProgress?.({ stage: 'task', taskId, elapsedMs: elapsed })
    last = await requestJson(
      fetchImpl,
      `${base}/v1/tasks/${encodeURIComponent(taskId)}`,
      { method: 'GET', headers: headersFor(deps.apiKey, { 'X-ModelScope-Task-Type': 'image_generation' }), signal: timeoutSignal(deps.abortSignal, Math.min(timeoutMs, 60000)) },
      meta,
    )
    const status = String(last?.task_status ?? last?.status ?? '').toUpperCase()
    if (status === 'SUCCEED') {
      const urls = Array.isArray(last?.output_images) ? last.output_images : []
      if (urls.length === 0) throw new ProviderError('魔搭任务成功但未返回图片地址', { code: 'bad_response', providerId: provider.id })
      const images = await downloadAll(urls, deps, timeoutMs)
      return { images, taskId, elapsedMs: Date.now() - started, model }
    }
    if (status === 'FAILED') {
      throw new ProviderError(`魔搭任务失败：${errorMessageOf(last?.errors ?? last, '未知原因')}`, {
        code: 'task_failed',
        providerId: provider.id,
        model,
        detail: JSON.stringify(last ?? null).slice(0, 800),
      })
    }
  }
  throw new ProviderError(`魔搭任务超时（>${Math.round(timeoutMs / 1000)} 秒）`, { code: 'timeout', providerId: provider.id, model, detail: JSON.stringify(last ?? null).slice(0, 400) })
}

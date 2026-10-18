/**
 * 多模态服务商统一错误：所有适配器只抛 ProviderError。
 *
 * 设计目标：
 * 1. 错误信息面向用户可读（中文），技术细节放 detail/stack 进开发日志；
 * 2. code 供页面/工具做分支提示（invalid_key / rate_limited / timeout / not_found / unreachable / bad_response / aborted …）；
 * 3. 绝不把服务商原始 JSON 整段倒给用户（可能含敏感信息），只截取 message 字段。
 */

export class ProviderError extends Error {
  /**
   * @param {string} message 用户可读消息
   * @param {{code?: string, status?: number, providerId?: string, model?: string, detail?: string}} meta
   */
  constructor(message, meta = {}) {
    super(message)
    this.name = 'ProviderError'
    this.code = typeof meta.code === 'string' && meta.code.length > 0 ? meta.code : 'provider_error'
    this.status = Number(meta.status) || 0
    this.providerId = meta.providerId ?? ''
    this.model = meta.model ?? ''
    this.detail = typeof meta.detail === 'string' ? meta.detail.slice(0, 2000) : ''
  }

  toJSON() {
    return {
      ok: false,
      error: this.message,
      code: this.code,
      status: this.status,
      providerId: this.providerId,
      model: this.model,
    }
  }
}

/** 服务商返回体里的错误文本（OpenAI 风格 {error:{message}} / 裸 {message} / 纯文本）。 */
export function errorMessageOf(payload, fallback = '') {
  if (payload === null || payload === undefined) return fallback
  if (typeof payload === 'string') return payload.trim().slice(0, 400) || fallback
  if (typeof payload !== 'object') return fallback
  const candidates = [payload.error?.message, payload.error, payload.message, payload.detail, payload.reason]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim().slice(0, 400)
    if (candidate !== null && typeof candidate === 'object' && typeof candidate.message === 'string' && candidate.message.trim().length > 0) {
      return candidate.message.trim().slice(0, 400)
    }
  }
  return fallback
}

/** HTTP 状态码 → 用户可读消息。 */
export function messageForStatus(status, payload) {
  const detail = errorMessageOf(payload, '')
  const suffix = detail.length > 0 ? `：${detail}` : ''
  if (status === 400) return `请求参数被服务商拒绝（400）${suffix}`
  if (status === 401) return `密钥无效或未授权（401）${suffix}`
  if (status === 403) return `无权限调用该模型或服务（403）${suffix}`
  if (status === 404) return `接口路径不存在（404），请检查 baseUrl 是否包含正确的版本前缀（如 /v1）${suffix}`
  if (status === 409) return `服务商任务冲突（409）${suffix}`
  if (status === 413) return `图片或提示词过大（413）${suffix}`
  if (status === 422) return `参数校验失败（422）${suffix}`
  if (status === 429) return `请求被限流（429），请稍后重试${suffix}`
  if (status >= 500) return `服务商内部错误（${status}），请稍后重试${suffix}`
  return `服务商返回异常（HTTP ${status}）${suffix}`
}

/** 网络层异常（fetch 抛错）→ 用户可读消息。 */
export function messageForFetchError(error) {
  const name = error?.name ?? ''
  if (name === 'TimeoutError' || name === 'AbortError' || /aborted|timeout/i.test(String(error?.message ?? ''))) {
    return '请求超时或已取消'
  }
  const detail = String(error?.message ?? error ?? '').slice(0, 300)
  return `无法连接服务商（检查网络、代理或地址是否正确）：${detail}`
}

/** 包装 fetch：超时 + 用户取消 + 网络错误统一映射。 */
export async function requestJson(fetchImpl, url, init, meta = {}) {
  let response
  try {
    response = await fetchImpl(url, init)
  } catch (error) {
    throw new ProviderError(messageForFetchError(error), {
      code: /timeout/i.test(String(error?.name ?? '')) ? 'timeout' : 'unreachable',
      providerId: meta.providerId,
      model: meta.model,
      detail: String(error?.message ?? error ?? ''),
    })
  }
  const text = await response.text()
  let payload = null
  try {
    payload = text.length > 0 ? JSON.parse(text) : null
  } catch {
    payload = text
  }
  if (!response.ok) {
    throw new ProviderError(messageForStatus(response.status, payload), {
      code: response.status === 401 || response.status === 403 ? 'invalid_key' : response.status === 429 ? 'rate_limited' : 'http_error',
      status: response.status,
      providerId: meta.providerId,
      model: meta.model,
      detail: typeof text === 'string' ? text.slice(0, 800) : '',
    })
  }
  return payload
}

/** 组合超时信号：调用方 AbortSignal + 毫秒超时（Node 20.3+ 支持 AbortSignal.any）。 */
export function timeoutSignal(abortSignal, timeoutMs) {
  const signals = []
  if (abortSignal !== undefined && abortSignal !== null) signals.push(abortSignal)
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs))
  if (signals.length === 0) return undefined
  if (signals.length === 1) return signals[0]
  return AbortSignal.any(signals)
}

/**
 * 服务商配置存储：<dataDir>/providers.json。
 *
 * 与 config-overlay.json 分工：
 * - overlay：插件全局配置（传输、路径、开关）；
 * - providers.json：多模态服务商清单（可增删、按 provider 存默认参数）。
 *
 * 安全约定：
 * - apiKey 支持 `env:VAR` 间接引用（推荐）；
 * - list()/回显一律掩码（sk-****abcd），只有服务端解析真实值；
 * - 私网地址默认拒绝（SSRF 防护），本机 Ollama/vLLM 需显式 allowPrivateHosts。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const PROVIDER_KINDS = Object.freeze([
  'modelscope',
  'huggingface',
  'openai-images',
  'ollama',
  'vllm',
  'sdwebui',
])

export const PROVIDER_KIND_LABELS = Object.freeze({
  modelscope: '魔搭 ModelScope（异步任务）',
  huggingface: 'HuggingFace Inference Providers',
  'openai-images': 'OpenAI 兼容图像接口',
  ollama: 'Ollama（实验性，本机）',
  vllm: 'vLLM-omni（本机/自建）',
  sdwebui: 'A1111 / SD WebUI',
})

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

function isPrivateHostname(hostname) {
  const host = String(hostname ?? '').toLowerCase()
  if (host.length === 0) return true
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1' || host === '[::1]') return true
  if (host === '0.0.0.0') return true
  if (/^127\./.test(host)) return true
  if (/^10\./.test(host)) return true
  if (/^192\.168\./.test(host)) return true
  if (/^169\.254\./.test(host)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true
  if (/^fc00:/i.test(host) || /^fe80:/i.test(host)) return true
  return false
}

/** 校验 baseUrl：http(s)、非私网（除非显式允许）。 */
export function checkBaseUrl(baseUrl, { allowPrivateHosts = false } = {}) {
  if (typeof baseUrl !== 'string' || baseUrl.trim().length === 0) return 'baseUrl 不能为空'
  let url
  try {
    url = new URL(baseUrl.trim())
  } catch {
    return 'baseUrl 不是合法 URL'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'baseUrl 只支持 http/https'
  if (!allowPrivateHosts && isPrivateHostname(url.hostname)) {
    return `baseUrl 指向私网地址（${url.hostname}）；本机服务请勾选「允许私网地址」`
  }
  return ''
}

/** 规范化默认参数。 */
export function normalizeDefaults(raw) {
  const defaults = raw !== null && typeof raw === 'object' ? raw : {}
  const out = {}
  if (typeof defaults.size === 'string' && /^\d{2,4}x\d{2,4}$/.test(defaults.size.trim())) out.size = defaults.size.trim()
  if (typeof defaults.negativePrompt === 'string') out.negativePrompt = defaults.negativePrompt.slice(0, 1000)
  if (Number.isFinite(Number(defaults.steps)) && Number(defaults.steps) > 0) out.steps = Math.min(200, Math.round(Number(defaults.steps)))
  if (Number.isFinite(Number(defaults.guidance)) && Number(defaults.guidance) >= 0) out.guidance = Number(defaults.guidance)
  if (Number.isFinite(Number(defaults.seed)) ) out.seed = Math.trunc(Number(defaults.seed))
  if (Number.isFinite(Number(defaults.n)) && Number(defaults.n) >= 1) out.n = Math.min(4, Math.round(Number(defaults.n)))
  return out
}

export function maskKey(key) {
  const text = String(key ?? '')
  if (text.length === 0) return ''
  if (text.startsWith('env:')) return text
  if (text.length <= 8) return '****'
  return `${text.slice(0, 3)}****${text.slice(-4)}`
}

export function isMaskedKey(value) {
  return typeof value === 'string' && value.includes('****')
}

/**
 * 校验并规范化单个 provider。返回 { value, error }。
 * @param {object} raw
 * @param {{ existing?: object|null }} options
 */
export function normalizeProvider(raw, { existing = null } = {}) {
  if (raw === null || typeof raw !== 'object') return { error: 'provider 必须是对象' }
  const id = String(raw.id ?? '').trim()
  if (!ID_PATTERN.test(id)) return { error: 'id 需为小写字母/数字/-/_（1~64 位）' }
  const kind = String(raw.kind ?? '').trim()
  if (!PROVIDER_KINDS.includes(kind)) return { error: `kind 需为 ${PROVIDER_KINDS.join(' / ')}` }
  const allowPrivateHosts = raw.allowPrivateHosts === true
  const baseUrl = String(raw.baseUrl ?? '').trim()
  const urlError = checkBaseUrl(baseUrl, { allowPrivateHosts })
  if (urlError.length > 0) return { error: urlError }
  const model = String(raw.model ?? '').trim()
  if (model.length === 0 && kind !== 'sdwebui') return { error: 'model 不能为空' }
  // 密钥：掩码回传表示保持原值；空表示清空
  let apiKey = raw.apiKey === undefined ? (existing?.apiKey ?? '') : String(raw.apiKey)
  if (isMaskedKey(apiKey)) apiKey = existing?.apiKey ?? ''
  if (apiKey.startsWith('env:') && apiKey.length <= 4) return { error: 'env: 后需要环境变量名' }
  const capabilities = Array.isArray(raw.capabilities) ? raw.capabilities.filter((entry) => entry === 't2i' || entry === 'i2i') : []
  const timeoutMs = Number(raw.timeoutMs)
  const value = {
    id,
    label: String(raw.label ?? '').trim().slice(0, 60) || `${PROVIDER_KIND_LABELS[kind] ?? kind} · ${model || id}`,
    kind,
    baseUrl,
    apiKey,
    model,
    enabled: raw.enabled !== false,
    allowPrivateHosts,
    capabilities: capabilities.length > 0 ? [...new Set(capabilities)] : ['t2i'],
    defaults: normalizeDefaults(raw.defaults),
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(30 * 60 * 1000, Math.max(5000, Math.round(timeoutMs))) : 600000,
    ...(raw.note !== undefined ? { note: String(raw.note).slice(0, 300) } : {}),
  }
  return { value }
}

function defaultState() {
  return { version: 1, defaultId: '', providers: [] }
}

function validateState(state) {
  if (state === null || typeof state !== 'object' || !Array.isArray(state.providers)) return defaultState()
  const seen = new Set()
  const providers = []
  for (const entry of state.providers) {
    const normalized = normalizeProvider(entry)
    if (normalized.error !== undefined) continue
    if (seen.has(normalized.value.id)) continue
    seen.add(normalized.value.id)
    providers.push(normalized.value)
  }
  const defaultId = typeof state.defaultId === 'string' && seen.has(state.defaultId) ? state.defaultId : providers[0]?.id ?? ''
  return { version: 1, defaultId, providers }
}

export function createProviderStore({ dataDir }) {
  const dir = typeof dataDir === 'string' && dataDir.length > 0 ? dataDir : ''
  const file = join(dir, 'providers.json')

  function loadRaw() {
    if (dir.length === 0 || !existsSync(file)) return defaultState()
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      return defaultState()
    }
  }

  function load() {
    return validateState(loadRaw())
  }

  function persist(state) {
    if (dir.length === 0) return
    mkdirSync(dir, { recursive: true })
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
  }

  /** 内部用（含真实密钥）。 */
  function all() {
    const state = load()
    return { ...state, providers: state.providers }
  }

  /** 页面/工具用：密钥掩码。 */
  function list() {
    const state = load()
    return {
      version: state.version,
      defaultId: state.defaultId,
      providers: state.providers.map((provider) => ({
        ...provider,
        apiKey: maskKey(provider.apiKey),
        apiKeyIsEnv: provider.apiKey.startsWith('env:'),
        kindLabel: PROVIDER_KIND_LABELS[provider.kind] ?? provider.kind,
      })),
    }
  }

  function find(id) {
    return load().providers.find((provider) => provider.id === id) ?? null
  }

  /** 新增或更新（apiKey 掩码时保留原值）。 */
  function upsert(raw) {
    const state = load()
    const existing = state.providers.find((provider) => provider.id === String(raw?.id ?? '').trim()) ?? null
    const normalized = normalizeProvider(raw, { existing })
    if (normalized.error !== undefined) return { ok: false, reason: normalized.error }
    const index = state.providers.findIndex((provider) => provider.id === normalized.value.id)
    if (index >= 0) state.providers[index] = normalized.value
    else state.providers.push(normalized.value)
    if (state.defaultId.length === 0 || state.defaultId === normalized.value.id) state.defaultId = normalized.value.id
    persist(state)
    return { ok: true, value: normalized.value, created: index < 0 }
  }

  function remove(id) {
    const state = load()
    const index = state.providers.findIndex((provider) => provider.id === id)
    if (index < 0) return { ok: false, reason: `服务商 ${id} 不存在` }
    state.providers.splice(index, 1)
    if (state.defaultId === id) state.defaultId = state.providers[0]?.id ?? ''
    persist(state)
    return { ok: true }
  }

  function setDefault(id) {
    const state = load()
    if (!state.providers.some((provider) => provider.id === id)) return { ok: false, reason: `服务商 ${id} 不存在` }
    state.defaultId = id
    persist(state)
    return { ok: true }
  }

  /** 解析真实密钥（env: 引用在调用时取值，改环境变量无需重启）。 */
  function resolveKey(provider) {
    const key = String(provider?.apiKey ?? '')
    if (key.startsWith('env:')) return String(process.env[key.slice(4)] ?? '')
    return key
  }

  return { file, all, list, find, upsert, remove, setDefault, resolveKey }
}

export function defaultProviderStore(dataDir) {
  return createProviderStore({ dataDir })
}

export { dirname as providerDirname }

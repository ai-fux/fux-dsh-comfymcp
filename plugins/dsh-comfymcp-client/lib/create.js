/**
 * 创作服务：多模态服务商生成任务 + 落盘 + 创作历史（creations.json）。
 *
 * 任务模型：长任务（魔搭 FLUX 可达数分钟）不阻塞 HTTP——start() 立即返回 jobId，
 * 页面轮询 job(id) 获取进度/结果；任务在服务端跑完并落盘，页面关掉也不丢。
 *
 * 落盘：<artifactsDir>/created/<YYYY-MM-DD>/<stem>.png + 同名 .json 元数据。
 * 历史：<dataDir>/creations.json（环形 ≤200 条）。
 * 错误：进 dev-log（source=create），非开发模式也留档。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import * as providers from './providers/index.js'
import { ProviderError } from './providers/errors.js'
import { readImageResult, readLocalImage, writeImageFile, safeStem, detectMime } from './providers/image.js'

const MAX_JOBS = 50
const MAX_HISTORY = 200

function dateStamp(iso) {
  return String(iso ?? '').slice(0, 10) || new Date().toISOString().slice(0, 10)
}

function oneLine(text, max = 600) {
  return String(text ?? '').replaceAll(/\s+/g, ' ').slice(0, max)
}

export function createCreationService({ config, store, devLog = null, fetchImpl = globalThis.fetch, historyLimit = MAX_HISTORY }) {
  const jobs = new Map()
  const dataDir = typeof config?.dataDir === 'string' ? config.dataDir : ''
  const historyFile = join(dataDir, 'creations.json')

  function loadHistory() {
    if (dataDir.length === 0 || !existsSync(historyFile)) return []
    try {
      const parsed = JSON.parse(readFileSync(historyFile, 'utf8'))
      return Array.isArray(parsed?.items) ? parsed.items : []
    } catch {
      return []
    }
  }

  function saveHistory(items) {
    if (dataDir.length === 0) return
    mkdirSync(dataDir, { recursive: true })
    const tmp = `${historyFile}.tmp-${process.pid}`
    writeFileSync(tmp, `${JSON.stringify({ version: 1, items }, null, 2)}\n`, 'utf8')
    renameSync(tmp, historyFile)
  }

  function appendHistory(record) {
    const items = [record, ...loadHistory()].slice(0, historyLimit)
    saveHistory(items)
    return record
  }

  /** 解析图生图输入：{bytes,mime} / {path} / {url} / dataURL。 */
  async function resolveImageInput(input) {
    if (input === null || input === undefined) return undefined
    if (typeof input === 'string') {
      if (input.startsWith('data:')) return readImageResult(input, { fetchImpl })
      if (/^https?:\/\//i.test(input)) return readImageResult(input, { fetchImpl })
      const path = isAbsolute(input) ? input : join(String(config?.artifactsDir ?? ''), input)
      if (!existsSync(path)) throw new ProviderError(`参考图片不存在：${path}`, { code: 'bad_request' })
      return readLocalImage(path)
    }
    if (typeof input === 'object') {
      if (typeof input.b64 === 'string') return readImageResult(input.b64, { fetchImpl })
      if (typeof input.dataUrl === 'string') return readImageResult(input.dataUrl, { fetchImpl })
      if (typeof input.url === 'string') return readImageResult(input.url, { fetchImpl })
      if (typeof input.path === 'string') return resolveImageInput(input.path)
      if (input.bytes !== undefined) {
        const bytes = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes, 'base64')
        return { bytes, mime: detectMime(bytes) }
      }
    }
    throw new ProviderError('无法识别的参考图片格式', { code: 'bad_request' })
  }

  function publicJob(job) {
    return {
      id: job.id,
      status: job.status,
      startedAt: job.startedAt,
      elapsedMs: job.endedAt !== null ? Date.parse(job.endedAt) - Date.parse(job.startedAt) : Date.now() - Date.parse(job.startedAt),
      providerId: job.providerId,
      providerLabel: job.providerLabel,
      model: job.model,
      mode: job.mode,
      prompt: job.prompt,
      negativePrompt: job.negativePrompt,
      size: job.size,
      seed: job.seed,
      images: job.images,
      error: job.error,
      ...(job.progress !== undefined ? { progress: job.progress } : {}),
    }
  }

  /**
   * 启动创作任务（异步）。
   * @returns {{ok: boolean, jobId?: string, reason?: string}}
   */
  function start(payload = {}) {
    const providerId = String(payload.providerId ?? '').trim()
    const provider = providerId.length > 0 ? store.all().providers.find((entry) => entry.id === providerId) : (() => {
      const state = store.all()
      return state.providers.find((entry) => entry.id === state.defaultId) ?? state.providers.find((entry) => entry.enabled !== false) ?? null
    })()
    if (provider === null) return { ok: false, reason: '未配置可用的创作服务商：请先在「创作」页添加服务商' }
    if (provider.enabled === false) return { ok: false, reason: `服务商「${provider.label ?? provider.id}」已禁用` }
    const mode = payload.mode === 'i2i' ? 'i2i' : 't2i'
    const prompt = String(payload.prompt ?? '').trim()
    if (prompt.length === 0) return { ok: false, reason: '提示词不能为空' }
    if (mode === 'i2i' && payload.image === undefined) return { ok: false, reason: '图生图需要提供参考图片' }
    if (jobs.size >= MAX_JOBS) return { ok: false, reason: '并发任务过多，请等待已有任务完成' }

    const job = {
      id: randomUUID().slice(0, 8),
      status: 'running',
      startedAt: new Date().toISOString(),
      endedAt: null,
      providerId: provider.id,
      providerLabel: provider.label ?? provider.id,
      model: String(payload.model ?? provider.model ?? '').trim(),
      mode,
      prompt,
      negativePrompt: String(payload.negativePrompt ?? provider.defaults?.negativePrompt ?? ''),
      size: String(payload.size ?? provider.defaults?.size ?? '1024x1024'),
      seed: payload.seed !== undefined && payload.seed !== null && String(payload.seed) !== '' ? Math.trunc(Number(payload.seed)) : undefined,
      steps: payload.steps !== undefined && payload.steps !== null && String(payload.steps) !== '' ? Number(payload.steps) : undefined,
      guidance: payload.guidance !== undefined && payload.guidance !== null && String(payload.guidance) !== '' ? Number(payload.guidance) : undefined,
      images: [],
      error: '',
      abort: null,
      progress: undefined,
    }
    jobs.set(job.id, job)
    void runJob(job, provider, payload)
    return { ok: true, jobId: job.id }
  }

  async function runJob(job, provider, payload) {
    const controller = new AbortController()
    job.abort = controller
    try {
      const image = job.mode === 'i2i' ? await resolveImageInput(payload.image) : undefined
      const result = await providers.generate(
        provider,
        {
          mode: job.mode,
          prompt: job.prompt,
          negativePrompt: job.negativePrompt,
          size: job.size,
          steps: job.steps,
          guidance: job.guidance,
          seed: job.seed,
          n: payload.n,
          image,
          model: job.model,
        },
        {
          store,
          fetchImpl,
          abortSignal: controller.signal,
          onProgress: (progress) => {
            job.progress = progress
          },
        },
      )
      // 落盘 + 元数据
      const stamp = dateStamp(job.startedAt)
      const dir = join(String(config?.artifactsDir ?? ''), 'created', stamp)
      const stemBase = safeStem(`${stamp}-${provider.id}-${oneLine(job.prompt, 24).replaceAll(/\s+/g, '-')}`, 'creation')
      const saved = result.images.map((image, index) => {
        const file = writeImageFile(dir, `${stemBase}-${job.id}${result.images.length > 1 ? `-${index + 1}` : ''}`, image)
        const metaFile = join(dir, `${stemBase}-${job.id}${result.images.length > 1 ? `-${index + 1}` : ''}.json`)
        mkdirSync(dir, { recursive: true })
        writeFileSync(
          metaFile,
          `${JSON.stringify(
            {
              id: job.id,
              providerId: provider.id,
              providerLabel: provider.label ?? provider.id,
              kind: provider.kind,
              model: result.model ?? job.model,
              mode: job.mode,
              prompt: job.prompt,
              negativePrompt: job.negativePrompt,
              size: result.size ?? job.size,
              seed: job.seed ?? null,
              steps: job.steps ?? null,
              guidance: job.guidance ?? null,
              taskId: result.taskId ?? '',
              elapsedMs: result.elapsedMs,
              file: file.path,
              createdAt: new Date().toISOString(),
            },
            null,
            2,
          )}\n`,
          'utf8',
        )
        return { path: file.path, metaPath: metaFile, mime: file.mime, bytes: file.bytes }
      })
      job.images = saved
      job.status = 'succeeded'
      job.endedAt = new Date().toISOString()
      appendHistory({
        id: job.id,
        status: 'succeeded',
        providerId: provider.id,
        providerLabel: provider.label ?? provider.id,
        kind: provider.kind,
        model: result.model ?? job.model,
        mode: job.mode,
        prompt: job.prompt,
        negativePrompt: job.negativePrompt,
        size: result.size ?? job.size,
        seed: job.seed ?? null,
        steps: job.steps ?? null,
        guidance: job.guidance ?? null,
        images: saved.map((entry) => ({ path: entry.path, mime: entry.mime, bytes: entry.bytes })),
        elapsedMs: result.elapsedMs,
        createdAt: new Date().toISOString(),
      })
    } catch (error) {
      const message = error instanceof ProviderError ? error.message : error instanceof Error ? error.message : String(error)
      job.status = 'failed'
      job.error = message
      job.endedAt = new Date().toISOString()
      appendHistory({
        id: job.id,
        status: 'failed',
        providerId: provider.id,
        providerLabel: provider.label ?? provider.id,
        kind: provider.kind,
        model: job.model,
        mode: job.mode,
        prompt: job.prompt,
        negativePrompt: job.negativePrompt,
        size: job.size,
        seed: job.seed ?? null,
        images: [],
        error: message,
        elapsedMs: Date.parse(job.endedAt) - Date.parse(job.startedAt),
        createdAt: new Date().toISOString(),
      })
      try {
        devLog?.add({ level: 'error', source: 'create', tool: 'comfymcp_create', message: `创作失败：${message}`, where: provider.id })
      } catch {
        /* 留档失败不影响主流程 */
      }
    } finally {
      job.abort = null
    }
  }

  function jobView(id) {
    const job = jobs.get(String(id ?? ''))
    return job === undefined ? null : publicJob(job)
  }

  function cancel(id) {
    const job = jobs.get(String(id ?? ''))
    if (job === undefined) return { ok: false, reason: '任务不存在' }
    if (job.status !== 'running') return { ok: false, reason: `任务已${job.status === 'succeeded' ? '成功' : '失败'}` }
    try {
      job.abort?.abort()
    } catch {
      /* ignore */
    }
    return { ok: true }
  }

  function history(limit = 30) {
    const max = Math.max(1, Math.min(historyLimit, Number(limit) || 30))
    return loadHistory().slice(0, max)
  }

  /** 删除一条创作记录；deleteFiles 时同时删盘（仅允许删 created/ 下的登记文件）。 */
  function remove(id, { deleteFiles = false } = {}) {
    const items = loadHistory()
    const index = items.findIndex((item) => item.id === id)
    if (index < 0) return { ok: false, reason: '记录不存在' }
    const item = items[index]
    const removedFiles = []
    if (deleteFiles && Array.isArray(item.images)) {
      for (const image of item.images) {
        const path = String(image?.path ?? '')
        if (path.length === 0 || !existsSync(path)) continue
        if (!path.replaceAll('\\', '/').includes('/created/')) continue
        try {
          unlinkSync(path)
          removedFiles.push(path)
        } catch {
          /* ignore */
        }
      }
    }
    items.splice(index, 1)
    saveHistory(items)
    return { ok: true, removedFiles }
  }

  return { start, job: jobView, cancel, history, remove, resolveImageInput, jobs }
}

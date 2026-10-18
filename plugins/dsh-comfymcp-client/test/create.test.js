import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCreationService } from '../lib/create.js'
import { createProviderStore } from '../lib/providers/store.js'
import { createDevLog } from '../lib/devlog.js'
import { createTools } from '../lib/catalog.js'

const PNG_BYE = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082', 'hex')
const PNG_B64 = PNG_BYE.toString('base64')

let workdir
let config
let store
let devLog

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'comfymcp-create-'))
  config = { dataDir: join(workdir, 'data'), artifactsDir: join(workdir, 'artifacts') }
  store = createProviderStore({ dataDir: config.dataDir })
  store.upsert({ id: 'p1', kind: 'openai-images', baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'sk-1234567890', enabled: true })
  devLog = createDevLog({ dataDir: config.dataDir, devMode: false })
})
afterEach(async () => {
  await rm(workdir, { recursive: true, force: true })
})

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

function successFetch() {
  return async () => jsonResponse({ data: [{ b64_json: PNG_B64 }] })
}

async function waitJob(creation, jobId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const job = creation.job(jobId)
    if (job !== null && job.status !== 'running') return job
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('job did not settle in time')
}

describe('creation service', () => {
  it('runs a t2i job, saves files with sidecar metadata and appends history', async () => {
    const creation = createCreationService({ config, store, devLog, fetchImpl: successFetch() })
    const started = creation.start({ providerId: 'p1', mode: 't2i', prompt: 'a cat', size: '512x512' })
    expect(started.ok).toBe(true)
    const job = await waitJob(creation, started.jobId)
    expect(job.status).toBe('succeeded')
    expect(job.images).toHaveLength(1)
    const file = job.images[0]
    expect(existsSync(file.path)).toBe(true)
    expect(file.path.replaceAll('\\', '/')).toContain('/created/')
    expect(readFileSync(file.path).length).toBe(PNG_BYE.length)
    expect(existsSync(file.metaPath)).toBe(true)
    const meta = JSON.parse(readFileSync(file.metaPath, 'utf8'))
    expect(meta.prompt).toBe('a cat')
    expect(meta.providerId).toBe('p1')
    const history = creation.history(5)
    expect(history[0].status).toBe('succeeded')
    expect(history[0].images[0].path).toBe(file.path)
  })

  it('records failures in history and the dev log', async () => {
    const creation = createCreationService({
      config,
      store,
      devLog,
      fetchImpl: async () => jsonResponse({ error: { message: 'nope' } }, 500),
    })
    const started = creation.start({ providerId: 'p1', mode: 't2i', prompt: 'x' })
    const job = await waitJob(creation, started.jobId)
    expect(job.status).toBe('failed')
    expect(job.error).toContain('500')
    expect(creation.history(5)[0].status).toBe('failed')
    const log = readFileSync(join(config.dataDir, 'dev-log.jsonl'), 'utf8')
    expect(log).toContain('"source":"create"')
  })

  it('rejects generation without a configured provider or prompt', () => {
    const creation = createCreationService({ config, store, devLog, fetchImpl: successFetch() })
    expect(creation.start({}).ok).toBe(false) // 无提示词
    store.remove('p1')
    const empty = createCreationService({ config, store, devLog, fetchImpl: successFetch() })
    expect(empty.start({ prompt: 'x' }).ok).toBe(false) // 无服务商
    expect(empty.start({ prompt: '  ' }).ok).toBe(false)
  })

  it('supports i2i with a local reference image', async () => {
    const imagePath = join(workdir, 'ref.png')
    await writeFile(imagePath, PNG_BYE)
    let sawForm = false
    const creation = createCreationService({
      config,
      store,
      devLog,
      fetchImpl: async (url, init) => {
        if (String(url).endsWith('/images/edits')) {
          sawForm = init.body instanceof FormData
          return jsonResponse({ data: [{ b64_json: PNG_B64 }] })
        }
        return jsonResponse({ data: [{ b64_json: PNG_B64 }] })
      },
    })
    const started = creation.start({ providerId: 'p1', mode: 'i2i', prompt: 'restyle', image: imagePath })
    expect(started.ok).toBe(true)
    const job = await waitJob(creation, started.jobId)
    expect(job.status).toBe('succeeded')
    expect(sawForm).toBe(true)
  })

  it('cancels a running job', async () => {
    const creation = createCreationService({
      config,
      store,
      devLog,
      fetchImpl: async () =>
        new Promise((resolve, reject) => {
          // 永不 settle，直到被取消
          setTimeout(() => reject(new Error('aborted')), 500)
        }),
    })
    const started = creation.start({ providerId: 'p1', mode: 't2i', prompt: 'slow' })
    expect(creation.cancel(started.jobId).ok).toBe(true)
    const job = await waitJob(creation, started.jobId, 3000)
    expect(job.status).toBe('failed')
  })

  it('removes history entries and their files when requested', async () => {
    const creation = createCreationService({ config, store, devLog, fetchImpl: successFetch() })
    const started = creation.start({ providerId: 'p1', mode: 't2i', prompt: 'delete me' })
    const job = await waitJob(creation, started.jobId)
    const file = job.images[0].path
    expect(creation.remove(started.jobId, { deleteFiles: true }).ok).toBe(true)
    expect(creation.history(5)).toHaveLength(0)
    expect(existsSync(file)).toBe(false)
  })
})

describe('comfymcp_create tool', () => {
  function fakeBridge() {
    return {
      config: { endpoint: 'http://x/mcp', hostCommand: 'node', hostEntry: 'h.mjs', workflowDirs: [join(workdir, 'wf')], saveSubdir: 'sub', artifactsDir: join(workdir, 'art'), autoUnloadModel: true, requestTimeoutMs: 1000, callTimeoutMs: 2000 },
      probe: async () => ({ ok: true }),
      probeUnload: async () => ({ available: true }),
      ensureReady: async () => ({}),
      callRemote: async () => ({ structuredContent: {} }),
      fetchArtifacts: async () => ({ structuredContent: { files: [] } }),
      recordRun: (run) => ({ id: 'run-1', ...run }),
    }
  }
  function fakeDefine() {
    const definitions = []
    const define = (options) => {
      definitions.push(options)
      return { name: options.name, options }
    }
    return { define, definitions }
  }

  it('lists providers without leaking secrets', async () => {
    const creation = createCreationService({ config, store, devLog, fetchImpl: successFetch() })
    const { define, definitions } = fakeDefine()
    createTools({ define, bridge: fakeBridge(), askUser: async () => ({}), providerStore: store, creation })
    const tool = definitions.find((entry) => entry.name === 'comfymcp_create')
    const answer = await tool.execute({ action: 'providers' })
    expect(answer.ok).toBe(true)
    const provider = answer.providers.find((entry) => entry.id === 'p1')
    expect(provider.label).toContain('OpenAI 兼容图像接口')
    expect(provider.apiKey).toBeUndefined() // 工具输出绝不暴露密钥
    expect(provider.kind).toBe('openai-images')
  })

  it('generates through the creation service and returns image paths', async () => {
    const creation = createCreationService({ config, store, devLog, fetchImpl: successFetch() })
    const { define, definitions } = fakeDefine()
    createTools({ define, bridge: fakeBridge(), askUser: async () => ({}), providerStore: store, creation })
    const tool = definitions.find((entry) => entry.name === 'comfymcp_create')
    const answer = await tool.execute({ action: 'generate', providerId: 'p1', prompt: 'a cat' })
    expect(answer.ok).toBe(true)
    expect(answer.images).toHaveLength(1)
    expect(existsSync(answer.images[0].path)).toBe(true)
    expect(answer.providerId).toBe('p1')
  })

  it('reports a clear error when no provider is configured', async () => {
    const emptyStore = createProviderStore({ dataDir: join(workdir, 'empty-data') })
    const creation = createCreationService({ config, store: emptyStore, devLog, fetchImpl: successFetch() })
    const { define, definitions } = fakeDefine()
    createTools({ define, bridge: fakeBridge(), askUser: async () => ({}), providerStore: emptyStore, creation })
    const tool = definitions.find((entry) => entry.name === 'comfymcp_create')
    const answer = await tool.execute({ action: 'generate', prompt: 'x' })
    expect(answer.ok).toBe(false)
    expect(answer.error).toContain('服务商')
  })
})

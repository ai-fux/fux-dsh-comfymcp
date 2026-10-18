import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createProviderStore, normalizeProvider, checkBaseUrl, maskKey, PROVIDER_KINDS } from '../lib/providers/store.js'
import { detectMime, decodeDataUrl, readImageResult, writeImageFile, extensionFor } from '../lib/providers/image.js'
import { generate as generateViaIndex, testProvider, PROVIDER_PRESETS } from '../lib/providers/index.js'
import * as modelscope from '../lib/providers/modelscope.js'
import * as huggingface from '../lib/providers/huggingface.js'
import * as sdwebui from '../lib/providers/sdwebui.js'
import * as ollama from '../lib/providers/ollama.js'
import { generateOpenAICompat } from '../lib/providers/openai-compat.js'
import { ProviderError } from '../lib/providers/errors.js'

const PNG_BYE = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082', 'hex')
const PNG_B64 = PNG_BYE.toString('base64')

let workdir
beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'comfymcp-providers-'))
})
afterEach(async () => {
  await rm(workdir, { recursive: true, force: true })
})

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

function makeProvider(overrides = {}) {
  return {
    id: 'p1',
    label: 'test',
    kind: 'openai-images',
    baseUrl: 'https://api.example.com/v1',
    apiKey: '',
    model: 'gpt-image-1',
    enabled: true,
    allowPrivateHosts: false,
    capabilities: ['t2i'],
    defaults: {},
    timeoutMs: 5000,
    pollIntervalMs: 10,
    ...overrides,
  }
}

describe('providers.store', () => {
  it('normalizes and validates a provider', () => {
    const { value, error } = normalizeProvider({
      id: 'ms-qwen',
      label: '魔搭',
      kind: 'modelscope',
      baseUrl: 'https://api-inference.modelscope.cn',
      model: 'Qwen/Qwen-Image',
      apiKey: 'env:MS_TOKEN',
      capabilities: ['t2i', 'i2i'],
      defaults: { size: '1024x1024', steps: 30 },
    })
    expect(error).toBeUndefined()
    expect(value.kind).toBe('modelscope')
    expect(value.capabilities).toEqual(['t2i', 'i2i'])
    expect(value.defaults.size).toBe('1024x1024')
    expect(value.defaults.steps).toBe(30)
  })

  it('rejects invalid ids, kinds, urls and missing models', () => {
    expect(normalizeProvider({ id: 'UPPER', kind: 'openai-images', baseUrl: 'https://x.com', model: 'm' }).error).toContain('id')
    expect(normalizeProvider({ id: 'ok', kind: 'nope', baseUrl: 'https://x.com', model: 'm' }).error).toContain('kind')
    expect(normalizeProvider({ id: 'ok', kind: 'openai-images', baseUrl: 'ftp://x.com', model: 'm' }).error).toContain('http')
    expect(normalizeProvider({ id: 'ok', kind: 'openai-images', baseUrl: 'https://x.com', model: '' }).error).toContain('model')
    // sdwebui 允许空模型（用当前加载）
    expect(normalizeProvider({ id: 'ok', kind: 'sdwebui', baseUrl: 'https://x.com', model: '' }).error).toBeUndefined()
  })

  it('blocks private hosts unless explicitly allowed', () => {
    expect(checkBaseUrl('http://localhost:11434/v1', { allowPrivateHosts: true })).toBe('')
    expect(checkBaseUrl('http://localhost:11434/v1', { allowPrivateHosts: false })).toContain('私网')
    expect(checkBaseUrl('http://192.168.1.2:7860', {})).toContain('私网')
    expect(checkBaseUrl('https://api.example.com/v1', {})).toBe('')
  })

  it('masks keys and keeps masked values on upsert', () => {
    expect(maskKey('env:MS_TOKEN')).toBe('env:MS_TOKEN')
    expect(maskKey('sk-abcdefghijklmnop')).toBe('sk-****mnop')
    const store = createProviderStore({ dataDir: workdir })
    expect(store.upsert({ id: 'p1', kind: 'openai-images', baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'sk-1234567890abcdef' }).ok).toBe(true)
    const masked = store.list().providers[0]
    expect(masked.apiKey).toBe('sk-****cdef')
    // 回传掩码 → 保留原值
    const outcome = store.upsert({ ...masked, label: 'renamed' })
    expect(outcome.ok).toBe(true)
    expect(store.all().providers[0].apiKey).toBe('sk-1234567890abcdef')
    expect(store.all().providers[0].label).toBe('renamed')
  })

  it('persists providers, default id and removal', () => {
    const store = createProviderStore({ dataDir: workdir })
    store.upsert({ id: 'a', kind: 'openai-images', baseUrl: 'https://a.example.com/v1', model: 'm' })
    store.upsert({ id: 'b', kind: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'x/z-image-turbo', allowPrivateHosts: true })
    expect(store.list().defaultId).toBe('a')
    expect(store.setDefault('b').ok).toBe(true)
    expect(store.list().defaultId).toBe('b')
    const reloaded = createProviderStore({ dataDir: workdir })
    expect(reloaded.list().providers.map((provider) => provider.id)).toEqual(['a', 'b'])
    expect(reloaded.list().defaultId).toBe('b')
    expect(reloaded.remove('b').ok).toBe(true)
    expect(reloaded.list().defaultId).toBe('a')
    expect(reloaded.remove('nope').ok).toBe(false)
  })

  it('resolves env: key references at call time', () => {
    const store = createProviderStore({ dataDir: workdir })
    store.upsert({ id: 'e', kind: 'openai-images', baseUrl: 'https://a.example.com/v1', model: 'm', apiKey: 'env:COMFYMCP_TEST_KEY' })
    process.env.COMFYMCP_TEST_KEY = 'sk-from-env'
    expect(store.resolveKey(store.find('e'))).toBe('sk-from-env')
    delete process.env.COMFYMCP_TEST_KEY
    expect(store.resolveKey(store.find('e'))).toBe('')
  })

  it('exposes presets covering all kinds', () => {
    const kinds = new Set(PROVIDER_PRESETS.map((preset) => preset.kind))
    for (const kind of PROVIDER_KINDS) expect(kinds.has(kind)).toBe(true)
  })
})

describe('providers.image', () => {
  it('detects mime from magic bytes', () => {
    expect(detectMime(PNG_BYE)).toBe('image/png')
    expect(detectMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(detectMime(Buffer.from('RIFF0000WEBP', 'ascii'))).toBe('image/webp')
    expect(detectMime(Buffer.from('GIF89a', 'ascii'))).toBe('image/gif')
    expect(detectMime(Buffer.from('BM', 'ascii'))).toBe('image/bmp')
    expect(extensionFor('image/png')).toBe('.png')
  })

  it('decodes data urls and base64', async () => {
    const dataUrl = `data:image/png;base64,${PNG_B64}`
    expect(decodeDataUrl(dataUrl)?.bytes.length).toBe(PNG_BYE.length)
    const fromUrl = await readImageResult(dataUrl)
    expect(fromUrl.mime).toBe('image/png')
    const fromB64 = await readImageResult(PNG_B64)
    expect(fromB64.bytes.length).toBe(PNG_BYE.length)
  })

  it('downloads images from urls via injected fetch', async () => {
    const fetchImpl = async () => new Response(PNG_BYE, { status: 200, headers: { 'content-type': 'image/png' } })
    const image = await readImageResult('https://img.example.com/x.png', { fetchImpl })
    expect(image.mime).toBe('image/png')
    expect(image.bytes.length).toBe(PNG_BYE.length)
  })

  it('writes files with unique names', async () => {
    const first = writeImageFile(workdir, 'demo', { bytes: PNG_BYE, mime: 'image/png' })
    const second = writeImageFile(workdir, 'demo', { bytes: PNG_BYE, mime: 'image/png' })
    expect(first.path).not.toBe(second.path)
    expect(existsSync(first.path)).toBe(true)
    expect(readFileSync(first.path).length).toBe(PNG_BYE.length)
  })
})

describe('providers.openai-compat', () => {
  it('generates t2i with b64 response', async () => {
    const provider = makeProvider()
    const fetchImpl = async (url, init) => {
      expect(url).toBe('https://api.example.com/v1/images/generations')
      const body = JSON.parse(init.body)
      expect(body.model).toBe('gpt-image-1')
      expect(body.prompt).toBe('a cat')
      expect(body.response_format).toBe('b64_json')
      return jsonResponse({ data: [{ b64_json: PNG_B64 }] })
    }
    const result = await generateOpenAICompat(provider, { mode: 't2i', prompt: 'a cat' }, { fetchImpl, apiKey: 'sk-x' })
    expect(result.images).toHaveLength(1)
    expect(result.images[0].mime).toBe('image/png')
  })

  it('generates i2i through /images/edits multipart', async () => {
    const provider = makeProvider()
    const fetchImpl = async (url, init) => {
      expect(url).toBe('https://api.example.com/v1/images/edits')
      expect(init.body instanceof FormData).toBe(true)
      expect(init.body.get('prompt')).toBe('restyle')
      return jsonResponse({ data: [{ b64_json: PNG_B64 }] })
    }
    const result = await generateOpenAICompat(provider, { mode: 'i2i', prompt: 'restyle', image: { bytes: PNG_BYE, mime: 'image/png' } }, { fetchImpl, apiKey: 'sk-x' })
    expect(result.images).toHaveLength(1)
  })

  it('maps 401 to a readable invalid-key error', async () => {
    const provider = makeProvider()
    const fetchImpl = async () => jsonResponse({ error: { message: 'bad key' } }, 401)
    await expect(generateOpenAICompat(provider, { mode: 't2i', prompt: 'x' }, { fetchImpl, apiKey: 'sk' })).rejects.toMatchObject({ code: 'invalid_key' })
  })

  it('polls task endpoints when the response only has a task id', async () => {
    const provider = makeProvider()
    let polls = 0
    const fetchImpl = async (url) => {
      if (url.endsWith('/images/generations')) return jsonResponse({ task_id: 't1' })
      polls += 1
      if (polls < 2) return jsonResponse({ status: 'running' })
      return jsonResponse({ status: 'completed', data: [{ b64_json: PNG_B64 }] })
    }
    const result = await generateOpenAICompat(provider, { mode: 't2i', prompt: 'x' }, { fetchImpl, apiKey: 'sk' })
    expect(polls).toBe(2)
    expect(result.images).toHaveLength(1)
  })
})

describe('providers.modelscope', () => {
  it('submits async task and polls /v1/tasks with ModelScope headers', async () => {
    const provider = makeProvider({ kind: 'modelscope', baseUrl: 'https://api-inference.modelscope.cn', model: 'Qwen/Qwen-Image', pollIntervalMs: 5 })
    const headers = {}
    let polls = 0
    const fetchImpl = async (url, init) => {
      if (url.endsWith('/v1/images/generations')) {
        headers.async = init.headers['X-ModelScope-Async-Mode']
        return jsonResponse({ task_id: 'task-1' })
      }
      if (url.endsWith('/v1/tasks/task-1')) {
        expect(init.headers['X-ModelScope-Task-Type']).toBe('image_generation')
        polls += 1
        if (polls === 1) return jsonResponse({ task_status: 'RUNNING' })
        return jsonResponse({ task_status: 'SUCCEED', output_images: ['https://img.example.com/a.png'] })
      }
      // 图片下载
      return new Response(PNG_BYE, { status: 200, headers: { 'content-type': 'image/png' } })
    }
    const result = await modelscope.generate(provider, { mode: 't2i', prompt: 'cat' }, { fetchImpl, apiKey: 'ms-token' })
    expect(headers.async).toBe('true')
    expect(polls).toBe(2)
    expect(result.taskId).toBe('task-1')
    expect(result.images[0].mime).toBe('image/png')
  })

  it('surfaces FAILED tasks with the server error text', async () => {
    const provider = makeProvider({ kind: 'modelscope', baseUrl: 'https://api-inference.modelscope.cn', pollIntervalMs: 5 })
    const fetchImpl = async (url) => {
      if (url.endsWith('/v1/images/generations')) return jsonResponse({ task_id: 't2' })
      return jsonResponse({ task_status: 'FAILED', errors: 'model busy' })
    }
    await expect(modelscope.generate(provider, { mode: 't2i', prompt: 'x' }, { fetchImpl, apiKey: 'k' })).rejects.toMatchObject({ code: 'task_failed' })
  })
})

describe('providers.huggingface', () => {
  it('supports the legacy binary inference endpoint', async () => {
    const provider = makeProvider({ kind: 'huggingface', baseUrl: 'https://api-inference.huggingface.co', model: 'black-forest-labs/FLUX.1-schnell', legacy: true })
    const fetchImpl = async (url, init) => {
      expect(url).toBe('https://api-inference.huggingface.co/models/black-forest-labs/FLUX.1-schnell')
      expect(JSON.parse(init.body).inputs).toBe('a dog')
      return new Response(PNG_BYE, { status: 200, headers: { 'content-type': 'image/png' } })
    }
    const result = await huggingface.generate(provider, { mode: 't2i', prompt: 'a dog' }, { fetchImpl, apiKey: 'hf' })
    expect(result.images[0].mime).toBe('image/png')
  })

  it('defaults to the router OpenAI-compatible protocol', async () => {
    const provider = makeProvider({ kind: 'huggingface', baseUrl: 'https://router.huggingface.co/v1', model: 'stabilityai/stable-diffusion-xl-base-1.0' })
    const fetchImpl = async (url) => {
      expect(url).toBe('https://router.huggingface.co/v1/images/generations')
      return jsonResponse({ data: [{ b64_json: PNG_B64 }] })
    }
    const result = await huggingface.generate(provider, { mode: 't2i', prompt: 'x' }, { fetchImpl, apiKey: 'hf' })
    expect(result.images).toHaveLength(1)
  })
})

describe('providers.sdwebui', () => {
  it('calls txt2img with parameters', async () => {
    const provider = makeProvider({ kind: 'sdwebui', baseUrl: 'http://127.0.0.1:7860', model: '', allowPrivateHosts: true })
    const fetchImpl = async (url, init) => {
      expect(url).toBe('http://127.0.0.1:7860/sdapi/v1/txt2img')
      const body = JSON.parse(init.body)
      expect(body.prompt).toBe('cat')
      expect(body.width).toBe(512)
      expect(body.height).toBe(512)
      return jsonResponse({ images: [PNG_B64] })
    }
    const result = await sdwebui.generate(provider, { mode: 't2i', prompt: 'cat', size: '512x512' }, { fetchImpl })
    expect(result.images[0].mime).toBe('image/png')
  })

  it('calls img2img with init images', async () => {
    const provider = makeProvider({ kind: 'sdwebui', baseUrl: 'http://127.0.0.1:7860', model: '', allowPrivateHosts: true })
    const fetchImpl = async (url, init) => {
      expect(url).toBe('http://127.0.0.1:7860/sdapi/v1/img2img')
      const body = JSON.parse(init.body)
      expect(body.init_images[0]).toBe(PNG_B64)
      expect(body.denoising_strength).toBeGreaterThan(0)
      return jsonResponse({ images: [PNG_B64] })
    }
    const result = await sdwebui.generate(provider, { mode: 'i2i', prompt: 'x', image: { bytes: PNG_BYE, mime: 'image/png' } }, { fetchImpl })
    expect(result.images).toHaveLength(1)
  })
})

describe('providers.ollama', () => {
  it('rejects i2i with an explicit unsupported error', async () => {
    const provider = makeProvider({ kind: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'x/z-image-turbo', allowPrivateHosts: true })
    await expect(ollama.generate(provider, { mode: 'i2i', prompt: 'x', image: { bytes: PNG_BYE, mime: 'image/png' } }, { fetchImpl: async () => jsonResponse({}) })).rejects.toMatchObject({ code: 'unsupported' })
  })

  it('generates t2i through the OpenAI-compatible endpoint', async () => {
    const provider = makeProvider({ kind: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'x/z-image-turbo', allowPrivateHosts: true })
    const fetchImpl = async (url) => {
      expect(url).toBe('http://localhost:11434/v1/images/generations')
      return jsonResponse({ data: [{ b64_json: PNG_B64 }] })
    }
    const result = await ollama.generate(provider, { mode: 't2i', prompt: 'cat' }, { fetchImpl })
    expect(result.images).toHaveLength(1)
  })
})

describe('providers.index', () => {
  it('rejects disabled providers and missing keys for keyed kinds', async () => {
    const store = createProviderStore({ dataDir: workdir })
    store.upsert({ id: 'p1', kind: 'openai-images', baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: '', enabled: true })
    const provider = store.find('p1')
    await expect(generateViaIndex(provider, { mode: 't2i', prompt: 'x' }, { store, fetchImpl: async () => jsonResponse({}) })).rejects.toMatchObject({ code: 'invalid_key' })
    const disabled = { ...provider, enabled: false }
    await expect(generateViaIndex(disabled, { mode: 't2i', prompt: 'x' }, { store })).rejects.toMatchObject({ code: 'disabled' })
    await expect(generateViaIndex({ ...provider, kind: 'nope' }, { mode: 't2i', prompt: 'x' }, { store })).rejects.toThrow()
    await expect(generateViaIndex(provider, { mode: 't2i', prompt: '  ' }, { store })).rejects.toMatchObject({ code: 'bad_request' })
  })

  it('runs the full generate path with env-resolved keys', async () => {
    process.env.COMFYMCP_IT_KEY = 'sk-it'
    const store = createProviderStore({ dataDir: workdir })
    store.upsert({ id: 'it', kind: 'openai-images', baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'env:COMFYMCP_IT_KEY' })
    const fetchImpl = async (url, init) => {
      expect(init.headers.authorization).toBe('Bearer sk-it')
      return jsonResponse({ data: [{ b64_json: PNG_B64 }] })
    }
    const result = await generateViaIndex(store.find('it'), { mode: 't2i', prompt: 'x' }, { store, fetchImpl })
    expect(result.images).toHaveLength(1)
    delete process.env.COMFYMCP_IT_KEY
  })

  it('tests connectivity through /models and reports failures', async () => {
    const store = createProviderStore({ dataDir: workdir })
    store.upsert({ id: 't1', kind: 'openai-images', baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'k' })
    const ok = await testProvider(store.find('t1'), {
      store,
      fetchImpl: async () => jsonResponse({ data: [{ id: 'm1' }, { id: 'm2' }] }),
    })
    expect(ok.ok).toBe(true)
    expect(ok.models).toEqual(['m1', 'm2'])
    const bad = await testProvider(store.find('t1'), {
      store,
      fetchImpl: async () => jsonResponse({ error: { message: 'no' } }, 401),
    })
    expect(bad.ok).toBe(false)
  })

  it('accepts 404 on /models as reachable (OpenAI-compatible gateways vary)', async () => {
    const store = createProviderStore({ dataDir: workdir })
    store.upsert({ id: 't2', kind: 'vllm', baseUrl: 'http://127.0.0.1:8000/v1', model: 'm', allowPrivateHosts: true })
    const outcome = await testProvider(store.find('t2'), { store, fetchImpl: async () => jsonResponse({}, 404) })
    expect(outcome.ok).toBe(true)
  })
})

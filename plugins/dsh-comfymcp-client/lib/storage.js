/**
 * 插件自有文件目录管理的通用存储接口（拟定协议）。
 *
 * 统一形状：key 为相对路径（POSIX 分隔，不允许 `..`），value 为 Buffer/字符串。
 * 每个提供者实现五个方法：
 *   list(prefix?)  → [{ key, size, modifiedAt, kind }]
 *   get(key)       → { bytes, contentType }
 *   put(key, bytes)=> { key, size }
 *   remove(key)    → {}
 *   url(key)       → 可访问地址（本地=环回控制端点 /artifact；对象存储=签名或直链）
 *
 * 三个实现：
 *   createLocalStorage  — artifactsDir 本地目录（默认）
 *   createMinioStorage  — S3 V4 签名 REST，兼容 MinIO / 任何 S3 兼容存储（path-style）
 *   createOssStorage    — 阿里云 OSS V4 签名 REST
 * resolveStorage(config) 按 config.storage 选择（local|minio|oss）。
 */
import { createHash, createHmac } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, posix, sep } from 'node:path'

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.mkv'])

export function kindForKey(key) {
  const ext = posix.extname(String(key)).toLowerCase()
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (VIDEO_EXTS.has(ext)) return 'video'
  return 'file'
}

/** 规范 key：POSIX 分隔、去空段、拒绝 `..` 与绝对路径。 */
export function normalizeKey(key) {
  const parts = String(key ?? '')
    .replaceAll('\\', '/')
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.')
  if (parts.includes('..')) throw new Error(`storage key 不得包含 "..": ${key}`)
  const normalized = parts.join('/')
  if (normalized.length === 0) throw new Error('storage key 不能为空')
  return normalized
}

function contentTypeForKey(key) {
  const ext = posix.extname(String(key)).toLowerCase()
  const table = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
    '.json': 'application/json',
    '.txt': 'text/plain',
  }
  return table[ext] ?? 'application/octet-stream'
}

function entryFor(key, size, modifiedAt) {
  return { key, size, modifiedAt, kind: kindForKey(key), filename: posix.basename(key) }
}

async function requestJsonOrText(url, init) {
  const response = await fetch(url, init)
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`storage request failed: HTTP ${response.status} ${text.slice(0, 200)}`)
  }
  return response
}

/* ─────────────────────────── 本地目录 ─────────────────────────── */

export function createLocalStorage({ rootDir }) {
  if (typeof rootDir !== 'string' || rootDir.trim().length === 0) {
    throw new Error('local storage 需要 rootDir（产物目录）')
  }
  const root = rootDir.trim()
  const absOf = (key) => {
    const normalized = normalizeKey(key)
    const abs = join(root, ...normalized.split('/'))
    return { normalized, abs }
  }
  return {
    id: 'local',
    async list(prefix = '') {
      const base = prefix.length > 0 ? join(root, ...normalizeKey(prefix).split('/')) : root
      if (!existsSync(base)) return []
      const out = []
      const walk = (dir, rel) => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name)
          const relKey = rel.length > 0 ? `${rel}/${name}` : name
          const stats = statSync(full)
          if (stats.isDirectory()) walk(full, relKey)
          else out.push(entryFor(relKey, stats.size, stats.mtime.toISOString()))
        }
      }
      walk(base, '')
      return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
    },
    async get(key) {
      const { abs } = absOf(key)
      if (!existsSync(abs)) throw new Error(`file gone: ${key}`)
      const stats = statSync(abs)
      if (stats.size > 256 * 1024 * 1024) throw new Error('file too large')
      return { bytes: readFileSync(abs), contentType: contentTypeForKey(key) }
    },
    async put(key, bytes) {
      const { normalized, abs } = absOf(key)
      mkdirSync(abs.slice(0, abs.length - basename(abs).length), { recursive: true })
      writeFileSync(abs, bytes)
      return { key: normalized, size: Buffer.byteLength(bytes) }
    },
    async remove(key) {
      const { abs } = absOf(key)
      if (existsSync(abs)) rmSync(abs)
      return {}
    },
    url(key) {
      return `/artifact?path=${encodeURIComponent(join(root, ...normalizeKey(key).split('/')))}`
    },
  }
}

/* ─────────────────────── 签名工具（V4 / OSS） ─────────────────────── */

function hmacSha256(key, payload) {
  return createHmac('sha256', key).update(payload).digest()
}
function sha256Hex(payload) {
  return createHash('sha256').update(payload).digest('hex')
}

/** S3 V4 派生签名密钥（导出供 AWS 官方测试向量校验）。 */
export function s3SigningKey(secretAccessKey, dateStamp, region, service = 's3') {
  return hmacSha256(hmacSha256(hmacSha256(hmacSha256(`AWS4${secretAccessKey}`, dateStamp), region), service), 'aws4_request')
}

function amzDateNow() {
  return new Date().toISOString().replaceAll('-', '').replaceAll(':', '').replace(/\.\d{3}/, '')
}

/** S3 V4 签名请求头（SigV4，适用于 MinIO 与一切 S3 兼容存储，path-style）。 */
export function signS3Request({ method, url, headers = {}, body = '', accessKeyId, secretAccessKey, region, service = 's3', now }) {
  const parsed = new URL(url)
  const amzDate = typeof now === 'string' ? now : amzDateNow()
  const dateStamp = amzDate.slice(0, 8)
  const payloadHash = sha256Hex(body)
  const baseHeaders = {
    host: parsed.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
  }
  const sortedKeys = Object.keys(baseHeaders).sort()
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${baseHeaders[k].trim()}\n`).join('')
  const signedHeaders = sortedKeys.join(';')
  const canonicalRequest = [method, parsed.pathname, parsed.search.replace(/^\?/, ''), canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const scope = `${dateStamp}/${region}/${service}/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n')
  const signature = createHmac('sha256', s3SigningKey(secretAccessKey, dateStamp, region, service)).update(stringToSign).digest('hex')
  return {
    ...baseHeaders,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
}

/** 阿里云 OSS V4 签名请求头。 */
export function signOssRequest({ method, url, headers = {}, body = '', accessKeyId, secretAccessKey, region, now }) {
  const parsed = new URL(url)
  const amzDate = typeof now === 'string' ? now : amzDateNow()
  const dateStamp = amzDate.slice(0, 8)
  const payloadHash = sha256Hex(body)
  const baseHeaders = {
    host: parsed.host,
    'x-oss-content-sha256': 'UNSIGNED-PAYLOAD',
    'x-oss-date': amzDate,
    ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
  }
  const sortedKeys = Object.keys(baseHeaders).sort()
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${baseHeaders[k].trim()}\n`).join('')
  const signedHeaders = sortedKeys.join(';')
  const canonicalRequest = [method, parsed.pathname, parsed.search.replace(/^\?/, ''), canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const scope = `${dateStamp}/${region}/oss/aliyun_v4_request`
  const stringToSign = ['OSS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n')
  const signingKey = hmacSha256(hmacSha256(hmacSha256(hmacSha256(`aliyun_v4${secretAccessKey}`, dateStamp), region), 'oss'), 'aliyun_v4_request')
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')
  return {
    ...baseHeaders,
    authorization: `OSS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
}

/* ───────────────────────── S3 / MinIO ───────────────────────── */

export function createMinioStorage({ endpoint, bucket, accessKeyId, secretAccessKey, region = 'us-east-1', prefix = '' }) {
  const base = String(endpoint ?? '').replace(/\/+$/, '')
  if (base.length === 0 || !bucket) throw new Error('minio storage 需要 endpoint 与 bucket')
  const keyOf = (key) => {
    const normalized = normalizeKey(key)
    return prefix.length > 0 ? `${normalizeKey(prefix)}/${normalized}` : normalized
  }
  const signedFetch = async (method, key, body = '', headers = {}) => {
    const url = `${base}/${bucket}/${keyOf(key).split('/').map(encodeURIComponent).join('/')}`
    const signed = signS3Request({ method, url, headers, body, accessKeyId, secretAccessKey, region })
    return requestJsonOrText(url, { method, headers: signed, body: body.length > 0 ? body : undefined })
  }
  return {
    id: 'minio',
    async list(prefixArg = '') {
      // 生效前缀 = 调用方前缀（相对）叠 加配置前缀；无调用方前缀时用配置前缀目录
      const fullPrefix = prefixArg.length > 0
        ? keyOf(prefixArg)
        : prefix.length > 0
          ? `${normalizeKey(prefix)}/`
          : ''
      const query = new URLSearchParams({ 'list-type': '2', ...(fullPrefix.length > 0 ? { prefix: fullPrefix } : {}) })
      const url = `${base}/${bucket}/?${query.toString()}`
      const signed = signS3Request({ method: 'GET', url, headers: {}, body: '', accessKeyId, secretAccessKey, region })
      const response = await requestJsonOrText(url, { method: 'GET', headers: signed })
      const text = await response.text()
      const contents = [...text.matchAll(/<Key>([^<]+)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>[\s\S]*?<LastModified>([^<]+)<\/LastModified>/g)]
      return contents.map(([, key, size, modified]) => {
        const rel = prefix.length > 0 && key.startsWith(`${normalizeKey(prefix)}/`) ? key.slice(normalizeKey(prefix).length + 1) : key
        return entryFor(rel, Number(size), new Date(modified).toISOString())
      })
    },
    async get(key) {
      const response = await signedFetch('GET', key)
      const buffer = Buffer.from(await response.arrayBuffer())
      return { bytes: buffer, contentType: response.headers.get('content-type') ?? contentTypeForKey(key) }
    },
    async put(key, bytes) {
      const payload = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes))
      await signedFetch('PUT', key, payload, { 'content-type': contentTypeForKey(key) })
      return { key: normalizeKey(key), size: payload.byteLength }
    },
    async remove(key) {
      await signedFetch('DELETE', key)
      return {}
    },
    url(key) {
      return `${base}/${bucket}/${keyOf(key).split('/').map(encodeURIComponent).join('/')}`
    },
  }
}

/* ───────────────────────── 阿里云 OSS ───────────────────────── */

export function createOssStorage({ endpoint, bucket, accessKeyId, secretAccessKey, region = 'cn-chengdu', prefix = '' }) {
  const base = String(endpoint ?? '').replace(/\/+$/, '')
  if (base.length === 0 || !bucket) throw new Error('oss storage 需要 endpoint 与 bucket')
  const keyOf = (key) => {
    const normalized = normalizeKey(key)
    return prefix.length > 0 ? `${normalizeKey(prefix)}/${normalized}` : normalized
  }
  const signedFetch = async (method, key, body = '', headers = {}) => {
    const url = `${base}/${keyOf(key).split('/').map(encodeURIComponent).join('/')}`
    const signed = signOssRequest({ method, url, headers, body: Buffer.isBuffer(body) ? body : '', accessKeyId, secretAccessKey, region })
    return requestJsonOrText(url, { method, headers: signed, body: body.length > 0 ? body : undefined })
  }
  return {
    id: 'oss',
    async list(prefixArg = '') {
      const scope = prefixArg.length > 0 ? keyOf(prefixArg) : prefix.length > 0 ? `${normalizeKey(prefix)}/` : ''
      const query = new URLSearchParams({ ...(scope.length > 0 ? { prefix: scope } : {}), 'max-keys': '200' })
      const url = `${base}/?${query.toString()}`
      const signed = signOssRequest({ method: 'GET', url, headers: {}, body: '', accessKeyId, secretAccessKey, region })
      const response = await requestJsonOrText(url, { method: 'GET', headers: signed })
      const text = await response.text()
      const contents = [...text.matchAll(/<Key>([^<]+)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>[\s\S]*?<LastModified>([^<]+)<\/LastModified>/g)]
      return contents.map(([, key, size, modified]) => {
        const rel = scope.length > 0 && key.startsWith(scope) ? key.slice(scope.length).replace(/^\//, '') : key
        return entryFor(rel, Number(size), new Date(modified).toISOString())
      })
    },
    async get(key) {
      const response = await signedFetch('GET', key)
      const buffer = Buffer.from(await response.arrayBuffer())
      return { bytes: buffer, contentType: response.headers.get('content-type') ?? contentTypeForKey(key) }
    },
    async put(key, bytes) {
      const payload = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes))
      await signedFetch('PUT', key, payload, { 'content-type': contentTypeForKey(key) })
      return { key: normalizeKey(key), size: payload.byteLength }
    },
    async remove(key) {
      await signedFetch('DELETE', key)
      return {}
    },
    url(key) {
      return `${base}/${keyOf(key).split('/').map(encodeURIComponent).join('/')}`
    },
  }
}

/* ───────────────────────── 工厂 ───────────────────────── */

/**
 * @param config { storage, artifactsDir, storageEndpoint, storageBucket,
 *                 storageRegion, storageAccessKey, storageSecret, storagePrefix }
 */
export function resolveStorage(config = {}) {
  const kind = String(config.storage ?? 'local').toLowerCase()
  if (kind === 'minio') {
    return createMinioStorage({
      endpoint: config.storageEndpoint,
      bucket: config.storageBucket,
      accessKeyId: config.storageAccessKey,
      secretAccessKey: config.storageSecret,
      region: config.storageRegion,
      prefix: config.storagePrefix,
    })
  }
  if (kind === 'oss') {
    return createOssStorage({
      endpoint: config.storageEndpoint,
      bucket: config.storageBucket,
      accessKeyId: config.storageAccessKey,
      secretAccessKey: config.storageSecret,
      region: config.storageRegion,
      prefix: config.storagePrefix,
    })
  }
  // 本地默认：产物目录未配置时落到进程工作区的 artifacts/（面板可改）
  return createLocalStorage({ rootDir: config.artifactsDir ?? join(process.cwd(), 'artifacts') })
}

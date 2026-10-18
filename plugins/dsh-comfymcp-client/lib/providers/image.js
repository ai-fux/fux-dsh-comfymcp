/**
 * 图片字节处理：类型嗅探、b64/URL/dataURL 解码、落盘。
 *
 * 插件零依赖（不引 sharp 等），只用 Node 内置：
 * - magic bytes 判定 MIME 与扩展名（服务商可能返回 png/jpeg/webp）；
 * - 下载 URL 时限制大小（默认 24MB），防止误拉大文件；
 * - 落盘走 临时文件 + rename，避免半截文件。
 */
import { mkdirSync, renameSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MAX_IMAGE_BYTES = 24 * 1024 * 1024

/** 按 magic bytes 判类型；未知返回 application/octet-stream。 */
export function detectMime(bytes) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes ?? [])
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (bytes.length >= 6 && bytes.toString('ascii', 0, 6) === 'GIF87a') return 'image/gif'
  if (bytes.length >= 6 && bytes.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif'
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp'
  return 'application/octet-stream'
}

export function extensionFor(mime) {
  if (mime === 'image/png') return '.png'
  if (mime === 'image/jpeg') return '.jpg'
  if (mime === 'image/webp') return '.webp'
  if (mime === 'image/gif') return '.gif'
  if (mime === 'image/bmp') return '.bmp'
  return '.bin'
}

/** 文件名主干净化：只留字母数字与 -_，空则 image。 */
export function safeStem(name, fallback = 'image') {
  const cleaned = String(name ?? '')
    .replaceAll(/[^\w\u4e00-\u9fa5.-]+/gu, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 60)
  return cleaned.length > 0 ? cleaned : fallback
}

/** 解码 data URL（data:image/png;base64,...）。 */
export function decodeDataUrl(text) {
  const match = /^data:([\w/+.-]+);base64,(.+)$/s.exec(String(text ?? ''))
  if (match === null) return null
  return { mime: match[1], bytes: Buffer.from(match[2], 'base64') }
}

/**
 * 从服务商响应里取图片：支持 b64_json / base64 / b64 / url / data url。
 * @returns {Promise<{bytes: Buffer, mime: string}>}
 */
export async function readImageResult(source, { fetchImpl = globalThis.fetch, timeoutMs = 120000, abortSignal } = {}) {
  if (source === null || source === undefined) throw new Error('服务商未返回图片数据')
  if (typeof source === 'string') {
    if (source.startsWith('data:')) {
      const decoded = decodeDataUrl(source)
      if (decoded !== null) return { bytes: decoded.bytes, mime: decoded.mime !== '' ? decoded.mime : detectMime(decoded.bytes) }
      throw new Error('返回的 data URL 无法解析')
    }
    if (/^https?:\/\//i.test(source)) {
      const response = await fetchImpl(source, {
        method: 'GET',
        ...(abortSignal !== undefined ? { signal: abortSignal } : {}),
      })
      if (!response.ok) throw new Error(`图片下载失败（HTTP ${response.status}）`)
      const length = Number(response.headers?.get?.('content-length') ?? '0')
      if (length > MAX_IMAGE_BYTES) throw new Error(`图片超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB 上限`)
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error(`图片超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB 上限`)
      return { bytes, mime: detectMime(bytes) }
    }
    // 纯 base64（无前缀）
    if (/^[A-Za-z0-9+/=\s]+$/.test(source) && source.length > 64) {
      const bytes = Buffer.from(source.replaceAll(/\s+/g, ''), 'base64')
      return { bytes, mime: detectMime(bytes) }
    }
    throw new Error('无法识别的图片数据格式')
  }
  if (typeof source === 'object') {
    if (typeof source.b64_json === 'string') return readImageResult(source.b64_json)
    if (typeof source.b64 === 'string') return readImageResult(source.b64)
    if (typeof source.base64 === 'string') return readImageResult(source.base64)
    if (typeof source.url === 'string') return readImageResult(source.url)
    if (source.bytes !== undefined) {
      const bytes = Buffer.isBuffer(source.bytes) ? source.bytes : Buffer.from(source.bytes)
      return { bytes, mime: detectMime(bytes) }
    }
  }
  throw new Error('服务商返回的图片字段无法识别（期望 b64_json / url / base64）')
}

/** 本地文件（含相对 artifactsDir 的路径）读取为图片。 */
export function readLocalImage(path) {
  const bytes = readFileSync(path)
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error(`图片超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB 上限`)
  return { bytes, mime: detectMime(bytes) }
}

export function fileSizeOf(path) {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/** 落盘：<dir>/<stem><ext>，原子写（tmp → rename）。返回 {path, mime, bytes}。 */
export function writeImageFile(dir, stem, image) {
  mkdirSync(dir, { recursive: true })
  const mime = image.mime && image.mime !== 'application/octet-stream' ? image.mime : detectMime(image.bytes)
  const ext = extensionFor(mime)
  const base = safeStem(stem)
  let path = join(dir, `${base}${ext}`)
  let counter = 1
  while (existsFile(path)) {
    path = join(dir, `${base}-${counter}${ext}`)
    counter += 1
  }
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, image.bytes)
  renameSync(tmp, path)
  return { path, mime, bytes: image.bytes.byteLength }
}

function existsFile(path) {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

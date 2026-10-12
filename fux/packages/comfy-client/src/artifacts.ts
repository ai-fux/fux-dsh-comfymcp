/**
 * 成果物下载（协议 §2）：把 `artifacts[].url` 相对端点解析为绝对 URL，取回字节流
 * 写入本地目录。文件名冲突用 `-1`、`-2` 序号解决；路径穿越（`..`）被拒绝。
 */
import { existsSync } from 'node:fs'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { posix, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import type { ArtifactFile, ArtifactRef } from './types.js'
import { McpStreamableHttpError } from './streamable-http.js'

/** Resolve one artifact URL (absolute, or relative to the comfy-mcp endpoint). */
export function resolveArtifactUrl(endpoint: string, url: string): string {
  if (/^https?:\/\//.test(url)) return url
  const base = new URL(endpoint)
  return new URL(url, base).toString()
}

/** Safe file name: basename only, no traversal, non-empty. */
export function safeArtifactFilename(ref: ArtifactRef, index: number): string {
  const raw =
    typeof ref.filename === 'string' && ref.filename.trim().length > 0 ? ref.filename.trim() : `artifact-${index + 1}`
  const base = posix.basename(raw.replaceAll('\\', '/'))
  if (base.length === 0 || base === '.' || base === '..') return `artifact-${index + 1}`
  return base
}

export interface DownloadArtifactsOptions {
  readonly endpoint: string
  readonly artifactsDir: string
  readonly refs: readonly ArtifactRef[]
  readonly timeoutMs?: number
  readonly fetchImpl?: typeof fetch
}

/** Download every ref into `artifactsDir`; returns the local file manifest. */
export async function downloadArtifacts(options: DownloadArtifactsOptions): Promise<ArtifactFile[]> {
  if (options.refs.length === 0) return []
  if (typeof options.artifactsDir !== 'string' || options.artifactsDir.length === 0) {
    throw new McpStreamableHttpError('artifactsDir is not configured', { code: 'E_ARTIFACT_DIR' })
  }
  const outDir = resolve(options.artifactsDir)
  await mkdir(outDir, { recursive: true })
  const doFetch = options.fetchImpl ?? fetch
  const files: ArtifactFile[] = []
  for (const [index, ref] of options.refs.entries()) {
    const filename = safeArtifactFilename(ref, index)
    const url = resolveArtifactUrl(options.endpoint, ref.url)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 60000)
    try {
      const response = await doFetch(url, { signal: controller.signal })
      if (!response.ok || response.body === null) {
        throw new McpStreamableHttpError(`artifact ${filename} answered HTTP ${response.status}`, {
          status: response.status,
          code: 'E_ARTIFACT_HTTP',
        })
      }
      const target = uniquify(resolve(outDir, filename))
      const stream = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>)
      await pipeline(stream, createWriteStream(target))
      const headerBytes = Number(response.headers.get('content-length') ?? 0)
      files.push({
        path: target,
        filename,
        kind: typeof ref.kind === 'string' && ref.kind.length > 0 ? ref.kind : kindFromFilename(filename),
        bytes: headerBytes > 0 ? headerBytes : (ref.bytes ?? 0),
        url,
      })
    } finally {
      clearTimeout(timer)
    }
  }
  return files
}

/** `a.png` → `image`; `b.mp4` → `video`; `c.mp3` → `audio`; else `file`. */
export function kindFromFilename(filename: string): string {
  const ext = posix.extname(filename).toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(ext)) return 'image'
  if (['.mp4', '.webm', '.mov', '.mkv', '.avi'].includes(ext)) return 'video'
  if (['.mp3', '.wav', '.flac', '.ogg', '.m4a'].includes(ext)) return 'audio'
  return 'file'
}

function uniquify(path: string): string {
  if (!existsSync(path)) return path
  const parsed = posix.parse(path)
  for (let attempt = 1; ; attempt += 1) {
    const candidate = resolve(parsed.dir, `${parsed.name}-${attempt}${parsed.ext}`)
    if (!existsSync(candidate)) return candidate
  }
}

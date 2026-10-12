/**
 * 成果物登记与字节流服务（协议 §2）。
 *
 * 产物**就地服务**（不拷贝）：登记 `<id> → 绝对路径`，GET /artifacts/<id> 校验
 * 路径仍存在于登记表后流式返回。登记表在内存中——服务端重启后旧 id 失效，
 * 客户端用 `list_artifacts` 重新拉取即可（约定写进协议文档）。
 */
import { createReadStream, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { extname } from 'node:path'
import type { ArtifactEntry } from './types.js'

const CONTENT_TYPES: Record<string, string> = {
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
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
}

export function contentTypeFor(filename: string): string {
  return CONTENT_TYPES[extname(filename).toLowerCase()] ?? 'application/octet-stream'
}

export function kindFromFilename(filename: string): string {
  const ext = extname(filename).toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(ext)) return 'image'
  if (['.mp4', '.webm', '.mov', '.mkv'].includes(ext)) return 'video'
  if (['.mp3', '.wav', '.flac', '.ogg', '.m4a'].includes(ext)) return 'audio'
  return 'file'
}

export class ArtifactStore {
  private readonly entries = new Map<string, ArtifactEntry>()

  /** Register one on-disk file; missing files are skipped, not fatal. */
  register(path: string, filename?: string): ArtifactEntry | undefined {
    try {
      const stats = statSync(path)
      if (!stats.isFile()) return undefined
      const name = filename ?? path.replaceAll('\\', '/').split('/').pop() ?? 'artifact'
      const entry: ArtifactEntry = {
        id: randomUUID(),
        filename: name,
        kind: kindFromFilename(name),
        bytes: stats.size,
        path,
      }
      this.entries.set(entry.id, entry)
      return entry
    } catch {
      return undefined
    }
  }

  get(id: string): ArtifactEntry | undefined {
    return this.entries.get(id)
  }

  get size(): number {
    return this.entries.size
  }

  list(): ArtifactEntry[] {
    return [...this.entries.values()]
  }
}

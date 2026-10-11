/**
 * 成果物注入（协议 §2）：扫描归一化数据里的 `files[]`（带 `path` 的文件清单），
 * 登记进 ArtifactStore 后把 `artifacts[]`（含 `url`）附加到数据上。
 * 已带 `artifacts` 的结果不重复注入。
 */
import { isAbsolute, resolve } from 'node:path'
import type { ArtifactStore } from './artifacts-store.js'

export interface WrapResult {
  readonly data: Record<string, unknown>
  readonly injected: number
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function injectArtifacts(
  data: Record<string, unknown>,
  store: ArtifactStore,
  maxArtifacts: number,
): WrapResult {
  if (Array.isArray(data['artifacts'])) return { data, injected: 0 }
  const files = data['files']
  if (!Array.isArray(files)) return { data, injected: 0 }
  const artifacts: Array<Record<string, unknown>> = []
  for (const entry of files.slice(0, maxArtifacts)) {
    const record = asRecord(entry)
    const rawPath = record?.['path']
    if (typeof rawPath !== 'string' || rawPath.length === 0) continue
    const absolute = isAbsolute(rawPath) ? resolve(rawPath) : resolve(rawPath)
    const registered = store.register(absolute, typeof record?.['filename'] === 'string' ? record['filename'] : undefined)
    if (registered === undefined) continue
    artifacts.push({
      id: registered.id,
      filename: registered.filename,
      kind: typeof record?.['kind'] === 'string' ? record['kind'] : registered.kind,
      bytes: registered.bytes,
      url: `/artifacts/${registered.id}`,
    })
  }
  if (artifacts.length === 0) return { data, injected: 0 }
  return { data: { ...data, artifacts }, injected: artifacts.length }
}

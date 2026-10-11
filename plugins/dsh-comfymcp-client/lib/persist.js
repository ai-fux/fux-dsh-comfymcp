/**
 * 配置覆盖层持久化：面板写入的配置落到 JSON 覆盖文件（行配置不动，
 * 重启仍生效）。层序：默认 < 行配置 < 覆盖文件 < 环境变量。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Resolve the overlay file path; tests pass an explicit dir. */
export function overlayPath(dataDir) {
  const home = typeof dataDir === 'string' && dataDir.length > 0
    ? dataDir
    : (process.env.DSH_HOME ?? join(process.cwd(), 'data', '.dsh'))
  return join(home, 'comfymcp', 'config-overlay.json')
}

export function readOverlay(path) {
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** Atomic-enough write: temp file + rename; a failure returns false, never throws. */
export function writeOverlay(path, patch) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const temp = `${path}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(patch, null, 2)}\n`, 'utf8')
    try {
      unlinkSync(path)
    } catch {
      /* not present */
    }
    renameSync(temp, path)
    return true
  } catch (error) {
    console.error(`[dsh-comfymcp-client] 配置覆盖层写入失败: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

export const OVERLAY_KEYS = [
  'endpoint',
  'workflowDirs',
  'saveSubdir',
  'artifactsDir',
  'autoUnloadModel',
  'autoConnect',
  'hostEntry',
  'requestTimeoutMs',
  'callTimeoutMs',
  'embeddedServer',
  'serverEntry',
  'embeddedBackend',
  'embeddedBackendCommand',
  'embeddedBackendArgs',
]

/** Reduce a config/write payload to the writable keys (drop empties except explicit booleans). */
export function sanitizeOverlayPatch(payload) {
  const patch = {}
  for (const key of OVERLAY_KEYS) {
    if (payload?.[key] === undefined) continue
    const value = payload[key]
    if (typeof value === 'boolean') {
      patch[key] = value
      continue
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      patch[key] = value.trim()
    }
  }
  return patch
}

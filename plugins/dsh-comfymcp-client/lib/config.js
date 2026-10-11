/**
 * 配置解析：优先级 env > 行配置 > 默认。纯函数、可测试，不依赖 DSH 运行时。
 */

/** Local defaults mirroring the bundle patch row. */
export const DEFAULTS = Object.freeze({
  endpoint: 'http://127.0.0.1:18800/mcp',
  hostCommand: 'node',
  hostEntry: '',
  workflowDirs: [],
  saveSubdir: 'dsh-generated',
  artifactsDir: '',
  autoUnloadModel: true,
  autoConnect: true,
  requestTimeoutMs: 30000,
  callTimeoutMs: 300000,
  embeddedServer: false,
  serverEntry: '',
  embeddedBackend: 'mock',
  embeddedBackendCommand: 'node',
  embeddedBackendArgs: '',
  comfyuiUrl: 'http://127.0.0.1:8000',
  controlPort: 18801,
  controlToken: '',
})

const NUMBER_KEYS = new Set(['requestTimeoutMs', 'callTimeoutMs', 'controlPort'])
const BOOLEAN_KEYS = new Set(['autoUnloadModel', 'autoConnect', 'embeddedServer'])
const LIST_KEYS = new Set(['workflowDirs'])

function isBlank(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim().length === 0)
}

function coerceNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return undefined
}

/** controlPort 允许 0（随机空闲端口）；>0 时按普通数值。 */
function coercePort(value) {
  if (value === 0) return 0
  if (typeof value === 'string' && value.trim() === '0') return 0
  return coerceNumber(value)
}

function coerceBoolean(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(text)) return true
    if (['0', 'false', 'no', 'off'].includes(text)) return false
  }
  return undefined
}

/** Split a path list: `;` always separates; `:` only when not a Windows drive prefix. */
export function splitPathList(value) {
  const text = String(value ?? '').trim()
  if (text.length === 0) return []
  const separator = text.includes(';') || /^[A-Za-z]:[\\/]/.test(text) ? ';' : ':'
  return text
    .split(separator)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

function coerceFor(key, value) {
  if (value === undefined || value === null) return undefined
  if (key === 'controlPort') return coercePort(value)
  if (NUMBER_KEYS.has(key)) return coerceNumber(value)
  if (BOOLEAN_KEYS.has(key)) return coerceBoolean(value)
  if (LIST_KEYS.has(key)) {
    if (Array.isArray(value)) {
      const list = value.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0)
      return list.length > 0 ? list : undefined
    }
    if (typeof value === 'string') {
      const list = splitPathList(value)
      return list.length > 0 ? list : undefined
    }
    return undefined
  }
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function envNamesFor(key) {
  const screaming = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()
  const names = [`DSH_COMFYMCP_${screaming}`, `COMFY_MCP_${screaming}`]
  if (key === 'endpoint') names.push('COMFY_MCP_ENDPOINT')
  if (key === 'artifactsDir') names.push('COMFY_MCP_ARTIFACTS_DIR')
  return names
}

/**
 * Resolve the effective configuration.
 * @param row partial config from the Loader row (already schema-validated when declared)
 * @param env environment record; pass {} for isolation in tests
 * @param resolvePath path resolver injected by the Host half (node:path.resolve)
 */
export function resolveConfig(row = {}, env = {}, resolvePath = (p) => p) {
  const out = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    // 优先级：环境变量 > 行配置 > 默认
    let resolved
    for (const name of envNamesFor(key)) {
      const value = env[name]
      if (!isBlank(value)) {
        const coerced = coerceFor(key, value)
        if (coerced !== undefined) {
          resolved = coerced
          break
        }
      }
    }
    if (resolved === undefined) {
      resolved = coerceFor(key, row[key])
    }
    if (resolved !== undefined) {
      out[key] = resolved
    }
  }
  if (typeof out.artifactsDir === 'string' && out.artifactsDir.length > 0) {
    out.artifactsDir = resolvePath(out.artifactsDir)
  }
  out.workflowDirs = [...out.workflowDirs]
  return out
}

/** Conventional workspace locations of the MCP host entry, most specific first. */
export function candidateHostEntries(pluginDir) {
  const entries = []
  if (pluginDir) {
    const normalized = pluginDir.replaceAll('\\', '/')
    const marker = '/node_modules/'
    const cut = normalized.lastIndexOf(marker)
    if (cut > 0) {
      const profileRoot = normalized.slice(0, cut)
      entries.push(`${profileRoot}/projects/dsh-comfymcp/mcp/bin/fux-comfymcp-host.mjs`)
    }
  }
  entries.push('projects/dsh-comfymcp/mcp/bin/fux-comfymcp-host.mjs')
  return entries
}

/**
 * Resolve the comfy-mcp-server entry for embedded mode, most specific first:
 * 1. env override (DSH_COMFYMCP_SERVER_ENTRY / COMFY_MCP_SERVER_ENTRY)
 * 2. explicit config (row/overlay serverEntry)
 * 3. the BUNDLED copy shipped inside the plugin (vendor/comfy-mcp-server.mjs) —
 *    makes the plugin self-contained on any machine
 * 4. derivation from the host entry's sibling layout (…/mcp/bin → …/comfy-mcp-server/bin)
 */
export function resolveServerEntry(env = {}, serverEntry, hostEntry, pluginDir = '') {
  for (const name of ['DSH_COMFYMCP_SERVER_ENTRY', 'COMFY_MCP_SERVER_ENTRY']) {
    const value = env[name]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  if (typeof serverEntry === 'string' && serverEntry.trim().length > 0) return serverEntry.trim()
  if (typeof pluginDir === 'string' && pluginDir.trim().length > 0) {
    return `${pluginDir.trim().replaceAll('\\', '/')}/vendor/comfy-mcp-server.mjs`
  }
  if (typeof hostEntry === 'string' && hostEntry.trim().length > 0) {
    const normalized = hostEntry.trim().replaceAll('\\', '/')
    const cut = normalized.lastIndexOf('/mcp/bin/')
    if (cut > 0) return `${normalized.slice(0, cut)}/comfy-mcp-server/bin/comfy-mcp-server.mjs`
  }
  return ''
}

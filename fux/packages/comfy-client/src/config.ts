import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { manifest } from './manifest.js'
import type { ComfyMcpClientConfig } from './types.js'

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function asHeaders(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const headers: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') headers[key] = entry
    else if (typeof entry === 'number' || typeof entry === 'boolean') headers[key] = String(entry)
  }
  return headers
}

/** Default artifacts dir: inside DSH_HOME when known, else the OS temp dir. */
export function defaultArtifactsDir(env: Record<string, string | undefined> = process.env): string {
  const home = asString(env['DSH_HOME'], '')
  if (home.length > 0) return join(home, 'storages', 'fux-mcp-comfy-client', 'artifacts')
  return join(tmpdir(), 'fux-mcp-comfy-client', 'artifacts')
}

function schemaDefault(key: string): unknown {
  const properties = manifest.configSchema?.['properties'] as Record<string, Record<string, unknown>> | undefined
  return properties?.[key]?.['default']
}

/**
 * Effective configuration. Precedence: environment (`COMFY_MCP_*`) → row
 * config → manifest schema defaults. The environment wins so an operator can
 * retarget a deployment without touching the composition.
 */
export function resolveConfig(
  raw: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env,
): ComfyMcpClientConfig {
  const pick = (key: string): unknown => raw[key] ?? schemaDefault(key)
  const headersEnv = asString(env['COMFY_MCP_HEADERS'], '')
  return {
    endpoint: asString(env['COMFY_MCP_ENDPOINT'], asString(pick('endpoint'), String(schemaDefault('endpoint')))),
    headers:
      headersEnv.length > 0
        ? asHeaders(safeJsonParse(headersEnv))
        : asHeaders(pick('headers') ?? schemaDefault('headers')),
    protocolVersion: asString(env['COMFY_MCP_PROTOCOL_VERSION'], asString(pick('protocolVersion'), String(schemaDefault('protocolVersion')))),
    requestTimeoutMs: asNumber(
      env['COMFY_MCP_TIMEOUT_MS'] === undefined ? undefined : Number(env['COMFY_MCP_TIMEOUT_MS']),
      asNumber(pick('requestTimeoutMs'), Number(schemaDefault('requestTimeoutMs'))),
    ),
    callTimeoutMs: asNumber(
      env['COMFY_MCP_CALL_TIMEOUT_MS'] === undefined ? undefined : Number(env['COMFY_MCP_CALL_TIMEOUT_MS']),
      asNumber(pick('callTimeoutMs'), Number(schemaDefault('callTimeoutMs'))),
    ),
    maxInitAttempts: asNumber(pick('maxInitAttempts'), Number(schemaDefault('maxInitAttempts'))),
    artifactsDir: resolve(
      asString(env['COMFY_MCP_ARTIFACTS_DIR'], asString(pick('artifactsDir'), defaultArtifactsDir(env))),
    ),
    clientName: asString(pick('clientName'), String(schemaDefault('clientName'))),
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

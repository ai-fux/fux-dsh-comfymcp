import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { ComfyMcpServerConfig } from './types.js'

function asString(value: string | undefined, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function asNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

/** Port 0 is meaningful (OS-assigned), so it bypasses the positive-number rule. */
function asPort(value: string | undefined, fallback: number): number {
  if (value === undefined || value.length === 0) return fallback
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : fallback
}

/** Effective server configuration from `COMFY_MCP_*` environment keys. */
export function resolveServerConfig(env: Record<string, string | undefined> = process.env): ComfyMcpServerConfig {
  const backendKind = asString(env['COMFY_MCP_BACKEND'], 'stdio') === 'mock' ? 'mock' : 'stdio'
  const argsEnv = asString(env['COMFY_MCP_BACKEND_ARGS'], '')
  return {
    port: asPort(env['COMFY_MCP_SERVER_PORT'], 18800),
    host: asString(env['COMFY_MCP_SERVER_HOST'], '127.0.0.1'),
    path: asString(env['COMFY_MCP_SERVER_PATH'], '/mcp'),
    backendKind,
    backendCommand: asString(env['COMFY_MCP_BACKEND_CMD'], 'node'),
    backendArgs:
      argsEnv.length > 0
        ? argsEnv.split(';').map((entry) => entry.trim()).filter((entry) => entry.length > 0)
        : [],
    callTimeoutMs: asNumber(env['COMFY_MCP_CALL_TIMEOUT_MS'], 300000),
    requestTimeoutMs: asNumber(env['COMFY_MCP_TIMEOUT_MS'], 30000),
    maxArtifactsPerResult: asNumber(env['COMFY_MCP_MAX_ARTIFACTS'], 50),
    serverName: 'comfy-mcp-server',
    serverVersion: '0.1.0',
    instructions:
      'comfy-mcp reference service. Tools follow the ComfyUI MCP contract (server_info, node_search, run_workflow, fetch_outputs, ...). File-producing tools attach artifacts[] with resolvable url fields; GET {base}{url} streams the bytes.',
  }
}

/** Where the mock backend stages its artifact files. */
export function mockStageDir(env: Record<string, string | undefined> = process.env): string {
  return resolve(asString(env['COMFY_MCP_MOCK_STAGE_DIR'], resolve(tmpdir(), 'comfy-mcp-mock-stage')))
}

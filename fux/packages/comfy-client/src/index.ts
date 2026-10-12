/**
 * fux-plugin-mcp-comfy-client — comfy-mcp 服务通用客户端插件。
 *
 * activate() 把五个 capability 绑定到一个惰性单例 StreamableHttpClient 上：
 * 连接在第一次调用时建立，会话失效自动重连（有界）。本插件不理解 ComfyUI
 * 语义——工具目录与调用语义都由 comfy-mcp 服务定义。
 */
import type { CapabilityHandler, FuxPluginModule, PluginContext } from '@fux/runtime'
import { downloadArtifacts } from './artifacts.js'
import { resolveConfig } from './config.js'
import { manifest } from './manifest.js'
import { McpStreamableHttpError, StreamableHttpClient, normalizeToolResult } from './streamable-http.js'
import type { ArtifactRef, RemoteTool } from './types.js'

export { manifest }
export { resolveConfig, defaultArtifactsDir } from './config.js'
export { StreamableHttpClient, McpStreamableHttpError, normalizeToolResult } from './streamable-http.js'
export { downloadArtifacts, resolveArtifactUrl, safeArtifactFilename, kindFromFilename } from './artifacts.js'
export type {
  ArtifactFile,
  ArtifactRef,
  ComfyMcpClientConfig,
  JsonRpcErrorObject,
  NormalizedCallResult,
  RemoteServerInfo,
  RemoteTool,
} from './types.js'

const PLUGIN_VERSION = manifest.version

interface ClientState {
  readonly client: StreamableHttpClient
  readonly config: ReturnType<typeof resolveConfig>
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** Extract artifact refs from a normalized call payload (`artifacts[]`). */
export function extractArtifacts(data: unknown): ArtifactRef[] {
  const record = asRecord(data)
  const artifacts = record['artifacts']
  if (!Array.isArray(artifacts)) return []
  return artifacts
    .map((entry) => asRecord(entry))
    .filter((entry) => typeof entry['url'] === 'string' && (entry['url'] as string).length > 0)
    .map((entry) => ({
      url: entry['url'] as string,
      ...(typeof entry['id'] === 'string' ? { id: entry['id'] } : {}),
      ...(typeof entry['filename'] === 'string' ? { filename: entry['filename'] } : {}),
      ...(typeof entry['kind'] === 'string' ? { kind: entry['kind'] } : {}),
      ...(typeof entry['bytes'] === 'number' ? { bytes: entry['bytes'] } : {}),
    }))
}

function errorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof McpStreamableHttpError) {
    return { ok: false, error: error.message, code: error.code, ...(error.status > 0 ? { status: error.status } : {}) }
  }
  return { ok: false, error: error instanceof Error ? error.message : String(error), code: 'E_MCP_CLIENT' }
}

function activate(ctx: PluginContext): void {
  const config = resolveConfig(asRecord(ctx.config))
  let state: ClientState | null = null

  const clientOf = (): ClientState => {
    if (state === null) {
      const client = new StreamableHttpClient({
        endpoint: config.endpoint,
        headers: config.headers,
        protocolVersion: config.protocolVersion,
        requestTimeoutMs: config.requestTimeoutMs,
        clientName: config.clientName,
        clientVersion: PLUGIN_VERSION,
        // stdout is protocol surface in the MCP host; diagnostics go to stderr.
        logger: { error: (message) => process.stderr.write(`[mcp-comfy] ${message}\n`) },
      })
      state = { client, config }
    }
    return state
  }

  /** `mcp-comfy:health` — probe; never throws. */
  const health: CapabilityHandler = async () => {
    const { client, config } = clientOf()
    const probe = await client.probe()
    return {
      ok: probe.ok,
      endpoint: config.endpoint,
      ...(probe.ok ? { serverInfo: probe.serverInfo, latencyMs: probe.latencyMs } : {}),
      ...(probe.ok ? {} : { error: probe.error }),
    }
  }

  /** `mcp-comfy:status` — full snapshot; never throws for transport reasons. */
  const status: CapabilityHandler = async () => {
    const { client, config } = clientOf()
    const probe = await client.probe()
    if (!probe.ok) {
      return { ok: false, endpoint: config.endpoint, connected: false, error: probe.error }
    }
    let tools: RemoteTool[] = []
    let toolsError: string | undefined
    try {
      tools = await client.listTools()
    } catch (error) {
      toolsError = error instanceof Error ? error.message : String(error)
    }
    return {
      ok: true,
      endpoint: config.endpoint,
      connected: client.connected,
      serverInfo: probe.serverInfo,
      latencyMs: probe.latencyMs,
      protocolVersion: config.protocolVersion,
      artifactsDir: config.artifactsDir,
      tools: tools.map((tool) => ({ name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }) })),
      toolCount: tools.length,
      ...(toolsError === undefined ? {} : { toolsError }),
    }
  }

  /** `mcp-comfy:tools` — full catalog with input schemas. */
  const tools: CapabilityHandler = async () => {
    const { client, config } = clientOf()
    const catalog = await client.listTools()
    return { ok: true, endpoint: config.endpoint, count: catalog.length, tools: catalog }
  }

  /** `mcp-comfy:call` — invoke one remote tool; optional inline artifact download. */
  const call: CapabilityHandler = async (payload) => {
    const request = asRecord(payload)
    const toolName = request['tool']
    if (typeof toolName !== 'string' || toolName.length === 0) {
      throw new Error('payload.tool (string) is required')
    }
    const { client, config } = clientOf()
    const args = asRecord(request['arguments'])
    const timeoutMs = typeof request['timeoutMs'] === 'number' ? request['timeoutMs'] : config.callTimeoutMs
    const outcome = await client.callTool(toolName, args, { timeoutMs })
    const artifacts = extractArtifacts(outcome.data)
    let localFiles: unknown
    if (artifacts.length > 0 && request['downloadArtifacts'] === true) {
      const downloaded = await downloadArtifacts({
        endpoint: config.endpoint,
        artifactsDir: config.artifactsDir,
        refs: artifacts,
        timeoutMs: config.requestTimeoutMs,
      })
      localFiles = downloaded
    }
    return {
      ok: outcome.ok,
      isError: outcome.isError,
      tool: toolName,
      data: outcome.data,
      artifacts,
      ...(localFiles !== undefined ? { localFiles } : {}),
      ...('raw' in outcome ? { raw: outcome.raw } : {}),
    }
  }

  /** `mcp-comfy:artifact-fetch` — download artifact refs to the local dir. */
  const artifactFetch: CapabilityHandler = async (payload) => {
    const request = asRecord(payload)
    const refsRaw = request['refs']
    if (!Array.isArray(refsRaw)) throw new Error('payload.refs (array of artifacts) is required')
    const refs: ArtifactRef[] = refsRaw
      .map((entry) => asRecord(entry))
      .filter((entry) => typeof entry['url'] === 'string' && (entry['url'] as string).length > 0)
      .map((entry) => ({
        url: entry['url'] as string,
        ...(typeof entry['id'] === 'string' ? { id: entry['id'] } : {}),
        ...(typeof entry['filename'] === 'string' ? { filename: entry['filename'] } : {}),
        ...(typeof entry['kind'] === 'string' ? { kind: entry['kind'] } : {}),
        ...(typeof entry['bytes'] === 'number' ? { bytes: entry['bytes'] } : {}),
      }))
    if (refs.length === 0) return { ok: true, files: [] }
    const outDir = typeof request['outDir'] === 'string' && request['outDir'].length > 0 ? request['outDir'] : config.artifactsDir
    const files = await downloadArtifacts({
      endpoint: config.endpoint,
      artifactsDir: outDir,
      refs,
      timeoutMs: config.requestTimeoutMs,
    })
    return { ok: true, outDir, count: files.length, files }
  }

  ctx.provide('mcp-comfy:health', health)
  ctx.provide('mcp-comfy:status', status)
  ctx.provide('mcp-comfy:tools', tools)
  ctx.provide('mcp-comfy:call', call)
  ctx.provide('mcp-comfy:artifact-fetch', artifactFetch)
}

export const plugin: FuxPluginModule = {
  activate,
  deactivate() {
    /* one-shot HTTP client holds no persistent sockets worth closing */
  },
}

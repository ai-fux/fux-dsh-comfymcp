/** Shared types for the comfy-mcp Streamable HTTP client. */

/** One tool description as advertised by `tools/list`. */
export interface RemoteTool {
  readonly name: string
  readonly description?: string
  readonly inputSchema?: Record<string, unknown>
}

/** `initialize` result `serverInfo` subset we keep. */
export interface RemoteServerInfo {
  readonly name?: string
  readonly version?: string
  readonly instructions?: string
}

/** MCP JSON-RPC error object. */
export interface JsonRpcErrorObject {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

/** One artifact per the comfy-mcp artifacts convention (`docs/protocol.md` §2). */
export interface ArtifactRef {
  readonly id?: string
  readonly filename?: string
  readonly kind?: string
  readonly bytes?: number
  readonly url: string
}

/** One downloaded artifact file. */
export interface ArtifactFile {
  readonly path: string
  readonly filename: string
  readonly kind: string
  readonly bytes: number
  readonly url: string
}

/** Normalized `tools/call` outcome (protocol §1.1). */
export interface NormalizedCallResult {
  readonly ok: boolean
  readonly data: Record<string, unknown>
  readonly isError: boolean
  readonly raw?: unknown
}

/** Effective plugin configuration. */
export interface ComfyMcpClientConfig {
  readonly endpoint: string
  readonly headers: Readonly<Record<string, string>>
  readonly protocolVersion: string
  readonly requestTimeoutMs: number
  readonly callTimeoutMs: number
  readonly maxInitAttempts: number
  readonly artifactsDir: string
  readonly clientName: string
}

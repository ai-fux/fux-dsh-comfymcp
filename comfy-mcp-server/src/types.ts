/** Shared types for the comfy-mcp reference server. */

export interface RemoteTool {
  readonly name: string
  readonly description?: string
  readonly inputSchema?: Record<string, unknown>
}

/** MCP content block subset we proxy. */
export interface ContentBlock {
  readonly type: string
  readonly text?: string
}

/** A `tools/call` outcome as the backend answers it (MCP result shape). */
export interface ToolCallOutcome {
  readonly content?: readonly ContentBlock[]
  readonly structuredContent?: Record<string, unknown>
  readonly isError?: boolean
}

/** Backend abstraction: stdio child process or in-process mock. */
export interface McpBackend {
  readonly kind: 'stdio' | 'mock'
  listTools(): Promise<RemoteTool[]>
  callTool(name: string, args: Record<string, unknown> | undefined): Promise<ToolCallOutcome>
  stop(): Promise<void>
}

export interface ArtifactEntry {
  readonly id: string
  readonly filename: string
  readonly kind: string
  readonly bytes: number
  readonly path: string
}

export interface ComfyMcpServerConfig {
  readonly port: number
  readonly host: string
  readonly path: string
  readonly backendKind: 'stdio' | 'mock'
  readonly backendCommand: string
  readonly backendArgs: readonly string[]
  readonly callTimeoutMs: number
  readonly requestTimeoutMs: number
  readonly maxArtifactsPerResult: number
  readonly serverName: string
  readonly serverVersion: string
  readonly instructions: string
}

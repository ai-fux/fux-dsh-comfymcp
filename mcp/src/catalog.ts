/**
 * Host-side tool catalog: the single source of truth for what the MCP host
 * advertises. Every entry drives exactly one `mcp-comfy:*` capability of
 * `@fux-mcp/comfy-client`; the host stays generic — comfy semantics live in
 * the remote tool catalog and in the DSH plugin's model-facing catalog.
 */

export interface CatalogTool {
  readonly name: string
  readonly description: string
  readonly capability: string
  readonly inputSchema: Record<string, unknown>
}

const ENDPOINT_NOTE =
  'The comfy-mcp endpoint comes from config/env (COMFY_MCP_ENDPOINT); these tools never take one.'

export const CATALOG_TOOLS: readonly CatalogTool[] = [
  {
    name: 'connection_status',
    capability: 'mcp-comfy:health',
    description:
      'Probe the comfy-mcp service (MCP Streamable HTTP): initialize handshake, reachability, latency, serverInfo. Never throws; answers { ok, endpoint, serverInfo?, latencyMs? } or { ok: false, error }. ' +
      ENDPOINT_NOTE,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_remote_tools',
    capability: 'mcp-comfy:tools',
    description:
      'List the remote tool catalog advertised by the comfy-mcp service: [{ name, description?, inputSchema? }]. Call this before inventing tool names for call_remote_tool. ' +
      ENDPOINT_NOTE,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'call_remote_tool',
    capability: 'mcp-comfy:call',
    description:
      'Invoke one remote tool of the comfy-mcp service and return the normalized JSON result ({ ok, tool, data, artifacts }). The result is an application error when data.isError is true — read data.error instead of guessing. ' +
      ENDPOINT_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'Remote tool name, exactly as listed by list_remote_tools.' },
        arguments: { type: 'object', description: 'Tool arguments object (may be empty).' },
        timeoutMs: { type: 'number', description: 'Optional per-call budget override.' },
        downloadArtifacts: {
          type: 'boolean',
          description: 'When true, download any artifacts[] of the result into the local artifacts dir and attach localFiles.',
        },
      },
      required: ['tool'],
    },
  },
  {
    name: 'fetch_artifacts',
    capability: 'mcp-comfy:artifact-fetch',
    description:
      'Download artifact refs (the artifacts[] entries a result carried) into the local artifacts dir; answers { ok, files: [{ path, filename, kind, bytes }] }. ' +
      ENDPOINT_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        refs: {
          type: 'array',
          description: 'Artifact refs; each needs at least url (plus optional id/filename/kind/bytes).',
          items: { type: 'object' },
        },
        outDir: { type: 'string', description: 'Optional output directory override.' },
      },
      required: ['refs'],
    },
  },
]

export const HOST_TOOL_NAMES = CATALOG_TOOLS.map((tool) => tool.name)

/** The tool names the DSH plugin may rely on; keep them in sync with the plugin. */
export const REQUIRED_TOOL_NAMES = HOST_TOOL_NAMES

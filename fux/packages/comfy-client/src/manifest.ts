import type { PluginManifest } from '@fux/protocol'

/**
 * comfy-mcp 通用客户端插件契约。
 *
 * 本插件只做一件事：把一个 **MCP Streamable HTTP** 端点（comfy-mcp 服务）适配成
 * FUX capability。它不理解 ComfyUI 语义——工具目录、图、工作流都由服务端定义；
 * 本插件负责连接、目录、调用归一化与成果物下载。
 */
export const manifest: PluginManifest = {
  id: '@fux-mcp/comfy-client',
  name: 'FUX MCP Comfy Client',
  version: '0.1.0',
  protocol: '^0.1.0',
  executionMode: 'in_process',
  description:
    'comfy-mcp 服务通用客户端：MCP Streamable HTTP 传输（initialize/tools/list/tools/call）、结果归一化与成果物（artifacts）下载落盘。',
  license: 'MIT',
  capabilities: [
    { name: 'mcp-comfy:health', version: '0.1.0', description: '探测 comfy-mcp 端点：initialize 握手、可达性、时延与错误（从不抛出）。' },
    { name: 'mcp-comfy:status', version: '0.1.0', description: '连接快照：端点、serverInfo、协议版本、会话状态与工具目录摘要。' },
    { name: 'mcp-comfy:tools', version: '0.1.0', description: '拉取服务端工具目录：name/description/inputSchema。' },
    { name: 'mcp-comfy:call', version: '0.1.0', description: '调用一个服务端工具并归一化结果；可附带下载结果中的成果物。' },
    { name: 'mcp-comfy:artifact-fetch', version: '0.1.0', description: '按成果物约定下载 artifacts[].url 到本地目录并返回文件清单。' },
  ],
  consumes: [],
  dependencies: [],
  configSchema: {
    type: 'object',
    properties: {
      endpoint: { type: 'string', default: 'http://127.0.0.1:18800/mcp' },
      headers: { type: 'object', default: {} },
      protocolVersion: { type: 'string', default: '2025-03-26' },
      requestTimeoutMs: { type: 'number', default: 15000 },
      callTimeoutMs: { type: 'number', default: 120000 },
      maxInitAttempts: { type: 'number', default: 2 },
      artifactsDir: { type: 'string', default: '' },
      clientName: { type: 'string', default: 'fux-mcp-comfy-client' },
    },
  },
}

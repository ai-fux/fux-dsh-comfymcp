/**
 * 内置 mock 后端（`COMFY_MCP_BACKEND=mock` / 测试）：无 ComfyUI 时的端到端替身。
 *
 * 工具目录是真实契约的缩影；`run_workflow` 会真的写一个小 PNG 到暂存目录并以
 * `files[]`（含 `path`）返回，从而完整走通「后端 → 成果物登记 → URL 服务 →
 * 客户端下载」链路。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { McpBackend, RemoteTool, ToolCallOutcome } from './types.js'

/** 1x1 red PNG. */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const MOCK_TOOLS: RemoteTool[] = [
  { name: 'server_info', description: 'mock snapshot', inputSchema: { type: 'object' } },
  { name: 'node_search', description: 'mock node search', inputSchema: { type: 'object' } },
  { name: 'node_info', description: 'mock node info', inputSchema: { type: 'object' } },
  { name: 'list_models', description: 'mock model list', inputSchema: { type: 'object' } },
  { name: 'list_workflows', description: 'mock workflow list', inputSchema: { type: 'object' } },
  { name: 'get_workflow', description: 'mock workflow read', inputSchema: { type: 'object' } },
  { name: 'save_workflow', description: 'mock workflow save', inputSchema: { type: 'object' } },
  { name: 'build_workflow', description: 'mock graph build', inputSchema: { type: 'object' } },
  { name: 'validate_workflow', description: 'mock validation', inputSchema: { type: 'object' } },
  { name: 'run_workflow', description: 'mock run: writes an artifact and returns files[]', inputSchema: { type: 'object' } },
  { name: 'fetch_outputs', description: 'mock outputs fetch', inputSchema: { type: 'object' } },
  { name: 'list_artifacts', description: 'mock gallery', inputSchema: { type: 'object' } },
  { name: 'echo', description: 'echo arguments back', inputSchema: { type: 'object' } },
]

export class MockBackend implements McpBackend {
  readonly kind = 'mock' as const
  private readonly stageDir: string
  private readonly workflows = new Map<string, { name: string; subdir: string; graph: unknown }>()

  constructor(stageDir?: string) {
    this.stageDir = stageDir ?? join(tmpdir(), 'comfy-mcp-mock-stage')
  }

  async listTools(): Promise<RemoteTool[]> {
    return MOCK_TOOLS
  }

  async callTool(name: string, args: Record<string, unknown> | undefined): Promise<ToolCallOutcome> {
    const payload = args ?? {}
    const text = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], isError: false })
    switch (name) {
      case 'echo':
        return text({ echoed: payload })
      case 'server_info':
        return text({
          reachable: true,
          version: 'mock-0.1.0',
          system: { comfyui_version: '0.3.51-mock', python_version: '3.12.mock', device_name: 'MockGPU' },
          queue: { running: 0, pending: 0 },
        })
      case 'node_search':
        return text({
          query: payload['query'] ?? '',
          total: 2,
          nodes: [
            { class_type: 'UnloadAllModels', category: 'Unload Model', output: ['*'] },
            { class_type: 'UnloadModel', category: 'Unload Model', output: ['*'] },
          ],
        })
      case 'node_info':
        return text({
          classes: {
            KSampler: {
              input: {
                required: {
                  seed: ['INT', { min: 0, max: 2 ** 32 }],
                  steps: ['INT', { min: 1, max: 100 }],
                  cfg: ['FLOAT', { min: 0, max: 20 }],
                },
              },
              output: ['MODEL', 'LATENT'],
            },
          },
        })
      case 'list_models':
        return text({ types: { checkpoints: ['mock.safetensors'], total: 1 } })
      case 'list_workflows':
        return text({
          total: this.workflows.size,
          workflows: [...this.workflows.entries()].map(([id, entry]) => ({ id, name: entry.name, subdir: entry.subdir })),
        })
      case 'get_workflow':
        return text({
          id: String(payload['id'] ?? ''),
          graph: { '1': { class_type: 'KSampler', inputs: { seed: 42, steps: 20 } } },
        })
      case 'save_workflow': {
        const id = randomUUID()
        this.workflows.set(id, {
          name: String(payload['name'] ?? 'workflow'),
          subdir: String(payload['subdir'] ?? ''),
          graph: payload['graph'],
        })
        return text({ ok: true, id, subdir: String(payload['subdir'] ?? '') })
      }
      case 'build_workflow':
        return text({
          graph: {
            '3': { class_type: 'KSampler', inputs: { seed: 0, steps: 20, cfg: 8 } },
            '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'mock' } },
          },
          warnings: [],
        })
      case 'validate_workflow':
        return text({ valid: true, errors: [], warnings: [] })
      case 'run_workflow':
      case 'fetch_outputs': {
        await mkdir(this.stageDir, { recursive: true })
        const filename = `mock_${randomUUID().slice(0, 8)}.png`
        const target = join(this.stageDir, filename)
        await writeFile(target, TINY_PNG)
        return text({
          ...(name === 'run_workflow' ? { promptId: randomUUID(), state: 'completed' } : {}),
          files: [{ path: target, filename, bytes: TINY_PNG.length, kind: 'image' }],
        })
      }
      case 'list_artifacts':
        return text({ files: [], total: 0 })
      default:
        return { content: [{ type: 'text', text: `mock backend does not implement ${name}` }], isError: true }
    }
  }

  async stop(): Promise<void> {
    /* nothing to stop */
  }
}

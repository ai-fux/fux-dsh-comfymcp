/**
 * stdio MCP 后端客户端：spawn 一条 MCP 子进程（默认 `fux-comfyui-mcp.mjs`——
 * 已真机验证的 ComfyUI MCP 服务器），以换行分隔 JSON-RPC 通信。
 *
 * 生命周期：懒启动；崩溃后在下次请求时有界重连；`stop()` 幂等。
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type { McpBackend, RemoteTool, ToolCallOutcome } from './types.js'

export class BackendError extends Error {
  readonly code: string
  constructor(message: string, code = 'E_BACKEND') {
    super(message)
    this.name = 'BackendError'
    this.code = code
  }
}

interface PendingEntry {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export interface StdioBackendOptions {
  readonly command: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly requestTimeoutMs?: number
  readonly maxRestarts?: number
  readonly logger?: { error(message: string): void }
}

export class StdioBackend implements McpBackend {
  readonly kind = 'stdio' as const
  private readonly command: string
  private readonly args: string[]
  private readonly extraEnv: Record<string, string>
  private readonly requestTimeoutMs: number
  private readonly maxRestarts: number
  private readonly logger: { error(message: string): void }

  private child: ChildProcess | null = null
  private nextId = 1
  private buffer = ''
  private pending = new Map<number, PendingEntry>()
  private starting: Promise<void> | null = null
  private restarts = 0
  private stopped = false
  private toolsCache: RemoteTool[] | null = null
  private toolsCachedAt = 0

  constructor(options: StdioBackendOptions) {
    this.command = options.command
    this.args = [...(options.args ?? [])]
    this.extraEnv = { ...(options.env ?? {}) }
    this.requestTimeoutMs = options.requestTimeoutMs ?? 300000
    this.maxRestarts = options.maxRestarts ?? 3
    this.logger = options.logger ?? { error: () => {} }
  }

  status(): Record<string, unknown> {
    return {
      kind: this.kind,
      command: [this.command, ...this.args].join(' '),
      running: this.child !== null && this.child.exitCode === null,
      restarts: this.restarts,
      tools: this.toolsCache?.length ?? 0,
    }
  }

  async listTools(): Promise<RemoteTool[]> {
    if (this.toolsCache !== null && Date.now() - this.toolsCachedAt < 60_000) return this.toolsCache
    const result = await this.request('tools/list', {})
    const tools = (result as { tools?: unknown })['tools']
    this.toolsCache = Array.isArray(tools)
      ? tools
          .filter((tool): tool is Record<string, unknown> => typeof tool === 'object' && tool !== null)
          .map((tool) => ({
            name: String(tool['name'] ?? ''),
            ...(typeof tool['description'] === 'string' ? { description: tool['description'] } : {}),
            ...(typeof tool['inputSchema'] === 'object' && tool['inputSchema'] !== null
              ? { inputSchema: tool['inputSchema'] as Record<string, unknown> }
              : {}),
          }))
          .filter((tool) => tool.name.length > 0)
      : []
    this.toolsCachedAt = Date.now()
    return this.toolsCache
  }

  async callTool(name: string, args: Record<string, unknown> | undefined): Promise<ToolCallOutcome> {
    this.toolsCache = null
    const result = (await this.request('tools/call', {
      name,
      ...(args === undefined ? {} : { arguments: args }),
    })) as Record<string, unknown>
    return {
      content: Array.isArray(result['content']) ? (result['content'] as ToolCallOutcome['content']) : [],
      ...(typeof result['structuredContent'] === 'object' && result['structuredContent'] !== null
        ? { structuredContent: result['structuredContent'] as Record<string, unknown> }
        : {}),
      isError: result['isError'] === true,
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new BackendError('backend stopped', 'E_BACKEND_STOPPED'))
    }
    this.pending = new Map()
    const child = this.child
    this.child = null
    if (child !== null && child.exitCode === null) {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
    }
  }

  /** One JSON-RPC request with a crash-restart retry. */
  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    await this.ensureStarted()
    try {
      return await this.rawRequest(method, params)
    } catch (error) {
      if (error instanceof BackendError && (error.code === 'E_BACKEND_DOWN' || error.code === 'E_BACKEND_STOPPED')) {
        this.killChild()
        await this.ensureStarted()
        return await this.rawRequest(method, params)
      }
      throw error
    }
  }

  private async rawRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    const child = this.child
    if (child === null || child.stdin === null) throw new BackendError('backend is not running', 'E_BACKEND_DOWN')
    const id = this.nextId++
    const payload = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new BackendError(`backend request ${method} timed out after ${this.requestTimeoutMs}ms`, 'E_BACKEND_TIMEOUT'))
      }, this.requestTimeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
        timer,
      })
      child.stdin!.write(payload)
    })
  }

  private async ensureStarted(): Promise<void> {
    if (this.stopped) throw new BackendError('backend is stopped', 'E_BACKEND_STOPPED')
    if (this.child !== null && this.child.exitCode === null) return
    if (this.starting === null) {
      this.starting = (async () => {
        await this.spawnChild()
        await this.handshake()
      })().finally(() => {
        this.starting = null
      })
    }
    await this.starting
  }

  /** MCP initialize + initialized-notification against the child. */
  private async handshake(): Promise<void> {
    const child = this.child
    if (child === null || child.stdin === null) throw new BackendError('backend is not running', 'E_BACKEND_DOWN')
    await this.rawRequest('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'comfy-mcp-server', version: '0.1.0' },
    })
    child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`)
  }

  private async spawnChild(): Promise<void> {
    if (this.restarts > this.maxRestarts) {
      throw new BackendError(`backend restarted ${this.restarts} times and keeps dying`, 'E_BACKEND_RESTARTS')
    }
    if (this.restarts > 0) {
      this.toolsCache = null
    }
    const child = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.extraEnv },
      windowsHide: true,
    })
    this.child = child
    child.on('error', (error) => {
      this.logger.error(`backend spawn error: ${error.message}`)
    })
    child.on('exit', () => {
      if (this.child === child) {
        this.child = null
        for (const [, entry] of this.pending) entry.reject(new BackendError('backend exited', 'E_BACKEND_DOWN'))
        this.pending = new Map()
      }
    })
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => {
      this.buffer += chunk
      let newline = this.buffer.indexOf('\n')
      while (newline !== -1) {
        const line = this.buffer.slice(0, newline).trim()
        this.buffer = this.buffer.slice(newline + 1)
        if (line.length > 0) this.handleFrame(line)
        newline = this.buffer.indexOf('\n')
      }
    })
    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim().length > 0) this.logger.error(`[backend] ${line}`)
      }
    })
    this.restarts += 1
  }

  private handleFrame(line: string): void {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    const id = message['id']
    if (typeof id !== 'number') return
    const entry = this.pending.get(id)
    if (entry === undefined) return
    this.pending.delete(id)
    if (message['error'] !== undefined) {
      const error = message['error'] as Record<string, unknown>
      entry.reject(new BackendError(String(error['message'] ?? 'backend error'), 'E_BACKEND_RPC'))
      return
    }
    entry.resolve(message['result'])
  }

  private killChild(): void {
    const child = this.child
    this.child = null
    if (child !== null && child.exitCode === null) {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
    }
  }
}

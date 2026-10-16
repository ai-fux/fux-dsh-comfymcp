/**
 * MCP stdio 客户端：spawn 一条 MCP 子进程（本项目 mcp/ 宿主），换行分隔
 * JSON-RPC（协议 2024-11-05 子集：initialize / tools/list / tools/call / ping）。
 *
 * 懒连接；进程退出后下次调用时有界重连；每次请求带超时。
 */
import { spawn } from 'node:child_process'

export class McpStdioError extends Error {
  constructor(message, code = 'E_STDIO') {
    super(message)
    this.name = 'McpStdioError'
    this.code = code
  }
}

export class McpStdioClient {
  /**
   * @param options command/args spawn target, budgets, logger
   */
  constructor(options) {
    this.command = options.command ?? 'node'
    this.args = [...(options.args ?? [])]
    this.cwd = options.cwd
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30000
    this.callTimeoutMs = options.callTimeoutMs ?? 300000
    this.maxRestarts = options.maxRestarts ?? 3
    this.log = options.log ?? (() => {})
    this.env = options.env

    this.child = null
    this.nextId = 1
    this.buffer = ''
    this.pending = new Map()
    this.starting = null
    this.restarts = 0
    this.closed = false
    this.serverInfo = null
  }

  status() {
    return {
      running: this.child !== null && this.child.exitCode === null && this.child.pid !== undefined,
      command: [this.command, ...this.args].join(' '),
      restarts: this.restarts,
      serverInfo: this.serverInfo,
    }
  }

  async initialize() {
    await this.ensureStarted()
    const result = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'dsh-comfymcp-client', version: '0.2.1' },
    })
    if (result && typeof result === 'object') {
      this.serverInfo = result.serverInfo ?? null
    }
    this.notify('notifications/initialized', {})
    return result
  }

  async listTools() {
    await this.ensureStarted()
    const result = await this.request('tools/list', {})
    return Array.isArray(result?.tools) ? result.tools : []
  }

  /**
   * Call one remote tool through the host.
   * @param name host tool name (connection_status / list_remote_tools / call_remote_tool / fetch_artifacts)
   * @param args tool arguments object
   * @param timeoutMs per-call budget override
   */
  async callTool(name, args = {}, timeoutMs) {
    await this.ensureStarted()
    return this.request('tools/call', { name, arguments: args }, timeoutMs)
  }

  async ping(timeoutMs) {
    await this.ensureStarted()
    return this.request('ping', {}, timeoutMs ?? 10000)
  }

  async close() {
    this.closed = true
    this.rejectAll(new McpStdioError('client closed', 'E_STDIO_CLOSED'))
    this.killChild()
  }

  // ------------------------------------------------------------------ internals

  async ensureStarted() {
    if (this.closed) throw new McpStdioError('client is closed', 'E_STDIO_CLOSED')
    if (this.child !== null && this.child.exitCode === null && this.child.stdin !== null) return
    if (this.starting === null) {
      this.starting = this.spawnChild()
        .then(() => this.handshake())
        .finally(() => {
          this.starting = null
        })
    }
    await this.starting
  }

  async handshake() {
    await this.rawRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'dsh-comfymcp-client', version: '0.2.1' },
    })
    this.notify('notifications/initialized', {})
  }

  /** One request with a single crash-reconnect retry. */
  async request(method, params = {}, timeoutMs) {
    await this.ensureStarted()
    try {
      return await this.rawRequest(method, params, timeoutMs)
    } catch (error) {
      if (error instanceof McpStdioError && (error.code === 'E_STDIO_DOWN' || error.code === 'E_STDIO_CLOSED')) {
        if (error.code === 'E_STDIO_CLOSED') throw error
        this.killChild()
        await this.ensureStarted()
        return this.rawRequest(method, params, timeoutMs)
      }
      throw error
    }
  }

  notify(method, params = {}) {
    const child = this.child
    if (child === null || child.stdin === null) return
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
    } catch (error) {
      this.log(`stdin write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  rawRequest(method, params, timeoutMs) {
    const child = this.child
    if (child === null || child.stdin === null) {
      return Promise.reject(new McpStdioError('host process is not running', 'E_STDIO_DOWN'))
    }
    const id = this.nextId++
    const budget = timeoutMs ?? (method === 'tools/call' ? this.callTimeoutMs : this.requestTimeoutMs)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new McpStdioError(`host request ${method} timed out after ${budget}ms`, 'E_STDIO_TIMEOUT'))
      }, budget)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new McpStdioError(`host stdin write failed: ${error instanceof Error ? error.message : String(error)}`, 'E_STDIO_DOWN'))
      }
    })
  }

  spawnChild() {
    if (this.restarts > this.maxRestarts) {
      return Promise.reject(new McpStdioError(`host process restarted ${this.restarts} times and keeps exiting`, 'E_STDIO_RESTARTS'))
    }
    this.restarts += 1
    return new Promise((resolve, reject) => {
      let child
      try {
        child = spawn(this.command, this.args, {
          cwd: this.cwd,
          env: this.env ?? undefined,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        })
      } catch (error) {
        reject(new McpStdioError(`failed to spawn host: ${error instanceof Error ? error.message : String(error)}`, 'E_STDIO_SPAWN'))
        return
      }
      this.child = child
      child.on('error', (error) => {
        this.log(`host spawn error: ${error.message}`)
      })
      child.on('exit', (code) => {
        if (this.child === child) {
          this.child = null
          this.log(`host process exited (code ${String(code)})`)
          this.rejectAll(new McpStdioError(`host process exited (code ${String(code)})`, 'E_STDIO_DOWN'))
        }
      })
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk) => {
        this.buffer += chunk
        let newline = this.buffer.indexOf('\n')
        while (newline !== -1) {
          const line = this.buffer.slice(0, newline).trim()
          this.buffer = this.buffer.slice(newline + 1)
          if (line.length > 0) this.handleFrame(line)
          newline = this.buffer.indexOf('\n')
        }
      })
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk) => {
        for (const line of chunk.split(/\r?\n/)) {
          const trimmed = line.trim()
          if (trimmed.length > 0) this.log(`[host] ${trimmed}`)
        }
      })
      // Resolve immediately: the handshake request below is the real readiness gate.
      resolve()
    })
  }

  handleFrame(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    const id = message?.id
    if (typeof id !== 'number') return
    const entry = this.pending.get(id)
    if (entry === undefined) return
    this.pending.delete(id)
    if (message.error !== undefined) {
      const code = typeof message.error?.code === 'number' ? message.error.code : -32000
      entry.reject(new McpStdioError(String(message.error?.message ?? 'host error'), `E_STDIO_RPC_${code}`))
      return
    }
    entry.resolve(message.result ?? {})
  }

  rejectAll(error) {
    for (const [, entry] of this.pending) {
      entry.reject(error)
    }
    this.pending = new Map()
  }

  killChild() {
    const child = this.child
    this.child = null
    if (child !== null && child.exitCode === null && child.pid !== undefined) {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
    }
  }
}

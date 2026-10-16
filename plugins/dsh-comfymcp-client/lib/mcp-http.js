/**
 * MCP Streamable HTTP 客户端（远程模式专用；本地内置模式仍走 stdio 宿主）。
 *
 * 协议要点（2024-11-05 / 2025-03-26 的 Streamable HTTP）：
 * - 单端点：所有 JSON-RPC 都 POST 到同一个 URL；
 * - `Accept: application/json, text/event-stream` —— 服务端可回 JSON，也可回 SSE 流；
 * - `initialize` 的响应头可带 `Mcp-Session-Id`，后续请求必须回带；
 * - 通知（无 id）用 POST 且不强求响应体。
 *
 * 这里只做传输层（initialize/listTools/callTool/ping/close）。把「宿主工具名」
 * （connection_status / call_remote_tool / list_remote_tools / fetch_artifacts）
 * 翻译成 comfy-mcp 原生工具的适配器见文件末尾 createHostFacade。
 */
const PROTOCOL_VERSION = '2024-11-05'
const CLIENT_NAME = 'dsh-comfymcp-client'
const CLIENT_VERSION = '0.2.1'

export class McpHttpError extends Error {
  constructor(message, code = 'E_HTTP', status = 0) {
    super(message)
    this.name = 'McpHttpError'
    this.code = code
    this.status = status
  }
}

/** 解析 SSE 文本块，取出所有 `data:` 负载（跨事件拼接按事件边界处理）。 */
export function parseSseChunk(text) {
  const events = []
  for (const block of String(text).split(/\r?\n\r?\n/)) {
    const dataLines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
    if (dataLines.length === 0) continue
    const payload = dataLines.join('\n')
    if (payload.length === 0) continue
    try {
      events.push(JSON.parse(payload))
    } catch {
      /* 非 JSON 事件（心跳/注释）忽略 */
    }
  }
  return events
}

export class McpHttpClient {
  /**
   * @param options endpoint*, token, headers, budgets, fetchImpl, log
   */
  constructor(options = {}) {
    this.endpoint = String(options.endpoint ?? '')
    this.token = String(options.token ?? '')
    this.extraHeaders = options.headers ?? {}
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30000
    this.callTimeoutMs = options.callTimeoutMs ?? 300000
    this.log = options.log ?? (() => {})
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.nextId = 1
    this.sessionId = ''
    this.serverInfo = null
    this.protocolVersion = PROTOCOL_VERSION
    this.closed = false
    this.lastError = ''
  }

  status() {
    return {
      transport: 'http',
      running: this.endpoint.length > 0 && this.closed === false,
      command: `POST ${this.endpoint}`,
      entry: this.endpoint,
      endpoint: this.endpoint,
      session: this.sessionId.length > 0 ? `${this.sessionId.slice(0, 8)}…` : '(stateless)',
      restarts: 0,
      serverInfo: this.serverInfo,
    }
  }

  headers() {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': this.protocolVersion,
      ...this.extraHeaders,
    }
    if (this.token.length > 0) headers.authorization = `Bearer ${this.token}`
    if (this.sessionId.length > 0) headers['mcp-session-id'] = this.sessionId
    return headers
  }

  async initialize() {
    if (this.endpoint.length === 0) {
      throw new McpHttpError('远程模式未配置 comfy-mcp 服务端点', 'E_HTTP_NO_ENDPOINT')
    }
    const { result, sessionId, protocolVersion } = await this.post(
      'initialize',
      {
        protocolVersion: this.protocolVersion,
        capabilities: {},
        clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
      },
      this.requestTimeoutMs,
    )
    if (sessionId.length > 0) this.sessionId = sessionId
    if (result !== null && typeof result === 'object') {
      this.serverInfo = result.serverInfo ?? this.serverInfo
      if (typeof result.protocolVersion === 'string' && result.protocolVersion.length > 0) {
        this.protocolVersion = result.protocolVersion
      }
    }
    if (typeof protocolVersion === 'string' && protocolVersion.length > 0) this.protocolVersion = protocolVersion
    await this.notify('notifications/initialized', {})
    return result
  }

  async listTools() {
    const { result } = await this.post('tools/list', {}, this.requestTimeoutMs)
    return Array.isArray(result?.tools) ? result.tools : []
  }

  async callTool(name, args = {}, timeoutMs) {
    const { result, httpStatus } = await this.post(
      'tools/call',
      { name, arguments: args },
      timeoutMs ?? this.callTimeoutMs,
    )
    if (result !== null && typeof result === 'object' && result.isError === true && httpStatus >= 400) {
      throw new McpHttpError(`tools/call ${name} failed (HTTP ${httpStatus})`, 'E_HTTP_TOOL', httpStatus)
    }
    return result ?? {}
  }

  async ping(timeoutMs) {
    const { result } = await this.post('ping', {}, timeoutMs ?? 10000)
    return result ?? {}
  }

  async notify(method, params = {}) {
    try {
      await this.post(method, params, this.requestTimeoutMs, { notification: true })
    } catch (error) {
      this.log(`notify ${method} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async close() {
    this.closed = true
    this.sessionId = ''
  }

  /** 一次 JSON-RPC POST：兼容 JSON 与 SSE 两种响应体。 */
  async post(method, params, timeoutMs, options = {}) {
    if (this.closed) throw new McpHttpError('client is closed', 'E_HTTP_CLOSED')
    const notification = options.notification === true
    const id = notification ? undefined : this.nextId++
    const body = notification
      ? { jsonrpc: '2.0', method, params }
      : { jsonrpc: '2.0', id, method, params }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      clearTimeout(timer)
      const aborted = error instanceof Error && (error.name === 'AbortError' || /abort/i.test(error.message))
      const message = aborted
        ? `远程 comfy-mcp 请求 ${method} 超时（${timeoutMs}ms）`
        : `远程 comfy-mcp 连接失败：${error instanceof Error ? error.message : String(error)}`
      this.lastError = message
      throw new McpHttpError(message, aborted ? 'E_HTTP_TIMEOUT' : 'E_HTTP_CONNECT')
    }
    try {
      const sessionId = response.headers?.get?.('mcp-session-id') ?? ''
      if (sessionId.length > 0 && this.sessionId.length === 0) this.sessionId = sessionId
      if (notification) return { result: null, sessionId, httpStatus: response.status, protocolVersion: '' }
      const contentType = String(response.headers?.get?.('content-type') ?? '')
      const text = await response.text()
      if (response.status >= 400 && text.trim().length === 0) {
        throw new McpHttpError(`远程 comfy-mcp 返回 HTTP ${response.status}（${method}）`, 'E_HTTP_STATUS', response.status)
      }
      const messages = contentType.includes('text/event-stream') || /^\s*(event|data):/m.test(text)
        ? parseSseChunk(text)
        : [safeJson(text)]
      const match = messages.find((message) => message !== null && typeof message === 'object' && Object.is(message.id, id))
      const fallback = messages.find((message) => message !== null && typeof message === 'object' && (message.result !== undefined || message.error !== undefined))
      const message = match ?? fallback ?? null
      if (message === null) {
        if (response.status >= 400) {
          throw new McpHttpError(`远程 comfy-mcp 返回 HTTP ${response.status}（${method}）`, 'E_HTTP_STATUS', response.status)
        }
        throw new McpHttpError(`远程 comfy-mcp 对 ${method} 未返回可解析的 JSON-RPC 响应`, 'E_HTTP_BAD_BODY', response.status)
      }
      if (message.error !== undefined) {
        const code = typeof message.error?.code === 'number' ? message.error.code : -32000
        throw new McpHttpError(String(message.error?.message ?? '远程 comfy-mcp 返回错误'), `E_HTTP_RPC_${code}`, response.status)
      }
      return { result: message.result ?? {}, sessionId, httpStatus: response.status, protocolVersion: '' }
    } finally {
      clearTimeout(timer)
    }
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * 宿主工具门面：让「远程 HTTP 直连」对上层呈现与 stdio 宿主一致的四个工具，
 * 上层（bridge/runcore）无需区分传输方式。
 *
 *   connection_status  → 原生 server_info（+ tools/list 计数）
 *   list_remote_tools  → 原生 tools/list
 *   call_remote_tool   → 原生 tools/call（裸名透传，返回宿主同形包装）
 *   fetch_artifacts    → 原生 fetch_outputs（有 promptId 时）
 */
export function createHostFacade(httpClient, options = {}) {
  const log = options.log ?? (() => {})
  const wrap = (tool, data, raw) => ({
    structuredContent: {
      ok: raw?.isError === true ? false : true,
      isError: raw?.isError === true,
      tool,
      data,
      raw,
    },
  })
  const dataOf = (result) => {
    if (result === null || typeof result !== 'object') return {}
    if (result.structuredContent !== undefined) return result.structuredContent
    const textPart = Array.isArray(result.content)
      ? result.content.find((part) => part?.type === 'text' && typeof part.text === 'string')
      : null
    if (textPart !== null && textPart !== undefined) {
      const parsed = safeJson(textPart.text)
      return parsed ?? { text: textPart.text }
    }
    return result
  }
  return {
    get serverInfo() {
      return httpClient.serverInfo
    },
    status: () => httpClient.status(),
    initialize: () => httpClient.initialize(),
    listTools: () => httpClient.listTools(),
    ping: (timeoutMs) => httpClient.ping(timeoutMs),
    close: () => httpClient.close(),
    async callTool(name, args = {}, timeoutMs) {
      if (name === 'call_remote_tool') {
        const tool = String(args.tool ?? '')
        if (tool.length === 0) {
          return { structuredContent: { ok: false, isError: true, tool: '', data: { error: 'call_remote_tool 需要 tool' }, raw: null } }
        }
        const result = await httpClient.callTool(tool, args.arguments ?? {}, timeoutMs)
        return wrap(tool, dataOf(result), result)
      }
      if (name === 'list_remote_tools') {
        const tools = await httpClient.listTools()
        return wrap('list_remote_tools', { tools, count: tools.length }, { tools })
      }
      if (name === 'connection_status') {
        try {
          const info = await httpClient.callTool('server_info', {}, timeoutMs ?? 20000)
          const data = dataOf(info)
          const tools = await httpClient.listTools().catch(() => [])
          return {
            structuredContent: {
              ok: true,
              isError: false,
              tool: 'server_info',
              data: { ...(typeof data === 'object' && data !== null ? data : { value: data }), toolCount: tools.length, transport: 'streamable-http' },
              raw: info,
            },
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          log(`connection_status via HTTP failed: ${message}`)
          return { structuredContent: { ok: false, isError: true, tool: 'server_info', data: { error: message }, raw: null } }
        }
      }
      if (name === 'fetch_artifacts') {
        const refs = Array.isArray(args.refs) ? args.refs : []
        const promptId = args.promptId ?? refs.find((ref) => ref?.promptId !== undefined)?.promptId ?? ''
        if (String(promptId).length === 0) {
          return { structuredContent: { ok: false, isError: true, tool: 'fetch_outputs', data: { error: 'fetch_artifacts 需要 promptId（refs[].promptId）' }, raw: null } }
        }
        const result = await httpClient.callTool(
          'fetch_outputs',
          { promptId, ...(args.outDir ? { outDir: args.outDir } : {}), ...(args.files ? { files: args.files } : {}) },
          timeoutMs ?? 120000,
        )
        return wrap('fetch_outputs', dataOf(result), result)
      }
      // 其余宿主工具名一律按原生工具直呼（宿主也允许透传）
      const result = await httpClient.callTool(name, args, timeoutMs)
      return wrap(name, dataOf(result), result)
    },
  }
}

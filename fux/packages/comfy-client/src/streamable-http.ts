/**
 * MCP Streamable HTTP client (protocol §1).
 *
 * Dependency-free: JSON-RPC over `POST {endpoint}` with
 * `Accept: application/json, text/event-stream`. The server may answer a single
 * JSON body or an SSE stream; both are parsed. The `Mcp-Session-Id` response
 * header of `initialize` is stored and replayed; a 404 (or explicit session
 * error) drops the session so the next call re-initializes.
 */
import type {
  JsonRpcErrorObject,
  NormalizedCallResult,
  RemoteServerInfo,
  RemoteTool,
} from './types.js'

interface HttpResult {
  readonly status: number
  readonly sessionId: string | null
  /** Parsed JSON-RPC messages (one for JSON bodies, many for SSE streams). */
  readonly messages: readonly JsonRpcMessage[]
}

type JsonRpcMessage =
  | { readonly id: number | string; readonly result?: unknown; readonly error?: JsonRpcErrorObject }
  | { readonly method: string; readonly params?: unknown }

export class McpStreamableHttpError extends Error {
  readonly status: number
  readonly code: string
  constructor(message: string, options: { status?: number; code?: string } = {}) {
    super(message)
    this.name = 'McpStreamableHttpError'
    this.status = options.status ?? 0
    this.code = options.code ?? 'E_MCP_HTTP'
  }
}

export interface StreamableHttpClientOptions {
  readonly endpoint: string
  readonly headers?: Readonly<Record<string, string>>
  readonly protocolVersion: string
  readonly requestTimeoutMs: number
  readonly clientName: string
  readonly clientVersion: string
  readonly logger?: { error(message: string): void }
  /** fetch injection for tests. */
  readonly fetchImpl?: typeof fetch
}

export class StreamableHttpClient {
  readonly endpoint: string
  private readonly extraHeaders: Record<string, string>
  private readonly protocolVersion: string
  private readonly requestTimeoutMs: number
  private readonly clientInfo: { name: string; version: string }
  private readonly logger: { error(message: string): void }
  private readonly doFetch: typeof fetch

  private nextId = 1
  private sessionId: string | null = null
  private serverInfo: RemoteServerInfo | null = null
  private initialized = false
  private initializing: Promise<void> | null = null

  constructor(options: StreamableHttpClientOptions) {
    if (typeof options.endpoint !== 'string' || !/^https?:\/\//.test(options.endpoint)) {
      throw new McpStreamableHttpError(`invalid endpoint: ${String(options.endpoint)}`, { code: 'E_MCP_ENDPOINT' })
    }
    this.endpoint = options.endpoint
    this.extraHeaders = { ...(options.headers ?? {}) }
    this.protocolVersion = options.protocolVersion
    this.requestTimeoutMs = options.requestTimeoutMs
    this.clientInfo = { name: options.clientName, version: options.clientVersion }
    this.logger = options.logger ?? { error: () => {} }
    this.doFetch = options.fetchImpl ?? fetch
  }

  /* ------------------------------------------------------------ snapshots */

  get connected(): boolean {
    return this.initialized
  }

  get sessionInfo(): { sessionId: string | null; serverInfo: RemoteServerInfo | null } {
    return { sessionId: this.sessionId, serverInfo: this.serverInfo }
  }

  /** Drop the session so the next request re-initializes. */
  invalidate(): void {
    this.initialized = false
    this.initializing = null
  }

  /* ------------------------------------------------------------ protocol */

  /** `initialize` + `notifications/initialized`. Safe to call concurrently. */
  async initialize(): Promise<RemoteServerInfo> {
    if (this.initialized && this.serverInfo !== null) return this.serverInfo
    if (this.initializing === null) {
      this.initializing = this.#initialize().finally(() => {
        this.initializing = null
      })
    }
    await this.initializing
    return this.serverInfo ?? {}
  }

  async #initialize(): Promise<void> {
    this.sessionId = null
    const result = await this.#request(
      'initialize',
      {
        protocolVersion: this.protocolVersion,
        capabilities: {},
        clientInfo: this.clientInfo,
      },
      { session: false },
    )
    if (result.error !== undefined) {
      throw new McpStreamableHttpError(`initialize failed: ${result.error.message}`, {
        code: 'E_MCP_INIT',
      })
    }
    const info = (result.result ?? {}) as { serverInfo?: RemoteServerInfo; protocolVersion?: string }
    this.serverInfo = info.serverInfo ?? {}
    if (typeof this.serverInfo !== 'object' || this.serverInfo === null) this.serverInfo = {}
    this.initialized = true
    await this.#notify('notifications/initialized', {})
  }

  async #notify(method: string, params: Record<string, unknown>): Promise<void> {
    const body = { jsonrpc: '2.0', method, params }
    await this.#post(body, { expectMessage: false })
  }

  async #request(
    method: string,
    params: Record<string, unknown>,
    options: { session?: boolean; timeoutMs?: number } = {},
  ): Promise<{ result?: unknown; error?: JsonRpcErrorObject }> {
    const id = this.nextId++
    const body = { jsonrpc: '2.0', id, method, params }
    const { messages } = await this.#post(body, {
      expectMessage: true,
      session: options.session !== false,
      timeoutMs: options.timeoutMs,
    })
    const match = messages.find((message) => 'id' in message && message.id === id)
    if (match === undefined || !('id' in match)) {
      throw new McpStreamableHttpError(`no JSON-RPC response for ${method}`, { code: 'E_MCP_NO_RESPONSE' })
    }
    return { result: match.result, error: match.error }
  }

  /* ------------------------------------------------------------ public API */

  /** `tools/list`. */
  async listTools(): Promise<RemoteTool[]> {
    await this.initialize()
    const result = await this.#request('tools/list', {})
    if (result.error !== undefined) {
      throw new McpStreamableHttpError(`tools/list failed: ${result.error.message}`, { code: 'E_MCP_TOOLS' })
    }
    const tools = (result.result ?? {}) as { tools?: unknown }
    if (!Array.isArray(tools.tools)) return []
    return tools.tools
      .filter((tool): tool is Record<string, unknown> => typeof tool === 'object' && tool !== null)
      .map((tool) => ({
        name: String(tool['name'] ?? ''),
        ...(typeof tool['description'] === 'string' ? { description: tool['description'] } : {}),
        ...(typeof tool['inputSchema'] === 'object' && tool['inputSchema'] !== null
          ? { inputSchema: tool['inputSchema'] as Record<string, unknown> }
          : {}),
      }))
      .filter((tool) => tool.name.length > 0)
  }

  /**
   * `tools/call` with one bounded session-invalidated retry: a stale session
   * (404) re-initializes and replays the call once.
   */
  async callTool(
    name: string,
    args?: Record<string, unknown>,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<NormalizedCallResult> {
    await this.initialize()
    const params = { name, ...(args === undefined ? {} : { arguments: args }) }
    let result = await this.#requestWithRetry(name, params, options)
    if (result.retryAfterInit) {
      result = await this.#requestWithRetry(name, params, { ...options, retried: true })
      if (result.retryAfterInit) {
        throw new McpStreamableHttpError(`session rejected twice for ${name}`, { code: 'E_MCP_SESSION' })
      }
    }
    return normalizeToolResult(result.outcome)
  }

  async #requestWithRetry(
    name: string,
    params: Record<string, unknown>,
    options: { timeoutMs?: number; signal?: AbortSignal; retried?: boolean },
  ): Promise<{ outcome: { result?: unknown; error?: JsonRpcErrorObject }; retryAfterInit: boolean }> {
    try {
      const outcome = await this.#request('tools/call', params, {
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      })
      return { outcome, retryAfterInit: false }
    } catch (error) {
      const stale =
        error instanceof McpStreamableHttpError &&
        (error.status === 404 || error.code === 'E_MCP_SESSION')
      if (stale && options.retried !== true) {
        this.invalidate()
        await this.initialize()
        return { outcome: {}, retryAfterInit: true }
      }
      throw error
    }
  }

  /** Probe reachability without throwing. */
  async probe(): Promise<{ ok: boolean; latencyMs: number; serverInfo?: RemoteServerInfo; error?: string }> {
    const startedAt = Date.now()
    try {
      const serverInfo = await this.initialize()
      return { ok: true, latencyMs: Date.now() - startedAt, serverInfo }
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /* ------------------------------------------------------------ transport */

  async #post(
    body: Record<string, unknown>,
    options: { expectMessage: boolean; session?: boolean; timeoutMs?: number },
  ): Promise<HttpResult> {
    const timeoutMs = options.timeoutMs !== undefined && options.timeoutMs > 0 ? options.timeoutMs : this.requestTimeoutMs
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...this.extraHeaders,
      }
      if (options.session !== false && this.sessionId !== null) {
        headers['mcp-session-id'] = this.sessionId
      }
      const response = await this.doFetch(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (response.status === 404 && this.sessionId !== null) {
        throw new McpStreamableHttpError('session not found (404)', { status: 404, code: 'E_MCP_SESSION' })
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new McpStreamableHttpError(
          `endpoint answered HTTP ${response.status}${text.length > 0 ? `: ${text.slice(0, 200)}` : ''}`,
          { status: response.status, code: 'E_MCP_HTTP' },
        )
      }
      const headerSession = response.headers.get('mcp-session-id')
      if (typeof headerSession === 'string' && headerSession.length > 0) this.sessionId = headerSession
      const contentType = response.headers.get('content-type') ?? ''
      if (contentType.includes('text/event-stream')) {
        const messages = await parseSseResponse(response)
        if (options.expectMessage && messages.length === 0) {
          throw new McpStreamableHttpError('SSE stream closed without a JSON-RPC response', {
            code: 'E_MCP_NO_RESPONSE',
          })
        }
        return { status: response.status, sessionId: headerSession, messages }
      }
      if (response.status === 202) {
        return { status: response.status, sessionId: headerSession, messages: [] }
      }
      const text = await response.text()
      if (text.trim().length === 0) {
        return { status: response.status, sessionId: headerSession, messages: [] }
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new McpStreamableHttpError(`endpoint returned non-JSON body: ${text.slice(0, 120)}`, {
          code: 'E_MCP_BAD_JSON',
        })
      }
      return { status: response.status, sessionId: headerSession, messages: [asMessage(parsed)] }
    } catch (error) {
      if (error instanceof McpStreamableHttpError) throw error
      if (error instanceof Error && error.name === 'AbortError') {
        throw new McpStreamableHttpError(`request timed out after ${timeoutMs}ms`, {
          code: 'E_MCP_TIMEOUT',
        })
      }
      throw new McpStreamableHttpError(
        `transport failure: ${error instanceof Error ? error.message : String(error)}`,
        { code: 'E_MCP_TRANSPORT' },
      )
    } finally {
      clearTimeout(timer)
    }
  }
}

function asMessage(value: unknown): JsonRpcMessage {
  if (typeof value !== 'object' || value === null) {
    throw new McpStreamableHttpError('JSON-RPC frame is not an object', { code: 'E_MCP_BAD_JSON' })
  }
  const record = value as Record<string, unknown>
  if ('id' in record) {
    return {
      id: record['id'] as number | string,
      ...( 'result' in record ? { result: record['result'] } : {}),
      ...('error' in record ? { error: record['error'] as JsonRpcErrorObject } : {}),
    }
  }
  return { method: String(record['method'] ?? ''), ...('params' in record ? { params: record['params'] } : {}) }
}

/** Read an SSE body and collect every `data:` JSON payload until the stream ends. */
async function parseSseResponse(response: Response): Promise<JsonRpcMessage[]> {
  const messages: JsonRpcMessage[] = []
  const body = response.body
  if (body === null) return messages
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const message = parseSseBlock(block)
      if (message !== undefined) messages.push(message)
      boundary = buffer.indexOf('\n\n')
    }
  }
  buffer += decoder.decode()
  const tail = parseSseBlock(buffer)
  if (tail !== undefined) messages.push(tail)
  return messages
}

function parseSseBlock(block: string): JsonRpcMessage | undefined {
  const dataLines = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
  if (dataLines.length === 0) return undefined
  const payload = dataLines.join('\n')
  if (payload.length === 0 || payload === '[DONE]') return undefined
  try {
    return asMessage(JSON.parse(payload))
  } catch {
    return undefined
  }
}

/** Project a raw `tools/call` result onto the normalized shape (protocol §1.1). */
export function normalizeToolResult(outcome: { result?: unknown; error?: JsonRpcErrorObject }): NormalizedCallResult {
  if (outcome.error !== undefined) {
    return {
      ok: false,
      isError: true,
      data: { error: outcome.error.message },
      raw: outcome.error,
    }
  }
  const result = (outcome.result ?? {}) as Record<string, unknown>
  const isError = result['isError'] === true
  const content = Array.isArray(result['content']) ? result['content'] : []
  const texts = content
    .map((block) => (typeof block === 'object' && block !== null && (block as Record<string, unknown>)['type'] === 'text'
      ? String((block as Record<string, unknown>)['text'] ?? '')
      : ''))
    .filter((text) => text.length > 0)
  let data: Record<string, unknown>
  if (result['structuredContent'] !== undefined && typeof result['structuredContent'] === 'object' && result['structuredContent'] !== null) {
    data = result['structuredContent'] as Record<string, unknown>
  } else if (texts.length > 0) {
    try {
      const parsed = JSON.parse(texts.join('\n')) as unknown
      data = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : { text: String(parsed) }
    } catch {
      data = { text: texts.join('\n') }
    }
  } else {
    data = {}
  }
  if (isError) {
    const message = typeof data['error'] === 'string' ? data['error'] : texts.join('\n') || 'tool reported an error'
    return { ok: false, isError: true, data: { ...data, error: message }, raw: result }
  }
  return { ok: true, isError: false, data, raw: content.length > 0 ? content : undefined }
}

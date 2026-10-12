/**
 * The stdio MCP server of the host: newline-delimited JSON-RPC with the minimal
 * MCP surface the DSH plugin's client needs — `initialize`,
 * `notifications/initialized`, `tools/list`, `tools/call`, `ping`.
 *
 * `createServer()` boots the FUX runtime once and returns the server plus the
 * runtime handle so tests own both lifetimes. Capability failures become MCP
 * `isError` results carrying the plugin's own error text.
 */
import { realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline'
import { bootRuntime } from './boot.js'
import type { BootedRuntime, BootRuntimeOptions } from './boot.js'
import { CATALOG_TOOLS } from './catalog.js'

export const SERVER_NAME = 'fux-comfymcp-host'
export const SERVER_VERSION = '0.1.0'

export interface ServerHandle {
  booted: BootedRuntime
  close(): Promise<void>
}

interface IncomingMessage {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: Record<string, unknown>
}

/** Drive one framed JSON-RPC message; answers with a line or nothing. */
export async function handleMessage(booted: BootedRuntime, message: IncomingMessage, write: (line: string) => void): Promise<void> {
  const method = message.method
  if (method === undefined) return
  const hasId = message.id !== undefined
  const answer = async (result: unknown): Promise<void> => {
    if (hasId) write(`${JSON.stringify({ jsonrpc: '2.0', id: message!.id, result })}\n`)
  }
  const answerError = (code: number, errorMessage: string): void => {
    if (hasId) write(`${JSON.stringify({ jsonrpc: '2.0', id: message!.id, error: { code, message: errorMessage } })}\n`)
  }

  if (method === 'initialize') {
    await answer({
      protocolVersion: '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions:
        'Generic bridge to a comfy-mcp service (MCP Streamable HTTP). Start with connection_status; list_remote_tools names what call_remote_tool can invoke.',
    })
    return
  }
  if (method.startsWith('notifications/')) return
  if (method === 'ping') {
    await answer({})
    return
  }
  if (method === 'tools/list') {
    await answer({
      tools: CATALOG_TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    })
    return
  }
  if (method === 'tools/call') {
    const params = message.params ?? {}
    const name = String(params['name'] ?? '')
    const args = (params['arguments'] ?? {}) as Record<string, unknown>
    const tool = CATALOG_TOOLS.find((entry) => entry.name === name)
    if (tool === undefined) {
      await answer({
        content: [{ type: 'text', text: `unknown tool: ${name}` }],
        isError: true,
      })
      return
    }
    try {
      const result = (await booted.call(tool.capability, args)) as unknown
      await answer({
        content: [{ type: 'text', text: JSON.stringify(result ?? {}) }],
        structuredContent: (result ?? {}) as Record<string, unknown>,
        isError: false,
      })
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      await answer({ content: [{ type: 'text', text }], structuredContent: { error: text }, isError: true })
    }
    return
  }
  answerError(-32601, `method not found: ${method}`)
}

export async function createServer(options: BootRuntimeOptions = {}): Promise<ServerHandle> {
  const booted = await bootRuntime(options)
  let closed = false
  return {
    booted,
    close: async () => {
      if (closed) return
      closed = true
      await booted.stop()
    },
  }
}

/** Serve on stdin/stdout until the stream closes. */
export async function startStdio(options: BootRuntimeOptions = {}): Promise<ServerHandle> {
  const handle = await createServer(options)
  const lines = createInterface({ input: process.stdin })
  const write = (line: string): void => {
    if (!process.stdout.write(line)) {
      process.stdout.once('drain', () => {})
    }
  }
  lines.on('line', (line) => {
    const trimmed = line.trim()
    if (trimmed.length === 0) return
    let message: IncomingMessage
    try {
      message = JSON.parse(trimmed) as IncomingMessage
    } catch {
      return
    }
    void handleMessage(handle.booted, message, write).catch((error: unknown) => {
      process.stderr.write(`${SERVER_NAME}: handler failure: ${error instanceof Error ? error.message : String(error)}\n`)
    })
  })
  lines.on('close', () => {
    void handle.close().then(() => process.exit(0))
  })
  const shutdown = (): void => {
    void handle.close().then(() => process.exit(0))
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  return handle
}

export async function runSelfTest(): Promise<number> {
  try {
    const handle = await createServer({ env: { ...process.env, COMFY_MCP_ENDPOINT: 'http://127.0.0.1:1/mcp' } })
    const answers: string[] = []
    await handleMessage(
      handle.booted,
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      (line) => answers.push(line),
    )
    await handleMessage(
      handle.booted,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      (line) => answers.push(line),
    )
    const toolsAnswer = JSON.parse(answers[1]!) as { result: { tools: Array<{ name: string }> } }
    const ok = answers.length === 2 && toolsAnswer.result.tools.length === CATALOG_TOOLS.length
    await handle.close()
    process.stdout.write(`${JSON.stringify({ ok, tools: toolsAnswer.result.tools.map((tool) => tool.name) })}\n`)
    return ok ? 0 : 1
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`)
    return 1
  }
}

const USAGE = `fux-comfymcp-host — local stdio MCP host over the FUX runtime + comfy-mcp client plugin

Usage:
  fux-comfymcp-host              serve the MCP protocol on stdin/stdout
  fux-comfymcp-host --selftest   boot, print {"ok":true,...} and exit
  fux-comfymcp-host --help       show this message

Environment: COMFY_MCP_ENDPOINT (default http://127.0.0.1:18800/mcp), COMFY_MCP_HEADERS,
COMFY_MCP_TIMEOUT_MS, COMFY_MCP_CALL_TIMEOUT_MS, COMFY_MCP_ARTIFACTS_DIR, DSH_HOME.
`

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE)
    return
  }
  if (argv.includes('--selftest')) {
    process.exit(await runSelfTest())
  }
  await startStdio({})
}

/** True when this module is the process entry point (tsx/plain node). */
function isMainModule(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    const self = realpathSync(fileURLToPath(import.meta.url))
    return pathToFileURL(realpathSync(entry)).href === pathToFileURL(self).href
  } catch {
    return entry.endsWith('main.ts') || entry.endsWith('main.js')
  }
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    process.stderr.write(`${SERVER_NAME}: failed to start: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    process.exit(1)
  })
}

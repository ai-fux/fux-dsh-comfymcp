/**
 * comfy-mcp-server 进程入口：HTTP 监听 + 优雅停机 + `--selftest`。
 */
import { realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createComfyMcpServer } from './server.js'

const NAME = 'comfy-mcp-server'

export async function runSelfTest(): Promise<number> {
  const handle = await createComfyMcpServer({
    config: undefined,
    env: { ...process.env, COMFY_MCP_BACKEND: 'mock', COMFY_MCP_SERVER_PORT: '0' },
  })
  try {
    const response = await fetch(handle.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    const body = (await response.json()) as { result?: { serverInfo?: { name?: string } } }
    const ok = response.headers.get('mcp-session-id') !== null && body.result?.serverInfo?.name === 'comfy-mcp-server'
    process.stdout.write(`${JSON.stringify({ ok, url: handle.url })}\n`)
    return ok ? 0 : 1
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: String(error) })}\n`)
    return 1
  } finally {
    await handle.stop()
  }
}

const USAGE = `comfy-mcp-server — MCP Streamable HTTP reference service for ComfyUI

Usage:
  comfy-mcp-server              listen on COMFY_MCP_SERVER_PORT (default 18800)
  comfy-mcp-server --selftest   boot the mock backend, initialize, exit 0/1
  comfy-mcp-server --help       show this message

Environment: COMFY_MCP_BACKEND=stdio|mock, COMFY_MCP_BACKEND_CMD, COMFY_MCP_BACKEND_ARGS,
COMFY_MCP_SERVER_PORT, COMFY_MCP_SERVER_HOST, COMFY_MCP_SERVER_PATH, COMFY_MCP_CALL_TIMEOUT_MS.
`

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE)
    return
  }
  if (argv.includes('--selftest')) {
    process.exit(await runSelfTest())
  }
  const handle = await createComfyMcpServer({})
  process.stderr.write(`${NAME}: listening on ${handle.url} (backend: ${handle.status()['backend']})\n`)
  const shutdown = (signal: string) => {
    process.stderr.write(`${NAME}: ${signal}, shutting down\n`)
    void handle.stop().then(() => process.exit(0))
  }
  process.once('SIGINT', () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))
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
    process.stderr.write(`${NAME}: failed to start: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    process.exit(1)
  })
}

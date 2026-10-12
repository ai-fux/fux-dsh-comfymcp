#!/usr/bin/env node
/**
 * comfy-mcp-server 启动器：平台包与本包都是 TS 源分发，真实入口是
 * `src/main.ts`（由 tsx 执行）。这个 .mjs 包装保证 MCP 客户端可以用
 * `command: "node"` 在任何 OS 上 spawn 一个稳定路径。
 *
 * stdout 是 JSON-RPC/协议通道的场景不存在（本服务监听 HTTP），诊断直接写 stderr。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url)) // <package>/bin
const packageDir = resolve(here, '..')
const mainEntry = join(packageDir, 'src', 'main.ts')

function resolveTsxCli() {
  const candidates = []
  const fromEnv = process.env.COMFY_MCP_TSX
  if (typeof fromEnv === 'string' && fromEnv.length > 0) candidates.push(fromEnv)
  try {
    const require = createRequire(import.meta.url)
    candidates.push(require.resolve('tsx/dist/cli.mjs'))
  } catch {
    /* fall through to the directory walk */
  }
  let dir = here
  for (;;) {
    candidates.push(join(dir, 'node_modules', 'tsx', 'dist', 'cli.mjs'))
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0 && existsSync(candidate)) return candidate
  }
  return ''
}

const tsxCli = resolveTsxCli()
if (tsxCli === '') {
  process.stderr.write(
    'comfy-mcp-server: cannot find the "tsx" runtime. Run `pnpm install` in the workspace root, ' +
      'or set COMFY_MCP_TSX to the absolute path of tsx/dist/cli.mjs.\n',
  )
  process.exit(1)
}

const child = spawn(process.execPath, [tsxCli, mainEntry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
  windowsHide: true,
})

child.on('error', (error) => {
  process.stderr.write(`comfy-mcp-server: failed to start tsx: ${error.message}\n`)
  process.exit(1)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal)
  })
}

child.on('exit', (code, signal) => {
  process.exit(signal === null ? (code ?? 0) : 1)
})

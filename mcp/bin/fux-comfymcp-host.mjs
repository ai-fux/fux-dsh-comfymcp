#!/usr/bin/env node
/**
 * fux-comfymcp-host 启动器：TS 源分发由 tsx 直跑；此包装保证 DSH 插件可以用
 * `command: "node"` spawn 一个稳定路径。stdio 从不继承/拷贝——JSON-RPC 通道
 * 必须原样通过。
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
  const fromEnv = process.env.FUX_COMFYMCP_TSX
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
    'fux-comfymcp-host: cannot find the "tsx" runtime. Run `pnpm install` in the workspace root, ' +
      'or set FUX_COMFYMCP_TSX to the absolute path of tsx/dist/cli.mjs.\n',
  )
  process.exit(1)
}

const child = spawn(process.execPath, [tsxCli, mainEntry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
  windowsHide: true,
})

child.on('error', (error) => {
  process.stderr.write(`fux-comfymcp-host: failed to start tsx: ${error.message}\n`)
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

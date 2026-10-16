/**
 * 复现页面执行的完整链路：展平图 → save_workflow → run_workflow → job_wait → fetch。
 * 用法：node scripts/repro-run.mjs [本地工作流名，默认 image_z_image]
 */
import { spawn } from 'node:child_process'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiGraphFromUi } from '../plugins/dsh-comfymcp-client/lib/wfgraph.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const hostEntry = join(root, 'mcp', 'bin', 'fux-comfymcp-host.mjs')
const overlay = JSON.parse(readFileSync(join(process.env.DSH_HOME ?? '', 'comfymcp', 'config-overlay.json'), 'utf8'))
const name = process.argv[2] ?? 'image_z_image'
const raw = JSON.parse(readFileSync(join(overlay.workflowDirs, `${name}.json`), 'utf8'))
const flat = apiGraphFromUi(raw)
console.log(`[1] 展平：${Object.keys(flat.graph).length} 节点，子图 ${flat.subgraphs} 个`)

const child = spawn(process.execPath, [hostEntry], {
  env: { ...process.env, COMFY_MCP_ENDPOINT: process.env.COMFY_MCP_ENDPOINT ?? 'http://127.0.0.1:18800/mcp' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let buffer = ''
const pending = new Map()
let nextId = 1
function send(method, params) {
  const id = nextId++
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  return new Promise((resolve, reject) => {
    pending.set(id, resolve)
    setTimeout(() => reject(new Error(`timeout ${method}`)), 300000)
  })
}
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line.length === 0) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message.result)
      pending.delete(message.id)
    }
  }
})
child.stderr.on('data', (chunk) => process.stderr.write(`[host] ${chunk}`))

function content(result) {
  const list = Array.isArray(result?.content) ? result.content : []
  const text = list.find((entry) => entry.type === 'text')?.text ?? '{}'
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}
const call = async (tool, args) => content(await send('tools/call', { name: 'call_remote_tool', arguments: { tool, arguments: args } }))

try {
  await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'repro', version: '0' } })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n')

  const saved = await call('save_workflow', { name: `probe-${name}`, graph: flat.graph, overwrite: true })
  console.log('[2] save_workflow →', JSON.stringify(saved).slice(0, 300))

  const started = Date.now()
  const run = await call('run_workflow', { graph: flat.graph })
  console.log('[3] run_workflow →', JSON.stringify(run).slice(0, 300))
  const promptId = run?.data?.promptId ?? run?.promptId
  if (typeof promptId !== 'string') throw new Error('没有拿到 promptId')

  const progressTimer = setInterval(async () => {
    try {
      const progress = await call('job_progress', { promptId })
      console.log(`    [progress ${Math.round((Date.now() - started) / 1000)}s]`, JSON.stringify(progress?.data ?? progress).slice(0, 200))
    } catch {
      /* ignore */
    }
  }, 4000)

  const waited = await call('job_wait', { promptId, timeoutMs: 260000 })
  clearInterval(progressTimer)
  console.log(`[4] job_wait（${Math.round((Date.now() - started) / 1000)}s）→`, JSON.stringify(waited?.data ?? waited).slice(0, 700))

  const outputs = await call('fetch_outputs', { promptId })
  console.log('[5] fetch_outputs →', JSON.stringify(outputs?.data ?? outputs).slice(0, 500))
  mkdirSync(join(root, 'tmp'), { recursive: true })
  writeFileSync(join(root, 'tmp', `repro-${name}.json`), JSON.stringify({ flat: Object.keys(flat.graph).length, saved, run, waited, outputs }, null, 2), 'utf8')
} catch (error) {
  console.log('[!] 失败：', error instanceof Error ? error.message : String(error))
} finally {
  child.kill()
}

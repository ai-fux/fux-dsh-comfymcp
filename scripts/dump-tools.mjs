/**
 * 打印远端工具的参数 schema（用于核对插件调用参数名）。
 * 用法：node scripts/dump-tools.mjs
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const child = spawn(process.execPath, [join(root, 'mcp', 'bin', 'fux-comfymcp-host.mjs')], {
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
})
let buffer = ''
const pending = new Map()
let nextId = 1
function send(method, params) {
  const id = nextId++
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  return new Promise((resolve) => {
    pending.set(id, resolve)
    setTimeout(() => resolve(null), 60000)
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
child.stderr.on('data', () => {})

try {
  await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dump', version: '0' } })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n')
  const result = await send('tools/call', { name: 'list_remote_tools', arguments: {} })
  const text = (result?.content ?? []).find((entry) => entry.type === 'text')?.text ?? '{}'
  const parsed = JSON.parse(text)
  const tools = parsed?.data?.tools ?? parsed?.tools ?? []
  for (const tool of tools) {
    const props = tool.inputSchema?.properties ?? tool.input_schema?.properties ?? {}
    const required = tool.inputSchema?.required ?? tool.input_schema?.required ?? []
    console.log(`${tool.name}(${Object.keys(props).map((key) => key + (required.includes(key) ? '*' : '')).join(', ')})`)
  }
} finally {
  child.kill()
}

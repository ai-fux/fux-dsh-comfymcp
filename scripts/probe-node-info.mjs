/**
 * 活链路实证：经 MCP 宿主调用 node_info / list_workflows，落盘真实返回形状。
 * 用法：node scripts/probe-node-info.mjs <ClassA> <ClassB> ...
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const hostEntry = join(root, 'mcp', 'bin', 'fux-comfymcp-host.mjs')
const classes = process.argv.slice(2)
if (classes.length === 0) classes.push('KSampler', 'CLIPTextEncode', 'CheckpointLoaderSimple', 'EmptyLatentImage', 'SaveImage', 'VAEDecode')

const child = spawn(process.execPath, [hostEntry], {
  env: { ...process.env, COMFYUI_URL: process.env.COMFYUI_URL ?? 'http://127.0.0.1:8000' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let buffer = ''
const pending = new Map()
let nextId = 1

function send(method, params) {
  const id = nextId++
  const message = JSON.stringify({ jsonrpc: '2.0', id, method, params })
  child.stdin.write(message + '\n')
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => reject(new Error(`timeout waiting ${method}`)), 60000)
  })
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
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
      const entry = pending.get(message.id)
      pending.delete(message.id)
      entry.resolve(message.result)
    }
  }
})
child.stderr.on('data', (chunk) => process.stderr.write(chunk))

function rpcContent(result) {
  const content = Array.isArray(result?.content) ? result.content : []
  const text = content.find((entry) => entry.type === 'text')?.text ?? '{}'
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

try {
  await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '0.0.0' } })
  notify('notifications/initialized', {})
  const info = await send('tools/call', { name: 'call_remote_tool', arguments: { tool: 'node_info', arguments: { classTypes: classes } } })
  const list = await send('tools/call', { name: 'call_remote_tool', arguments: { tool: 'list_workflows', arguments: {} } })
  const wf = await send('tools/call', { name: 'call_remote_tool', arguments: { tool: 'get_workflow', arguments: { id: process.env.PROBE_WF_ID ?? 'library:image_netayume_lumina_t2i.json' } } })
  const outDir = join(root, 'tmp')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'node-info-live.json'), JSON.stringify(rpcContent(info), null, 2), 'utf8')
  writeFileSync(join(outDir, 'list-workflows-live.json'), JSON.stringify(rpcContent(list), null, 2), 'utf8')
  writeFileSync(join(outDir, 'get-workflow-live.json'), JSON.stringify(rpcContent(wf), null, 2), 'utf8')
  const shaped = rpcContent(info)
  const data = shaped?.data ?? shaped ?? {}
  const catalog = data.nodes ?? data
  const firstKey = Object.keys(catalog ?? {})[0]
  console.log('wrapper keys:', Object.keys(shaped ?? {}))
  console.log('catalog top keys:', Object.keys(data ?? {}).slice(0, 8))
  console.log('first class:', firstKey)
  console.log(JSON.stringify(catalog?.[firstKey], null, 2).slice(0, 1600))
  console.log('--- list_workflows sample ---')
  const listData = rpcContent(list)?.data ?? {}
  console.log(JSON.stringify(listData).slice(0, 400))
  console.log('--- get_workflow graph keys ---')
  const wfData = rpcContent(wf)?.data ?? {}
  const graph = wfData.graph ?? {}
  console.log('wrapper:', Object.keys(wfData))
  if (Array.isArray(graph.nodes)) {
    console.log('UI format: nodes=', graph.nodes.length, 'links=', (graph.links ?? []).length)
    console.log(JSON.stringify(graph.nodes[0]).slice(0, 500))
  } else {
    console.log('API format classes:', Object.keys(graph).slice(0, 10))
  }
} finally {
  child.kill()
}

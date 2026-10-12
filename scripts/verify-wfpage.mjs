/**
 * 活链路验证：真实模板库工作流 + 真实 node_info → 页面描述符 → HTML 表单。
 * 用法：node scripts/verify-wfpage.mjs [library:工作流id]
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPageDescriptor, renderPageHtml } from '../plugins/dsh-comfymcp-client/lib/wfpage.js'
import { normalizeNodeCatalog } from '../plugins/dsh-comfymcp-client/lib/nodecat.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const hostEntry = join(root, 'mcp', 'bin', 'fux-comfymcp-host.mjs')
const workflowId = process.argv[2] ?? 'library:image_netayume_lumina_t2i.json'

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
    pending.set(id, { resolve, reject })
    setTimeout(() => reject(new Error(`timeout waiting ${method}`)), 90000)
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
    return {}
  }
}

try {
  await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify', version: '0.0.0' } })
  notify('notifications/initialized', {})
  const wf = rpcContent(await send('tools/call', { name: 'call_remote_tool', arguments: { tool: 'get_workflow', arguments: { id: workflowId } } })).data
  const graph = wf?.graph
  if (graph === null || typeof graph !== 'object') throw new Error(`get_workflow ${workflowId} 无图`)
  const classes = [...new Set(Object.values(graph).map((node) => node?.class_type).filter(Boolean))]
  const catalog = normalizeNodeCatalog(rpcContent(await send('tools/call', { name: 'call_remote_tool', arguments: { tool: 'node_info', arguments: { classTypes: classes } } })).data)
  const descriptor = buildPageDescriptor({ name: workflowId, title: workflowId, graph, nodeInfos: catalog })
  const html = renderPageHtml(descriptor, { token: 'demo', quickCommands: [{ name: '抽卡', label: '🎲 抽卡' }] })
  mkdirSync(join(root, 'tmp'), { recursive: true })
  writeFileSync(join(root, 'tmp', 'wfpage-sample.html'), html, 'utf8')
  const fields = descriptor.sections.flatMap((section) => section.fields)
  const byType = {}
  for (const field of fields) byType[field.type] = (byType[field.type] ?? 0) + 1
  console.log(`工作流 ${workflowId}：${descriptor.nodeCount} 节点 → ${descriptor.sections.length} 组 / ${fields.length} 个表单字段`)
  console.log('字段类型分布:', JSON.stringify(byType))
  console.log('catalog 命中类:', classes.filter((cls) => catalog[cls] !== undefined).length, '/', classes.length)
  console.log('样本页: tmp/wfpage-sample.html', html.includes('data-field=') ? '(含表单控件 ✓)' : '(无控件 ✗)')
} finally {
  child.kill()
}

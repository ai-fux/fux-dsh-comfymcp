/**
 * 活链路实证：本地 ComfyUI UI 格式工作流 → 服务端转换 → 页面表单字段。
 * 用法：node scripts/verify-local-ui.mjs
 */
import { spawn } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWorkbenchMethods } from '../plugins/dsh-comfymcp-client/lib/workbench.js'
import { apiGraphFromUi } from '../plugins/dsh-comfymcp-client/lib/wfgraph.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const hostEntry = join(root, 'mcp', 'bin', 'fux-comfymcp-host.mjs')
const overlay = JSON.parse(readFileSync(join(process.env.DSH_HOME ?? '', 'comfymcp', 'config-overlay.json'), 'utf8'))
const workflowDir = overlay.workflowDirs

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
    setTimeout(() => reject(new Error(`timeout ${method}`)), 120000)
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

function rpcContent(result) {
  const content = Array.isArray(result?.content) ? result.content : []
  const text = content.find((entry) => entry.type === 'text')?.text ?? '{}'
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

/** 真实 bridge：只实现工作台页面所需的 callRemote。 */
const bridge = {
  config: overlay,
  listRuns: () => [],
  recordRun: (run) => ({ ...run, id: 'probe' }),
  async callRemote(tool, args = {}) {
    const result = await send('tools/call', { name: 'call_remote_tool', arguments: { tool, arguments: args } })
    return { structuredContent: rpcContent(result) }
  },
}

try {
  await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify-ui', version: '0' } })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n')

  const workbench = createWorkbenchMethods({
    bridge,
    config: { ...overlay, homeDir: join(root, 'tmp', 'probe-home'), dataDir: join(root, 'tmp', 'probe-home', 'data') },
  })
  // 诊断：服务端目录可见性 + saved 匹配 + 转换结果
  const listAnswer = await bridge.callRemote('list_workflows', {})
  const listData = listAnswer?.structuredContent?.data ?? {}
  console.log('[诊断] list_workflows total =', listData.total, 'entries =', Array.isArray(listData.workflows) ? listData.workflows.length : 'n/a')
  const sample = Array.isArray(listData.workflows) ? listData.workflows.find((w) => String(w.id).includes('image_z_image')) : undefined
  console.log('[诊断] 匹配条目 =', JSON.stringify(sample))
  const convAnswer = await bridge.callRemote('get_workflow', { id: 'saved:image_z_image.json' })
  const convData = convAnswer?.structuredContent?.data ?? {}
  console.log('[诊断] saved 转换: converted =', convData.converted, 'nodes =', convData.graph ? Object.keys(convData.graph).length : 'no graph', 'error =', convData.error ?? '-')
  const files = readdirSync(workflowDir).filter((name) => /\.json$/i.test(name))
  mkdirSync(join(root, 'tmp'), { recursive: true })
  for (const file of files) {
    const name = file.replace(/\.json$/i, '')
    const page = await workbench.pageWorkflow(name, { token: 'demo' })
    // 展平后的图提交服务端校验（证明不只是能出表单，而是可执行）
    const raw = JSON.parse(readFileSync(join(workflowDir, file), 'utf8'))
    const flat = apiGraphFromUi(raw)
    const check = await bridge.callRemote('validate_workflow', { graph: flat.graph })
    const checkData = check?.structuredContent?.data ?? {}
    const verdict = checkData.valid === true
      ? '校验通过 ✓'
      : `校验问题: ${JSON.stringify(checkData.errors ?? checkData.error ?? 'unknown').slice(0, 160)}`
    if (page.error !== undefined) {
      console.log(`${name}: ✗ ${page.error}`)
      continue
    }
    const fields = (page.html.match(/data-field="/g) ?? []).length
    const sections = (page.html.match(/<h3>/g) ?? []).length
    const note = /已由服务端转换/.test(page.html) ? '服务端转换' : /已本地转换/.test(page.html) ? '本地转换' : 'API 图直读'
    console.log(`${name}: ${fields} 个表单字段 / ${sections} 组 · ${note} · 展平后 ${Object.keys(flat.graph).length} 节点 · ${verdict}`)
    if (file.startsWith('image_z_image')) writeFileSync(join(root, 'tmp', `live-${name}.html`), page.html, 'utf8')
  }
  console.log('样本页: tmp/live-image_z_image.html')
} finally {
  child.kill()
}

/**
 * 远程 Streamable HTTP 通路的活体验证：
 *   1) 起一个真实 comfy-mcp-server（独立进程，HTTP :18800，mock 后端）；
 *   2) 插件以「远程模式」（embeddedServer:false）用 Streamable HTTP 直连它；
 *   3) 走完握手 → 工具目录 → node_search（卸载探测）→ list_workflows。
 * 用法：node scripts/verify-remote-http.mjs
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ComfymcpBridge } from '../plugins/dsh-comfymcp-client/lib/bridge.js'
import { resolveConfig } from '../plugins/dsh-comfymcp-client/lib/config.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(root, 'comfy-mcp-server', 'bin', 'comfy-mcp-server.mjs')
const port = 18991
const endpoint = `http://127.0.0.1:${port}/mcp`

const child = spawn(process.execPath, [entry], {
  env: { ...process.env, COMFY_MCP_SERVER_PORT: String(port), COMFY_MCP_SERVER_HOST: '127.0.0.1', COMFY_MCP_BACKEND: 'mock' },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
const ready = new Promise((resolve, reject) => {
  let text = ''
  const timer = setTimeout(() => reject(new Error('服务端 20s 内未就绪')), 20000)
  const onData = (chunk) => {
    text += chunk.toString()
    if (/listening on /.test(text)) {
      clearTimeout(timer)
      resolve()
    }
  }
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)
  child.on('exit', (code) => reject(new Error(`服务端提前退出 code=${code}`)))
})

const config = resolveConfig({
  endpoint,
  embeddedServer: false, // ← 远程模式：走 Streamable HTTP
  hostEntry: '', // 故意留空：远程模式不应再要求宿主入口
  hostCommand: 'node',
  workflowDirs: [],
  saveSubdir: 'dsh-generated',
  artifactsDir: join(root, 'tmp', 'verify-remote-http'),
  requestTimeoutMs: 20000,
  callTimeoutMs: 60000,
  autoConnect: false,
})
const bridge = new ComfymcpBridge(config, { log: (line) => console.log(`    [bridge] ${line}`) })

try {
  await ready
  console.log(`[1] 真实 comfy-mcp-server 已就绪 → ${endpoint}`)
  console.log(`[2] 插件传输方式 → ${bridge.transport()}（宿主入口="${config.hostEntry}"，不参与远程模式）`)

  const probe = await bridge.probe()
  console.log(`[3] 探测 → ok=${probe.ok} · transport=${probe.host?.transport} · session=${probe.host?.session} · serverInfo=${probe.host?.serverInfo?.name ?? '-'} ${probe.host?.serverInfo?.version ?? ''}`)
  if (probe.error.length > 0) console.log(`    错误：${probe.error}`)
  console.log(`[4] 卸载节点探测 → available=${probe.unload.available} · ${probe.unload.reason}`)

  const tools = await bridge.listRemoteTools()
  const list = tools?.structuredContent?.data?.tools ?? []
  console.log(`[5] 工具目录（直连原生 tools/list）→ ${list.length} 个：${list.slice(0, 6).map((tool) => tool.name).join(', ')}…`)

  const workflows = await bridge.callRemote('list_workflows', { limit: 5 }, 30000)
  const data = workflows?.structuredContent?.data ?? {}
  const items = Array.isArray(data.workflows) ? data.workflows : Array.isArray(data.items) ? data.items : []
  console.log(`[6] call_remote_tool(list_workflows) → ok=${workflows?.structuredContent?.ok} · 条目 ${items.length} 个 · 首个 ${items[0]?.name ?? items[0]?.id ?? '-'}`)
  console.log(`[7] 结论 → ${probe.ok && list.length > 0 ? '远程 Streamable HTTP 通路可用 ✓' : '远程通路异常 ✗'}`)
} catch (error) {
  console.log('[!] 失败：', error instanceof Error ? error.message : String(error))
} finally {
  try {
    child.kill()
  } catch {
    /* ignore */
  }
  await bridge.close?.().catch?.(() => {})
  process.exit(0)
}

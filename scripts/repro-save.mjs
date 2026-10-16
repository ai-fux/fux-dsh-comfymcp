/**
 * 复现页面 save_workflow 失败：用真实工作流名 + 展平图，逐步打印响应。
 * 用法：node scripts/repro-save.mjs [工作流名，默认 image_z_image]
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ComfymcpBridge } from '../plugins/dsh-comfymcp-client/lib/bridge.js'
import { resolveConfig } from '../plugins/dsh-comfymcp-client/lib/config.js'
import { apiGraphFromUi } from '../plugins/dsh-comfymcp-client/lib/wfgraph.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const overlay = JSON.parse(readFileSync(join(process.env.DSH_HOME ?? '', 'comfymcp', 'config-overlay.json'), 'utf8'))
const config = resolveConfig({ ...overlay, embeddedBackend: 'stdio', dataDir: join(root, 'tmp', 'repro-save-data') })
const name = process.argv[2] ?? 'image_z_image'
const raw = JSON.parse(readFileSync(join(overlay.workflowDirs, `${name}.json`), 'utf8'))
const flat = apiGraphFromUi(raw)

const bridge = new ComfymcpBridge(config, { log: (line) => console.log('[bridge]', line) })
try {
  const client = await bridge.ensureReady()
  console.log('节点数:', Object.keys(flat.graph).length)
  for (const variant of [
    { label: 'A name+graph+overwrite', args: { name, graph: flat.graph, overwrite: true } },
    { label: 'B name+graph', args: { name, graph: flat.graph } },
  ]) {
    try {
      const answer = await client.callTool('call_remote_tool', { tool: 'save_workflow', arguments: variant.args })
      const structured = answer?.structuredContent
      console.log(variant.label, '→ isError=', structured?.isError, '| data=', JSON.stringify(structured?.data).slice(0, 300))
    } catch (error) {
      console.log(variant.label, '→ 抛错:', error instanceof Error ? error.message.slice(0, 300) : JSON.stringify(error).slice(0, 300))
    }
  }
} catch (error) {
  console.log('[!] 连接失败：', error instanceof Error ? error.message : JSON.stringify(error))
} finally {
  process.exit(0)
}

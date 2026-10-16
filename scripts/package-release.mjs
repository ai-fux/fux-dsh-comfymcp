#!/usr/bin/env node
/**
 * 离线安装包打包脚本（发布约定见 AGENTS.md「发布与离线安装包」）。
 *
 * 每次推送 GitHub 快照稳定版本（master + vX.Y.Z tag）后，基于该版本打两个包到 dist/：
 *   1) dsh-comfymcp-client-v<ver>-source.zip —— 纯插件零依赖包（推荐给 DSH 对话框大模型自动安装）
 *      内容：插件运行文件 + vendor 内置 comfy-mcp-server + INSTALL.md，无任何 npm 依赖。
 *   2) dsh-comfymcp-v<ver>-full.zip —— 全工程源码包（文档/脚本/参考服务端/预置包都带上）
 *      内容：整个项目仓（不含 .git / node_modules / dist / tmp），内嵌运行同样零依赖；
 *      仅开发/测试需要恢复依赖（pnpm install，catalog 由上层 workspace 提供）。
 *
 * 用法：node scripts/package-release.mjs [--version 0.4.0] [--out dist]
 * 产物不进 git（dist/ 已 ignore）；可手动附到 GitHub Release。
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const outDir = resolve(root, argOf('--out', 'dist'))

const pluginPkg = JSON.parse(readFileSync(join(root, 'plugins/dsh-comfymcp-client/package.json'), 'utf8'))
const version = argOf('--version', pluginPkg.version)

// ---- INSTALL.md：面向 DSH 对话框里的大模型，照做即可完成安装/验证/升级 ----
const installMd = (pkgName) => `# INSTALL —— 交给 DSH 大模型自动执行

你在 DSH 会话中收到本压缩包（${pkgName}）。目标：把它安装进本机 DSH 并跑通验证。
全程零 npm 依赖（内置 vendor 包），只需 Node >= 20 与能启动的 DSH。按顺序执行：

## 1. 落盘
把压缩包解压到持久目录（示例 \`D:\\dsh-comfymcp-client\`），记下解压绝对路径 <PKG_DIR>。

## 2. 挂载（二选一）
- **会话命令**（推荐）：\`plugin_manager install_bundle <PKG_DIR>\`（source 包的 <PKG_DIR> 就是解压根，内含 index.js/package.json）。
- **手改 profile**：编辑 DSH 数据目录下 \`profiles/web/package.json\`：
  - \`dependencies\` 加 \`"@ai-fux/fux-dsh-comfymcp": "link:<PKG_DIR>"\`；
  - \`dsh.profile.bundles\` 数组加 \`"@ai-fux/fux-dsh-comfymcp"\`。

## 3. 重启 DSH（必须）
宿主进程按 URL 冻结模块生成，不重启不生效。

## 4. 验证
1. 启动日志无 \`entry did not activate\`，稍后出现 \`panel channel /comfymcp ready\`；
2. Web 设置页出现「ComfyUI MCP」，「测试连接」已连接；
3. 会话内调用 \`comfymcp_status\` → \`ok: true\`（内嵌模式默认 embeddedServer=true，服务端由插件内置 vendor 包自动拉起，随机端口随 DSH 启停）。

## 5. ComfyUI 不在本机时
设置页「ComfyUI MCP」→ comfyuiUrl 改为 ComfyUI 实际地址（官方默认端口 \`8188\`，如 \`http://<局域网IP>:8188\`）并保存（热重启内置服务）。
ComfyUI 原版服务即可，无需装任何 MCP 组件（可选 custom_nodes/comfyui-unload-model 用于运行后释放显存）。

## 6. 备注
- \`cordis.patch.yml\` 里的 hostEntry 是开发机绝对路径：内嵌模式用不到，可忽略；仅切「远程模式」时在设置页改指真实宿主入口。
- 升级：用新版本包重做第 1–3 步。卸载：\`plugin_manager remove_bundle @ai-fux/fux-dsh-comfymcp\` 后重启；彻底清理删 DSH 数据目录下 \`comfymcp/\`（配置覆盖层与产物）。
- 版本：${version}（${new Date().toISOString().slice(0, 10)} 打包）
`

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

// 递归拷贝目录并应用排除规则（路径相对 dirRoot 判断）
const EXCLUDE_NAMES = new Set(['node_modules', '.git', 'dist', 'tmp', '.workplace', '.vitest', '.vite', '.vite-temp'])
function stageCopy(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true })
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const name = entry.name
    if (EXCLUDE_NAMES.has(name)) continue
    if (name.endsWith('.log') || name === '__check.mjs' || name.endsWith('.local.json')) continue
    const src = join(srcDir, name)
    const dest = join(destDir, name)
    if (entry.isDirectory()) stageCopy(src, dest)
    else if (entry.isFile()) cpSync(src, dest)
  }
}

function zipStage(stageDir, zipPath) {
  rmSync(zipPath, { force: true })
  const command = `Compress-Archive -Path '${stageDir}\\*' -DestinationPath '${zipPath}' -Force`
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
  if (result.status !== 0 || !existsSync(zipPath)) {
    throw new Error(`Compress-Archive 失败：${(result.stderr || result.stdout || '').trim()}`)
  }
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

// ---- 包 1：source（纯插件，零依赖）----
const sourceStage = join(outDir, '_stage-source')
mkdirSync(sourceStage, { recursive: true })
for (const name of ['index.js', 'client.js', 'cordis.patch.yml', 'package.json', 'lib', 'locale', 'vendor']) {
  const src = join(root, 'plugins/dsh-comfymcp-client', name)
  if (!existsSync(src)) throw new Error(`source 包缺少必需项：${name}`)
  if (statSync(src).isDirectory()) stageCopy(src, join(sourceStage, name))
  else cpSync(src, join(sourceStage, name))
}
cpSync(join(root, 'LICENSE'), join(sourceStage, 'LICENSE'))
// 功能说明随包分发（公开发布要求：首次发布包功能描述尽量全面）
cpSync(join(root, 'README.md'), join(sourceStage, 'README.md'))
writeFileSync(join(sourceStage, 'INSTALL.md'), installMd('dsh-comfymcp-client source 包'))
const sourceZip = join(outDir, `dsh-comfymcp-client-v${version}-source.zip`)
zipStage(sourceStage, sourceZip)
rmSync(sourceStage, { recursive: true, force: true })

// ---- 包 2：full（全工程源码）----
const fullStage = join(outDir, '_stage-full')
stageCopy(root, fullStage)
writeFileSync(join(fullStage, 'INSTALL.md'), installMd('dsh-comfymcp full 包（全工程）'))
const fullZip = join(outDir, `dsh-comfymcp-v${version}-full.zip`)
zipStage(fullStage, fullZip)
rmSync(fullStage, { recursive: true, force: true })

// ---- 清单与校验和 ----
const lines = []
for (const zip of [sourceZip, fullZip]) {
  const size = statSync(zip).size
  const line = `${sha256(zip)}  ${zip.split(sep).pop()}  (${(size / 1024).toFixed(1)} KiB)`
  lines.push(line)
  console.log(line)
}
writeFileSync(join(outDir, `checksums-v${version}.txt`), lines.join('\n') + '\n')
console.log(`\n完成：dist/ 下 source（零依赖插件包）+ full（全工程源码包）+ checksums-v${version}.txt`)

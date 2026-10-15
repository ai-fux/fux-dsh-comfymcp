# dsh-comfymcp 项目空间说明（AGENTS.md）

## 运行环境（按项目询问结果）

- **操作系统**：Windows（本机 Windows 11 + PowerShell；脚本均提供 `.ps1`/`.mjs`）。
- **设备**：PC（服务端进程 + 浏览器 Web GUI）。
- **窗口化**：无 GUI 窗口；DSH Web GUI（浏览器，端口 13188）+ 后台 Node 进程。
- **运行时**：Node.js >= 20（本机 v22.21.0），pnpm >= 10（本机 11.13.0），源分发 TS 用 tsx 直跑。

## 组件与端口

| 组件 | 目录 | 默认端口 | 说明 |
| --- | --- | --- | --- |
| comfy-mcp 参考服务端 | `comfy-mcp-server/` | 18800 | MCP Streamable HTTP ⇄ stdio 桥接（可接 mock 后端） |
| MCP 宿主 | `mcp/` | stdio | FUX runtime + `@fux-mcp/comfy-client`，供 DSH 插件 spawn |
| DSH 插件 | `plugins/dsh-comfymcp-client/` | — | 纯 JS 无构建，挂载进 DSH profile |

## 分支与版本

- 当前版本：**0.3.0**（封板于 2026-10-15，已合并回 `dev` 并打 tag `v0.3.0`）。
- 稳定分支：`dev`（本次汇聚点，用户指定）；上一稳定分支 `snapshot-0.2.1`、`snapshot-0.2.0`、`snapshot-0.1.0`。
- 开发分支：`dev-snapshot-20261015-0.3.0`（本次迭代，已合并）；上一轮 `dev-snapshot-20261013-0.2.1`。
- 版本：三段 `X.Y.Z`（平台 SEMVER 限制），四段仅用于分支/`.workplace` 目录名。
- 严禁推送 `main`/`master`；远程推送与分支合并需用户二次确认。
- 本地验证补充：`node scripts/check-page-templates.mjs`（页面模板完整性）、`node scripts/check-page-scripts.mjs`（页面脚本语法与关键监听）。

## 本地验证

```powershell
pnpm install
pnpm test            # 三层 vitest
pnpm typecheck
node comfy-mcp-server/bin/comfy-mcp-server.mjs --selftest
node mcp/bin/fux-comfymcp-host.mjs --selftest
```

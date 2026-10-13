# dsh-comfy-mcp（dsh-comfymcp 工程）Agent 指南

## 运行环境

- **操作系统**：Windows / macOS / Linux 均可（脚本以 PowerShell 为主，Node 脚本跨平台）。
- **设备**：PC（服务端进程 + 浏览器 Web GUI）。
- **运行时**：Node.js >= 20，pnpm >= 10；源分发 TS 用 tsx 直跑，无构建步骤。

## 组件与端口

| 组件 | 目录 | 默认端口 | 说明 |
| --- | --- | --- | --- |
| comfy-mcp 参考服务端 | `comfy-mcp-server/` | 18800 | MCP Streamable HTTP ⇄ stdio 桥接（可接 mock 后端） |
| MCP 宿主 | `mcp/` | stdio | FUX runtime + `@fux-mcp/comfy-client`，供 DSH 插件 spawn |
| DSH 插件 | `plugins/dsh-comfymcp-client/` | — | 纯 JS 无构建，挂载进 DSH profile |
| FUX 系列平台包 | `fux/packages/` | — | 本地 vendor（MIT），workspace 优先本地解析 |

## 依赖与 fux/ vendor

- `fux/packages/*` 为 FUX 系列包本地 vendor（MIT；来源与移除计划见 `fux/README.md`）。
- 跨包依赖一律 `workspace:*` 本地解析；禁止直接 import 其它插件源码路径。
- FUX 全系仓库公开后移除 vendor 目录并切换在线依赖，期间不要把 `fux/` 当作可随意改动的
  本仓源码——它是对上游包的快照，修改需注明并在上游同步。

## 分支与版本

- 分支模型：`master` 为公开主干（唯一公开分支）；版本分支 `snapshot-<version>` 按需发布；
  迭代开发分支 `dev-snapshot-<yyyyMMdd>-<version>` 留在本地，内容检查通过后合并 `master` 再推送。
- 版本：三段 `X.Y.Z`（平台 SEMVER 限制）；发布时打 `vX.Y.Z` tag。
- 远程推送需用户二次确认；严禁强推已发布分支。

## 提交纪律

- Conventional Commits（`feat:` / `fix:` / `docs:` / `test:` / `refactor:` / `chore:`），
  祈使句，subject <= 72 字。
- 新能力必须带测试：happy path + 一个错误路径 + 一个边界（语句覆盖 >= 80%）。

## 敏感信息纪律

- 严禁提交：本机绝对路径（如 `X:\...`）、内网地址、任何凭据 / token / 私钥。
- 本地环境配置放 `config/*.env`（已被 `.gitignore` 忽略），模板见
  `config/comfymcp.env.example`；示例值一律用文档保留段（如 `192.0.2.0/24`）。

## 本地验证

```powershell
pnpm install
pnpm test            # 全部 vitest
pnpm typecheck
node comfy-mcp-server/bin/comfy-mcp-server.mjs --selftest
node mcp/bin/fux-comfymcp-host.mjs --selftest
```

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

- 当前版本：**0.4.0**（封板于 2026-10-16，已合并回 `dev` 并打 tag `v0.4.0`；同日经用户授权推 GitHub：master 快照合并 + tag，见「发布与离线安装包」）；上一稳定版 0.3.1（tag `v0.3.1`）、0.3.0（tag `v0.3.0`）。
- 稳定分支：`dev`（本次汇聚点，用户指定）；历史稳定分支 `snapshot-0.2.1`、`snapshot-0.2.0`、`snapshot-0.1.0`。
- 开发分支：`dev-snapshot-20261016-0.4.0`（已合并）；上一轮 `dev-snapshot-20261016-0.3.1`（已合并）。
- 版本：三段 `X.Y.Z`（平台 SEMVER 限制），四段仅用于分支/`.workplace` 目录名。
- 严禁推送 `main`/`master`；远程推送与分支合并需用户二次确认。
- 本地验证补充：`node scripts/check-page-templates.mjs`（页面模板完整性）、`node scripts/check-page-scripts.mjs`（页面脚本语法与关键监听）。

## 版本升级说明（0.4.0）

**新版本升级优化功能**：

1. **命中业务类 → 表单标题提示**：`comfymcp_business match` 命中后，`comfymcp_push_form`
   确认表单标题自动以业务类显示名开头（模型写了同名开头不重复拼），用户一眼可见本次按哪类执行；
   match 的 nextSteps 同步提示。
2. **候选智能排序 + 自动/手动换主**：新增 `workflowOutcomeStats`（只认 completed/failed）与
   `businessRanking`（得分 = 成功×3 + 使用 − 失败 +（成功过再 +1））；`auto=true` 的业务配置在
   候选明显更好（≥2 次成功且得分超主配置 3 分）时自动提升为主配置，手动配置永不自动改；
   工作台业务卡候选条带 ✓/✗ 战绩、一键「设为主配置」（原主退候选 demoted）。
3. **业务级参数预设集**：业务配置可存 ≤12 条参数预设（同名覆盖、空参数拒绝）；
   模型侧 `preset_save` / `preset_remove` / register 带 `presetName`，match 带出
   `matched.presets`；工作台业务卡预设 chip（套用/删除/存当前参数）、工作流页「业务预设」条
   按字段名一键填表。
4. **发布工程**：GitHub 快照发布约定 + 离线安装包（source 零依赖插件包 / full 全工程源码包，
   包内 INSTALL.md 供 DSH 对话框大模型自动安装）；README 按公开发布重写。
5. **默认端口对齐官方**：ComfyUI 默认地址从本机测试端口 8000 改为官方默认 **8188**
   （代码默认 / 行配置 / 设置页占位 / 文档同步）；老部署若 ComfyUI 仍在非 8188 端口，
   重启后在设置页确认 comfyuiUrl 即可（已有显式配置不受影响）。

**修复问题**（含 0.3.1）：

- 0.3.1：devMode 经设置页保存后丢失/不即时生效 → 活值化（写入即时生效）+ 落盘原子写。
- 0.4.0：运行战绩统计只认已结论运行（running/aborted 不计），避免误判候选优劣；
  预设保存合并不丢已有 createdAt；远端模板命中时预设提示两路（本地图/远端）都带出。

**升级注意**：宿主半区改动需**重启 DSH** 加载；`business.json` 向后兼容自动补 `presets`
字段，无迁移动作；升级后建议跑一遍 `comfymcp_status` 与工作台业务页确认。

## 本地验证

```powershell
pnpm install
pnpm test            # 三层 vitest
pnpm typecheck
node comfy-mcp-server/bin/comfy-mcp-server.mjs --selftest
node mcp/bin/fux-comfymcp-host.mjs --selftest
```

## 发布与离线安装包（GitHub 快照）

- **快照发布**：稳定版本推 GitHub 仓库（`github` remote）并合并至 `master`，同时打 `vX.Y.Z` tag；`main`/`master` 推送仍需用户明确授权。GitHub `master` 与本地 dev 是两条历史线（0.1.0 公开快照起点），合并用 plumbing 合并提交（master 树 = 发布版树，双父保留两条历史）。
- **离线安装包（强制约定）**：每次成果推送完 GitHub 快照稳定版本，必须基于该版本运行 `node scripts/package-release.mjs` 打离线安装压缩包，产物落 `dist/`（已 gitignore，不入 git；可手动附到 GitHub Release）：
  - `dsh-comfymcp-client-v<ver>-source.zip`：**纯插件零依赖包**（运行文件 + vendor 内置 comfy-mcp-server + INSTALL.md；推荐用于「发给 DSH 对话框由大模型自动安装」）；
  - `dsh-comfymcp-v<ver>-full.zip`：**全工程源码包**（文档/脚本/参考服务端/预置包齐带；内嵌运行同样零依赖，仅开发测试需恢复 pnpm 依赖）；
  - 附 `checksums-v<ver>.txt`（SHA256）。
- **包内 INSTALL.md** 面向 DSH 会话大模型：落盘解压 → `plugin_manager install_bundle` 或 profile `link:` 挂载 → 重启 DSH → `comfymcp_status` 验证 →（ComfyUI 在别的机器）设置页改 `comfyuiUrl`。用户把 zip 发进 DSH 对话框，大模型照做即可完成安装。
- 打包脚本零依赖（Node 内置 + 系统 Compress-Archive）；插件本体运行零 npm 依赖是「source 包离线可装」的前提，改动插件依赖时必须同步评估打包清单。

# fux/ — FUX 系列包本地 vendor 目录（临时）

本目录临时内置 dsh-comfy-mcp 依赖的 FUX 系列包（均为 MIT 许可），使本仓**克隆即可
安装运行**，无需等待这些包发布到公共 registry。

| 包 | 版本 | 来源 |
| --- | --- | --- |
| `@fux/protocol` / `@fux/core` / `@fux/queue` / `@fux/connector` / `@fux/ui` / `@fux/runtime` | 0.0.35 | [fux-os-base](https://gitee.com/mycode_hub/fux-os-base)（MIT，见 `LICENSE`） |
| `@fux-mcp/comfy-client` | 0.1.0 | 通用 MCP 客户端插件（Streamable HTTP only，MIT） |

## 加载方式

仓库级 `pnpm-workspace.yaml` 已将 `fux/packages/*` 纳入 workspace，所有
`workspace:*` 依赖（MCP 宿主 `mcp/` → `@fux/*`、`@fux-mcp/comfy-client`）优先解析到
本目录，即「加载时优先走本地目录」。

## 移除计划（在线更新）

待 FUX 全系列仓库发布到公共仓后：

1. 删除本 `fux/` 目录；
2. 将 `mcp/package.json` 中的 `workspace:*` 依赖切换为在线版本（registry 或 git 依赖）；
3. `pnpm install` 重新解析，完成在线更新。

各包 `package.json` 的 `repository` 字段保留上游来源，便于追溯。

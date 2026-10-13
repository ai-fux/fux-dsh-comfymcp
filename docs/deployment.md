# dsh-comfymcp 部署文档

> 版本 0.2.1（迭代分支 `dev-snapshot-20261013-0.2.1`；上一稳定分支 `snapshot-0.2.0`）· 更新日期 2026-10-13
> 配套文档：[操作手册](operations.md) · [协议说明](protocol.md) · [迭代记录](roadmap.md) · [总览 README](../README.md)

## 1. 架构总览

```
大模型（Agent 会话）
   │  comfymcp_* 工具调用 / 结构化表单（ask-user-question）
   ▼
dsh-comfymcp-client（DSH 插件，纯 JS 无构建）
   │  spawn stdio
   ▼
MCP 宿主 fux-comfymcp-host.mjs（FUX runtime + @fux-mcp/comfy-client 通用插件）
   │  MCP Streamable HTTP :18800
   ▼
comfy-mcp-server 参考服务端（Node，可配 mock / stdio 两种后端）
   │  mock：内置 13 工具离线联调，出 PNG
   │  stdio：spawn fux-comfyui-mcp.mjs（Node，仅 HTTP 访问 ComfyUI）
   ▼
ComfyUI（:8000，用户自备，.venv Python 3.12）
   └─ custom_nodes/comfyui-unload-model（卸载节点，无 pip 依赖）
```

端口一览：

| 端口 | 归属 | 说明 |
| --- | --- | --- |
| 13188 | DSH Web GUI | 浏览器入口（含设置页、产物卡） |
| 18800 | comfy-mcp 服务端 | MCP Streamable HTTP（`/mcp`） |
| 8000 | ComfyUI | 仅 comfy-mcp 的 stdio 后端访问 |

## 2. 前置条件

| 项 | 要求 | 本机实测 |
| --- | --- | --- |
| Node.js | >= 20 | v22.21.0 |
| pnpm | >= 10 | 11.13.0 |
| DSH | Web profile 正常启动 | GUI :13188 |
| ComfyUI | 真实模式才需要，:8000 | v0.39.2 运行中 |
| Python | 仅 ComfyUI 自身 `.venv` 需要（3.12） | 链路本身零 Python 依赖 |
| 卸载节点 | `custom_nodes/comfyui-unload-model`（可选，缺失仅影响自动卸载） | 已装并已加载 |

## 3. 安装步骤

以下命令均在项目根 `F:\AgentWorkplace\dsh\dsh-13188-comfymcp\projects\dsh-comfymcp` 执行。

### 3.0 两种部署形态（先选一个）

| 形态 | 说明 | 适合 |
| --- | --- | --- |
| **内嵌（默认，推荐单机）** | comfy-mcp 服务端由 DSH 插件**自动拉起**：随机空闲端口、随 DSH 启停、无需任何手动操作；ComfyUI 可在本机或局域网任意主机（后端仅走 HTTP） | 本机开发/单人使用 |
| **外置** | comfy-mcp 服务端按 3.2 单独启动；设置页/行配置关闭内嵌开关，endpoint 指向该服务 | 多消费者共享、独立生命周期、部署在服务器主机 |

内嵌模式的默认配置已写入行配置（`embeddedServer: true` + stdio 后端指向
兄弟项目 `fux-comfyui-mcp.mjs`）；**comfy-mcp-server 程序已内置在插件包内**
（`vendor/comfy-mcp-server.mjs`，esbuild 单文件零依赖打包），部署时无需关心其路径，
env `DSH_COMFYMCP_SERVER_ENTRY` 或覆盖层 `serverEntry` 可显式覆盖。
ComfyUI 服务地址可在设置页（内置模式）直接配置（`comfyuiUrl`，默认
`http://127.0.0.1:8000`，保存后自动重启内置服务）。ComfyUI 原版服务即可，无需在
ComfyUI 内装任何 MCP 组件（可选 `comfyui-unload-model` 仅用于运行后释放显存）。

### 3.1 安装仓内依赖并自检

```powershell
pnpm install
pnpm test                                              # 三层 vitest 全绿
node comfy-mcp-server/bin/comfy-mcp-server.mjs --selftest
node mcp/bin/fux-comfymcp-host.mjs --selftest
```

### 3.2 启动 comfy-mcp 服务端（仅外置形态需要）

**离线联调（mock 后端，出 PNG）**：

```powershell
$env:COMFY_MCP_BACKEND='mock'; $env:COMFY_MCP_SERVER_PORT='18800'
node comfy-mcp-server/bin/comfy-mcp-server.mjs
```

**真实模式（stdio 后端，接运行中的 ComfyUI :8000）**：

```powershell
$env:COMFY_MCP_BACKEND='stdio'
$env:COMFY_MCP_SERVER_PORT='18800'
$env:COMFY_MCP_BACKEND_CMD='node'
$env:COMFY_MCP_BACKEND_ARGS='F:\AgentWorkplace\dsh\dsh-1-comfy-p\projects\dsh-comfyui\mcp\bin\fux-comfyui-mcp.mjs'
node comfy-mcp-server/bin/comfy-mcp-server.mjs
```

验证：`Invoke-WebRequest http://127.0.0.1:18800/mcp -Method Options -UseBasicParsing` 返回 2xx/405 均视为存活。

### 3.3 挂载 DSH 插件

在 DSH 会话内执行（本环境由 Agent 代操作）：

```
plugin_manager remove_bundle dsh-comfymcp-client        # 若已挂载
plugin_manager install_bundle <项目>\plugins\dsh-comfymcp-client
```

### 3.4 重启 DSH（必须）

宿主进程按 URL 缓存模块记录与生成快照，**进程内不刷新**（官方语义：
*"replacing an installed package requires restart to load a fresh JavaScript module generation"*）。
任何插件代码改动（Host 半区）都要 `install_bundle` + 重启 DSH 才生效。

> 经验：改了代码但启动仍报旧错误的堆栈行号，先怀疑快照冻结，重启一次再看。

### 3.5 验证激活

1. 启动日志**无** `1 entry did not activate`；稍后出现
   `panel channel /comfymcp ready (attempts=N)`（面板通道在 webServer 就绪后自动挂载，
   N>1 属正常——webServer 异步落位，插件内置就绪重试，最长 2 分钟）。
2. DSH Web → **设置 → ComfyUI MCP** 出现设置页（连接状态点、三个分区卡片）。
3. 会话内 Agent 调 `comfymcp_status` → `ok: true`；mock 模式 `unload.available: true`。

## 4. 配置参考

### 4.1 层序（高 → 低）

```
环境变量（DSH_COMFYMCP_* / COMFY_MCP_*）
  > DSH 行配置（cordis.patch.yml 的 dsh-comfymcp-client 行）
  > 覆盖文件 $DSH_HOME/comfymcp/config-overlay.json（设置页「保存配置」写入，原子写）
  > 内置默认值
```

### 4.2 键位

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_COMFYMCP_HOST_ENTRY` | 项目内 `mcp/bin/fux-comfymcp-host.mjs` | DSH 插件 spawn 的宿主入口 |
| `COMFY_MCP_ENDPOINT` | `http://127.0.0.1:18800/mcp` | comfy-mcp 服务端点 |
| `COMFY_MCP_SERVER_PORT` | 18800 | comfy-mcp 服务端自身监听 |
| `COMFY_MCP_BACKEND` | `mock` | `mock` \| `stdio` |
| `COMFY_MCP_BACKEND_CMD` / `_ARGS` | — | stdio 后端启动命令（见 3.2） |
| `DSH_COMFYUI_URL` | `http://127.0.0.1:8000` | 兄弟后端用的 ComfyUI 地址（其 env 文件管理） |
| 设置页可改 | endpoint / workflowDirs / saveSubdir / artifactsDir / hostEntry / autoUnloadModel / embeddedServer | 保存进覆盖文件，即时生效 |
| `embeddedServer` / `comfyuiUrl` / `embeddedBackend` / `embeddedBackendCommand` / `embeddedBackendArgs` / `serverEntry` | 行配置见 bundle patch | 内嵌服务端：开关 / ComfyUI 服务地址（设置页可配，保存即热重启内置服务）/ `mock`\|`stdio` / 后端命令 / 后端参数 / 服务入口（默认用插件内置 vendor 包）；env 别名 `DSH_COMFYMCP_SERVER_ENTRY` |

完整示例见 [`config/comfymcp.env`](../config/comfymcp.env)。

## 5. 真实模式切换与 Python 侧要求

1. ComfyUI 运行于 :8000（`Invoke-WebRequest http://127.0.0.1:8000/system_stats`）。
2. 卸载节点已注册（`Invoke-WebRequest http://127.0.0.1:8000/object_info/UnloadAllModels`）；
   未安装时到 `custom_nodes/` 放入 `comfyui-unload-model` 并重启 ComfyUI（无 pip 依赖）。
3. comfy-mcp 服务端按 3.2 真实模式重启。
4. `comfymcp_status` → `ok: true` 且 `unload.available: true`。

Python 侧细节与验证清单见 README「Python 侧依赖」一节——链路对 Python 只有
ComfyUI HTTP API 与卸载节点两个接触点，无进程 spawn、无 pip install。

## 6. 卸载 / 回滚

```
plugin_manager remove_bundle dsh-comfymcp-client   # 移除插件（随后重启 DSH）
```

覆盖文件与产物目录独立于插件存在，如需彻底清理：
`$DSH_HOME/comfymcp/config-overlay.json`、DSH 数据目录下 `comfymcp/artifacts`。

## 7. 部署验证清单（CheckList）

- [ ] `pnpm test` 全绿；两个 `--selftest` 通过
- [ ] comfy-mcp 服务端存活（:18800）
- [ ] install_bundle 成功且 DSH 重启后无 activation 报错
- [ ] 启动日志出现 `panel channel /comfymcp ready`
- [ ] 设置页可见且「测试连接」返回已连接
- [ ] mock：`comfymcp_status` ok + unload available
- [ ] （真实模式）object_info 命中 UnloadAllModels + status unload available
- [ ] E2E：自然语言 → 表单 → 运行 → 产物卡回显（见操作手册 §2）

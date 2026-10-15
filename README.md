# dsh-comfymcp — DSH ⇄ comfy-mcp 对接（v0.2.1）

把 DSH（DeepSeek Harness）接入 ComfyUI 生成链路：大模型基于自然语言设计可运行工作流 →
定制表单向用户确认 → 强制保存后运行 → 成果物回显到会话；并内置**图形工作台**（工作流静态页、
执行进度与中断、成果物库检索 / 标签 / 导出）。

> v0.2.1 封板于 2026-10-15（已合并回 `dev`，tag `v0.2.1`；开发分支 `dev-snapshot-20261013-0.2.1`）。
> 本期重点：配置界面精简、卸载开关语义修正、**工作台 UI 打磨**（真瀑布流排布、卡片分层与操作主次、
> 整屏遮罩灯箱、多图收集卡与子级画廊、参数确认框文案与取消语义）。
> 上一稳定版本 v0.2.0（`snapshot-0.2.0`）、v0.1.0（`snapshot-0.1.0`）。本期交付清单见 [迭代记录](docs/roadmap.md)。

## 组件与端口

| 组件 | 目录 | 端口/形态 | 说明 |
| --- | --- | --- | --- |
| comfy-mcp 参考服务端 | `comfy-mcp-server/` | Streamable HTTP :18800 | MCP HTTP ⇄ stdio 桥；`COMFY_MCP_BACKEND=mock` 内置 mock，`stdio` 接真实 ComfyUI MCP |
| MCP 宿主 | `mcp/` | stdio | FUX runtime + `@fux-mcp/comfy-client`（通用客户端插件，capability `mcp-comfy:*`），由 DSH 插件 spawn |
| DSH 插件 | `plugins/dsh-comfymcp-client/` | Host+Client 双半区 | Host：`comfymcp_*` 工具 + 技能 + 工作台控制端点（环回 :18801+）；Client：侧栏工作台面板（三 Tab）+ 设置页 + 运行产物卡 |
| FUX 通用客户端插件 | 工作区 `plugins/fux-plugin-mcp-comfy-client/` | 独立仓 | 四层链路的通用 MCP 客户端（Streamable HTTP only），被 MCP 宿主复用 |

链路：**大模型 → dsh-comfymcp-client → MCP 宿主(stdio) → comfy-mcp(Streamable HTTP :18800) → ComfyUI MCP(stdio) → ComfyUI(:8000)**

## 图形工作台（v0.2.0 新增）

侧栏「ComfyUI 工作台」→ 中央面板，三个平价 Tab（浏览器亦可直开 `http://127.0.0.1:18801/ui`）：

| Tab | 路由 | 能力 |
| --- | --- | --- |
| 我的工作流 | `/ui` | 本地工作流列表；模板执行过一次会自动落库到这里；打开即带出**上次运行的参数**（字段标「上次」） |
| 模板 | `/ui/library` | 远端模板库；点开即渲染表单，执行一次自动保存到「我的工作流」 |
| 成果物 | `/ui/artifacts` | 卡片库（瀑布流 / 两列平铺 / 重叠摊开）、复合语法检索、勾选批量删除、导出 JSON（base64 内嵌） |

工作流页：按 `node_info` 解析成表单（提示词类为大域 textarea，可 `⤢ 展开` 全文编辑）→ 执行（异步 +
进度 + 执行中禁用 + 手动中断 + 单工作流最大运行时间超时中断）→ 成果按运行分组展示（参数可展开 / 悬浮）。

成果物库复合检索语法：空格＝与、`|`＝或、`-`＝排除，字段限定 `tag:` / `param:` / `field:` / `prompt:` /
`file:` / `name:` / `state:` / `seed:` / `kind:`，比较 `= != ~ > >= < <=`（页面内「? 语法」有速查表与可点示例）。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [部署文档](docs/deployment.md) | 架构总览、前置条件、安装/挂载/重启、配置参考、真实模式切换、卸载回滚、CheckList |
| [操作手册](docs/operations.md) | 日常自然语言生成流程、工作台三 Tab 操作、设置页、服务启停/热迭代、故障排查表、E2E 清单 |
| [协议说明](docs/protocol.md) | MCP 协议细节、stdio 桥接、表单契约、页面协议 v1、运行工具契约、卸载插桩设计 |
| [迭代记录](docs/roadmap.md) | v0.2.0 交付清单与封板校验、v0.1.0 历史、下个迭代候选 |
| [配置示例](config/comfymcp.env) | 环境变量样例（含真实模式与 Python 侧要求注释） |

## 本地验证

```powershell
pnpm install
pnpm test                                   # 全部 vitest（插件 143 + server 13 + host/存储/协议等，共 400+）
pnpm typecheck
node comfy-mcp-server/bin/comfy-mcp-server.mjs --selftest
node mcp/bin/fux-comfymcp-host.mjs --selftest
node scripts/check-page-templates.mjs       # 页面模板完整性（防模板被截断）
node scripts/check-page-scripts.mjs         # 页面脚本语法与关键监听
```

## Python 侧依赖（ComfyUI 链路）

本链路对 Python **只有两个接触点**，全部经 ComfyUI HTTP API（:8000），无任何 Python 进程 spawn、无额外 pip 依赖：

1. **ComfyUI 运行时**（用户自备）：`.venv`（Python 3.12）自行管理；链路只消费其 HTTP API
   （`/prompt` `/history` `/view` `/object_info`）。
2. **模型卸载节点 `comfyui-unload-model`**（手动安装进 `ComfyUI/custom_nodes/`）：
   - 依赖仅 ComfyUI 自带（`comfy.model_management` / `torch` / `gc`），**无需 pip install**；
   - 注册键名 `UnloadAllModels`（输入 `value: *` 直通、输出 `*`），与 `comfymcp_run_workflow`
     的链路内插桩契约（上游输出 → value → 原消费者）一致；
   - 安装后重启 ComfyUI 生效。

**验证清单**（真实模式前逐项过一遍）：

```powershell
# ① ComfyUI 存活
Invoke-WebRequest http://127.0.0.1:8000/system_stats -UseBasicParsing
# ② 卸载节点已注册（返回 JSON 即为已加载）
Invoke-WebRequest http://127.0.0.1:8000/object_info/UnloadAllModels -UseBasicParsing
# ③ 链路级探测：comfymcp_status → unload.available = true（等效于 node_search UnloadAllModels）
```

真实模式后端（stdio MCP）入口：`F:\AgentWorkplace\dsh\dsh-1-comfy-p\projects\dsh-comfyui\mcp\bin\fux-comfyui-mcp.mjs`
（Node 程序，内部同样只讲 HTTP）。

## 部署（挂进 DSH profile）

1. 启动 comfy-mcp 服务端（无 ComfyUI 先用 mock）：
   ```powershell
   $env:COMFY_MCP_BACKEND='mock'; $env:COMFY_MCP_SERVER_PORT='18800'
   node comfy-mcp-server/bin/comfy-mcp-server.mjs
   ```
2. `plugin_manager install_bundle` 挂载 `projects/dsh-comfymcp/plugins/dsh-comfymcp-client`（绝对路径）。
3. **重启 DSH 生效**：宿主进程的模块记录/生成快照按进程冻结，安装后需重启才装载
   （文档语义：*"replacing an installed package requires restart to load a fresh JavaScript
   module generation"*）。行配置已带默认：endpoint 18800、hostEntry 指向本仓 MCP 宿主、
   workflowDirs 指向 ComfyUI 工作流目录。
4. 热迭代插件代码后：重跑 `install_bundle` + 重启 DSH。`scripts/build-host-entry.mjs`
   可生成全新 URL 的模块树（`plugin-entry.mjs` + `runtime-vN/`），供不重启调试时换 specifier
   绕过负缓存（实验性，规范入口仍是 `index.js`）。

## 配置层序

`环境变量（DSH_COMFYMCP_* / COMFY_MCP_*） > DSH 行配置 > 覆盖文件（$DSH_HOME/comfymcp/config-overlay.json，设置页"保存配置"写入） > 默认值`

设置页（DSH Web → 设置 → ComfyUI MCP）：endpoint、工作流空间、保存子目录、产物目录、
MCP 宿主入口、自动卸载开关（服务端无 UnloadAllModels 插件或未连接时置灰并提示三态原因）。

## 工具一览（Host 半区，模型可调用）

| 工具 | 作用 |
| --- | --- |
| `comfymcp_status` | 探测链路 + 卸载插件可用性（永不抛错） |
| `comfymcp_discover` | 列出本地工作流空间 + 远端模板 + 模型清单 |
| `comfymcp_analyze_workflow` | 需求拆解 + 从模板/内联图推导定制字段（提示词/种子/数值/枚举） |
| `comfymcp_push_form` | 组装问题列表并经 ask-user-question 推送用户（种子三选项：用随机/重随/固定值） |
| `comfymcp_apply_form` | 把答案回写图（custom 优先），产出可运行工作流 |
| `comfymcp_run_workflow` | 强制 save_workflow → 整合 UnloadAllModels（链路内插桩）→ run → job_wait → fetch 产物 |
| `comfymcp_fetch_artifacts` | 下载远端成果物到本地并登记 |
| `comfymcp_call_remote` | 逃生舱：直调远端任意工具 |

Client 半区：`settings.section`（id=comfymcp）+ `tool.call.toolview`（keyed
`comfymcp_run_workflow`/`comfymcp_fetch_artifacts`）产物卡，图像经
`/api/comfymcp/artifact?path=`（containment 校验）回显。

## E2E 验收清单（重启 DSH 后执行）

1. `Tool.listTools` 出现 8 个 `comfymcp_*`；`Config.listConfigs` 可见行配置。
2. `comfymcp_status` → ok（mock 后端）+ unload available（mock 提供 UnloadAllModels）。
3. `comfymcp_discover` → 本地工作流空间列出（F:\Comfy\ComfyUI\user\default\workflows）。
4. `comfymcp_analyze_workflow`（内联图）→ 字段推导（text/seed/number/enum）。
5. `comfymcp_push_form` → GUI 弹表单 → 答复 → `comfymcp_apply_form`。
6. `comfymcp_run_workflow`（mock 后端出 PNG）→ 产物卡回显 + `dsh-generated` 保存记录。
7. 真实模式：`COMFY_MCP_BACKEND=stdio` + `COMFY_MCP_BACKEND_CMD/ARGS` 指向 ComfyUI 侧
   `fux-comfyui-mcp.mjs`（ComfyUI :8000 运行中），重跑 2-6。

## 版本与分支

- 当前版本：`0.2.1`（tag `v0.2.1`，已合并回 `dev`）；开发分支 `dev-snapshot-20261013-0.2.1`，上一轮 `dev-snapshot-20261011-0.2.0`。
- 稳定汇聚：本次按要求合并至 `dev`；历史稳定分支 `snapshot-0.2.0`、`snapshot-0.1.0`、`dev-snapshot-20261011-0.1.0`。
- 版本：三段 `X.Y.Z`（平台 SEMVER 限制），四段仅用于分支/`.workplace` 目录名。

## 本次迭代（0.1.0-MVP）完成内容

- 四层链路全组件落地并测试通过（coverage：fux-client 89.17%，其余全绿）。
- MCP 协议：Streamable HTTP only；stdio 桥（initialize 2025-03-26 ⇄ 2024-11-05）。
- 表单契约 `fields[{id,nodeId,field,kind,...}]`；种子推送时随机一次，答案 custom 优先。
- 卸载节点整合：上游输出 → UnloadAllModels.value → 原消费者输入（链路内插桩，优先 Save/Preview 端点）。

## 建议下次迭代

1. 真实 ComfyUI 模式 E2E（依赖 ComfyUI :8000 与 fux-comfyui-mcp 就绪）。
2. 产物 `ref=` 直取（绕过先下载）；产物登记持久化（现内存，重启失效）。
3. 运行历史持久化；工作流空间模板检索走远端搜索而非目录扫描。
4. 远程 GitLab 推送（`dsh-comfymcp` / `fux-plugin-mcp-comfy-client`，用户二次确认后）。

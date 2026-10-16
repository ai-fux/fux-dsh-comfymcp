# dsh-comfymcp — DSH ⇄ ComfyUI 对接（v0.4.0）

把 DSH（DeepSeek Harness）接入 ComfyUI 生成链路：大模型基于自然语言设计可运行工作流 →
定制表单向用户确认 → 强制保存后运行 → 成果物回显到会话；并内置**图形工作台**
（工作流/模板/成果物/快捷指令/业务配置五个页面）与**业务配置**记忆。

> **v0.4.0**（2026-10-16 封板，tag `v0.4.0`，已推 GitHub `master`）——**业务配置增强包**：
> ① 命中业务类时表单标题直接亮出业务类；② 多工作流候选按运行战绩智能排序，支持自动/手动换主；
> ③ 业务级参数预设集（工作台一键套用 + 模型侧存取）。
> 上一版 v0.3.1（devMode 保存丢失修复）· v0.3.0（业务配置）· v0.2.1（页面体验）· v0.2.0（图形工作台）· v0.1.0（MVP）。
> 完整交付清单见 [迭代记录](docs/roadmap.md)。

## 功能总览（v0.4.0）

**自然语言生成链路**（8 个 `comfymcp_*` 工具 + 生成流程技能）

- `comfymcp_status` 探测链路 → `comfymcp_business` 自然语言命中业务配置 →
  `comfymcp_discover` / `comfymcp_analyze_workflow` 需求拆解与字段推导 →
  `comfymcp_push_form` / `comfymcp_apply_form` 定制表单确认 →
  `comfymcp_run_workflow` 强制保存并运行（自动整合模型卸载插桩）→
  `comfymcp_fetch_artifacts` 成果回显 → `comfymcp_call_remote` 逃生舱直调任意远端工具。

**业务配置（本期重点增强）**

- 把「跑过 / 加载过」的工作流按业务类沉淀（预置 文生图 / 图生图 / 文生视频 / 图生视频 /
  局部重绘 / 放大 / 音频 / 其它，业务类可自行增删），后续会话用自然语言直接命中，
  不再每次捞模板、枚举模型；跑通一次即自动登记。
- **命中提示（0.4.0）**：命中业务类后，确认表单标题自动以业务类显示名开头
  （如「文生图 · 白色机甲 · 生成参数」），用户第一眼看到本次按哪类执行。
- **候选智能排序 + 换主（0.4.0）**：同一业务类的多个工作流按运行战绩计分
  （成功×3 + 使用 − 失败），自动登记的配置在候选明显更好时**自动换主**
  （≥2 次成功且得分超主配置 3 分才提升，手动配置永不自动改）；工作台候选条带 ✓/✗
  战绩，点击「设为主配置」手动切换。
- **参数预设集（0.4.0）**：每个业务类可存 ≤12 条参数预设（如「高清 1024·30 步」）；
  工作台业务卡一键套用/删除/存当前参数，工作流页「业务预设」条按字段名一键填表；
  模型侧 `preset_save` / `preset_remove` 存取，用户点名预设即按其参数推荐。

**图形工作台**（DSH 侧栏进入，浏览器亦可直开 `http://127.0.0.1:18801/ui`）

- **我的工作流**：本地工作流列表；模板执行过一次自动落库；打开即带出上次运行参数。
- **模板**：远端模板库；点开即渲染表单，执行一次自动保存。
- **成果物**：卡片库（瀑布流/平铺）、复合语法检索（`tag:` `param:` `seed:` 等字段限定 +
  与或非）、标签管理、勾选批量删除、导出 JSON。
- **快捷指令**：把跑过的运行存成一键指令（如「抽卡」：随机种子 + 指定数量连跑）。
- **业务配置**：卡片式编辑（业务类/显示名/工作流/触发词/参数覆盖/预设/候选）。

**运行与交互**

- 定制表单：提示词大域编辑、种子三策略（用随机/重随/固定）、枚举与数值范围校验；
  可选**倒计时自动采用推荐值**（`autoAcceptForm`），模型含糊时先追问、明确时直跑。
- 运行异步化：进度、执行中禁用、手动中断、单工作流超时中断；运行结束自动卸载模型释放显存
  （配合 ComfyUI 侧 `comfyui-unload-model` 节点，无 pip 依赖）。

**部署与存储**

- **内嵌服务端（默认）**：comfy-mcp 服务端内置在插件包（`vendor/` 单文件），
  随 DSH 启停、随机端口，**目标机零部署零依赖**；也可切外置模式多消费者共享。
- 存储可插拔：本地磁盘 / MinIO / 阿里云 OSS。
- **离线安装包**：每个稳定版本随 GitHub Release 提供 `source`（纯插件零依赖包，
  内含 INSTALL.md，**发给 DSH 对话框即可由大模型自动安装**）与 `full`（全工程源码包）。

## 组件与端口

| 组件 | 目录 | 端口/形态 | 说明 |
| --- | --- | --- | --- |
| comfy-mcp 参考服务端 | 内嵌于插件 `vendor/`（源码 `comfy-mcp-server/`） | Streamable HTTP 随机端口 | 内嵌模式自动拉起；外置模式默认 :18800 |
| MCP 宿主 | `mcp/` | stdio | FUX runtime + `@fux-mcp/comfy-client`，仅远程模式需要 |
| DSH 插件 | `plugins/dsh-comfymcp-client/` | 控制端点 :18801+ | `comfymcp_*` 工具 + 工作台 + 设置页 + 产物卡 |
| ComfyUI | 用户自备 | **官方默认 :8188** | 链路仅走其 HTTP API；本项目默认配置已对齐 8188 |

链路：**大模型 → dsh-comfymcp-client →（内嵌 vendor / 外置）comfy-mcp → ComfyUI(:8188)**

## 快速开始

**A. 离线安装包（推荐）**：从 GitHub Release 下载 `dsh-comfymcp-client-v0.4.0-source.zip`，
直接发给 DSH 对话框——包内 `INSTALL.md` 会让大模型自动完成解压、挂载（`plugin_manager
install_bundle`）、重启提醒与 `comfymcp_status` 验证；目标机只需 Node ≥ 20。

**B. 从源码**：

```powershell
git clone https://github.com/easymor2024-ychen/dsh-comfy-mcp.git
# DSH 会话内执行：
plugin_manager install_bundle <仓库路径>\plugins\dsh-comfymcp-client
# 重启 DSH 生效（模块快照按进程冻结）
```

**C. ComfyUI 在别的机器**：设置页「ComfyUI MCP」→ comfyuiUrl 改
`http://<局域网IP>:8188` 保存（热重启内置服务）。

## 配置层序

`环境变量（DSH_COMFYMCP_* / COMFY_MCP_*） > DSH 行配置（cordis.patch.yml） > 覆盖文件（$DSH_HOME/comfymcp/config-overlay.json，设置页"保存配置"写入） > 默认值`

设置页按「连接 → 目录 → 运行 → 交互 → 存储 → 开发」8 区手风琴布局，收起态显示各区当前值摘要；
**开发模式**默认关闭（关闭时严禁改插件源码），开启后允许 `comfymcp_dev` 自查自修。

## 本地验证

```powershell
pnpm install
pnpm test                                   # 三层 vitest（插件 231 + server 13 + mcp 5）
pnpm typecheck
node comfy-mcp-server/bin/comfy-mcp-server.mjs --selftest
node mcp/bin/fux-comfymcp-host.mjs --selftest
node scripts/check-page-templates.mjs       # 页面模板完整性
node scripts/check-page-scripts.mjs         # 页面脚本语法与关键监听
node scripts/package-release.mjs            # 打离线安装包到 dist/（发布约定，见 AGENTS.md）
```

## Python 侧依赖（ComfyUI 链路）

链路对 Python **只有两个接触点**，全部经 ComfyUI HTTP API（默认 :8188），无 Python 进程
spawn、无额外 pip 依赖：

1. **ComfyUI 运行时**（用户自备）：`.venv`（Python 3.12）自行管理；链路只消费
   `/prompt` `/history` `/view` `/object_info`。
2. **模型卸载节点 `comfyui-unload-model`**（可选，装进 `ComfyUI/custom_nodes/`）：
   依赖仅 ComfyUI 自带，无需 pip install；安装后重启 ComfyUI 生效。

```powershell
# 验证（端口按实际 ComfyUI 为准，官方默认 8188）
Invoke-WebRequest http://127.0.0.1:8188/system_stats -UseBasicParsing
Invoke-WebRequest http://127.0.0.1:8188/object_info/UnloadAllModels -UseBasicParsing
```

## 版本历史

| 版本 | 日期 | 重点 |
| --- | --- | --- |
| **v0.4.0** | 2026-10-16 | 业务配置增强包：命中提示（表单标题亮业务类）、候选智能排序与自动/手动换主、参数预设集（工作台 + 工作流页 + 模型侧）；ComfyUI 默认端口对齐官方 8188；离线安装包发布约定 |
| v0.3.1 | 2026-10-16 | 修复 devMode 经设置页保存后丢失/不即时生效（活值化 + 落盘原子写） |
| v0.3.0 | 2026-10-15 | 业务配置：业务类沉淀/自然语言命中/自动登记；工作流候选多来源合并；参数随工作流动态化；设置页 8 区手风琴；开发模式 |
| v0.2.1 | 2026-10-13 | 工作台页面体验打磨（设置页、产物卡、远程 HTTP 自检脚本） |
| v0.2.0 | 2026-10-12 | 图形工作台（工作流/模板/成果物三页）、运行异步化与中断、成果物检索语法、快捷指令雏形 |
| v0.1.0 | 2026-10-10 | MVP：四层链路、表单契约、卸载插桩、mock 后端 |

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [部署文档](docs/deployment.md) | 架构总览、前置条件、安装/挂载/重启、配置参考、真实模式切换、卸载回滚、CheckList |
| [操作手册](docs/operations.md) | 日常生成流程、工作台操作、设置页、故障排查表、E2E 清单 |
| [协议说明](docs/protocol.md) | MCP 协议细节、表单契约、页面协议 v1、卸载插桩设计 |
| [迭代记录](docs/roadmap.md) | 各版本交付清单与校验、下个迭代候选 |
| [配置示例](config/comfymcp.env) | 环境变量样例（含真实模式与 Python 侧要求注释） |
| [项目规约](AGENTS.md) | 分支版本规约、发布与离线安装包约定、版本升级说明 |

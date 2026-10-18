# dsh-comfymcp — DSH ⇄ ComfyUI 对接（v0.6.0）

把 DSH（DeepSeek Harness）接入 ComfyUI 生成链路：大模型基于自然语言设计可运行工作流 →
定制表单向用户确认 → 强制保存后运行 → 成果物回显到会话；并内置**图形工作台**
（工作流/创作/模板/成果物/快捷指令/业务配置六个页面）、**业务配置**记忆与
**多模态创作台**（直连魔搭/HuggingFace/Ollama/vLLM/A1111 文生图与图生图）。

> **v0.6.0**（2026-10-17，tag `v0.6.0`）——**多模态创作台**：工作台新增「创作」页，可配置
> 六类服务商（魔搭 ModelScope / HuggingFace Inference Providers / Ollama / vLLM-omni /
> A1111·SD WebUI / OpenAI 兼容网关）直连出图（文生图 / 图生图），成果自动落盘、进创作历史、
> 可复用为图生图输入；新增 `comfymcp_create` 模型工具（快速出图绕过工作流）。
> 0.5.x 线：修复 npm 全新安装内嵌模式全灭（宿主缺失回退 HTTP 直连）、非开发模式固定留档、
> 行配置去机器绝对路径、`timedAsk` 倒计时开关。完整交付清单见 [迭代记录](docs/roadmap.md)。

## 功能总览（v0.6.0）

**自然语言生成链路**（13 个 `comfymcp_*` 工具 + 生成流程技能）

- `comfymcp_status` 探测链路 → `comfymcp_business` 自然语言命中业务配置 →
  `comfymcp_discover` / `comfymcp_analyze_workflow` 需求拆解与字段推导 →
  `comfymcp_push_form` / `comfymcp_apply_form` 定制表单确认 →
  `comfymcp_run_workflow` 强制保存并运行（自动整合模型卸载插桩）→
  `comfymcp_fetch_artifacts` 成果回显 → `comfymcp_create` 直连多模态服务商快速出图 →
  `comfymcp_call_remote` 逃生舱直调任意远端工具。

**多模态创作台（0.6.0 新）**

- **服务商配置**：工作台「创作」页增删改服务商，预设模板一键填充（魔搭 Qwen-Image、
  HF SDXL、Ollama Z-Image、vLLM-omni、A1111、OpenAI 兼容网关）；连接测试、启用开关、
  默认服务商；密钥支持 `env:环境变量名` 引用与掩码回显。
- **文生图 / 图生图**：提示词 + 负向提示词 + 尺寸/步数/引导/种子/数量；图生图支持上传图片、
  从成果物选择、URL 或 dataURL 作为参考图（魔搭 Qwen-Image-Edit、A1111 img2img、
  OpenAI edits 协议）。
- **异步任务**：长任务（魔搭 FLUX 可达数分钟）不阻塞页面——提交后轮询进度，
  服务端跑完自动落盘；支持取消。
- **成果与历史**：图片落 `<artifactsDir>/created/<日期>/`，同名 `.json` 元数据（提示词/
  参数/种子/耗时）；创作历史（≤200 条）可重试、删除；结果画廊复用整屏灯箱预览。
- **模型侧**：`comfymcp_create`（action=generate / providers / history），
  「帮我快速画一张」无需现搭工作流。

**业务配置**

- 把「跑过 / 加载过」的工作流按业务类沉淀（预置 文生图 / 图生图 / 文生视频 / 图生视频 /
  局部重绘 / 放大 / 音频 / 其它，业务类可自行增删），后续会话用自然语言直接命中，
  不再每次捞模板、枚举模型；跑通一次即自动登记。
- **命中提示**：命中业务类后，确认表单标题自动以业务类显示名开头
  （如「文生图 · 白色机甲 · 生成参数」），用户第一眼看到本次按哪类执行。
- **候选智能排序 + 换主**：同一业务类的多个工作流按运行战绩计分
  （成功×3 + 使用 − 失败），自动登记的配置在候选明显更好时**自动换主**
  （≥2 次成功且得分超主配置 3 分才提升，手动配置永不自动改）；工作台候选条带 ✓/✗
  战绩，点击「设为主配置」手动切换。
- **参数预设集**：每个业务类可存 ≤12 条参数预设（如「高清 1024·30 步」）；
  工作台业务卡一键套用/删除/存当前参数，工作流页「业务预设」条按字段名一键填表；
  模型侧 `preset_save` / `preset_remove` 存取，用户点名预设即按其参数推荐。

**图形工作台**（DSH 侧栏进入，浏览器亦可直开 `http://127.0.0.1:18801/ui`）

- **我的工作流**：本地工作流列表；模板执行过一次自动落库；打开即带出上次运行参数。
- **创作**：多模态服务商管理与直连出图（文生图/图生图/历史/画廊，见上）。
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

**A. 离线安装包（推荐）**：从 GitHub Release 下载 `dsh-comfymcp-client-v0.6.0-source.zip`，
直接发给 DSH 对话框——包内 `INSTALL.md` 会让大模型自动完成解压、挂载（`plugin_manager
install_bundle`）、重启提醒与 `comfymcp_status` 验证；目标机只需 Node ≥ 20。

**B. 从源码**：

```powershell
git clone https://github.com/ai-fux/fux-dsh-comfymcp.git
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
pnpm test                                   # 三层 vitest（插件 272 + server 13 + mcp 5）
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
| **v0.6.0** | 2026-10-17 | 多模态创作台：工作台「创作」页 + 六类服务商直连（魔搭/HF/Ollama/vLLM/A1111/OpenAI 兼容）文生图与图生图、`comfymcp_create` 工具、创作历史与画廊；pagekit 页面公共件抽取 |
| v0.5.2 | 2026-10-17 | 非开发模式固定留档：运行失败/探测失败无条件进 dev-log（source=run/probe），仓库迁移 ai-fux/fux-dsh-comfymcp |
| v0.5.1 | 2026-10-17 | 修复 npm 全新安装内嵌模式全灭：宿主入口缺失自动回退 HTTP 直连（status=streamable-http-fallback）+ vendor 宿主候选约定 |
| v0.5.0 | 2026-10-17 | 行配置零机器绝对路径；吸收 timed-ask 预设（`timedAsk` 开关） |
| v0.4.1 | 2026-10-16 | 客户端注册 id 修复（包名即 bundle id） |
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
| [0.6.0 研发计划](docs/0.6.0-plan.md) | 多模态创作台方案（服务商协议矩阵、适配器契约、里程碑） |
| [配置示例](config/comfymcp.env) | 环境变量样例（含真实模式与 Python 侧要求注释） |
| [项目规约](AGENTS.md) | 分支版本规约、发布与离线安装包约定、版本升级说明 |

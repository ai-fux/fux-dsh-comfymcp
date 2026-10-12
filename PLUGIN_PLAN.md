# dsh-comfymcp — 插件研发计划（研发入口文档）

> 依据本仓 `AGENTS.md`：插件计划先于编码被确认。本文件是 comfy-mcp 对接研发的功能明细、
> 功能↔插件关联、功能↔capability（`domain:action`）映射与迭代清单。协议细节见
> [`docs/protocol.md`](./docs/protocol.md)。

## 1. 研发目标

研发对接 **comfy-mcp 服务**（ComfyUI 服务的 MCP 服务，MCP Streamable HTTP 形态）：

1. **`fux-plugin-mcp-comfy-client`**（独立插件，`plugins/fux-plugin-mcp-comfy-client`）：
   客户端通用插件——拟定「客户端 ⇄ comfy-mcp 服务」协议并实现对接（连接、工具目录、
   工具调用、成果物取回）。
2. **`dsh-comfymcp-client`**（项目级 DSH 插件，`projects/dsh-comfymcp/plugins/dsh-comfymcp-client`）：
   集成第 1 点插件完成对接——模型工具、技能、表单推送、产物回显、设置页/运行面板。

## 2. 架构（四层）

```
大模型 (GLM)
  │ comfymcp_* 模型工具 + 技能 + ask-user-question 结构化表单
  ▼
DSH 插件 dsh-comfymcp-client            ← DSH Host 进程（本部署，端口 13188）
  │ MCP stdio（JSON-RPC，spawn 子进程）
  ▼
MCP 宿主 projects/dsh-comfymcp/mcp      ← FUX runtime 宿主
  │ ctx.call('mcp-comfy:*')
  ▼
FUX 插件 fux-plugin-mcp-comfy-client    ← 通用 MCP Streamable HTTP 客户端（协议+对接实现）
  │ MCP Streamable HTTP（initialize / tools/list / tools/call / artifacts）
  ▼
comfy-mcp 服务（参考实现 projects/dsh-comfymcp/comfy-mcp-server）
  │ 适配（参考实现 = Streamable HTTP ⇄ stdio 桥接 → 已验证的 fux-comfyui-mcp.mjs）
  ▼
ComfyUI http://127.0.0.1:8000（已手动安装 comfyui-unload-model）
```

决策记录（2026-10-11，用户确认）：

| 决策点 | 结论 |
| --- | --- |
| 传输形态 | **仅 MCP Streamable HTTP**（通用客户端只实现 HTTP 传输；服务端形态由 comfy-mcp 服务自行决定） |
| 表单形态 | **ask-user-question 结构化表单**（多问题、选项、自由文本 custom；卡片表单留待后续迭代） |
| 项目命名/远程 | 命名确认可行；**先本地开发**，远程仓库创建/推送联调后二次确认 |

## 3. 功能明细（验收标准 → 功能 → 插件 → capability）

| # | 验收标准 | 功能 | 承担插件 | capability / 工具 |
| --- | --- | --- | --- | --- |
| A1 | 从服务端拿到成果物 | 成果物约定（`artifacts[]` + `url`）与下载落盘；会话回显 | 通用客户端（取回）+ DSH 插件（回显） | `mcp-comfy:artifact-fetch`；工具 `comfymcp_fetch_artifacts` |
| A2 | 自然语言基于节点信息设计可运行工作流，保存到配置的工作流空间子目录 | 节点目录检索、图构建、校验、保存（子目录） | comfy-mcp 服务提供工具；DSH 插件编排 | `comfymcp_node_search` / `comfymcp_node_info` / `comfymcp_build_workflow` / `comfymcp_validate_workflow` / `comfymcp_save_workflow`（`subdir` 参数） |
| A3 | 模型卸载节点自动装载（服务端无插件则置灰并提示） | 能力探测（`UnloadModel`/`UnloadAllModels` 是否在节点目录）+ 配置置灰 + 运行前整合卸载节点 | DSH 插件（探测/置灰/整合）；通用客户端提供探测数据 | `mcp-comfy:call`（node_search）；DSH 状态 `capabilities.unloadModel`；运行流程 `integrateUnloadNode` |
| A4 | 自然语言→需求分析→空间/模板检索→自行设计（先联网）→保存后运行→表单推送→重解析→执行→成果物回显 | 生成编排技能（四路选路）+ 表单规格推导 + ask-user-question 推送 + 表单回填 | DSH 插件（技能/工具/表单/回填/执行） | 技能 `comfymcp-generation-flow`；工具 `comfymcp_analyze_workflow` / `comfymcp_push_form` / `comfymcp_apply_form` / `comfymcp_run_workflow`（强制先保存） |

## 4. 功能 ↔ capability 映射（拟定协议）

### 4.1 FUX 通用客户端插件 `@fux-mcp/comfy-client`（domain: `mcp-comfy`）

| capability | 版本 | 作用 |
| --- | --- | --- |
| `mcp-comfy:health` | 0.1.0 | 探测 comfy-mcp 端点：握手 initialize，返回可达性/时延/错误 |
| `mcp-comfy:status` | 0.1.0 | 完整快照：serverInfo、协议版本、工具目录摘要、会话状态 |
| `mcp-comfy:tools` | 0.1.0 | 拉取远端工具目录（name/description/inputSchema） |
| `mcp-comfy:call` | 0.1.0 | 调用远端工具（`tool`/`arguments`/`timeoutMs`），归一化 JSON 结果 |
| `mcp-comfy:artifact-fetch` | 0.1.0 | 按成果物约定下载 `artifacts[].url` 到本地 artifactsDir |

### 4.2 comfy-mcp 服务工具契约（服务端⇄客户端，摘要）

完整契约见 `docs/protocol.md`。参考实现暴露（与已验证的 fux-comfyui-mcp 同名同参）：
`server_info` `server_health` `queue_status` `queue_manage` `cancel_job` `node_search` `node_info`
`node_path` `list_models` `list_workflows` `get_workflow` `save_workflow` `build_workflow`
`validate_workflow` `run_workflow` `job_status` `job_progress` `job_wait` `fetch_outputs`
`list_artifacts` `upload_image`。

**成果物约定**：产出文件的工具结果附加
`artifacts: [{ id, filename, kind, bytes, url }]`；`url` 相对 comfy-mcp 端点解析，`GET url` 返回字节流。

### 4.3 DSH 插件 `dsh-comfymcp-client` 模型工具

| 工具 | 驱动的远端工具 | 说明 |
| --- | --- | --- |
| `comfymcp_status` | `server_info` + `node_search`（卸载节点探测） | 服务快照 + 卸载插件可用性（A3） |
| `comfymcp_node_search` | `node_search` | 节点类检索（A2 设计输入） |
| `comfymcp_node_info` | `node_info` | 节点契约（A2 设计输入） |
| `comfymcp_node_path` | `node_path` | 类型路由提示 |
| `comfymcp_list_models` | `list_models` | 模型清单 |
| `comfymcp_list_workflows` | `list_workflows` | 工作流空间/模板库检索（A4-2/3） |
| `comfymcp_get_workflow` | `get_workflow` | 读取工作流（UI→API 转换） |
| `comfymcp_save_workflow` | `save_workflow` | 保存到工作流空间**子目录**（A2，`subdir`） |
| `comfymcp_build_workflow` | `build_workflow` | 模板/操作构建图（A2/A4-4） |
| `comfymcp_validate_workflow` | `validate_workflow` | 提交前预检（强制） |
| `comfymcp_analyze_workflow` | 本地分析 | 图 → 表单规格（提示词/种子/参数槽/枚举） |
| `comfymcp_push_form` | userQuestions | 表单推送给用户（预设值/缺省/随机种子/固定种子） |
| `comfymcp_apply_form` | 本地回填 | 表单答案 → 可运行工作流数据 |
| `comfymcp_run_workflow` | `run_workflow`（封装校验→整合卸载节点→保存→提交→等待） | 保存后运行（A4） |
| `comfymcp_fetch_artifacts` | `fetch_outputs`/`list_artifacts` + `artifact-fetch` | 成果物取回落盘（A1） |
| `comfymcp_queue_status` / `comfymcp_cancel` | `queue_status` / `queue_manage` | 队列观测/治理 |

## 5. 迭代清单（MVP = 0.1.0）

- [x] 0.1.0-MVP 计划与协议草案（本文 + `docs/protocol.md`）
- [ ] `fux-plugin-mcp-comfy-client` 0.1.0（Streamable HTTP 客户端 + 5 capabilities + 测试 ≥80%）
- [ ] comfy-mcp 参考服务端（Streamable HTTP ⇄ stdio 桥接 + mock 后端 + 测试）
- [ ] MCP 宿主（FUX runtime + 通用客户端 → stdio MCP）+ 测试
- [ ] `dsh-comfymcp-client` Host 半区（工具/技能/表单/回显/连接 RPC 通道）+ 测试
- [ ] `dsh-comfymcp-client` Client 半区（设置页：端点/工作流空间/卸载节点置灰；运行面板/产物卡）
- [ ] 真机端到端：四条验收标准逐一验证并记录
- [ ] 后续 0.2.0 候选：自定义 Chat 卡片表单、会话内产物卡片渲染增强、comfy-mcp 服务端原生 Streamable HTTP 实现

## 6. 测试与验收纪律

- 每层 vitest/node --test：happy path + 错误路径 + 边界；FUX 插件 coverage ≥ 80% statements。
- 端到端验证脚本 `scripts/verify-e2e.mjs`：对照 A1–A4 出报告（需要 ComfyUI 运行 + comfy-mcp 服务启动）。
- 分支：`snapshot-0.1.0`（公开发布分支）；版本三段式规约，插件 `manifest.version` = `package.json#version`。

# comfy-mcp 对接协议（v0.2.0）

> 本文件是 `fux-plugin-mcp-comfy-client`（客户端通用插件）与 comfy-mcp 服务之间的**拟定协议**，
> 也是 `projects/dsh-comfymcp/comfy-mcp-server`（参考实现）的实现依据。
> 状态：**v0.2.0 封板**（页面协议 v1 + 运行工具契约按真机实测校准；变更需同步实现与测试）。

## 1. 传输层：MCP Streamable HTTP

客户端与服务端之间使用 [MCP](https://spec.modelcontextprotocol.io/) 的 **Streamable HTTP** 传输
（协议版本 `2025-03-26` 及以上语义，向后兼容 `2024-11-05` 初始化）：

| 项 | 约定 |
| --- | --- |
| 端点 | 单一 HTTP 端点，如 `http://127.0.0.1:18800/mcp`（配置项 `endpoint`） |
| 初始化 | `POST endpoint`，`initialize` 请求 → 响应头 `Mcp-Session-Id` 必须保存并在后续请求回传 |
| 后续请求 | `POST endpoint` + `Mcp-Session-Id` 头；`notifications/initialized` 完成握手 |
| 工具目录 | `tools/list` → `{ tools: [{ name, description?, inputSchema? }] }` |
| 工具调用 | `tools/call` `{ name, arguments }` → `{ content: [...], structuredContent?, isError? }` |
| 响应形态 | 服务端可以返回 `application/json`（单响应体）或 `text/event-stream`（SSE 流，客户端须解析 `event: message` 数据行取 JSON-RPC 响应）；客户端两种都必须支持 |
| 会话失效 | HTTP 404（或含「session」错误语义的 4xx）→ 客户端丢弃会话重新 `initialize`（有界重试） |
| 超时 | 每请求独立预算（配置 `requestTimeoutMs`）；`tools/call` 另有 `timeoutMs` 覆盖 |
| 鉴权 | 可选 `headers` 配置（键值对，随每个请求发送） |

### 1.1 客户端归一化结果

`tools/call` 响应归一化为：

```jsonc
{
  "ok": true,                  // !isError
  "data": { /* structuredContent 或 文本块 JSON 解析结果 */ },
  "isError": false,
  "raw": { /* 原始 content 块（截断保护） */ }
}
```

`isError: true` → `ok: false` 且 `data.error` 携带文本；调用方（MCP 宿主/DSH 工具）必须把它当业务失败呈现而不是静默。

## 2. 成果物约定（A1）

产出文件的工具（`run_workflow`(wait=true)、`fetch_outputs`、`list_artifacts`）在归一化数据里附加：

```jsonc
{
  "artifacts": [{
    "id": "a1b2c3",            // 服务端会话内唯一
    "filename": "z_image_00001_.png",
    "kind": "image",           // image | video | audio | file
    "bytes": 1123004,
    "url": "/artifacts/a1b2c3" // 相对 comfy-mcp 端点解析；GET 返回字节流
  }]
}
```

- `url` 可以是绝对 URL 或相对路径；相对路径按 comfy-mcp 端点 base 解析。
- `GET {base}{url}`：`200` + `Content-Type` + `Content-Length`（尽力）；`404` = 成果物过期。
- 客户端 `mcp-comfy:artifact-fetch`：下载 `refs[].url` → 写入 `artifactsDir`，返回本地
  `{ files: [{ path, filename, kind, bytes }] }`（DSH 侧用于回显与 `read_image`）。

## 3. 模型卸载节点约定（A3）

- ComfyUI 服务端**手动安装** `comfyui-unload-model`（节点类 `UnloadModel`、`UnloadAllModels`，
  类别 `Unload Model`）。
- **探测**：`node_search { query: "UnloadAllModels" }` 命中 `UnloadAllModels` 即视为「已安装且已启用」；
  未命中 = 未安装或未启用 → DSH 配置项置灰并提示。
- **整合**：`autoUnloadModel: true` 且探测可用时，运行前把 `UnloadAllModels` 插入到每个输出节点
  （`SaveImage` 等）链路中：`上游输出 → UnloadAllModels.value`，`UnloadAllModels` 输出 → 原输入。
  语义：执行到输出前释放显存，产物保存不受影响（节点为透传）。
- 配置关闭或探测不可用时**不改图**。

## 4. DSH 表单契约（A4）

`comfymcp_analyze_workflow` 从 API 格式图推导**表单规格**（纯本地分析，不访问服务端）：

```jsonc
{
  "title": "txt2img 工作流",
  "fields": [{
    "id": "positive", "nodeId": "6", "field": "text",
    "kind": "text",             // text | number | seed | enum | boolean | image
    "label": "正向提示词",
    "value": "预设提示词…",      // 当前图内取值（=预设值）
    "default": "预设提示词…",    // 缺省（表单可一键采用）
    "required": true,
    "min": null, "max": null,   // number 专属
    "options": null             // enum 专属（如模型清单）
  }]
}
```

推导规则（v0.2.0）：

| 节点类 | 字段 | kind |
| --- | --- | --- |
| `CLIPTextEncode`（连到 KSampler 的 positive/negative） | `text` | text（positive/negative 标注） |
| `KSampler` / `KSamplerAdvanced` | `seed` / `noise_seed` | seed（推送时随机一次） |
| 同上 | `steps` `cfg` `denoise` | number（min/max 来自 node_info，取不到用安全缺省） |
| `CheckpointLoaderSimple` 等 loader | `ckpt_name` 等 | enum（`list_models` 选项；分析时若带 `modelOptions` 则填充） |
| `EmptyLatentImage` | `width` `height` `batch_size` | number |
| `LoadImage` | `image` | image（提示先 `comfymcp_upload`） |

`comfymcp_push_form` → ask-user-question 推送：

- 每个字段一个问题（`id = 字段 id`）；`seed` 提供选项「随机新种子（推荐）/固定 <当前值>」+ 自由文本；
  `text` 字段预设值写入 `detail` 并作为缺省 custom；`enum` 提供≤8 选项 + 自由文本。
- 答案 → `comfymcp_apply_form`：`{ graph, answers: [{id, value}] }` → 回填后的可运行工作流数据
  （含整合卸载节点后的最终图，直接可 `validate` → `run`）。
- 用户自然语言要求固定种子：模型把该种子写入 `answers`（`seed` 字段 value=固定值）再回填。

## 5. 版本与兼容

- 协议版本号跟随通用客户端插件 `manifest.version`（0.2.0）。
- 页面协议（`lib/wfpage.js` 描述符 v1：`{version:1, workflow, sections[{nodeId,classType,fields[]}], notes[]}`）在 v0.2.0 起视为稳定契约：新增字段只增不改，渲染器对未知字段忽略。
- 运行工具契约以真机实测为准（`save_workflow(name,graph,overwrite)` / `run_workflow(graph,id,front,priority)` / `job_wait(promptId,timeoutMs)` / `job_progress(promptId)` / `fetch_outputs(promptId,outDir)` / `cancel_job` / `queue_manage{action}`），另见 [roadmap 适配表](roadmap.md)。
- 服务端可以在 `initialize` 结果 `serverInfo.instructions` 里声明能力提示；
  DSH 侧据 `tools/list` 实际目录决定可用功能，**不做硬编码工具存在性假设**（缺失即禁用对应 UI）。
- 兼容策略：客户端只依赖 §1/§2 的最小公约数；服务端工具集可增可减。

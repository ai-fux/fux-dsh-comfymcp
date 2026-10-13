# 迭代计划（MVP Roadmap）

> 版本规约：四段式 `主.较.常.快`；分支规约：`snapshot-<version>` 稳定主分支 / `dev-snapshot-<yyyyMMdd>-<version>` 迭代分支。

## snapshot-0.1.0（稳定主分支，2026-10-11 固化）

首个可交付闭环，源自 `dev-snapshot-20261011-0.1.0` 全部 12 个提交：

- dsh-comfymcp-client 插件：10 个 `comfymcp_*` 模型工具全流程（状态→检索→分析→表单→回填→保存运行→成果物）
- 内嵌 comfy-mcp-server（vendor 单文件包，port 0）+ MCP 宿主（stdio）+ stdio 后端 → 原版 ComfyUI
- 设置页：DSH kit 同风格；内置/远程模式选择；环回控制端点（18801..18810）兜底静态挂载拿不到 connection RPC 的场景
- 自动卸载：探测四形状兼容（rows/nodes × classType/class_type），探测可用时输出链插桩 `UnloadAllModels`
- 插件自有主目录：`$DSH_HOME/comfymcp/`，派生 `workflows|artifacts|data`，runs.json 结构化持久化
- 受管存储三实现：本地目录 / MinIO（S3 SigV4）/ 阿里云 OSS（OSS4）；产物非本地时自动推送
- 聊天渲染：运行产物卡 + 文件管理卡；远端模板拉取 `comfymcp_workflow_pull`
- 测试：插件 67、server 13（mock 后端自检另计）；文档 deployment/operations/protocol

## dev-snapshot-20261011-0.2.0（开发中，v0.2.0 迭代——用户定稿范围）

本期五项（2026-10-11 用户需求，覆盖先前草案）：

1. **工作流可视化 → 静态网页**：DSH 前端可视化当前工作流；按协议规则把工作流节点编排成静态网页（UI 对齐 DSH 简约风）。协议 = 页面描述符 JSON（`lib/wfpage.js`）：节点分组 → 控件（number/string/choice/seed，含 min/max/step/枚举），渲染器确定性输出 HTML。
2. **一工作流多静态页 + Tab 手动执行**：每个工作流一个页面 + 索引页；DSH 内注册 `sidebar.panellist` 图标 → `main` 中央面板「ComfyUI 工作台」（iframe 嵌入，浏览器亦可直接打开控制端点 URL），页面内改参 → 手动触发远程 MCP 工具调用（run）生成图像/媒体数据。
3. **成果物可视化 Tab**：成果物页（runs + 文件 + 图片瓦片）；文件支持动态字段与标签操作（标签、绑定提示词、使用来源、标签集合）。
4. **快捷指令封装**：抽卡=仅重滚种子续跑同一工作流（表单答案复用）；种子策略可配：范围 min/max、随机位数、时间戳+补偿位数；指令列表 JSON 可扩展。
5. **成果物镜像下载**：`downloadDir`（相对主目录）配置后，运行产物在下载的同时复制一份到项目空间子目录。

实现落位：`lib/wfpage.js`（协议+渲染）、`lib/quick.js`（指令/种子策略）、`lib/tags.js`（标签存储）、`lib/runcore.js`（工具与控制端点共用运行核心）、`lib/nodecat.js`（官方节点目录形状适配）、`lib/wfgraph.js`（UI 格式 ⇄ API 格式、内联子图展平）、控制端点 `/ui*` `/api/*`、`client.js` 工作台面板。

### 节点解析与格式适配（活链路实证结论）

| 环节 | 真实形状（抓包实证） | 适配落位 |
| --- | --- | --- |
| 宿主转发包装 | `structuredContent = {ok,isError,tool,data,...}` | 先解 `.data` 再取 `nodes`（`unwrapHost`） |
| 节点元数据 | `{nodes:{Cls:{inputs:[{name,group,type,required,default,min,max,step,options}]}},missing:[]}`；枚举为 `type:"COMBO"+options` | `lib/nodecat.js` 统一四种形状（含官方 object_info 裸形状、rows 分页、数组枚举旧约定） |
| 工作流来源 | 本地目录文件 + 远端 `library:*`（模板库）/`saved:*`（本地同目录被服务端索引）/工作区条目 | 本地优先；拉取写插件自有 `<home>/workflows`（绝不写用户 ComfyUI 目录） |
| 本地文件格式 | ComfyUI 前端 **UI 格式**（`nodes[]/links[]/widgets_values`），且大量使用**内联子图** | `lib/wfgraph.js`：服务端转换优先（无子图时）→ 本地展平兜底 |
| 子图展平 | 定义含虚拟边界 `inputNode(-10)/outputNode(-20)`；`def.inputs[i].linkIds` 指内部链路，槽位序 = 外节点输入序；外节点 `outputs[s].links` 需重映射到内部产出节点 | `apiGraphFromUi`：内部节点前缀 `<外节点id>:`，promoted 输入取值（外链→外部引用／widget→外节点同名值），输出链路重映射 |
| 自动增长组输入（`COMFY_AUTOGROW_V3`） | 两端契约不同：ComfyUI `/prompt` 只认扁平点号键 `values.a`（给嵌套对象 → `required_input_missing: values.a`）；comfy-mcp 校验层却要求存在名为 `values` 的输入（只给 `values.a` → `missing_input: requires input "values"`） | **双写**：既写 `values.a`，也镜像父对象 `values:{a:…}`，两端同时通过 |
| 运行工具契约 | `save_workflow(name*, graph*, overwrite)`／`run_workflow(graph, id, front, priority)`（**无** name/wait）／`job_wait(promptId*, timeoutMs)`／`fetch_outputs(promptId, files, outDir, inline, maxBytes)`（`outDir` 直接落盘并返回 `files[].path` + `artifacts[]`）；`job_progress(promptId)` 供进度 | `lib/runcore.js` 按实测 schema 调用；`lib/rund.js` 轮询进度、维护运行状态与清空标记 |
| 复合键 | 展平后节点 id 自身含冒号（`128:127`），字段名也可能含点号（`values.a`） | 页面 values 键 `nodeId:field` 按**最后一个冒号**切分 |
| 校验 | `validate_workflow`（服务端逐字段）+ ComfyUI `/prompt`（真实执行校验） | 实机 6 个本地工作流展平后全部通过；1 个为工作流自身引用了本机缺失素材（表单以「当前值·不可用」呈现，不静默丢值） |

### 成果物库与提示词（2026-10-13 追加）

- **无模态数据不入库**：成果物页只登记有产物的运行，无产物的失败记录不展示（页头给出忽略条数）
- **一列卡片**：每次运行一个分区，每个文件一张横向卡（缩略图 + 文件名 + 标签/集合/动态字段 + 操作）
- **预览/播放**：点击图片放大、视频/音频就地播放（`/artifact` 支持 HTTP Range，可拖动进度）
- **提示词正/负**：运行核心按采样节点 `positive`/`negative` 链接定位文本节点，提取正负提示词与**可回填字段键**（`forms.extractPrompts`）；卡片折叠展示、鼠标悬浮看全文、箭头展开全文
- **提示词快捷赋值**：成果物页「⇢ 赋值」暂存（`/api/prompt/assign`，落 ui-state.json），工作流页加载时一次性取回并回填对应字段（`/api/prompt/take`），带高亮提示条
- **导出**：单次运行或整体导出 JSON（`/export?runs=…`，附件下载）；内容为当前已有字段 + 提示词正负 + 标签/集合/动态字段 + 文件字节 **base64 内嵌**
- **文本字段区分**：提示词类 textarea 自动增高（按字数/行数）、显示字数行数、`⤢ 展开` 大窗口全文编辑并写回表单

先前草案（并入后续版本候选）：运行历史面板增强、内嵌服务自动重启、对象存储直传、多 ComfyUI 实例、表单记忆、国际化。

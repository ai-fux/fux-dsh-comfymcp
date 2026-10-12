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

实现落位：`lib/wfpage.js`（协议+渲染）、`lib/quick.js`（指令/种子策略）、`lib/tags.js`（标签存储）、`lib/runcore.js`（工具与控制端点共用运行核心）、控制端点 `/ui*` `/api/*`、`client.js` 工作台面板。

先前草案（并入后续版本候选）：运行历史面板增强、内嵌服务自动重启、对象存储直传、多 ComfyUI 实例、表单记忆、国际化。

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

## dev-snapshot-20261011-0.2.0（开发中，v0.2.0 迭代）

本次 MVP 目标（较大版本位 Y：功能更新）：

1. **文件管理深化**：设置页存储「测试连接」按钮；`comfymcp_files` 支持 key 读取/删除与分页；产物卡直览对象存储文件
2. **运行历史面板**：runs.json 结构化数据的可视化（面板「历史」分区：状态/种子/耗时/产物缩略，可回显产物卡）
3. **工作流管理面板**：主目录 workflows/ 的列表、重命名、删除、导入（拖拽 JSON）；模板库拉取入面板可追溯
4. **健壮性**：内嵌服务崩溃自动重启（带退避）；控制端点占用顺延后向客户端广播生效端口
5. **文档**：operations.md 增补 v0.2.0 功能章节；protocol.md 固化存储协议 v1（五方法语义）

建议下次迭代（v0.2.x / v0.3.0 候选）：

- 产物对象存储直传（ComfyUI 侧上传，绕过 DSH 中转）
- 多 ComfyUI 实例：comfyuiUrl 多端点与运行期切换
- 表单记忆：按模板缓存上次表单答案作为下次种子
- 国际化：设置页与工具描述 en/zh 双语

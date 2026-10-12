# dsh-comfymcp 操作手册

> 面向日常使用与运维。部署先行：[部署文档](deployment.md)。

## 1. 日常使用：自然语言生成工作流

在 DSH 会话里用自然语言下达生成需求，模型会走固定管线（技能
`comfymcp-generation-flow` 约束流程）：

```
状态检查 → 空间/模板检索 → 设计工作流（先联网检索资料）
  → 推送定制表单（GUI 弹窗）→ 按答复回填生成可运行图
  → 强制保存到工作流空间 → 执行 → 成果物回显（产物卡）
```

你只需要做两件事：

1. **答表单**：弹出的结构化表单含提示词、数值参数、模型选择、种子。
   种子三选一：使用推送时已随机的种子 / 重新随机 / 手填固定值；
   任何手填值（custom）优先于预设。
2. **看产物卡**：运行完成后会话内出现产物卡——状态色条（绿=完成/红=失败/橙=运行中）、
   图片瓦片网格（点击原图）、文件胶囊、保存位置与种子元信息。

### 每次运行发生了什么

- 工作流**先保存**到 `workflowDirs` 下的 `saveSubdir`（默认 `dsh-generated`）再执行，可回溯；
- 若设置页开启「自动卸载」且服务端支持，运行图会在终点节点前插桩
  `UnloadAllModels`（上游输出 → value → 原消费者），跑完即释放显存；
- 产物经 `/api/comfymcp/artifact?path=` 回显（仅 artifactsDir/工作流空间内，containment 校验）。

## 2. 设置页操作（DSH Web → 设置 → ComfyUI MCP）

| 分区 | 字段/操作 | 说明 |
| --- | --- | --- |
| 头部 | 连接状态点 | 绿=已连接；红=探测失败（附原因与「重新探测」）；灰=尚未探测 |
| 连接 | comfy-mcp 服务端点 | 改后「保存配置」即时生效；「测试连接」随时探测 |
| 连接 | 宿主入口 / 桥接版本 | 只读行，带复制按钮 |
| 工作流空间 | 工作流目录（分号分隔） | 模板检索与强制保存的根 |
| 工作流空间 | 生成保存子目录 | 每次运行先落盘的位置 |
| 工作流空间 | 产物下载目录 | 留空用 DSH 数据目录 |
| 宿主与卸载 | MCP 宿主入口 | 留空走环境变量 |
| 宿主与卸载 | 自动卸载开关 | 三态：未连接=禁用；服务端无 UnloadAllModels=禁用+原因；可用=品牌色可切换 |
| 底部 | 保存配置 | 有未保存改动时按钮高亮 + 黄色提示；保存写入覆盖层并即时生效 |

## 3. 运维操作

### 3.1 服务启停（PowerShell）

**内嵌模式（默认）**：comfy-mcp 服务端随 DSH 插件自动拉起/回收（随机端口），无需手动启停；
首次使用时日志出现 `embedded comfy-mcp server at http://127.0.0.1:<port>/mcp`。

**外置模式**（设置页关闭内嵌开关后）：

```powershell
$env:COMFY_MCP_BACKEND='mock'; $env:COMFY_MCP_SERVER_PORT='18800'
node comfy-mcp-server\bin\comfy-mcp-server.mjs
# 停止：Ctrl-C；DSH 插件在下次调用时按新状态重连
```

### 3.2 插件代码热迭代

```
改代码 → pnpm --filter dsh-comfymcp-client test → install_bundle → 重启 DSH
```

Client 半区（设置页/产物卡）随浏览器产物构建刷新，页面刷新即可见；
Host 半区（工具/面板通道）受模块快照冻结约束，**必须重启**。

### 3.3 运行历史与产物

- 运行历史存内存（最近 50 条），DSH/插件进程重启即清空（MVP 行为）；
- 产物文件落盘在「产物下载目录」或 DSH 数据目录，历史保存的工作流在
  `workflowDirs/<saveSubdir>/`，可随时打开复跑。

## 4. 故障排查

| 症状 | 原因 | 处置 |
| --- | --- | --- |
| 启动告警 `1 entry did not activate` | 模块快照冻结（改码后未重启）或激活期异常 | 看堆栈行号是否旧代码 → 重启 DSH；仍复现则按堆栈定位 |
| 启动有 `cannot get property "webServer"` | 面板通道在 webServer 落位前注册 | 已内置就绪重试；出现即说明运行的是旧代码，重启装载新版 |
| 设置页显示「connection RPC 不可用」 | 面板通道未挂上（服务端未启动/旧代码） | 确认启动日志有 `panel channel /comfymcp ready`；没有则按上两行处理 |
| 设置页全部读写失败（测试不行/保存失败） | 静态挂载拿不到 connection RPC（平台限制）；环回控制端点未启动 | 看启动日志 `设置页通道就绪：http://127.0.0.1:18801`；没有则说明运行旧代码，重启 DSH |
| `comfymcp_status` ok:false | comfy-mcp 服务端没起 / 端点错 | 内置模式：看日志有无 `embedded comfy-mcp server at <url>`；远程模式：起 18800 服务端后核对 endpoint |
| 内嵌启动失败 `内嵌服务端…未报告监听地址/入口不存在` | 服务入口不对或服务自身崩了 | 服务端已内置（vendor 包）；env `DSH_COMFYMCP_SERVER_ENTRY` 覆盖时核对该路径；手动 `node <插件目录>\vendor\comfy-mcp-server.mjs --selftest` 验证 |
| 卸载开关置灰 | 未连接，或服务端无 UnloadAllModels | 接通后自动可用；真实模式按部署文档 §5 验证 object_info |
| 运行报 ComfyUI 相关错误 | ComfyUI 未运行/显存不足/图不合法 | 查 :8000 存活；看 ComfyUI 控制台输出；开自动卸载释放显存 |
| 产物卡图片裂图 / 404 | 产物不在 containment 目录内 | 核对「产物下载目录」与运行输出目录一致 |
| 表单没弹出来 | userQuestions 服务不可用 | 工具会显式报错；检查 DSH 表单服务启用状态 |

### 日志在哪

- DSH 插件侧：DSH 进程控制台（前缀 `[dsh-comfymcp-client]`，含 MCP 宿主 stdio 透传日志）；
- comfy-mcp 服务端：其自身控制台（启动即打印 backend 模式与端口）；
- ComfyUI：其控制台（卸载节点执行时打印 `Unload Model: - Unloading all models...`）。

## 5. 验收用 E2E 脚本化清单

1. `comfymcp_status` → ok + unload 状态
2. `comfymcp_discover` → 列出本地工作流目录 + 远端模板 + 模型清单
3. `comfymcp_analyze_workflow`（内联最小图）→ 推导 text/seed/number/enum 字段
4. `comfymcp_push_form` → GUI 表单 → 答复 → `comfymcp_apply_form` → 可运行图
5. `comfymcp_run_workflow` → 保存记录 + 运行 + 产物卡回显
6. 真实模式重跑 1-5（ComfyUI :8000 运行时）

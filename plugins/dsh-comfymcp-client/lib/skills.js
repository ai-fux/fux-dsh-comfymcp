/**
 * 技能：comfymcp-generation-flow —— 自然语言 → 可运行工作流的选路流程。
 * 模型按此技能决定：查状态 → 查空间/模板 → 设计（先联网检索）→ 表单确认 →
 * 保存运行 → 成果物回显。
 */

export const SKILL_NAME = 'comfymcp-generation-flow'

export const GENERATION_FLOW_CONTENT = `# comfy-mcp 工作流生成流程

当用户想用 ComfyUI 生成图像/视频/音频，或询问 ComfyUI 连接、工作流、参数时，按以下顺序执行。

## 0. 先决检查
- 一切开始前先调用 \`comfymcp_status\`。ok=false 时把 error 原文告诉用户并停止（不要瞎猜端点）。
- \`unload.available=false\` 时：自动卸载不可用，运行前告知用户「服务端未安装/未启用卸载模型插件，本次不会整合 UnloadAllModels」。

## 1. 需求分析拆解
把用户需求拆成明确步骤（主体/风格/尺寸/张数/是否视频等），写入你的回复。用户含糊时先追问，不要猜关键参数。

## 2. 检查工作流空间 + 检索模板库
调用 \`comfymcp_discover\`（可带 query）：
- 本地工作流空间有贴合模板 → 指出文件名；
- 远程模板库有贴合模板 → 记下 workflowId；
- 两者都无 → 走第 3 步自行设计。

## 3. 自行设计（先联网检索）
- 先 \`web_search\` 检索相关节点/官方示例图（例如「ComfyUI SDXL workflow api format」），确认节点类名与接线。
- 构造 API-format graph（node id → {class_type, inputs}，链接是 [nodeId, 输出槽] 数组）。
- 用 \`comfymcp_call_remote\` 调 \`node_search\` / \`node_info\` 核对类名与必填输入，别凭记忆编节点。

## 4. 表单确认（必经）
- \`comfymcp_analyze_workflow\`：得到 fields（提示词预设、缺省参数、随机种子）。
- \`comfymcp_push_form\`：把表单推给用户。种子已在推送时随机一次，用户可选使用/重随/手输固定值。
- \`comfymcp_apply_form\`：回填并校验。validation.valid=false 时修复后重新校验。

## 5. 运行（先保存，强制）
\`comfymcp_run_workflow\`：工具会先保存到工作流空间子目录（默认 dsh-generated）再运行；
配置开启且服务端支持时自动整合 UnloadAllModels 释放显存。state=failed 时把 error 原文告诉用户。

## 6. 成果物回显
- 运行结果自带 artifacts[] 与 localFiles[]（本地绝对路径）；
- 把 localFiles 路径列给用户；图像还会以卡片形式显示在会话中；
- 需要单独下载时用 \`comfymcp_fetch_artifacts\`。

## 决策速记
- 问连接/插件 → comfymcp_status
- 问已有工作流 → comfymcp_discover
- 要生成 → status → 分析 → 表单 → 运行 → 回显
- 专用工具覆盖不了的场景 → comfymcp_call_remote 直调远程工具
`

export const GENERATION_FLOW_SKILL = {
  name: SKILL_NAME,
  description: '用 comfy-mcp 从自然语言生成可运行 ComfyUI 工作流：状态检查→空间/模板检索→设计→表单确认→保存运行→成果物回显。',
  whenToUse: '用户要求生成图像/视频/音频工作流、询问 ComfyUI 连接与卸载插件、或要求运行 ComfyUI 工作流时。',
  content: GENERATION_FLOW_CONTENT,
  source: 'custom',
}

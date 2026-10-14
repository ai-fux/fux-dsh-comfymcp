/**
 * 模型可见工具目录：comfymcp_* 系列，全部经由桥接（MCP 宿主 → comfy-mcp）。
 *
 * 工具职责与自然语言生成流程一一对应：
 *   comfymcp_status          连接/服务/卸载插件可用性
 *   comfymcp_discover        检查工作流空间 + 检索模板库
 *   comfymcp_analyze_workflow 需求分析拆解 + 表单字段推导
 *   comfymcp_push_form       结构化表单推送用户（ask-user-question）
 *   comfymcp_apply_form      表单答案回填 + 校验
 *   comfymcp_run_workflow    强制先保存 → （可选整合卸载节点）→ 运行 → 等待
 *   comfymcp_fetch_artifacts 成果物下载到本地（storage≠local 时同步推送到对象存储）
 *   comfymcp_files           插件自有文件目录管理（本地/MinIO/OSS 统一接口）
 *   comfymcp_workflow_pull   从远端模板库拉取工作流文件到本地工作流空间
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { deriveFields, normalizeNodeInfos, buildQuestions, applyAnswers, firstPromptText, firstSeed } from './forms.js'
import { safeFileStem } from './bridge.js'
import { resolveStorage } from './storage.js'
import { createRunExecutor, distributeArtifacts } from './runcore.js'


const REMOTE_TOOL_LIST = [
  'server_info',
  'node_search',
  'node_info',
  'list_models',
  'list_workflows',
  'get_workflow',
  'save_workflow',
  'build_workflow',
  'validate_workflow',
  'run_workflow',
  'job_wait',
  'fetch_outputs',
  'list_artifacts',
]

function text(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
}

function oneLine(value) {
  return String(value ?? '').replaceAll(/\s+/g, ' ').slice(0, 400)
}

/** Build the comfymcp_* tool definitions; DI keeps tests free of the dsh runtime. */
/**
 * 工具目录：七个 comfymcp_* 模型工具 + comfymcp_call_remote 逃生舱。
 * define 注入（生产为 lib/define.js 的本地 defineTool；测试注入捕获桩）。
 */
export function createTools({ define, bridge, askUser }) {
  const tools = []
  const executeRun = createRunExecutor({ bridge })

  tools.push(
    define({
      name: 'comfymcp_status',
      description:
        'Probe the comfy-mcp integration: MCP host process, comfy-mcp service reachability, ComfyUI snapshot, and whether the server-side unload-model plugin is available. ' +
        'Call it first when the user asks about ComfyUI connectivity, before generating a workflow, and to explain a disabled auto-unload option. Never throws; answers { ok, host, remote, unload, config, error }.',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: (_args, value) => text(oneLine(value)),
      },
      async execute() {
        const probe = await bridge.probe()
        return probe
      },
    }),
  )

  tools.push(
    define({
      name: 'comfymcp_discover',
      description:
        'Inspect the workflow workspace and the remote template library: local workflow files under the configured directories plus remote saved workflows (list_workflows), optionally filtered by a query. ' +
        'Use it as the "检查工作流空间 / 检索模板库" step before designing a new graph. Answers { ok, local: [{path,name}], remote: [{id,name,subdir}], error? }.',
      parameters: {
        query: { type: 'string', description: 'Optional name filter for local files and remote workflows.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => text(oneLine(value)),
      },
      async execute(args) {
        const query = typeof args.query === 'string' ? args.query.toLowerCase() : ''
        const local = []
        for (const dir of bridge.config.workflowDirs) {
          let entries = []
          try {
            entries = readdirSync(dir, { withFileTypes: true })
          } catch {
            continue
          }
          for (const entry of entries) {
            if (!entry.isFile() || !/\.(json)$/i.test(entry.name)) continue
            if (query.length > 0 && !entry.name.toLowerCase().includes(query)) continue
            local.push({ path: join(dir, entry.name), name: entry.name })
          }
        }
        let remote = []
        let remoteError = ''
        try {
          const answer = await bridge.callRemote('list_workflows', {}, 30000)
          const data = answer?.structuredContent ?? {}
          remote = Array.isArray(data.workflows) ? data.workflows : []
          if (query.length > 0) {
            remote = remote.filter((entry) => String(entry?.name ?? '').toLowerCase().includes(query))
          }
        } catch (error) {
          remoteError = error instanceof Error ? error.message : String(error)
        }
        return {
          ok: local.length > 0 || remote.length > 0 || remoteError.length === 0,
          local,
          remote,
          ...(remoteError.length > 0 ? { remoteError } : {}),
        }
      },
    }),
  )

  tools.push(
    define({
      name: 'comfymcp_analyze_workflow',
      description:
        'Turn a requirement plus a candidate graph into an analysis and a tailored form draft: fetches the template graph (workflowId) or accepts an inline graph, reads node declarations, and derives form fields (prompts, seeds, numeric params, model choices). ' +
        'Answers { ok, analysis: {steps[]}, graph, fields[], notes[] }. Follow with comfymcp_push_form.',
      parameters: {
        requirement: { type: 'string', required: true, description: 'The user requirement restated as concrete generation steps.' },
        workflowId: { type: 'string', description: 'Remote template workflow id to start from (from comfymcp_discover).' },
        graph: { type: 'json', description: 'Inline API-format graph to analyze instead of a stored template.' },
        useModelChoices: { type: 'boolean', description: 'Fetch checkpoint names from the server for model fields (default true).' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => text(oneLine(value)),
      },
      async execute(args) {
        let graph = args.graph
        const notes = []
        if (graph === undefined || graph === null) {
          if (typeof args.workflowId !== 'string' || args.workflowId.length === 0) {
            return { ok: false, error: '需要 workflowId 或 graph 之一' }
          }
          const answer = await bridge.callRemote('get_workflow', { id: args.workflowId }, 30000)
          graph = answer?.structuredContent?.graph
          if (graph === undefined || graph === null) {
            return { ok: false, error: `模板 ${args.workflowId} 没有可用的 graph` }
          }
          notes.push(`模板 ${args.workflowId} 已载入`)
        }
        let nodeInfos = {}
        try {
          // 真实后端契约：node_info { classTypes: [...] }（复数数组）；空图时不调用
          const classTypes = [
            ...new Set(
              Object.values(graph ?? {})
                .map((node) => String(node?.class_type ?? ''))
                .filter((name) => name.length > 0),
            ),
          ]
          const answer = await bridge.callRemote('node_info', classTypes.length > 0 ? { classTypes } : {}, 60000)
          nodeInfos = normalizeNodeInfos(answer?.structuredContent ?? {})
        } catch (error) {
          notes.push(`node_info 不可用（${error instanceof Error ? error.message : String(error)}），按图内现值推导`)
        }
        let modelChoices = []
        if (args.useModelChoices !== false) {
          try {
            const answer = await bridge.callRemote('list_models', {}, 30000)
            const types = answer?.structuredContent?.types ?? {}
            const checkpoints = types.checkpoints ?? types.checkpoint ?? []
            modelChoices = Array.isArray(checkpoints) ? checkpoints.map((entry) => String(entry)) : []
          } catch {
            notes.push('list_models 不可用，模型字段仅含图内现值')
          }
        }
        const fields = deriveFields(graph, nodeInfos, modelChoices)
        return {
          ok: true,
          analysis: { steps: splitSteps(args.requirement) },
          graph,
          fields,
          notes,
        }
      },
    }),
  )

  tools.push(
    define({
      name: 'comfymcp_push_form',
      description:
        'Push the tailored parameter form to the user as structured questions and wait for answers (ask-user-question). Seeds were randomized once at push time; every seed question offers use/re-roll/fixed options. ' +
        'If the plugin config enables autoAcceptForm, a countdown starts: when it expires without user input the form auto-resolves to the recommended values (answers=[], seeds keep their randomized value) and the result is flagged `auto:true` — proceed with comfymcp_apply_form right away. ' +
        'Answers { ok, answers: [{id, selected[], custom?}], fields } where ids are `field:<node>.<input>`. Follow with comfymcp_apply_form. Requires a live user session.',
      parameters: {
        graph: { type: 'json', required: true, description: 'The analyzed graph (unchanged).' },
        fields: { type: 'json', required: true, description: 'Fields as produced by comfymcp_analyze_workflow.' },
        title: { type: 'string', description: 'Short form title shown above the questions.' },
      },
      timeoutMs: 600000,
      isConcurrencySafe: () => false,
      output: {
        schema: { type: 'json' },
        render: (_args, value) => text(oneLine(value)),
      },
      async execute(args, exec) {
        const { questions, prepared } = buildQuestions(args.fields)
        // 倒计时自动确认：开启后超时未作答 → 自动采用推荐参数（空 answers＝种子沿用随机值、其余保持推导值）
        const seconds = bridge.config?.autoAcceptForm === true
          ? Math.max(1, Number(bridge.config?.autoAcceptFormSec) > 0 ? Number(bridge.config.autoAcceptFormSec) : 30)
          : 0
        if (seconds > 0 && questions.length > 0) {
          const first = questions[0]
          questions[0] = { ...first, detail: `${first.detail ?? ''} · ⏱ ${seconds} 秒内未作答将自动采用推荐参数` }
        }
        let timer = null
        let answer
        if (seconds > 0) {
          answer = await Promise.race([
            askUser({ questions }, exec),
            new Promise((resolve) => {
              timer = setTimeout(() => resolve({ autoTimeout: true }), seconds * 1000)
            }),
          ])
        } else {
          answer = await askUser({ questions }, exec)
        }
        if (timer !== null) clearTimeout(timer)
        if (answer !== null && typeof answer === 'object' && answer.autoTimeout === true) {
          return {
            ok: true,
            auto: true,
            autoReason: `倒计时 ${seconds} 秒未收到用户作答，已自动采用推荐参数（种子沿用随机值，其余保持推导值）`,
            answers: [],
            fields: prepared,
            answered: 0,
          }
        }
        const items = Array.isArray(answer?.answers) ? answer.answers : []
        return {
          ok: true,
          answers: items,
          fields: prepared,
          answered: items.filter((entry) => (entry?.selected?.length ?? 0) > 0 || (entry?.custom ?? '').length > 0).length,
        }
      },
    }),
  )

  tools.push(
    define({
      name: 'comfymcp_apply_form',
      description:
        'Apply form answers onto the graph (custom text wins, seed re-roll honored), then validate the runnable graph remotely. ' +
        'Answers { ok, graph, applied, kept, validation: {valid, errors[], warnings[]} }. Follow with comfymcp_run_workflow.',
      parameters: {
        graph: { type: 'json', required: true, description: 'The analyzed graph.' },
        fields: { type: 'json', required: true, description: 'Prepared fields returned by comfymcp_push_form.' },
        answers: { type: 'json', required: true, description: 'Answers returned by comfymcp_push_form.' },
        validate: { type: 'boolean', description: 'Validate remotely; default true.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => text(oneLine(value)),
      },
      async execute(args) {
        const appliedResult = applyAnswers(args.graph, args.fields, args.answers)
        let validation = { valid: true, errors: [], warnings: [] }
        if (args.validate !== false) {
          try {
            const answer = await bridge.callRemote(
              'validate_workflow',
              { graph: appliedResult.graph },
              60000,
            )
            const data = answer?.structuredContent ?? {}
            validation = {
              valid: data.valid !== false && data.isError !== true,
              errors: Array.isArray(data.errors) ? data.errors.map((entry) => String(entry)) : [],
              warnings: Array.isArray(data.warnings) ? data.warnings.map((entry) => String(entry)) : [],
            }
          } catch (error) {
            validation = {
              valid: false,
              errors: [`validate_workflow 不可用：${error instanceof Error ? error.message : String(error)}`],
              warnings: [],
            }
          }
        }
        return {
          ok: validation.valid,
          graph: appliedResult.graph,
          applied: appliedResult.applied,
          kept: appliedResult.kept,
          validation,
        }
      },
    }),
  )

  tools.push(
    define({
      name: 'comfymcp_run_workflow',
      description:
        'Save the graph into the workflow workspace subdirectory (mandatory, every run is traceable), optionally integrate the UnloadAllModels node when config enables it and the server supports it, run remotely, wait for completion, and return artifacts with local download paths. ' +
        'Answers { ok, runId, promptId, state, artifacts[], localFiles[], saved, unload, error? }. Artifacts also render as a card; echo localFiles paths to the user.',
      parameters: {
        name: { type: 'string', required: true, description: 'Workflow name for the saved copy (e.g. girl-portrait-01).' },
        graph: { type: 'json', required: true, description: 'The validated graph to run.' },
        subdir: { type: 'string', description: 'Save subdirectory override; default from config (dsh-generated).' },
        wait: { type: 'boolean', description: 'Wait for completion; default true.' },
        timeoutMs: { type: 'number', description: 'Completion wait budget; default 120000.' },
        autoUnload: { type: 'boolean', description: 'Integrate the unload node for this run; default from config.' },
      },
      timeoutMs: 420000,
      isConcurrencySafe: () => false,
      output: {
        schema: { type: 'json' },
        render: (_args, value) => text(oneLine(value)),
        presentationMeta: (_args, value) => value,
      },
      async execute(args) {
        return executeRun(args)
      },
    }),
  )

  tools.push(
    define({
      name: 'comfymcp_fetch_artifacts',
      description:
        'Download artifact refs (the artifacts[] entries a previous run returned) into the local artifacts dir and return their absolute paths for echo/preview. ' +
        'Answers { ok, files: [{path, filename, kind, bytes}] }.',
      parameters: {
        refs: { type: 'json', required: true, description: 'Artifact refs array (id/filename/kind/bytes/url).' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => text(oneLine(value)),
        presentationMeta: (_args, value) => value,
      },
      async execute(args) {
        const answer = await bridge.fetchArtifacts(Array.isArray(args.refs) ? args.refs : [])
        const data = answer?.structuredContent ?? {}
        const files = Array.isArray(data.files) ? data.files : []
        const distributed = await distributeArtifacts(bridge, files)
        return { ok: data.isError !== true, files, ...(distributed !== null ? { distributed } : {}) }
      },
    }),
  )

  tools.push(
    define({
      name: 'comfymcp_files',
      description:
        'Manage the plugin-owned file space: list managed files (local artifacts dir, MinIO or Aliyun OSS depending on the storage setting) with key/size/kind and an access url. ' +
        'Use it when the user asks what files/outputs exist, or to locate a previous artifact. Answers { ok, storage, files: [{key, filename, kind, size, modifiedAt, url}] }.',
      parameters: {
        prefix: { type: 'string', description: 'Optional key prefix filter, e.g. "artifacts/2026-10-11".' },
        kind: { type: 'string', description: 'Optional kind filter: image | video | file.' },
        limit: { type: 'number', description: 'Max entries (default 50, cap 200).' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => text(oneLine(value)),
        presentationMeta: (_args, value) => value,
      },
      async execute(args) {
        const storage = resolveStorage(bridge.config)
        const prefix = typeof args.prefix === 'string' ? args.prefix : ''
        let files = await storage.list(prefix)
        const kind = typeof args.kind === 'string' && args.kind.length > 0 ? args.kind.toLowerCase() : ''
        if (kind.length > 0) files = files.filter((entry) => entry.kind === kind)
        const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 200) : 50
        files = files.slice(0, limit)
        for (const entry of files) entry.url = storage.url(entry.key)
        return { ok: true, storage: storage.id, files }
      },
    }),
  )

  tools.push(
    define({
      name: 'comfymcp_workflow_pull',
      description:
        'Pull a workflow file from the remote template library (comfymcp_discover remote entries) into the local workflow workspace, making it editable/inspectable offline. ' +
        'Answers { ok, path, name, format }.',
      parameters: {
        workflowId: { type: 'string', required: true, description: 'Remote workflow id as returned by comfymcp_discover (remote[].id).' },
        name: { type: 'string', description: 'Target file name override (default derived from the remote name).' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => text(oneLine(value)),
      },
      async execute(args) {
        const workflowId = typeof args.workflowId === 'string' ? args.workflowId.trim() : ''
        if (workflowId.length === 0) return { ok: false, error: '需要 workflowId（来自 comfymcp_discover 的 remote[].id）' }
        const answer = await bridge.callRemote('get_workflow', { id: workflowId }, 60000)
        const data = answer?.structuredContent ?? {}
        const graph = data.graph
        if (graph === undefined || graph === null) return { ok: false, error: `模板 ${workflowId} 没有可用的 graph` }
        const dir = bridge.config.workflowDirs[0]
        if (typeof dir !== 'string' || dir.length === 0) return { ok: false, error: '未配置工作流目录' }
        const name = safeFileStem(typeof args.name === 'string' && args.name.trim().length > 0 ? args.name : workflowId)
        mkdirSync(dir, { recursive: true })
        const target = join(dir, `${name}.json`)
        writeFileSync(target, `${JSON.stringify(graph, null, 2)}\n`, 'utf8')
        return { ok: true, path: target, name: `${name}.json`, format: typeof data.format === 'string' ? data.format : 'api' }
      },
    }),
  )

  tools.push(
    define({
      name: 'comfymcp_call_remote',
      description:
        `Escape hatch: invoke any remote tool of the comfy-mcp service verbatim (${REMOTE_TOOL_LIST.join(', ')} among others; list with list_remote_tools via this tool's sibling status info). ` +
        'Use it for node_search/node_info lookups and anything the dedicated comfymcp_* tools do not cover. Answers { ok, tool, data }.',
      parameters: {
        tool: { type: 'string', required: true, description: 'Remote tool name, exactly as the service advertises it.' },
        arguments: { type: 'json', description: 'Remote tool arguments object.' },
        timeoutMs: { type: 'number', description: 'Per-call budget override.' },
      },
      output: {
        schema: { type: 'json'},
        render: (_args, value) => text(oneLine(value)),
      },
      async execute(args) {
        const answer = await bridge.callRemote(args.tool, args.arguments ?? {}, args.timeoutMs)
        const data = answer?.structuredContent ?? {}
        return {
          ok: data.isError !== true,
          tool: args.tool,
          data,
        }
      },
    }),
  )

  return tools
}

/** Split a requirement into analysis steps (naive sentence/semicolon split, deduped). */
export function splitSteps(requirement) {
  const raw = String(requirement ?? '')
  const parts = raw
    .split(/[。；;\n]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  const steps = parts.length > 0 ? parts : [raw.trim()].filter((entry) => entry.length > 0)
  return steps.slice(0, 12)
}

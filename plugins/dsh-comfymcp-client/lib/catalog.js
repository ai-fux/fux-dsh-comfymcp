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
import { mkdirSync, readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { deriveFields, normalizeNodeInfos, buildQuestions, applyAnswers, firstPromptText, firstSeed } from './forms.js'
import { safeFileStem } from './bridge.js'
import { resolveStorage } from './storage.js'
import { createRunExecutor, distributeArtifacts } from './runcore.js'
import { createBusinessStore, DEFAULT_BUSINESS_KINDS, inferBusiness, matchBusiness, extractBusinessParams } from './business.js'
import { createDevLog } from './devlog.js'


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
  // 对象/数组必须先 JSON.stringify，否则 String() 产物是 "[object Object]"
  let raw = value
  if (typeof raw !== 'string') {
    try {
      raw = JSON.stringify(raw)
    } catch {
      raw = String(raw)
    }
  }
  return String(raw ?? '').replaceAll(/\s+/g, ' ').slice(0, 400)
}

/** Build the comfymcp_* tool definitions; DI keeps tests free of the dsh runtime. */
/**
 * 工具目录：七个 comfymcp_* 模型工具 + comfymcp_call_remote 逃生舱。
 * define 注入（生产为 lib/define.js 的本地 defineTool；测试注入捕获桩）。
 */
/**
 * 业务配置候选（工具侧）：把已跑过、但该业务类还没登记的运行列出来，提示模型/用户去登记。
 * 与工作台 businessCandidates 同义，这里只依赖 bridge 的轻量列表。
 */
function businessCandidatesOf(bridge, profiles = []) {
  const runs = typeof bridge?.listRuns === 'function' ? bridge.listRuns(80) : []
  const grouped = new Map()
  for (const run of runs) {
    const graph = run?.form?.graph
    if (graph === undefined || graph === null) continue
    const business = inferBusiness(graph)
    if (business === 'other') continue
    const workflow = String(run.name ?? '').trim()
    if (workflow.length === 0) continue
    const profile = profiles.find((entry) => entry.business === business) ?? null
    if (profile !== null && profile.workflow === workflow) continue
    const key = `${business}:${workflow}`
    const found = grouped.get(key)
    if (found === undefined) grouped.set(key, { business, workflow, runs: 1, current: profile === null ? null : profile.workflow })
    else found.runs += 1
  }
  return [...grouped.values()].slice(0, 8)
}

/** 读本地工作流文件（本地主目录优先）：只在 API 格式时返回图，UI 格式交给页面/工作台转换。 */
function readLocalGraph(bridge, workflow) {
  const name = String(workflow ?? '').trim()
  if (name.length === 0) return null
  const stem = safeFileStem(name.replace(/^(library|saved):/, '').replace(/\.json$/i, ''))
  for (const dir of bridge?.config?.workflowDirs ?? []) {
    try {
      const file = join(dir, `${stem}.json`)
      if (!existsSync(file)) continue
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed.nodes)) return null
      return parsed
    } catch {
      // 读不动就当作没有（远端模板路径兜底）
    }
  }
  return null
}

export function createTools({ define, bridge, askUser, business = null, devLog = null, devMode = false, providerStore = null, creation = null }) {
  const businessStore = business
  // devMode 活值化：设置页保存 devMode 后 bridge.config 即时更新（applyOverlay 原地改写），
  // comfymcp_dev 按调用时取值即时生效，无需重启 DSH；兼容旧布尔参数（激活时定格）。
  const isDevMode = () =>
    bridge?.config?.devMode === true ||
    (typeof devMode === 'function' ? devMode() === true : devMode === true)
  const log = devLog ?? createDevLog({ dataDir: bridge?.config?.dataDir, devMode: isDevMode })
  // 每个工具的异常都进开发日志：开发模式下模型可直接读报告定位问题；非开发模式仅留档供反馈
  const defineTool = (options) => define({
    ...options,
    execute: async (args, exec) => {
      try {
        return await options.execute(args, exec)
      } catch (error) {
        log.add({
          level: 'error',
          source: 'tool',
          tool: options.name,
          message: error instanceof Error ? error.message : String(error),
          detail: error instanceof Error ? (error.stack ?? '') : String(error),
        })
        throw error
      }
    },
  })
  const tools = []
  const executeRun = createRunExecutor({ bridge })
  // 最近一次业务配置命中（comfymcp_business match）：push_form 的标题自动以业务类显示名开头，
  // 用户在表单上直接看到「这次按哪个业务类跑」，不用读工具输出才知道。
  let lastBusinessMatch = null
  // 最近一次 status 探测失败文本（去重：同一错误只记一条，恢复记一条 info）
  let lastProbeError = ''

  tools.push(
    defineTool({
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
        // 探测失败无条件留档（非开发模式也记录）：同一错误只记一次，恢复时记一条 info。
        const message = probe.ok === true ? '' : (typeof probe.error === 'string' && probe.error.length > 0 ? probe.error : 'comfy-mcp 探测失败')
        if (message !== '' && message !== lastProbeError) {
          lastProbeError = message
          log.add({ level: 'error', source: 'probe', tool: 'comfymcp_status', message })
        } else if (message === '' && lastProbeError !== '') {
          lastProbeError = ''
          log.add({ level: 'info', source: 'probe', tool: 'comfymcp_status', message: 'comfy-mcp 连接恢复' })
        }
        return probe
      },
    }),
  )

  tools.push(
    defineTool({
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
    defineTool({
      name: 'comfymcp_business',
      description:
        '业务配置（开工第一步，省 token 的关键）：把「跑过 / 加载过」的工作流按业务类（文生图 / 图生图 / 文生视频 / 图生视频 / 局部重绘 / 放大 / 音频）沉淀成配置，后续会话用自然语言直接命中，' +
        '命中就用该配置里的工作流与默认参数继续，**不要**再去 comfymcp_discover 捞模板或 list_models 枚举模型。' +
        '用法：action=match 传用户原话 text（默认）→ 命中返回 matched{workflow, params, presets, keywords}，本地 API 格式工作流还会带上 graph（可直接喂给 comfymcp_analyze_workflow 的 graph，省一次取图）；未命中返回 matched:null，再走完整探索流程。' +
        'matched.presets 是该业务类的参数预设集（如「高清」「草稿」）：用户点名预设就用它的 params 当推荐值。' +
        '跑通后可用 action=register 把这次的工作流登记回来（可带 graph 自动判断业务类，presetName 可顺手把参数存成预设），下次就命中。action=list 看全部配置，action=save/remove 手工增删，action=preset_save/preset_remove 管理参数预设。' +
        '命中后 push_form 的表单标题会自动以业务类显示名开头（「文生图 · …」），让用户一眼看到命中了哪类。' +
        'Answers { ok, action, matched|null, profiles[], candidates[], nextSteps }.',
      parameters: {
        action: { type: 'string', description: 'match（默认）| list | register | save | remove | kind_save | kind_remove | preset_save | preset_remove' },
        text: { type: 'string', description: '用户原话（action=match 时用于自然语言匹配业务类）' },
        business: { type: 'string', description: '业务类 id（预置 text2img/image2img/text2video/image2video/edit/upscale/audio/other，也可用自定义 id）' },
        label: { type: 'string', description: 'action=kind_save 时的业务类显示名（如「换脸」）' },
        workflow: { type: 'string', description: '工作流名（本地文件词干或远端模板 id）' },
        graph: { type: 'json', description: '可选：内联图，用于 register 时自动判断业务类并摘取默认参数' },
        params: { type: 'json', description: '可选：该业务类的默认参数覆盖（steps/width/height/batch_size/model…）；preset_save 时即预设参数' },
        keywords: { type: 'string', description: '可选：自定义触发词（逗号分隔；kind_save 时即该业务类的触发词）' },
        notes: { type: 'string', description: '可选：备注' },
        id: { type: 'string', description: 'action=remove/kind_remove/preset_* 时的业务配置 id（＝业务类 id）' },
        name: { type: 'string', description: 'preset_save 时的预设名称（如「高清」）；preset_remove 时也可用名称删' },
        presetId: { type: 'string', description: '可选：preset_remove 按预设 id 删除；preset_save 传了则覆盖该预设' },
        presetName: { type: 'string', description: 'register/save 时可选：把这次参数存成该名称的预设' },
        includeGraph: { type: 'boolean', description: 'match 是否附带本地图（默认 true；只是想确认命中可设 false）' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => text(oneLine(value)),
      },
      async execute(args = {}) {
        const action = String(args.action ?? 'match').trim() || 'match'
        const store = businessStore !== null ? businessStore : createBusinessStore({ dataDir: bridge.config?.dataDir })
        const currentKinds = () => (typeof store.kinds === 'function' ? store.kinds() : DEFAULT_BUSINESS_KINDS)
        if (action === 'list') {
          const profiles = store.all()
          return {
            ok: true,
            action,
            matched: null,
            profiles,
            kinds: currentKinds(),
            candidates: businessCandidatesOf(bridge, profiles),
            nextSteps: '命中后直接执行该工作流；未配置的业务类先跑一次再用 register 登记。业务类可在工作台「业务配置」页动态增删，或用 action=kind_save。',
          }
        }
        if (action === 'kind_save' || action === 'kind_remove') {
          const outcome = action === 'kind_save'
            ? store.saveKind({ id: args.business ?? args.id, label: args.label, keywords: args.keywords })
            : store.removeKind(args.id ?? args.business)
          return {
            ok: outcome.ok !== false,
            action,
            matched: null,
            kind: outcome.kind ?? null,
            kinds: outcome.kinds ?? currentKinds(),
            profiles: store.all(),
            ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
            nextSteps: outcome.ok === false
              ? '业务类还有配置在用（或名称不合法）：先改掉/删除相关配置，或换个名称。'
              : '业务类清单已更新：后续 match 会按新的触发词匹配。',
          }
        }
        if (action === 'remove') {
          const removed = store.remove(args.id ?? args.business)
          return { ok: removed, action, matched: null, profiles: store.all(), kinds: currentKinds(), candidates: businessCandidatesOf(bridge, store.all()) }
        }
        if (action === 'preset_save' || action === 'preset_remove') {
          const id = args.id ?? args.business
          const outcome = action === 'preset_save'
            ? store.savePreset({ id, preset: { id: args.presetId, name: args.name ?? args.presetName, params: args.params } })
            : store.removePreset({ id, presetId: args.presetId ?? args.name })
          const profiles = store.all()
          const saved = profiles.find((profile) => profile.id === String(id ?? '')) ?? null
          return {
            ok: outcome.ok !== false,
            action,
            matched: null,
            preset: outcome.preset ?? null,
            presets: Array.isArray(saved?.presets) ? saved.presets : [],
            profiles,
            ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
            nextSteps: outcome.ok === false
              ? `预设${action === 'preset_save' ? '保存' : '删除'}失败：${outcome.reason ?? '未知原因'}`
              : `已${action === 'preset_save' ? '保存' : '删除'}预设（业务配置 ${String(id ?? '')}）：match 命中时 presets 会一起带出，用户点名即可套用。`,
          }
        }
        if (action === 'save' || action === 'register') {
          const graph = args.graph ?? null
          const business = String(args.business ?? '').trim() || (graph === null ? 'other' : inferBusiness(graph))
          const workflow = String(args.workflow ?? '').trim()
          if (workflow.length === 0) return { ok: false, action, error: 'register/save 需要 workflow' }
          const saved = store.save({
            id: business,
            business,
            workflow,
            source: String(args.source ?? 'saved'),
            params: args.params ?? (graph === null ? {} : extractBusinessParams(graph)),
            keywords: args.keywords,
            notes: args.notes ?? (action === 'register' ? '由一次成功的运行登记' : ''),
            auto: false,
          })
          // 顺手把这次的参数存成第一条预设（presetName 给名，不给就落不了预设）
          const presetName = String(args.presetName ?? '').trim()
          const preset = presetName.length > 0
            ? store.savePreset({ id: business, preset: { name: presetName, params: saved.params ?? {} } })
            : null
          return {
            ok: true,
            action,
            matched: saved,
            ...(preset === null || preset.ok === false ? {} : { preset: preset.preset }),
            ...(preset === null || preset.ok !== false ? {} : { reason: preset.reason }),
            profiles: store.all(),
            nextSteps: `已登记：${business} → ${workflow}。下次同类需求会直接命中，不再检索模板库。${preset !== null && preset.ok ? `参数已存为预设「${preset.preset.name}」。` : ''}`,
          }
        }
        // 默认：自然语言匹配（用当前动态业务类清单打分）
        const profiles = store.all()
        const hit = matchBusiness(String(args.text ?? ''), profiles, currentKinds())
        if (hit === null) {
          return {
            ok: true,
            action: 'match',
            matched: null,
            profiles,
            candidates: businessCandidatesOf(bridge, profiles),
            nextSteps: '没有命中业务配置：按技能走完整流程（discover → analyze → 表单 → 运行），跑通后用 action=register 登记回来。',
          }
        }
        const local = args.includeGraph === false ? null : readLocalGraph(bridge, hit.profile.workflow)
        store.touch(hit.profile.id)
        lastBusinessMatch = { id: hit.profile.id, business: hit.profile.business, label: String(hit.profile.label ?? hit.profile.business ?? '') }
        // 有参数预设时两路提示都带上：用户点名预设就用它的 params 当推荐值
        const presetHint = Array.isArray(hit.profile.presets) && hit.profile.presets.length > 0
          ? `该业务有参数预设（${hit.profile.presets.map((entry) => entry.name).join(' / ')}）：用户点名就用其 params 当推荐值。`
          : ''
        return {
          ok: true,
          action: 'match',
          matched: {
            id: hit.profile.id,
            business: hit.profile.business,
            label: hit.profile.label,
            workflow: hit.profile.workflow,
            params: hit.profile.params ?? {},
            keywords: hit.profile.keywords ?? [],
            notes: hit.profile.notes ?? '',
            presets: Array.isArray(hit.profile.presets) ? hit.profile.presets : [],
            score: hit.score,
            hits: hit.hits,
          },
          ...(local === null ? {} : { graph: local }),
          profiles: store.all(),
          nextSteps: local === null
            ? `命中「${hit.profile.label}」→ 直接用 comfymcp_analyze_workflow 传 workflowId="${hit.profile.workflow}"（远端模板），跳过 discover 与模型枚举；push_form 的表单标题会自动带上「${hit.profile.label}」。${presetHint}`
            : `命中「${hit.profile.label}」→ 已附上本地图 graph，直接把它与需求一起喂给 comfymcp_analyze_workflow，不要再检索模板库；push_form 的表单标题会自动带上「${hit.profile.label}」。${presetHint}`,
        }
      },
    }),
  )

  tools.push(
    defineTool({
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
    defineTool({
      name: 'comfymcp_push_form',
      description:
        'Push the tailored parameter form to the user as structured questions and wait for answers (ask-user-question). ' +
        'Every question carries its purpose in the header (title · 1/N), the recommended value first labelled （推荐）, and the countdown rule in the question text. Seeds were randomized once at push time; every seed question offers use/re-roll/fixed options. ' +
        'If the plugin config enables autoAcceptForm, a visible countdown runs on the question card: when it expires without user input the form auto-resolves to the recommended values (answers=[], seeds keep their randomized value), flagged `auto:true` — proceed with comfymcp_apply_form right away; a late user answer arrives as a message afterwards. ' +
        'When the user dismisses the form instead, the result is `cancelled:true` — do not run; ask the user what to change and push a fresh form (a new push always carries a fresh countdown). ' +
        'Answers { ok, answers: [{id, selected[], custom?}], fields } where ids are `field:<node>.<input>`. Follow with comfymcp_apply_form. Requires a live user session.',
      parameters: {
        graph: { type: 'json', required: true, description: 'The analyzed graph (unchanged).' },
        fields: { type: 'json', required: true, description: 'Fields as produced by comfymcp_analyze_workflow.' },
        title: { type: 'string', description: '用途标题，写进每题 header（例如「白色机甲 · 生成参数」）；缺省「生成参数确认」。命中业务配置时标题会自动以业务类显示名开头' },
      },
      timeoutMs: 600000,
      isConcurrencySafe: () => false,
      output: {
        schema: { type: 'json' },
        render: (_args, value) => text(oneLine(value)),
      },
      async execute(args, exec) {
        // title 决定每题 header 的用途说明（对话框只渲染 header/question/options）。
        // 命中业务配置（comfymcp_business match）后，标题自动以业务类显示名开头——
        // 用户在表单上第一眼就能看到「这次按哪个业务类跑」；模型自己写了同名开头则不重复拼。
        const hitLabel = lastBusinessMatch === null ? '' : lastBusinessMatch.label
        const rawTitle = String(args.title ?? '').trim()
        const baseTitle = rawTitle.length > 0 ? rawTitle : '生成参数确认'
        const title = hitLabel.length > 0 && baseTitle.startsWith(hitLabel) === false ? `${hitLabel} · ${baseTitle}` : baseTitle
        const { questions, prepared } = buildQuestions(args.fields, Math.random, { title })
        // 倒计时自动确认：开启后超时未作答 → 自动采用推荐参数（空 answers＝种子沿用随机值、其余保持推导值）
        const seconds = bridge.config?.autoAcceptForm === true
          ? Math.max(1, Number(bridge.config?.autoAcceptFormSec) > 0 ? Number(bridge.config.autoAcceptFormSec) : 30)
          : 0
        if (seconds > 0 && questions.length > 0) {
          // 对话框只渲染 question 与 options —— 提示必须写进 question 文本才可见；
          // 每页都写，翻到第 2/3/4 题也知道倒计时规则与「不答即用推荐值」。
          const note = `⏱ ${seconds} 秒未答 → 自动采用【推荐】值继续（本框可留空）`
          questions.forEach((question, index) => {
            questions[index] = {
              ...question,
              question: `${question.question}｜${note}`,
              detail: `${question.detail ?? ''} · ${note}`,
            }
          })
        }
        const cancelled = (reason) => ({
          ok: true,
          cancelled: true,
          reason,
          answers: [],
          fields: prepared,
          answered: 0,
        })
        const isUserCancellation = (error) => {
          const code = String(error?.code ?? '')
          const message = String(error?.message ?? error ?? '')
          return code === 'ASK_CANCELLED' || /cancel|abort|取消|中断/i.test(message)
        }
        // 计时提问的前置失败（非根代理 / 重复等待 / 等待参数非法）才值得退回阻塞式提问；
        // 用户主动取消绝不能重弹，否则会再冒出一次没有倒计时的对话框。
        const isTimedPrecondition = (error) => {
          const code = String(error?.code ?? '')
          if (code === 'BAD_TIMEOUT' || code === 'DUPLICATE_WAIT') return true
          const message = String(error?.message ?? error ?? '')
          return /timed questions require a live agent|live runtime root|DELEGATED_CALLER/i.test(message)
        }
        let timer = null
        let answer
        if (seconds > 0) {
          // 本地守卫计时器：与 seam 计时（askTimed）双保险——seam 正常时到期返回 pending；
          // 旧版 stub/seam 挂起不返回时由本地守卫兜底触发自动采用。
          const guard = new Promise((resolve) => {
            timer = setTimeout(() => resolve({ autoTimeout: true }), seconds * 1000)
          })
          try {
            // 计时提问：DSH 卡片自带可见倒计时；到期返回 { pending: true }（问题仍可后答，
            // 迟到回答会以用户消息送达）。askTimed 需要活跃根代理 + 工具调用 id。
            answer = await Promise.race([askUser({ questions }, exec, seconds), guard])
          } catch (error) {
            if (isUserCancellation(error)) {
              if (timer !== null) clearTimeout(timer)
              return cancelled('用户取消了参数确认（未作答）；不要继续执行，先与用户确认下一步')
            }
            if (!isTimedPrecondition(error)) throw error
            // askTimed 不可用 → 退回阻塞式 ask + 本地守卫（倒计时仍然生效）
            try {
              answer = await Promise.race([askUser({ questions }, exec), guard])
            } catch (retryError) {
              if (isUserCancellation(retryError)) {
                if (timer !== null) clearTimeout(timer)
                return cancelled('用户取消了参数确认（未作答）；不要继续执行，先与用户确认下一步')
              }
              throw retryError
            }
          }
        } else {
          try {
            answer = await askUser({ questions }, exec)
          } catch (error) {
            if (isUserCancellation(error)) {
              return cancelled('用户取消了参数确认（未作答）；不要继续执行，先与用户确认下一步')
            }
            throw error
          }
        }
        if (timer !== null) clearTimeout(timer)
        if (answer !== null && typeof answer === 'object' && (answer.autoTimeout === true || answer.pending === true)) {
          return {
            ok: true,
            auto: true,
            autoReason: `倒计时 ${seconds} 秒未收到用户作答，已自动采用推荐参数（种子沿用随机值，其余保持推导值）；用户的迟到回答将以消息送达，届时可按新选择调整`,
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
    defineTool({
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
    defineTool({
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
    defineTool({
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
    defineTool({
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
    defineTool({
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
    defineTool({
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

  tools.push(
    defineTool({
      name: 'comfymcp_create',
      description:
        '多模态创作（直连服务商，不经 ComfyUI 工作流）：文生图（t2i）/ 图生图（i2i）直接调用已配置的多模态服务商（魔搭 ModelScope、HuggingFace、Ollama、vLLM-omni、A1111、OpenAI 兼容网关）。' +
        '适用：快速出图、封面/草图/灵感、单图编辑，或用户没有现成工作流时；复杂节点链（ControlNet/LoRA/放大/视频）请走 comfymcp_run_workflow。' +
        'action=generate 生成（prompt 必填；providerId 缺省用默认服务商；image 为图生图参考图：本地路径/成果物文件名/http(s) URL）；action=providers 列出服务商与预设；action=history 查看最近创作。' +
        'Answers { ok, jobId?, images:[{path, bytes, mime}], providerId?, model?, elapsedMs?, error?, hint? }。',
      parameters: {
        action: { type: 'string', description: 'generate（默认）| providers | history' },
        providerId: { type: 'string', description: '服务商 id（缺省用默认；可先 action=providers 查询）' },
        mode: { type: 'string', description: 't2i（默认）| i2i' },
        prompt: { type: 'string', description: '提示词（action=generate 时必填）' },
        negativePrompt: { type: 'string', description: '负向提示词（可选）' },
        image: { type: 'string', description: '图生图参考图：本地绝对路径 / 成果物文件名 / http(s) URL / dataURL' },
        model: { type: 'string', description: '模型 id 覆盖（缺省用服务商配置）' },
        size: { type: 'string', description: '尺寸，如 1024x1024（缺省用服务商默认）' },
        steps: { type: 'number', description: '步数（缺省用服务商默认）' },
        guidance: { type: 'number', description: '引导系数（缺省用服务商默认）' },
        seed: { type: 'number', description: '种子（-1/留空=随机）' },
        n: { type: 'number', description: '生成数量（1~4，默认 1）' },
        limit: { type: 'number', description: 'action=history 返回条数（默认 20）' },
      },
      timeoutMs: 300000,
      output: {
        schema: { type: 'json' },
        render: (_args, value) => text(oneLine(value)),
        presentationMeta: (_args, value) => value,
      },
      async execute(args = {}) {
        const action = String(args.action ?? 'generate')
        if (providerStore === null || creation === null) return { ok: false, error: '创作服务未初始化（插件加载异常）' }
        if (action === 'providers') {
          const state = providerStore.list()
          return {
            ok: true,
            defaultId: state.defaultId,
            providers: state.providers.map((provider) => ({
              id: provider.id,
              label: provider.label,
              kind: provider.kind,
              kindLabel: provider.kindLabel,
              model: provider.model,
              capabilities: provider.capabilities,
              enabled: provider.enabled !== false,
              defaults: provider.defaults,
            })),
          }
        }
        if (action === 'history') {
          return { ok: true, items: creation.history(Number(args.limit) || 20) }
        }
        // generate：启动异步任务并等待完成（服务商长任务可达数分钟；工具侧最多等 280 秒）
        const started = creation.start({
          providerId: args.providerId,
          mode: args.mode === 'i2i' ? 'i2i' : 't2i',
          prompt: args.prompt,
          negativePrompt: args.negativePrompt,
          image: args.image,
          model: args.model,
          size: args.size,
          steps: args.steps,
          guidance: args.guidance,
          seed: args.seed,
          n: args.n,
        })
        if (started.ok !== true) return { ok: false, error: started.reason }
        const jobId = started.jobId
        const deadline = Date.now() + 280000
        let last = null
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 1500))
          last = creation.job(jobId)
          if (last === null) return { ok: false, error: '创作任务丢失（可能已重启插件）', jobId }
          if (last.status === 'succeeded') {
            return {
              ok: true,
              jobId,
              images: last.images,
              providerId: last.providerId,
              providerLabel: last.providerLabel,
              model: last.model,
              mode: last.mode,
              size: last.size,
              seed: last.seed,
              elapsedMs: last.elapsedMs,
              hint: '图片已落盘到成果物 created/ 目录并写入创作历史；需要继续编辑可再来一张（改 seed/prompt），或在「创作」页把该图作为图生图输入。',
            }
          }
          if (last.status === 'failed') {
            return { ok: false, jobId, providerId: last.providerId, error: last.error || '生成失败' }
          }
        }
        return {
          ok: true,
          running: true,
          jobId,
          elapsedMs: last?.elapsedMs,
          hint: '任务仍在生成中（超过 280 秒）：请稍后在工作台「创作」页查看结果，或再次查询该 jobId。',
        }
      },
    }),
  )

  tools.push(
    defineTool({
      name: 'comfymcp_dev',
      description:
        '开发模式工具（插件自查自修）：开发模式（配置 devMode）开启时，允许定位并修复插件源码（plugins/dsh-comfymcp-client/**）、把结论记录到日志；**未开启时严禁修改任何插件源码**，只能按插件规则执行并把问题记录/转述给用户。' +
        'action=report 读最近异常报告（按级别/来源汇总 + 最近的错误明细 + 复现线索）；action=note 记录一条发现（message 必填，level 可选 info/warn/error）；action=clear 清空日志。' +
        'Answers { ok, devMode, report? | entry?, guidance }。',
      parameters: {
        action: { type: 'string', description: 'report（默认）| note | clear' },
        message: { type: 'string', description: 'action=note 时的发现描述（必填）' },
        level: { type: 'string', description: 'action=note 时的级别：info（默认）| warn | error' },
        limit: { type: 'number', description: 'report/note 返回的条数上限（默认 40）' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => text(oneLine(value)),
      },
      async execute(args = {}) {
        const action = String(args.action ?? 'report').trim() || 'report'
        if (action === 'clear') {
          log.clear()
          return { ok: true, devMode: isDevMode(), action, guidance: '开发日志已清空。' }
        }
        if (action === 'note') {
          const message = String(args.message ?? '').trim()
          if (message.length === 0) return { ok: false, devMode: isDevMode(), action, error: 'note 需要 message' }
          const entry = log.add({ level: String(args.level ?? 'info'), source: 'model', message })
          return { ok: true, devMode: isDevMode(), action, entry, guidance: log.report({ limit: 1 }).guidance }
        }
        const report = log.report({ limit: Number(args.limit) || 40 })
        return { ok: true, devMode: isDevMode(), action: 'report', report, guidance: report.guidance }
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

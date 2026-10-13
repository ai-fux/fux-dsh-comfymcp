/**
 * 工作流 → 静态网页协议（v1）。
 *
 * 页面描述符（descriptor）是协议载体：把工作流图按节点编排为分组控件，
 * 渲染器（renderPageHtml）对描述符做确定性输出——同描述符必得同页面。
 * 页面内的「执行 / 快捷指令」按钮调用控制端点 /api/run、/api/quick，
 * 由宿主半区复用与模型工具完全相同的运行核心（runcore）执行。
 */
import { DEFAULT_QUICK_COMMANDS } from './quick.js'
import { resolveNodeInfo } from './nodecat.js'

/** 控件类型的链接型（非控件）类别：接线字段不渲染。 */
const LINK_TYPES = /^(MODEL|CLIP|CLIP_VISION|VAE|CONDITIONING|LATENT|IMAGE|MASK|AUDIO|VIDEO|CONTROL_NET|UPSCALE_MODEL|STYLE_MODEL|SIGMAS|NOISE|GUIDER|SAMPLER|BASIC_SCHEDULER|SAMPLER_CUSTOM)$/i

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export { escapeHtml }

function isMultilineText(name, type) {
  return String(type).toUpperCase().includes('STRING') && /^(text|prompt|positive|negative|caption|notes)/i.test(String(name))
}

/** 单个字段映射：返回 null 表示不渲染（链接/保留字段）。 */
function fieldFor(nodeId, input, value) {
  const name = String(input.name ?? '')
  if (name.length === 0) return null
  const rawType = input.type
  const upper = Array.isArray(rawType) ? '' : String(rawType ?? '').toUpperCase()
  // 枚举：官方 COMBO+options（内嵌链路实证）与旧约定数组类型都认
  const comboOptions = Array.isArray(rawType)
    ? rawType.map((entry) => String(entry))
    : upper === 'COMBO' && Array.isArray(input.options)
      ? input.options.map((entry) => String(entry))
      : null
  if (comboOptions !== null) {
    return { field: name, label: name, type: 'choice', options: comboOptions, value: String(value ?? ''), required: input.required === true }
  }
  if (LINK_TYPES.test(upper)) return null
  if (upper === 'INT' || upper === 'FLOAT' || /seed/i.test(name)) {
    const isSeed = /seed/i.test(name)
    return {
      field: name,
      label: name,
      type: isSeed ? 'seed' : 'number',
      value: value === undefined || value === null ? '' : String(value),
      min: input.min,
      max: input.max,
      step: upper === 'FLOAT' ? (input.step ?? 0.01) : 1,
      required: input.required === true,
    }
  }
  if (upper === 'BOOLEAN') {
    return { field: name, label: name, type: 'boolean', value: value === true, required: input.required === true }
  }
  if (upper.includes('STRING')) {
    return {
      field: name,
      label: name,
      type: isMultilineText(name, rawType) ? 'text' : 'string',
      value: String(value ?? ''),
      required: input.required === true,
    }
  }
  return null
}

/**
 * 构建页面描述符。
 * @param nodeInfos node_info 返回的 { Cls: { inputs: [{name,type,required,default,min,max,step}] } }
 */
export function buildPageDescriptor({ name, title, graph, nodeInfos = {}, notes = [], prefill = {} }) {
  const sections = []
  for (const [nodeId, nodeRaw] of Object.entries(graph ?? {})) {
    const node = nodeRaw !== null && typeof nodeRaw === 'object' ? nodeRaw : {}
    const classType = String(node.class_type ?? 'Unknown')
    const values = node.inputs !== null && typeof node.inputs === 'object' ? node.inputs : {}
    const info = resolveNodeInfo(nodeInfos, classType)
    const declared = Array.isArray(info?.inputs) ? info.inputs : []
    const fields = []
    const seen = new Set()
    for (const input of declared) {
      const fieldName = String(input?.name ?? '')
      if (fieldName.length === 0 || seen.has(fieldName)) continue
      seen.add(fieldName)
      const value = values[fieldName]
      if (value !== undefined && value !== null && Array.isArray(value) && value.length >= 2) continue // 输入链接
      // 上次运行的参数优先（同名字段直接带出，并标记来源）
      const remembered = prefill !== null && typeof prefill === 'object' ? prefill[`${nodeId}:${fieldName}`] : undefined
      const usesRemembered = remembered !== undefined && remembered !== null && !(typeof remembered === 'object')
      const field = fieldFor(nodeId, input, usesRemembered ? remembered : value !== undefined ? value : input.default)
      if (field === null) continue
      fields.push(usesRemembered ? { ...field, fromLastRun: true } : field)
    }
    // 声明缺失（node_info 不可用）时回退：渲染图里已有的非链接标量
    if (declared.length === 0) {
      for (const [fieldName, value] of Object.entries(values)) {
        if (value !== null && typeof value === 'object') continue
        if (Array.isArray(value) && value.length >= 2) continue
        const remembered = prefill !== null && typeof prefill === 'object' ? prefill[`${nodeId}:${fieldName}`] : undefined
        const usesRemembered = remembered !== undefined && remembered !== null && !(typeof remembered === 'object')
        const effective = usesRemembered ? remembered : value
        const upper = typeof effective === 'number' ? (Number.isInteger(effective) ? 'INT' : 'FLOAT') : typeof effective === 'boolean' ? 'BOOLEAN' : 'STRING'
        const field = fieldFor(nodeId, { name: fieldName, type: upper, required: false }, effective)
        if (field !== null) fields.push(usesRemembered ? { ...field, fromLastRun: true } : field)
      }
    }
    if (fields.length === 0) continue
    sections.push({ nodeId, classType, title: `${classType} (${nodeId})`, fields })
  }
  return {
    version: 1,
    workflow: String(name ?? 'workflow'),
    title: String(title ?? name ?? 'workflow'),
    generatedAt: new Date().toISOString(),
    nodeCount: Object.keys(graph ?? {}).length,
    sections,
    notes: Array.isArray(notes) ? notes.map((note) => String(note)) : [],
  }
}

const PAGE_CSS = `
:root{--bg:#f6f7f9;--surface:#ffffff;--text:#1f2329;--muted:#6f7680;--line:#e4e7ec;--accent:#3b6cf0;--accent-weak:#eaf0ff;--ok:#1a7f37;--err:#c0392b;--radius:8px}
@media (prefers-color-scheme:dark){:root{--bg:#141517;--surface:#1d1f23;--text:#e8eaed;--muted:#9aa1ab;--line:#2e3238;--accent:#6f96ff;--accent-weak:#22304d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 system-ui,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif}
.wrap{max-width:860px;margin:0 auto;padding:20px 16px 48px}
h1{font-size:17px;margin:0 0 2px}.sub{color:var(--muted);font-size:12px;margin-bottom:16px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:14px 16px;margin-bottom:12px}
.card h3{margin:0 0 10px;font-size:13px;color:var(--muted);font-weight:600}
.row{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px;align-items:center}
.row:last-child{margin-bottom:0}label{min-width:130px;max-width:100%;color:var(--muted);font-size:12px;word-break:break-all}
.row.fromLast label{color:var(--accent)}
.row.fromLast input,.row.fromLast textarea,.row.fromLast select{border-color:var(--accent)}
input[type=text],input[type=number],textarea,select{flex:1;min-width:180px;padding:5px 9px;border:1px solid var(--line);border-radius:var(--radius);background:var(--bg);color:var(--text);font:inherit}
textarea{min-height:56px;resize:vertical}button{padding:6px 14px;border-radius:var(--radius);border:1px solid var(--line);background:var(--surface);color:var(--text);cursor:pointer;font:inherit}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button.mini{padding:2px 8px;font-size:12px}
button:hover{filter:brightness(.97)}button:disabled{opacity:.55;cursor:default}
.state{padding:10px 12px;border-radius:var(--radius);background:var(--accent-weak);color:var(--muted);margin-top:12px;font-size:13px;display:none}
.tiles{display:flex;flex-wrap:wrap;gap:10px;margin-top:12px}.tiles img{width:200px;border-radius:var(--radius);border:1px solid var(--line);display:block}
a{color:var(--accent);text-decoration:none}.top{display:flex;justify-content:space-between;align-items:baseline}
.chip{display:inline-block;padding:1px 8px;border-radius:99px;background:var(--accent-weak);color:var(--accent);font-size:12px;margin:0 4px 4px 0}
.file{display:flex;gap:8px;align-items:center;padding:6px 0;border-top:1px solid var(--line);flex-wrap:wrap}
.file:first-of-type{border-top:0}.file .name{flex:1;min-width:200px;word-break:break-all;font-size:13px}
.muted{color:var(--muted);font-size:12px}.hidden{display:none}
.actions{display:flex;gap:8px;align-items:center;margin-top:12px}
.spinner{display:inline-block;width:12px;height:12px;margin-right:6px;border:2px solid rgba(255,255,255,.45);border-top-color:#fff;border-radius:50%;animation:spin .8s linear infinite;vertical-align:-1px}
.spinner[hidden]{display:none}
@keyframes spin{to{transform:rotate(360deg)}}
/* 媒体预览弹层（图片放大 / 视频音频播放） */
.modal{position:fixed;inset:0;background:rgba(12,14,17,.78);display:flex;align-items:center;justify-content:center;z-index:50;padding:24px}
.modal[hidden]{display:none}
.modal .box{background:var(--surface);border-radius:10px;padding:12px;max-width:92vw;max-height:88vh;overflow:auto;position:relative}
.modal img{max-width:88vw;max-height:74vh;display:block;border-radius:6px}
.modal video{max-width:88vw;max-height:74vh;display:block;border-radius:6px;background:#000}
.modal audio{width:min(560px,84vw);display:block}
.modal .bar2{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:8px;font-size:13px}
.progress{margin-top:12px}.bar{height:8px;border-radius:99px;background:var(--accent-weak);overflow:hidden}
.bar .fill{height:100%;width:0;background:var(--accent);transition:width .4s ease}
.bar .fill.indeterminate{animation:pulse 1.4s ease-in-out infinite}
@keyframes pulse{0%{margin-left:0;width:25%}50%{margin-left:65%;width:35%}100%{margin-left:0;width:25%}}
.results{margin-top:16px}.results .head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.files{margin-top:8px}.tiles a{display:inline-block}
/* 文本字段：宽域 + 自动增高 + 展开编辑 */
.textwrap{flex:1;min-width:220px;display:flex;flex-direction:column;gap:4px}
.textwrap textarea{width:100%;min-height:64px;max-height:340px;font-size:13px;line-height:1.45}
.texthint{display:flex;justify-content:space-between;align-items:center;gap:8px}
.modal .box.wide{width:min(1100px,94vw)}
.modal textarea{width:100%;min-height:56vh;max-height:70vh;font-size:13px;line-height:1.5;padding:10px}
.assignHint{border-left:3px solid var(--accent);background:var(--surface);border-radius:8px;padding:8px 12px;margin-bottom:10px;font-size:13px}
.assignHint[hidden]{display:none}
/* 成果分组：每次运行一组，一行或多行自适应 */
.history{display:grid;grid-template-columns:repeat(auto-fill,minmax(440px,1fr));gap:12px;margin-top:10px}
.runGroup{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}
.runGroup .rgHead{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline}
.runGroup .rgHead .idx{font-weight:600;font-size:13px}
.runGroup .chip.ok{background:rgba(26,127,55,.12);color:var(--ok)}
.runGroup .chip.bad{background:rgba(192,57,43,.12);color:var(--err)}
.runGroup .promptMini{font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:help}
.runGroup details.params{font-size:12px}
.runGroup details.params summary{cursor:pointer;color:var(--accent)}
.runGroup table.pv{width:100%;border-collapse:collapse;margin-top:6px}
.runGroup table.pv td{border-top:1px solid var(--line);padding:2px 6px;vertical-align:top;word-break:break-all}
.runGroup table.pv td.k{color:var(--muted);white-space:nowrap;width:38%}
.runGroup .mediaRow{display:flex;flex-wrap:wrap;gap:8px}
.runGroup .mediaRow .item{position:relative;width:104px;height:104px;border-radius:8px;overflow:hidden;border:1px solid var(--line);background:var(--accent-weak);display:flex;align-items:center;justify-content:center;cursor:zoom-in}
.runGroup .mediaRow .item img{width:100%;height:100%;object-fit:cover;display:block}
.runGroup .mediaRow .item .big{font-size:28px;color:var(--accent)}
.runGroup .mediaRow .item .cap{position:absolute;left:0;right:0;bottom:0;background:rgba(0,0,0,.55);color:#fff;font-size:10px;padding:1px 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.runGroup .rgOps{display:flex;gap:6px;flex-wrap:wrap}
.runGroup .mediaRow .item .del{position:absolute;right:4px;top:4px;width:20px;height:20px;padding:0;border-radius:6px;border:1px solid rgba(255,255,255,.5);background:rgba(0,0,0,.55);color:#fff;font-size:11px;line-height:1;cursor:pointer}
.runGroup .mediaRow .item .del:hover{background:var(--err);border-color:var(--err)}
.history .empty{color:var(--muted);font-size:13px}
`

function pageShell(title, body, { extraScript = '', extraCss = '' } = {}) {
  const styles = extraCss.length > 0 ? `${PAGE_CSS}${extraCss}` : PAGE_CSS
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${styles}</style></head>
<body><div class="wrap">${body}</div>
<script>${extraScript}</script></body></html>
`
}

/** Tab 样式（索引页专用，与 DSH 简约风一致）。 */
const INDEX_CSS = `
.tabs{display:flex;gap:8px;margin:12px 0}
.tab{background:transparent;border:1px solid var(--line);border-radius:8px;padding:6px 14px;cursor:pointer;font-size:13px;color:var(--muted)}
.tab.active{color:var(--fg);border-color:var(--fg);font-weight:600}
`

function fieldControlHtml(field, fieldId, dataKey) {
  const type = field.type
  if (type === 'boolean') {
    return `<input type="checkbox" id="${fieldId}" data-field="${escapeHtml(dataKey)}" ${field.value === true ? 'checked' : ''}>`
  }
  if (type === 'choice') {
    const options = Array.isArray(field.options) ? field.options.map((option) => String(option)) : []
    const current = field.value === undefined || field.value === null ? '' : String(field.value)
    // 当前值不在可选项里（如引用了本机缺失的素材）→ 保留并标注，避免静默丢值
    const stale = current.length > 0 && !options.includes(current)
      ? `<option value="${escapeHtml(current)}" selected>${escapeHtml(current)}（当前值·不可用）</option>`
      : ''
    const list = options.map((option) => `<option value="${escapeHtml(option)}" ${current === option ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('')
    return `<select id="${fieldId}" data-field="${escapeHtml(dataKey)}">${stale}${list}</select>`
  }
  if (type === 'text') {
    // 提示词类字段：更宽的域 + 自动增高 + 「展开」大域查看全文
    const value = String(field.value ?? '')
    const lines = value.split('\n').length
    const rows = Math.max(3, Math.min(14, Math.max(lines, Math.ceil(value.length / 70))))
    return `<div class="textwrap"><textarea id="${fieldId}" data-field="${escapeHtml(dataKey)}" rows="${rows}" placeholder="（空）">${escapeHtml(value)}</textarea>
<div class="texthint"><span class="muted">${value.length} 字 · ${lines} 行</span>
<button type="button" class="mini" data-expand="${fieldId}" title="在大窗口中查看/编辑全文">⤢ 展开</button></div></div>`
  }
  const minMax = `${field.min !== undefined && field.min !== null ? ` min="${field.min}"` : ''}${field.max !== undefined && field.max !== null ? ` max="${field.max}"` : ''}`
  const step = type === 'number' ? ` step="${field.step ?? 1}"` : ' step="1"'
  const dice = type === 'seed' ? ` <button type="button" class="mini" data-dice="${fieldId}" title="重滚种子">🎲</button>` : ''
  return `<input type="number" id="${fieldId}" data-field="${escapeHtml(dataKey)}" value="${escapeHtml(field.value)}"${minMax}${step}>${dice}`
}

/** 渲染工作流页面（描述符 → HTML，确定性输出）。 */
export function renderPageHtml(descriptor, options = {}) {
  const token = String(options.token ?? '')
  const quickCommands = Array.isArray(options.quickCommands) ? options.quickCommands : DEFAULT_QUICK_COMMANDS
  const apiCfg = { token }
  const sections = (descriptor.sections ?? [])
    .map((section) => {
      const rows = section.fields
        .map((field) => {
          // 复合键 nodeId:field —— 同名字段跨节点不冲突
          const fieldId = `f-${section.nodeId}-${escapeHtml(field.field)}`
          const control = fieldControlHtml(field, fieldId, `${section.nodeId}:${field.field}`)
          const mark = field.fromLastRun === true ? ' <span class="chip" title="该值来自上一次运行，可手动改回">上次</span>' : ''
          return `<div class="row${field.fromLastRun === true ? ' fromLast' : ''}"><label for="${fieldId}">${escapeHtml(field.label)}${mark}</label>${control}</div>`
        })
        .join('\n')
      return `<div class="card"><h3>${escapeHtml(section.title)}</h3>${rows}</div>`
    })
    .join('\n')
  const quickBar = quickCommands.length > 0
    ? `<div class="row" style="margin-bottom:10px">${quickCommands.map((command) => `<button type="button" data-quick="${escapeHtml(command.name)}">${escapeHtml(command.label ?? command.name)}</button>`).join('')}</div>`
    : ''
  const refreshBtn = `<button type="button" class="mini" data-refresh="1" title="丢弃解析缓存，重新拉取工作流与节点元数据并重渲染">↻ 重新解析</button>`
  const notes = Array.isArray(descriptor.notes) ? descriptor.notes : []
  const noteBar = notes.length > 0
    ? `<div class="card" style="border-left:3px solid var(--accent)">${notes.map((note) => `<div class="muted">${escapeHtml(note)}</div>`).join('')}</div>`
    : ''
  const emptyHint = descriptor.nodeCount === 0
    ? '未能解析出任何节点：该文件可能不是 ComfyUI 工作流，或为不支持的子图格式。请确认服务端可用后点「↻ 重新解析」。'
    : '该工作流没有可编辑参数（参数全部来自上游链接，或节点元数据不可用）。'
  const body = `
<div class="top"><div><h1>${escapeHtml(descriptor.title)}</h1>
<div class="sub">工作流 ${escapeHtml(descriptor.workflow)} · ${descriptor.nodeCount} 节点 · ${sections.length} 组参数 · 生成于 ${escapeHtml(descriptor.generatedAt)} · ${refreshBtn}</div></div>
<a href="/ui?token=${encodeURIComponent(token)}">← 全部页面</a></div>${noteBar}
${quickBar}
<form id="run-form" onsubmit="return false">
${sections || `<div class="card">${escapeHtml(emptyHint)}</div>`}
<div class="actions">
<button type="submit" class="primary" id="run-btn"><span class="spinner" id="run-spin" hidden></span><span id="run-label">▶ 执行工作流</span></button>
<button type="button" class="mini" id="cancel-btn" hidden>■ 中断执行</button>
<button type="button" class="mini" id="reload-btn" title="重新读取执行状态（刷新页面也不会丢）">↻ 刷新状态</button>
</div>
</form>
<div class="state" id="state"></div>
<div class="assignHint" id="assign-hint" hidden></div>
<div class="timing muted" id="timing"></div>
<div class="progress" id="progress" hidden><div class="bar"><div class="fill" id="progress-fill"></div></div><div class="muted" id="progress-text"></div></div>
<div class="results" id="results" hidden>
  <div class="head"><b>成果物 <span id="results-count">0</span></b>
  <span class="muted">最近多次运行按组展示；每组的「参数」可展开，鼠标移入缩略图可看参数</span>
  <span><button type="button" class="mini" id="history-reload" title="重新读取运行历史">↻ 刷新成果</button>
  <button type="button" class="mini" id="clear-btn">清空展示</button></span></div>
  <div class="history" id="history"></div>
</div>
<div class="modal" id="preview2" hidden><div class="box">
<div class="bar2"><span id="preview2-name"></span><span class="tools">
<button type="button" class="mini" data-zoom="out">−</button><span id="zoom-label" class="muted">100%</span>
<button type="button" class="mini" data-zoom="in">＋</button>
<button type="button" class="mini" data-zoom="reset">重置</button>
<button type="button" class="mini" id="preview2-close">关闭 ✕</button></span></div>
<div id="preview2-body"></div>
<div class="zoomHint" id="zoom-hint">滚轮缩放 · 拖拽平移 · 双击切换 100%/200% · 快捷键 +/−/0 · Esc 关闭</div>
</div></div>
<div class="modal" id="textmodal" hidden><div class="box wide">
<div class="bar2"><span id="textmodal-name">编辑全文</span><span>
<button type="button" class="mini" id="textmodal-save">保存到表单</button>
<button type="button" class="mini" id="textmodal-close">关闭 ✕</button></span></div>
<textarea id="textmodal-area" spellcheck="false"></textarea>
<div class="muted" id="textmodal-hint"></div>
</div></div>
<script>
var API_CFG = ${JSON.stringify(apiCfg)};
var WORKFLOW = ${JSON.stringify(descriptor.workflow)};
${PAGE_RUN_JS}
</script>`
  return pageShell(descriptor.title, body, { extraCss: PREVIEW_CSS })
}

/** 工作台顶部三 Tab（我的工作流 / 模板 / 成果物），三页共用，齐平展示。 */
export function workbenchTabs(active, token = '') {
  const enc = encodeURIComponent(token)
  const item = (key, label, href, count) => `<a class="wtab ${active === key ? 'active' : ''}" href="${href}?token=${enc}">${label}${typeof count === 'number' ? `（${count}）` : ''}</a>`
  return `<nav class="wtabs">
${item('mine', '我的工作流', '/ui', typeof active === 'object' ? active.mine : undefined)}
${item('library', '模板', '/ui/library', typeof active === 'object' ? active.library : undefined)}
${item('artifacts', '成果物', '/ui/artifacts', typeof active === 'object' ? active.artifacts : undefined)}
</nav>`
}

/** Tab 栏样式（三页共用）。 */
const TABS_CSS = `
.wtabs{display:flex;gap:6px;border-bottom:1px solid var(--line);margin:2px 0 16px;flex-wrap:wrap}
.wtabs .wtab{padding:7px 16px;border:1px solid var(--line);border-bottom:none;border-radius:8px 8px 0 0;background:var(--bg);color:var(--muted);font-size:13px;margin-bottom:-1px}
.wtabs .wtab.active{background:var(--surface);color:var(--text);font-weight:600;border-color:var(--line)}
.wtabs .wtab:hover{color:var(--text)}
`

/** CSS：预览弹层（含缩放画布）。两页共用。 */
const PREVIEW_CSS = `
.modal{position:fixed;inset:0;background:rgba(12,14,17,.82);display:flex;align-items:center;justify-content:center;z-index:60;padding:20px}
.modal[hidden]{display:none}
.modal .box{background:var(--surface);border-radius:10px;padding:10px 12px;max-width:94vw;max-height:90vh;display:flex;flex-direction:column;gap:8px;position:relative}
.modal .bar2{display:flex;justify-content:space-between;align-items:center;gap:12px;font-size:13px}
.modal .bar2 .tools{display:flex;gap:6px;align-items:center}
.modal .stage{overflow:hidden;display:flex;align-items:center;justify-content:center;background:var(--bg);border-radius:8px;min-width:min(70vw,320px);min-height:200px}
.modal .stage img{max-width:88vw;max-height:70vh;display:block;border-radius:6px;transform-origin:center center;cursor:grab;user-select:none}
.modal .stage img.dragging{cursor:grabbing}
.modal video{max-width:88vw;max-height:70vh;display:block;border-radius:6px;background:#000}
.modal audio{width:min(560px,84vw);display:block;margin:24px auto}
.modal .zoomHint{color:var(--muted);font-size:11px;text-align:right}
`

/**
 * 预览器脚本：两页共用（图片滚轮缩放/拖拽平移/重置，视频音频就地播放）。
 * 需要调用方提供 openPreview(target) —— 由各页在自己的点击处理里按属性名分派。
 */
const PREVIEW_JS = `
var ZOOM = { scale: 1, x: 0, y: 0, dragging: false, startX: 0, startY: 0 };
function zoomApply(img) {
  img.style.transform = 'translate(' + ZOOM.x + 'px,' + ZOOM.y + 'px) scale(' + ZOOM.scale + ')';
  var label = document.getElementById('zoom-label');
  if (label) label.textContent = Math.round(ZOOM.scale * 100) + '%';
}
function zoomReset() {
  ZOOM.scale = 1; ZOOM.x = 0; ZOOM.y = 0;
  var img = document.querySelector('.modal .stage img');
  if (img) zoomApply(img);
}
function zoomBy(factor) {
  var img = document.querySelector('.modal .stage img');
  if (!img) return;
  ZOOM.scale = Math.max(0.1, Math.min(8, ZOOM.scale * factor));
  zoomApply(img);
}
function fillPreview(bodyId, kind, url, name) {
  ZOOM.scale = 1; ZOOM.x = 0; ZOOM.y = 0;
  var body = document.getElementById(bodyId);
  if (kind === 'video') body.innerHTML = '<video src="' + url + '" controls autoplay playsinline></video>';
  else if (kind === 'audio') body.innerHTML = '<audio src="' + url + '" controls autoplay></audio>';
  else if (kind === 'image') body.innerHTML = '<div class="stage"><img src="' + url + '" alt="" draggable="false"></div>';
  else body.innerHTML = '<div class="muted">该类型不支持内嵌预览，请下载后查看。</div>';
  var label = document.getElementById('zoom-label');
  if (label) label.textContent = '100%';
  var hint = document.getElementById('zoom-hint');
  if (hint) hint.hidden = kind !== 'image';
}
function bindPreviewEvents(modalId) {
  var modal = document.getElementById(modalId);
  if (!modal) return;
  modal.addEventListener('wheel', function (event) {
    var img = modal.querySelector('.stage img');
    if (!img) return;
    event.preventDefault();
    zoomBy(event.deltaY < 0 ? 1.15 : 1 / 1.15);
  }, { passive: false });
  modal.addEventListener('mousedown', function (event) {
    var img = modal.querySelector('.stage img');
    if (!img || event.target !== img) return;
    ZOOM.dragging = true; ZOOM.startX = event.clientX - ZOOM.x; ZOOM.startY = event.clientY - ZOOM.y;
    img.classList.add('dragging');
    event.preventDefault();
  });
  window.addEventListener('mousemove', function (event) {
    if (!ZOOM.dragging) return;
    var img = modal.querySelector('.stage img');
    if (!img) return;
    ZOOM.x = event.clientX - ZOOM.startX; ZOOM.y = event.clientY - ZOOM.startY;
    zoomApply(img);
  });
  window.addEventListener('mouseup', function () {
    ZOOM.dragging = false;
    var img = modal.querySelector('.stage img');
    if (img) img.classList.remove('dragging');
  });
  modal.addEventListener('dblclick', function (event) {
    if (event.target.tagName !== 'IMG') return;
    ZOOM.scale = ZOOM.scale > 1.01 ? 1 : 2;
    ZOOM.x = 0; ZOOM.y = 0;
    zoomApply(event.target);
  });
  document.addEventListener('keydown', function (event) {
    if (modal.hidden) return;
    if (event.key === 'Escape') closePreviewModal(modalId);
    else if (event.key === '+' || event.key === '=') zoomBy(1.2);
    else if (event.key === '-') zoomBy(1 / 1.2);
    else if (event.key === '0') zoomReset();
  });
}
function closePreviewModal(modalId) {
  var body = document.getElementById(modalId + '-body');
  if (body) body.innerHTML = ''; // 清空以停止播放
  document.getElementById(modalId).hidden = true;
}
`

const PAGE_RUN_JS = `
${PREVIEW_JS}
function api(path, body) {
  return fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: Object.assign({'x-dsh-comfymcp': '1', 'content-type': 'application/json'},
      API_CFG.token ? {'x-dsh-comfymcp-token': API_CFG.token} : {}),
    body: body === undefined ? undefined : JSON.stringify(body)
  }).then(function (res) { return res.json().then(function (data) { if (!res.ok || data.ok === false) throw new Error((data.error && data.error.message) || ('HTTP ' + res.status)); return data.value !== undefined ? data.value : data }) });
}
function artifactUrl(file) {
  return '/artifact?path=' + encodeURIComponent(file.path || '') + (API_CFG.token ? '&token=' + encodeURIComponent(API_CFG.token) : '');
}
function state(text, isError) {
  var el = document.getElementById('state');
  el.style.display = text ? 'block' : 'none';
  el.style.background = isError ? 'rgba(192,57,43,.12)' : '';
  el.style.color = isError ? 'var(--err)' : '';
  el.textContent = text || '';
}
function fmtElapsed(ms) {
  var s = Math.max(0, Math.round((ms || 0) / 1000));
  return s < 60 ? s + 's' : Math.floor(s / 60) + 'm' + (s % 60) + 's';
}
function busy(on, label) {
  var btn = document.getElementById('run-btn');
  var spin = document.getElementById('run-spin');
  var text = document.getElementById('run-label');
  btn.disabled = !!on;
  btn.style.opacity = on ? '.65' : '';
  spin.hidden = !on;
  text.textContent = on ? (label || '执行中…') : '▶ 执行工作流';
}
function showProgress(status) {
  var wrap = document.getElementById('progress');
  if (!status || status.state !== 'running') { wrap.hidden = true; return; }
  wrap.hidden = false;
  var progress = status.progress || {};
  var fill = document.getElementById('progress-fill');
  var percent = typeof progress.percent === 'number' ? progress.percent
    : (progress.step !== null && progress.step !== undefined && progress.total ? Math.round((progress.step / progress.total) * 100) : null);
  if (percent === null || percent === undefined) { fill.classList.add('indeterminate'); fill.style.width = '35%'; }
  else { fill.classList.remove('indeterminate'); fill.style.width = Math.max(2, Math.min(100, percent)) + '%'; }
  var stepText = (progress.step !== null && progress.step !== undefined && progress.total) ? (' · ' + progress.step + '/' + progress.total) : '';
  var nodeText = progress.node ? (' · 节点 ' + progress.node) : '';
  document.getElementById('progress-text').textContent =
    (status.stage || '执行中') + stepText + nodeText + ' · 已用 ' + fmtElapsed(status.elapsedMs) + (status.promptId ? ' · ' + String(status.promptId).slice(0, 8) : '');
}
/* ---------------- 运行历史（多次执行成果分组展示） ---------------- */
function paramRows(params) {
  var rows = '';
  (params || []).forEach(function (param) {
    var label = (param.node ? param.node + ' · ' : '') + param.field;
    rows += '<tr><td class="k">' + esc(label) + '</td><td title="' + esc(param.text || param.value) + '">' + esc(String(param.text || param.value).slice(0, 300)) + '</td></tr>';
  });
  return rows || '<tr><td class="k">—</td><td>（无标量参数）</td></tr>';
}
function paramSummaryText(run) {
  var parts = ['种子 ' + (run.seed === null || run.seed === undefined ? '-' : run.seed), '用时 ' + fmtElapsed(run.durationMs || run.elapsedMs)];
  var interesting = ['steps', 'cfg', 'sampler_name', 'scheduler', 'denoise', 'width', 'height', 'batch_size', 'filename_prefix'];
  (run.params || []).forEach(function (param) {
    if (interesting.indexOf(param.field) < 0) return;
    parts.push(param.field + '=' + String(param.value).slice(0, 40));
  });
  var prompts = run.prompts || {};
  if (prompts.positive) parts.push('正:' + String(prompts.positive).slice(0, 60));
  if (prompts.negative) parts.push('负:' + String(prompts.negative).slice(0, 40));
  return parts.join(' · ');
}
function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function groupHtml(run, index) {
  var state = run.state || '';
  var chipClass = state === 'completed' ? 'ok' : state === 'failed' || state === 'aborted' ? 'bad' : '';
  var time = run.startedAt ? new Date(run.startedAt).toLocaleString('zh-CN') : '';
  var hover = paramSummaryText(run);
  var promptText = '';
  var prompts = run.prompts || {};
  if (prompts.positive) promptText += '<div class="promptMini" title="' + esc(prompts.positive) + '">正：' + esc(String(prompts.positive).slice(0, 160)) + '</div>';
  if (prompts.negative) promptText += '<div class="promptMini" title="' + esc(prompts.negative) + '">负：' + esc(String(prompts.negative).slice(0, 160)) + '</div>';
  var media = (run.files || []).map(function (file) {
    var url = artifactUrl(file);
    var inner = file.kind === 'image'
      ? '<img src="' + url + '" alt="" loading="lazy" draggable="false">'
      : '<span class="big">' + (file.kind === 'video' ? '▶' : file.kind === 'audio' ? '♪' : '📄') + '</span>';
    var tip = (file.filename || '') + '\\n' + hover + '\\n（点击预览：图片可滚轮缩放）';
    return '<div class="item" data-preview2="' + esc(file.path || '') + '" data-kind="' + esc(file.kind || 'file') + '" data-name="' + esc(file.filename || '') + '" title="' + esc(tip) + '">'
      + inner + '<span class="cap">' + esc(file.filename || '') + '</span>'
      + '<button type="button" class="del" title="删除该成果物（含磁盘文件）" data-remove-file="' + esc(file.path || '') + '" data-remove-run="' + esc(run.runId || '') + '">✕</button></div>';
  }).join('');
  var body = media || '<div class="muted">（本次无成果物）</div>';
  return '<section class="runGroup" title="' + esc(hover) + '">'
    + '<div class="rgHead"><span class="idx">#' + index + ' ' + esc(run.workflow || WORKFLOW) + '</span>'
    + '<span class="chip ' + chipClass + '">' + esc(state) + '</span>'
    + '<span class="muted">种子 ' + esc(run.seed === null || run.seed === undefined ? '-' : run.seed) + ' · 用时 ' + esc(fmtElapsed(run.durationMs || run.elapsedMs)) + (time ? ' · ' + esc(time) : '') + '</span></div>'
    + promptText
    + (run.error ? '<div class="muted" style="color:var(--err)">' + esc(run.error) + '</div>' : '')
    + '<details class="params"><summary>参数（' + ((run.params || []).length) + '）· 鼠标移入亦可查看</summary><table class="pv">' + paramRows(run.params) + '</table></details>'
    + '<div class="mediaRow">' + body + '</div>'
    + '<div class="rgOps"><button type="button" class="mini" data-history-export="' + esc(run.runId || '') + '">⇩ 导出该次 JSON</button>'
    + '<button type="button" class="mini" data-drop-run="' + esc(run.runId || '') + '" title="仅从展示中移除该次运行（磁盘文件保留）">✕ 移除该组</button>'
    + '<a class="mini" style="padding:2px 8px" href="/ui/artifacts?token=' + encodeURIComponent(API_CFG.token || '') + '">成果物库 →</a></div>'
    + '</section>';
}
function renderHistory(runs) {
  var box = document.getElementById('history');
  var items = runs || [];
  document.getElementById('results').hidden = items.length === 0;
  document.getElementById('results-count').textContent = String(items.length);
  box.innerHTML = items.length === 0
    ? '<div class="empty">还没有带成果物的运行。点上方「▶ 执行工作流」开始。</div>'
    : items.map(function (run, index) { return groupHtml(run, index + 1); }).join('');
}
function loadHistory() {
  return api('/api/run/history?workflow=' + encodeURIComponent(WORKFLOW) + '&limit=6').then(function (runs) {
    renderHistory(runs || []);
  }).catch(function () { /* 历史读取失败静默 */ });
}
function fmtClock(ts) {
  if (!ts) return '-';
  var d = new Date(ts);
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}
function showTiming(status) {
  var el = document.getElementById('timing');
  if (!status) { el.textContent = ''; return; }
  var parts = [];
  parts.push('开始 ' + fmtClock(status.startedAt));
  if (status.state === 'running') {
    parts.push('已用 ' + fmtElapsed(status.elapsedMs));
    if (status.timeoutMs) parts.push('限时 ' + Math.round(status.timeoutMs / 60000) + ' 分钟');
  } else if (status.finishedAt) {
    parts.push('结束 ' + fmtClock(status.finishedAt));
    parts.push('总用时 ' + fmtElapsed(status.durationMs || status.elapsedMs));
  }
  if (status.promptId) parts.push('任务 ' + String(status.promptId).slice(0, 8));
  el.textContent = parts.join(' · ');
}
function applyStatus(status, quiet) {
  if (!status) {
    if (!quiet) { busy(false); showProgress(null); }
    return;
  }
  showTiming(status);
  var cancelBtn = document.getElementById('cancel-btn');
  if (status.state === 'running') {
    busy(true, (status.stage || '执行中') + '…');
    showProgress(status);
    cancelBtn.hidden = false;
    state('⏳ ' + (status.stage || '执行中') + ' · 已用 ' + fmtElapsed(status.elapsedMs) + '（执行中，按钮已禁用）', false);
  } else {
    busy(false);
    showProgress(null);
    cancelBtn.hidden = true;
    var files = status.files || [];
    loadHistory(); // 结束后刷新成果分组（本轮会作为新的一组出现在最前）
    if (status.state === 'failed') state('✗ ' + (status.error || '执行失败'), true);
    else if (status.state === 'aborted') state('■ ' + (status.error || '执行已中断'), true);
    else if (files.length > 0) state('✓ 完成 · ' + files.length + ' 个成果物 · 用时 ' + fmtElapsed(status.durationMs || status.elapsedMs), false);
    else state('✓ 执行完成，但没有产生成果物', false);
  }
}
function poll() {
  return api('/api/run/status?workflow=' + encodeURIComponent(WORKFLOW)).then(function (status) {
    applyStatus(status);
    if (status && status.state === 'running') setTimeout(poll, 2000);
  }).catch(function (error) { state('✗ 状态查询失败：' + error.message, true); busy(false); });
}
function collectValues() {
  var values = {};
  document.querySelectorAll('[data-field]').forEach(function (el) {
    values[el.getAttribute('data-field')] = el.type === 'checkbox' ? el.checked : (el.type === 'number' ? (el.value === '' ? null : Number(el.value)) : el.value);
  });
  return values;
}
function start(makeCall, label) {
  busy(true, label);
  showProgress(null);
  state('⏳ 正在提交…', false);
  makeCall().then(function (started) {
    state('⏳ 已提交（' + (started && started.runId ? String(started.runId).slice(0, 8) : '') + '），正在执行…', false);
    poll();
  }).catch(function (error) { state('✗ ' + error.message, true); busy(false); });
}
document.addEventListener('click', function (event) {
  var t = event.target;
  if (t.id === 'preview2-close' || t.id === 'preview2') {
    closePreviewModal('preview2');
    return;
  }
  var zoomAction = t.getAttribute && t.getAttribute('data-zoom');
  if (zoomAction) {
    if (zoomAction === 'in') zoomBy(1.25);
    else if (zoomAction === 'out') zoomBy(1 / 1.25);
    else zoomReset();
    return;
  }
  if (t.id === 'history-reload') { loadHistory(); return; }
  var historyExport = t.getAttribute && t.getAttribute('data-history-export');
  if (historyExport) {
    location.href = '/export?runs=' + encodeURIComponent(historyExport) + (API_CFG.token ? '&token=' + encodeURIComponent(API_CFG.token) : '');
    return;
  }
  var removeTarget = t.closest ? t.closest('[data-remove-file]') : null;
  if (removeTarget) {
    var removePath = removeTarget.getAttribute('data-remove-file');
    var removeRun = removeTarget.getAttribute('data-remove-run') || '';
    if (!confirm('删除该成果物？\\n\\n将从展示与运行记录中移除，并删除磁盘文件（不可恢复）。')) return;
    api('/api/artifacts/remove', { runId: removeRun, path: removePath, deleteFile: true })
      .then(function () { state('已删除该成果物', false); loadHistory(); })
      .catch(function (error) { alert('删除失败：' + error.message); });
    return;
  }
  var dropGroup = t.getAttribute && t.getAttribute('data-drop-run');
  if (dropGroup) {
    if (!confirm('把该次运行整组从展示中移除？（磁盘文件保留，可在成果物库查看）')) return;
    api('/api/artifacts/remove', { runId: dropGroup, dropRun: true })
      .then(function () { loadHistory(); })
      .catch(function (error) { alert('移除失败：' + error.message); });
    return;
  }
  var previewHost = t.closest ? t.closest('[data-preview2]') : null;
  if (previewHost) {
    var kind2 = previewHost.getAttribute('data-kind') || 'file';
    var path2 = previewHost.getAttribute('data-preview2');
    var url2 = '/artifact?path=' + encodeURIComponent(path2) + (API_CFG.token ? '&token=' + encodeURIComponent(API_CFG.token) : '');
    document.getElementById('preview2-name').textContent = previewHost.getAttribute('data-name') || '';
    fillPreview('preview2-body', kind2, url2, previewHost.getAttribute('data-name') || '');
    document.getElementById('preview2').hidden = false;
    return;
  }
  if (t.id === 'textmodal-close' || t.id === 'textmodal') {
    document.getElementById('textmodal').hidden = true;
    return;
  }
  if (t.id === 'textmodal-save') {
    var area = document.getElementById('textmodal-area');
    var source = document.getElementById(area.getAttribute('data-for'));
    if (source) {
      source.value = area.value;
      var wrap = source.closest ? source.closest('.textwrap') : null;
      var hint = wrap ? wrap.querySelector('.texthint .muted') : null;
      if (hint) hint.textContent = area.value.length + ' 字 · ' + area.value.split('\\n').length + ' 行';
    }
    document.getElementById('textmodal').hidden = true;
    return;
  }
  var expandId = t.getAttribute && t.getAttribute('data-expand');
  if (expandId) {
    var field = document.getElementById(expandId);
    if (!field) return;
    var modal = document.getElementById('textmodal');
    var target = document.getElementById('textmodal-area');
    target.value = field.value;
    target.setAttribute('data-for', expandId);
    var label = field.closest ? field.closest('.row') : null;
    document.getElementById('textmodal-name').textContent = (label && label.querySelector('label') ? label.querySelector('label').textContent : '') + ' · 全文编辑';
    document.getElementById('textmodal-hint').textContent = field.value.length + ' 字 · 修改后点「保存到表单」写回';
    modal.hidden = false;
    target.focus();
    return;
  }
  if (t.getAttribute && t.getAttribute('data-refresh')) {
    t.disabled = true; t.textContent = '解析中…';
    api('/api/refresh', { workflow: WORKFLOW }).then(function () { location.reload(); })
      .catch(function (error) { t.disabled = false; t.textContent = '↻ 重新解析'; alert('重新解析失败：' + error.message); });
    return;
  }
  if (t.id === 'reload-btn') { state('正在刷新状态…', false); api('/api/run/status?workflow=' + encodeURIComponent(WORKFLOW)).then(function (s) { applyStatus(s); }).catch(function (e) { state('✗ ' + e.message, true); }); return; }
  if (t.id === 'cancel-btn') {
    if (!confirm('确定中断当前执行？（同时请求取消队列中的任务）')) return;
    t.disabled = true; t.textContent = '中断中…';
    api('/api/run/cancel', { workflow: WORKFLOW }).then(function () { state('■ 已请求中断…', false); poll(); })
      .catch(function (e) { alert('中断失败：' + e.message); })
      .then(function () { t.disabled = false; t.textContent = '■ 中断执行'; });
    return;
  }
  if (t.id === 'clear-btn') {
    api('/api/runs/clear', { workflow: WORKFLOW }).then(function () { loadHistory(); state('已清空展示（产物文件仍可在成果物页查看）', false); })
      .catch(function (e) { alert('清空失败：' + e.message); });
    return;
  }
  if (t.getAttribute && t.getAttribute('data-dice')) {
    var input = document.getElementById(t.getAttribute('data-dice'));
    input.value = String(Math.floor(1 + Math.random() * 4294967294));
  }
  var quick = t.getAttribute && t.getAttribute('data-quick');
  if (quick) { start(function () { return api('/api/quick', { workflow: WORKFLOW, command: quick }); }, '执行中…'); }
});
document.getElementById('run-form').addEventListener('submit', function (event) {
  event.preventDefault();
  start(function () { return api('/api/run', { workflow: WORKFLOW, values: collectValues() }); }, '执行中…');
});
// 页面加载即恢复：执行中的进度，或历史成果分组（刷新不丢）
bindPreviewEvents('preview2');
loadHistory();
api('/api/run/status?workflow=' + encodeURIComponent(WORKFLOW)).then(function (status) {
  applyStatus(status, true);
  if (status && status.state === 'running') poll();
}).catch(function () { /* 首次加载静默 */ });
// 成果物页点了「⇢ 赋值」的提示词：取回并回填到对应字段
api('/api/prompt/take', { workflow: WORKFLOW }).then(function (pending) {
  if (!pending || !pending.field) return;
  var field = document.querySelector('[data-field="' + pending.field + '"]');
  if (!field) return;
  field.value = pending.value || '';
  field.style.borderColor = 'var(--accent)';
  var hint = document.getElementById('assign-hint');
  hint.hidden = false;
  hint.innerHTML = '已从成果物页回填「' + (pending.kind === 'negative' ? '负' : '正') + '向提示词」到字段 <b>' + pending.field + '</b>：确认后点「▶ 执行工作流」即可生效。';
}).catch(function () { /* 无待赋值时静默 */ });
`

const PAGE_INDEX_JS = `
document.addEventListener('click', function (event) {
  var el = event.target; if (!el.getAttribute) return;
  var tab = el.getAttribute('data-tab');
  if (tab) {
    var buttons = document.querySelectorAll('[data-tab]');
    for (var i = 0; i < buttons.length; i++) buttons[i].classList.toggle('active', buttons[i] === el);
    var groups = document.querySelectorAll('[data-group]');
    for (var j = 0; j < groups.length; j++) groups[j].style.display = groups[j].getAttribute('data-group') === tab ? '' : 'none';
    return;
  }
  var pull = el.getAttribute('data-pull');
  if (pull) {
    el.disabled = true; el.textContent = '拉取中…';
    fetch('/api/workflows/pull', { method: 'POST', headers: { 'x-dsh-comfymcp': '1', 'content-type': 'application/json', 'x-dsh-comfymcp-token': TOKEN }, body: JSON.stringify({ id: pull }) })
      .then(function (res) { return res.json().then(function (data) { if (!res.ok || data.ok === false) throw new Error((data.error && data.error.message) || ('HTTP ' + res.status)); return data.value !== undefined ? data.value : data }); })
      .then(function (value) { alert('已拉取到我的工作流：' + (value && value.name ? value.name : pull)); location.reload(); })
      .catch(function (error) { el.disabled = false; el.textContent = '⬇ 拉取'; alert('拉取失败：' + error.message); });
  }
});
`

/** 渲染「我的工作流」页（三 Tab 之一）：本地工作流 + 远端工作区条目（可拉取）。 */
export function renderIndexHtml({ mine = [], library = [], token = '' }) {
  const enc = encodeURIComponent(token)
  const pageLink = (page, extra = '') => `<a class="card" style="display:block" href="/ui/wf/${encodeURIComponent(page.name)}?token=${enc}">
<b>${escapeHtml(page.title ?? page.name)}</b>${extra}
<div class="muted">${page.updatedAt ? `更新 ${escapeHtml(page.updatedAt)}` : ''}${page.origin === 'remote' ? ' · 在服务端，可拉取到本地' : ''}</div></a>`
  const pullButton = (page) => `<div class="card"><b>${escapeHtml(page.title ?? page.name)}</b> <button type="button" class="mini" data-pull="${escapeHtml(page.name)}">⬇ 拉取</button>
<div class="muted">${page.updatedAt ? `更新 ${escapeHtml(page.updatedAt)}` : ''}</div></div>`
  const mineItems = mine.map((page) => (page.origin === 'remote' ? pullButton(page) : pageLink(page))).join('\n')
  const body = `
<h1>ComfyUI 工作台</h1>
${workbenchTabs({ mine: mine.length, library: library.length }, token)}
<div class="sub">工作流静态页 · 由 dsh-comfymcp-client 生成 ·
<button type="button" class="mini" onclick="location.reload()">↻ 重新加载</button></div>
${mineItems || '<div class="card">还没有我的工作流：在「模板」里点开任一模板执行一次，或点条目的「⬇ 拉取」保存到本地。</div>'}
`
  return pageShell('ComfyUI 工作台', body, { extraScript: `var TOKEN = ${JSON.stringify(token)};\n${PAGE_INDEX_JS}`, extraCss: `${INDEX_CSS}${TABS_CSS}` })
}

/** 渲染「模板」页（三 Tab 之一）：远端模板库条目，执行一次即自动存入我的工作流。 */
export function renderLibraryHtml({ library = [], mine = [], token = '' }) {
  const enc = encodeURIComponent(token)
  const items = library
    .map((page) => `<a class="card" style="display:block" href="/ui/wf/${encodeURIComponent(page.name)}?token=${enc}">
<b>${escapeHtml(page.title ?? page.name)}</b>
<div class="muted">${page.updatedAt ? `更新 ${escapeHtml(page.updatedAt)}` : ''} · 打开后执行一次即自动保存到「我的工作流」</div></a>`)
    .join('\n')
  const body = `
<h1>ComfyUI 工作台</h1>
${workbenchTabs({ mine: mine.length, library: library.length }, token)}
<div class="sub">模板库共 ${library.length} 个 · 执行过一次后自动落入「我的工作流」；已存在时优先沿用上次运行的参数 ·
<button type="button" class="mini" onclick="location.reload()">↻ 重新加载</button></div>
${items || '<div class="card">模板库暂不可达（服务端未连接或目录为空）。</div>'}
`
  return pageShell('ComfyUI 工作台 · 模板', body, { extraCss: `${INDEX_CSS}${TABS_CSS}` })
}

const ARTIFACTS_JS = `
${PREVIEW_JS}
var API_CFG = ${JSON.stringify({ token: '' })}; API_CFG.token = TOKEN;
function api(path, body) {
  return fetch(path, { method: body === undefined ? 'GET' : 'POST',
    headers: Object.assign({'x-dsh-comfymcp':'1','content-type':'application/json'}, API_CFG.token ? {'x-dsh-comfymcp-token': API_CFG.token} : {}),
    body: body === undefined ? undefined : JSON.stringify(body) })
    .then(function (res) { return res.json().then(function (data) { if (!res.ok || data.ok === false) throw new Error((data.error && data.error.message) || ('HTTP ' + res.status)); return data.value !== undefined ? data.value : data }); });
}
function ask(label, current) { var v = prompt(label, current || ''); return v === null ? null : v.trim(); }
function mediaUrl(path) { return '/artifact?path=' + encodeURIComponent(path) + (TOKEN ? '&token=' + encodeURIComponent(TOKEN) : ''); }
function closePreview() { closePreviewModal('preview'); }
function picked() {
  return Array.prototype.slice.call(document.querySelectorAll('.rowpick:checked')).map(function (el) {
    return { runId: el.getAttribute('data-run') || '', path: el.getAttribute('data-path') || '' };
  });
}
function refreshPickCount() {
  var groups = {}, count = 0;
  document.querySelectorAll('.rowpick:checked').forEach(function (el) {
    count += 1;
    var run = el.getAttribute('data-run') || '';
    groups[run] = (groups[run] || 0) + 1;
  });
  document.querySelectorAll('.runpick').forEach(function (el) {
    el.checked = (groups[el.getAttribute('data-run') || ''] || 0) > 0;
  });
  var label = document.getElementById('pick-count');
  if (label) label.textContent = '已选 ' + count + ' 件' + (Object.keys(groups).length > 1 ? '（跨 ' + Object.keys(groups).length + ' 组）' : '');
  document.querySelectorAll('.mediacard').forEach(function (card) {
    var box = card.querySelector('.rowpick');
    if (box) card.classList.toggle('picked', box.checked);
  });
}
function renderRuns(payload) {
  var box = document.getElementById('runs');
  box.innerHTML = payload && payload.html ? payload.html : '<div class="card">没有符合条件的成果物。</div>';
  var summary = document.getElementById('runs-summary');
  if (summary && payload) {
    summary.innerHTML = (payload.summary || '') + (payload.queryText ? ' · 检索：' + payload.queryText : '') + ' · <a href="/ui?token=' + encodeURIComponent(TOKEN || '') + '">← 工作台</a>';
  }
  if (payload && payload.runIds) window.__runIds = payload.runIds;
  refreshPickCount();
}
function searchPayload() {
  return { query: document.getElementById('q').value, style: currentStyle() };
}
function currentStyle() {
  var box = document.getElementById('runs');
  var style = box && box.getAttribute('data-style');
  return style || 'masonry';
}
function applyStyle(style) {
  var box = document.getElementById('runs');
  if (!box) return;
  var next = ['masonry', 'grid2', 'fan'].indexOf(style) >= 0 ? style : 'masonry';
  box.classList.remove('style-masonry', 'style-grid2', 'style-fan');
  box.classList.add('style-' + next);
  box.setAttribute('data-style', next);
  document.querySelectorAll('[data-style]').forEach(function (btn) {
    btn.classList.toggle('dshmcp-on', btn.getAttribute('data-style') === next);
  });
  try { window.localStorage.setItem('comfymcp.artifactStyle', next); } catch (e) {}
}
function runSearch() {
  var payload = searchPayload();
  return api('/api/artifacts/query', payload)
    .then(function (result) {
      renderRuns(result);
      applyStyle(payload.style);
      var help = document.getElementById('q-help');
      if (help && result && result.hits > 0) help.hidden = true;
      return result;
    })
    .catch(function (error) { alert('检索失败：' + error.message); });
}
document.addEventListener('keydown', function (event) {
  if (event.target && event.target.id === 'q' && event.key === 'Enter') {
    event.preventDefault();
    runSearch();
  }
});
document.addEventListener('change', function (event) {
  var el = event.target;
  if (!el.classList) return;
  if (el.classList.contains('rowpick')) { refreshPickCount(); return; }
  if (el.classList.contains('runpick')) {
    var runId = el.getAttribute('data-run') || '';
    document.querySelectorAll('.rowpick[data-run="' + runId + '"]').forEach(function (box) { box.checked = el.checked; });
    refreshPickCount();
  }
});
document.addEventListener('click', function (event) {
  var el = event.target;
  if (el.id === 'preview-close' || el.id === 'preview') { closePreview(); return; }
  if (el.id === 'q-run') { runSearch(); return; }
  if (el.id === 'q-help-toggle') {
    var help = document.getElementById('q-help');
    help.hidden = !help.hidden;
    el.classList.toggle('dshmcp-on', !help.hidden);
    return;
  }
  var example = el.getAttribute && el.getAttribute('data-example');
  if (example) {
    document.getElementById('q').value = example;
    runSearch();
    return;
  }
  var stylePick = el.getAttribute && el.getAttribute('data-style');
  if (stylePick) { applyStyle(stylePick); return; }
  if (el.id === 'q-reset') {
    document.getElementById('q').value = '';
    runSearch();
    return;
  }
  if (el.id === 'pick-all') { document.querySelectorAll('.rowpick').forEach(function (box) { box.checked = true; }); refreshPickCount(); return; }
  if (el.id === 'pick-none') { document.querySelectorAll('.rowpick').forEach(function (box) { box.checked = false; }); refreshPickCount(); return; }
  if (el.id === 'remove-picked') {
    var items = picked();
    if (items.length === 0) { alert('请先勾选要删除的成果物'); return; }
    if (!confirm('删除选中的 ' + items.length + ' 件成果物？\\n\\n将从记录中移除并删除磁盘文件（不可恢复）。')) return;
    el.disabled = true;
    api('/api/artifacts/remove-batch', { items: items, deleteFile: true })
      .then(function (result) {
        alert('已删除 ' + result.deleted + ' 件' + (result.failed > 0 ? '，失败 ' + result.failed + ' 件' : ''));
        return runSearch();
      })
      .catch(function (error) { alert('批量删除失败：' + error.message); })
      .then(function () { el.disabled = false; });
    return;
  }
  var removeBtn = el.closest ? el.closest('[data-remove-file]') : null;
  if (removeBtn) {
    var path = removeBtn.getAttribute('data-remove-file');
    var runId = removeBtn.getAttribute('data-remove-run') || '';
    if (!confirm('删除该成果物？\\n\\n将从记录移除并删除磁盘文件（不可恢复）。')) return;
    api('/api/artifacts/remove', { runId: runId, path: path, deleteFile: true })
      .then(function () { return runSearch(); })
      .catch(function (error) { alert('删除失败：' + error.message); });
    return;
  }
  var zoomAction = el.getAttribute && el.getAttribute('data-zoom');
  if (zoomAction) {
    if (zoomAction === 'in') zoomBy(1.25);
    else if (zoomAction === 'out') zoomBy(1 / 1.25);
    else zoomReset();
    return;
  }
  if (el.id === 'export-all') {
    var ids = (window.__runIds || []).join(',');
    if (!ids) { alert('没有可导出的运行'); return; }
    location.href = '/export?runs=' + encodeURIComponent(ids) + (TOKEN ? '&token=' + encodeURIComponent(TOKEN) : '');
    return;
  }
  if (!el.getAttribute) return;
  var exportRun = el.getAttribute('data-export-run');
  if (exportRun) {
    location.href = '/export?runs=' + encodeURIComponent(exportRun) + (TOKEN ? '&token=' + encodeURIComponent(TOKEN) : '');
    return;
  }
  var toggle = el.getAttribute('data-prompt-toggle');
  if (toggle) {
    var box = document.getElementById(toggle);
    if (box) { box.hidden = !box.hidden; el.textContent = box.hidden ? '▾' : '▴'; }
    return;
  }
  var assignField = el.getAttribute('data-assign-field');
  if (assignField) {
    var workflow = el.getAttribute('data-workflow') || '';
    var kind = el.getAttribute('data-assign-kind') || 'positive';
    var row = el.parentElement; // .promptRow
    var full = row && row.nextElementSibling; // .promptFull
    var text = full && typeof full.className === 'string' && full.className.indexOf('promptFull') >= 0 ? full.textContent : '';
    if (!text) { alert('没有可赋值的提示词内容'); return; }
    el.disabled = true; var original = el.textContent; el.textContent = '赋值中…';
    api('/api/prompt/assign', { workflow: workflow, field: assignField, value: text, kind: kind })
      .then(function () { el.textContent = '✓ 已存入，打开工作流页即可见'; })
      .catch(function (error) { el.disabled = false; el.textContent = original; alert('赋值失败：' + error.message); });
    return;
  }
  var previewHost = el.closest ? el.closest('[data-preview]') : null;
  if (previewHost) {
    var kind = previewHost.getAttribute('data-kind') || 'file';
    var name = previewHost.getAttribute('data-name') || '';
    var url = mediaUrl(previewHost.getAttribute('data-preview'));
    document.getElementById('preview-name').textContent = name;
    fillPreview('preview-body', kind, url, name);
    document.getElementById('preview').hidden = false;
    return;
  }
  var key = el.getAttribute('data-key'); if (!key) return;
  var op = el.getAttribute('data-op');
  var patch = null;
  if (op === 'tag-add') { var v = ask('添加标签（留空取消）'); if (v) patch = { tags: [v] }; }
  else if (op === 'tag-edit') { var record = window.__records && window.__records[key]; var list = record ? (record.tags || []).join(', ') : ''; var v2 = ask('标签集合（逗号分隔，全清=置空）', list); if (v2 !== null) patch = { tagsSet: v2.length ? v2.split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean) : [] }; }
  else if (op === 'field') { var pair = ask('动态字段 key=value'); if (pair && pair.indexOf('=') > 0) { var i = pair.indexOf('='); var f = {}; f[pair.slice(0, i).trim()] = pair.slice(i + 1).trim(); patch = { fields: f }; } }
  else if (op === 'prompt') { var p = ask('绑定提示词'); if (p !== null) patch = { prompt: p }; }
  else if (op === 'source') { var s = ask('标签项目使用来源'); if (s !== null) patch = { source: s }; }
  else if (op === 'collection') { var c = ask('标记标签集合（逗号分隔）'); if (c !== null) patch = { collectionsSet: c.length ? c.split(/[,，]/).map(function (x) { return x.trim(); }).filter(Boolean) : [] }; }
  if (!patch) return;
  api('/api/tags', { key: key, patch: patch }).then(function () { location.reload(); })
    .catch(function (error) { alert('失败：' + error.message); });
});
`

const ARTIFACTS_CSS = `
.run{margin-bottom:18px}.run .head{display:flex;flex-wrap:wrap;gap:10px;align-items:baseline;margin-bottom:8px}
.run .head b{font-size:14px}
/* 一列/两列/瀑布流：卡片为竖向卡（图在上、信息在下） */
.mediaList{display:flex;flex-direction:column;gap:10px}
.mediacard{background:var(--surface);border:1px solid var(--line);border-radius:10px;display:flex;gap:12px;padding:10px;align-items:flex-start}
.mediacard .thumb{position:relative;flex:0 0 132px;width:132px;height:132px;background:var(--accent-weak);border-radius:8px;display:flex;align-items:center;justify-content:center;cursor:zoom-in;overflow:hidden}
/* 卡片式样式：瀑布流 / 两列平铺（竖向卡：缩略图占满卡片宽度） */
#runs.style-masonry{column-count:2;column-gap:12px}
@media (min-width:1200px){#runs.style-masonry{column-count:3}}
#runs.style-masonry .run,#runs.style-grid2 .run{break-inside:avoid;display:inline-block;width:100%;margin:0 0 12px}
#runs.style-grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;align-items:start}
#runs.style-grid2 .run{margin:0}
#runs.style-masonry .mediaList,#runs.style-grid2 .mediaList{display:flex;flex-direction:column;gap:10px}
#runs.style-masonry .mediacard,#runs.style-grid2 .mediacard{flex-direction:column;align-items:stretch;padding:0;overflow:hidden}
#runs.style-masonry .mediacard .thumb,#runs.style-grid2 .mediacard .thumb{flex:none;width:100%;height:auto;aspect-ratio:1/1;border-radius:0}
#runs.style-masonry .mediacard .meta,#runs.style-grid2 .mediacard .meta{padding:10px 12px}
#runs.style-fan .mediacard{flex-direction:row}
.dshmcp-on{border-color:var(--accent);color:var(--accent);font-weight:600}
.exportBar .sep{width:1px;height:16px;background:var(--line);margin:0 2px}
.qhelp{border:1px solid var(--line);border-radius:8px;padding:10px 12px;background:var(--surface);font-size:12px}
.qhelp[hidden]{display:none}
.qtable{border-collapse:collapse;width:100%}
.qtable td{border-top:1px solid var(--line);padding:3px 6px;vertical-align:top}
.qtable td:first-child{white-space:nowrap;width:1%}
.qtable code{background:var(--accent-weak);color:var(--accent);border-radius:4px;padding:0 4px}
.mediacard .thumb img{width:100%;height:100%;object-fit:cover;display:block}
.mediacard .thumb .badge{position:absolute;right:4px;bottom:4px;background:rgba(0,0,0,.55);color:#fff;border-radius:6px;padding:1px 6px;font-size:11px}
.mediacard .thumb .big{font-size:38px;color:var(--accent)}
.mediacard .meta{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}
.mediacard .fname{font-size:13px;word-break:break-all;font-weight:600}
.mediacard .ops{display:flex;flex-wrap:wrap;gap:4px;margin-top:2px}
/* 提示词：折叠 + 悬浮预览 */
.promptBox{display:flex;flex-direction:column;gap:4px}
.promptRow{display:flex;align-items:center;gap:6px;font-size:12px}
.promptRow .tag{flex:0 0 auto;border-radius:6px;padding:1px 7px;font-size:11px;background:var(--accent-weak);color:var(--accent)}
.promptRow .tag.neg{background:rgba(192,57,43,.12);color:var(--err)}
.promptRow .brief{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);cursor:help}
.promptRow .arrow{border:0;background:transparent;cursor:pointer;color:var(--muted);padding:0 4px}
.promptFull{white-space:pre-wrap;word-break:break-word;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font-size:12px;max-height:none}
.promptFull[hidden]{display:none}
.exportBar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:10px 0 14px}
.searchbar{display:flex;flex-direction:column;gap:6px;margin:10px 0 4px}
.searchbar .srow{display:flex;gap:8px;flex-wrap:wrap}
.searchbar input[type=text]{flex:1;min-width:220px;padding:5px 9px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text);font:inherit}
.searchbar select{padding:5px 8px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text)}
.pick{display:flex;align-items:center;justify-content:center;flex:0 0 auto;cursor:pointer}
.mediacard .pick{margin-right:2px}
.run .head .pick{margin-right:4px}
button.mini.danger{border-color:var(--err);color:var(--err)}
button.mini.danger:hover{background:rgba(192,57,43,.12)}
.picked{outline:2px solid var(--accent);outline-offset:-2px;border-radius:8px}
/* 同组多张：扑克牌摊开（重叠扇开，悬浮抬起看全） */
.fan{display:flex;align-items:flex-start;padding:16px 78px 14px 8px;overflow-x:auto;overflow-y:hidden}
.fan .mediacard{width:230px;flex:0 0 auto;margin-left:-132px;transform:rotate(-5deg);transform-origin:bottom center;transition:transform .18s ease,box-shadow .18s ease;box-shadow:0 2px 6px rgba(0,0,0,.14);background:var(--surface)}
.fan .mediacard:first-child{margin-left:0}
.fan .mediacard:nth-child(2n){transform:rotate(4deg)}
.fan .mediacard:nth-child(3n){transform:rotate(-1deg) translateY(4px)}
.fan .mediacard:hover,.fan .mediacard.picked{transform:rotate(0) translateY(-12px) scale(1.03);z-index:9;position:relative;box-shadow:0 10px 22px rgba(0,0,0,.22)}
.fan .mediacard .thumb{flex:0 0 88px;width:88px;height:88px}
.fan .mediacard .meta{gap:4px}
.fan .mediacard .ops{display:none}
.fan .mediacard:hover .ops{display:flex}
`

/** 提示词区块：正/负分列、可折叠展开全文、支持快捷赋值到工作流表单。 */
function promptBlock(run, token) {
  const prompts = run.prompts ?? null
  const positive = prompts?.positive ?? run.prompt ?? ''
  const negative = prompts?.negative ?? ''
  if (positive.length === 0 && negative.length === 0) return ''
  const row = (kind, label, text, field) => {
    if (text.length === 0) return ''
    const id = `p-${run.id ?? 'run'}-${kind}`
    const brief = text.replaceAll(/\s+/g, ' ').slice(0, 90)
    const assign = field
      ? `<button type="button" class="mini" data-assign-field="${escapeHtml(field)}" data-assign-kind="${kind}" data-workflow="${escapeHtml(run.name ?? '')}" title="把这段提示词回填到工作流表单对应字段">⇢ 赋值</button>`
      : ''
    return `<div class="promptRow"><span class="tag ${kind === 'negative' ? 'neg' : ''}">${label}</span>
<span class="brief" title="${escapeHtml(text)}">${escapeHtml(brief)}</span>
<button type="button" class="arrow" data-prompt-toggle="${id}" title="展开/收起全文">▾</button>${assign}</div>
<div class="promptFull hidden" id="${id}">${escapeHtml(text)}</div>`
  }
  return `<div class="promptBox">${row('positive', '正', positive, prompts?.positiveField ?? '')}${row('negative', '负', negative, prompts?.negativeField ?? '')}</div>`
}

/** 成果物列表 HTML（首次渲染与检索结果复用同一份）。 */
export function artifactsRunsHtml({ runs = [], tags = {}, token = '' }) {
  const tagOf = (key) => tags[key] ?? null
  // 无模态数据不入库：丢弃没有任何产物的运行记录
  const withMedia = runs.filter((run) => Array.isArray(run.localFiles) && run.localFiles.length > 0)
  const runCards = withMedia
    .map((run) => {
      const cards = (run.localFiles ?? [])
        .map((file) => {
          const key = file.key ?? file.path ?? file.filename
          const meta = tagOf(key)
          const chips = [
            ...(meta?.tags ?? []).map((tag) => `<span class="chip">${escapeHtml(tag)}</span>`),
            ...(meta?.collections ?? []).map((collection) => `<span class="chip" title="标签集合">🗃 ${escapeHtml(collection)}</span>`),
          ].join('')
          const fields = Object.entries(meta?.fields ?? {})
            .map(([name, value]) => `<span class="chip" title="动态字段">${escapeHtml(name)}=${escapeHtml(value)}</span>`)
            .join('')
          const bind = meta?.prompt || meta?.source
            ? `<div class="muted">${meta?.prompt ? `绑定提示词：${escapeHtml(meta.prompt)}<br>` : ''}${meta?.source ? `来源：${escapeHtml(meta.source)}` : ''}</div>`
            : ''
          const src = `/artifact?path=${encodeURIComponent(file.path ?? '')}&token=${encodeURIComponent(token)}`
          const name = escapeHtml(file.filename ?? key)
          const kindLabel = file.kind === 'image' ? '图片' : file.kind === 'video' ? '视频' : file.kind === 'audio' ? '音频' : '文件'
          const big = file.kind === 'image' ? '' : file.kind === 'video' ? '▶' : file.kind === 'audio' ? '♪' : '📄'
          const thumb = file.kind === 'image'
            ? `<img src="${src}" alt="${name}" loading="lazy">`
            : `<span class="big">${big}</span>`
          const sizeText = file.bytes ? `${Math.round(file.bytes / 1024)} KB` : ''
          return `<div class="mediacard">
<label class="pick" title="勾选后可批量删除"><input type="checkbox" class="rowpick" data-run="${escapeHtml(run.id ?? '')}" data-path="${escapeHtml(file.path ?? '')}"></label>
<div class="thumb" data-preview="${escapeHtml(file.path ?? '')}" data-kind="${escapeHtml(file.kind ?? 'file')}" data-name="${name}" title="点击预览（图片可滚轮缩放）">${thumb}<span class="badge">${kindLabel}${sizeText ? ` · ${sizeText}` : ''}</span></div>
<div class="meta"><span class="fname" title="${name}">${name}</span>${chips}${fields}${bind}
<div class="ops">
<button type="button" class="mini" data-key="${escapeHtml(key)}" data-op="tag-add">＋标签</button>
<button type="button" class="mini" data-key="${escapeHtml(key)}" data-op="tag-edit">标签集合</button>
<button type="button" class="mini" data-key="${escapeHtml(key)}" data-op="collection">🗃 集合</button>
<button type="button" class="mini" data-key="${escapeHtml(key)}" data-op="field">字段</button>
<button type="button" class="mini" data-key="${escapeHtml(key)}" data-op="prompt">绑定提示词</button>
<button type="button" class="mini" data-key="${escapeHtml(key)}" data-op="source">来源</button>
<a class="mini" style="padding:2px 8px" href="${src}" download>下载</a>
<button type="button" class="mini" data-export-run="${escapeHtml(run.id ?? '')}" title="导出该次运行（字段 + 文件 base64）">⇩ 导出 JSON</button>
<button type="button" class="mini danger" data-remove-file="${escapeHtml(file.path ?? '')}" data-remove-run="${escapeHtml(run.id ?? '')}" title="删除该成果物（含磁盘文件）">✕ 删除</button>
</div></div></div>`
        })
        .join('\n')
      const duration = typeof run.durationMs === 'number'
        ? (run.durationMs < 60000 ? `${Math.round(run.durationMs / 1000)}s` : `${Math.round(run.durationMs / 60000)}m`)
        : (run.finishedAt && run.startedAt ? `${Math.round((run.finishedAt - run.startedAt) / 1000)}s` : '-')
      const time = run.startedAt ? new Date(run.startedAt).toLocaleString('zh-CN') : ''
      const hits = Array.isArray(run.hits) && run.hits.length > 0
        ? `<span class="muted">命中：${escapeHtml(run.hits.slice(0, 4).join(' / '))}</span>`
        : ''
      const files = Array.isArray(run.localFiles) ? run.localFiles : []
      const fanned = files.length >= 4 // 同组多张 → 扑克牌摊开（重叠）样式
      return `<section class="run"><div class="head">
<label class="pick" title="勾选整组"><input type="checkbox" class="runpick" data-run="${escapeHtml(run.id ?? '')}"></label>
<b>${escapeHtml(run.name ?? 'workflow')}</b>
<span class="chip">${escapeHtml(run.state ?? '')}</span>
<span class="muted">种子 ${escapeHtml(String(run.seed ?? '-'))} · 用时 ${escapeHtml(duration)}${time ? ` · ${escapeHtml(time)}` : ''} · ${files.length} 件${fanned ? ' · 重叠展示' : ''}</span>
${hits}
</div>
${promptBlock(run, token)}
<div class="${fanned ? 'fan' : 'mediaList'}">${cards}</div></section>`
    })
    .join('\n')
  const excluded = runs.length - withMedia.length
  const summary = `${withMedia.length} 次有产物的运行${excluded > 0 ? ` · 已忽略 ${excluded} 次无成果物记录` : ''}`
  return { html: runCards, summary, shown: withMedia.length, total: runs.length }
}

/**
 * 渲染成果物页：只登记「有模态数据」的运行（无产物不入库），
 * 一列卡片展示；支持检索（模糊/标签/参数/动态字段，与或）、勾选批量删除、
 * 图片放大与缩放、视频音频播放、单次或整体导出 JSON（base64）。
 */
export function renderArtifactsHtml({ runs = [], tags = {}, token = '' }) {
  const { html: runCards, summary, shown } = artifactsRunsHtml({ runs, tags, token })
  const body = `
<h1>ComfyUI 工作台</h1>
${workbenchTabs('artifacts', token)}
<div class="sub" id="runs-summary">${summary}</div>
<form id="search-form" onsubmit="return false" class="searchbar">
<div class="srow">
<input type="text" id="q" placeholder='复合检索：fashion | tag:夕阳 param:steps&gt;=25 -tag:废片 prompt:"sunset beach" file:.png'>
<button type="submit" class="primary" id="q-run">检索</button>
<button type="button" class="mini" id="q-reset">重置</button>
<button type="button" class="mini" id="q-help-toggle" title="查看复合检索语法">? 语法</button>
</div>
<div class="qhelp" id="q-help" hidden>
<div class="muted" style="margin-bottom:6px">复合检索语法：空格＝<b>与</b>，<b>|</b>＝<b>或</b>，前缀 <b>-</b>＝<b>排除</b>；值默认「包含」匹配，可用 <code>= != ~ &gt; &gt;= &lt; &lt;=</code></div>
<table class="qtable">
<tr><td><code>fashion</code></td><td>模糊匹配：正/负提示词、文件名、标签/集合、动态字段名值、参数名值</td></tr>
<tr><td><code>a | b</code></td><td>含 a <b>或</b> 含 b（<code>|</code> 分组，组内仍是与）</td></tr>
<tr><td><code>tag:夕阳 tag:旅拍</code></td><td>同时带「夕阳」与「旅拍」标签/集合</td></tr>
<tr><td><code>param:steps&gt;=25</code>、<code>param:sampler_name=euler</code></td><td>运行参数比较</td></tr>
<tr><td><code>field:尺寸=768</code></td><td>动态字段（标签库里登记的自定义字段）</td></tr>
<tr><td><code>prompt:"sunset beach"</code></td><td>只在提示词里找（含空格的值用引号）</td></tr>
<tr><td><code>file:.png</code>、<code>name:image_z</code>、<code>state:completed</code>、<code>seed:123</code>、<code>kind:image</code></td><td>文件名 / 工作流名 / 状态 / 种子 / 类型</td></tr>
<tr><td><code>-tag:废片</code></td><td>排除：不带该标签</td></tr>
</table>
<div class="muted" style="margin-top:6px">点示例直接填入：
<button type="button" class="mini" data-example="fashion | night">fashion | night</button>
<button type="button" class="mini" data-example="tag:夕阳 param:steps>=25">tag:夕阳 param:steps&gt;=25</button>
<button type="button" class="mini" data-example="prompt:sunset -tag:废片">prompt:sunset -tag:废片</button>
<button type="button" class="mini" data-example="file:.png state:completed">file:.png state:completed</button>
</div>
</div>
</form>
<div class="exportBar">
<span class="muted">卡片样式</span>
<button type="button" class="mini" data-style="masonry">瀑布流</button>
<button type="button" class="mini" data-style="grid2">两列平铺</button>
<button type="button" class="mini" data-style="fan">重叠摊开</button>
<span class="sep"></span>
<button type="button" class="mini" id="pick-all">全选</button>
<button type="button" class="mini" id="pick-none">全不选</button>
<button type="button" class="mini danger" id="remove-picked">🗑 删除选中（含磁盘文件）</button>
<span class="muted" id="pick-count">已选 0 件</span>
<button type="button" class="mini" id="export-all" title="导出当前列表全部运行的字段与文件（base64 内嵌）">⇩ 导出全部（JSON / base64）</button>
</div>
<div id="runs" class="style-masonry" data-style="masonry">${runCards || '<div class="card">还没有带成果物的运行。先在聊天里或工作流页执行一次工作流。</div>'}</div>
<div class="modal" id="preview" hidden><div class="box">
<div class="bar2"><span id="preview-name"></span><span class="tools">
<button type="button" class="mini" data-zoom="out">−</button><span id="zoom-label" class="muted">100%</span>
<button type="button" class="mini" data-zoom="in">＋</button>
<button type="button" class="mini" data-zoom="reset">重置</button>
<button type="button" class="mini" id="preview-close">关闭 ✕</button></span></div>
<div id="preview-body"></div>
<div class="zoomHint" id="zoom-hint">滚轮缩放 · 拖拽平移 · 双击切换 100%/200% · 快捷键 +/−/0 · Esc 关闭</div></div></div>
<script>
var TOKEN = ${JSON.stringify(token)};
window.__records = ${JSON.stringify(tags)};
window.__runIds = ${JSON.stringify(runs.filter((run) => Array.isArray(run.localFiles) && run.localFiles.length > 0).map((run) => run.id ?? null).filter(Boolean))};
bindPreviewEvents('preview');
refreshPickCount();
// 恢复上次选择的卡片样式（瀑布流 / 两列平铺 / 重叠摊开）
try { applyStyle(window.localStorage.getItem('comfymcp.artifactStyle') || 'masonry'); } catch (e) { applyStyle('masonry'); }
${ARTIFACTS_JS}
</script>`
  return pageShell('成果物', body, { extraCss: `${ARTIFACTS_CSS}${PREVIEW_CSS}${TABS_CSS}` })
}

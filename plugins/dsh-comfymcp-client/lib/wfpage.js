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
export function buildPageDescriptor({ name, title, graph, nodeInfos = {}, notes = [] }) {
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
      const field = fieldFor(nodeId, input, value !== undefined ? value : input.default)
      if (field !== null) fields.push(field)
    }
    // 声明缺失（node_info 不可用）时回退：渲染图里已有的非链接标量
    if (declared.length === 0) {
      for (const [fieldName, value] of Object.entries(values)) {
        if (value !== null && typeof value === 'object') continue
        if (Array.isArray(value) && value.length >= 2) continue
        const upper = typeof value === 'number' ? (Number.isInteger(value) ? 'INT' : 'FLOAT') : typeof value === 'boolean' ? 'BOOLEAN' : 'STRING'
        const field = fieldFor(nodeId, { name: fieldName, type: upper, required: false }, value)
        if (field !== null) fields.push(field)
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
          return `<div class="row"><label for="${fieldId}">${escapeHtml(field.label)}</label>${control}</div>`
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
<a href="/ui?token=${encodeURIComponent(token)}">← 全部页面</a></div>
${noteBar}
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
  <div class="head"><b>成果物 <span id="results-count">0</span></b><button type="button" class="mini" id="clear-btn">清空展示</button></div>
  <div class="tiles" id="tiles"></div>
  <div class="files" id="files"></div>
</div>
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
  return pageShell(descriptor.title, body)
}

const PAGE_RUN_JS = `
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
function renderFiles(files) {
  var tiles = document.getElementById('tiles');
  var list = document.getElementById('files');
  tiles.innerHTML = ''; list.innerHTML = '';
  var items = files || [];
  document.getElementById('results-count').textContent = String(items.length);
  items.forEach(function (file) {
    if (file.kind === 'image') {
      var a = document.createElement('a');
      a.href = artifactUrl(file); a.target = '_blank'; a.rel = 'noreferrer';
      var img = document.createElement('img');
      img.src = artifactUrl(file); img.alt = file.filename || ''; img.title = file.filename || '';
      a.appendChild(img); tiles.appendChild(a);
    } else {
      var row = document.createElement('div');
      row.className = 'file';
      var link = document.createElement('a');
      link.href = artifactUrl(file); link.target = '_blank'; link.rel = 'noreferrer';
      link.textContent = (file.kind === 'video' ? '▶ ' : '📄 ') + (file.filename || file.path || '');
      row.appendChild(link);
      if (file.bytes) { var meta = document.createElement('span'); meta.className = 'muted'; meta.textContent = ' ' + Math.round(file.bytes / 1024) + ' KB'; row.appendChild(meta); }
      list.appendChild(row);
    }
  });
  document.getElementById('results').hidden = items.length === 0;
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
    renderFiles(files);
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
  renderFiles([]);       // 新一轮开始：先清掉上一轮成果，避免误读为新结果
  showProgress(null);
  state('⏳ 正在提交…', false);
  makeCall().then(function (started) {
    state('⏳ 已提交（' + (started && started.runId ? String(started.runId).slice(0, 8) : '') + '），正在执行…', false);
    poll();
  }).catch(function (error) { state('✗ ' + error.message, true); busy(false); });
}
document.addEventListener('click', function (event) {
  var t = event.target;
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
    api('/api/runs/clear', { workflow: WORKFLOW }).then(function () { renderFiles([]); state('已清空展示（产物文件仍可在成果物页查看）', false); })
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
// 页面加载即恢复：执行中的进度，或上次完成的成果物（刷新不丢）
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

/** 渲染索引页：分「我的工作流 / 模板库」两个 Tab，组内按名称去重；远端条目可手动拉取。 */
export function renderIndexHtml({ mine = [], library = [], token = '' }) {
  const enc = encodeURIComponent(token)
  const pageLink = (page, extra = '') => `<a class="card" style="display:block" href="/ui/wf/${encodeURIComponent(page.name)}?token=${enc}">
<b>${escapeHtml(page.title ?? page.name)}</b>${extra}
<div class="muted">${page.updatedAt ? `更新 ${escapeHtml(page.updatedAt)}` : ''}${page.origin === 'remote' ? ' · 在服务端，可拉取到本地' : ''}</div></a>`
  const pullButton = (page) => `<div class="card"><b>${escapeHtml(page.title ?? page.name)}</b> <button type="button" class="mini" data-pull="${escapeHtml(page.name)}">⬇ 拉取</button>
<div class="muted">${page.updatedAt ? `更新 ${escapeHtml(page.updatedAt)}` : ''}</div></div>`
  const mineItems = mine.map((page) => (page.origin === 'remote' ? pullButton(page) : pageLink(page))).join('\n')
  const libraryItems = library.map((page) => pageLink(page)).join('\n')
  const body = `
<h1>ComfyUI 工作台</h1>
<div class="sub">工作流静态页 · 由 dsh-comfymcp-client 生成 · <a href="/ui/artifacts?token=${enc}">成果物 →</a> ·
<button type="button" class="mini" onclick="location.reload()">↻ 重新加载</button></div>
<div class="tabs">
<button type="button" class="tab active" data-tab="mine">我的工作流（${mine.length}）</button>
<button type="button" class="tab" data-tab="library">模板库（${library.length}）</button>
</div>
<div data-group="mine">${mineItems || '<div class="card">还没有我的工作流：在聊天里让 AI 生成并保存，或在「模板库」里拉取一份到本地。</div>'}</div>
<div data-group="library" style="display:none">${libraryItems || '<div class="card">模板库暂不可达（服务端未连接或目录为空）。</div>'}</div>
`
  return pageShell('ComfyUI 工作台', body, { extraScript: `var TOKEN = ${JSON.stringify(token)};\n${PAGE_INDEX_JS}`, extraCss: INDEX_CSS })
}

const ARTIFACTS_JS = `
var API_CFG = ${JSON.stringify({ token: '' })}; API_CFG.token = TOKEN;
function api(path, body) {
  return fetch(path, { method: body === undefined ? 'GET' : 'POST',
    headers: Object.assign({'x-dsh-comfymcp':'1','content-type':'application/json'}, API_CFG.token ? {'x-dsh-comfymcp-token': API_CFG.token} : {}),
    body: body === undefined ? undefined : JSON.stringify(body) })
    .then(function (res) { return res.json().then(function (data) { if (!res.ok || data.ok === false) throw new Error((data.error && data.error.message) || ('HTTP ' + res.status)); return data.value !== undefined ? data.value : data }); });
}
function ask(label, current) { var v = prompt(label, current || ''); return v === null ? null : v.trim(); }
function mediaUrl(path) { return '/artifact?path=' + encodeURIComponent(path) + (TOKEN ? '&token=' + encodeURIComponent(TOKEN) : ''); }
function closePreview() {
  var modal = document.getElementById('preview');
  var body = document.getElementById('preview-body');
  body.innerHTML = ''; // 停止播放
  modal.hidden = true;
}
document.addEventListener('click', function (event) {
  var el = event.target;
  if (el.id === 'preview-close' || el.id === 'preview') { closePreview(); return; }
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
  var previewPath = el.getAttribute('data-preview') || (el.parentElement && el.parentElement.getAttribute && el.parentElement.getAttribute('data-preview'));
  if (previewPath) {
    var holder = el.getAttribute('data-preview') ? el : el.parentElement;
    var kind = holder.getAttribute('data-kind') || 'file';
    var name = holder.getAttribute('data-name') || '';
    var url = mediaUrl(previewPath);
    document.getElementById('preview-name').textContent = name;
    var body = document.getElementById('preview-body');
    if (kind === 'video') body.innerHTML = '<video src="' + url + '" controls autoplay playsinline></video>';
    else if (kind === 'audio') body.innerHTML = '<audio src="' + url + '" controls autoplay></audio>';
    else if (kind === 'image') body.innerHTML = '<img src="' + url + '" alt="">';
    else body.innerHTML = '<div class="muted">该类型不支持内嵌预览，请使用下载。</div>';
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
/* 一列卡片：每个文件占满一行，缩略图在左、信息在右 */
.mediaList{display:flex;flex-direction:column;gap:10px}
.mediacard{background:var(--surface);border:1px solid var(--line);border-radius:10px;display:flex;gap:12px;padding:10px;align-items:flex-start}
.mediacard .thumb{position:relative;flex:0 0 132px;width:132px;height:132px;background:var(--accent-weak);border-radius:8px;display:flex;align-items:center;justify-content:center;cursor:zoom-in;overflow:hidden}
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

/**
 * 渲染成果物页：只登记「有模态数据」的运行（无产物不入库），
 * 一列卡片展示；图片放大 / 视频音频就地播放；支持单个或整体导出 JSON（base64）。
 */
export function renderArtifactsHtml({ runs = [], tags = {}, token = '' }) {
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
<div class="thumb" data-preview="${escapeHtml(file.path ?? '')}" data-kind="${escapeHtml(file.kind ?? 'file')}" data-name="${name}" title="点击预览">${thumb}<span class="badge">${kindLabel}${sizeText ? ` · ${sizeText}` : ''}</span></div>
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
</div></div></div>`
        })
        .join('\n')
      const duration = typeof run.durationMs === 'number'
        ? (run.durationMs < 60000 ? `${Math.round(run.durationMs / 1000)}s` : `${Math.round(run.durationMs / 60000)}m`)
        : (run.finishedAt && run.startedAt ? `${Math.round((run.finishedAt - run.startedAt) / 1000)}s` : '-')
      const time = run.startedAt ? new Date(run.startedAt).toLocaleString('zh-CN') : ''
      return `<section class="run"><div class="head">
<b>${escapeHtml(run.name ?? 'workflow')}</b>
<span class="chip">${escapeHtml(run.state ?? '')}</span>
<span class="muted">种子 ${escapeHtml(String(run.seed ?? '-'))} · 用时 ${escapeHtml(duration)}${time ? ` · ${escapeHtml(time)}` : ''} · ${(run.localFiles ?? []).length} 件</span>
</div>
${promptBlock(run, token)}
<div class="mediaList">${cards}</div></section>`
    })
    .join('\n')
  const excluded = runs.length - withMedia.length
  const body = `
<h1>成果物</h1>
<div class="sub">${withMedia.length} 次有产物的运行${excluded > 0 ? ` · 已忽略 ${excluded} 次无成果物记录` : ''} · <a href="/ui?token=${encodeURIComponent(token)}">← 工作台</a></div>
<div class="exportBar">
<button type="button" class="mini" id="export-all" title="导出当前页全部运行的字段与文件（base64 内嵌）">⇩ 导出全部（JSON / base64）</button>
<span class="muted">导出内容：当前已有字段（运行信息、提示词正负、标签/集合/动态字段、文件字节 base64）</span>
</div>
${runCards || '<div class="card">还没有带成果物的运行。先在聊天里或工作流页执行一次工作流。</div>'}
<div class="modal" id="preview" hidden><div class="box">
<div class="bar2"><span id="preview-name"></span><button type="button" class="mini" id="preview-close">关闭 ✕</button></div>
<div id="preview-body"></div></div></div>
<script>
var TOKEN = ${JSON.stringify(token)};
window.__records = ${JSON.stringify(tags)};
window.__runIds = ${JSON.stringify(withMedia.map((run) => run.id ?? null).filter(Boolean))};
${ARTIFACTS_JS}
</script>`
  return pageShell('成果物', body, { extraCss: ARTIFACTS_CSS })
}

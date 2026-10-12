/**
 * 工作流 → 静态网页协议（v1）。
 *
 * 页面描述符（descriptor）是协议载体：把工作流图按节点编排为分组控件，
 * 渲染器（renderPageHtml）对描述符做确定性输出——同描述符必得同页面。
 * 页面内的「执行 / 快捷指令」按钮调用控制端点 /api/run、/api/quick，
 * 由宿主半区复用与模型工具完全相同的运行核心（runcore）执行。
 */
import { DEFAULT_QUICK_COMMANDS } from './quick.js'

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
  if (Array.isArray(rawType)) {
    return { field: name, label: name, type: 'choice', options: rawType.map((entry) => String(entry)), value: String(value ?? ''), required: input.required === true }
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
export function buildPageDescriptor({ name, title, graph, nodeInfos = {} }) {
  const sections = []
  for (const [nodeId, nodeRaw] of Object.entries(graph ?? {})) {
    const node = nodeRaw !== null && typeof nodeRaw === 'object' ? nodeRaw : {}
    const classType = String(node.class_type ?? 'Unknown')
    const values = node.inputs !== null && typeof node.inputs === 'object' ? node.inputs : {}
    const info = nodeInfos[classType] ?? nodeInfos[String(node.class_type ?? '')] ?? null
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
`

function pageShell(title, body, extraScript = '') {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${PAGE_CSS}</style></head>
<body><div class="wrap">${body}</div>
<script>${extraScript}</script></body></html>
`
}

function fieldControlHtml(field, fieldId, dataKey) {
  const type = field.type
  if (type === 'boolean') {
    return `<input type="checkbox" id="${fieldId}" data-field="${escapeHtml(dataKey)}" ${field.value === true ? 'checked' : ''}>`
  }
  if (type === 'choice') {
    const options = (field.options ?? []).map((option) => `<option value="${escapeHtml(option)}" ${String(field.value) === option ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('')
    return `<select id="${fieldId}" data-field="${escapeHtml(dataKey)}">${options}</select>`
  }
  if (type === 'text') {
    return `<textarea id="${fieldId}" data-field="${escapeHtml(dataKey)}">${escapeHtml(field.value)}</textarea>`
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
  const body = `
<div class="top"><div><h1>${escapeHtml(descriptor.title)}</h1>
<div class="sub">工作流 ${escapeHtml(descriptor.workflow)} · ${descriptor.nodeCount} 节点 · ${sections.length} 组参数 · 生成于 ${escapeHtml(descriptor.generatedAt)}</div></div>
<a href="/ui?token=${encodeURIComponent(token)}">← 全部页面</a></div>
${quickBar}
<form id="run-form">
${sections || '<div class="card">该工作流没有可编辑参数（全部为链接字段）。</div>'}
<button type="submit" class="primary" id="run-btn">▶ 执行工作流</button>
</form>
<div class="state" id="state"></div>
<div class="tiles" id="tiles"></div>
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
function state(text, isError) {
  var el = document.getElementById('state');
  el.style.display = 'block';
  el.style.background = isError ? 'rgba(192,57,43,.12)' : '';
  el.style.color = isError ? 'var(--err)' : '';
  el.textContent = text;
}
function collectValues() {
  var values = {};
  document.querySelectorAll('[data-field]').forEach(function (el) {
    values[el.getAttribute('data-field')] = el.type === 'checkbox' ? el.checked : (el.type === 'number' ? (el.value === '' ? null : Number(el.value)) : el.value);
  });
  return values;
}
document.addEventListener('click', function (event) {
  var t = event.target;
  if (t.getAttribute && t.getAttribute('data-dice')) {
    var input = document.getElementById(t.getAttribute('data-dice'));
    input.value = String(Math.floor(1 + Math.random() * 4294967294));
  }
  var quick = t.getAttribute && t.getAttribute('data-quick');
  if (quick) { run(function () { return api('/api/quick', { workflow: WORKFLOW, command: quick }); }); }
});
function run(makeCall) {
  var btn = document.getElementById('run-btn');
  btn.disabled = true; state('已提交，正在执行工作流（含排队与等待）…');
  makeCall().then(function (result) {
    var files = result.localFiles || [];
    var tiles = document.getElementById('tiles'); tiles.innerHTML = '';
    files.forEach(function (file) {
      if (file.kind !== 'image') return;
      var img = document.createElement('img');
      img.src = '/artifact?path=' + encodeURIComponent(file.path) + (API_CFG.token ? '&token=' + encodeURIComponent(API_CFG.token) : '');
      img.alt = file.filename || ''; img.title = (file.filename || '') + ' · 种子 ' + (result.seed ?? '');
      tiles.appendChild(img);
    });
    state('✓ 完成（种子 ' + (result.seed ?? '-') + '，' + files.length + ' 个成果物）', false);
  }).catch(function (error) { state('✗ ' + error.message, true); }).finally(function () { btn.disabled = false; });
}
document.getElementById('run-form').addEventListener('submit', function (event) {
  event.preventDefault();
  run(function () { return api('/api/run', { workflow: WORKFLOW, values: collectValues(), name: WORKFLOW + '-' + Date.now() }); });
});
`

/** 渲染索引页（一个工作流一个页面入口）。 */
export function renderIndexHtml({ pages = [], token = '' }) {
  const items = pages
    .map((page) => `<a class="card" style="display:block" href="/ui/wf/${encodeURIComponent(page.name)}?token=${encodeURIComponent(token)}">
<b>${escapeHtml(page.title ?? page.name)}</b>
<div class="muted">${page.nodeCount ?? '?'} 节点 · 更新 ${escapeHtml(page.updatedAt ?? '')}</div></a>`)
    .join('\n')
  const body = `
<h1>ComfyUI 工作台</h1>
<div class="sub">工作流静态页 · 由 dsh-comfymcp-client 生成 · <a href="/ui/artifacts?token=${encodeURIComponent(token)}">成果物 →</a></div>
${items || '<div class="card">工作流目录还没有可编排的工作流（.json）。在聊天里让 AI 生成一个，或把 API 格式工作流文件放进主目录 workflows/。</div>'}
`
  return pageShell('ComfyUI 工作台', body)
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
document.addEventListener('click', function (event) {
  var el = event.target; if (!el.getAttribute) return;
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

/** 渲染成果物页（runs + 文件 + 标签操作）。 */
export function renderArtifactsHtml({ runs = [], tags = {}, token = '' }) {
  const tagOf = (key) => tags[key] ?? null
  const runCards = runs
    .map((run) => {
      const files = (run.localFiles ?? [])
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
            ? `<div class="muted" style="width:100%">${meta?.prompt ? `提示词：${escapeHtml(meta.prompt)}<br>` : ''}${meta?.source ? `来源：${escapeHtml(meta.source)}` : ''}</div>`
            : ''
          const src = `/artifact?path=${encodeURIComponent(file.path ?? '')}&token=${encodeURIComponent(token)}`
          const preview = file.kind === 'image'
            ? `<a href="${src}" target="_blank" rel="noreferrer"><img src="${src}" alt="${escapeHtml(file.filename ?? '')}" style="width:72px;border-radius:6px;border:1px solid var(--line);display:block"></a>`
            : `<span>${file.kind === 'video' ? '▶' : '📄'}</span>`
          return `<div class="file">${preview}<span class="name">${escapeHtml(file.filename ?? key)}</span>
<span class="muted">${escapeHtml(String(file.bytes ?? ''))}B</span>
${chips}${fields}${bind}
<button type="button" class="mini" data-key="${escapeHtml(key)}" data-op="tag-add">＋标签</button>
<button type="button" class="mini" data-key="${escapeHtml(key)}" data-op="tag-edit">标签集合</button>
<button type="button" class="mini" data-key="${escapeHtml(key)}" data-op="collection">🗃 集合</button>
<button type="button" class="mini" data-key="${escapeHtml(key)}" data-op="field">字段</button>
<button type="button" class="mini" data-key="${escapeHtml(key)}" data-op="prompt">提示词</button>
<button type="button" class="mini" data-key="${escapeHtml(key)}" data-op="source">来源</button></div>`
        })
        .join('\n')
      return `<div class="card"><h3>${escapeHtml(run.name ?? 'workflow')} · ${escapeHtml(run.state ?? '')} · 种子 ${escapeHtml(String(run.seed ?? '-'))}</h3>
<div class="muted" style="margin-bottom:6px">${escapeHtml(run.prompt ?? '')}</div>${files || '<div class="muted">（无成果物）</div>'}</div>`
    })
    .join('\n')
  const body = `
<h1>成果物</h1>
<div class="sub">最近 ${runs.length} 次运行 · <a href="/ui?token=${encodeURIComponent(token)}">← 工作台</a></div>
${runCards || '<div class="card">还没有运行记录。先在聊天里或工作流页执行一次工作流。</div>'}
<script>
var TOKEN = ${JSON.stringify(token)};
window.__records = ${JSON.stringify(tags)};
${ARTIFACTS_JS}
</script>`
  return pageShell('成果物', body)
}

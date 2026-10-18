/**
 * 创作页（/ui/create）：多模态服务商管理 + 文生图/图生图创作 + 结果画廊 + 创作历史。
 *
 * 数据流：
 * - 服务端首屏渲染服务商卡片与最近创作历史（无 JS 也有内容）；
 * - JS 负责增删改查（/api/providers*）、生成（/api/create + 轮询 /api/create/job）、
 *   结果画廊与历史刷新；灯箱复用 pagekit 的 PREVIEW_JS。
 */
import { escapeHtml, lightboxMarkup, pageShell, PREVIEW_CSS, TABS_CSS, workbenchTabs } from './pagekit.js'
import { PROVIDER_KINDS, PROVIDER_KIND_LABELS, PROVIDER_PRESETS } from './providers/index.js'

const CREATE_CSS = `
.pcard{display:flex;flex-direction:column;gap:6px;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin-bottom:8px}
.pcard .phead{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.pcard .phead b{font-size:13px}
.pcard .pops{display:flex;flex-wrap:wrap;gap:6px}
.pcard .dot{width:8px;height:8px;border-radius:50%;background:#bbb;display:inline-block}
.pcard .dot.ok{background:#2e9d5b}.pcard .dot.off{background:#c0392b}
.pedit{background:var(--bg);border:1px dashed var(--line);border-radius:10px;padding:10px 12px;margin:10px 0}
.pedit .row label{min-width:110px}
.pedit .hint{color:var(--muted);font-size:12px;margin:2px 0 8px}
.radio{display:inline-flex;align-items:center;gap:4px;min-width:auto!important;color:var(--text)!important}
.adv summary{cursor:pointer;color:var(--accent);font-size:12px;margin:4px 0 8px}
.tiles .tile{position:relative;display:flex;flex-direction:column;gap:4px;width:190px}
.tiles .tile img{width:190px;height:150px;object-fit:cover;border-radius:8px;border:1px solid var(--line);cursor:zoom-in;background:var(--accent-weak)}
.tiles .tile .tops{display:flex;gap:4px;flex-wrap:wrap}
.chistory .ch{display:flex;gap:10px;align-items:center;border-top:1px solid var(--line);padding:8px 0}
.chistory .ch:first-child{border-top:0}
.chistory .ch .thumb{width:56px;height:56px;border-radius:6px;object-fit:cover;border:1px solid var(--line);background:var(--accent-weak);cursor:zoom-in;flex:0 0 auto}
.chistory .ch .info{flex:1;min-width:200px;font-size:12px;color:var(--muted)}
.chistory .ch .info b{color:var(--text);font-size:13px}
.chistory .ch .ops{display:flex;gap:6px;flex-wrap:wrap}
.chip.ok{background:rgba(46,157,91,.12);color:#2e9d5b}.chip.bad{background:rgba(192,57,43,.12);color:#c0392b}
.select-inline{display:inline-block;min-width:auto;flex:0 1 auto;max-width:280px}
@media (max-width:700px){.tiles .tile,.tiles .tile img{width:46vw}}
`

/** 单个服务商卡片 HTML。 */
function providerCard(provider) {
  const id = escapeHtml(provider.id)
  const dot = provider.enabled === false ? 'off' : 'ok'
  return `<div class="pcard" data-pid="${id}">
<div class="phead"><span class="dot ${dot}"></span><b>${escapeHtml(provider.label ?? provider.id)}</b><span class="chip">${escapeHtml(provider.kindLabel ?? PROVIDER_KIND_LABELS[provider.kind] ?? provider.kind)}</span>${provider.id === provider.defaultId ? '<span class="chip">默认</span>' : ''}</div>
<div class="muted">${escapeHtml(provider.baseUrl)} · 模型 ${escapeHtml(provider.model || '（当前加载）')} · 密钥 ${provider.apiKey ? escapeHtml(provider.apiKey) + (provider.apiKeyIsEnv ? '（环境变量）' : '') : '未配置'}</div>
<div class="pops">
<button type="button" class="mini" data-act="test">测试连接</button>
<button type="button" class="mini" data-act="edit">编辑</button>
<button type="button" class="mini" data-act="toggle">${provider.enabled === false ? '启用' : '停用'}</button>
<button type="button" class="mini" data-act="default">设为默认</button>
<button type="button" class="mini danger" data-act="remove">删除</button>
</div></div>`
}

function providerSelectOptions(providers, selected) {
  return providers.map((provider) => `<option value="${escapeHtml(provider.id)}"${provider.id === selected ? ' selected' : ''}>${escapeHtml(provider.label ?? provider.id)}</option>`).join('')
}

function historyItem(item, index) {
  const thumb = Array.isArray(item.images) && item.images.length > 0 ? String(item.images[0].path ?? '') : ''
  const stateChip = item.status === 'succeeded' ? '<span class="chip ok">成功</span>' : '<span class="chip bad">失败</span>'
  const imageUrl = thumb.length > 0 ? `/artifact?path=${encodeURIComponent(thumb)}` : ''
  return `<div class="ch" data-cid="${escapeHtml(item.id ?? String(index))}">
${thumb.length > 0 ? `<img class="thumb" data-preview="${escapeHtml(imageUrl)}" data-name="${escapeHtml(thumb)}" src="${escapeHtml(imageUrl)}" alt="" loading="lazy">` : '<span class="thumb" style="display:flex;align-items:center;justify-content:center;font-size:16px">✕</span>'}
<div class="info"><b>${escapeHtml(item.providerLabel ?? item.providerId ?? '')}</b> · ${escapeHtml(item.model ?? '')} ${stateChip}
<div>${escapeHtml(String(item.prompt ?? '').slice(0, 100))}</div>
<div>${escapeHtml(String(item.createdAt ?? '').slice(0, 19).replace('T', ' '))} · ${item.elapsedMs !== undefined ? Math.max(1, Math.round(Number(item.elapsedMs) / 1000)) + 's' : ''}${item.error ? ` · ${escapeHtml(String(item.error).slice(0, 120))}` : ''}</div></div>
<div class="ops">
${item.status === 'succeeded' ? '<button type="button" class="mini" data-act="rerun">再来一张</button>' : '<button type="button" class="mini" data-act="rerun">重试</button>'}
<button type="button" class="mini" data-act="delete">删除</button>
</div></div>`
}

/**
 * 渲染创作页。
 * @param {object} options
 * @param {Array} options.providers 服务商（密钥已掩码）
 * @param {Array} options.creations 创作历史（最近 N 条）
 * @param {string} options.defaultId 默认服务商
 * @param {string} options.token 控制端点令牌
 */
export function renderCreateHtml({ providers = [], creations = [], defaultId = '', presets = PROVIDER_PRESETS, kinds = PROVIDER_KINDS, token = '' } = {}) {
  const providerCards = providers.map((provider) => providerCard({ ...provider, defaultId })).join('\n') || '<div class="muted">还没有配置服务商：点右上角「＋ 添加服务商」，或从预设模板一键创建。</div>'
  const historyHtml = creations.map((item, index) => historyItem(item, index)).join('\n') || '<div class="muted">还没有创作记录。</div>'
  const kindOptions = kinds.map((kind) => `<option value="${escapeHtml(kind)}">${escapeHtml(PROVIDER_KIND_LABELS[kind] ?? kind)}</option>`).join('')
  const presetOptions = presets.map((preset) => `<option value="${escapeHtml(preset.id)}">${escapeHtml(preset.label)}</option>`).join('')
  const activeProviders = providers.filter((provider) => provider.enabled !== false)
  const body = `
<div class="pagehead"><h1>ComfyUI 工作台</h1>
${workbenchTabs('create', token)}</div>
<div class="pagebar"><div><b>创作</b> <span class="muted">多模态服务商直连出图（文生图 / 图生图）；复杂节点链请走工作流引擎</span></div>
<span class="pagebar-actions"><span class="muted" id="prov-count">${providers.length} 个服务商</span></span></div>

<div class="card">
<h3>服务商 <button type="button" class="mini" id="add-provider">＋ 添加服务商</button></h3>
<div id="provider-list">${providerCards}</div>
<div class="pedit" id="provider-edit" hidden>
<div class="hint" id="pedit-hint">从预设模板开始，或手动填写；密钥支持 <code>env:环境变量名</code>（推荐，明文仅存本机）。</div>
<div class="row"><label for="pedit-preset">预设模板</label><select id="pedit-preset"><option value="">（手动填写）</option>${presetOptions}</select></div>
<div class="row"><label for="pedit-id">ID</label><input type="text" id="pedit-id" placeholder="ms-qwen-image（小写字母/数字/-/_）"></div>
<div class="row"><label for="pedit-label">显示名</label><input type="text" id="pedit-label" placeholder="魔搭 · Qwen-Image"></div>
<div class="row"><label for="pedit-kind">类型</label><select id="pedit-kind">${kindOptions}</select></div>
<div class="row"><label for="pedit-base">baseUrl</label><input type="text" id="pedit-base" placeholder="https://api-inference.modelscope.cn"></div>
<div class="row"><label for="pedit-model">模型</label><input type="text" id="pedit-model" placeholder="Qwen/Qwen-Image"></div>
<div class="row"><label for="pedit-key">API key</label><input type="text" id="pedit-key" placeholder="env:MODELSCOPE_API_KEY 或直接填写" autocomplete="off"></div>
<div class="row"><label>高级</label><label class="radio"><input type="checkbox" id="pedit-private">允许私网地址（本机 Ollama/vLLM/A1111 需勾选）</label><label class="radio"><input type="checkbox" id="pedit-enabled" checked>启用</label></div>
<div class="row"><label for="pedit-size">默认尺寸</label><input type="text" id="pedit-size" placeholder="1024x1024" class="select-inline"><label for="pedit-np">默认负向</label><input type="text" id="pedit-np" placeholder="低质量, 模糊"></div>
<div class="row"><label for="pedit-legacy">兼容模式</label><label class="radio"><input type="checkbox" id="pedit-legacy">HuggingFace legacy 推理端点（/models/{id} 二进制）</label></div>
<div class="actions"><button type="button" class="primary" id="pedit-save">保存</button><button type="button" id="pedit-cancel">取消</button><span class="muted" id="pedit-state"></span></div>
</div>
</div>

<div class="card">
<h3>生成</h3>
<div class="row"><label for="gen-provider">服务商</label><select id="gen-provider">${providerSelectOptions(activeProviders, defaultId)}</select><span class="muted" id="gen-provider-hint"></span></div>
<div class="row"><label for="gen-model">模型</label><input type="text" id="gen-model" placeholder="留空用服务商默认"><span class="muted">按需覆盖</span></div>
<div class="row"><label>模式</label><label class="radio"><input type="radio" name="gen-mode" value="t2i" checked>文生图</label><label class="radio"><input type="radio" name="gen-mode" value="i2i">图生图</label></div>
<div class="row" id="i2i-row" hidden><label>参考图</label><input type="file" id="gen-file" accept="image/*"><span class="muted">或</span><select id="gen-artifact" class="select-inline"><option value="">从成果物选择…</option></select><img id="i2i-thumb" hidden style="width:56px;height:56px;object-fit:cover;border-radius:6px;border:1px solid var(--line)"></div>
<div class="row"><label for="gen-prompt">提示词</label><textarea id="gen-prompt" placeholder="描述你想要的画面（例如：电影感海报，雨夜霓虹街道，一位撑伞的旅人）"></textarea></div>
<div class="row"><label for="gen-negative">负向提示词</label><input type="text" id="gen-negative" placeholder="可选；留空用服务商默认"></div>
<details class="adv"><summary>高级参数（尺寸 / 步数 / 引导 / 种子 / 数量）</summary>
<div class="row"><label for="gen-size">尺寸</label><input type="text" id="gen-size" placeholder="1024x1024" class="select-inline"></div>
<div class="row"><label for="gen-steps">步数</label><input type="number" id="gen-steps" min="1" max="150" placeholder="默认"><label for="gen-guidance">引导</label><input type="number" id="gen-guidance" step="0.1" placeholder="默认"></div>
<div class="row"><label for="gen-seed">种子</label><input type="number" id="gen-seed" placeholder="-1 或留空=随机"><button type="button" class="mini" id="gen-dice" title="随机一个种子">🎲</button><label for="gen-n">数量</label><input type="number" id="gen-n" min="1" max="4" value="1" class="select-inline"></div>
</details>
<div class="actions"><button type="button" class="primary" id="gen-run"><span class="spinner" id="gen-spin" hidden></span><span id="gen-label">▶ 生成</span></button><button type="button" class="mini" id="gen-cancel" hidden>■ 取消</button><span class="muted" id="gen-state"></span></div>
<div class="progress" id="gen-progress" hidden><div class="bar"><div class="fill ind" id="gen-fill"></div></div><div class="muted" id="gen-progress-text"></div></div>
</div>

<div class="card" id="results-card" hidden>
<h3>本次结果 <span class="muted" id="results-count"></span><button type="button" class="mini" id="results-clear">清空</button></h3>
<div class="tiles" id="results"></div>
</div>

<div class="card">
<h3>创作历史 <span class="muted" id="hist-count"></span><button type="button" class="mini" id="hist-reload">↻ 刷新</button></h3>
<div class="chistory" id="history">${historyHtml}</div>
</div>
${lightboxMarkup('preview', '滚轮缩放 · 拖拽平移 · 双击切换 适应/1:1 · Esc 关闭')}
<script>
var TOKEN = ${JSON.stringify(token)};
var PROVIDERS = ${JSON.stringify(providers)};
var PRESETS = ${JSON.stringify(presets)};
var KIND_LABELS = ${JSON.stringify(PROVIDER_KIND_LABELS)};
window.__defaultId = ${JSON.stringify(defaultId)};
${CREATE_JS}
</script>`
  return pageShell('创作', body, { extraCss: `${CREATE_CSS}${TABS_CSS}${PREVIEW_CSS}`, wrapClass: 'wide' })
}

const CREATE_JS = `
function api(path, body) {
  return fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: Object.assign({ 'x-dsh-comfymcp': '1', 'content-type': 'application/json' }, TOKEN ? { 'x-dsh-comfymcp-token': TOKEN } : {}),
    body: body === undefined ? undefined : JSON.stringify(body)
  }).then(function (res) {
    return res.json().then(function (data) {
      if (!res.ok || data.ok === false) throw new Error((data.error && data.error.message) || ('HTTP ' + res.status));
      return data.value !== undefined ? data.value : data;
    });
  });
}
function artUrl(path) {
  return '/artifact?path=' + encodeURIComponent(path || '') + (TOKEN ? '&token=' + encodeURIComponent(TOKEN) : '');
}
function el(id) { return document.getElementById(id); }
function text(id, value) { var node = el(id); if (node) node.textContent = value || ''; }
function show(id, on) { var node = el(id); if (node) node.hidden = !on; }
var STATE = { providers: PROVIDERS.slice(), editing: null, jobId: '', pollTimer: null, fileData: '', filePath: '', lastImages: [] };
function renderProviders() {
  var list = STATE.providers;
  var box = el('provider-list');
  if (!box) return;
  box.innerHTML = list.length === 0 ? '<div class="muted">还没有配置服务商：点右上角「＋ 添加服务商」，或从预设模板一键创建。</div>' : list.map(function (p) {
    var dot = p.enabled === false ? 'off' : 'ok';
    var isDefault = p.id === (window.__defaultId || '');
    return '<div class="pcard" data-pid="' + esc(p.id) + '"><div class="phead"><span class="dot ' + dot + '"></span><b>' + esc(p.label || p.id) + '</b><span class="chip">' + esc(p.kindLabel || KIND_LABELS[p.kind] || p.kind) + '</span>' + (isDefault ? '<span class="chip">默认</span>' : '') + '</div>' +
      '<div class="muted">' + esc(p.baseUrl) + ' · 模型 ' + esc(p.model || '（当前加载）') + ' · 密钥 ' + (p.apiKey ? esc(p.apiKey) + (p.apiKeyIsEnv ? '（环境变量）' : '') : '未配置') + '</div>' +
      '<div class="pops"><button type="button" class="mini" data-act="test">测试连接</button><button type="button" class="mini" data-act="edit">编辑</button><button type="button" class="mini" data-act="toggle">' + (p.enabled === false ? '启用' : '停用') + '</button><button type="button" class="mini" data-act="default">设为默认</button><button type="button" class="mini danger" data-act="remove">删除</button></div></div>';
  }).join('');
  var select = el('gen-provider');
  if (select) {
    var current = select.value;
    select.innerHTML = STATE.providers.filter(function (p) { return p.enabled !== false; }).map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(p.label || p.id) + '</option>'; }).join('');
    if (current && STATE.providers.some(function (p) { return p.id === current && p.enabled !== false; })) select.value = current;
  }
  text('prov-count', STATE.providers.length + ' 个服务商');
}
function esc(v) { return String(v === undefined || v === null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function reloadProviders() {
  return api('/api/providers').then(function (data) {
    STATE.providers = data.providers || [];
    window.__defaultId = data.defaultId || '';
    renderProviders();
  });
}
function fillPreset(preset) {
  if (!preset) return;
  el('pedit-id').value = preset.id || '';
  el('pedit-label').value = preset.label || '';
  el('pedit-kind').value = preset.kind || 'openai-images';
  el('pedit-base').value = preset.baseUrl || '';
  el('pedit-model').value = preset.model || '';
  el('pedit-key').value = '';
  el('pedit-private').checked = preset.allowPrivateHosts === true;
  el('pedit-enabled').checked = true;
  el('pedit-size').value = (preset.defaults && preset.defaults.size) || '';
  el('pedit-np').value = (preset.defaults && preset.defaults.negativePrompt) || '';
  el('pedit-legacy').checked = false;
  text('pedit-hint', preset.note || '');
}
function openEditor(provider) {
  STATE.editing = provider || null;
  var wrap = el('provider-edit');
  wrap.hidden = false;
  el('pedit-preset').value = '';
  if (provider) {
    el('pedit-id').value = provider.id;
    el('pedit-label').value = provider.label || '';
    el('pedit-kind').value = provider.kind;
    el('pedit-base').value = provider.baseUrl;
    el('pedit-model').value = provider.model || '';
    el('pedit-key').value = provider.apiKey || '';
    el('pedit-private').checked = provider.allowPrivateHosts === true;
    el('pedit-enabled').checked = provider.enabled !== false;
    el('pedit-size').value = (provider.defaults && provider.defaults.size) || '';
    el('pedit-np').value = (provider.defaults && provider.defaults.negativePrompt) || '';
    el('pedit-legacy').checked = provider.legacy === true;
    text('pedit-hint', '编辑中：' + provider.id);
  } else {
    el('pedit-id').value = '';
    el('pedit-label').value = '';
    el('pedit-kind').value = 'openai-images';
    el('pedit-base').value = '';
    el('pedit-model').value = '';
    el('pedit-key').value = '';
    el('pedit-private').checked = false;
    el('pedit-enabled').checked = true;
    el('pedit-size').value = '1024x1024';
    el('pedit-np').value = '';
    el('pedit-legacy').checked = false;
    text('pedit-hint', '从预设模板开始，或手动填写；密钥支持 env:环境变量名（推荐）。');
  }
  wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function saveProvider() {
  var payload = {
    id: el('pedit-id').value.trim(),
    label: el('pedit-label').value.trim(),
    kind: el('pedit-kind').value,
    baseUrl: el('pedit-base').value.trim(),
    model: el('pedit-model').value.trim(),
    apiKey: el('pedit-key').value.trim(),
    allowPrivateHosts: el('pedit-private').checked,
    enabled: el('pedit-enabled').checked,
    legacy: el('pedit-legacy').checked,
    defaults: { size: el('pedit-size').value.trim(), negativePrompt: el('pedit-np').value.trim() }
  };
  text('pedit-state', '保存中…');
  api('/api/providers', payload).then(function () {
    text('pedit-state', '已保存');
    return reloadProviders();
  }).then(function () {
    show('provider-edit', false);
    text('pedit-state', '');
  }).catch(function (error) { text('pedit-state', '保存失败：' + error.message); });
}
function providerAction(event) {
  var btn = event.target.closest ? event.target.closest('button[data-act]') : null;
  if (!btn) return;
  var card = btn.closest('.pcard');
  var id = card ? card.getAttribute('data-pid') : '';
  var provider = STATE.providers.filter(function (p) { return p.id === id; })[0];
  if (!provider) return;
  var act = btn.getAttribute('data-act');
  if (act === 'edit') { openEditor(provider); return; }
  if (act === 'test') {
    btn.disabled = true;
    btn.textContent = '测试中…';
    api('/api/providers/test', { id: id }).then(function (result) {
      btn.textContent = result.ok ? '✓ 连接正常' : '✗ 失败';
      alert((result.ok ? '连接成功：' : '连接失败：') + result.message);
      setTimeout(function () { btn.disabled = false; btn.textContent = '测试连接'; }, 1200);
    }).catch(function (error) {
      alert('测试失败：' + error.message);
      btn.disabled = false; btn.textContent = '测试连接';
    });
    return;
  }
  if (act === 'toggle') {
    api('/api/providers', Object.assign({}, provider, { enabled: provider.enabled === false })).then(reloadProviders);
    return;
  }
  if (act === 'default') {
    api('/api/providers/default', { id: id }).then(function () { window.__defaultId = id; return reloadProviders(); });
    return;
  }
  if (act === 'remove') {
    if (!confirm('删除服务商「' + (provider.label || provider.id) + '」？')) return;
    api('/api/providers/remove', { id: id }).then(reloadProviders);
  }
}
function currentMode() {
  var radios = document.querySelectorAll('input[name="gen-mode"]');
  for (var i = 0; i < radios.length; i++) if (radios[i].checked) return radios[i].value;
  return 't2i';
}
function syncModeUi() {
  var mode = currentMode();
  show('i2i-row', mode === 'i2i');
  if (mode !== 'i2i') { STATE.fileData = ''; STATE.filePath = ''; show('i2i-thumb', false); el('i2i-thumb').src = ''; }
}
function setThumb(src) {
  var thumb = el('i2i-thumb');
  thumb.src = src || '';
  thumb.hidden = !src;
}
function pickFile() {
  var file = el('gen-file').files && el('gen-file').files[0];
  if (!file) return;
  if (file.size > 12 * 1024 * 1024) { alert('图片超过 12MB，请先压缩'); return; }
  var reader = new FileReader();
  reader.onload = function () { STATE.fileData = String(reader.result || ''); STATE.filePath = ''; setThumb(STATE.fileData); };
  reader.readAsDataURL(file);
}
function loadArtifacts() {
  return api('/api/artifacts').then(function (data) {
    var options = [];
    (data || []).forEach(function (run) {
      (run.localFiles || []).forEach(function (file) {
        if (!file || !file.path) return;
        if (!/\.(png|jpe?g|webp|gif|bmp)$/i.test(file.path)) return;
        options.push('<option value="' + esc(file.path) + '">' + esc(file.filename || file.path) + '</option>');
      });
    });
    var select = el('gen-artifact');
    if (select) select.innerHTML = '<option value="">从成果物选择…</option>' + options.slice(0, 80).join('');
  }).catch(function () {});
}
function collectRequest() {
  var providerId = el('gen-provider').value;
  var provider = STATE.providers.filter(function (p) { return p.id === providerId; })[0];
  if (!provider) throw new Error('请先选择服务商');
  var mode = currentMode();
  var image = '';
  if (mode === 'i2i') {
    if (el('gen-artifact').value) image = el('gen-artifact').value;
    else if (STATE.fileData) image = STATE.fileData;
    else throw new Error('图生图需要选择参考图（上传或从成果物选）');
  }
  var payload = {
    providerId: providerId,
    mode: mode,
    prompt: el('gen-prompt').value.trim(),
    negativePrompt: el('gen-negative').value.trim(),
    model: el('gen-model').value.trim() || undefined,
    size: el('gen-size').value.trim() || undefined,
    steps: el('gen-steps').value.trim() || undefined,
    guidance: el('gen-guidance').value.trim() || undefined,
    seed: el('gen-seed').value.trim() === '' ? undefined : el('gen-seed').value.trim(),
    n: el('gen-n').value.trim() || undefined,
    image: image || undefined
  };
  return payload;
}
function pollJob() {
  if (!STATE.jobId) return;
  api('/api/create/job?id=' + encodeURIComponent(STATE.jobId)).then(function (job) {
    if (!job) return;
    var seconds = Math.max(1, Math.round((job.elapsedMs || 0) / 1000));
    if (job.status === 'running') {
      text('gen-state', '生成中… ' + seconds + 's' + (job.progress && job.progress.stage === 'task' ? '（服务商任务处理中）' : ''));
    } else if (job.status === 'succeeded') {
      stopPolling();
      show('gen-progress', false);
      show('gen-spin', false);
      el('gen-run').disabled = false;
      el('gen-label').textContent = '▶ 生成';
      show('gen-cancel', false);
      text('gen-state', '完成：' + (job.images || []).length + ' 张 · ' + seconds + 's');
      renderResults(job.images || []);
      loadHistory();
    } else {
      stopPolling();
      show('gen-progress', false);
      show('gen-spin', false);
      el('gen-run').disabled = false;
      el('gen-label').textContent = '▶ 生成';
      show('gen-cancel', false);
      text('gen-state', '失败：' + (job.error || '未知错误'));
      loadHistory();
    }
  }).catch(function (error) {
    stopPolling();
    text('gen-state', '查询任务失败：' + error.message);
  });
}
function stopPolling() {
  if (STATE.pollTimer) { clearInterval(STATE.pollTimer); STATE.pollTimer = null; }
}
function startJob() {
  var payload;
  try { payload = collectRequest(); } catch (error) { alert(error.message); return; }
  if (!payload.prompt) { alert('请填写提示词'); return; }
  show('gen-spin', true);
  el('gen-run').disabled = true;
  el('gen-label').textContent = '生成中…';
  show('gen-progress', true);
  show('gen-cancel', true);
  text('gen-state', '提交中…');
  text('gen-progress-text', '');
  api('/api/create', payload).then(function (started) {
    if (!started.ok) { throw new Error(started.reason || '无法启动'); }
    STATE.jobId = started.jobId;
    text('gen-state', '任务已提交（' + started.jobId + '）');
    STATE.pollTimer = setInterval(pollJob, 1500);
    pollJob();
  }).catch(function (error) {
    show('gen-spin', false);
    el('gen-run').disabled = false;
    el('gen-label').textContent = '▶ 生成';
    show('gen-progress', false);
    show('gen-cancel', false);
    text('gen-state', '启动失败：' + error.message);
  });
}
function cancelJob() {
  if (!STATE.jobId) return;
  api('/api/create/cancel', { id: STATE.jobId }).then(function () { text('gen-state', '已请求取消…'); }).catch(function () {});
}
function renderResults(images) {
  STATE.lastImages = images || [];
  var box = el('results');
  if (!box) return;
  box.innerHTML = '';
  STATE.lastImages.forEach(function (image, index) {
    var url = artUrl(image.path);
    var tile = document.createElement('div');
    tile.className = 'tile';
    tile.innerHTML = '<img data-preview="' + esc(url) + '" data-name="' + esc(image.path) + '" src="' + esc(url) + '" alt="生成结果 ' + (index + 1) + '" loading="lazy">' +
      '<div class="muted" style="font-size:11px;word-break:break-all">' + esc(String(image.path || '').split(/[\\\\/]/).pop()) + '</div>' +
      '<div class="tops"><button type="button" class="mini" data-img-act="again">再来一张</button><button type="button" class="mini" data-img-act="copy">复制提示词</button><a class="mini" href="' + esc(url) + '" download>⬇ 下载</a></div>';
    box.appendChild(tile);
  });
  show('results-card', STATE.lastImages.length > 0);
  text('results-count', STATE.lastImages.length > 0 ? String(STATE.lastImages.length) + ' 张' : '');
}
function loadHistory() {
  return api('/api/create/history?limit=20').then(function (items) {
    var box = el('history');
    if (!box) return;
    box.innerHTML = (items || []).length === 0 ? '<div class="muted">还没有创作记录。</div>' : items.map(historyHtmlOf).join('');
    text('hist-count', (items || []).length > 0 ? String(items.length) + ' 条' : '');
  }).catch(function () {});
}
function historyHtmlOf(item) {
  var thumb = item.images && item.images[0] ? item.images[0].path : '';
  var url = thumb ? artUrl(thumb) : '';
  var chip = item.status === 'succeeded' ? '<span class="chip ok">成功</span>' : '<span class="chip bad">失败</span>';
  return '<div class="ch" data-cid="' + esc(item.id) + '">' +
    (thumb ? '<img class="thumb" data-preview="' + esc(url) + '" data-name="' + esc(thumb) + '" src="' + esc(url) + '" alt="" loading="lazy">' : '<span class="thumb" style="display:flex;align-items:center;justify-content:center">✕</span>') +
    '<div class="info"><b>' + esc(item.providerLabel || item.providerId) + '</b> · ' + esc(item.model || '') + ' ' + chip +
    '<div>' + esc(String(item.prompt || '').slice(0, 100)) + '</div>' +
    '<div>' + esc(String(item.createdAt || '').slice(0, 19).replace('T', ' ')) + (item.elapsedMs !== undefined ? ' · ' + Math.max(1, Math.round(item.elapsedMs / 1000)) + 's' : '') + (item.error ? ' · ' + esc(String(item.error).slice(0, 120)) : '') + '</div></div>' +
    '<div class="ops"><button type="button" class="mini" data-act="rerun">' + (item.status === 'succeeded' ? '再来一张' : '重试') + '</button><button type="button" class="mini" data-act="delete">删除</button></div></div>';
}
function fillFromHistory(item) {
  var provider = STATE.providers.filter(function (p) { return p.id === item.providerId; })[0];
  if (provider) el('gen-provider').value = provider.id;
  el('gen-model').value = item.model || '';
  el('gen-prompt').value = item.prompt || '';
  el('gen-negative').value = item.negativePrompt || '';
  el('gen-size').value = item.size || '';
  el('gen-seed').value = '';
  if (item.mode === 'i2i') {
    var radios = document.querySelectorAll('input[name="gen-mode"]');
    for (var i = 0; i < radios.length; i++) radios[i].checked = radios[i].value === 'i2i';
    syncModeUi();
  }
  openEditor(null);
  show('provider-edit', false);
  el('gen-prompt').focus();
  el('gen-prompt').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
document.addEventListener('click', function (event) {
  var target = event.target;
  if (target.closest) {
    var preview = target.closest('[data-preview]');
    if (preview) {
      showPreview('preview', 'image', preview.getAttribute('data-preview'), preview.getAttribute('data-name') || '');
      return;
    }
    var act = target.closest('button[data-act]');
    if (act) {
      var card = act.closest('.ch');
      var historyBox = el('history');
      if (card && historyBox && historyBox.contains(card)) {
        var cid = card.getAttribute('data-cid');
        var item = null;
        api('/api/create/history?limit=200').then(function (items) {
          item = (items || []).filter(function (entry) { return String(entry.id) === cid; })[0];
          var op = act.getAttribute('data-act');
          if (op === 'rerun' && item) { fillFromHistory(item); return; }
          if (op === 'delete' && item) {
            if (!confirm('删除这条创作记录（含磁盘文件）？')) return;
            api('/api/create/remove', { id: cid, deleteFiles: true }).then(function () { loadHistory(); });
          }
        });
        return;
      }
    }
  }
});
document.getElementById('add-provider').addEventListener('click', function () { openEditor(null); });
document.getElementById('pedit-cancel').addEventListener('click', function () { show('provider-edit', false); });
document.getElementById('pedit-save').addEventListener('click', saveProvider);
document.getElementById('pedit-preset').addEventListener('change', function () {
  var preset = PRESETS.filter(function (entry) { return entry.id === this.value; }.bind(this))[0];
  fillPreset(preset);
});
document.getElementById('provider-list').addEventListener('click', providerAction);
document.getElementById('gen-run').addEventListener('click', startJob);
document.getElementById('gen-cancel').addEventListener('click', cancelJob);
document.getElementById('gen-dice').addEventListener('click', function () { el('gen-seed').value = String(Math.floor(Math.random() * 4294967295)); });
document.getElementById('gen-file').addEventListener('change', pickFile);
document.getElementById('gen-artifact').addEventListener('change', function () {
  if (this.value) { STATE.fileData = ''; setThumb(artUrl(this.value)); } else { setThumb(STATE.fileData); }
});
document.querySelectorAll('input[name="gen-mode"]').forEach(function (radio) { radio.addEventListener('change', syncModeUi); });
document.getElementById('results-clear').addEventListener('click', function () { STATE.lastImages = []; renderResults([]); });
document.getElementById('hist-reload').addEventListener('click', loadHistory);
document.getElementById('results').addEventListener('click', function (event) {
  var btn = event.target.closest ? event.target.closest('button[data-img-act]') : null;
  if (btn) {
    if (btn.getAttribute('data-img-act') === 'copy') {
      if (navigator.clipboard) navigator.clipboard.writeText(el('gen-prompt').value || '').then(function () { btn.textContent = '✓ 已复制'; });
      return;
    }
    if (btn.getAttribute('data-img-act') === 'again') {
      el('gen-seed').value = '';
      startJob();
    }
  }
});
bindPreviewEvents('preview');
syncModeUi();
loadArtifacts();
`

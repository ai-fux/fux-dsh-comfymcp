/**
 * 页面公共件（pagekit）：工作台各页共用的页面外壳 / Tab / 灯箱 / 转义工具。
 *
 * 0.6.0 从 wfpage.js 抽出：新增「创作」页与现有五页共用同一套外壳与灯箱，
 * 避免大文件里复制粘贴 CSS/JS。全部为纯字符串/纯函数，渲染确定性。
 */

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export const PAGE_CSS = `
:root{--bg:#f6f7f9;--surface:#ffffff;--text:#1f2329;--muted:#6f7680;--line:#e4e7ec;--accent:#3b6cf0;--accent-weak:#eaf0ff;--ok:#1a7f37;--err:#c0392b;--radius:8px}
@media (prefers-color-scheme:dark){:root{--bg:#141517;--surface:#1d1f23;--text:#e8eaed;--muted:#9aa1ab;--line:#2e3238;--accent:#6f96ff;--accent-weak:#22304d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 system-ui,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif}
.wrap{max-width:860px;margin:0 auto;padding:14px 16px 40px}
/* 宽版页面（成果物画廊 / 指令编辑器）：全宽左对齐，卡片从左侧起排 */
.wrap.wide{max-width:none;margin:0;padding:14px 20px 40px}
/* 页头（标题 + 四 Tab）：嵌在 DSH 工作台里时顶部已有同样的 Tab，页内不再重复，
   只有「在新窗口打开」的独立访问才显示，保证单独打开时仍有导航。 */
.pagehead{display:none}
.pagehead.standalone{display:block}
h1{font-size:17px;margin:0 0 2px}.sub{color:var(--muted);font-size:12px;margin-bottom:12px}
/* 页面条：一行说明 + 右侧动作（顶部 Tab 由客户端插件提供，页内不再重复标题与 Tab） */
.pagebar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.pagebar-actions{display:flex;gap:6px;flex:0 0 auto}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:14px 16px;margin-bottom:12px}
.card h3{margin:0 0 10px;font-size:13px;color:var(--muted);font-weight:600}
.row{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px;align-items:center}
.row:last-child{margin-bottom:0}.row label{min-width:130px;max-width:100%;color:var(--muted);font-size:12px;word-break:break-all}
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
/* 文本弹窗基础样式（图片/视频预览已改为整屏遮罩灯箱，样式见 PREVIEW_CSS） */
.modal{position:fixed;inset:0;background:rgba(12,14,17,.78);display:flex;align-items:center;justify-content:center;z-index:50;padding:24px}
.modal[hidden]{display:none}
.modal .box{background:var(--surface);border-radius:10px;padding:12px;max-width:92vw;max-height:88vh;overflow:auto;position:relative}
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

/** 只在独立窗口（非 iframe）里露出页头与页内 Tab——嵌在 DSH 工作台时顶部已有 Tab。 */
export const FRAME_JS = `if (window.self === window.top) { var ph = document.querySelector('.pagehead'); if (ph) ph.classList.add('standalone'); }
`

export function pageShell(title, body, { extraScript = '', extraCss = '', wrapClass = '' } = {}) {
  const styles = extraCss.length > 0 ? `${PAGE_CSS}${extraCss}` : PAGE_CSS
  const wrap = wrapClass.length > 0 ? `wrap ${wrapClass}` : 'wrap'
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${styles}</style></head>
<body><div class="${wrap}">${body}</div>
<script>${FRAME_JS}${extraScript}</script></body></html>
`
}

/** Tab 样式（索引页专用，与 DSH 简约风一致）。 */

/** 工作台顶部 Tab（我的工作流 / 创作 / 模板 / 成果物 / 业务配置 / 指令），各页共用，齐平展示。 */
export function workbenchTabs(active, token = '') {
  const enc = encodeURIComponent(token)
  const item = (key, label, href, count) => `<a class="wtab ${active === key ? 'active' : ''}" href="${href}?token=${enc}">${label}${typeof count === 'number' ? `（${count}）` : ''}</a>`
  return `<nav class="wtabs">
${item('mine', '我的工作流', '/ui', typeof active === 'object' ? active.mine : undefined)}
${item('create', '创作', '/ui/create', typeof active === 'object' ? active.create : undefined)}
${item('library', '模板', '/ui/library', typeof active === 'object' ? active.library : undefined)}
${item('artifacts', '成果物', '/ui/artifacts', typeof active === 'object' ? active.artifacts : undefined)}
${item('business', '业务配置', '/ui/business', typeof active === 'object' ? active.business : undefined)}
${item('commands', '指令', '/ui/commands', typeof active === 'object' ? active.commands : undefined)}
</nav>`
}

/** 灯箱标记（与 PREVIEW_JS 配套，prefix 区分多页复用；hint 为底部操作提示）。 */
export function lightboxMarkup(prefix, hint = '滚轮缩放 · 拖拽平移 · 双击切换 适应/1:1 · Esc 关闭') {
  return `<div class="modal lightbox" id="${prefix}" role="dialog" aria-modal="true" hidden>
<div class="lb-top"><span class="lb-name" id="${prefix}-name"></span>
<button type="button" class="lb-close" id="${prefix}-close" title="关闭（Esc）">✕</button></div>
<div class="lb-stage" id="${prefix}-body"></div>
<div class="lb-bottom">
<div class="lb-strip" id="${prefix}-strip" hidden></div>
<div class="lb-tools">
<span class="lb-zoomtools">
<button type="button" class="mini" data-zoom="out" title="缩小（-）">−</button>
<span class="lb-zoom" id="zoom-label">100%</span>
<button type="button" class="mini" data-zoom="in" title="放大（+）">＋</button>
<button type="button" class="mini" data-zoom="fit" title="适应窗口（0）">适应窗口</button>
<button type="button" class="mini" data-zoom="one" title="原始尺寸（1）">1:1</button>
</span>
<a class="mini" id="${prefix}-blank" href="#" target="_blank" rel="noopener" title="在新窗口打开原图">⤢ 新窗口</a>
<a class="mini" id="${prefix}-save" href="#" download title="下载原文件">⬇ 下载</a>
<span class="lb-hint" id="${prefix}-hint">${hint}</span>
</div></div></div>`
}

export const TABS_CSS = `
.wtabs{display:flex;gap:6px;border-bottom:1px solid var(--line);margin:2px 0 16px;flex-wrap:wrap}
.wtabs .wtab{padding:7px 16px;border:1px solid var(--line);border-bottom:none;border-radius:8px 8px 0 0;background:var(--bg);color:var(--muted);font-size:13px;margin-bottom:-1px}
.wtabs .wtab.active{background:var(--surface);color:var(--text);font-weight:600;border-color:var(--line)}
.wtabs .wtab:hover{color:var(--text)}
`

export const PREVIEW_CSS = `
html.lb-open,body.lb-open{overflow:hidden}
.modal.lightbox{position:fixed;inset:0;background:rgba(6,7,9,.96);display:flex;flex-direction:column;align-items:stretch;justify-content:flex-start;padding:0;z-index:80}
.modal.lightbox[hidden]{display:none}
.modal.lightbox .lb-top{position:absolute;top:0;left:0;right:0;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px var(--lb-pad,16px) 12px 16px;z-index:3;color:#e9ecef;font-size:13px;background:linear-gradient(180deg,rgba(0,0,0,.6),rgba(0,0,0,0))}
.modal.lightbox .lb-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:74vw;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
/* 圆形关闭：flex 居中保证 ✕ 落在圆心；上 16px／右 16px（含滚动条补偿）左右上下等距 */
.modal.lightbox .lb-close{flex:0 0 auto;display:flex;align-items:center;justify-content:center;width:34px;height:34px;padding:0;border-radius:50%;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.24);color:#f1f3f5;font-size:14px;line-height:1;cursor:pointer}
.modal.lightbox .lb-close:hover{background:rgba(255,255,255,.24);color:#fff}
/* 舞台铺满整个浏览器窗口，图片在其中缩放/平移（超出的部分被遮罩裁掉） */
.modal.lightbox .lb-stage{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;overflow:hidden;cursor:grab;touch-action:none}
.modal.lightbox .lb-stage.grabbing{cursor:grabbing}
.modal.lightbox .lb-stage img{display:block;max-width:none;max-height:none;transform-origin:center center;user-select:none;-webkit-user-drag:none;border-radius:2px;box-shadow:0 14px 44px rgba(0,0,0,.6)}
.modal.lightbox .lb-stage video{max-width:100%;max-height:100%;display:block;background:#000;border-radius:6px}
.modal.lightbox .lb-stage audio{width:min(560px,84vw);display:block}
.modal.lightbox .lb-empty{color:#e9ecef;font-size:13px;max-width:80vw;word-break:break-all}
.modal.lightbox .lb-bottom{position:absolute;left:0;right:0;bottom:0;display:flex;flex-direction:column;align-items:center;gap:8px;padding:12px var(--lb-pad,16px) 16px;z-index:3;color:#e9ecef;font-size:12px;background:linear-gradient(0deg,rgba(0,0,0,.6),rgba(0,0,0,0))}
.modal.lightbox .lb-tools{display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap}
/* 画廊缩略条：多张成果物逐张查看时用（点缩略图跳转，← → 也可切） */
.modal.lightbox .lb-strip{display:flex;gap:6px;max-width:86vw;overflow-x:auto;padding:2px}
.modal.lightbox .lb-strip[hidden]{display:none}
.modal.lightbox .lb-strip .stripitem{flex:0 0 auto;width:52px;height:52px;border-radius:6px;overflow:hidden;border:2px solid transparent;background:rgba(255,255,255,.08);cursor:pointer;display:flex;align-items:center;justify-content:center;color:#e9ecef;font-size:16px}
.modal.lightbox .lb-strip .stripitem.on{border-color:#fff}
.modal.lightbox .lb-strip .stripitem img{width:100%;height:100%;object-fit:cover;display:block}
.modal.lightbox .lb-bottom .mini{background:rgba(255,255,255,.09);border-color:rgba(255,255,255,.2);color:#e9ecef}
.modal.lightbox .lb-bottom .mini:hover{background:rgba(255,255,255,.2);color:#fff}
.modal.lightbox .lb-bottom a.mini{text-decoration:none;display:inline-flex;align-items:center}
.modal.lightbox .lb-zoom{min-width:54px;text-align:center;color:#fff;font-variant-numeric:tabular-nums}
.modal.lightbox .lb-hint{color:rgba(255,255,255,.5);margin-left:8px}
@media (max-width:760px){.modal.lightbox .lb-hint{display:none}}
`

export const PREVIEW_JS = `
var VIEW = { modalId: '', kind: 'file', natW: 1, natH: 1, scale: 1, fitScale: 1, x: 0, y: 0, dragging: false, moved: false, sx: 0, sy: 0 };
function viewStage() { return document.getElementById(VIEW.modalId + '-body'); }
function viewImg() { var stage = viewStage(); return stage ? stage.querySelector('img') : null; }
function viewLabelSet() {
  var label = document.getElementById('zoom-label');
  if (label) label.textContent = Math.round(VIEW.scale * 100) + '%';
}
/** 遮罩内可用于放图的空间：舞台铺满窗口，上下各留出浮层工具条的高度。 */
function viewAvailable() {
  var stage = viewStage();
  var width = stage ? stage.clientWidth : 0;
  var height = stage ? stage.clientHeight : 0;
  return { w: Math.max(60, width - 36), h: Math.max(60, height - 116) };
}
function viewFitScale() {
  var size = viewAvailable();
  return Math.min(size.w / (VIEW.natW || 1), size.h / (VIEW.natH || 1));
}
function viewApply() {
  var img = viewImg();
  if (!img) return;
  img.style.width = VIEW.natW + 'px';
  img.style.height = VIEW.natH + 'px';
  img.style.transform = 'translate(' + VIEW.x + 'px,' + VIEW.y + 'px) scale(' + VIEW.scale + ')';
  viewLabelSet();
}
/** 别把图整个拖出视野：任何方向至少留 40px 可见。 */
function viewClamp() {
  var stage = viewStage();
  if (!stage) return;
  var maxX = Math.max(0, (VIEW.natW * VIEW.scale + stage.clientWidth) / 2 - 40);
  var maxY = Math.max(0, (VIEW.natH * VIEW.scale + stage.clientHeight) / 2 - 40);
  VIEW.x = Math.max(-maxX, Math.min(maxX, VIEW.x));
  VIEW.y = Math.max(-maxY, Math.min(maxY, VIEW.y));
}
/** 以 (anchorX, anchorY)（默认遮罩中心）为锚点缩放到 scale。 */
function viewZoomTo(scale, anchorX, anchorY) {
  var stage = viewStage();
  if (!stage) return;
  var next = Math.max(0.05, Math.min(16, scale));
  var rect = stage.getBoundingClientRect();
  var cx = rect.left + rect.width / 2;
  var cy = rect.top + rect.height / 2;
  if (typeof anchorX !== 'number') { anchorX = cx; anchorY = cy; }
  var ratio = next / (VIEW.scale || 1);
  VIEW.x = anchorX - cx - (anchorX - cx - VIEW.x) * ratio;
  VIEW.y = anchorY - cy - (anchorY - cy - VIEW.y) * ratio;
  VIEW.scale = next;
  viewClamp();
  viewApply();
}
function viewZoomBy(factor, anchorX, anchorY) { viewZoomTo(VIEW.scale * factor, anchorX, anchorY); }
function viewFit() {
  VIEW.fitScale = viewFitScale();
  VIEW.scale = VIEW.fitScale;
  VIEW.x = 0;
  VIEW.y = 0;
  viewApply();
}
function viewActual() { VIEW.scale = 1; VIEW.x = 0; VIEW.y = 0; viewClamp(); viewApply(); }
/* 旧调用点兼容 */
function zoomBy(factor) { viewZoomBy(factor); }
function zoomReset() { viewFit(); }
function fillPreview(bodyId, kind, url, name) {
  var modalId = String(bodyId).replace(/-body$/, '');
  VIEW.modalId = modalId;
  VIEW.kind = kind;
  VIEW.natW = 1; VIEW.natH = 1; VIEW.scale = 1; VIEW.fitScale = 1; VIEW.x = 0; VIEW.y = 0;
  VIEW.dragging = false; VIEW.moved = false;
  var body = document.getElementById(bodyId);
  if (!body) return;
  var modal = document.getElementById(modalId);
  var blank = document.getElementById(modalId + '-blank');
  var save = document.getElementById(modalId + '-save');
  var tools = modal ? modal.querySelector('.lb-zoomtools') : null;
  var hint = document.getElementById(modalId + '-hint');
  if (tools) tools.hidden = kind !== 'image';
  if (hint) hint.hidden = kind !== 'image';
  if (blank) blank.href = url;
  if (save) { save.href = url; save.setAttribute('download', name || ''); }
  if (kind === 'video') { body.innerHTML = '<video src="' + url + '" controls autoplay playsinline></video>'; return; }
  if (kind === 'audio') { body.innerHTML = '<audio src="' + url + '" controls autoplay></audio>'; return; }
  if (kind !== 'image') { body.innerHTML = '<div class="lb-empty">该类型不支持内嵌预览，可点「下载」或「新窗口」查看。</div>'; return; }
  body.innerHTML = '<img src="' + url + '" alt="" draggable="false">';
  var img = body.querySelector('img');
  var ready = function () {
    VIEW.natW = img.naturalWidth || img.width || 1;
    VIEW.natH = img.naturalHeight || img.height || 1;
    viewFit(); // 打开即「适应窗口」：整张图落在遮罩区域内
    // 显示遮罩后布局会再稳定一帧（滚动条/浮层），补一次以免用到旧尺寸
    if (window.requestAnimationFrame) {
      window.requestAnimationFrame(function () { if (viewImg() === img && !VIEW.dragging) viewFit(); });
    }
  };
  img.addEventListener('load', ready);
  img.addEventListener('error', function () {
    body.innerHTML = '<div class="lb-empty">图像加载失败（可用「下载」或「新窗口」打开）：' + url + '</div>';
  });
  if (img.complete && img.naturalWidth > 0) ready();
}
/** 打开灯箱：设文件名 → 填内容 → 显示遮罩 → 锁页面滚动。 */
function showPreview(modalId, kind, url, name) {
  var modal = document.getElementById(modalId);
  if (!modal) return;
  GALLERY.items = []; // 单张模式：← → 不切图
  GALLERY.modalId = modalId;
  var nameEl = document.getElementById(modalId + '-name');
  if (nameEl) nameEl.textContent = name || '';
  fillPreview(modalId + '-body', kind, url, name);
  var strip = document.getElementById(modalId + '-strip');
  if (strip) { strip.hidden = true; strip.innerHTML = ''; }
  modal.hidden = false;
  document.documentElement.classList.add('lb-open');
  // 若页面仍留着滚动条，给浮层补上等宽内边距，避免关闭按钮被压在滚动条下（看起来被切、不对称）
  var scrollbar = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
  modal.style.setProperty('--lb-pad', (16 + scrollbar) + 'px');
}
/* ---- 画廊模式：一次运行多张时逐张查看（子级详情） ---- */
var GALLERY = { items: [], index: 0, modalId: '' };
/** 打开某次运行的画廊：第 index 张起（items 由页面渲染时写入 window.__galleries）。 */
function showGallery(modalId, runId, index) {
  var items = (window.__galleries || {})[runId] || [];
  if (items.length === 0) return;
  GALLERY.items = items;
  GALLERY.modalId = modalId;
  var modal = document.getElementById(modalId);
  if (!modal) return;
  renderGalleryStrip(modalId);
  galleryShow(Number(index) || 0);
  modal.hidden = false;
  document.documentElement.classList.add('lb-open');
  var scrollbar = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
  modal.style.setProperty('--lb-pad', (16 + scrollbar) + 'px');
}
function renderGalleryStrip(modalId) {
  var strip = document.getElementById(modalId + '-strip');
  if (!strip) return;
  strip.hidden = GALLERY.items.length < 2;
  strip.innerHTML = GALLERY.items.map(function (item, index) {
    var inner = item.kind === 'image'
      ? '<img src="' + item.url + '" alt="" loading="lazy">'
      : item.kind === 'video' ? '▶' : item.kind === 'audio' ? '♪' : '📄';
    return '<span class="stripitem" data-strip-index="' + index + '" title="' + (item.name || '') + '">' + inner + '</span>';
  }).join('');
}
/** 切到第 index 张（循环）：更新标题序号、舞台内容、缩略条高亮。 */
function galleryShow(index) {
  if (GALLERY.items.length === 0) return;
  var total = GALLERY.items.length;
  var next = ((index % total) + total) % total;
  GALLERY.index = next;
  var item = GALLERY.items[next];
  var modalId = GALLERY.modalId;
  var nameEl = document.getElementById(modalId + '-name');
  if (nameEl) nameEl.textContent = (item.name || '') + ' · ' + (next + 1) + '/' + total;
  fillPreview(modalId + '-body', item.kind, item.url, item.name);
  var strip = document.getElementById(modalId + '-strip');
  if (strip) {
    Array.prototype.slice.call(strip.children).forEach(function (el, i) {
      el.classList.toggle('on', i === next);
    });
  }
  var hint = document.getElementById(modalId + '-hint');
  if (hint) hint.hidden = false;
}
function galleryStep(delta) {
  if (GALLERY.items.length < 2) return;
  galleryShow(GALLERY.index + delta);
}
function closePreviewModal(modalId) {
  var body = document.getElementById(modalId + '-body');
  if (body) body.innerHTML = ''; // 清空以停止播放
  var modal = document.getElementById(modalId);
  if (modal) modal.hidden = true;
  var strip = document.getElementById(modalId + '-strip');
  if (strip) { strip.hidden = true; strip.innerHTML = ''; }
  GALLERY.items = [];
  document.documentElement.classList.remove('lb-open');
  VIEW.dragging = false;
}
function bindPreviewEvents(modalId) {
  var modal = document.getElementById(modalId);
  var stage = document.getElementById(modalId + '-body');
  if (!modal || !stage) return;
  // 滚轮：以光标为锚点缩放（图在遮罩内放大，遮罩本身不动）
  modal.addEventListener('wheel', function (event) {
    if (modal.hidden || !viewImg()) return;
    event.preventDefault();
    viewZoomBy(event.deltaY < 0 ? 1.12 : 1 / 1.12, event.clientX, event.clientY);
  }, { passive: false });
  stage.addEventListener('pointerdown', function (event) {
    if (!viewImg() || event.button !== 0) return;
    VIEW.dragging = true; VIEW.moved = false;
    VIEW.sx = event.clientX - VIEW.x; VIEW.sy = event.clientY - VIEW.y;
    stage.classList.add('grabbing');
    try { stage.setPointerCapture(event.pointerId); } catch (error) {}
    event.preventDefault();
  });
  stage.addEventListener('pointermove', function (event) {
    if (!VIEW.dragging) return;
    var nx = event.clientX - VIEW.sx;
    var ny = event.clientY - VIEW.sy;
    if (Math.abs(nx - VIEW.x) > 3 || Math.abs(ny - VIEW.y) > 3) VIEW.moved = true;
    VIEW.x = nx; VIEW.y = ny;
    viewClamp();
    viewApply();
  });
  var endDrag = function (event) {
    if (!VIEW.dragging) return;
    VIEW.dragging = false;
    stage.classList.remove('grabbing');
    try { stage.releasePointerCapture(event.pointerId); } catch (error) {}
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  // 点遮罩空白（且没拖动过）关闭
  stage.addEventListener('click', function (event) {
    if (event.target === stage && !VIEW.moved) closePreviewModal(modalId);
  });
  stage.addEventListener('dblclick', function (event) {
    if (!viewImg() || event.target.tagName !== 'IMG') return;
    if (VIEW.scale > VIEW.fitScale * 1.02) viewFit(); else viewActual();
  });
  modal.addEventListener('click', function (event) {
    var target = event.target && event.target.closest ? event.target.closest('[data-zoom]') : null;
    if (target) {
      var action = target.getAttribute('data-zoom');
      if (action === 'in') viewZoomBy(1.25);
      else if (action === 'out') viewZoomBy(1 / 1.25);
      else if (action === 'one') viewActual();
      else viewFit();
      return;
    }
    var stripItem = event.target && event.target.closest ? event.target.closest('[data-strip-index]') : null;
    if (stripItem) {
      galleryShow(Number(stripItem.getAttribute('data-strip-index')) || 0);
      return;
    }
    if (event.target && event.target.id === modalId + '-close') closePreviewModal(modalId);
  });
  document.addEventListener('keydown', function (event) {
    if (modal.hidden) return;
    if (event.key === 'Escape') { closePreviewModal(modalId); return; }
    if (event.key === 'ArrowLeft') { galleryStep(-1); return; }
    if (event.key === 'ArrowRight') { galleryStep(1); return; }
    if (!viewImg()) return;
    if (event.key === '+' || event.key === '=') viewZoomBy(1.2);
    else if (event.key === '-' || event.key === '_') viewZoomBy(1 / 1.2);
    else if (event.key === '0') viewFit();
    else if (event.key === '1') viewActual();
  });
  window.addEventListener('resize', function () {
    if (!modal.hidden && viewImg()) viewFit();
  });
}
`

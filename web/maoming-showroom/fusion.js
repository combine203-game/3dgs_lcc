/* ============================================================
 * maoming-showroom · SPA 融合层（四个楼层共用一个文档）
 *
 * 架构要点（2026-11-10 重构）：
 *   ① 单入口 index.html，楼层用 ?view= 表达（刷新不会落到不存在的 HTML）；
 *      楼层内容拆成 views/*.html + views/*.css，用 History API 无刷新切换，
 *      Tailwind JIT / vendor / fusion / 控制台 / 小地图全程只初始化一次。
 *   ② 3DGS Viewer iframe 按场景懒加载并常驻（floor1 / floor3 各一份）。
 *      同场景换楼层只发 mg-set-spawn（不碰 SOG）；跨场景切换只是把另一个
 *      已解码的实例切回前台并恢复 autoRender，模型永不重复下载与解码。
 *   ③ 三维导航小地图是单例，楼层变化走 setScene() 换数据，DOM 节点在
 *      视图替换时原样搬到新面板，Canvas / 事件 / ResizeObserver 不重建。
 *   ④ 全页只有一个 500ms 心跳（罗盘 + 时钟 + 状态），隐藏标签页自动休眠。
 *
 * 依赖：./vendor/*、./maoming-showroom/*、./mini-map.js、
 *       ./gs-viewer.html?embed=showroom（单入口 index.html 架构）
 * 兼容：?nocache=1 可退化为「单 iframe + 跨场景重载」低显存模式。
 * ============================================================ */
import { initMiniMap } from '../mini-map.js';

/* ---------- 楼层路由表：URL / 场景 / 出生点 / 小地图 / HUD 初值 ---------- */
const VIEWS = {
  'outdoor.html': {
    title: '室外 · 茂名展示馆线上展厅', scene: 'floor1', spawn: 'outdoor', mini: 'floor1',
    label: '室外广场 · 一层实景',
    hud: { angle: 132, distance: 12, progress: 34, coneBase: 132, coneX: 160, coneY: 202 }
  },
  'floor-1.html': {
    title: '一层 · 茂名展示馆线上展厅', scene: 'floor1', spawn: 'floor1', mini: 'floor1',
    label: '一层展厅',
    hud: { angle: 118, distance: 18, progress: 46, coneBase: 118, coneX: 153, coneY: 202 }
  },
  'floor-2.html': {
    title: '二层 · 茂名展示馆线上展厅', scene: 'floor1', spawn: 'floor1', mini: 'floor1',
    label: '二层展厅（暂用一层实景）',
    hud: { angle: 126, distance: 22, progress: 58, coneBase: 126, coneX: 153, coneY: 202 }
  },
  'floor-3.html': {
    title: '三层 · 茂名展示馆线上展厅', scene: 'floor3', spawn: 'floor3', mini: 'floor3',
    label: '三层展厅',
    hud: { angle: 204, distance: 15, progress: 68, coneBase: 204, coneX: 153, coneY: 202 }
  }
};
const DEFAULT_PAGE = 'outdoor.html';
const FRAME_CACHE = new URLSearchParams(location.search).get('nocache') !== '1';
const $ = (id) => document.getElementById(id);
const stage = () => $('stage');

const viewCache = new Map();       // page -> Promise<{html, css}>
const frames = new Map();          // scene -> iframe（常驻，不销毁）
let activeFrame = null;            // 当前前台 Viewer iframe
let activeScene = null;
let currentPage = null;
let currentCfg = VIEWS[DEFAULT_PAGE];
let mapApi = null;
let renderSeq = 0;
let hudTick = 0;
let panelYield = false;   // 右侧面板展开中，小地图需要让位（收成一条）
let userFolded = false;   // 用户自己选择的折叠状态，面板关闭后原样还原
let editorMode = false;   // 标注编辑模式：隐藏全部浏览态 HUD，只留三维 iframe + 编辑器 UI

/* 三维场景亮度：与 iframe 内 app.js::__mgBrightness 共用同一 localStorage，
   常驻的 floor1 / floor3 两个 Viewer 实例都要同步。 */
const BRIGHT_KEY = 'gsBrightness';
const BRIGHT_MIN = 0.4, BRIGHT_MAX = 1.8;
let brightness = readBrightness();
let brightnessPanel = null;

/* 楼层导览自动跟随：只在「室外 / 一层」同场景自由漫游时按相机位置判定 */
let autoFloorHoldUntil = 0;     // 自动跟随冷却截止时间戳（ms），与心跳频率解耦
let autoFloorStreak = 0;
let autoFloorCandidate = null;

function pageFromPath() {
  // 单入口 index.html：楼层用 ?view= 表达，刷新不会落到不存在的 HTML
  const f = (new URLSearchParams(location.search).get('view') || DEFAULT_PAGE).toLowerCase();
  return VIEWS[f] ? f : DEFAULT_PAGE;
}

/* ---------- 视图片段：一次 fetch，之后走内存缓存 ---------- */
function getView(page) {
  if (viewCache.has(page)) return viewCache.get(page);
  const cssFile = './maoming-showroom/views/' + page.replace(/\.html$/, '.css');
  const p = Promise.all([
    fetch('./maoming-showroom/views/' + page).then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' · views/' + page);
      return r.text();
    }),
    fetch(cssFile).then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' · ' + cssFile);
      return r.text();
    })
  ]).then(([html, css]) => ({ html, css }));
  viewCache.set(page, p);
  return p;
}
function prefetchViews() {
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 2500));
  idle(() => {
    Object.keys(VIEWS).forEach((p) => { if (!viewCache.has(p)) getView(p).catch(() => {}); });
  }, { timeout: 8000 });
}

/* ---------- 与前台 Viewer iframe 通信（同源，直接读 contentWindow） ---------- */
function win() { try { return activeFrame && activeFrame.contentWindow; } catch (_) { return null; } }
function idoc() { try { return activeFrame && activeFrame.contentDocument; } catch (_) { return null; } }
function pose() { try { return win()?.__mgPose?.() || null; } catch (_) { return null; } }
function click(id) {
  const el = idoc()?.getElementById(id);
  if (!el) { toast('三维场景尚未就绪，请稍候再试'); return false; }
  el.click();
  return true;
}
function press(k) {
  const w = win();
  if (!w) { toast('三维场景尚未就绪，请稍候再试'); return; }
  try { w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true })); }
  catch (_) { /* 忽略跨 realm 构造差异 */ }
}
function toggleCheck(id) {
  const d = idoc(), w = win();
  const el = d?.getElementById(id);
  if (!el || !w) { toast('三维场景尚未就绪，请稍候再试'); return; }
  el.checked = !el.checked;
  el.dispatchEvent(new w.Event('change', { bubbles: true }));
  toast('已切换：' + id);
}
function toast(msg) {
  try { if (typeof window.showToast === 'function') { window.showToast(msg); return; } } catch (_) { /* noop */ }
  const t = $('toast'), x = $('toastText');
  if (t && x) { x.textContent = msg; t.classList.remove('hidden'); }
  console.log('[showroom-fusion]', msg);
}

/* ---------- 1. 常驻三维实景：按场景懒加载，切换只换前台 ---------- */
function ensureFrame(scene, spawn) {
  let f = frames.get(scene);
  if (f) return f;
  f = document.createElement('iframe');
  f.className = 'gs-scene-frame';
  f.id = frames.size === 0 ? 'gsFrame' : 'gsFrame-' + scene;
  f.title = '3DGS 全屏三维实景 · ' + scene;
  f.setAttribute('allow', 'fullscreen; clipboard-write');
  f.dataset.scene = scene;
  f.src = './gs-viewer.html?embed=showroom&scene=' + scene + '&spawn=' + spawn;
  f.addEventListener('load', () => {
    // 新 Viewer 实例要从当前亮度起渲染（app.js 也会自己读 localStorage，
    // 这里再发一次，覆盖「脚本尚未执行完」的窗口）
    try {
      f.contentWindow?.postMessage({ type: 'mg-set-brightness', value: brightness }, '*');
    } catch (_) { /* noop */ }
    setTimeout(syncStatus, 900);
    // 引擎首帧 / gsplat 流加载会把 autoRender 重新打开；若此时已退到后台，补一次暂停
    setTimeout(() => {
      if (f.dataset.active !== '1') {
        try { f.contentWindow?.__mgEmbed?.setPaused?.(true); } catch (_) { /* noop */ }
      }
    }, 3500);
  });
  // 挂到 #viewport（而不是 16:9 的 #stage）：三维实景铺满整个视口，
  // 宽屏 / 超宽屏下不再出现左右黑边；HUD 仍留在 #stage 里按设计稿缩放。
  const host = $('viewport') || stage();
  host.insertBefore(f, host.firstChild);
  frames.set(scene, f);
  return f;
}
function setActiveFrame(scene, spawn) {
  const target = ensureFrame(scene, spawn);
  // 低显存模式：只保留一个 iframe，仅「跨场景」才改 src 重载（父文档仍不刷新）
  if (!FRAME_CACHE && activeScene && activeScene !== scene) {
    frames.forEach((f, s) => {
      if (s !== scene) { f.remove(); frames.delete(s); }
    });
    const want = './gs-viewer.html?embed=showroom&scene=' + scene + '&spawn=' + spawn;
    if (target.getAttribute('src') !== want) target.src = want;
  }
  frames.forEach((f, s) => {
    const on = s === scene;
    f.dataset.active = on ? '1' : '0';
    try { f.contentWindow?.__mgEmbed?.setPaused?.(!on); } catch (_) { /* noop */ }
  });
  activeFrame = target;
  activeScene = scene;
  // 同场景换楼层 / 切回已加载场景：只改出生点，不重新拉取 SOG
  try { target.contentWindow?.postMessage({ type: 'mg-set-spawn', spawn }, '*'); }
  catch (_) { /* noop */ }
  if (editorMode) editorSend('mg-editor-enter', target);
}

/* ---------- 2. 单例三维导航小地图 ---------- */
function ensureMiniMap(cfg) {
  if (mapApi) return;
  const box = document.querySelector('.mini-map');
  if (!box) return;
  const mm = document.createElement('aside');
  mm.id = 'mg-minimap';
  mm.className = 'fusion-mm';
  mm.setAttribute('aria-label', '三维导航小地图');
  mm.innerHTML =
    '<div class="mg-mm-hd">' +
      '<b>三维导览</b><span class="mg-mm-scene" id="mg-mm-scene"></span>' +
      '<button type="button" id="mg-mm-follow" title="跟随相机">跟随</button>' +
      '<button type="button" id="mg-mm-mode" title="切换 3D / 俯视">3D</button>' +
      '<button type="button" id="mg-mm-wall" title="玻璃墙 / 线框墙">玻璃</button>' +
      '<button type="button" id="mg-mm-reset" title="复位视角">⌖</button>' +
      '<button type="button" id="mg-mm-min" title="折叠 / 展开">—</button>' +
    '</div>' +
    '<canvas id="mg-mm-canvas"></canvas>' +
    '<div class="mg-mm-ft"><span id="mg-mm-pos">等待相机…</span>' +
    '<span id="mg-mm-zone">载入导航图…</span></div>';
  box.appendChild(mm);
  mapApi = initMiniMap({
    scene: cfg.mini,
    getPose: pose,
    label: cfg.label,
    base: './sog/'
  });
  // 与 Viewer 的 __mgPose / __mgEmbed 一致，暴露只读状态供控制台与回归脚本使用
  window.__mgMiniMap = mapApi;
  // mini-map.js 先注册了折叠按钮，这里补一个后置监听同步外层容器
  $('mg-mm-min')?.addEventListener('click', () => setTimeout(onMiniMapFoldClick, 0));
  syncMiniMapHost();
  if (panelYield) setMapFold(true);
}

/* ---------- 2b. 小地图与外层导览面板：折叠 / 隐藏状态始终同步 ----------
   融合时 #mg-minimap 是注入到展厅 .mini-map 里的；只折叠内层会留下一个
   218px 的空框。这里把状态映射到外层 aside.hud-panel，让它一起收成一条。 */
function syncMiniMapHost() {
  const mm = $('mg-minimap');
  if (!mm) return;
  const panel = mm.closest('.mini-map')?.closest('aside.hud-panel');
  if (!panel) return;
  const folded = mm.classList.contains('mg-mm-fold');
  panel.classList.add('gs-mm-panel');
  panel.classList.toggle('gs-mm-folded', folded);
  panel.classList.toggle('gs-mm-hidden', mm.classList.contains('mg-mm-hide'));
  const btn = $('mg-mm-min');
  if (btn) btn.textContent = folded ? '＋' : '—';
}
/* 统一走 mini-map.js 自带的折叠按钮，保证展开时 Canvas 重新 resize */
function setMapFold(folded) {
  const mm = $('mg-minimap');
  if (!mm) return;
  if (mm.classList.contains('mg-mm-fold') !== folded) $('mg-mm-min')?.click();
  syncMiniMapHost();
}
function onMiniMapFoldClick() {
  const mm = $('mg-minimap');
  if (!mm) return;
  const folded = mm.classList.contains('mg-mm-fold');
  if (panelYield && !folded) {
    // 用户在面板展开期间主动展开小地图 → 收起右侧面板，保持小地图可见
    closeRightPanels();
    panelYield = false;
  } else if (!panelYield) {
    userFolded = folded;
  }
  syncMiniMapHost();
}
/* 右侧面板与小地图互斥：面板展开时小地图收成一条，关闭后还原用户选择 */
function yieldMapForPanels(on) {
  panelYield = on;
  setMapFold(on ? true : userFolded);
}
function anyRightPanelOpen() {
  const c = $('gs-console'), s = $('speedPanel');
  return (c && !c.hidden) || (s && !s.classList.contains('hidden')) ||
    (brightnessPanel && !brightnessPanel.hidden);
}
function closeRightPanels() {
  const c = $('gs-console');
  if (c && !c.hidden) { c.hidden = true; $('gsConsoleBtn')?.classList.remove('is-on'); }
  try { window.hideOverlay?.('speedPanel', 'block'); } catch (_) { /* noop */ }
  if (brightnessPanel && !brightnessPanel.hidden) {
    brightnessPanel.hidden = true;
    $('gsBrightnessBtn')?.classList.remove('is-on');
  }
}

function hideStaticArt(root) {
  root.querySelectorAll('svg.scene-svg').forEach((s) => { s.style.display = 'none'; });
  const panel = root.querySelector('.mini-map');
  if (panel) {
    panel.querySelectorAll(':scope > svg').forEach((s) => { s.style.display = 'none'; });
    panel.querySelectorAll('div').forEach((d) => {
      if (d.children.length === 0 && d.textContent.indexOf('建筑白膜') >= 0) {
        d.textContent = '3DGS 实景 · 实时跟随';
      }
    });
  }
}

/* ---------- 2c. 三维场景亮度：右上角第 6 个按钮 + 滑杆面板 ----------
   filter 只落在 iframe 内 PlayCanvas 的 WebGL canvas 上（app.js 实现），
   因此导览界面、Viewer 工具条、三维锚定标签都不会跟着变暗。 */
function readBrightness() {
  try {
    const v = parseFloat(localStorage.getItem(BRIGHT_KEY));
    return Number.isFinite(v) ? Math.min(BRIGHT_MAX, Math.max(BRIGHT_MIN, v)) : 1;
  } catch (_) { return 1; }
}
function brightnessLabel(v) { return Math.round(v * 100) + '%'; }
function applyBrightness(v, quiet) {
  brightness = Math.round(Math.min(BRIGHT_MAX, Math.max(BRIGHT_MIN, Number(v) || 1)) * 100) / 100;
  try { localStorage.setItem(BRIGHT_KEY, String(brightness)); } catch (_) { /* noop */ }
  const filter = Math.abs(brightness - 1) < 0.005 ? '' : `brightness(${brightness})`;
  frames.forEach((f) => {
    try {
      const w = f.contentWindow;
      if (w?.__mgBrightness?.set) w.__mgBrightness.set(brightness);
      else w?.postMessage({ type: 'mg-set-brightness', value: brightness }, '*');
      // 模块尚未执行完时直接兜一层，随后消息会覆盖成同一个值
      f.contentDocument?.querySelectorAll('#mg-stage canvas').forEach((c) => {
        c.style.filter = filter;
      });
    } catch (_) { /* noop */ }
  });
  const val = $('gsBrightValue'); if (val) val.textContent = brightnessLabel(brightness);
  const st = $('gsBrightState'); if (st) st.textContent = brightnessLabel(brightness);
  const range = $('gsBrightRange');
  if (range && Number(range.value) !== brightness) range.value = String(brightness);
  document.querySelectorAll('.gs-bright-chip').forEach((b) => {
    b.classList.toggle('is-current',
      Math.abs(parseFloat(b.dataset.value) - brightness) < 0.005);
  });
  $('gsBrightnessBtn')?.classList.toggle('is-on', Math.abs(brightness - 1) > 0.005);
  if (!quiet) toast('三维场景亮度：' + brightnessLabel(brightness));
  syncStatus();
  return brightness;
}
function toggleBrightnessPanel(force) {
  const p = brightnessPanel;
  if (!p) return;
  const show = force === undefined ? p.hidden : !!force;
  if (show) {
    // 右侧面板互斥：速度面板 / 三维功能控制台先收起
    const c = $('gs-console'); if (c) c.hidden = true;
    $('gsConsoleBtn')?.classList.remove('is-on');
    try { window.hideOverlay?.('speedPanel', 'block'); } catch (_) { /* noop */ }
  }
  p.hidden = !show;
  $('gsBrightnessBtn')?.classList.toggle('is-on', show);
  yieldMapForPanels(anyRightPanelOpen());
}
function mountBrightness() {
  const st = stage();
  if (!st) return;
  // 插到右上角工具条最前面：与参考图新增按钮的标注位置一致
  const bar = document.querySelector('#view-root .tool-btn')?.parentElement;
  if (bar && !$('gsBrightnessBtn')) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'gsBrightnessBtn';
    btn.className = 'tool-btn';
    btn.setAttribute('aria-label', '亮度调节');
    btn.innerHTML =
      '<iconify-icon width="22" height="22" icon="ph:brightness"></iconify-icon>' +
      '<span class="label">亮度调节</span>';
    btn.addEventListener('click', () => toggleBrightnessPanel());
    bar.insertBefore(btn, bar.firstChild);
  }
  if (!brightnessPanel) {
    const p = document.createElement('section');
    p.id = 'gsBrightPanel';
    p.className = 'hud-panel gs-bright-panel';
    p.hidden = true;
    p.innerHTML =
      '<div class="gs-bright-hd"><div><b>场景亮度</b>' +
        '<small>SCENE EXPOSURE / 3DGS</small></div>' +
        '<div class="gs-bright-val" id="gsBrightValue">100%</div></div>' +
      '<input class="gs-bright-range" id="gsBrightRange" type="range" ' +
        'min="0.4" max="1.8" step="0.05" value="1" aria-label="三维场景亮度">' +
      '<div class="gs-bright-scale"><span>40% 偏暗</span><span>100% 标准</span>' +
        '<span>180% 高亮</span></div>' +
      '<div class="gs-bright-chips">' +
        '<button type="button" class="gs-bright-chip" data-value="0.7">偏暗 70%</button>' +
        '<button type="button" class="gs-bright-chip" data-value="1">标准 100%</button>' +
        '<button type="button" class="gs-bright-chip" data-value="1.3">提亮 130%</button>' +
        '<button type="button" class="gs-bright-chip" data-value="1.6">高亮 160%</button>' +
      '</div>' +
      '<div class="gs-bright-tip">仅调整三维实景画面整体亮度；导览界面、' +
        '工具条与展厅标签保持原清晰度。设置自动记忆，切换楼层不会重置。</div>';
    st.appendChild(p);   // 挂 #stage：视图片段替换不会销毁面板
    brightnessPanel = p;
    p.querySelector('#gsBrightRange')?.addEventListener('input', (e) =>
      applyBrightness(e.target.value, true));
    p.querySelector('#gsBrightRange')?.addEventListener('change', (e) =>
      applyBrightness(e.target.value, false));
    p.querySelectorAll('.gs-bright-chip').forEach((b) => {
      b.addEventListener('click', () => applyBrightness(b.dataset.value, false));
    });
  }
  applyBrightness(brightness, true);
}

/* ---------- 2d. 楼层导览自动跟随相机 ----------
   室外与一层共用同一份 floor1 SOG / 小地图：用户用 WASD 从广场走进大厅时，
   楼层导览要自己把「当前」从室外切到一层，反之亦然。这里只改 HUD 高亮 /
   文案 / 地址栏，绝不调用 renderView（那会发 mg-set-spawn 把正在自由漫游
   的相机拽回出生点），也不重建 iframe / 小地图。 */
const FLOOR_LABEL = { 'outdoor.html': '室外', 'floor-1.html': '一层' };
/* 自动切换时同步左下场景说明，避免「人在一层、说明还写着馆前广场」。
   只改文字节点，不重建视图片段、不触碰 iframe / 小地图 / 相机。 */
const FLOOR_CAPTION = {
  'outdoor.html': {
    eyebrow: 'SCENE 01 / OUTDOOR', title: '馆前广场 · 滨海之门',
    text: '潮汐步道从城市海岸延伸至展示馆主入口，曲面屋面与海面共同构成茂名的滨海天际。',
    minutes: '建议 15 分钟', extra: '室外 26°C · 海风 3 级'
  },
  'floor-1.html': {
    eyebrow: 'SCENE 02 / FLOOR 01', title: '一层 · 城市序章',
    text: '从好心茂名到滨海绿城，环形屏幕与光影沙盘共同展开城市总规、海岸线变迁与未来生活。',
    minutes: '建议 25 分钟', extra: '当前人流 舒适'
  }
};
function syncFloorCaption(page) {
  const c = FLOOR_CAPTION[page];
  const box = document.querySelector('.scene-caption');
  if (!c || !box) return;
  const eb = box.querySelector('.eyebrow'); if (eb) eb.textContent = c.eyebrow;
  const h = box.querySelector('h2'); if (h) h.textContent = c.title;
  const p = box.querySelector('p'); if (p) p.textContent = c.text;
  const row = [...box.querySelectorAll('div')]
    .find((d) => d.querySelector('iconify-icon[icon="ph:clock"]'));
  if (row) {
    const spans = row.querySelectorAll('span');
    const first = spans[0];
    if (first) {
      const icon = first.querySelector('iconify-icon');
      first.textContent = c.minutes;
      if (icon) first.insertBefore(icon, first.firstChild);
    }
    const last = spans[spans.length - 1];
    if (last && last !== first) last.textContent = c.extra;
  }
}
function detectFloorZone() {
  if (activeScene !== 'floor1') return null;
  // 小地图 nav-map / floor-plan 尚未加载完（state.ready=false）时，rooms 数据
  // 处于未稳定态，此刻判定会把室内出生点误判成「室外」并触发楼层切换。
  // 数据未就绪则不覆盖当前楼层页（首屏已由 URL 置为正确楼层），等 ready
  // 后再由相机驱动跟随，彻底消除加载初期闪「室外」再跳「一层」的竞态。
  if (!mapApi?.getState?.().ready) return null;
  const p = pose();
  if (!p?.position) return null;
  const [x, , z] = p.position;
  // 直接用相机世界坐标与 nav-map.json 的房间几何判定，不读小地图的
  // state.room / component：那是渲染循环的产物，跨场景切回来时可能残留
  // 上一层的房间名，会把刚进室外的相机误判成室内。
  const rooms = mapApi?.data?.rooms;
  if (!Array.isArray(rooms) || !rooms.length) return null;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  let indoor = false;
  for (const room of rooms) {
    for (const r of room.rects || []) {
      if (x >= r[0] && x <= r[2] && z >= r[1] && z <= r[3]) { indoor = true; break; }
      x0 = Math.min(x0, r[0]); z0 = Math.min(z0, r[1]);
      x1 = Math.max(x1, r[2]); z1 = Math.max(z1, r[3]);
    }
    if (indoor) break;
  }
  // 门洞 / 连廊不在房间矩形里，留 1.5m 缓冲仍按室内算；
  // 室外出生点 (0, 0) 与室内区 z≈10 起相距足够远，不会误判。
  if (!indoor && Number.isFinite(x0) &&
      x >= x0 - 1.5 && x <= x1 + 1.5 && z >= z0 - 1.5 && z <= z1 + 1.5) {
    indoor = true;
  }
  return indoor ? 'floor-1.html' : 'outdoor.html';
}
function applyFloorHighlight(page) {
  if (!VIEWS[page] || page === currentPage) return false;
  markActiveNav(page);
  const label = FLOOR_LABEL[page];
  const hf = $('gsCurrentFloor'); if (hf) hf.textContent = label;
  const mf = $('gsMapFloor'); if (mf) mf.textContent = '当前位置 · ' + label;
  syncFloorCaption(page);
  document.title = VIEWS[page].title;
  document.documentElement.dataset.gsView = page.replace(/\.html$/, '');
  try { history.replaceState({ page }, '', '?view=' + page); } catch (_) { /* noop */ }
  currentPage = page;
  currentCfg = VIEWS[page];       // 仅状态栏展示用，scene/spawn 不会被再次应用
  return true;
}
function autoFloorFollow() {
  if (editorMode) return;                        // 编辑模式下 WASD 漫游不得触发切楼层
  if (Date.now() < autoFloorHoldUntil) return;   // 冷却期内不覆盖楼层页
  if (currentPage !== 'outdoor.html' && currentPage !== 'floor-1.html') return;
  const zone = detectFloorZone();
  if (!zone || zone === currentPage) {
    autoFloorStreak = 0; autoFloorCandidate = null; return;
  }
  if (autoFloorCandidate !== zone) { autoFloorCandidate = zone; autoFloorStreak = 0; }
  autoFloorStreak += 1;
  // 连续 3 次心跳（1.5s）判定一致才切，避免门洞 / 墙边来回抖动
  if (autoFloorStreak >= 3) {
    autoFloorStreak = 0; autoFloorCandidate = null;
    applyFloorHighlight(zone);
  }
}

/* ---------- 3. Viewer 全部功能 -> 展厅页按钮 ---------- */
function setViewerSpeed(v) {
  const d = idoc(), w = win();
  if (!d || !w) { toast('三维场景尚未就绪，请稍候再试'); return; }
  const value = Math.max(0.25, Math.min(4, Number(v) || 1));
  try { w.__mgControls?.setScale?.(value); } catch (_) { /* noop */ }
  const range = d.getElementById('mg-speed');
  if (range) {
    range.value = String(value);
    range.dispatchEvent(new w.Event('input', { bubbles: true }));
  }
  syncStatus();
}
function toggleMap() {
  if (!mapApi) { toast('导览小地图正在载入'); return; }
  const on = mapApi.toggle();
  $('gsMapBtn')?.classList.toggle('is-on', on);
  syncMiniMapHost();          // 隐藏时外层导览面板同步隐藏，不留空框
  if (on && anyRightPanelOpen()) yieldMapForPanels(true);
  toast(on ? '三维导览小地图已显示' : '三维导览小地图已隐藏');
  syncStatus();
}
function navigate(page) {
  if (!VIEWS[page] || editorMode) return;        // 编辑模式锁定楼层，避免 iframe 被换掉
  if (page === currentPage) { toggleConsole(false); return; }
  // 手动选楼层后给自动跟随 8 秒冷却：等相机被 setSpawn 送到目标出生点，
  // 避免刚点完就被「旧位置」把导览高亮拉回去。
  autoFloorHoldUntil = Date.now() + 8000;
  autoFloorStreak = 0; autoFloorCandidate = null;
  history.pushState({ page }, '', '?view=' + page);
  renderView(page);
}
function openHelp() {
  closeRightPanels();
  if (panelYield) yieldMapForPanels(false);
  try { window.showOverlay?.('helpModal', 'flex'); } catch (_) { /* noop */ }
  toast('操作说明：鼠标拖动旋转 / 滚轮缩放 / WASD 漫游 / R 复位 / F 取景');
}
async function copyLan() {
  let d = null;
  try { d = await fetch('./__server_info.json').then((r) => r.ok ? r.json() : null); }
  catch (_) { /* 静态服务可能没有该端点 */ }
  const url = (d && (d.lanUrl || d.localUrl)) ||
    (location.href.split('?')[0]);
  let ok = false;
  try { await navigator.clipboard.writeText(url); ok = true; } catch (_) { /* 非安全上下文 */ }
  toast((ok ? '已复制局域网地址：' : '局域网地址：') + url);
}
function fixedClean() {
  toast('当前部署包固定加载「已清理模糊点」版，无需切换（原始版未打包）');
}
function syncStatus() {
  const el = $('gs-status');
  if (!el) return;
  const w = win();
  const c = w?.__mgControls?.getState?.();
  const r = w?.__mgRenderer;
  const m = mapApi?.getState?.();
  const p = pose();
  el.innerHTML =
    '<b>渲染</b> ' + (r?.renderer || '检测中') +
    ' · <b>碰撞</b> ' + (c ? (c.collisionOn ? '开' : '关') : '载入中') +
    ' · <b>速度</b> ' + (c ? Number(c.scale).toFixed(2) : '1.00') + '×' +
    ' · <b>小地图</b> ' + (m ? (m.visible ? '开' : '关') : '—') +
    '<br><b>场景</b> ' + currentCfg.label +
    ' · <b>相机</b> ' + (p ? p.position.map((v) => v.toFixed(1)).join(', ') : '载入中…') +
    ' · <b>缓存</b> ' + frames.size + ' 个三维实例' +
    ' · <b>亮度</b> ' + brightnessLabel(brightness);
}

/* 功能清单：三维查看器顶栏 / 工具箱 / 帮助里的每一项都有对应按钮 */
const GROUPS = [
  { title: '视图 / 相机', items: [
    ['场景亮度调节', () => toggleBrightnessPanel(true)],
    ['亮度重置 100%', () => applyBrightness(1)],
    ['重置相机 R', () => { press('r'); toast('已重置相机到出生点'); }],
    ['自动取景 F', () => { press('f'); toast('已自动取景（全景）'); }],
    ['全屏 F11', () => { try { window.toggleFullscreen?.(); } catch (_) {} }],
    ['碰撞开关 C', () => { click('mg-collision'); setTimeout(syncStatus, 120); }],
    ['小地图 M', () => toggleMap()],
    ['小地图跟随', () => { const s = mapApi?.getState?.(); mapApi?.setFollow?.(!s?.follow); toast('已切换跟随'); }],
    ['3D / 俯视', () => { const s = mapApi?.getState?.(); mapApi?.setMode?.(s?.mode === '3d' ? 'top' : '3d'); }],
    ['玻璃 / 线框', () => { const s = mapApi?.getState?.(); mapApi?.setWallStyle?.(s?.wallStyle === 'glass' ? 'flat' : 'glass'); }],
    ['小地图复位', () => mapApi?.reset?.()],
    ['地图放大 +', () => { const s = mapApi?.getState?.(); mapApi?.setZoom?.((s?.zoom || 1) * 1.3); }],
    ['地图缩小 −', () => { const s = mapApi?.getState?.(); mapApi?.setZoom?.((s?.zoom || 1) / 1.3); }],
    ['折叠 / 展开', () => $('mg-mm-min')?.click()]
  ] },
  { title: '场景 / 出生点', items: [
    ['1层室外 1', () => navigate('outdoor.html')],
    ['1层室内 2', () => navigate('floor-1.html')],
    ['二层（平面图）', () => navigate('floor-2.html')],
    ['三层室内 3', () => navigate('floor-3.html')],
    ['设为出生点', () => { click('mg-save-spawn'); toast('已把当前相机设为出生点'); }],
    ['复制位姿 URL', () => click('mg-copy-spawn')],
    ['恢复默认机位', () => { click('mg-reset-spawn'); toast('已恢复内置出生点'); }]
  ] },
  { title: '漫游 / 录制', items: [
    ['录制 / 停止 L', () => click('mg-route-rec')],
    ['播放路线 P', () => click('mg-route-play')],
    ['停止播放', () => click('mg-route-stop')],
    ['播放链接', () => click('mg-route-copy')],
    ['删除路线', () => click('mg-route-del')],
    ['导出路线 JSON', () => click('mg-route-json')],
    ['导出 WebM 视频', () => click('mg-route-video')],
    ['导入路线 JSON', () => click('mg-route-import')],
    ['循环播放', () => toggleCheck('mg-route-loop')],
    ['自动播放', () => toggleCheck('mg-route-auto')],
    ['速度 −', () => click('mg-speed-down')],
    ['速度 +', () => click('mg-speed-up')],
    ['0.5× / 1× / 2×', () => setViewerSpeed(1)],
    ['3× 快速', () => setViewerSpeed(3)]
  ] },
  { title: '碰撞体 / 调试', items: [
    ['碰撞网格 V', () => { click('mg-col-mesh'); toast('已切换碰撞网格线框'); }],
    ['分块包围盒 B', () => { click('mg-col-boxes'); toast('已切换分块包围盒'); }],
    ['刷新诊断', () => click('mg-col-refresh')],
    ['穿透显示', () => toggleCheck('mg-col-xray')],
    ['坐标系切换', () => toast('米制 Y-up 为当前生效坐标（工具面板可切换旧 log 对照）')]
  ] },
  { title: '系统 / 信息', items: [
    ['场景工具 T', () => { click('mg-tools'); toggleConsole(true); toast('已打开三维功能控制台'); }],
    ['操作说明', () => openHelp()],
    ['局域网地址', () => copyLan()],
    ['清理开关 G', () => fixedClean()],
    ['渲染器状态', () => { syncStatus(); const r = win()?.__mgRenderer; toast('渲染后端：' + (r?.renderer || '检测中')); }],
    ['刷新状态', () => syncStatus()]
  ] }
];

function buildConsole() {
  const st = stage();
  if (!st || $('gs-console')) return;
  const el = document.createElement('section');
  el.id = 'gs-console';
  el.hidden = true;
  el.innerHTML =
    '<div class="gs-hd"><div><b>三维功能控制台</b>' +
    '<small>3DGS VIEWER · 对应三维查看器全部操作</small></div>' +
    '<button type="button" class="gs-close" aria-label="关闭">×</button></div>' +
    '<div class="gs-body"></div><div class="gs-ft" id="gs-status">载入中…</div>';
  const body = el.querySelector('.gs-body');
  GROUPS.forEach((g) => {
    const sec = document.createElement('div');
    sec.className = 'gs-group';
    const h = document.createElement('h4');
    h.textContent = g.title;
    sec.appendChild(h);
    const grid = document.createElement('div');
    grid.className = 'gs-grid';
    g.items.forEach(([label, fn]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'gs-btn';
      b.textContent = label;
      b.addEventListener('click', () => { try { fn(); } catch (e) { toast('操作失败：' + e.message); } });
      grid.appendChild(b);
    });
    sec.appendChild(grid);
    body.appendChild(sec);
  });
  el.querySelector('.gs-close').addEventListener('click', () => toggleConsole(false));
  st.appendChild(el);
}
function toggleConsole(force) {
  const el = $('gs-console');
  if (!el) return;
  el.hidden = (force === undefined) ? !el.hidden : !force;
  $('gsConsoleBtn')?.classList.toggle('is-on', !el.hidden);
  if (!el.hidden) {
    // 右侧面板互斥：速度面板收起，小地图收成一条让出空间
    try { window.hideOverlay?.('speedPanel', 'block'); } catch (_) { /* noop */ }
    yieldMapForPanels(true);
    syncStatus();
  } else if (!anyRightPanelOpen()) {
    yieldMapForPanels(false);
  }
}

const ICON_CUBE = '<path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="M3 7l9 5 9-5M12 12v10"/>';
const ICON_MAP = '<path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z"/><path d="M9 3v15M15 6v15"/>';
const ICON_EDIT = '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M14 5l4 4"/>';
function quickButton(id, label, paths, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.id = id;
  b.className = 'gs-aux-btn gs-quick';
  b.setAttribute('aria-label', label);
  b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">' + paths +
    '</svg><span>' + label + '</span>';
  b.addEventListener('click', onClick);
  return b;
}
/* 右上角按参考图只保留 5 个原生按钮（速度调节 / 漫游录制 / 操作说明 /
   退出全屏 / 关闭系统）。「导览图」「三维功能」是融合层附加能力，改挂到
   左下角常驻辅助条：功能一个不丢，也不占用右上角。辅助条挂在 #stage 上，
   视图片段替换时不会被清掉；按钮 id 保持不变，供控制台 / 验证脚本使用。 */
function mountQuickBar() {
  const st = document.getElementById('stage');
  if (!st) return;
  let bar = $('gs-aux-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'gs-aux-bar';
    bar.className = 'gs-aux-bar';
    st.appendChild(bar);
  }
  bar.replaceChildren(
    quickButton('gsMapBtn', '导览图', ICON_MAP, toggleMap),
    quickButton('gsConsoleBtn', '三维功能', ICON_CUBE, () => toggleConsole()),
    quickButton('gsEditorBtn', '标注编辑', ICON_EDIT, () => enterEditor())
  );
  const m = mapApi?.getState?.();
  $('gsMapBtn')?.classList.toggle('is-on', !m || m.visible);
  $('gsConsoleBtn')?.classList.toggle('is-on', !$('gs-console')?.hidden);
}

/* 把展厅页原有的按钮接到真实三维功能上（每次视图替换后重新绑定） */
function wireExisting() {
  document.querySelectorAll('.speed-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const v = parseFloat(chip.textContent);
      if (Number.isFinite(v)) setViewerSpeed(v);
    });
  });
  const range = $('speedRange');
  if (range) range.addEventListener('input', () => setViewerSpeed(parseFloat(range.value)));

  // 速度面板与控制台 / 小地图互斥：右侧同一列不再有多个展开面板互相压盖
  document.querySelectorAll('[onclick*="toggleSpeed"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sp = $('speedPanel');
      const open = sp && !sp.classList.contains('hidden');
      if (open) {
        const c = $('gs-console');
        if (c && !c.hidden) { c.hidden = true; $('gsConsoleBtn')?.classList.remove('is-on'); }
        yieldMapForPanels(true);
      } else if (!anyRightPanelOpen()) {
        yieldMapForPanels(false);
      }
    });
  });

  $('recordBtn')?.addEventListener('click', () => {
    click('mg-route-rec');
    toast($('recordBtn')?.classList.contains('is-recording')
      ? '三维漫游录制已开始（真实相机采样）'
      : '三维漫游录制已结束并保存');
  });

  document.querySelectorAll('[onclick*="stepTour"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const forward = (btn.getAttribute('onclick') || '').indexOf('stepTour(1)') >= 0;
      if (forward) { click('mg-route-play'); toast('播放三维导览路线'); }
      else { click('mg-route-stop'); press('r'); toast('停止路线并回到出生点'); }
    });
  });

  const helpBtn = document.querySelector('[onclick*="helpModal"][onclick*="showOverlay"]');
  helpBtn?.addEventListener('click', () =>
    toast('三维场景：左键拖动旋转 / 滚轮缩放 / WASD 漫游 / R 复位 / F 取景 / C 碰撞 / M 小地图'));
}

function markActiveNav(page) {
  document.querySelectorAll('a.floor-link').forEach((a) => {
    const hit = (a.getAttribute('href') || '').split('?')[0] === page;
    a.classList.toggle('is-active', hit);
    if (hit) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
    const st = a.querySelector('.floor-state');
    if (st) st.textContent = hit ? '当前' : '可游览';
  });
}

/* ---------- 路由：一个视图替换动作，不动常驻层 ---------- */
async function renderView(page) {
  const cfg = VIEWS[page] || VIEWS[DEFAULT_PAGE];
  const seq = ++renderSeq;
  let view;
  try {
    view = await getView(page);
  } catch (e) {
    console.error('[showroom-fusion] 视图片段载入失败', e);
    toast('楼层内容载入失败，请刷新页面重试');
    // 单入口架构下不再有整页文档副本，不能跳到 ./<page>（会 404 / 循环重载）
    return;
  }
  if (seq !== renderSeq) return;    // 快速连点：丢弃过期渲染

  currentPage = page;
  currentCfg = cfg;
  // 首屏 / 跨场景加载后给自动跟随约 4 秒冷却：覆盖相机被 setSpawn 送到目标
  // 出生点的动画过程。否则出生动画途中相机短暂落在室外坐标，会被误判切走
  // （直接打开一层页面时尤其明显：会先闪「室外」再跳回「一层」）。
  // 仅在无更长的既有冷却时才设置，避免覆盖手动切楼层的 8 秒冷却。
  if (autoFloorHoldUntil <= Date.now()) autoFloorHoldUntil = Date.now() + 4000;

  // 1) 视图专属样式（16~19 KB，替换一次 <style> 内容，不新增请求）
  const cssEl = $('view-css');
  if (cssEl) cssEl.textContent = view.css;

  // 2) HUD 初值 / 标题
  document.body.dataset.view = page;
  Object.keys(cfg.hud).forEach((k) => { document.body.dataset[k] = String(cfg.hud[k]); });
  document.title = cfg.title;

  // 3) 先把小地图 DOM 原样搬进新片段，再整体替换视图
  //    （DOM 节点不销毁 → Canvas / 事件 / ResizeObserver / rAF 全部保活）
  const mm = $('mg-minimap');
  const tpl = document.createElement('div');
  tpl.innerHTML = view.html;
  const newPanel = tpl.querySelector('.mini-map');
  if (mm && newPanel) newPanel.appendChild(mm);
  else if (mm) $('gs-console')?.appendChild(mm);
  const root = $('view-root');
  root.replaceChildren(...Array.from(tpl.childNodes));

  hideStaticArt(root);
  ensureMiniMap(cfg);
  syncMiniMapHost();          // 新片段的 aside 是全新节点，重新同步折叠 / 隐藏状态
  window.Showroom?.initView?.();
  mountQuickBar();
  mountBrightness();          // 工具条是视图片段，每次换视图都要补挂按钮
  wireExisting();
  markActiveNav(page);

  // 4) 小地图换数据（同场景不重复 fetch）、三维场景换前台
  const ms = mapApi?.getState?.();
  if (ms && ms.scene !== cfg.mini) mapApi?.setScene?.(cfg.mini, cfg.label);
  setActiveFrame(cfg.scene, cfg.spawn);
  syncStatus();
  document.documentElement.dataset.gsFusion = 'on';
  document.documentElement.dataset.gsView = page.replace(/\.html$/, '');
}

/* ---------- 单个心跳：罗盘 / 时钟 / 状态，隐藏页自动休眠 ---------- */
function startHudSync() {
  setInterval(() => {
    if (document.hidden) return;
    hudTick += 1;
    if (hudTick % 2 === 0) {
      try { window.Showroom?.tickClock?.(); } catch (_) {}
      // ESC / 内联事件可能直接关闭面板，这里对账一次，避免让位状态残留
      const open = anyRightPanelOpen();
      if (open !== panelYield) yieldMapForPanels(open);
    }
    autoFloorFollow();                          // 室外 <-> 一层 导览高亮跟随相机
    const p = pose();
    if (!p) { if (hudTick % 5 === 0) syncStatus(); return; }
    const dx = p.target[0] - p.position[0];
    const dz = p.target[2] - p.position[2];
    const deg = (Math.atan2(dx, dz) * 180 / Math.PI + 360) % 360;
    const txt = String(Math.round(deg)).padStart(3, '0') + '°';
    const a = $('viewAngle'); if (a) a.textContent = txt;
    const m = $('angleMini'); if (m) m.textContent = txt;
    const n = $('compassNeedle'); if (n) n.style.transform = 'rotate(' + deg.toFixed(1) + 'deg)';
    if (hudTick % 5 === 0) syncStatus();
  }, 500);
}

/* 楼层链接一律走 History API，不产生新的文档请求 */
function wireRouter() {
  document.addEventListener('click', (e) => {
    const t = e.target;
    const a = t && t.closest ? t.closest('a[href]') : null;
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const href = a.getAttribute('href') || '';
    const page = href.split('?')[0];
    if (!VIEWS[page]) return;
    e.preventDefault();
    navigate(page);
  }, true);
  window.addEventListener('popstate', () => {
    if (editorMode) exitEditor();
    renderView(pageFromPath());
  });
}

/* ============================================================
 * 标注编辑模块：单入口 index.html 的「模式开关」
 *
 * 点击左下角「标注编辑」→ #stage 内全部浏览态 HUD 由 CSS 隐藏，
 * 全屏 3DGS iframe 保持常驻，iframe 内 editor/bridge.js 动态挂载编辑器。
 * 父子只传「进入 / 退出」指令，不跨 iframe 传屏幕坐标：编辑器与相机、
 * 碰撞 MESH 同处一个文档、一个世界坐标系。
 * ============================================================ */
function editorSend(type, frame) {
  const f = frame || activeFrame;
  if (!f) return;
  try {
    f.contentWindow?.postMessage({ type, scene: activeScene, page: currentPage }, '*');
  } catch (_) { /* iframe 尚未加载或跨域 */ }
}

function enterEditor() {
  if (editorMode) return;
  editorMode = true;
  document.documentElement.dataset.gsEditor = 'on';
  try { closeRightPanels(); } catch (_) { /* noop */ }
  autoFloorStreak = 0; autoFloorCandidate = null;
  // 先同步暂停 iframe 渲染，再发 enter 指令。
  // 原因：编辑器模块的求值必须排进 iframe 主线程的任务队列，而 3DGS 渲染
  // 循环会长时间占满它（实测大场景下单帧可达数百毫秒）。若先发 postMessage，
  // 连「消息处理器本身」都要排队等渲染空窗，延迟可达数秒；父页主线程是空闲的，
  // 直接同步调用 iframe 里的 suspendRender() 可以立刻让出主线程。
  // 停掉的只是绘制，update(dt) 照常执行，WASD 漫游与相机状态不受影响；
  // 编辑器挂载完成后 bridge 会自动恢复渲染。
  try { activeFrame?.contentWindow?.__mgEditorBridge?.suspendRender?.(); }
  catch (_) { /* noop */ }
  editorSend('mg-editor-enter');
  // WASD 由 iframe 内的 Viewer 控制器接收，键盘焦点交给三维画面
  try { activeFrame?.contentWindow?.focus(); } catch (_) { /* noop */ }
  // 编辑器模块的求值要等主线程空窗（3DGS 渲染循环占满时可能达数百毫秒），
  // 先给「加载中」提示，iframe 回报挂载完成后再提示可用。
  toast('正在装载标注编辑器…');
  syncStatus();
}

function exitEditor() {
  if (!editorMode) return;
  editorMode = false;
  document.documentElement.dataset.gsEditor = 'off';
  // 退出后给 8 秒冷却，避免漫游中的相机位置立刻把楼层导览拉走
  autoFloorHoldUntil = Date.now() + 8000;
  frames.forEach(f => editorSend('mg-editor-exit', f));
  // 兜底恢复渲染（iframe 未挂载成功时 bridge 不会自动恢复）
  frames.forEach(f => {
    try { f.contentWindow?.__mgEditorBridge?.resumeRender?.(); } catch (_) { /* noop */ }
  });
  toast('已退出标注编辑模式');
  syncStatus();
}

function wireEditor() {
  // 父页兜底退出按钮（不依赖 iframe 内编辑器是否成功挂载）
  if (!$('gs-editor-exit')) {
    const btn = document.createElement('button');
    btn.id = 'gs-editor-exit';
    btn.type = 'button';
    btn.textContent = '× 退出编辑';
    btn.title = '返回线上展厅浏览模式（Esc）';
    btn.addEventListener('click', exitEditor);
    document.body.appendChild(btn);
  }
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.type === 'mg-editor-ready') {
      // iframe 内的 bridge 可能比父页 enter 指令更早或更晚就绪
      if (editorMode) {
        try {
          e.source?.postMessage({ type: 'mg-editor-enter', scene: activeScene, page: currentPage }, '*');
        } catch (_) { /* noop */ }
      }
    } else if (d.type === 'mg-editor-exit-request') {
      exitEditor();
    } else if (d.type === 'mg-editor-mounted') {
      if (d.ok) toast('标注编辑模式 · WASD 漫游，鼠标操作编辑面板');
      else toast('标注编辑器装载失败：' + (d.error || '未知错误'));
    }
  });
  // 焦点在父页时（刚点过入口按钮）也允许 Esc 退出
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && editorMode && e.target === document.body) exitEditor();
  });
}

window.__mgEditorHost = {
  enter: enterEditor,
  exit: exitEditor,
  getState: () => ({ on: editorMode, page: currentPage, scene: activeScene })
};

/* ---------- 启动 ---------- */
function boot() {
  buildConsole();
  wireRouter();
  wireEditor();
  startHudSync();
  renderView(pageFromPath()).then(() => {
    if (window.requestIdleCallback) prefetchViews();
    else setTimeout(prefetchViews, 3000);
    // 启动服务时用 /?edit=1 可直接落在编辑态（默认 / 仍是浏览态）
    if (new URLSearchParams(location.search).get('edit') === '1') enterEditor();
  });
  // 亮度和楼层跟随的只读状态 + 手动入口，供回归脚本与现场标定使用
  window.__mgBrightnessUI = {
    get: () => brightness,
    label: () => brightnessLabel(brightness),
    set: (v) => applyBrightness(v, true),
    toggle: (on) => toggleBrightnessPanel(on),
    panelOpen: () => !!brightnessPanel && !brightnessPanel.hidden,
    canvasFilter: () => {
      try {
        return activeFrame?.contentDocument?.querySelector('#mg-stage canvas')?.style.filter || '';
      } catch (_) { return ''; }
    }
  };
  window.__mgFloorFollow = {
    getState: () => ({
      page: currentPage, scene: activeScene, zone: detectFloorZone(),
      hold: Math.max(0, autoFloorHoldUntil - Date.now()),
      active: document.querySelector('a.floor-link.is-active')?.getAttribute('href') || null,
      header: $('gsCurrentFloor')?.textContent || null,
      map: $('gsMapFloor')?.textContent || null
    }),
    detect: detectFloorZone,
    apply: applyFloorHighlight,
    releaseHold: () => { autoFloorHoldUntil = 0; }
  };
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

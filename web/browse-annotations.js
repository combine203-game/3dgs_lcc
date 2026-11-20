/**
 * 浏览态标注层 + 「场景图层」数据源
 *
 * == 需求 ==
 *   编辑器（web/editor/*）把标注持久化到 localStorage 的单一 key
 *   `mg3dgs.annotations.v1`。浏览模式此前完全不渲染这些标注。
 *   本模块在浏览态把标注**读出来画在三维画面上**，并向上提供一棵
 *   「分组 / 图层 → 标注」的树，用于逐条 / 逐组 / 逐图层控制显隐。
 *
 * == 三条硬约束 ==
 *   1. **绝不写编辑器数据**。显隐覆盖只存 `mg3dgs.browseView.v1`，
 *      编辑态的 `a.visible` / `group.visible` / `layer.visible` 原样不动。
 *      否则回归里「组级显隐不改写单条 visible」的断言会被浏览态污染。
 *   2. **编辑态必须彻底退出**。编辑器的回归断言大量依赖
 *      `.ed-item[data-id]` 只由编辑器 Overlay 产生（如 hiddenNotRendered），
 *      而本模块复用 Overlay 会产出同前缀的 DOM。因此进入编辑（bridge 派发
 *      `mg-editor-on`）时同步销毁叠加层，退出（`mg-editor-off`）后重建；
 *      叠加层额外带 `.mg-ann-layer` 类，CSS 里统一 `pointer-events:none`，
 *      浏览态不会抢走引擎的旋转 / 缩放 / 漫游手势。
 *   3. **只读**。`Overlay` 的编辑回调全部缺省，`isEditable()=false`，
 *      拖拽 / 缩放 / 吸附逻辑自然不生效。
 *
 * == 数据刷新 ==
 *   · 编辑器每次改动都整份写回同一 key，但**同一文档内写 localStorage
 *     不会触发 storage 事件**，所以退出编辑由 `mg-editor-off` 事件驱动重读；
 *   · 其它标签页 / 直接改 localStorage 的情况由 `storage` 事件 + 低频轮询
 *     兜底（只比较长度与尾部时间戳，不解析整份文档）。
 */

import { Store } from './editor/store.js';
import { Overlay } from './editor/overlay.js';
import { DEFAULT_GROUP_ID } from './editor/schema.js';
import { createDecalRuntime } from './decal-runtime.js';

const DOC_KEY = 'mg3dgs.annotations.v1';
const VIEW_KEY = 'mg3dgs.browseView.v1';
const DEFAULT_LAYER_ID = 'default';
const POLL_MS = 3000;

const KIND_NAME = {
  point: '点', line: '动线', area: '面域',
  board: '展板', screen: '实体屏', decal: '贴花', measure: '测量'
};

/* ------------------------------------------------------------------ 视图状态 */

function readView() {
  const empty = { ann: {}, group: {}, layer: {} };
  try {
    const d = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null');
    if (!d || typeof d !== 'object') return empty;
    return {
      ann: (d.ann && typeof d.ann === 'object') ? { ...d.ann } : {},
      group: (d.group && typeof d.group === 'object') ? { ...d.group } : {},
      layer: (d.layer && typeof d.layer === 'object') ? { ...d.layer } : {}
    };
  } catch (_) { return empty; }
}

function writeView(v) {
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(v)); } catch (_) { /* 隐私模式 */ }
}

/**
 * Overlay 只依赖这几个方法：list / get / layer / groupVisible / calibration。
 * 这里把「文档里的显隐」与「浏览态覆盖」合成一个每帧可直接消费的只读视图，
 * 从而完全不用改 overlay.js 的过滤逻辑。
 */
class ViewStore {
  constructor(doc, view) {
    this.doc = doc;
    this.view = view;
    this._byScene = new Map();
    this._byId = new Map();
    this._rebuild();
  }

  setDoc(doc) { this.doc = doc; this._rebuild(); }
  setView(view) { this.view = view; this._rebuild(); }

  _baseVisible(a) {
    if (a.visible === false) return false;
    const g = (this.doc.groups || []).find((x) => x.id === (a.groupId || DEFAULT_GROUP_ID));
    if (g && g.visible === false) return false;
    const l = (this.doc.layers || []).find((x) => x.id === (a.layerId || DEFAULT_LAYER_ID));
    if (l && l.visible === false) return false;
    return true;
  }

  /** 覆盖优先级：单条 > 分组 > 图层 > 编辑器里的默认值 */
  visibleOf(a) {
    const v = this.view || {};
    if (v.ann && Object.prototype.hasOwnProperty.call(v.ann, a.id)) return !!v.ann[a.id];
    const gid = a.groupId || DEFAULT_GROUP_ID;
    if (v.group && Object.prototype.hasOwnProperty.call(v.group, gid)) return !!v.group[gid];
    const lid = a.layerId || DEFAULT_LAYER_ID;
    if (v.layer && Object.prototype.hasOwnProperty.call(v.layer, lid)) return !!v.layer[lid];
    return this._baseVisible(a);
  }

  _rebuild() {
    this._byScene.clear();
    this._byId.clear();
    const list = (this.doc.annotations || []).slice().sort(
      (a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
    for (const a of list) {
      const vis = this.visibleOf(a);
      // 必须用**严格相等**判定要不要派生副本：旧文档 / 手工导入的标注往往没有
      // visible 字段（undefined），而 Overlay 内部是 `if (!a.visible) continue`，
      // 直接复用原对象会让整份标注一条都画不出来（表现为「有图层、没画面」）。
      const item = a.visible === vis ? a : { ...a, visible: vis };
      this._byId.set(a.id, item);
      if (!this._byScene.has(a.scene)) this._byScene.set(a.scene, []);
      this._byScene.get(a.scene).push(item);
    }
  }

  list(scene) {
    if (!scene) {
      const out = [];
      for (const arr of this._byScene.values()) out.push(...arr);
      return out.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
    }
    return (this._byScene.get(scene) || []).slice();
  }

  get(id) { return this._byId.get(id) || null; }

  // 显隐已在 list() 里烘焙进 visible，这里不再二次过滤
  groupVisible() { return true; }
  layer() { return null; }
  calibration() { return this.doc.calibration || { scale: 1 }; }
}

/* ------------------------------------------------------------------ 场景判定 */

/** 与 app.js 的判定保持一致：spawn 优先映射到场景，其次 ?scene=，默认三层。 */
function currentScene() {
  try {
    const s = window.__mgEmbed?.scene;
    if (s) return s;
  } catch (_) { /* noop */ }
  try {
    const q = new URLSearchParams(location.search);
    const sp = { outdoor: 'floor1', floor1: 'floor1', floor3: 'floor3' }[q.get('spawn')];
    const sc = q.get('scene');
    if (sc === 'floor1' || sc === 'floor3') return sc;
    return sp || 'floor3';
  } catch (_) { return 'floor1'; }
}

const SCENE_LABEL = { floor1: '1 层', floor3: '3 层' };

/* ------------------------------------------------------------------ 运行时 */

const state = {
  doc: null,
  view: null,
  store: null,
  scene: '',
  overlay: null,
  raf: 0,
  failAt: 0,
  sig: '',
  panel: null,
  btn: null,
  standalone: false,
  // 贴花 GPU 投射运行时（浏览态唯一负责「把视频投到场景表面」的东西）
  decal: null,
  decalTryAt: 0
};

const isEditorOn = () => {
  try { return document.documentElement.classList.contains('mg-editor-on'); }
  catch (_) { return false; }
};

function loadDoc() {
  // Store 构造只读，不会写回 localStorage（写入只发生在 _changed）
  const st = new Store();
  return st.doc;
}

function docSig() {
  try {
    const raw = localStorage.getItem(DOC_KEY) || '';
    // updatedAt 是文档最后一个字段：长度 + 尾部即可低成本判定「有没有变」
    return raw.length + '|' + raw.slice(-40);
  } catch (_) { return ''; }
}

/* ------------------------------------------------------- 叠加层（只读 Overlay） */

function ensureOverlay() {
  if (state.overlay || isEditorOn()) return null;
  if (Date.now() - state.failAt < 5000) return null;      // 出错后冷却，避免每帧刷异常
  const host = document.getElementById('mg-stage');
  if (!host) return null;
  if (!window.__viewer?.app) return null;                  // 三维场景未就绪
  if (!state.store.list(state.scene).length) return null;  // 当前场景没有标注：不铺 DOM
  const ov = new Overlay({
    host,
    getViewer: () => window.__viewer,
    store: state.store,
    getScene: () => state.scene,
    getSelected: () => null,
    getSelectedSet: () => [],
    isPreview: () => false,
    // 浏览态不按距离淡出：远景点也要看清标题
    alwaysVisible: () => true,
    isEditable: () => false,
    // 不用 isLocked：那会触发 .ed-locked 的变暗 / 去色，浏览态只需要「不可交互」
    isLocked: () => false,
    // 浏览态不画贴花辅助线框（OBB / 视锥台 / 手柄 / 占位框）：观众只看得到
    // 投射出来的视频，编辑辅助图形一律留给编辑态。
    showDecalGuides: () => false,
    onPick: () => {}
  });
  // pointer-events:none 由 CSS 统一兜住（app.css .mg-ann-layer）
  ov.layer.classList.add('mg-ann-layer');
  // 不调 ov.start()：本模块自己的 rAF 循环统一驱动 frame()，避免双份投影
  state.overlay = ov;
  return ov;
}

function teardownOverlay() {
  const ov = state.overlay;
  state.overlay = null;
  if (!ov) return;
  try { ov.destroy(); } catch (_) { /* noop */ }
}

/* ---------------------------------------------- 贴花投射（浏览态看得到视频的关键）

   背景：贴花的画面是 GPU 后处理（decal-projection.js），不是 DOM。编辑器挂载时
   由 editor.js 实例化；浏览态以前完全没有这条链路，于是「编辑里能看到投射视频，
   退出编辑就看不见」。这里让浏览层自己装配一份投射运行时：

     · 只在当前场景确实存在带 projector 的贴花时才创建（没有贴花 = 零开销，
       不会把展厅常驻页变成永动渲染）；
     · 进入编辑态立刻销毁，交给编辑器自己那份，绝不双份投射；
     · 显隐 / 数据变更（图层树开关、别的标签页改动、编辑器退出）都走 sync()。 */

function decalList() {
  return state.store ? state.store.list(state.scene) : [];
}

function hasDecals() {
  return decalList().some((a) => a.kind === 'decal' && a.visible !== false && a.projector);
}

function ensureDecalRuntime() {
  if (state.decal || isEditorOn()) return state.decal;
  if (!hasDecals()) return null;
  // 引擎 / 相机 Picker 未就绪时 500ms 重试一次，避免每帧刷异常
  const now = Date.now();
  if (now - state.decalTryAt < 500) return null;
  state.decalTryAt = now;
  const v = window.__viewer;
  if (!v?.app || !v.picker) return null;
  const rt = createDecalRuntime({
    getViewer: () => window.__viewer,
    listDecals: decalList
  });
  if (!rt.sync()) { rt.destroy(); return null; }
  state.decal = rt;
  return rt;
}

function syncDecalRuntime() {
  if (state.decal) { try { state.decal.sync(); } catch (_) { /* noop */ } }
  else ensureDecalRuntime();
}

function teardownDecalRuntime() {
  const rt = state.decal;
  state.decal = null;
  if (!rt) return;
  try { rt.destroy(); } catch (_) { /* noop */ }
}

function loop() {
  state.raf = requestAnimationFrame(loop);
  if (document.hidden) return;
  if (isEditorOn()) {                       // 双保险：桥接事件之外的兜底
    if (state.overlay) teardownOverlay();
    if (state.decal) teardownDecalRuntime();
    return;
  }
  try {
    const ov = state.overlay || ensureOverlay();
    ov?.frame();
    // 引擎 / Picker 就绪后才建：就绪前每次都会早退，代价只是一次时间戳比较
    if (!state.decal) ensureDecalRuntime();
  } catch (err) {
    state.failAt = Date.now();
    teardownOverlay();
    console.warn('[browse-ann] 叠加层渲染异常，已降级：', err);
  }
}

/* --------------------------------------------------------------- 树 / 显隐 */

function buildTree() {
  const store = state.store;
  if (!store || !state.doc) return null;
  const items = store.list(state.scene);
  const total = items.length;
  const shown = items.filter((a) => a.visible !== false).length;

  const byGroup = new Map();
  for (const a of items) {
    const gid = a.groupId || DEFAULT_GROUP_ID;
    if (!byGroup.has(gid)) byGroup.set(gid, []);
    byGroup.get(gid).push(a);
  }

  const order = (g) => (Number(g?.order) || 0);
  const groups = (state.doc.groups || []).slice().sort((a, b) => order(a) - order(b));
  // 文档里不存在对应分组定义的标注（旧数据 / 手工导入）单独成桶，避免「看不见」
  for (const gid of byGroup.keys()) {
    if (!groups.some((g) => g.id === gid)) {
      groups.push({ id: gid, name: gid === DEFAULT_GROUP_ID ? '默认分组' : gid, color: '#22d3ee' });
    }
  }

  const groupRows = groups.map((g) => {
    const arr = byGroup.get(g.id) || [];
    return {
      id: g.id,
      name: g.name || g.id,
      color: g.color || '#22d3ee',
      count: arr.length,
      visible: arr.length ? arr.some((a) => a.visible !== false) : g.visible !== false,
      items: arr.map((a) => ({
        id: a.id,
        title: a.title || KIND_NAME[a.kind] || '未命名',
        kind: a.kind,
        kindLabel: KIND_NAME[a.kind] || a.kind,
        color: a.style?.color,
        visible: a.visible !== false
      }))
    };
  });

  const layerRows = (state.doc.layers || []).map((l) => {
    const arr = items.filter((a) => (a.layerId || DEFAULT_LAYER_ID) === l.id);
    return {
      id: l.id,
      name: l.name || l.id,
      color: l.color || '#22d3ee',
      count: arr.length,
      visible: arr.length ? arr.some((a) => a.visible !== false) : l.visible !== false,
      items: []
    };
  });

  return {
    scene: state.scene,
    sceneLabel: (SCENE_LABEL[state.scene] || state.scene) + ' 浏览态',
    total,
    shown,
    groups: groupRows,
    layers: layerRows,
    editor: isEditorOn(),
    overlay: !!state.overlay
  };
}

function applyView(view) {
  state.view = view;
  writeView(view);
  state.store.setView(view);
  if (!state.store.list(state.scene).length) teardownOverlay();
  // 显隐一变，GPU 投射实例必须同步增减：否则「图层树里关掉了贴花，
  // 画面上视频还在投」。
  syncDecalRuntime();
  syncPanel();
  notifyParent('view');
}

function setVisible(kind, id, on) {
  if (!id) return null;
  const v = state.view;
  if (kind === 'group') v.group[id] = !!on;
  else if (kind === 'layer') v.layer[id] = !!on;
  else v.ann[id] = !!on;
  applyView(v);
  return buildTree();
}

function setAll(mode) {
  const v = { ann: {}, group: {}, layer: {} };
  if (mode === 'off') {
    // 全部隐藏：关掉所有分组；单条覆盖清空，避免「隐藏后仍有漏网的」
    for (const g of state.doc.groups || []) v.group[g.id] = false;
    for (const a of state.doc.annotations || []) {
      if (!v.group[a.groupId || DEFAULT_GROUP_ID]) v.group[a.groupId || DEFAULT_GROUP_ID] = false;
    }
  } else if (mode === 'on') {
    // 全部显示：分组 / 图层全开即可（清空覆盖即恢复文档默认）
    for (const g of state.doc.groups || []) v.group[g.id] = true;
    for (const l of state.doc.layers || []) v.layer[l.id] = true;
  }
  applyView(v);
  return buildTree();
}

/* ------------------------------------------------------------------ 面板 */

function syncPanel() {
  try { state.panel?.refresh?.(); } catch (_) { /* noop */ }
  if (state.btn) {
    const t = buildTree();
    const b = state.btn.querySelector('b');
    if (b && t) b.textContent = t.shown + '/' + t.total;
  }
}

function notifyParent(reason) {
  try {
    if (window.parent !== window) window.parent.postMessage({ type: 'mg-ann-changed', reason }, '*');
  } catch (_) { /* noop */ }
}
/** 编辑态开合广播：父页据此收起 / 恢复「场景图层」面板。
 *  正常流程父页 enterEditor 已自行 closeRightPanels，这里覆盖 `?edit=1`
 *  直达编辑态、以及 iframe 内独立挂载编辑器（父页没收到任何点击）的情况。 */
function notifyEditorMode(on) {
  try {
    if (window.parent !== window) window.parent.postMessage({ type: 'mg-ann-editor', on: !!on }, '*');
  } catch (_) { /* noop */ }
}

function toggleStandalonePanel(force) {
  const p = state.panel;
  if (!p) return;
  const show = force === undefined ? !p.isOpen() : !!force;
  p.setOpen(show);
  state.btn?.classList.toggle('is-on', show);
}

/** 独立打开 gs-viewer.html（没有父页 HUD）时，自己在 iframe 内建一个入口 */
function ensureStandaloneUi() {
  if (state.standalone) return;
  state.standalone = true;
  const host = document.getElementById('mg-stage');
  if (!host) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'mg-ann-btn';
  btn.className = 'mg-ann-btn';
  btn.innerHTML = '场景图层<b>0/0</b>';
  btn.addEventListener('click', () => toggleStandalonePanel());
  host.appendChild(btn);
  state.btn = btn;
  import('./browse-ann-ui.js').then(({ createAnnotationPanel }) => {
    if (state.panel) return;
    state.panel = createAnnotationPanel({
      mount: host,
      id: 'mg-ann-panel',
      style: { right: '16px', bottom: '62px', maxHeight: '64vh' },
      getTree: () => (state.store ? buildTree() : null),
      onToggle: (kind, id, on) => setVisible(kind, id, on),
      onAll: (mode) => setAll(mode),
      onRefresh: () => refreshDoc('ui'),
      onOpenChange: (open) => state.btn?.classList.toggle('is-on', open),
      emptyText: '三维场景还没就绪…'
    });
    syncPanel();
  }).catch(() => { /* 面板加载失败不影响叠加层 */ });
}

/* ------------------------------------------------------------------ 生命周期 */

function refreshDoc(reason) {
  try {
    state.doc = loadDoc();
    const view = readView();
    state.view = view;
    if (!state.store) state.store = new ViewStore(state.doc, view);
    else {
      // 文档变了：先换文档再套覆盖，避免中途用旧 groups 计算可见性
      state.store.setDoc(state.doc);
      state.store.setView(view);
    }
    state.sig = docSig();
    if (!state.store.list(state.scene).length) teardownOverlay();
    // 文档变了（编辑器刚保存 / 别的标签页改动）：投射实例跟着重喂
    syncDecalRuntime();
    syncPanel();
    notifyParent(reason || 'refresh');
  } catch (err) {
    console.warn('[browse-ann] 标注数据读取失败：', err);
  }
}

function boot() {
  state.scene = currentScene();
  refreshDoc('boot');

  document.addEventListener('mg-editor-on', () => {
    teardownOverlay();
    // 编辑器会自己建一份投射管理器：浏览态这份必须先撤，避免双份投射
    teardownDecalRuntime();
    if (state.panel) state.panel.setOpen(false);
    if (state.btn) state.btn.classList.remove('is-on');
    notifyEditorMode(true);
  });
  // 编辑器每次改动都立即整份落盘；退出时整体重读，保证「编辑里刚加的标注」
  // 回到浏览态就能看到
  document.addEventListener('mg-editor-off', () => {
    refreshDoc('editor-exit');
    notifyEditorMode(false);
  });

  window.addEventListener('storage', (e) => {
    if (!e.key || e.key === DOC_KEY || e.key === VIEW_KEY) refreshDoc('storage');
  });

  // 低频兜底：直接改 localStorage（同文档不触发 storage）时也能感知
  setInterval(() => {
    if (document.hidden || isEditorOn()) return;
    const s = docSig();
    if (s !== state.sig) { state.sig = s; refreshDoc('poll'); }
  }, POLL_MS);

  // 独立打开时（父页不存在）自建入口；展厅融合页由父页 fusion.js 挂面板
  if (window.parent === window) ensureStandaloneUi();

  state.raf = requestAnimationFrame(loop);
}

/* 对外 API：父页（展厅融合层）直接跨 iframe 读取树 / 切换显隐 */
window.__mgBrowseAnn = {
  get ready() { return !!state.store; },
  scene: () => state.scene,
  tree: () => buildTree(),
  toggle: (kind, id, on) => setVisible(kind, id, on),
  setAll: (mode) => setAll(mode),
  refresh: (reason) => refreshDoc(reason),
  openPanel: (on) => toggleStandalonePanel(on),
  /** 只读诊断：给 headless 回归确认叠加层确实建起来了 */
  stats: () => ({
    scene: state.scene,
    total: state.store ? state.store.list(state.scene).length : 0,
    shown: state.store ? state.store.list(state.scene).filter((a) => a.visible !== false).length : 0,
    overlay: !!state.overlay,
    nodes: state.overlay ? state.overlay.nodes.size : 0,
    editor: isEditorOn(),
    panel: !!(state.panel && state.panel.isOpen()),
    docSig: state.sig
  }),
  /** 贴花投射诊断：enabled / instances / pickReady / degraded / gpuErrors。
   *  浏览态「看不到投射视频」的排查入口（与编辑器 decalMgr.debug() 同口径）。 */
  decalStats: () => (state.decal ? state.decal.stats() : state.decal),
  /** 强制重喂一次投射实例（诊断 / 父页在外部改动文档后调用） */
  syncDecals: () => { syncDecalRuntime(); return 1; },
  /** DOM 断言辅助：叠加层根节点是否挂在 #mg-stage 上 */
  layerEl: () => document.querySelector('#mg-stage .mg-ann-layer') || null
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

/**
 * 3DGS 场景标注编辑器 · 主装配（可挂载 / 卸载）
 *
 * 运行位置：gs-viewer.html iframe 内（与相机、碰撞 MESH、#mg-stage 同文档），
 * 由 editor/bridge.js 在父页点「标注编辑」后动态 import 并 mount()。
 * 浏览态 gs-viewer.html / index.html 的 UI 结构一行不改。
 *
 * 交互约定：
 *   · WASD / 滚轮 / 拖拽旋转 -> 交给 Viewer 原生控制器（不抢键位）
 *   · 画布「单击 / 双击」   -> 在 #mg-stage 捕获阶段阻断，避免引擎
 *                              navigateTo / flyTo / orbitFocus 自动漫游过去；
 *                              单击改由编辑器落点，双击结束当前折线
 *   · 编辑面板上的鼠标点击   -> 完全不拦截，正常操作 UI
 *
 * 【键盘隔离原理】
 *   引擎的键盘监听全部挂在 **window 冒泡阶段**（ModeShortcuts /
 *   KeyboardMouseSource / MiniStats）。编辑器把监听挂在 **document 冒泡阶段**：
 *     document 冒泡 -> window 冒泡
 *   只要在 document 阶段调用 stopPropagation，window 上的引擎监听就收不到，
 *   而按键已经到达目标元素（输入框照常打字），两头都不误伤。
 *
 * 对外：window.__mgEditor = { store, picker, overlay, panel, getState, action, unmount }
 */
import { Store } from './store.js';
import { createPicker } from './picking.js';
import { Overlay } from './overlay.js';
import { createPanel } from './panel.js';
import { KINDS, makeAnnotation, LAYER_PALETTE, GROUP_PALETTE, DEFAULT_GROUP_ID,
  screenRectUV, buildDecalProjector, projectorOBBCorners, projectorVolumeCorners,
  buildShadowDepthMap, makeFrustumProjector, retuneFrustumProjector } from './schema.js';
import { rayHitMesh } from './mesh-pick.js';
import { createDecalProjection } from './decal-projection.js';
import { decalsForGPU } from '../decal-runtime.js';
import { resolveEngineAdapter } from '../engine/index.js';

// 直接向父页发消息，不再 import bridge.js —— 避免
// bridge -> dynamic import editor -> static import bridge 的模块环导致导入挂起。
function requestExit() {
  try { parent.postMessage({ type: 'mg-editor-exit-request' }, '*'); } catch (_) { /* noop */ }
}

/* 工具快捷键统一走 Shift+字母。
   字母刻意避开 W A S D —— 这四个键归漫游，且引擎按 event.code 判定，
   用 Shift+A 切「面」会和「Shift 加速 + A 左移」打架。 */
const SHIFT_KEYS = { V: 'select', P: 'point', L: 'line', E: 'area', B: 'board', N: 'screen',
  R: 'decal', F: 'frustum', M: 'measure' };
/* 引擎 / 宿主的单键快捷键，编辑模式下一律屏蔽（不让它抢走按键） */
const ENGINE_KEYS = new Set(['v', 'h', 'g', 'r', 'f', ' ', '1', '2', '3', '4', '5', 'p', 'l', 'b', 't', 'm']);
/* 漫游键：必须放行给引擎 */
const MOVE_KEYS = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);

const DEPTH_KEY = 'mgEditorDepthOn';
const PLANE_KEY = 'mgEditorPlaneDist';
const MESH_KEY = 'mgEditorMeshOn';
/** 工程内本地测试片源（由 viewer_stream/www/media/test.mp4 复制而来） */
const LOCAL_TEST_VIDEO = './media/test.mp4';
const TAP_PX = 5;
// 双击不再参与任何交互（左键 / 右键一律），合成双击判定常量随之移除。

let session = null;

function readBool(key, def) {
  try { const v = localStorage.getItem(key); return v === null ? def : v === '1'; }
  catch (_) { return def; }
}
function readNum(key, def) {
  try { const v = Number(localStorage.getItem(key)); return Number.isFinite(v) && v > 0 ? v : def; }
  catch (_) { return def; }
}
function writeVal(key, v) { try { localStorage.setItem(key, String(v)); } catch (_) { /* 隐私模式 */ } }

function waitViewer(timeout = 30000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (window.__viewer?.app) return resolve(window.__viewer);
      if (Date.now() - t0 > timeout) return reject(new Error('3DGS viewer 未就绪'));
      setTimeout(tick, 100);
    };
    tick();
  });
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function mount(opts = {}) {
  if (session) return session.api;
  const viewer = await waitViewer();
  const stage = document.getElementById('mg-stage');
  if (!stage) throw new Error('缺少 #mg-stage 容器');

  const scene = opts.scene || new URLSearchParams(location.search).get('scene') || 'floor1';
  const store = new Store();
  if (!store.list().length) {
    try {
      const r = await fetch('./editor/sample.json', { cache: 'no-store' });
      if (r.ok) {
        const raw = JSON.parse(await r.text());
        raw.annotations = (raw.annotations || []).map(a => makeAnnotation(a.kind, a.points, a));
        store.importText(JSON.stringify(raw));
      }
    } catch (_) { /* 无示例数据时从空文档开始 */ }
  }

  const state = {
    tool: 'select', scene, preview: false,
    activeGroupId: DEFAULT_GROUP_ID,     // 当前分组：新绘制的标注自动归入
    depthOn: readBool(DEPTH_KEY, true),
    planeDistance: readNum(PLANE_KEY, 6),
    // 透视贴花（视锥体）的布设默认值：竖直 FOV（度）/ 宽高比。
    // 远距默认取「光心 → 指向目标」的实际距离（见 finishDraft）。
    projFov: 45,
    projAspect: 16 / 9,
    // 全局「显示碰撞体 MESH」：仅编辑模式有效，退出时恢复进编辑前的值
    meshVisible: readBool(MESH_KEY, false),
    meshOverlayReady: !!window.__mgCollisionDebug,
    lastSource: '-',
    // 多选：selectedIds 为有序数组（末尾 = 主选中，属性面板编辑它）；
    // selectedId 作为 getter 兼容旧的单选逻辑（返回主选中）。
    selectedIds: [],
    get selectedId() { return this.selectedIds[this.selectedIds.length - 1] || null; },
    set selectedId(v) { this.selectedIds = v ? [v] : []; }
  };
  if (!store.group(state.activeGroupId)) state.activeGroupId = store.groups()[0]?.id || DEFAULT_GROUP_ID;
  let draft = [];
  let draftScreen = [];                  // 与 draft 平行的屏幕点击坐标（贴面矩形深度反算用）
  let draftNormal = null;                // 本次绘制首点处的 MESH 法向（旧切平面兜底用）
  const decalTokens = new Map();         // 贴面重建去竞态：只接受最后一次的结果
  let tourTimer = null;
  let down = null;
  // 框选：选择工具下 Shift+空白拖拽 = 矩形框选（普通空白拖拽仍交给引擎旋转视角）
  let marqueeStart = null, marqueeActive = false, marqueeEl = null;
  const normRect = (a, b) => ({ x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) });
  const ensureMarqueeEl = () => {
    if (marqueeEl) return marqueeEl;
    marqueeEl = document.createElement('div');
    marqueeEl.className = 'ed-marquee';
    stage.appendChild(marqueeEl);
    return marqueeEl;
  };
  const cleanupMarquee = () => { marqueeStart = null; marqueeActive = false; if (marqueeEl) marqueeEl.style.display = 'none'; };
  let placeChain = Promise.resolve();     // 落点串行队列，保证连点顺序
  let draftGen = 0;                      // 草稿世代号：cancelDraft / finishDraft 自增
  let finishing = false;                 // 右键 / Enter 结束绘制的去重标记
  let cursorPending = null;              // 光标跟随预览（同步拾取）
  const ac = new AbortController();
  // 进编辑前引擎自带的碰撞网格开关值；卸载时原样还回去，不污染浏览态
  const prevMeshOverlay = !!viewer.state?.collisionOverlayEnabled;
  // 进编辑前的相机模式（walk / fly）：编辑器默认切 fly，退出时还原
  const prevCameraMode = viewer.state?.cameraMode || null;
  /* 编辑期「无碰撞飞行」：引擎的 fly 控制器同样挂着碰撞体（cameraManager /
     inputController / XR / 导航光标吃的是同一份 MeshCollision），只切 fly 不够 ——
     贴墙布点、穿门取景时相机仍会被墙体推开。这里把碰撞从相机控制器上摘掉。
     只摘挂、不销毁：viewer.collision() 仍返回同一个 MeshCollision，
     落点拾取 / 贴地 / 贴花深度反算全部照旧。退出编辑器再挂回去。 */
  const prevCollision = !!viewer.state?.hasCollision;
  let collisionDetached = false;
  if (prevCollision) {
    try { collisionDetached = viewer.setCollisionEnabled?.(false) === true; } catch (_) { collisionDetached = false; }
  }

  /** 全局碰撞体 MESH 显示：优先走同文档的调试模块（能处理异步 attach），
   *  否则直接写引擎的响应式 state（会触发 collisionOverlayEnabled:changed）。 */
  function setMeshVisible(on) {
    let ok = false;
    // 1) 同文档的碰撞调试模块：能处理「MESH 还没 attach 完」的异步等待
    try {
      const api = window.__mgCollisionDebug;
      if (api && typeof api.setMeshOverlay === 'function') { api.setMeshOverlay(on); ok = true; }
    } catch (_) { /* noop */ }
    // 2) 再写一次当前 viewer 的响应式 state（真实环境里是同一个对象，
    //    重复赋值无副作用；测试替身 / 旧引擎下这是唯一生效的路径）
    try {
      const st = window.__viewer?.state || viewer.state;
      if (st) { st.collisionOverlayEnabled = !!on; ok = true; }
    } catch (_) { /* noop */ }
    try { window.__viewer?.app && (window.__viewer.app.renderNextFrame = true); } catch (_) { /* noop */ }
    state.meshOverlayReady = ok || state.meshOverlayReady;
    return ok;
  }
  if (state.meshVisible) setMeshVisible(true);

  const optsForPicker = () => ({
    depthOn: state.depthOn,
    planeDistance: state.planeDistance,
    groundY: store.calibration().groundY,
    freeDistance: 3,
    scene: state.scene
  });
  const picker = createPicker({ getViewer: () => window.__viewer, getOptions: optsForPicker });

  /* ---------------------------------------------------------------- 屏幕空间 decal 投射管理器
   * 把「带 projector 的可见贴面矩形」喂给 GPU；每帧按实时表面深度投射视频纹理。
   * 防御式：非真实运行时（headless mock）自动禁用，不影响其余功能。 */
  let decalMgr = null;
  try {
    // 引擎适配层：编辑器只依赖 engine-adapter 契约，不直接触碰 PlayCanvas 类。
    // 后续接入 Babylon.js 时，仅需在此处替换适配器实现。
    const engineAdapter = resolveEngineAdapter({
      getApp: () => window.__viewer?.app || null,
      getCameraEntity: () => {
        const cam = window.__viewer?.app?.root?.findComponent?.('camera');
        return cam?.entity || null;
      },
      getPickView: () => {
        // 没有可见贴花时绝不驱动引擎 Picker：renderView() 会懒创建 Picker 并
        // 跑一次离屏 pick pass，那是「进入编辑后主画面消失」的源头。
        if (!getDecals().length) return null;
        const ep = picker.enginePicker?.();
        return ep && typeof ep.renderView === 'function' ? ep.renderView() : null;
      }
    });
    decalMgr = createDecalProjection({
      adapter: engineAdapter,
      getDecals: getDecals
    });
  } catch (e) {
    console.warn('[editor] decal 投射管理器初始化失败，已降级：', e);
  }
  /* 注记 → GPU 实例描述：与浏览态（browse-annotations.js）共用
     decal-runtime.js 的 decalsForGPU，避免两个入口的参数口径漂移。 */
  function getDecals() {
    return decalsForGPU(store.list(state.scene));
  }
  function syncDecals() {
    if (decalMgr && decalMgr.enabled && typeof decalMgr.sync === 'function') {
      decalMgr.sync(getDecals());
    }
  }

  /* ---------------------------------------------------------------- 动线贴地（与贴花同源）
   *
   * 只算一次、算完写回注记（a.drape / a.drapeMeta）：
   *   · 结果与相机无关 → 可持久化 → 浏览态直接照抄就能贴地，不需要任何拾取能力；
   *   · 不进撤销栈（store.update 的 noUndo）→ Ctrl+Z 撤销的是「我画的线」，
   *     而不是看不见的贴地重算；
   *   · 异步串行排队，深度反算是逐像素 GPU readback，绝不能并发几十条。
   *
   * 失效判据 = 原始顶点签名 + 拾取版本号（碰撞网 / 场景换了才需重算）。
   */
  const DRAPE_STEP = 0.9;
  const DRAPE_MAX_SAMPLES = 64;
  const drapeQueue = { busy: false, timer: 0, running: null };

  function pointsSig(a) { return JSON.stringify(a.points || []); }

  function needsDrape(a, v) {
    if (!a || a.kind !== 'line' || a.visible === false) return false;
    if (!Array.isArray(a.points) || a.points.length < 2) return false;
    const m = a.drapeMeta;
    return !m || m.pointsSig !== pointsSig(a) || m.v !== v;
  }

  function scheduleDrape(delay = 400) {
    clearTimeout(drapeQueue.timer);
    drapeQueue.timer = setTimeout(runDrapeQueue, delay);
  }

  function runDrapeQueue() {
    // 已在跑：把同一个 Promise 交出去（调用方 await 到的就是「这一轮算完」，
    // 而不是在忙时直接空返回 —— 否则诊断 / 外部调用会误判成「没有需要贴地的线」）
    if (drapeQueue.busy) return drapeQueue.running || Promise.resolve();
    if (state.preview) return Promise.resolve();
    drapeQueue.busy = true;
    drapeQueue.running = (async () => {
      try {
        for (;;) {
          const v = picker.drapeVersion;
          const a = store.list(state.scene).find(x => needsDrape(x, v));
          if (!a) break;
          const sig = pointsSig(a);
          let res = null;
          try {
            res = await picker.drapePolylineDepth(a.points, DRAPE_STEP, { maxSamples: DRAPE_MAX_SAMPLES });
          } catch (e) { res = null; }
          const cur = store.get(a.id);
          if (!cur) continue;                                // 排队期间被删掉
          if (!res || !Array.isArray(res.points) || res.points.length < 2 || res.source === 'none') {
            /* 没有任何真实命中（无深度图 / 相机看不到这条线 / 拾取全部失败）：
               绝不要写一份「看着像贴地、其实是原始悬空点」的假结果 —— 那会让
               后续判断以为已经贴好了。只落一个 meta 防止「算不出来 → 立刻再排」
               的死循环，drape 保持空，渲染继续走原始折线。 */
            store.update(a.id, {
              drapeMeta: { pointsSig: sig, v, source: 'none', at: Date.now() }
            }, { noUndo: true });
            continue;
          }
          const q = (n) => Math.round(Number(n) * 1000) / 1000;
          store.update(a.id, {
            drape: res.points.map(p => [q(p[0]), q(p[1]), q(p[2])]),
            drapeMeta: {
              pointsSig: sig, v, step: res.step, samples: res.samples,
              source: res.source, stats: res.stats || null, at: Date.now()
            }
          }, { noUndo: true });
        }
      } finally {
        drapeQueue.busy = false;
        drapeQueue.running = null;
      }
    })();
    return drapeQueue.running;
  }

  const overlay = new Overlay({
    host: stage,
    getViewer: () => window.__viewer,
    store,
    getScene: () => state.scene,
    getSelected: () => state.selectedId,
    getSelectedSet: () => state.selectedIds.slice(),
    isPreview: () => state.preview,
    alwaysVisible: () => !state.depthOn,
    onPick: (id, mode, mods) => {
      // 锁定标注不可点选 / 不可编辑（锁定来自标注自身 locked 字段，不随选中态变化）。
      const a = store.get(id);
      if (!a || a.locked) return;
      // 双击标注（overlay / SVG 直接派发 dblclick 的路径）= 回到标注机位。
      if (mode === 'fly') { action('fly', id); return; }
      /* 用户直接点中已有对象 = 进入「对象交互」，此时必须退出绘制工具。
         否则在绘制工具（Point / 动线 / 展板…）下选中一个对象后，下一次点空白处
         会继续落点、又新建一个标注（用户反馈：选中交互时不该能新建）。
         工具切回选择会同时丢弃未完成草稿；要接着画重新按工具快捷键即可。 */
      if (state.tool !== 'select') {
        action('tool', 'select');
        panel.status('已选中对象：退出绘制工具（继续绘制请重新选择工具）');
      }
      // 多选：Shift/Ctrl/Cmd + 点击 = 在选集中切换成员（Figma/Miro 式加选 / 减选）；
      // 普通点击 = 替换为单选。空白处取消 / Shift+拖拽框选由编辑器在 stage 层处理。
      const toggle = !!(mods && (mods.shift || mods.ctrl || mods.meta));
      action(toggle ? 'select-toggle' : 'select', id);
    },
    // 展板拖拽：overlay 传入的是「锚点原始屏幕位置 + 鼠标位移」，
    // 而不是鼠标当前位置（否则点一下板面展板就跳到光标下的场景表面）。
    // 合并键让一次连续拖动只占一条撤销记录。
    onBoardMove: (id, ax, ay) => {
      if (state.preview) return;
      const a = store.get(id);
      if (!a || a.locked) return;          // 锁定展板不可拖动（overlay 已守卫，这里再兜底）
      const hit = picker.pickSync(ax, ay);
      if (hit) store.update(id, { points: [hit.pos] }, { coalesceKey: 'move:' + id });
    },
    onBoardResize: (id, size) => {
      if (state.preview) return;
      const a = store.get(id);
      if (!a || a.locked) return;          // 锁定展板不可缩放
      store.update(id, { style: { size } }, { coalesceKey: 'resize:' + id });
    },
    // 引线锚点拖拽：吸附到最近碰撞 MESH 表面，把结果记成独立的 style.leadTo
    onBoardAnchor: (id, cx, cy, phase) => {
      if (state.preview) return;
      const a = store.get(id);
      if (!a || a.locked) return;          // 锁定展板不可拖锚点
      if (phase === 'start') { panel.status('拖动引线锚点：自动吸附最近的碰撞 MESH'); return; }
      if (phase === 'end') { panel.status('引线锚点已就位'); return; }
      const hit = picker.snapToMesh(cx, cy);
      if (!hit) return;
      state.lastSource = hit.source;
      store.update(id, { style: { leadTo: hit.pos } }, { coalesceKey: 'lead:' + id });
      panel.status(hit.snapped
        ? `引线锚点已吸附 MESH 表面 · ${hit.pos.map(n => n.toFixed(2)).join(', ')}`
        : '附近没有碰撞 MESH，锚点落在参考平面上');
    },
    // 三维实体屏移动（三轴 gizmo / 屏体自由拖动）：起点 + 世界位移，一次拖动合并成一条撤销
    onScreenMove: (id, start, delta) => {
      if (state.preview) return;
      const a = store.get(id);
      if (!a || a.locked) return;
      const p = [start[0] + delta[0], start[1] + delta[1], start[2] + delta[2]];
      store.update(id, { points: [p] }, { coalesceKey: 'screen-move:' + id });
    },
    // 三维实体屏底心旋转锚点：只改朝向（yaw / pitch），位置不动；一次拖动一条撤销
    onScreenRotate: (id, rot) => {
      if (state.preview) return;
      const a = store.get(id);
      if (!a || a.locked) return;
      store.update(id, { style: { yaw: rot.yaw, pitch: rot.pitch } },
        { coalesceKey: 'screen-rot:' + id });
    },
    isEditable: () => !state.preview,
    // 「选中即锁定其余对象」的设计已废弃（与多选冲突）：锁定只来自标注自身的 locked 字段，
    // 不再因「有选中对象」而锁死其它对象，否则无法 Shift+点击加选 / 框选。
    isLocked: (id) => { const a = store.get(id); return !!(a && a.locked); },
    // 动线贴合模型：等距重采样 + 逐点吸附碰撞 MESH 表面（结果可缓存，不随相机变）
    drapeLine: (points) => picker.drapePolyline(points, 0.45),
    // 贴面矩形：切平面网格逐点吸附碰撞 MESH 表面，形成随模型起伏的纹理面
    drapeQuad: (frame, nu, nv, lift) => picker.drapeQuad(frame, nu, nv, lift),
    drapeVersion: () => picker.drapeVersion,
    // 逐注记深度检测：开启后被前方模型遮挡的标注才隐藏
    isOccluded: (p) => picker.occluded(p),
    // 辅助线深度判断：贴花 OBB / 视锥体棱 / 旋转环逐段判定「是否在墙后被挡住」
    probeOcclusion: (pts, opt) => picker.probeOcclusion(pts, opt),
  });
  overlay.start();

  const panel = createPanel({
    host: document.body,
    store,
    getState: getState,
    onAction: action,
    // 贴花诊断状态行：把渲染层的运行时参数（归一化基准 / 深度口径 /
    // 分辨率缩放比）暴露给属性面板，只读，不改数据。
    getDecalDiag: () => {
      try {
        const d = decalMgr && typeof decalMgr.debug === 'function' ? decalMgr.debug() : null;
        if (!d) return null;
        const inst = d.instances && d.instances[0];
        return {
          pickReady: !!d.pickReady,
          pickSize: d.pickSize || null,
          dpr: d.dpr || 1,
          boxScale: inst ? inst.boxScale : (d.options?.boxScale ?? 1),
          depthMode: inst ? inst.depthMode : (d.options?.depthMode ?? 1),
          cull: inst ? !!inst.cull : false,
          degraded: !!d.degraded,
          gpuErrors: d.gpuErrors || 0,
          instances: d.instances?.length || 0,
          visible: d.instances?.filter(i => i.visible).length || 0
        };
      } catch (_) { return null; }
    }
  });

  // ------------------------------------------------------------ 键盘焦点
  // WASD 由 iframe 内 Viewer 控制器监听 window；把焦点从父页按钮收回来。
  const prevTabIndex = stage.getAttribute('tabindex');
  stage.setAttribute('tabindex', '0');
  const focusScene = () => {
    try { window.focus(); } catch (_) { /* noop */ }
    try { stage.focus({ preventScroll: true }); } catch (_) { /* noop */ }
  };
  setTimeout(focusScene, 60);

  // ------------------------------------------------------------ 鼠标接管（捕获阶段）
  function onUI(target) {
    return !!(target?.closest?.('.ed-ui, .ed-item, .ed-shape, .ed-flow-arrow-seg, ' +
      '.ed-flow-chain, .ed-label, .ed-draft, .ed-draft-halo, .ed-draft-handles, ' +
      '.ed-decal-cell, .ed-decal-video, .ed-decal-obb-handle, .ed-screen-gizmo, ' +
      '.ed-screen-rot'));
  }

  stage.addEventListener('pointerdown', e => {
    if (onUI(e.target)) { down = null; return; }
    down = { x: e.clientX, y: e.clientY, t: Date.now(), button: e.button };
    focusScene();
    // 选择工具下空白 Shift+拖拽 = 矩形框选（普通空白拖拽仍交给引擎旋转视角）
    if (state.tool === 'select' && e.shiftKey && !e.button) {
      marqueeStart = { x: e.clientX, y: e.clientY, shift: true };
      marqueeActive = false;
      e.stopPropagation();                      // 阻止引擎在框选起始时旋转视角
    }
  }, { signal: ac.signal, capture: true });

  stage.addEventListener('pointerup', e => {
    if (onUI(e.target)) return;
    const d0 = down; down = null;
    const p = d0 || { x: e.clientX, y: e.clientY };
    // 只把「左键单击」当落点。右键 / 中键的 pointerup 绝不能进 place()：
    // 落点是异步拾取队列，右键 contextmenu 先 cancelDraft，队列里的点随后
    // 又把草稿复活 —— 用户看到的就是「右键停不下来长方体的交互」。
    if (e.button !== 0 || (d0 && d0.button !== 0)) return;
    // 框选完成：用矩形命中测试选取相交的标注（Shift 加选，否则替换）
    if (marqueeStart) {
      const wasActive = marqueeActive;
      cleanupMarquee();
      if (wasActive) {
        const rect = normRect(marqueeStart, { x: e.clientX, y: e.clientY });
        const ids = overlay.selectionRectHit(rect, state.scene);
        action(marqueeStart.shift ? 'select-add' : 'select', ids);
        e.stopImmediatePropagation();
        return;
      }
      marqueeStart = null;
    }
    const moved = Math.hypot(e.clientX - p.x, e.clientY - p.y);
    if (moved > TAP_PX) return;                 // 拖拽旋转视角：放行给引擎
    // 无拖拽单击：阻断引擎「点击自动漫游过去」，改由编辑器落点
    e.stopImmediatePropagation();
    if (state.preview) return;

    // 双击不再触发任何事件：快速二次左键单击按两次独立落点处理，
    // 不再有「合成双击 = 结束绘制」的隐式语义（结束统一交给右键 / Enter）。
    place(e.clientX, e.clientY);
  }, { signal: ac.signal, capture: true });

  // 双击（左键 / 右键）一律不触发任何事件：不结束绘制、不回到标注机位、
  // 也不触发引擎的双击漫游。捕获阶段 preventDefault + stopImmediatePropagation
  // 吞掉整个事件，冒泡层（标注元素 / overlay / 引擎）什么都收不到。
  stage.addEventListener('dblclick', e => {
    e.preventDefault();
    e.stopImmediatePropagation();
  }, { signal: ac.signal, capture: true });

  // 右键单击：结束当前标注动作（等价原双击 / Enter 的「完成」语义），并把
  // 鼠标状态复位为默认的「选择」。无草稿时维持原行为：命中标注弹上下文菜单，
  // 命中空白取消选中。编辑面板内右键仍放行给原生菜单。
  stage.addEventListener('contextmenu', e => {
    if (e.target.closest?.('.ed-ui')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (state.preview) { panel.status('预览模式（只读）'); return; }
    // 绘制中右键：结束本次标注（落点队列里在途的点写完后再收尾，竞态安全）。
    // 点数不足下限时 finishDraft 会丢弃草稿并给出明确提示。
    if (draft.length) {
      finishDraftAfterPending(true);
      return;
    }
    // 右键直接命中某个标注元素：弹 Figma / Miro 式的轻量上下文菜单
    // （复制 / 飞到此处 / 置顶 / 置底 / 删除），不再「取消选中」。
    // 这与右键空白处（取消选中并回到选择）的语义分离，符合专业编辑器的习惯。
    const annEl = e.target.closest?.('[data-id]');
    const annId = annEl?.dataset?.id;
    if (annId && store.get(annId) && !store.get(annId).locked) {
      action('select', annId);
      panel.contextMenu(e.clientX, e.clientY, annId);
      return;
    }
    cancelDraft();
    state.selectedIds = [];
    state.tool = 'select';
    panel.render(getState());
    panel.status('右键：已取消选中 · 已回到「选择」状态');
  }, { signal: ac.signal, capture: true });

  // 光标跟随：同步拾取，零延迟，给出「鼠标在哪、点下去会落在哪」的实时反馈
  stage.addEventListener('pointermove', e => {
    if (onUI(e.target)) return;
    // 框选进行中：实时绘制矩形，并阻止引擎旋转视角
    if (marqueeStart) {
      const dx = e.clientX - marqueeStart.x, dy = e.clientY - marqueeStart.y;
      if (!marqueeActive && Math.hypot(dx, dy) > TAP_PX) { marqueeActive = true; ensureMarqueeEl(); }
      if (marqueeActive) {
        const r = normRect(marqueeStart, { x: e.clientX, y: e.clientY });
        Object.assign(marqueeEl.style, {
          left: r.x0 + 'px', top: r.y0 + 'px',
          width: (r.x1 - r.x0) + 'px', height: (r.y1 - r.y0) + 'px', display: 'block'
        });
        e.stopPropagation();
        return;
      }
    }
    if (state.preview || state.tool === 'select') { overlay.setCursor(null); return; }
    cursorPending = { x: e.clientX, y: e.clientY };
    if (cursorPending.raf) return;
    cursorPending.raf = requestAnimationFrame(() => {
      cursorPending.raf = 0;
      const c = cursorPending; if (!c) return;
      const hit = picker.pickSync(c.x, c.y);
      overlay.setCursor(hit ? hit.pos : null);
    });
  }, { signal: ac.signal, capture: true });

  stage.addEventListener('pointerleave', () => overlay.setCursor(null), { signal: ac.signal, capture: true });

  // ------------------------------------------------------------ 键盘
  // 挂在 document 冒泡阶段：既能屏蔽引擎（引擎在 window 冒泡），
  // 又不影响输入框正常接收字符。
  document.addEventListener('keydown', e => {
    const tag = e.target?.tagName || '';
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(tag) || e.target?.isContentEditable;
    const k = (e.key || '').length === 1 ? e.key.toLowerCase() : e.key;
    const mod = e.ctrlKey || e.metaKey || e.altKey;

    if (inField) {
      // 输入框内：普通按键只阻止冒泡（引擎收不到 -> 打字时相机不乱跑），
      // 不 preventDefault，复制 / 粘贴 / 文本撤销照常工作。
      if (e.key === 'Escape') { e.target.blur?.(); e.stopPropagation(); return; }
      // 但全局快捷键必须穿透：否则选中标注后焦点落在标题框里，
      // 按 Shift+P 变成往标题打字、Ctrl+Z 无法撤销、WASD 不能漫游 ——
      // 等于把整套文档承诺的快捷键在默认状态下「禁用」。这里显式放行。
      const k = (e.key || '').length === 1 ? e.key.toLowerCase() : e.key;
      if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && SHIFT_KEYS[k.toUpperCase()]) {
        e.preventDefault(); action('tool', SHIFT_KEYS[k.toUpperCase()]); return;
      }
      if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); action(e.shiftKey ? 'redo' : 'undo'); return; }
      if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); action('redo'); return; }
      if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); action('export'); return; }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && k === 'd') {
        e.preventDefault(); if (state.selectedIds.length) action('duplicate'); return;
      }
      if (e.key === 'Tab') { e.preventDefault(); action('preview'); return; }
      e.stopPropagation();
      return;
    }

    if (e.key === 'Escape') {
      e.stopPropagation();
      if (draft.length) { cancelDraft(); panel.status('已取消本次绘制'); }
      else if (state.selectedIds.length) { action('deselect'); }
      else action('tool', 'select');
      return;
    }
    // Enter 与双击等价：结束本次绘制并回到「选择」
    if (e.key === 'Enter' && draft.length) {
      e.preventDefault(); e.stopPropagation(); finishDraftAfterPending(true); return;
    }
    // Shift+C：全局显示 / 隐藏碰撞体 MESH（不与任何漫游键冲突）
    if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && k.toUpperCase() === 'C') {
      e.preventDefault(); e.stopPropagation(); action('mesh'); return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault();
      if (draft.length) {                       // 绘制中：退掉上一个顶点
        const d = draft.pop();
        if (!draft.length) draftNormal = null;
        overlay.setDraft(state.tool, draft);
        panel.status(d ? '已撤销上一个顶点' : '没有可撤销的顶点');
        return;
      }
      if (state.selectedIds.length) { e.stopPropagation(); action('delete'); }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && k === 'z') {
      e.preventDefault(); e.stopPropagation();
      action(e.shiftKey ? 'redo' : 'undo'); return;
    }
    if ((e.ctrlKey || e.metaKey) && k === 'y') {
      e.preventDefault(); e.stopPropagation(); action('redo'); return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && k === 'd') {
      e.preventDefault(); e.stopPropagation();
      if (state.selectedIds.length) action('duplicate'); return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && k === 'a') {
      e.preventDefault(); e.stopPropagation(); action('select-all'); return;
    }
    if ((e.ctrlKey || e.metaKey) && k === 's') {
      e.preventDefault(); e.stopPropagation(); action('export'); return;
    }
    if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); action('preview'); return; }

    // 工具快捷键（Shift+字母）
    if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && SHIFT_KEYS[k.toUpperCase()]) {
      e.preventDefault(); e.stopPropagation();
      action('tool', SHIFT_KEYS[k.toUpperCase()]); return;
    }

    // 其余单键屏蔽引擎（1/2/3 相机模式、v 碰撞线框、h 面板、g 手柄、
    // r 重置、f 取景、空格播放、p/l/b/t/m 宿主功能），漫游键 W A S D 放行。
    if (!mod && !e.shiftKey && ENGINE_KEYS.has(k)) { e.stopPropagation(); return; }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && k === 'd') e.stopPropagation();
  }, { signal: ac.signal });

  // ------------------------------------------------------------ 落点 / 绘制
  /** 串行执行，保证连续点击的顶点顺序与点击顺序一致 */
  function place(clientX, clientY) {
    placeChain = placeChain.then(() => placeAsync(clientX, clientY)).catch(() => {});
  }

  async function placeAsync(clientX, clientY) {
    const gen = draftGen;
    const toolAtStart = state.tool;
    if (state.tool === 'select') { action('select', null); return; }
    if (!draft.length) { picker.beginStroke(); draftNormal = null; }
    const hit = await picker.pickAsync(clientX, clientY);
    // 拾取是异步的：等待期间草稿可能已被右键 / Esc / 切工具 / 收尾取消或完成。
    // 不复核就会把一个孤儿点塞回空草稿，交互「复活」——右键停不下来的根因之一。
    if (gen !== draftGen || state.tool !== toolAtStart) return;
    if (!hit) { panel.status('拾取失败：相机尚未就绪'); return; }
    const def = KINDS[state.tool];
    if (draft.length === 0) draftNormal = Array.isArray(hit.normal) ? hit.normal.slice(0, 3) : null;
    draft.push(hit.pos);
    draftScreen.push([clientX, clientY]);
    overlay.setDraft(state.tool, draft);
    state.lastSource = hit.source;
    panel.status(`${def.label}：已落 ${draft.length} 点 · ${sourceLabel(hit.source)} · 右键/Enter 完成并回到选择 · Backspace 退点`);
    // 点数达上限（点 / 展板 / 三维屏 / 贴面矩形 / 测量）自动收尾，
    // 但保留当前工具，方便连续投放同类标注；双击收尾才回到「选择」。
    if (draft.length >= def.max) finishDraft({ backToSelect: false });
  }

  /** 丢弃草稿：所有取消路径（Esc / 右键 / 切工具 / 预览 / 深度开关）共用 */
  function cancelDraft() {
    draftGen++;                            // 让队列里还在飞的异步落点作废
    draft = [];
    draftScreen = [];
    draftNormal = null;
    overlay.setDraft(null);
    overlay.setCursor(null);
    picker.endStroke();
  }

  /** 等落点队列里的点全部写完再收尾，修掉「双击早于第二次异步落点」的竞态。
   *  否则草稿会停在 1 个点，用户看到的就是「只有点、没有线」。 */
  function finishDraftAfterPending(backToSelect = true) {
    placeChain = placeChain.then(() => finishDraft({ backToSelect })).catch(() => {});
  }

  /** @param {{backToSelect?:boolean}} opts true = 双击 / Enter 收尾，鼠标回到「选择」 */
  function finishDraft(opts = {}) {
    if (finishing) return;
    finishing = true;
    draftGen++;                            // 草稿已收尾，在途异步落点同样作废
    try {
      const def = KINDS[state.tool];
      const hadDraft = draft.length > 0;
      if (!def || draft.length < def.min) {
        if (hadDraft) panel.status(`未完成：${def?.label || '绘制'}至少需要 ${def?.min ?? 0} 个顶点，已丢弃草稿`);
        cancelDraft();
        if (opts.backToSelect) { state.tool = 'select'; panel.render(getState()); }
        return;
      }
      /* 透视贴花复用 kind='decal'：渲染 / 显隐 / 视频源 / 导入导出全链路同一套，
         只是投影机换成透视视锥体（projector.mode='persp'）。工具 id 与注记 kind
         在此显式分叉，避免再复制一份贴花实现。 */
      const kind = state.tool === 'frustum' ? 'decal' : state.tool;
      const layerId = store.layers()[0]?.id || 'default';
      const style = { color: store.layer(layerId)?.color || '#22d3ee' };
      if (state.tool === 'decal' && draftNormal) style.normal = draftNormal;
      // 贴面矩形：用户框的是「屏幕上的一块区域」，不是两个世界点。
      // 把两次点击归一化存进 rect，随后逐像素做深度反算填充 surface。
      let rect = null;
      if (state.tool === 'decal' && draftScreen.length >= 2) {
        const cv = viewer.app?.graphicsDevice?.canvas;
        const cr = cv?.getBoundingClientRect?.();
        if (cr) rect = screenRectUV(cr, draftScreen[0], draftScreen[1]);
      }
      /* 透视贴花：两次点击 = 光心 → 指向目标，far 默认取两点距离
         （视锥体刚好够到用户点的那个表面），near 取 far 的 2%。 */
      let projector = null;
      if (state.tool === 'frustum') {
        const dist = Math.hypot(draft[1][0] - draft[0][0], draft[1][1] - draft[0][1],
          draft[1][2] - draft[0][2]);
        projector = makeFrustumProjector(draft[0], draft[1], {
          far: dist, fov: state.projFov, aspect: state.projAspect
        });
        if (!projector) panel.status('透视贴花：两次落点太近，无法确定视锥方向，已改用默认朝向');
      }
      const a = makeAnnotation(kind, draft, {
        scene: state.scene,
        layerId,
        groupId: state.activeGroupId,     // 归入当前分组
        title: def.label + ' ' + (store.list(state.scene).length + 1),
        style,
        // 记录创建时的机位：双击标注 /「飞到此处」据此精确回到当初的视角，
        // 而不是用第一个落点粗略反推（多顶点标注尤其不准）。
        view: window.__mgPose?.() || null,
        rect,
        surface: null,
        projector
      });
      store.add(a);
      if (state.tool === 'frustum') {
        syncDecals();
        panel.status(projector
          ? `透视贴花已生成视锥体 · 光心 (${projector.position.map(v => v.toFixed(1)).join(', ')}) · ` +
            `FOV ${projector.fov.toFixed(0)}° · 远距 ${projector.far.toFixed(2)}m · 近距 ${projector.near.toFixed(2)}m` +
            ' · 在属性面板可调 FOV / 宽高比 / 远距，或拖视锥手柄'
          : '透视贴花已创建，但视锥体没有生成（请重画两点或调大远距）');
      } else if (state.tool === 'decal') {
        if (rect) rebuildDecalProjector(a.id);
        else panel.status('贴面矩形：画布尺寸不可用，请在属性面板点「重新投射投影机」');
      }
      cancelDraft();
      if (opts.backToSelect) state.tool = 'select';
      action('select', a.id);
      panel.status(`已创建 ${def.label} · ${a.id}` +
        (rect ? ' · 正在按深度反算贴合表面…' : '') +
        (opts.backToSelect ? ' · 已回到选择状态' : ''));
    } finally { finishing = false; }
  }

  /**
   * 贴面矩形（投影式延迟贴花）：按当前相机把 rect 里的采样点做一次「深度反算」，
   * 得到真实世界表面网格，再构造投影机 OBB（position/quaternion/half）。
   * GPU 每帧用实时表面深度重建世界点做盒内判定，因此贴花像素级贴合模型表面，
   * 不随视角漂移。换机位只需重算投影机（数据不变、表面网格可复用）。
   */
  function cameraWorldPosition() {
    try {
      const cam = window.__viewer?.app?.root?.findComponent?.('camera');
      const p = cam?.entity?.getPosition?.();
      if (p) return [p.x, p.y, p.z];
    } catch (_) { /* noop */ }
    return null;
  }
  async function rebuildDecalProjector(id) {
    const a = store.get(id);
    if (!a || a.kind !== 'decal' || !a.rect) return;
    // 透视贴花的视锥体由两次点击直接布设，与屏幕矩形 / 深度反算无关；
    // 重建 OBB 会把它覆盖成正交投影机，所以这里必须拦住。
    if (a.projector && a.projector.mode === 'persp') {
      panel.status('透视贴花的视锥体不参与深度反算重建；如需换位置请重新绘制或拖动手柄');
      return;
    }
    const token = (decalTokens.get(id) || 0) + 1;
    decalTokens.set(id, token);
    /* 网格密度：过去 6×6 是因为「每个点一次 GPU 回读」，点多就慢到秒级。
       unprojectRect 现在改走「一次快照 + 一次块回读」快路径，采样点多到 9×9
       也不增加回读次数，表面弯曲更准。pickTimeout 只对旧引擎的慢路径生效。 */
    const grid = await picker.unprojectRect(a.rect, 9, 9, { pickTimeout: 900 });
    const cur = store.get(id);
    if (!cur || decalTokens.get(id) !== token) return;
    if (!grid) {
      panel.status('贴面矩形：当前画面取不到表面深度，请调整视角后重试');
      return;
    }
    /* 「只有包围盒、没有视频」的数据层根因：框选区域横跨远近物体（或深度拾取
       超时退化到碰撞网格）时，网格点深度跨度可达几十米，OBB 会变成 26m×10m
       的巨盒 —— GPU 逐像素反算与它相交的只有零星碎片，投射必然斑驳不可见。
       这里做两道拦截：深度跨度 + 盒尺寸，超限就明确提示，宁可不投也不投碎片。

       ★ 跨度必须用鲁棒分位数（p10~p90）而非 min/max：真机实测室内墙面
       49 点里常有 1~2 个点深度拾取失败退化到碰撞网格 / 落到前景近物，
       min=6.5m、max=24m 把 min/max 口径的 spread 顶到 1.42 > 1.2，
       于是整块纯墙面被误判为「跨度过大」而拒绝生成投影机 —— 表现正是
       「只有框线没有视频」。而 p10=7.0 / p90=16.3 / med=12.4，
       分位数口径 spread=(16.3-7.0)/12.4≈0.75 < 1.2，能正确放行。
       真正横跨多表面的场景分位数跨度依然大，仍会被拦截。 */
    const pts = (grid.points || []).filter(Boolean);
    if (pts.length) {
      const cam = cameraWorldPosition() || [0, 0, 0];
      const dists = pts.map(p => Math.hypot(p[0] - cam[0], p[1] - cam[1], p[2] - cam[2]));
      const sorted = [...dists].sort((x, y) => x - y);
      const q = (f) => sorted[Math.min(sorted.length - 1, Math.floor(f * (sorted.length - 1)))];
      const med = q(0.5) || 0;
      const lo = q(0.1), hi = q(0.9);
      // 鲁棒跨度：p10~p90 相对中位数；离群点不再主导判断
      const spread = med > 0.5 ? (hi - lo) / med : 0;
      if (med > 60 || spread > 1.2) {
        panel.status(`贴面矩形：框选区域深度跨度过大（主区间 ${lo.toFixed(1)}m ~ ${hi.toFixed(1)}m，中位 ${med.toFixed(1)}m），请贴近目标重新框选，否则投射会碎片化`);
        return;
      }
    }
    const projector = buildDecalProjector(grid, { depth: a.style.decalDepth, toward: cameraWorldPosition() });
    if (!projector) return;
    if (projector.half[0] + projector.half[1] > 16) {
      panel.status(`贴面矩形：生成区域过大（宽 ${(projector.half[0] * 2).toFixed(1)}m × 高 ${(projector.half[1] * 2).toFixed(1)}m），请框选较小的屏幕区域`);
      return;
    }
    /* 标准三段式：Pass1 由 GPU depth-only 相机生成 D32_FLOAT 深度纹理
       （decal-projection.syncShadowPass），不再用 CPU 射线采样。只有引擎不支持
       depth-only pass 时才回退这里的 CPU 24² 深度图。 */
    if (!decalMgr || !decalMgr.shadowPathSupported) {
      try {
        const col = window.__viewer?.collision?.();
        if (col && typeof col.queryRay === 'function') {
          const raycast = (ox, oy, oz, dx, dy, dz, maxDist) => {
            const h = rayHitMesh({ queryRay: (...args) => col.queryRay(...args) }, [ox, oy, oz], [dx, dy, dz], maxDist);
            return h ? h.pos : null;
          };
          projector.shadow = buildShadowDepthMap(projector, raycast, { n: 24 });
        }
      } catch (_) { projector.shadow = null; }
    }
    store.update(id, { surface: grid, projector });
    syncDecals();
    const shadowInfo = (decalMgr && decalMgr.shadowPathSupported)
      ? ' · GPU 深度图 Pass1（正交投影仪）'
      : (projector.shadow ? ` · 深度图 ${projector.shadow.n}²（${projector.shadow.hits} 命中）` : ' · 深度图不可用(回退旧口径)');
    panel.status(`贴面矩形已生成投影机 OBB · 宽 ${(projector.half[0] * 2).toFixed(2)}m × 高 ${(projector.half[1] * 2).toFixed(2)}m${shadowInfo}` +
      ` · 表面反算 ${grid.samples} 点/${grid.readbacks ?? '?'} 次回读 ${grid.ms ?? '?'}ms`);
  }

  /** 示例数据 / 旧文档里只带 rect 或 surface、没有 projector 的贴面，挂载后自动补算一次。
      另外：旧 projector 没有 shadow 深度图时也要补算一次（shadowmap 贴花路线）。 */
  function ensureDecalProjectors() {
    for (const a of store.list(state.scene)) {
      if (a.kind !== 'decal' || !a.rect) continue;
      // 透视贴花有自己的 projector，不存在「首次加载补算」这回事
      if (a.projector && a.projector.mode === 'persp') continue;
      // 标准三段式只需 projector（GPU Pass1 自动同步）；旧路径才要求 CPU 深度图
      if (a.projector && (decalMgr && decalMgr.shadowPathSupported ||
          (a.projector.shadow && a.projector.shadow.depth))) continue;
      if (decalTokens.get(a.id + ':auto')) continue;
      decalTokens.set(a.id + ':auto', true);
      rebuildDecalProjector(a.id).finally(() => decalTokens.delete(a.id + ':auto'));
    }
  }

  function sourceLabel(s) {
    return ({ mesh: 'MESH 表面', depth: '高斯深度', ground: '地面', wall: '墙面',
      plane: '绘制平面', free: '悬浮', fallback: '悬浮回退' })[s] || s;
  }

  // ------------------------------------------------------------ 动作分发
  function getState() {
    const mi = picker.meshInfo(state.scene);
    return {
      ...state,
      depthReady: picker.depthReady,
      meshReady: picker.meshReady,
      meshStatus: mi.status,
      meshTris: picker.meshTriangles || mi.tris,
      meshError: mi.error,
      meshOverlayEnabled: !!viewer.state?.collisionOverlayEnabled,
      meshOverlayReady: !!window.__mgCollisionDebug || !!viewer.state?.hasCollisionOverlay,
      cameraMode: viewer.state?.cameraMode || '-',
      walkAllowed: !!viewer.state?.walkAllowed,
      draftCount: draft.length
    };
  }

  function action(type, payload, quiet) {
    switch (type) {
      case 'tool':
        state.tool = payload; cancelDraft();
        panel.status(payload === 'select' ? '选择模式：点击标注查看 / 编辑' : `${KINDS[payload].label}：点击场景落点`);
        break;
      case 'mesh': {
        // 全局显示 / 隐藏碰撞体 MESH 线框（编辑模式专用，状态持久化）
        const next = !state.meshVisible;
        const ok = setMeshVisible(next);
        state.meshVisible = ok ? next : state.meshVisible;
        writeVal(MESH_KEY, state.meshVisible ? 1 : 0);
        panel.status(state.meshVisible
          ? '碰撞体 MESH 已显示：绘制贴面矩形 / 动线时可直接对照表面'
          : '碰撞体 MESH 已隐藏');
        break;
      }
      case 'depth':
        state.depthOn = !state.depthOn;
        writeVal(DEPTH_KEY, state.depthOn ? 1 : 0);
        cancelDraft();
        panel.status(state.depthOn ? '深度已开启：落点贴合 MESH / 高斯表面' : '深度已关闭：落点锁定绘制平面（线面共面）');
        break;
      case 'plane-dist': {
        const v = Number(payload);
        if (!Number.isFinite(v) || v < 0.5 || v > 60) break;
        state.planeDistance = v;
        writeVal(PLANE_KEY, v);
        cancelDraft();
        panel.status('绘制平面距离 ' + v.toFixed(1) + ' m');
        break;
      }
      case 'undo': store.undo(); panel.status('已撤销'); break;
      case 'redo': store.redo(); panel.status('已重做'); break;
      case 'export': download('maoming-annotations.json', store.exportText()); panel.status('已导出 JSON'); break;
      case 'import-text':
        try { store.importText(payload); panel.status('导入成功'); }
        catch (err) { panel.status('导入失败：' + err.message); }
        break;
      case 'reset': store.reset(); action('select', null); break;
      case 'preview':
        state.preview = !state.preview; cancelDraft();
        panel.status(state.preview ? '预览模式（只读）' : '编辑模式');
        break;
      case 'select': {
        // payload: id | id[] | null，统一收口到 selectedIds（末尾为主选中）
        const ids = !payload ? [] : Array.isArray(payload) ? payload.slice() : [payload];
        state.selectedIds = ids;
        panel.status(ids.length ? `已选中 ${ids.length} 个标注` : '已取消选中');
        break;
      }
      case 'select-toggle': {
        // Shift/Ctrl/Cmd + 点击：在选集中切换成员（Figma/Miro 式加选 / 减选）
        const id = payload; if (!id) break;
        const set = state.selectedIds.slice();
        const i = set.indexOf(id);
        if (i >= 0) set.splice(i, 1); else set.push(id);
        state.selectedIds = set;
        panel.status(set.length ? `已选中 ${set.length} 个标注（含切换）` : '已取消选中');
        break;
      }
      case 'select-all': {
        const ids = store.list(state.scene).map(a => a.id);
        state.selectedIds = ids;
        panel.status(`已全选 ${ids.length} 个标注（Ctrl+A）`);
        break;
      }
      case 'select-add': {
        const ids = Array.isArray(payload) ? payload.slice() : [payload];
        const set = state.selectedIds.slice();
        for (const id of ids) if (!set.includes(id)) set.push(id);
        state.selectedIds = set;
        panel.status(`已加选 ${set.length} 个标注`);
        break;
      }
      case 'deselect':
        state.selectedIds = [];
        panel.status('已取消选中');
        break;
      case 'item':
        // 左侧列表点击：单选 + 右侧属性面板切到该标注（可直接编辑）
        state.selectedIds = payload ? [payload] : [];
        panel.status(payload ? '已选中标注，可在右侧编辑属性' : '未选中标注');
        break;
      case 'media': {
        // 展板内容：文字 / 图片 / 网页 / 视频
        const { id, type, url, caption } = payload || {};
        const a = store.get(id);
        if (!a) break;
        const cur = (a.media && a.media[0]) || { type: 'none', url: '', caption: '' };
        // 三维实体屏 / 贴面矩形天生就是视频投射面，内容类型恒为 video，
        // 否则空 media 时 cur.type='none' 会把用户填的视频 URL 丢掉。
        const next = {
          type: (a.kind === 'screen' || a.kind === 'decal') ? 'video' : (type ?? cur.type ?? 'none'),
          url: url ?? cur.url ?? '',
          caption: caption ?? cur.caption ?? ''
        };
        const media = next.type === 'none' ? [] : [next];
        // coalesce 键必须带对象 id：否则 1.2s 内对 A、B 改同一字段会被合并成一条撤销，
        // 撤销 A 时把 B 的编辑也一并回退（跨对象串扰）。
        store.update(id, { media }, { coalesceKey: 'media:' + id });
        break;
      }
      case 'local-video': {
        // 工程内测试片源：viewer_stream/www/media/test.mp4 -> web/media/test.mp4
        const a = store.get(payload);
        if (!a) break;
        store.update(payload, { media: [{ type: 'video', url: LOCAL_TEST_VIDEO,
          caption: '本地测试视频 test.mp4' }] });
        panel.status(`已切换为本地测试视频 ${LOCAL_TEST_VIDEO}`);
        break;
      }
      case 'local-video-file': {
        const { id, name, url } = payload || {};
        const a = store.get(id);
        if (!a || !url) break;
        store.update(id, { media: [{ type: 'video', url, caption: name || '本地视频' }] });
        panel.status('已加载本机视频：' + (name || '本地文件'));
        break;
      }
      case 'delete': {
        const ids = payload ? [payload] : state.selectedIds.slice();
        ids.forEach(id => store.remove(id));
        state.selectedIds = [];
        panel.status(`已删除 ${ids.length} 个标注`);
        break;
      }
      case 'duplicate': {
        const ids = payload ? [payload] : state.selectedIds.slice();
        const created = [];
        ids.forEach(id => { const c = store.duplicate(id); if (c) created.push(c.id); });
        if (created.length) { state.selectedIds = created; panel.status(`已复制 ${created.length} 个标注（各偏移 0.5m）`); }
        else panel.status('复制失败：未找到标注');
        break;
      }
      case 'bring-front': {
        const ids = payload ? [payload] : state.selectedIds.slice();
        ids.forEach(id => store.bringToFront(id));
        panel.status(`已置顶 ${ids.length} 个标注`);
        break;
      }
      case 'send-back': {
        const ids = payload ? [payload] : state.selectedIds.slice();
        ids.forEach(id => store.sendToBack(id));
        panel.status(`已置底 ${ids.length} 个标注`);
        break;
      }
      case 'item-del': {
        // 列表行删除按钮：就地删除，若正在编辑该标注则清空选中
        store.remove(payload);
        if (state.selectedIds.includes(payload)) state.selectedIds = state.selectedIds.filter(x => x !== payload);
        panel.status('已删除标注');
        break;
      }
      case 'item-vis': {
        // 列表行显隐按钮：切换可见性
        const a = store.get(payload);
        if (a) store.update(payload, { visible: !a.visible });
        panel.status(a && !a.visible ? '已显示标注' : '已隐藏标注');
        break;
      }
      case 'fly': {                        // 「飞到此处」按钮 / 保存机位定位（双击已禁用）
        flyToAnnotation(store.get(payload));
        break;
      }
      case 'saveview': {
        const p = window.__mgPose?.();
        if (!p) { panel.status('相机未就绪'); break; }
        store.update(payload, { view: p });
        panel.status('已保存当前机位');
        break;
      }
      case 'property': {
        const { id, field, val } = payload || {};
        if (!id) break;
        /* 透视视锥体参数（FOV / 宽高比 / 远距 / 近距）直接进 projector，
           不进 style：half 与 fov 必须始终自洽，统一由 retuneFrustumProjector
           重算，避免面板写一半、shader 用一半。 */
        const PROJ_FIELD = { projFov: 'fov', projAspect: 'aspect', projFar: 'far', projNear: 'near' }[field];
        if (PROJ_FIELD) {
          const cur = store.get(id);
          if (!cur || cur.kind !== 'decal' || cur.projector?.mode !== 'persp') break;
          const next = retuneFrustumProjector(cur.projector, { [PROJ_FIELD]: Number(val) });
          if (next) { store.update(id, { projector: next }); syncDecals(); }
          break;
        }
        // size / color / opacity / labelAlways / 动线样式 / 引线锚点都是 style 子字段
        const STYLE_FIELDS = ['color', 'opacity', 'labelAlways', 'size',
          'bandWidth', 'flowSpeed', 'flowArrow', 'leadTo',
          'yaw', 'pitch', 'muted', 'loop', 'decalOpacity', 'decalDepth', 'decalEdge', 'normal',
          // 贴花投射诊断：背面剔除 / 归一化基准 / 深度采样口径
          'decalCull', 'decalBoxScale', 'decalDepthMode'];
        const patch = STYLE_FIELDS.includes(field)
          ? { style: { [field]: val } }
          : { [field]: val };
        const target = store.get(id);
        store.update(id, patch, { coalesceKey: 'field:' + id + ':' + field });
        // 投影机盒厚（decalDepth）变了：仅重算 OBB 半尺寸，无需重采表面
        // 透视视锥体的「厚度」由 far 决定，不走 decalDepth（否则 half[2] 会被写坏）
        if (field === 'decalDepth' && target?.kind === 'decal' &&
            target?.projector?.mode !== 'persp' && Number.isFinite(Number(val))) {
          const a = store.get(id);
          if (a && a.projector) {
            const half = a.projector.half.slice();
            half[2] = Math.max(0.1, Number(val)) / 2;
            store.update(id, { projector: { ...a.projector, half, depth: Number(val) } });
            syncDecals();
          }
        }
        // 贴花诊断参数变了：立刻同步给渲染层（改的是 uniform/剔除开关，不动 OBB）
        if (['decalCull', 'decalBoxScale', 'decalDepthMode'].includes(field)) syncDecals();
        break;
      }
      case 'decal-rebuild': {
        // 换机位后重新按当前画面深度反算同一块屏幕区域，重建投影机 OBB
        const a = store.get(payload);
        if (!a || a.kind !== 'decal') break;
        if (!a.rect) { panel.status('该贴面缺少屏幕矩形，请重新绘制'); break; }
        panel.status('正在按当前视角重新投射投影机…');
        rebuildDecalProjector(payload);
        break;
      }
      case 'anchor-reset': {
        // 把引线锚点收回展板脚下（清空独立世界点）
        const a = store.get(payload);
        if (a) store.update(payload, { style: { leadTo: null } });
        panel.status('引线锚点已复位到展板脚下');
        break;
      }
      case 'layer-add': {
        const n = store.layers().length;
        store.addLayer('图层 ' + (n + 1), LAYER_PALETTE[n % LAYER_PALETTE.length]);
        break;
      }
      case 'layer-toggle': store.toggleLayer(payload); break;

      // ---------------------------------------------------------- 分组管理
      case 'group-add': {
        const n = store.groups().length;
        const g = store.addGroup('分组 ' + n, GROUP_PALETTE[n % GROUP_PALETTE.length]);
        state.activeGroupId = g.id;
        panel.status(`已新建「${g.name}」并设为当前分组，之后绘制的标注自动归入`);
        break;
      }
      case 'group-rename': {
        const { id, name } = payload || {};
        const g = store.renameGroup(id, name);
        if (g) panel.status('分组已改名为「' + g.name + '」');
        break;
      }
      case 'group-del': {
        const g = store.group(payload);
        if (!g) break;
        const count = store.listByGroup(payload).length;
        const ok = store.removeGroup(payload);
        if (ok) {
          if (state.activeGroupId === payload) state.activeGroupId = DEFAULT_GROUP_ID;
          panel.status(`已解散「${g.name}」，${count} 个标注移回默认分组（未删除标注）`);
        }
        break;
      }
      case 'group-vis': {
        const g = store.toggleGroup(payload);
        if (g) panel.status(`「${g.name}」已${g.visible ? '显示' : '隐藏'}（整组）`);
        break;
      }
      case 'group-fold': {
        const g = store.group(payload);
        if (g) store.setGroupCollapsed(payload, !g.collapsed);
        break;
      }
      case 'group-activate': {
        if (!store.group(payload)) break;
        state.activeGroupId = payload;
        panel.status('当前分组设为「' + store.group(payload).name + '」');
        break;
      }
      case 'group-put': {
        if (!state.selectedIds.length) { panel.status('请先在列表或场景中选中一个标注'); break; }
        const n = store.assignGroup(state.selectedIds.slice(), payload);
        panel.status(n ? '已把 ' + state.selectedIds.length + ' 个选中标注归入「' + store.group(payload).name + '」' : '标注已在该分组');
        break;
      }
      case 'group-fly': {
        const arr = store.listByGroup(payload, state.scene);
        if (!arr.length) { panel.status('该分组下暂无标注'); break; }
        const pts = arr.flatMap(a => a.points);
        const center = [0, 1, 2].map(i => pts.reduce((s, p) => s + p[i], 0) / pts.length);
        flyTo(viewFromPoint(center));
        panel.status('已飞到「' + store.group(payload).name + '」标注中心');
        break;
      }
      case 'tour-add': {
        const name = '导览 ' + (store.tours().length + 1);
        const p = window.__mgPose?.();
        store.saveTour(name, [{ title: '起点', view: p, dwell: 2500 }]);
        panel.status('已创建 ' + name);
        break;
      }
      case 'tour-play': playTour(payload); break;
      case 'exit': requestExit(); break;
      default: return;
    }
    // 贴面矩形 GPU 投射实例随数据变化即时同步：换片源（media / 本地视频 /
    // 本机文件）、删除、复制、撤销 / 重做、显隐之后都必须重喂 decalMgr，
    // 否则「先画贴面、再填视频 URL」会一直停在演示画面 —— 这是
    // 「贴面矩形没法正常播放视频」的数据层根因。
    syncDecals();
    if (!quiet) panel.render(getState());
  }

  /** 多顶点标注取所有落点的中心，而不是第一个点（decal / 折线 / 面尤其明显） */
  function annotationCenter(a) {
    const pts = (a?.points || []).filter(p => Array.isArray(p) && p.length >= 3);
    if (!pts.length) return null;
    return [0, 1, 2].map(i => pts.reduce((s, p) => s + (Number(p[i]) || 0), 0) / pts.length);
  }
  function viewFromPoint(pt) {
    const p = window.__mgPose?.();
    // 沿完整视线（含 y 分量）后退，保持原相机俯仰。旧实现把 position.y 硬编码
    // 成 pt.y+1.0 并丢掉 dir[1]，导致飞过去后视角偏、俯仰丢失。
    const dir = p ? unit([p.target[0] - p.position[0], p.target[1] - p.position[1], p.target[2] - p.position[2]]) : [0, 0, -1];
    const dist = 2.5;
    return {
      position: [pt[0] - dir[0] * dist, pt[1] - dir[1] * dist, pt[2] - dir[2] * dist],
      target: [...pt], fov: p?.fov || 75
    };
  }
  function unit(v) { const l = Math.hypot(...v) || 1; return v.map(n => n / l); }
  /** 优先用创建时保存的机位；旧数据没有 view 时按标注中心反推 */
  function flyToAnnotation(a) {
    if (!a) return;
    if (a.view?.position && a.view?.target) { flyTo(a.view); return; }
    const c = annotationCenter(a);
    if (c) flyTo(viewFromPoint(c));
    else panel.status('该标注没有可用机位');
  }
  function flyTo(view) {
    if (!view?.position || !view?.target) return;
    window.__viewer?.setCameraPose?.(view.position, view.target, view.fov || 75);
  }
  function playTour(name) {
    const t = store.tours().find(x => x.name === name);
    if (!t) return;
    clearTimeout(tourTimer);
    let i = 0;
    const step = () => {
      if (i >= t.stops.length) { panel.status('导览结束'); return; }
      const s = t.stops[i++];
      if (s.view) flyTo(s.view);
      panel.status(`导览 ${i}/${t.stops.length} · ${s.title || ''}`);
      tourTimer = setTimeout(step, s.dwell || 2500);
    };
    step();
  }

  const onChange = () => {
    // 撤销 / 重做可能删掉当前选中的标注：若不清理，isLocked 会让其余标注永久锁定、
    // 三维里点谁都没反应（只能 Esc 救回）。这里在每次数据变化后 reconcile 选中态。
    if (state.selectedIds.length && !state.selectedIds.every(id => store.get(id)))
      state.selectedIds = state.selectedIds.filter(id => store.get(id));
    ensureDecalProjectors(); syncDecals(); panel.render(getState());
    // 顶点 / 新绘制 / 撤销重做之后都要重算动线贴地（防抖，且只算「签名过期」的那几条）
    scheduleDrape();
  };
  store.addEventListener('change', onChange);
  // 持久化失败（最常见是 localStorage 配额超限）给出可见告警，避免「静默丢数据」
  store.addEventListener('error', (e) => {
    const d = e.detail || {};
    if (d.type === 'quota') panel.status('⚠ 本地存储已满，部分修改可能未保存，建议立即「导出 JSON」备份');
    else panel.status('⚠ 保存失败：' + (d.message || '未知错误'));
  });
  panel.render(getState());
  panel.status('编辑模式就绪 · WASD 自由飞行（无碰撞，可穿墙）/ Shift+字母切工具 / 场景内点击落点');

  // ------------------------------------------------------------ UI 与三维场景彻底隔离
  // 鼠标在工具栏 / 图层 / 标注列表 / 属性面板里交互时，绝不联动三维场景：
  // 这些事件停在 .ed-ui 内部，不继续冒泡到 window（避免滚轮穿透去缩放相机、
  // 或误触 Viewer 的画布监听）。注意 .ed-ui 背景 pointer-events:none，
  // 点空白处仍会落到下方画布用于落点，所以这里只拦「真正打在控件上」的事件。
  const uiRoot = document.querySelector('.ed-ui');
  if (uiRoot) {
    const stop = (type, alsoPrevent) => uiRoot.addEventListener(type, e => {
      if (e.target === uiRoot) return;     // 透明背景穿透给画布
      e.stopPropagation();
      if (alsoPrevent) e.preventDefault();
    }, { capture: true });
    stop('pointerdown'); stop('pointermove'); stop('wheel'); stop('contextmenu');
  }

  // 预加载碰撞 MESH（后台进行，绝不阻塞交互）
  picker.warmup(state.scene).then(() => { ensureDecalProjectors(); panel.render(getState()); });
  // 画布尺寸一就绪就补算示例 / 历史贴面的深度表面网格
  setTimeout(ensureDecalProjectors, 500);

  /* ---------------------------------------------------------------- 相机：编辑器默认「自由飞行」
   *
   * 浏览态默认是 walk（碰撞漫游，胶囊被钉在离地 1.6m，且会被墙体挡住），
   * app.js 还会在碰撞体加载完成后自动切 walk。编辑时要贴着墙面画贴花、
   * 要能升到高处俯视布点，walk 姿态非常碍事 —— 所以进编辑器强制 fly：
   *   · globalThis.__mgEditorFly 让 app.js 的自动切 walk 轮询停手；
   *   · 退出编辑器时把进来前的模式还回去，不污染浏览态。
   */
  globalThis.__mgEditorFly = true;
  function forceFlyCamera() {
    const st = viewer.state;
    if (!st) return false;
    if (st.cameraMode === 'fly') return true;
    // walk -> fly：引擎有 toggleWalk 就走官方切换（内部同步控制器 / 指针锁），
    // 否则直接写响应式 state（walk-controls.js 关碰撞时用的也是这条路径）。
    if (st.cameraMode === 'walk' && typeof viewer.toggleWalk === 'function') {
      try { viewer.toggleWalk(); } catch (_) { /* 落到下面兜底 */ }
    }
    if (st.cameraMode !== 'fly') {
      try { st.cameraMode = 'fly'; } catch (_) { return false; }
    }
    return st.cameraMode === 'fly';
  }
  function restoreCameraMode() {
    globalThis.__mgEditorFly = false;
    const st = viewer.state;
    if (!st || !prevCameraMode) return;
    // 只在「用户没在编辑期间手动改过模式」时还原，避免覆盖用户的显式选择
    if (st.cameraMode === 'fly' && prevCameraMode === 'walk' && st.hasCollision && st.walkAllowed) {
      try { st.cameraMode = 'walk'; } catch (_) { /* noop */ }
    }
  }
  forceFlyCamera();

  function unmount() {
    ac.abort();
    clearTimeout(tourTimer);
    clearTimeout(drapeQueue.timer);
    clearInterval(drapePoll);
    // 退出编辑：把引擎的碰撞网格开关恢复到进编辑前的值，浏览态不被污染
    if (state.meshVisible) setMeshVisible(prevMeshOverlay);
    // 先把碰撞挂回去（restoreCameraMode 判 walk 时要看 hasCollision / walkAllowed），
    // 再还原相机模式（编辑期是强制飞行）
    if (collisionDetached) {
      try { viewer.setCollisionEnabled?.(true); } catch (_) { /* noop */ }
      collisionDetached = false;
    }
    restoreCameraMode();
    store.removeEventListener('change', onChange);
    overlay.stop(); overlay.destroy();
    panel.destroy();
    if (decalMgr && typeof decalMgr.destroy === 'function') decalMgr.destroy();
    if (prevTabIndex === null) stage.removeAttribute('tabindex');
    else stage.setAttribute('tabindex', prevTabIndex);
    window.__mgEditor = null;
    session = null;
  }

  /* 碰撞 MESH / 深度图是异步就绪的：drapeVersion 变了（或首次从 0 变成字符串）
     就说明「表面」变了，需要把动线重贴一次。低频轮询足够，且 needsDrape 会在
     没有任何过期项时立刻空转返回（零开销）。 */
  const drapePoll = setInterval(() => {
    if (state.preview || drapeQueue.busy) return;
    const v = picker.drapeVersion;
    if (store.list(state.scene).some(a => needsDrape(a, v))) scheduleDrape(80);
  }, 2000);

  // decalMgr 暴露给诊断脚本：debug() 返回 pickReady / degraded / GPU 错误计数
  const api = {
    store, picker, overlay, panel, getState, action, unmount, viewer,
    /** 诊断 / 回归用：立刻跑一遍贴地队列，返回 Promise（算完即持久化到 a.drape） */
    redrape: () => { clearTimeout(drapeQueue.timer); return runDrapeQueue(); },
    decalMgr
  };
  session = { api };
  window.__mgEditor = api;
  return api;
}

export function unmount() { session?.api.unmount(); }

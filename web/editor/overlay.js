/**
 * 世界锚定叠加层：把标注的世界坐标每帧投影到屏幕（不新建 WebGL 上下文）
 *
 * 扩展到点 / 线 / 面 / 展板 / 测量五类：
 *   - 点、展板   -> DOM 元素（原生排版、图片、视频、网页）
 *   - 线、面、测量 -> 单个 SVG overlay（polyline / polygon / 文字）
 * 带视锥剔除、距离淡出、选中高亮、图层显隐、草稿预览（顶点手柄 + 橡皮筋）。
 *
 * 【性能 / 体验要点】
 *  1. DOM 结构 **只建一次**，之后只改 textContent / src / style。
 *     早期实现每帧 `innerHTML = html` 重建展板，iframe / video 会被反复
 *     重新加载，视觉上就是「闪烁 + 显示不及时」。
 *     网页 / 视频 / 图片全部直接内嵌在展板内，不打开独立页面或弹层。
 *  2. `className` 只能 **追加** 不能覆盖：`.ed-item` 才是承载
 *     `position:absolute` 的类，`.ed-pin` / `.ed-board` 都没有定位属性。
 *     每帧覆盖 className 会让点 / 展板全部堆到左上角（展板「不显示」的根因）。
 *  3. 草稿绘制要有「顶点手柄 + 跟随鼠标的橡皮筋」，否则用户点完看不到
 *     反馈，感觉就是「点线面没画出来」。
 */
import { distance, pathLength, polygonArea, arrowChainWorld,
  BOARD_BASE_PX, screenCorners, homographyMatrix3d,
  projectorOBBCorners, projectorVolumeCorners, makeFrustumProjector,
  retuneFrustumProjector, rotateByQuat,
  quatMul, quatFromAxis, quatNormalize } from './schema.js';

const NS = 'http://www.w3.org/2000/svg';
/** 展板悬浮于锚点上方的导引线长度（**世界米**）：随深度等比换算成像素。
 *  旧实现是固定 14px，于是远处的展板看起来「贴着」锚点、近处却悬空很远，
 *  与「展板深度要和锚点对齐」的要求相悖。 */
const BOARD_GAP_WORLD = 0.12;
/** 展板内部排版的设计像素宽度：实际显示尺寸由锚点深度换算，
 *  内部用 --s = 显示宽/设计宽 等比缩放，排版不会因缩放而挤爆。 */
const BOARD_LAYOUT_PX = 320;

/** 「像素/米」测量结果是否可信（近裁剪面附近 1m 投影会飞出屏幕，数值不可用） */
function pxPerMeterOk(a, b) {
  if (!a || !b) return false;
  if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) return false;
  const d = Math.hypot(a.x - b.x, a.y - b.y);
  return d > 0.5 && d < 4000;
}
/** 三维实体屏的源纹理分辨率（CSS px）：matrix3d 把它映射到投影四边形 */
const SCREEN_TEX_W = 480;
/** 拖动启动阈值（屏幕 px）：小于它一律视为「单击」，绝不改写任何世界坐标。
 *  与 editor.js 的 TAP_PX=5 对齐并略放宽，容纳真实鼠标点击时的手部微抖。 */
const DRAG_PX = 6;

/* 三维小工具（旋转环的平面基 / 方位角要用到，只在本文件内使用） */
const cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit3 = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

function svg(tag, attrs = {}) {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
}
function div(cls, html = '') {
  const n = document.createElement('div');
  n.className = cls;
  if (html) n.innerHTML = html;
  return n;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmt(n, unit = '') { return (Math.round(n * 100) / 100).toFixed(2) + unit; }
function setText(node, txt) {
  const s = String(txt ?? '');
  if (node.textContent !== s) node.textContent = s;
}

export class Overlay {
  constructor({ host, getViewer, store, getScene, getSelected, getSelectedSet, onPick, isPreview, alwaysVisible,
    onBoardMove, onBoardResize, onBoardAnchor, onScreenMove, onScreenRotate,
    isEditable, isLocked,
    drapeLine, drapeQuad, isOccluded, drapeVersion, showDecalGuides,
    probeOcclusion }) {
    this.host = host;
    this.getViewer = getViewer;
    this.store = store;
    this.getScene = getScene;
    this.getSelected = getSelected;
    this.getSelectedSet = getSelectedSet || (() => (this.getSelected() ? [this.getSelected()] : []));
    this.onPick = onPick;
    this.isPreview = isPreview || (() => false);
    this.alwaysVisible = alwaysVisible || (() => false);
    // 展板拖拽回调：移动（编辑器用 pickSync 算新锚点）/ 缩放（overlay 用屏幕增量算新尺寸）
    this.onBoardMove = onBoardMove || null;
    this.onBoardResize = onBoardResize || null;
    // 引线锚点拖拽：编辑器用 snapToMesh 吸附到最近的碰撞 MESH 表面
    this.onBoardAnchor = onBoardAnchor || null;
    // 三维实体屏六向移动：overlay 按相机基向量把屏幕位移换算成世界位移，
    // 编辑器只负责把「起点 + 位移」写回 points[0]。
    this.onScreenMove = onScreenMove || null;
    // 三维实体屏「底心旋转锚点」拖拽：只改 style.yaw / pitch（位置不变）
    this.onScreenRotate = onScreenRotate || null;
    this.isEditable = isEditable || (() => !this.isPreview());
    // 选中一个对象后其余标注锁定：变暗 + 不可拾取 / 拖拽 / 编辑
    this.isLocked = isLocked || (() => false);
    // 动线贴合模型：drapeLine 返回贴合表面的世界中心线（与相机无关，overlay 内缓存）；
    // isOccluded / drapeVersion 供逐注记深度检测与缓存失效判定。
    this.drapeLine = drapeLine || null;
    // 贴面矩形：drapeQuad 把切平面网格逐点吸附到 MESH 表面
    this.drapeQuad = drapeQuad || null;
    this.isOccluded = isOccluded || null;
    this.drapeVersion = drapeVersion || (() => 0);
    /* 贴花辅助线框（OBB / 视锥台 12 条棱 + 拖拽手柄 + 占位框 + 标签）是否绘制。
       编辑态必须画（要拖拽、要看清体积）；浏览态只显示 GPU 投射的视频，
       线框属于编辑辅助，必须隐藏 —— 否则观众会在画面上看到一圈「铁丝网」。 */
    this.showDecalGuides = showDecalGuides || (() => true);
    /* 辅助线「场景深度判断」：把 OBB / 视锥台的棱和旋转环按深度快照逐段判定遮挡。
       探测是异步 + 节流的（1 次 prepare + 1 次块回读），绘制永远用上一轮结果，
       所以打开深度判断不会给每帧加任何 GPU 回读。 */
    this.probeOcclusion = probeOcclusion || null;

    this.layer = div('ed-layer');
    this.svg = svg('svg', { class: 'ed-svg' });
    this.doms = div('ed-doms');
    this.layer.append(this.svg, this.doms);
    host.appendChild(this.layer);

    this.nodes = new Map();     // id -> { el?, g?, parts }
    this.draft = null;          // { kind, points }
    this.cursor = null;         // 鼠标当前的世界坐标（橡皮筋终点）
    this._drag = null;          // 展板拖拽状态
    this._anchorDrag = null;    // 引线锚点拖拽状态
    this._screenDrag = null;    // 三维屏六向移动拖拽状态
    this._suppressClick = false;
    this._raf = 0;
    this._running = false;
    this.lastError = null;      // 最近一次 frame() 异常（循环保活，供诊断读取）
    this._errLogged = false;
    this._tmp = null;
    this._out = null;
  }

  /** 启动渲染循环。
   *  【必须先续链、再渲染】：旧实现是 `frame(); raf = requestAnimationFrame(loop)`，
   *  只要某一帧投影/绘制抛一次异常，`requestAnimationFrame` 那一行就永远执行不到，
   *  整条链静默死亡 —— 之后新建的标注全部不渲染（数据在、DOM 不在，看起来像
   *  「贴花没生成」「手柄不见了」）。现在把续链提前，并吞掉单帧异常：
   *  下一帧照常重试，同时把原因留在 lastError 里供诊断读取。 */
  start() {
    if (this._running) return;                 // 防重复启动（两次 loop 会让绘制量翻倍）
    this._running = true;
    const loop = () => {
      if (!this._running) return;
      this._raf = requestAnimationFrame(loop);
      try {
        this.frame();
        this.lastError = null;
        this._errLogged = false;
      } catch (e) {
        this.lastError = String((e && e.stack) || e);
        if (!this._errLogged) {
          this._errLogged = true;
          console.error('[overlay] frame 异常（循环已保活，下一帧重试）', e);
        }
      }
    };
    loop();
  }
  stop() {
    this._running = false;
    cancelAnimationFrame(this._raf);
    this._raf = 0;
  }
  destroy() {
    this.stop();
    this.layer.remove();
    this.nodes.clear();
    stopDemoVideoStream();
  }
  setDraft(kind, points) { this.draft = kind ? { kind, points: points.slice() } : null; }
  /** 鼠标当前位置的世界坐标；null 表示移出场景 */
  setCursor(pos) { this.cursor = pos; }

  _project(ctx, p) {
    const { cam, camPos, fwd, tmp, out, sx, sy, ox, oy } = ctx;
    const dx = p[0] - camPos.x, dy = p[1] - camPos.y, dz = p[2] - camPos.z;
    if (dx * fwd.x + dy * fwd.y + dz * fwd.z <= 0.05) return null;
    tmp.set(p[0], p[1], p[2]);
    cam.worldToScreen(tmp, out);
    if (!Number.isFinite(out.x) || !Number.isFinite(out.y)) return null;
    // worldToScreen 用 graphicsDevice.clientRect（canvas CSS 像素）；
    // 叠加层挂在 #mg-stage 上，这里换算成相对 host 的 CSS 像素，避免
    // canvas 与 stage 尺寸/偏移不一致时标注整体错位（表现为「画不进场景」）。
    return { x: out.x * sx + ox, y: out.y * sy + oy, d: Math.hypot(dx, dy, dz) };
  }

  /** 相机的世界 up（单位向量）。用来量「像素/米」：沿 up 走 1 米再投影，
   *  屏幕位移就是该深度的真实透视比例。取不到就用世界 +Y（展板本来就是重力对齐的）。 */
  _cameraUp(ctx) {
    const up = ctx?.cam?.entity?.up || ctx?.cam?.up;
    let v = up && Number.isFinite(up.x) ? [up.x, up.y, up.z] : [0, 1, 0];
    const len = Math.hypot(v[0], v[1], v[2]);
    if (!(len > 1e-6)) v = [0, 1, 0];
    else v = [v[0] / len, v[1] / len, v[2] / len];
    return v;
  }

  _context() {
    const v = this.getViewer();
    const cam = v?.app?.root?.findComponent?.('camera');
    if (!cam) return null;
    const camPos = cam.entity.getPosition();
    if (!this._tmp) { this._tmp = camPos.clone(); this._out = camPos.clone(); }
    const dev = v?.app?.graphicsDevice;
    const canvas = dev?.canvas;
    let sx = 1, sy = 1, ox = 0, oy = 0;
    if (canvas) {
      const cr = canvas.getBoundingClientRect();
      const hr = this.host.getBoundingClientRect();
      const dw = dev.clientRect?.width || cr.width || 1;
      const dh = dev.clientRect?.height || cr.height || 1;
      sx = cr.width / dw; sy = cr.height / dh;
      ox = cr.left - hr.left; oy = cr.top - hr.top;
    }
    return { cam, camPos, fwd: cam.entity.forward, tmp: this._tmp, out: this._out, sx, sy, ox, oy };
  }

  frame() {
    const ctx = this._context();
    if (!ctx) return;
    const selSet = this.getSelectedSet();
    const scale = this.store.calibration().scale;
    const scene = this.getScene();
    const alwaysVisible = this.alwaysVisible();
    const visibleIds = new Set();

    for (const a of this.store.list(scene)) {
      if (!a.visible) continue;
      // 分组整组显隐：不改写标注自身的 visible，取消隐藏后原状态原样恢复
      if (this.store.groupVisible && !this.store.groupVisible(a)) continue;
      const layer = this.store.layer(a.layerId);
      if (layer && !layer.visible) continue;
      // 逐注记深度检测：开启后，若「实际渲染几何」的全部采样点都被前方模型挡住就隐藏。
      // 关键修正：遮挡判定必须用真正画出来的几何，而不是标注的原始落点——
      // 动线已贴到地面（draped 中心线）、贴面矩形是深度反算网格、面域内部也被墙挡，
      // 用空中原始点判定会「已贴地却判未遮挡」或反之。默认关闭 => 始终置顶可见。
      if (a.depthTest && this.isOccluded &&
          this._occludePoints(a).every(p => this.isOccluded(p))) { this._hide(a.id); continue; }
      const pts = a.points.map(p => this._project(ctx, p));
      // 贴面矩形的几何来自深度反算网格，两个兼容锚点偶尔落到相机背后也不该整块消失。
      // 透视贴花同理：几何完全由 projector（视锥体）决定，而「光心」锚点恰恰经常
      // 就贴在相机附近甚至身后 —— 绝不能因此把整条贴花判成"不可见"。
      const hasSurface = a.kind === 'decal' &&
        (a.projector?.mode === 'persp' ||
          (Array.isArray(a.surface?.points) && a.surface.points.length > 3));
      if (pts.some(p => !p) && !hasSurface) { this._hide(a.id); continue; }
      const isSel = selSet.includes(a.id);
      const locked = !isSel && this.isLocked(a.id);
      this._draw(a, pts, isSel, scale, alwaysVisible, ctx, locked);
      visibleIds.add(a.id);
    }
    for (const id of this.nodes.keys()) if (!visibleIds.has(id)) this._hide(id);
    this._drawDraft(ctx);
  }

  _hide(id) {
    const n = this.nodes.get(id);
    if (n) {
      n.el?.remove(); n.g?.remove();
      // 六向手柄 / 底心旋转锚点挂在独立 DOM 层（不受 matrix3d 变形），必须一起清掉
      n.parts?.screen?.gizmo?.remove();
      n.parts?.screen?.rot?.remove();
      n.parts?.decalOBB?.g?.remove();
      this.nodes.delete(id);
    }
  }

  /** 逐注记深度检测所用的「实际渲染几何」采样点。
   *  动线用贴合后的中心线（drapePolyline 结果，已贴地），
   *  贴面矩形用深度反算网格，面域补 centroid，其余用原始顶点。
   *  这样才能判定「真实画出来的部分」是否被遮挡，而非空中原始落点。 */
  _occludePoints(a) {
    if (a.kind === 'line') {
      const w = this.nodes.get(a.id)?.parts?.flow?.world;
      if (Array.isArray(w) && w.length) return w;
      // 还没跑到渲染（首帧 / 隐藏）时，用持久化的贴地中心线判定
      if (Array.isArray(a.drape) && a.drape.length) return a.drape;
    }
    if (a.kind === 'decal' && Array.isArray(a.surface?.points) && a.surface.points.length) {
      const pts = a.surface.points, step = Math.max(1, Math.floor(pts.length / 12));
      const out = [];
      for (let i = 0; i < pts.length; i += step) out.push(pts[i]);
      return out;
    }
    if (a.kind === 'area' && a.points.length >= 3) {
      const cx = a.points.reduce((s, p) => s + p[0], 0) / a.points.length;
      const cy = a.points.reduce((s, p) => s + p[1], 0) / a.points.length;
      const cz = a.points.reduce((s, p) => s + p[2], 0) / a.points.length;
      return a.points.concat([[cx, cy, cz]]);
    }
    /* 三维实体屏 / 展板：面板面积大，只用锚点一条射线判定「是否被遮挡」太激进 ——
       相机平移时墙角 / 柱子掠过锚点，整块面板就瞬间消失（用户反馈 3）。
       这里取面板的四角 + 中心共 5 个世界点，只有**全部**被挡才隐藏。 */
    if (a.kind === 'screen' && Array.isArray(a.points?.[0])) {
      const geo = screenCorners(a.points[0], a.style?.size || { w: 2.4, h: 1.35 },
        a.style?.yaw, a.style?.pitch);
      return [geo.center, ...geo.corners];
    }
    if (a.kind === 'board' && Array.isArray(a.points?.[0])) {
      const c = a.points[0];
      const r = Math.max(0.4, Number(a.style?.size?.w) || 1.8) * 0.35;
      return [c,
        [c[0] + r, c[1], c[2]], [c[0] - r, c[1], c[2]],
        [c[0], c[1] + r, c[2]], [c[0], c[1] - r, c[2]]];
    }
    return a.points;
  }

  /** 标注在屏幕上的包围盒（用于框选命中测试与对齐吸附）。
   *  三维屏用四角、贴面用深度反算网格，其余用顶点投影。 */
  _bbox(ctx, a) {
    let pts = a.points;
    if (a.kind === 'screen') {
      const size = a.style.size || { w: 1.8, h: 1.35 };
      const geo = screenCorners(a.points[0], size, a.style.yaw, a.style.pitch);
      pts = geo.corners;
    } else if (a.kind === 'decal' && a.projector?.mode === 'persp') {
      // 透视贴花没有 surface 网格：用视锥体 8 角点做包围盒（框选 / 对齐吸附才准）
      pts = projectorVolumeCorners(a.projector) || pts;
    } else if (a.kind === 'decal' && Array.isArray(a.surface?.points) && a.surface.points.length) {
      pts = a.surface.points;
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, any = false;
    for (const p of pts) {
      const s = this._project(ctx, p);
      if (!s) continue;
      any = true;
      if (s.x < x0) x0 = s.x; if (s.y < y0) y0 = s.y;
      if (s.x > x1) x1 = s.x; if (s.y > y1) y1 = s.y;
    }
    return any ? { x0, y0, x1, y1 } : null;
  }

  /** 框选：返回屏幕矩形内（相交）的所有标注 id */
  selectionRectHit(rect, scene) {
    const ctx = this._context(); if (!ctx) return [];
    const out = [];
    for (const a of this.store.list(scene)) {
      const b = this._bbox(ctx, a); if (!b) continue;
      if (b.x0 <= rect.x1 && b.x1 >= rect.x0 && b.y0 <= rect.y1 && b.y1 >= rect.y0) out.push(a.id);
    }
    return out;
  }

  /** 对齐吸附：把移动组的包围盒（含当前位移 dx,dy）的边 / 中线，与候选目标的边 / 中线对齐。
   *  命中阈值内取偏差最小者，返回吸附后的位移与引导线。 */
  _computeAlign(group, targets, dx, dy, th = 6) {
    const xs = [group.x0 + dx, (group.x0 + group.x1) / 2 + dx, group.x1 + dx];
    const ys = [group.y0 + dy, (group.y0 + group.y1) / 2 + dy, group.y1 + dy];
    let best = null;
    const consider = (val, tval, axis, tbox) => {
      const off = tval - val;
      if (Math.abs(off) <= th && (!best || Math.abs(off) < Math.abs(best.off)))
        best = { off, axis, line: tval,
          a0: axis === 'x' ? Math.min(group.y0 + dy, tbox.y0) : Math.min(group.x0 + dx, tbox.x0),
          a1: axis === 'x' ? Math.max(group.y1 + dy, tbox.y1) : Math.max(group.x1 + dx, tbox.x1) };
    };
    for (const t of targets) {
      const tx = [t.x0, (t.x0 + t.x1) / 2, t.x1];
      const ty = [t.y0, (t.y0 + t.y1) / 2, t.y1];
      for (const v of xs) for (const tv of tx) consider(v, tv, 'x', t);
      for (const v of ys) for (const tv of ty) consider(v, tv, 'y', t);
    }
    if (!best) return { dx, dy, guides: [] };
    if (best.axis === 'x') return { dx: dx + best.off, dy, guides: [{ x: best.line, y0: best.a0, y1: best.a1 }] };
    return { dx: dx, dy: dy + best.off, guides: [{ y: best.line, x0: best.a0, x1: best.a1 }] };
  }

  _ensureGuides() {
    if (this.guideLayer) return this.guideLayer;
    const layer = svg('svg', { class: 'ed-guides' });
    layer.setAttribute('style', 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible;z-index:50');
    (this.host || document.body).appendChild(layer);
    this.guideLayer = layer;
    return layer;
  }
  _drawGuides(guides) {
    const layer = this._ensureGuides();
    layer.innerHTML = '';
    for (const g of guides || []) {
      const ln = svg('line', { stroke: '#ffd23f', 'stroke-width': 1, 'stroke-dasharray': '4 3' });
      if (g.x != null) { ln.setAttribute('x1', g.x); ln.setAttribute('y1', g.y0); ln.setAttribute('x2', g.x); ln.setAttribute('y2', g.y1); }
      else { ln.setAttribute('x1', g.x0); ln.setAttribute('y1', g.y); ln.setAttribute('x2', g.x1); ln.setAttribute('y2', g.y); }
      layer.appendChild(ln);
    }
  }
  _clearGuides() { if (this.guideLayer) this.guideLayer.innerHTML = ''; }

  _node(a, which) {
    let n = this.nodes.get(a.id);
    if (!n) { n = { parts: {} }; this.nodes.set(a.id, n); }
    if (which === 'el' && !n.el) {
      // 注意：ed-item 承载 position:absolute，**不能**被后续 className 覆盖掉
      n.el = div('ed-item');
      n.el.dataset.id = a.id;
      n.el.addEventListener('click', e => {
        e.stopPropagation();
        if (this._suppressClick) return;       // 拖拽结束后抑制误触发的 click
        // 展板内容直接内嵌在三维空间中，单击只选中，绝不弹出独立页面
        const toggle = e.shiftKey || e.ctrlKey || e.metaKey;
        this.onPick(a.id, toggle ? 'toggle' : 'select', { shift: e.shiftKey, ctrl: e.ctrlKey, meta: e.metaKey });
      });
      // 双击一律不触发任何事件（见 editor.js stage 捕获层）：此处不再挂
      // dblclick 监听，程序化派发到元素上的双击也只会被 stage 吞掉。
      this.doms.appendChild(n.el);
    }
    if (which === 'g' && !n.g) {
      n.g = svg('g', { class: 'ed-g', 'data-id': a.id });
      n.g.addEventListener('click', e => { e.stopPropagation(); if (this._suppressClick) return; const t = e.shiftKey || e.ctrlKey || e.metaKey; this.onPick(a.id, t ? 'toggle' : 'select', { shift: e.shiftKey, ctrl: e.ctrlKey, meta: e.metaKey }); });
      this.svg.appendChild(n.g);
    }
    return n;
  }

  /** 追加类名而不是覆盖：保住 .ed-item 的定位能力 */
  _syncClass(el, cls, sel, fade, locked) {
    const want = 'ed-item ' + cls + (sel ? ' ed-sel' : '') +
      (locked ? ' ed-locked' : '') + (fade ? ' ed-far' : '');
    if (el.className !== want) el.className = want;
  }

  _draw(a, pts, selected, scale, alwaysVisible, ctx, locked = false) {
    const c = a.style.color;
    const sel = selected ? ' ed-sel' : '';
    const lockCls = locked ? ' ed-locked' : '';
    switch (a.kind) {
      case 'point':
      case 'board':
      case 'screen': {
        const n = this._node(a, 'el');
        const p = pts[0];
        // 锁定态：不再接受任何真实鼠标命中（程序化 dispatchEvent 仍可触发监听器）
        n.el.style.pointerEvents = locked ? 'none' : '';
        if (a.kind === 'board') this._drawBoard(a, n, p, scale, alwaysVisible, sel, ctx, locked);
        else if (a.kind === 'screen') this._drawScreen(a, n, sel, ctx, locked);
        else this._drawPoint(a, n, p, alwaysVisible, sel, locked);
        break;
      }
      case 'decal': {
        this._drawDecal(a, pts, selected, ctx, locked);
        break;
      }
      case 'line':
      case 'area':
      case 'measure': {
        const n = this._node(a, 'g');
        const isFlow = a.kind === 'line';       // 动线：贴合模型的等宽箭头形状多边形链
        const closed = a.kind === 'area';
        const tag = closed ? 'polygon' : 'polyline';
        const coords = pts.map(p => `${p.x},${p.y}`).join(' ');
        let shape = n.parts.shape;
        if (!shape || n.parts.tag !== tag) {
          shape?.remove();
          shape = svg(tag, { class: 'ed-shape' });
          n.g.appendChild(shape);
          n.parts.shape = shape; n.parts.tag = tag;
        }
        shape.setAttribute('points', coords);
        if (isFlow) {
          // 动线本体是面状箭头链。若箭头链因投影退化 / 贴合结果塌缩而画不出来，
          // 必须让这根折线显式可见作为兜底 —— 否则用户看到的就是「只有顶点、没有线」。
          const flowOk = this._drawFlow(a, n, pts, ctx, c, locked);
          shape.setAttribute('fill', 'none');
          shape.setAttribute('stroke', flowOk ? 'transparent' : c);
          shape.setAttribute('stroke-opacity', flowOk ? '0' : '0.95');
          /* 箭头之间有空隙、箭头凹口处也没有面：保留一条「不可见的宽描边」当命中区。
             否则在这些缝里点击会穿透到 stage —— 绘制工具下就又多落一个点、新建出一个
             标注（用户反馈：选中/交互对象时点击不该新建）。pointer-events:stroke 与
             描边是否可见无关，透明也能命中。 */
          shape.setAttribute('stroke-width', flowOk ? '18' : Math.max(3, Number(a.style.strokeWidth) || 2));
          shape.setAttribute('stroke-dasharray', 'none');
          shape.style.pointerEvents = locked ? 'none' : 'stroke';
        } else {
          shape.style.pointerEvents = locked ? 'none' : '';
          shape.setAttribute('fill', closed ? c : 'none');
          shape.setAttribute('fill-opacity', closed ? '0.18' : '0');
          shape.setAttribute('stroke', c);
          shape.setAttribute('stroke-width', a.style.strokeWidth);
          shape.setAttribute('stroke-dasharray', a.kind === 'measure' ? '6 4' : 'none');
          if (n.parts.flow) this._hideFlow(n);
        }
        n.g.setAttribute('class', 'ed-g' + sel + lockCls);
        n.g.style.pointerEvents = locked ? 'none' : '';

        // 顶点手柄
        if (!n.parts.dots) { n.parts.dots = []; }
        while (n.parts.dots.length < pts.length) {
          const d = svg('circle', { r: 3.5, class: 'ed-vertex' });
          n.g.appendChild(d); n.parts.dots.push(d);
        }
        n.parts.dots.forEach((d, i) => {
          d.style.display = i < pts.length ? '' : 'none';
          if (i < pts.length) { d.setAttribute('cx', pts[i].x); d.setAttribute('cy', pts[i].y); d.setAttribute('fill', c); }
        });

        // 读数 / 标题
        if (!n.parts.text) {
          n.parts.text = svg('text', { class: 'ed-measure' });
          n.g.appendChild(n.parts.text);
        }
        let label = a.style.showLabel ? a.title : '';
        if (a.kind === 'measure') label = fmt(distance(a.points[0], a.points[1], scale), ' m');
        else if (a.kind === 'line') label = (a.title ? a.title + ' · ' : '') + fmt(pathLength(a.points, scale), ' m');
        else if (a.kind === 'area') label = (a.title ? a.title + ' · ' : '') + fmt(polygonArea(a.points, scale), ' m²');
        const mid = pts[Math.floor(pts.length / 2)];
        setText(n.parts.text, label);
        n.parts.text.setAttribute('x', mid.x + 8);
        n.parts.text.setAttribute('y', mid.y - 8);
        n.parts.text.setAttribute('fill', c);
        break;
      }
    }
  }

  // ------------------------------------------------------------- 动线：贴合模型的等宽箭头链
  _hideFlow(n) {
    const f = n.parts.flow;
    if (f?.chain) f.chain.style.display = 'none';
  }

  /**
   * 动线 = 一串首尾相接的「箭头形状面片」，在**世界空间**沿贴合碰撞 mesh 的
   * 中心线铺放（不再使用屏幕空间多边形 —— 那本质是永远朝向摄像机的 billboard）。
   *
   *  ① 贴合模型：a.points 先经 picker.drapePolyline() 等距重采样并逐点吸附到
   *     碰撞 MESH 表面，得到随地形起伏的世界中心线；结果只与几何有关，
   *     按 (顶点 / 带宽 / MESH 版本) 签名缓存，绝不每帧打几百条射线。
   *  ② 面片在世界空间构造（schema.arrowChainWorld）：t 方向取「切线 × 世界 up」
   *     的水平侧向，面片水平贴在底面表面上，随透视自然近大远小；
   *     抬高 3 cm 避免与碰撞体网格显示模式 z-fight。
   *  ③ 箭头指向即轮廓：每个面片自带箭头尖；相位让整串面片沿路径**向箭头
   *     指向的前方**推进（schema 已修相位符号），动画方向与箭头方向一致。
   *  ④ 兜底：世界面片投影失败 / 贴合塌缩时返回 false，由调用方把底层折线
   *     显式画出来（保证「有线可画」），绝不退回 billboard 箭头。
   */
  _drawFlow(a, n, pts, ctx, c, locked = false) {
    if (!n.parts.flow) {
      const chain = svg('g', { class: 'ed-flow-chain' });
      n.g.appendChild(chain);
      n.parts.flow = { chain, segs: [], color: null, sig: null, world: null };
    }
    const f = n.parts.flow;
    f.chain.style.display = '';
    if (f.color !== c) {
      f.color = c;
      f.chain.style.color = c;                 // currentColor 供填充 / 发光使用
    }

    const bw = Math.max(0.1, Math.min(4, Number(a.style.bandWidth ?? 0.7)));
    // 带宽语义从「屏幕 px」改为「世界米」：0.7 档 ≈ 0.63 m 带宽（人行动线尺度）
    const halfW = Math.max(0.12, Math.min(2, bw * 0.45));
    const segLen = Math.max(0.8, halfW * 4.6);          // 段长 > 带宽：箭头细长、指向清晰

    /* 贴地中心线优先级：
       ① a.drape —— 编辑器算好并持久化的「深度反算贴地折线」（与贴花同源）。
          浏览态没有任何拾取能力，靠的就是它；pointsSig 不一致说明顶点已经改过、
          这份结果过期，必须退回原始折线等编辑器重算，绝不能继续画旧位置。
       ② drapeLine 回调 —— 编辑器内的即时兜底（碰撞 MESH 垂直吸附）。
       ③ 原始顶点。 */
    const pointsSig = JSON.stringify(a.points);
    const stored = Array.isArray(a.drape) && a.drape.length >= 2 &&
      (!a.drapeMeta?.pointsSig || a.drapeMeta.pointsSig === pointsSig);
    // 贴合缓存：drape 与相机无关，只有顶点 / 带宽 / 贴地结果版本变化才重算
    const sig = stored
      ? `stored|${a.drape.length}|${a.drapeMeta?.at || 0}|${bw}`
      : `${pointsSig}|${bw}|${this.drapeVersion()}`;
    if (f.sig !== sig) {
      f.sig = sig;
      if (stored) f.world = a.drape;
      else f.world = this.drapeLine ? this.drapeLine(a.points) : a.points;
    }
    const FLOW_LIFT = 0.03;
    const world = (f.world || a.points)
      .filter(p => Array.isArray(p) && p.length >= 3 && p.every(Number.isFinite))
      .map(p => [p[0], p[1] + FLOW_LIFT, p[2]]);

    const speed = Math.max(0.1, Math.min(4, Number(a.style.flowSpeed ?? 1.4)));
    const phase = (performance.now() / 1000 * speed * 0.5) % 1;
    const showArrow = a.style.flowArrow !== false;
    // 视线方向：沿墙面向上爬等「切线接近竖直」的段落，世界 up 参考会退化，
    // 由 schema 改用「切线 × 视线」定位向，避免面片垂直于墙面变成尖刺 / 乱转
    const viewDir = ctx.fwd ? [ctx.fwd.x, ctx.fwd.y, ctx.fwd.z] : null;
    const polys3 = arrowChainWorld(world, halfW, segLen, phase, { arrow: showArrow, viewDir });
    // 世界面片逐顶点投影；任一顶点投影失败（近裁 / 背后）就丢弃该面片
    const polys = polys3.map(poly => {
      const pr = poly.map(p => this._project(ctx, p));
      return pr.every(Boolean) ? pr.map(p => [p.x, p.y]) : null;
    }).filter(Boolean);
    if (!polys.length) { this._hideFlow(n); return false; }

    // 段数变化时增删 polygon；之后只改 points，不重建 DOM（不闪烁 / 不丢事件）
    while (f.segs.length < polys.length) {
      const p = svg('polygon', { class: 'ed-flow-arrow-seg' });
      f.chain.appendChild(p); f.segs.push(p);
    }
    f.segs.forEach((el, i) => {
      if (i >= polys.length) { el.style.display = 'none'; return; }
      el.style.display = '';
      el.style.pointerEvents = locked ? 'none' : 'all';
      el.setAttribute('points', polys[i].map(([x, y]) =>
        `${x.toFixed(1)},${y.toFixed(1)}`).join(' '));
      // 越靠前（沿路径）的箭头略亮，形成方向感；整体仍是同一颜色半透明
      el.setAttribute('fill-opacity', String((0.24 + 0.16 * (i / Math.max(1, polys.length - 1))).toFixed(3)));
    });
    return true;
  }

  // ------------------------------------------------------------- 点标注
  _drawPoint(a, n, p, alwaysVisible, sel, locked = false) {
    if (!n.parts.pin) {
      n.el.innerHTML = '<span class="ed-pin-dot"></span><span class="ed-pin-label"></span>';
      n.parts.pin = {
        dot: n.el.querySelector('.ed-pin-dot'),
        label: n.el.querySelector('.ed-pin-label'),
      };
      n.parts.pin.dot.textContent = a.style.icon || '●';
    }
    setText(n.parts.pin.label, a.title || '');
    n.el.dataset.kind = a.kind;
    this._syncClass(n.el, 'ed-pin', !!sel, isPreviewFade(a, p.d, alwaysVisible), locked);
    n.el.style.left = p.x + 'px';
    n.el.style.top = p.y + 'px';
    n.el.style.setProperty('--c', c_of(a));
    n.el.style.setProperty('--op', String(a.style.opacity));
  }

  // ------------------------------------------------------------- 展板（悬浮矩形全息面板）
  _drawBoard(a, n, p, scale, alwaysVisible, sel, ctx, locked = false) {
    if (!n.parts.board) {
      // 结构只建一次：iframe / video 反复重建会导致每次编辑都闪一下
      n.el.innerHTML = `
        <div class="ed-board-lead"><i class="ed-board-lead-dot" data-role="board-anchor" title="拖动：引线锚点自动吸附到最近的碰撞 MESH"></i></div>
        <div class="ed-board-in">
          <div class="ed-board-grid"></div>
          <div class="ed-board-hd">
            <span class="ed-board-ico">▤</span>
            <b class="ed-board-title"></b>
            <span class="ed-board-kind">展板</span>
          </div>
          <div class="ed-board-body">
            <div class="ed-board-text"></div>
            <div class="ed-board-media"></div>
          </div>
          <div class="ed-board-ft">
            <span class="ed-board-dot"></span>
            <span class="ed-board-meta"></span>
          </div>
          <i class="ed-board-c tl"></i><i class="ed-board-c tr"></i>
          <i class="ed-board-c bl"></i><i class="ed-board-c br"></i>
        </div>
        <i class="ed-board-corner tl" data-corner="tl"></i><i class="ed-board-corner tr" data-corner="tr"></i>
        <i class="ed-board-corner bl" data-corner="bl"></i><i class="ed-board-corner br" data-corner="br"></i>`;
      const q = (s) => n.el.querySelector(s);
      n.parts.board = {
        title: q('.ed-board-title'),
        text: q('.ed-board-text'),
        media: q('.ed-board-media'),
        meta: q('.ed-board-meta'),
        lead: q('.ed-board-lead'),
        dot: q('.ed-board-lead-dot'),
      };
      // 拖拽手势（移动 / 四角缩放 / 引线锚点）只绑定一次
      this._attachBoardDrag(a, n);
      this._attachBoardAnchor(a, n);
    }
    const b = n.parts.board;
    setText(b.title, a.title || '未命名展板');
    setText(b.text, a.body || '');

    // 媒体区：签名变了才重建，避免 iframe / video 被反复重载
    const media = (a.media || [])[0];
    const sig = media ? `${media.type}|${media.url}|${media.caption || ''}` : '';
    if (b.media.dataset.sig !== sig) {
      b.media.dataset.sig = sig;
      b.media.innerHTML = boardMediaHtml(media);
    }
    const mt = media ? ({ image: '图片', video: '视频', webpage: '网页', text: '文字', link: '链接' })[media.type] || '媒体' : '纯文字';
    setText(b.meta, `${mt} · 三维空间内嵌展示${a.link ? ' · 含外链' : ''}`);

    /* 几何：世界尺寸 size（米）-> 屏幕像素。
       【深度对齐】展板的屏幕尺寸必须由**锚点所在深度**的真实透视决定，否则它看起来
       浮在与锚点不同的深度上（旧的 clamp(0.8,1.4, 18/d) 是假透视：>22m 就不再缩小、
       <13m 就停止放大，于是近处展板反而比锚点「远」）。
       这里不猜 fov / 画布高度：直接把「锚点」和「锚点上方 1 米」都投影一次，差值就是
       该深度处的「像素/米」，对 DPR、fovAxis、非对称视锥一律成立。 */
    const size = a.style.size || { w: 1.8, h: 1.35 };
    const anchorW = a.points[0] || [0, 0, 0];
    const upW = this._cameraUp(ctx);
    const pUp = this._project(ctx, [
      anchorW[0] + upW[0], anchorW[1] + upW[1], anchorW[2] + upW[2]
    ]);
    const pxPerMeter = pUp && pxPerMeterOk(pUp, p) ? Math.hypot(pUp.x - p.x, pUp.y - p.y) : 0;
    // 兜底（相机几乎正对锚点 / 上方 1m 出画）：按距离给一个合理的估算，不让展板消失
    const ppm = pxPerMeter > 1 ? pxPerMeter : Math.max(4, 480 / Math.max(0.6, p.d));
    const zoom = ppm / BOARD_BASE_PX;        // 与 BOARD_BASE_PX 同一口径，拖拽换算直接复用
    const pw = size.w * ppm;
    const ph = size.h * ppm;
    // 悬浮间隙也是世界量（12cm），随深度等比缩放，不再固定 14px
    const gapPx = Math.max(3, Math.min(60, BOARD_GAP_WORLD * ppm));
    // 记录本帧屏幕几何，供拖拽换算（px 增量 -> 世界尺寸）
    n.parts.anchorScreen = { ax: p.x, ay: p.y, zoom, gap: gapPx, pw, ph, size: { ...size } };

    n.el.dataset.kind = a.kind;
    this._syncClass(n.el, 'ed-board', !!sel, isPreviewFade(a, p.d, alwaysVisible), locked);
    n.el.style.left = p.x + 'px';
    n.el.style.top = p.y + 'px';
    n.el.style.setProperty('--c', c_of(a));
    n.el.style.setProperty('--op', String(a.style.opacity));
    n.el.style.setProperty('--w', pw.toFixed(1) + 'px');
    n.el.style.setProperty('--h', ph.toFixed(1) + 'px');
    /* 内部内容按固定设计尺寸排版，再用 --s 等比缩放：
       这样展板整体（含标题 / 正文 / 内嵌网页）随深度真实缩放，而排版不会因为
       --w 变小而挤成一团（旧做法直接把 --w 压小 → 文字溢出 / 换行爆炸）。 */
    n.el.style.setProperty('--bw', BOARD_LAYOUT_PX + 'px');
    n.el.style.setProperty('--bh', Math.round(BOARD_LAYOUT_PX * size.h / Math.max(0.05, size.w)) + 'px');
    n.el.style.setProperty('--s', (pw / BOARD_LAYOUT_PX).toFixed(4));
    // 以锚点为底心向上悬浮 gapPx（世界 12cm 在该深度的像素数）；导引线从展板底连到锚点。
    n.el.style.transform = `translate(-50%, calc(-100% - ${gapPx.toFixed(1)}px))`;

    // 引线锚点：默认落在展板脚下 gapPx；一旦 style.leadTo 有值（拖拽锚点后），
    // 就把导引线拉长 / 旋转到那个世界点的投影位置。
    const lt = a.style.leadTo;
    const valid = Array.isArray(lt) && lt.length >= 3 && lt.every(Number.isFinite);
    const target = valid ? (this._project(ctx, lt) || { x: p.x, y: p.y }) : { x: p.x, y: p.y };
    const dx = target.x - p.x;
    const dy = target.y - (p.y - gapPx);
    const len = Math.max(8, Math.hypot(dx, dy));
    const angle = Math.atan2(-dx, dy);          // 默认向下 (0,1)，顺时针旋转到目标方向
    n.el.style.setProperty('--gap', len + 'px');
    b.lead.style.height = len + 'px';
    b.lead.style.transform = `translateX(-50%) rotate(${angle}rad)`;
    b.lead.classList.toggle('ed-lead-long', valid);
    const editable = this.isEditable();
    b.dot.classList.toggle('ed-anchor-draggable', editable);
    b.dot.style.pointerEvents = editable ? 'auto' : 'none';
    b.dot.title = editable ? '拖动：引线锚点自动吸附到最近的碰撞 MESH' : '引线锚点（预览态只读）';
    n.parts.anchorScreen.lead = { x: target.x, y: target.y, len, angle };
  }

  // ------------------------------------------------------------- 三维实体屏（世界空间固定平面）
  /** 与「悬浮 HUD 展板」完全不同：
   *   · 位置 / 世界尺寸 / 朝向全部是数据，不随相机改变（style.yaw / pitch / size）；
   *   · 四个世界角点分别投影，再用 CSS matrix3d 单应变换贴到透视四边形上，
   *     因此相机绕到侧面会自然被压扁、走到背面会看到背板，和真实显示屏一致；
   *   · 不绑定任何拖拽手势：点击只选中，绝不改变位置（需求 1 的同类保障）。 */
  _drawScreen(a, n, sel, ctx, locked = false) {
    if (!n.parts.screen) {
      n.el.innerHTML = `
        <div class="ed-screen-bezel">
          <div class="ed-screen-glass">
            <video class="ed-screen-video" muted loop playsinline autoplay preload="none"></video>
            <div class="ed-screen-scan"></div>
            <div class="ed-screen-glare"></div>
          </div>
          <div class="ed-screen-top">
            <span class="ed-screen-ico">▣</span>
            <b class="ed-screen-title"></b>
            <span class="ed-screen-tag">3D SCREEN</span>
          </div>
          <div class="ed-screen-foot">
            <span class="ed-screen-led"></span>
            <span class="ed-screen-meta"></span>
          </div>
          <i class="ed-screen-screw tl"></i><i class="ed-screen-screw tr"></i>
          <i class="ed-screen-screw bl"></i><i class="ed-screen-screw br"></i>
        </div>
        <div class="ed-screen-stand"></div>
        <div class="ed-screen-backplate">BACK PANEL</div>`;
      const q = (s) => n.el.querySelector(s);
      n.parts.screen = {
        title: q('.ed-screen-title'),
        meta: q('.ed-screen-meta'),
        video: q('.ed-screen-video'),
      };
      n.el.dataset.kind = a.kind;   // 首帧即使投影退化，也要带对类型标记
    }
    const s = n.parts.screen;

    const size = a.style.size || { w: 2.4, h: 1.35 };
    const W = SCREEN_TEX_W;
    const H = Math.max(120, Math.round(W * (Number(size.h) || 1.35) / (Number(size.w) || 2.4)));
    if (n.el.style.width !== W + 'px') {
      n.el.style.width = W + 'px';
      n.el.style.height = H + 'px';
    }

    const geo = screenCorners(a.points[0], size, a.style.yaw, a.style.pitch);
    const quad = geo.corners.map(c => this._project(ctx, c));
    // 近裁剪面保护：角点进入相机近裁（d 趋近 0）时，worldToScreen 除以极小的 w
    // 会返回一个超大坐标，homographyMatrix3d 据此生成畸变 / 翻转的 matrix3d，
    // 屏面被拉成巨大色块。这里在角点越过近裁时直接优雅隐藏（保留选中手柄由下方逻辑处理）。
    const nearClip = (ctx.cam?.nearClip || 0.1);
    /* 近裁保护只隐藏「屏体本身」，选中手柄与底心旋转锚点必须继续画：
       否则面板一旦贴近镜头越过近裁（平移屏体时非常容易发生），抓手也一起消失，
       用户就再也拖不回来 —— 表现就是「三维展板平移时突然消失」。 */
    if (quad.some(v => !v || v.d < nearClip)) {
      n.el.style.display = 'none';
      this._drawScreenHandles(a, n, geo, size, ctx, sel, locked);
      return;
    }
    // 若相机 right 与屏面局部 right 相反（部分 mock 相机 / 反向视角），四角会
    // 左右颠倒，导致屏内文字被镜像。用屏幕有向面积判定并交换左右角点，
    // 让纹理始终正向贴合；真实相机下 cross>0，此处不触发，无副作用。
    const cross = (quad[1].x - quad[0].x) * (quad[3].y - quad[0].y)
      - (quad[1].y - quad[0].y) * (quad[3].x - quad[0].x);
    const q4 = cross < 0 ? [quad[1], quad[0], quad[3], quad[2]] : quad;
    const matrix = homographyMatrix3d(q4, W, H);
    if (!matrix) {                                 // 四点单应退化：同上，只收屏体
      n.el.style.display = 'none';
      this._drawScreenHandles(a, n, geo, size, ctx, sel, locked);
      return;
    }
    n.el.style.display = '';
    n.el.style.left = '0px';
    n.el.style.top = '0px';
    n.el.style.transformOrigin = '0 0';
    n.el.style.transform = matrix;

    // 相机是否位于屏面正面（法向点积）；背面时显示金属背板，符合实体模型语义
    const cp = ctx.camPos;
    const toCam = [cp.x - geo.center[0], cp.y - geo.center[1], cp.z - geo.center[2]];
    const facing = geo.normal[0] * toCam[0] + geo.normal[1] * toCam[1] + geo.normal[2] * toCam[2] > 0;

    n.el.dataset.kind = a.kind;
    this._syncClass(n.el, 'ed-screen', !!sel, false, locked);   // 实体屏不做距离淡出
    n.el.classList.toggle('ed-screen-back', !facing);
    n.el.style.setProperty('--c', c_of(a));
    n.el.style.setProperty('--op', String(a.style.opacity));
    setText(s.title, a.title || '三维实体屏');
    const media = (a.media || [])[0] || null;
    const url = media?.type === 'video' ? (media.url || '') : '';
    setText(s.meta, `${Number(size.w).toFixed(2)} × ${Number(size.h).toFixed(2)} m · ` +
      `yaw ${Number(a.style.yaw || 0).toFixed(0)}° · ${url ? '视频源' : '演示画面'}`);

    // 片源只建一次 / 只在签名变化时切换，避免每帧重载导致闪烁。
    // 未填 URL 时播放「程序生成的演示流」：真实 <video> 在播且零网络请求。
    const sig = `video|${url}|${a.style.muted !== false}|${a.style.loop !== false}`;
    if (s.video.dataset.sig !== sig) {
      s.video.dataset.sig = sig;
      s.video.muted = a.style.muted !== false;
      s.video.loop = a.style.loop !== false;
      if (url) {
        try { s.video.srcObject = null; } catch { /* noop */ }
        if (s.video.getAttribute('src') !== url) s.video.setAttribute('src', url);
      } else {
        s.video.removeAttribute('src');
        const stream = demoVideoStream();
        if (stream) { try { s.video.srcObject = stream; } catch { /* noop */ } }
      }
      const pr = s.video.play?.();
      if (pr?.catch) pr.catch(() => { /* 自动播放策略拒绝时静默降级 */ });
    }

    this._drawScreenHandles(a, n, geo, size, ctx, sel, locked);
  }

  /** 三维屏的交互抓手：三轴 gizmo（X/Y/Z）+ 中心柄 + 底心旋转锚点。
   *  与「屏体能否画出来」解耦 —— 屏体贴着镜头越过近裁、四点单应退化时仍要显示，
   *  否则面板一消失用户就再也抓不到它。 */
  _drawScreenHandles(a, n, geo, size, ctx, sel, locked = false) {
    const s = n.parts.screen;
    // ---------- 三轴 gizmo（X/Y/Z 轴柄）+ 中心选择柄 + 屏体拖动 ----------
    const editable = !locked && this.isEditable() && !this.isPreview();
    s.basis = this._axisBasis(ctx, geo.center);
    if (sel && editable) {
      const gz = this._ensureScreenGizmo(n);
      const cp = this._project(ctx, geo.center);
      if (cp) {
        gz.style.display = '';
        gz.style.left = cp.x + 'px';
        gz.style.top = cp.y + 'px';
        this._updateScreenGizmoGeom(s, s.basis);
      } else gz.style.display = 'none';
      if (!s.dragAttached) { this._attachScreenDrag(a, n); s.dragAttached = true; }
    } else if (s.gizmo) s.gizmo.style.display = 'none';

    /* ---------- 底心旋转锚点 ----------
       挂在屏体「底边中点」（世界坐标 = center - up·h/2）：屏幕立在地上，
       这个点就是它的落脚点 / 转向轴。拖动它只改 style.yaw / pitch，
       points[0]（屏体中心）不动 —— 位置与朝向解耦，撤销也干净。 */
    const halfH = Math.max(0.05, Number(size.h) || 1.35) / 2;
    const footW = [
      geo.center[0] - geo.up[0] * halfH,
      geo.center[1] - geo.up[1] * halfH,
      geo.center[2] - geo.up[2] * halfH
    ];
    const foot = this._project(ctx, footW);
    if (sel && editable && foot) {
      const rot = this._ensureScreenRot(n, a);
      rot.style.display = '';
      rot.style.left = foot.x.toFixed(1) + 'px';
      rot.style.top = (foot.y + 16).toFixed(1) + 'px';
      if (!s.rotAttached) { this._attachScreenRotate(a, n); s.rotAttached = true; }
    } else if (s.rot) s.rot.style.display = 'none';
  }

  /** 底心旋转锚点：一个带环形箭头的圆形手柄（独立 DOM 层，不被 matrix3d 压扁） */
  _ensureScreenRot(n, a) {
    const sc = n.parts.screen;
    if (sc.rot) return sc.rot;
    const g = div('ed-screen-rot');
    g.innerHTML = `
      <svg width="34" height="34" viewBox="0 0 34 34">
        <circle class="ed-screen-rot-ring" cx="17" cy="17" r="11.5"></circle>
        <path class="ed-screen-rot-arc" d="M17 8.2 A8.8 8.8 0 1 1 8.6 21.5"></path>
        <polygon class="ed-screen-rot-head" points="17,5.6 13.6,9.6 17.9,11.4"></polygon>
        <circle class="ed-screen-rot-hit" cx="17" cy="17" r="15"></circle>
      </svg>`;
    g.title = '拖动：绕底心旋转屏体（左右 = 转向 yaw，上下 = 俯仰 pitch）';
    this.doms.appendChild(g);
    sc.rot = g;
    sc.rotHit = g.querySelector('.ed-screen-rot-hit');
    return g;
  }

  /**
   * 底心锚点拖拽 -> yaw / pitch。
   *   · 水平拖动：绕世界 Y 轴转向（向右拖 = 屏面转向屏幕右侧）；
   *   · 垂直拖动：绕屏面右向量俯仰（向下拖 = 屏面仰起）；
   *   · 旋转中心是屏体中心，points[0] 不变，因此「位置」不会被旋转带跑。
   * 每次 move 都从「按下瞬间的基线」重算，不会逐帧累积误差。
   */
  _attachScreenRotate(a, n) {
    const sc = n.parts.screen;
    const hit = sc.rotHit || sc.rot?.querySelector('.ed-screen-rot-hit');
    if (!hit) return;
    hit.addEventListener('pointerdown', (e) => {
      if (e.button === 2) return;
      const a0 = this.store.get(a.id);
      if (!a0 || a0.locked || this.isLocked(a.id)) return;
      if (this.isPreview() || !this.isEditable()) return;
      if (!this.getSelectedSet().includes(a.id)) return;
      e.stopPropagation();
      if (e.preventDefault) e.preventDefault();
      const baseYaw = Number(a0.style.yaw ?? 0);
      const basePitch = Number(a0.style.pitch ?? 0);
      const sx = e.clientX, sy = e.clientY;
      let suppressed = false;
      try { hit.setPointerCapture(e.pointerId); } catch { /* 合成事件无捕获也能拖 */ }
      const move = (ev) => {
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        if (!suppressed) {
          if (Math.hypot(dx, dy) <= DRAG_PX) { ev.stopPropagation(); return; }
          suppressed = true;
          this._suppressClick = true;           // 真拖拽：抑制随后的误触 click
        }
        // 0.4°/px：100px ≈ 40°，手感接近真实转台
        let yaw = baseYaw + dx * 0.4;
        yaw = ((yaw + 180) % 360 + 360) % 360 - 180;
        const pitch = Math.max(-80, Math.min(80, basePitch - dy * 0.25));
        this.onScreenRotate?.(a.id, {
          yaw: Math.round(yaw * 10) / 10,
          pitch: Math.round(pitch * 10) / 10
        });
        ev.stopPropagation();
      };
      this._beginDrag(move, null, e);
    });
  }

  /**
   * 统一的拖拽生命周期（视锥体锚点 / 屏体 gizmo / 展板引线… 全部走这里）。
   *
   * 只监听 pointerup 是不够的：鼠标在 iframe 外松开、系统吞掉事件、窗口失焦、
   * 或者指针被别的文档捕获时，本页根本收不到 pointerup —— 拖拽状态会一直挂着，
   * 之后随便动一下鼠标，视锥体还在继续调整（用户反馈：左键松开后停不下来）。
   * 这里三重收尾：
   *   1) pointerup / pointercancel；
   *   2) window blur（切窗口 / 点任务栏）；
   *   3) pointermove 里检测「左键位已经清零」——松开事件丢了也能在下一次移动时停下。
   * @param {Function} move   pointermove 处理
   * @param {Function} [onEnd] 收尾回调
   * @param {PointerEvent} [downEvent] 触发这次拖拽的 pointerdown（用于判断左键是否真按下）
   * @returns {Function} end 收尾函数（内部也会调用，重复调用安全）
   */
  _beginDrag(move, onEnd, downEvent) {
    const doc = this.host?.ownerDocument || document;
    const win = doc.defaultView || window;
    /* 只有「按下瞬间左键确实是按下态」才启用 buttons 兜底：合成事件
       （测试 / 自动化派发）pointerdown 的 buttons 通常是 0，拿它判断会误终止拖拽。 */
    const armed = !!downEvent && (downEvent.buttons & 1) === 1;
    let done = false;
    const end = (ev) => {
      if (done) return;
      done = true;
      doc.removeEventListener('pointermove', onMove);
      doc.removeEventListener('pointerup', end);
      doc.removeEventListener('pointercancel', end);
      win.removeEventListener('blur', end);
      try { onEnd?.(ev); } catch (_) { /* 收尾回调异常不影响卸载监听 */ }
    };
    const onMove = (ev) => {
      /* 真实鼠标在 iframe 外松手时本页收不到 pointerup，buttons 却会变 0 ——
         每次移动都校验一次，松手事件丢了也能立刻停下。触摸 / 笔无此语义。 */
      if (armed && ev.pointerType !== 'touch' && (ev.buttons & 1) === 0) {
        end(ev);
        return;
      }
      move(ev);
    };
    doc.addEventListener('pointermove', onMove);
    doc.addEventListener('pointerup', end);
    doc.addEventListener('pointercancel', end);
    win.addEventListener('blur', end);
    return end;
  }

  /**
   * 三轴 gizmo 每帧几何：把 X/Y/Z 三根轴柄摆到各世界轴的**投影方向**上
   * （固定屏幕长度，方向来自 _axisBasis，斜视 / 背面时拖动手感不反）。
   */
  _updateScreenGizmoGeom(sc, basis) {
    const parts = sc.gizmoParts;
    if (!parts || !basis) return;
    const C = 130, LEN = 76, HS = 5;               // viewBox 中心 / 轴柄屏幕长度 / 箭头半高
    for (const k of ['x', 'y', 'z']) {
      const dir = basis.screen[k] || [1, 0];
      const tx = C + dir[0] * LEN, ty = C + dir[1] * LEN;
      const a = parts.axes[k];
      a.line.setAttribute('x1', C); a.line.setAttribute('y1', C);
      a.line.setAttribute('x2', tx.toFixed(1)); a.line.setAttribute('y2', ty.toFixed(1));
      // 轴端箭头（垂直于轴的三角），指向 +轴 方向
      const px = -dir[1], py = dir[0];
      a.head.setAttribute('points',
        `${tx.toFixed(1)},${ty.toFixed(1)} ` +
        `${(tx - dir[0] * HS * 2 + px * HS).toFixed(1)},${(ty - dir[1] * HS * 2 + py * HS).toFixed(1)} ` +
        `${(tx - dir[0] * HS * 2 - px * HS).toFixed(1)},${(ty - dir[1] * HS * 2 - py * HS).toFixed(1)}`);
      a.hit.setAttribute('cx', tx.toFixed(1)); a.hit.setAttribute('cy', ty.toFixed(1));
    }
  }

  /** 三轴 gizmo 轴色（编辑软件通用约定：X 红 / Y 绿 / Z 蓝） */
  static get GIZMO_AXES() {
    return [
      { k: 'x', color: '#f87171' },
      { k: 'y', color: '#4ade80' },
      { k: 'z', color: '#60a5fa' },
    ];
  }

  /**
   * 相机基向量 + 各方向在屏幕上的投影方向与「每米多少像素」。
   * 用投影后的真实方向而不是写死 (1,0)/(0,1)，斜视 / 背面时拖动才不会反。
   * 轴向几乎与视线重合、投影长度趋近 0 时，给固定 80 px/m 的兜底方向。
   * world/screen/ppm 同时覆盖：相机平面基（right/up，屏体自由移动用）与
   * 世界三轴 x/y/z（三轴 gizmo 拖动用）。
   */
  _axisBasis(ctx, center) {
    const f = ctx.fwd || { x: 0, y: 0, z: 1 };
    const fl = Math.hypot(f.x, f.y, f.z) || 1;
    const F = [f.x / fl, f.y / fl, f.z / fl];
    let R = [-F[2], 0, F[0]];                       // cross(F, worldUp)
    const rl = Math.hypot(...R);
    R = rl > 1e-4 ? R.map(v => v / rl) : [1, 0, 0];
    let U = [R[1] * F[2] - R[2] * F[1],
             R[2] * F[0] - R[0] * F[2],
             R[0] * F[1] - R[1] * F[0]];           // cross(R, F)
    const ul = Math.hypot(...U) || 1;
    U = U.map(v => v / ul);
    const world = { right: R, up: U };
    const p0 = this._project(ctx, center);
    const ppm = {}, screen = {};
    for (const k of Object.keys(world)) {
      const p1 = this._project(ctx, center.map((v, i) => v + world[k][i]));
      const dx = p0 && p1 ? p1.x - p0.x : 0;
      const dy = p0 && p1 ? p1.y - p0.y : 0;
      const len = Math.hypot(dx, dy);
      if (!Number.isFinite(len) || len < 4) {
        ppm[k] = 80;
        screen[k] = k === 'right' ? [1, 0] : [0, -1];
      } else {
        ppm[k] = Math.max(8, Math.min(600, len));
        screen[k] = [dx / len, dy / len];
      }
    }
    // 世界三轴：三轴 gizmo 的轴柄方向与轴向拖动比例
    const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    for (const k of Object.keys(AXES)) {
      world[k] = AXES[k];
      const p1 = this._project(ctx, center.map((v, i) => v + AXES[k][i]));
      const dx = p0 && p1 ? p1.x - p0.x : 0;
      const dy = p0 && p1 ? p1.y - p0.y : 0;
      const len = Math.hypot(dx, dy);
      if (!Number.isFinite(len) || len < 4) {
        ppm[k] = 80;
        screen[k] = k === 'x' ? [1, 0] : k === 'y' ? [0, -1] : [0.707, -0.707];
      } else {
        ppm[k] = Math.max(8, Math.min(600, len));
        screen[k] = [dx / len, dy / len];
      }
    }
    return { R, U, F, world, ppm, screen };
  }

  /**
   * 三轴 gizmo（编辑软件通用样式）：X/Y/Z 三根彩色轴柄（箭头线 + 命中区）+
   * 中心选择柄（视觉白点；屏体本身即「相机平面自由移动」的拖动面）。
   * 挂在独立 DOM 层：屏体本身带 matrix3d，gizmo 不能被透视变换压扁。
   */
  _ensureScreenGizmo(n) {
    const sc = n.parts.screen;
    if (sc.gizmo) return sc.gizmo;
    const g = div('ed-screen-gizmo');
    const svgEl = svg('svg', {
      class: 'ed-gizmo-svg', width: '260', height: '260', viewBox: '0 0 260 260'
    });
    g.appendChild(svgEl);
    const parts = { svg: svgEl, axes: {} };
    for (const { k } of Overlay.GIZMO_AXES) {
      const line = svg('line', { class: 'ed-gizmo-axis', 'data-axis': k });
      const head = svg('polygon', { class: 'ed-gizmo-head', 'data-axis': k });
      const hit = svg('circle', { class: 'ed-gizmo-hit', r: '10', 'data-axis': k });
      svgEl.append(line, head, hit);
      parts.axes[k] = { line, head, hit };
    }
    const tip = div('ed-gizmo-tip');
    tip.textContent = '三轴拖动 · X / Y / Z 轴柄，屏体 / 中心柄自由移动';
    g.appendChild(tip);
    g.appendChild(div('ed-screen-gizmo-hub'));
    this.doms.appendChild(g);
    sc.gizmo = g;
    sc.gizmoParts = parts;
    return g;
  }

  /**
   * 选中三维屏后的拖动（三轴 gizmo 交互）：
   *   · 屏体 / 中心选择柄 -> 相机平面内自由移动（左右 + 上下）
   *   · X/Y/Z 轴柄        -> 沿对应世界轴平移（与 Unity/Blender 轴向操作一致）
   * 位移统一用「按下瞬间的世界起点 + 累计位移」写回，避免逐帧累加漂移；
   * 小于 DRAG_PX 的一律视为单击，绝不改写位置。
   */
  _attachScreenDrag(a, n) {
    const el = n.el;
    const sc = n.parts.screen;
    const gz = sc.gizmo;
    const axisHits = [...gz.querySelectorAll('.ed-gizmo-hit')];
    const targets = [el, ...axisHits];
    const start = (e, mode, key, target) => {
      const a2 = this.store.get(a.id);
      if (!a2 || a2.locked || this.isLocked(a.id) || this.isPreview() || !this.isEditable()) return;
      if (e.button === 2) return;
      const sel = this.getSelectedSet();
      if (!sel.includes(a.id)) return;
      this._screenDrag = {
        id: a.id, mode, key, target,
        armed: (e.buttons & 1) === 1,               // 左键按下态（合成事件为 0，不启用兜底）
        sx: e.clientX, sy: e.clientY, moved: false,
        start: a2.points[0].slice(0, 3),
        basis: sc.basis,
      };
      // 多选拖动：记录所有选中标注的基线位置，拖动时整体平移其余选中对象
      const selBase = new Map();
      for (const id of this.getSelectedSet()) {
        const aa = this.store.get(id); if (!aa) continue;
        selBase.set(id, { points: aa.points.map(p => p.slice()) });
      }
      this._screenDrag.selBase = selBase;
      try { target.setPointerCapture(e.pointerId); } catch { /* 合成事件无捕获也可拖动 */ }
      e.stopPropagation();
    };
    const move = (e) => {
      const d = this._screenDrag;
      if (!d) return;
      if (d.armed && e.pointerType !== 'touch' && (e.buttons & 1) === 0) {
        end(e);                                      // 左键已松开：停止平移屏体
        return;
      }
      if (!d.moved) {
        if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) <= DRAG_PX) { e.stopPropagation(); return; }
        d.moved = true;
        this._suppressClick = true;
      }
      const b = d.basis;
      if (!b) { e.stopPropagation(); return; }
      const dx0 = e.clientX - d.sx, dy0 = e.clientY - d.sy;
      // 对齐吸附：把移动组屏幕包围盒按光标位移偏移后，与未选中标注的边 / 中线对齐
      const ctx = this._context();
      const sel = this.getSelectedSet();
      let dx = dx0, dy = dy0;
      if (ctx && sel.length) {
        let gx0 = Infinity, gy0 = Infinity, gx1 = -Infinity, gy1 = -Infinity, has = false;
        for (const id of sel) { const bb = this._bbox(ctx, this.store.get(id)); if (!bb) continue; has = true; gx0 = Math.min(gx0, bb.x0); gy0 = Math.min(gy0, bb.y0); gx1 = Math.max(gx1, bb.x1); gy1 = Math.max(gy1, bb.y1); }
        const group = has ? { x0: gx0, y0: gy0, x1: gx1, y1: gy1 } : null;
        const targets = this.store.list(this.getScene()).filter(x => !sel.includes(x.id)).map(x => this._bbox(ctx, x)).filter(Boolean);
        if (group && targets.length) {
          const snap = this._computeAlign(group, targets, dx, dy);
          dx = snap.dx; dy = snap.dy;
          this._drawGuides(snap.guides);
        } else this._clearGuides();
      } else this._clearGuides();
      let delta;
      if (d.mode === 'plane') {
        const tr = (dx * b.screen.right[0] + dy * b.screen.right[1]) / b.ppm.right;
        const tu = (dx * b.screen.up[0] + dy * b.screen.up[1]) / b.ppm.up;
        delta = b.R.map((v, i) => v * tr + b.U[i] * tu);
      } else {
        const w = b.world[d.key] || b.R;
        const sd = b.screen[d.key] || [1, 0];
        const t = (dx * sd[0] + dy * sd[1]) / (b.ppm[d.key] || 80);
        delta = w.map(v => v * t);
      }
      this.onScreenMove?.(d.id, d.start, delta);
      // 多选：其余选中标注整体平移相同世界位移（一次拖动合并成一条撤销链）
      if (d.selBase) {
        for (const [id, base] of d.selBase) {
          if (id === d.id) continue;
          const np = base.points.map(p => [p[0] + delta[0], p[1] + delta[1], p[2] + delta[2]]);
          this.store.update(id, { points: np }, { coalesceKey: 'move-sel:' + id });
        }
      }
      e.stopPropagation();
    };
    const end = (e) => {
      if (!this._screenDrag) return;
      const moved = this._screenDrag.moved;
      const target = this._screenDrag.target;
      this._screenDrag = null;
      this._clearGuides();
      try { target.releasePointerCapture(e.pointerId); } catch { /* noop */ }
      e.stopPropagation();
      if (moved) setTimeout(() => { this._suppressClick = false; }, 0);
    };
    el.addEventListener('pointerdown', e => start(e, 'plane', null, el));
    axisHits.forEach(btn =>
      btn.addEventListener('pointerdown', e => start(e, 'axis', btn.dataset.axis, btn)));
    targets.forEach(t => {
      t.addEventListener('pointermove', move);
      t.addEventListener('pointerup', end);
      t.addEventListener('pointercancel', end);
    });
  }

  // ------------------------------------------------------------- 贴面矩形（深度反算纹理面 / 视频投射面）
  /**
   * 【新实现：深度反算】用户在屏幕上框出的矩形 + 每个采样像素的深度，
   * 由 picker.unprojectRect() 反投影成一组**世界表面点**，存在 a.surface 里。
   * 每帧只把这些世界点重新投影到当前相机：换机位会自然产生透视变形，
   * 墙面凹凸 / 台阶 / 斜顶都会真实弯折，像贴在模型上的纹理。
   *
   * 旧实现（两个世界点 + 法向切平面 + 向下射线吸附）已废弃：向下射线会先
   * 命中天花板，且切平面与鼠标框的位置毫无关系，实际完全不可用。
   * 只有导入的旧文档没有 surface 时才走 drapeQuad 兜底。
   *
   * 渲染分两层：SVG 网格四边形（几何事实 + 拾取命中）+ DOM 四点单应视频面。
   */
  _drawDecal(a, pts, selected, ctx, locked = false) {
    const n = this._node(a, 'g');
    const el = this._node(a, 'el').el;
    const c = c_of(a);

    if (!n.parts.decal) n.parts.decal = { sig: null, grid: null, cellG: null, cells: [], outline: null, label: null, dom: null, pending: null };
    const dc = n.parts.decal;

    /* 浏览态（showDecalGuides=false）：贴花的画面完全由 GPU 投射的视频负责，
       这里把所有编辑辅助图形收起来，只留一个空 <g>（保留 data-id 供诊断 /
       图层树计数），不产生任何线框 / 手柄 / 占位框。 */
    if (!this.showDecalGuides()) return this._hideDecalGuides(n, el, dc);
    n.g.style.display = '';

    // 新实现：投影式延迟贴花（projector OBB）——画 OBB 线框 + 手柄，不再画 81 网格 / 单应视频 DOM
    if (a.projector) return this._drawDecalProjector(a, selected, ctx, locked, n, el, c, dc);
    // 旧 surface 路径：隐藏可能残留的 OBB 元素
    this._hideDecalOBB(n);

    /* 【旧 surface 网格多边形路径已彻底移除】
       历史实现把 49 个深度反算世界点铺成 8×8 网格，构建 64 个填充多边形
       (.ed-decal-cell) + 外轮廓 + 四点单应视频 DOM。这条路径在掠射角 / 近裁剪面
       下个别世界点的投影坐标会爆炸，四边形被拉成细长尖刺 —— 正是曾出现的
       「奇异多边形」根因。现行技术路线是 projector OBB + GPU 逐像素投射，
       编辑器只需画 OBB 线框，不再构建任何世界空间网格多边形。
       没有 projector 时（投影机异步生成失败 / 旧文档）只画屏幕空间占位框：
       坐标直接取自 a.rect（归一化屏幕矩形），完全不经过世界点投影，从根上
       杜绝尖刺；surface 世界点数据仍保留（深度反算链路依赖它），只是不再画网格。 */
    this._hideDecalOBB(n);
    return this._drawDecalPending(a, selected, ctx, locked, n, el, c, dc);
  }

  /** 无 projector 的贴面矩形：只画基于 a.rect 的屏幕空间虚线占位框 + 提示标签。
   *  四个角点直接由归一化屏幕矩形换算，不做任何世界点投影，永不产生退化多边形。 */
  _drawDecalPending(a, selected, ctx, locked, n, el, c, dc) {
    if (dc.cellG) dc.cellG.style.display = 'none';
    if (dc.outline) dc.outline.style.display = 'none';
    if (dc.dom && dc.dom.video) { const p = dc.dom.video.parentElement; if (p) p.style.display = 'none'; }
    el.style.display = 'none';

    if (!dc.pending) {
      dc.pending = svg('rect', { class: 'ed-decal-pending', rx: 2 });
      n.g.appendChild(dc.pending);
      if (!dc.label) { dc.label = svg('text', { class: 'ed-decal-label' }); n.g.appendChild(dc.label); }
    }
    n.g.style.color = c;
    n.g.setAttribute('class', 'ed-g ed-decal-g ed-decal-pending-g' +
      (selected ? ' ed-sel' : '') + (locked ? ' ed-locked' : ''));
    n.g.style.pointerEvents = 'none';

    const r = Array.isArray(a.rect) && a.rect.length === 4 &&
      a.rect.every(Number.isFinite) ? a.rect : null;
    if (!r) {
      dc.pending.style.display = 'none';
      const p = this._project(ctx, a.points?.[0] || [0, 0, 0]);
      dc.label.style.display = p ? '' : 'none';
      if (p) {
        setText(dc.label, (a.title || '贴面矩形') + ' · 等待重新投射');
        dc.label.setAttribute('x', (p.x + 8).toFixed(1));
        dc.label.setAttribute('y', (p.y - 8).toFixed(1));
      }
      return 0;
    }
    const v = this.getViewer();
    const canvas = v?.app?.graphicsDevice?.canvas;
    const cr = canvas?.getBoundingClientRect();
    if (!cr || !(cr.width > 0) || !(cr.height > 0)) {
      dc.pending.style.display = 'none'; dc.label.style.display = 'none'; return 0;
    }
    const hr = this.host.getBoundingClientRect();
    const x0 = cr.left - hr.left + r[0] * cr.width;
    const y0 = cr.top - hr.top + r[1] * cr.height;
    const x1 = cr.left - hr.left + r[2] * cr.width;
    const y1 = cr.top - hr.top + r[3] * cr.height;
    dc.pending.style.display = '';
    dc.pending.setAttribute('x', Math.min(x0, x1).toFixed(1));
    dc.pending.setAttribute('y', Math.min(y0, y1).toFixed(1));
    dc.pending.setAttribute('width', Math.abs(x1 - x0).toFixed(1));
    dc.pending.setAttribute('height', Math.abs(y1 - y0).toFixed(1));
    dc.label.style.display = '';
    setText(dc.label, (a.title || '贴面矩形') + ' · 等待重新投射');
    dc.label.setAttribute('x', (Math.min(x0, x1) + 6).toFixed(1));
    dc.label.setAttribute('y', (Math.min(y0, y1) - 6).toFixed(1));
    return 0;
  }

  // ------------------------------------------------------------- 贴面矩形（投影式延迟贴花 OBB）
  /**
   * 新实现：贴花由 GPU 按实时表面深度投射，编辑器里只画投影机 OBB 线框 + 手柄，
   * 不再重建网格、也不再放单应视频 DOM（视频由 GPU 投射到真实表面）。
   * 选中的贴面额外显示 6 个轴向缩放手柄（±X/±Y/±Z 面心）与中心移动手柄。
   */
  _hideDecalOBB(n) {
    const o = n.parts.decalOBB;
    if (!o) return;
    if (o.g) o.g.style.display = 'none';
    if (o.rings) o.rings.style.display = 'none';
    if (o.handles) o.handles.style.display = 'none';
  }

  /** 浏览态：贴花不再画任何辅助图形（线框 / 手柄 / 占位框 / 标签 / 单应视频面），
   *  只保留一个空的 <g> 节点（data-id 仍可被图层树 / 诊断读到）。
   *  视频由 GPU 投射层绘制（见 decal-runtime.js），DOM 侧不能有任何可见痕迹。 */
  _hideDecalGuides(n, el, dc) {
    if (dc) {
      if (dc.cellG) dc.cellG.style.display = 'none';
      if (dc.outline) dc.outline.style.display = 'none';
      if (dc.pending) dc.pending.style.display = 'none';
      if (dc.label) dc.label.style.display = 'none';
      if (dc.dom && dc.dom.video) {
        const p = dc.dom.video.parentElement;
        if (p) p.style.display = 'none';
      }
    }
    this._hideDecalOBB(n);
    if (n.g) {
      n.g.style.display = 'none';
      n.g.style.pointerEvents = 'none';
    }
    if (el && el.style.display !== 'none') el.style.display = 'none';
    return 0;
  }

  _drawDecalProjector(a, selected, ctx, locked, n, el, c, dc) {
    // 隐藏旧网格 / 占位框 / 单应视频 DOM（projector 模式不需要）
    if (dc.cellG) dc.cellG.style.display = 'none';
    if (dc.outline) dc.outline.style.display = 'none';
    if (dc.pending) dc.pending.style.display = 'none';
    if (dc.label) dc.label.style.display = 'none';
    if (dc.dom && dc.dom.video) { const p = dc.dom.video.parentElement; if (p) p.style.display = 'none'; }

    if (!n.parts.decalOBB) {
      n.parts.decalOBB = { g: null, rings: null, handles: null, segs: [], ringSegs: [], ringHits: [], hcircles: [], occ: null };
    }
    const o = n.parts.decalOBB;
    if (!o.g || !o.rings) {
      if (!o.g) {
        o.g = svg('g', { class: 'ed-decal-obb' });
        n.g.appendChild(o.g);
      }
      /* 旋转环单独一层，压在棱线之上、手柄之下：环是「转向」入口，
         必须盖住棱线才能点得中（棱只画不接事件）。 */
      if (!o.rings) {
        o.rings = svg('g', { class: 'ed-decal-obb-rings' });
        n.g.appendChild(o.rings);
      }
      if (!o.handles) {
        o.handles = svg('g', { class: 'ed-decal-obb-handles' });
        n.g.appendChild(o.handles);
      }
      this._attachDecalDrag(a, o);
    }
    o.g.style.display = '';
    o.rings.style.display = '';
    o.handles.style.display = selected ? '' : 'none';

    /* 8 个体角点（世界）-> 投影。
       ortho = OBB；persp = 视锥台（近平面 4 点 / 远平面 4 点，同一索引顺序），
       所以下面 12 条边的连线表在两种模式下都成立。 */
    const isPersp = a.projector.mode === 'persp';
    const corners = projectorVolumeCorners(a.projector);
    const proj = corners.map(p => this._project(ctx, p));
    /* 正交 OBB 在盒心不重叠镜头时 8 个角点必定都在视锥内；
       透视视锥体的光心常常就在相机旁边，远平面角点也可能出画。
       只要还有两条可连的棱就照样画（逐边判定见下），不要整块隐藏。 */
    const visible = isPersp
      ? proj.filter(p => p && p.d > 0.05).length >= 2
      : proj.every(p => p && p.d > 0.05);
    if (!visible) {
      o.g.style.display = 'none'; o.rings.style.display = 'none'; o.handles.style.display = 'none';
      return 0;
    }

    // 12 条边（索引对）
    const edges = [
      [0, 1], [1, 3], [3, 2], [2, 0],   // z=-
      [4, 5], [5, 7], [7, 6], [6, 4],   // z=+
      [0, 4], [1, 5], [2, 6], [3, 7]    // 连接
    ];
    /* 【辅助线深度判断】每条棱按 SEG 段细分：段中点既做深度采样点，也做绘制的插值参数。
       选中时 6 段（能看出「哪一截被墙挡住」），未选中时整条 1 段（省 DOM）。
       屏幕空间线性插值是正确的：世界直线投影后仍是直线（透视也成立）。 */
    const SEG = selected ? 6 : 1;
    const nSeg = edges.length * SEG;
    while (o.segs.length < edges.length * 6) {
      const ln = svg('line', { class: 'ed-decal-obb-edge ed-decal-obb-seg' });
      o.g.appendChild(ln); o.segs.push(ln);
    }
    for (let i = nSeg; i < o.segs.length; i++) o.segs[i].style.display = 'none';

    const segPts = [];          // 段中点世界坐标（探测点，顺序与 segs 前 nSeg 项一致）
    edges.forEach((e) => {
      const A = corners[e[0]], B = corners[e[1]];
      for (let s = 0; s < SEG; s++) {
        const t = (s + 0.5) / SEG;
        segPts.push([
          A[0] + (B[0] - A[0]) * t,
          A[1] + (B[1] - A[1]) * t,
          A[2] + (B[2] - A[2]) * t
        ]);
      }
    });

    /* ---- 旋转环几何（仅正交 OBB，且选中）：绕本地 X/Y/Z 轴转 ----
       半径取「该环平面内最大半长 × 1.18」，三个环半径不同 → 屏幕上不重叠、不抢鼠标。
       环同样逐段做深度判断，被墙挡住的一段走虚线暗色。 */
    const RING_SEG = 16;
    const ppos = a.projector.position;
    const ringRuns = [];
    if (selected && !isPersp) {
      const q = a.projector.quaternion;
      const half = a.projector.half;
      const defs = [
        { k: 'rx', n: [1, 0, 0], R: Math.max(half[1], half[2]) * 1.18 },
        { k: 'ry', n: [0, 1, 0], R: Math.max(half[0], half[2]) * 1.18 },
        { k: 'rz', n: [0, 0, 1], R: Math.max(half[0], half[1]) * 1.18 }
      ];
      for (const def of defs) {
        const N = rotateByQuat(def.n, q);
        // 环平面内的正交基：挑与法向最不平行的世界轴做参考，避免退化
        const ref = Math.abs(N[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
        let U = [
          ref[1] * N[2] - ref[2] * N[1],
          ref[2] * N[0] - ref[0] * N[2],
          ref[0] * N[1] - ref[1] * N[0]
        ];
        const ul = Math.hypot(U[0], U[1], U[2]) || 1;
        U = [U[0] / ul, U[1] / ul, U[2] / ul];
        const V = [
          N[1] * U[2] - N[2] * U[1],
          N[2] * U[0] - N[0] * U[2],
          N[0] * U[1] - N[1] * U[0]
        ];
        const at = (t) => {
          const c = Math.cos(t) * def.R, si = Math.sin(t) * def.R;
          return [
            ppos[0] + U[0] * c + V[0] * si,
            ppos[1] + U[1] * c + V[1] * si,
            ppos[2] + U[2] * c + V[2] * si
          ];
        };
        const segs = [], mids = [], poly = [];
        for (let s = 0; s < RING_SEG; s++) {
          const t0 = (s / RING_SEG) * Math.PI * 2;
          const t1 = ((s + 1) / RING_SEG) * Math.PI * 2;
          const A = this._project(ctx, at(t0));
          const B = this._project(ctx, at(t1));
          segs.push(A && B && A.d > 0.05 && B.d > 0.05
            ? { x1: A.x, y1: A.y, x2: B.x, y2: B.y } : null);
          mids.push(at((t0 + t1) / 2));
          poly.push(at(t0));
        }
        ringRuns.push({ k: def.k, segs, mids, poly });
      }
    }

    // 一次深度探测同时覆盖「棱段中点 + 环段中点」，结果下一帧生效（异步 + 节流）
    const probePts = segPts.concat(...ringRuns.map(r => r.mids));
    const blocked = this._decalOcclusion(a, o, probePts);

    edges.forEach((e, ei) => {
      const A = proj[e[0]], B = proj[e[1]];
      for (let s = 0; s < SEG; s++) {
        const ln = o.segs[ei * SEG + s];
        if (!A || !B) { ln.style.display = 'none'; continue; }
        const t0 = s / SEG, t1 = (s + 1) / SEG;
        ln.style.display = '';
        ln.setAttribute('x1', (A.x + (B.x - A.x) * t0).toFixed(1));
        ln.setAttribute('y1', (A.y + (B.y - A.y) * t0).toFixed(1));
        ln.setAttribute('x2', (A.x + (B.x - A.x) * t1).toFixed(1));
        ln.setAttribute('y2', (A.y + (B.y - A.y) * t1).toFixed(1));
        const gi = ei * SEG + s;
        if (blocked && blocked[gi]) ln.setAttribute('class', 'ed-decal-obb-edge ed-decal-obb-seg is-blocked');
        else ln.setAttribute('class', 'ed-decal-obb-edge ed-decal-obb-seg');
      }
    });

    /* 旋转环 DOM：每个轴 RING_SEG 条可见线段（逐段遮挡）+ 1 条粗透明 polyline 做命中区 */
    while (o.ringSegs.length < 3 * RING_SEG) {
      const ln = svg('line', { class: 'ed-decal-ring' });
      o.rings.appendChild(ln); o.ringSegs.push(ln);
    }
    while (o.ringHits.length < 3) {
      const pl = svg('polyline', { class: 'ed-decal-ring-hit' });
      o.rings.appendChild(pl); o.ringHits.push(pl);
    }
    let ringIdx = 0;
    for (let a3 = 0; a3 < 3; a3++) {
      const run = ringRuns[a3];
      const hit = o.ringHits[a3];
      if (!run) {
        hit.style.display = 'none';
        for (let s = 0; s < RING_SEG; s++) o.ringSegs[a3 * RING_SEG + s].style.display = 'none';
        continue;
      }
      hit.style.display = '';
      hit.setAttribute('points', run.poly.map(p => {
        const pp = this._project(ctx, p);
        return pp ? `${pp.x.toFixed(1)},${pp.y.toFixed(1)}` : '0,0';
      }).join(' '));
      hit.dataset.id = a.id; hit.dataset.role = 'decal-handle'; hit.dataset.axis = run.k;
      for (let s = 0; s < RING_SEG; s++, ringIdx++) {
        const ln = o.ringSegs[a3 * RING_SEG + s];
        const g2 = run.segs[s];
        if (!g2) { ln.style.display = 'none'; continue; }
        ln.style.display = '';
        ln.setAttribute('x1', g2.x1.toFixed(1)); ln.setAttribute('y1', g2.y1.toFixed(1));
        ln.setAttribute('x2', g2.x2.toFixed(1)); ln.setAttribute('y2', g2.y2.toFixed(1));
        ln.setAttribute('data-axis', run.k);
        // 环段遮挡索引 = 棱段总数 + 本环之前的环段数 + s
        const gi = nSeg + (a3 * RING_SEG) + s;
        ln.setAttribute('class', blocked && blocked[gi] ? 'ed-decal-ring is-blocked' : 'ed-decal-ring');
      }
    }
    /* 环按 X/Y/Z 上色（与轴线手柄一致），棱线仍跟随选中色 currentColor */
    o.rings.setAttribute('data-mode', isPersp ? 'persp' : 'ortho');

    // 中心 + 3 个轴向缩放手柄（±X/±Y/±Z 面心）
    const pos = a.projector.position;
    const center = this._project(ctx, pos);
    const axisDir = {
      x: rotateByQuat([a.projector.half[0], 0, 0], a.projector.quaternion),
      y: rotateByQuat([0, a.projector.half[1], 0], a.projector.quaternion),
      z: rotateByQuat([0, 0, a.projector.half[2]], a.projector.quaternion)
    };
    /* 手柄语义：
       · ortho：中心 = 盒心平移；±X / ±Y / ±Z = 三个半尺寸。
       · persp：见下（aim / move 两个独立手柄）。
         透视模式下 -Z 手柄在光心背后没有意义，直接不给。 */
    const handles = isPersp
      ? [
        { k: 'px', w: [pos[0] + axisDir.x[0], pos[1] + axisDir.x[1], pos[2] + axisDir.x[2]] },
        { k: 'mx', w: [pos[0] - axisDir.x[0], pos[1] - axisDir.x[1], pos[2] - axisDir.x[2]] },
        { k: 'py', w: [pos[0] + axisDir.y[0], pos[1] + axisDir.y[1], pos[2] + axisDir.y[2]] },
        { k: 'my', w: [pos[0] - axisDir.y[0], pos[1] - axisDir.y[1], pos[2] - axisDir.y[2]] },
        { k: 'pz', w: [pos[0] + axisDir.z[0], pos[1] + axisDir.z[1], pos[2] + axisDir.z[2]] }
      ]
      : [
        { k: 'mx', w: [pos[0] - axisDir.x[0], pos[1] - axisDir.x[1], pos[2] - axisDir.x[2]] },
        { k: 'px', w: [pos[0] + axisDir.x[0], pos[1] + axisDir.x[1], pos[2] + axisDir.x[2]] },
        { k: 'my', w: [pos[0] - axisDir.y[0], pos[1] - axisDir.y[1], pos[2] - axisDir.y[2]] },
        { k: 'py', w: [pos[0] + axisDir.y[0], pos[1] + axisDir.y[1], pos[2] + axisDir.y[2]] },
        { k: 'mz', w: [pos[0] - axisDir.z[0], pos[1] - axisDir.z[1], pos[2] - axisDir.z[2]] },
        { k: 'pz', w: [pos[0] + axisDir.z[0], pos[1] + axisDir.z[1], pos[2] + axisDir.z[2]] }
      ];
    while (o.hcircles.length < handles.length + 2) {
      const c2 = svg('circle', { class: 'ed-decal-obb-handle', r: 5 });
      o.handles.appendChild(c2); o.hcircles.push(c2);
    }
    /* 「模拟相机」手柄（仅透视）：
       · aim  —— 画在**光心**上：拖动 = 搬动模拟相机，远平面中心（目标）保持不动，
                 于是投射方向随之改变。这就是「生成视锥体后还能调投射方向」。
                 光心常常就贴在观察者相机上，用光心自己做拖拽基准面会退化成
                 「屏幕怎么拖都不动」，所以基准面取远平面中心（远、稳、增益正常）。
       · move —— 画在视锥体中段（光心 + 0.5×远距）：整块平移视锥体，用于摆位。
       两者位置不重叠，不会互相抢鼠标。 */
    let allHandles;
    if (isPersp) {
      const far = Math.max(0.3, Number(a.projector.half[2]) || 1);
      const fwdW = rotateByQuat([0, 0, 1], a.projector.quaternion);
      const midW = [
        pos[0] + fwdW[0] * far * 0.5,
        pos[1] + fwdW[1] * far * 0.5,
        pos[2] + fwdW[2] * far * 0.5
      ];
      allHandles = [{ k: 'aim', w: pos }, { k: 'move', w: midW }].concat(handles);
    } else {
      allHandles = [{ k: 'move', w: pos }].concat(handles);
    }
    allHandles.forEach((h, i) => {
      const ci = o.hcircles[i];
      const pp = this._project(ctx, h.w);
      if (!pp || pp.d <= 0.05) { ci.style.display = 'none'; return; }
      ci.style.display = '';
      ci.setAttribute('cx', pp.x.toFixed(1)); ci.setAttribute('cy', pp.y.toFixed(1));
      ci.dataset.id = a.id; ci.dataset.role = 'decal-handle';
      ci.dataset.axis = h.k;
      ci.dataset.kind = 'decal';
    });
    for (let i = allHandles.length; i < o.hcircles.length; i++) o.hcircles[i].style.display = 'none';

    n.g.style.color = c;
    n.g.setAttribute('class', 'ed-g ed-decal-g' + (selected ? ' ed-sel' : '') + (locked ? ' ed-locked' : ''));
    n.g.style.pointerEvents = locked ? 'none' : '';
    this._syncClass(el, 'ed-decal', false, false, locked);
    return 0;
  }

  /** 辅助线「场景深度判断」的调度器：异步 + 静止去抖，绘制永远用上一轮结果。
   *
   *  为什么必须去抖：探测要走 `ph.prepare()`（引擎的 pick pass，会把 3DGS 场景
   *  再渲一遍到深度快照里），7.4M 高斯下单次是几十毫秒级。如果每帧/每 160ms
   *  触发一次，编辑器会直接卡死。所以策略是：相机或投影机一变就重置计时器，
   *  **稳定 300 ms 后才探一次**，探完记录 key 不重复探。
   *  拖动过程中保留上一次结果，视觉上只是遮挡提示略滞后，交互不掉帧。 */
  _decalOcclusion(a, o, points) {
    const probe = this.probeOcclusion;
    if (!probe || !Array.isArray(points) || !points.length) { o.occ = null; return null; }
    const ctx = this._context();
    if (!ctx) return o.occ?.blocked || null;
    const cp = ctx.cam.entity.getPosition();
    const fwd = ctx.cam.entity.forward;
    const pj = a.projector || {};
    const num = (v) => (Number.isFinite(v) ? v.toFixed(3) : 'x');
    const key = [
      num(cp.x), num(cp.y), num(cp.z), num(fwd.x), num(fwd.y), num(fwd.z),
      num(pj.position?.[0]), num(pj.position?.[1]), num(pj.position?.[2]),
      num(pj.quaternion?.[0]), num(pj.quaternion?.[1]), num(pj.quaternion?.[2]), num(pj.quaternion?.[3]),
      num(pj.half?.[0]), num(pj.half?.[1]), num(pj.half?.[2]),
      points.length
    ].join('|');
    const occ = o.occ || (o.occ = { key: '', done: '', at: 0, pending: false, blocked: null });
    const t = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (occ.key !== key) {                       // 场景/投影机还在变：重置去抖计时
      occ.key = key; occ.at = t;
    } else if (!occ.pending && occ.done !== key && t - occ.at >= 300) {
      occ.pending = true;
      Promise.resolve()
        .then(() => probe(points, { bias: 0.2 }))
        .then(res => {
          occ.pending = false;
          occ.done = key;
          occ.blocked = res && res.ready && Array.isArray(res.blocked) ? res.blocked : null;
        })
        .catch(() => { occ.pending = false; occ.done = key; });
    }
    return occ.blocked && occ.blocked.length === points.length ? occ.blocked : null;
  }

  // 贴面矩形 OBB 手柄拖拽：中心手柄移动投影机，±X/±Y/±Z 手柄沿该轴缩放盒厚/尺寸
  _attachDecalDrag(a, o) {
    if (o._dragAttached) return;
    o._dragAttached = true;
    const onDown = (e) => {
      const axis = e.target.dataset?.axis;
      const id = e.target.dataset?.id;
      if (!axis || !id) return;
      const cam = this._context()?.cam;
      if (!cam) return;
      if (this.isPreview()) return;
      e.stopPropagation();
      if (e.preventDefault) e.preventDefault();
      const a0 = this.store.get(id);
      if (!a0 || !a0.projector) return;
      const pr0 = a0.projector;
      const persp = pr0.mode === 'persp';
      const fwd0 = rotateByQuat([0, 0, 1], pr0.quaternion);
      const far0 = Math.max(0.3, Number(pr0.half[2]) || 1);
      const farCenter = [
        pr0.position[0] + fwd0[0] * far0,
        pr0.position[1] + fwd0[1] * far0,
        pr0.position[2] + fwd0[2] * far0
      ];
      /* 按下瞬间的投影机快照：位移式 / 旋转式手柄每一帧都从这份基准重算，
         避免逐帧累积导致的漂移与抖动。 */
      const base0 = {
        mode: pr0.mode,
        position: pr0.position.slice(),
        quaternion: pr0.quaternion.slice(),
        half: pr0.half.slice(),
        depth: pr0.depth,
        fov: pr0.fov, aspect: pr0.aspect, far: pr0.far, near: pr0.near
      };

      /* ---------- 旋转环（rx / ry / rz）：绕本地轴转 ----------
         角度不用屏幕位移硬乘系数，而是把鼠标射线与**环所在平面**求交，
         取交点相对盒心的方位角差 —— 这样「环在屏幕上被压成椭圆」时也跟手，
         不会出现「斜着看时转得飞快 / 转不动」的问题。
         旋转轴取按下瞬间的世界轴，增量每次都乘到同一份 base0 上，不累积误差。 */
      if (axis[0] === 'r') {
        const idx = axis[1] === 'x' ? 0 : axis[1] === 'y' ? 1 : 2;
        const localAxis = idx === 0 ? [1, 0, 0] : idx === 1 ? [0, 1, 0] : [0, 0, 1];
        const N = rotateByQuat(localAxis, pr0.quaternion);
        const c0 = pr0.position;
        const ref = Math.abs(N[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
        const U = unit3(cross3(ref, N));
        const V = cross3(N, U);
        const hit0 = this._decalDragWorld(e.clientX, e.clientY, cam, c0, N);
        if (!hit0) return;
        const rel0 = [hit0.x - c0[0], hit0.y - c0[1], hit0.z - c0[2]];
        if (Math.hypot(rel0[0], rel0[1], rel0[2]) < 1e-3) return;   // 正好点在轴心：方向无定义
        const ang0 = Math.atan2(dot3(rel0, V), dot3(rel0, U));
        let suppressedR = false;
        const moveR = (ev) => {
          const hit = this._decalDragWorld(ev.clientX, ev.clientY, cam, c0, N);
          if (!hit) return;
          suppressedR = true;
          const rel = [hit.x - c0[0], hit.y - c0[1], hit.z - c0[2]];
          let d = Math.atan2(dot3(rel, V), dot3(rel, U)) - ang0;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          this._applyDecalRotate(id, N, d, base0);
        };
        this._beginDrag(moveR, () => { if (suppressedR) this._suppressClick = true; });
        return;
      }

      /* 拖拽基准面 —— 决定「拖动的增益」，必须离相机足够远：
         · aim  ：远平面中心（光心贴着观察者相机时，用光心做基准面会退化成
                  「屏幕怎么拖都不动」，这是「模拟相机位置拖不动」的真正原因）；
         · move ：视锥体中段 / OBB 盒心；
         · 轴向 ：手柄自己所在的面（远平面边缘 / 半尺寸处）。 */
      const sgn = axis[0] === 'p' ? 1 : -1;
      let p0;
      if (persp && axis === 'aim') {
        p0 = farCenter;
      } else if (persp) {
        const local = axis === 'move' ? [0, 0, far0 * 0.5]
          : axis[1] === 'x' ? [sgn * pr0.half[0], 0, 0]
            : axis[1] === 'y' ? [0, sgn * pr0.half[1], 0]
              : [0, 0, sgn * pr0.half[2]];
        const r = rotateByQuat(local, pr0.quaternion);
        p0 = [pr0.position[0] + r[0], pr0.position[1] + r[1], pr0.position[2] + r[2]];
      } else {
        p0 = pr0.position;
      }
      const w0 = this._decalDragWorld(e.clientX, e.clientY, cam, p0);
      if (!w0) return;
      let suppressed = false;
      const move = (ev) => {
        const w = this._decalDragWorld(ev.clientX, ev.clientY, cam, p0);
        if (!w) return;
        suppressed = true;
        const d = [w.x - w0.x, w.y - w0.y, w.z - w0.z];
        // 位移式手柄（aim / move）：每帧都从「按下时」的基准算，不累积误差
        if (axis === 'aim') this._applyDecalAim(id, base0, d, farCenter);
        else if (axis === 'move') this._applyDecalMove(id, base0, d);
        else this._applyDecalDrag(id, axis, w);
      };
      // 统一拖拽生命周期：左键一松开就立刻停止调整（含在 iframe 外松开）
      this._beginDrag(move, () => { if (suppressed) this._suppressClick = true; });
    };
    /* 手柄层（圆点）与旋转环层都要接收按下：两者位置不重叠，
       但环是「转向」入口，必须能盖住棱线被点中。 */
    o.handles.addEventListener('pointerdown', onDown);
    o.rings.addEventListener('pointerdown', onDown);
  }

  // 屏幕光标 -> 过 P0、法向为 N0（缺省 = 相机朝向）的平面上的世界点（投影机拖拽 / 旋转环共用）
  _decalDragWorld(clientX, clientY, cam, P0, N0) {
    const v = this.getViewer();
    const canvas = v?.app?.graphicsDevice?.canvas;
    if (!canvas) return null;
    const cr = canvas.getBoundingClientRect();
    const rx = clientX - cr.left, ry = clientY - cr.top;
    const camPos = cam.entity.getPosition();
    const p1 = camPos.clone();
    cam.screenToWorld(rx, ry, 1, p1);                 // 光线上距相机 1m 的点
    const dir = { x: p1.x - camPos.x, y: p1.y - camPos.y, z: p1.z - camPos.z };
    const fwd = cam.entity.forward;
    /* 默认法向取相机朝向（屏幕平行面，增益稳定）；旋转环传自己的环平面法向，
       否则「射线 ∩ 屏幕平行面」与环平面不一致，方位角就会算错。 */
    const N = Array.isArray(N0)
      ? { x: N0[0], y: N0[1], z: N0[2] }
      : { x: fwd.x, y: fwd.y, z: fwd.z };
    const denom = dir.x * N.x + dir.y * N.y + dir.z * N.z;
    if (Math.abs(denom) < 1e-6) return null;
    const t = ((P0[0] - camPos.x) * N.x + (P0[1] - camPos.y) * N.y + (P0[2] - camPos.z) * N.z) / denom;
    return { x: camPos.x + dir.x * t, y: camPos.y + dir.y * t, z: camPos.z + dir.z * t };
  }

  /** 整块平移投影机（OBB 盒心 / 视锥体中段手柄）：位移直接叠加到基准位置。
   *  透视模式的位姿（quaternion / fov / far）完全不变，投射方向也不变。 */
  _applyDecalMove(id, base, d) {
    if (!base) return;
    const pos = [base.position[0] + d[0], base.position[1] + d[1], base.position[2] + d[2]]
      .map(v => Math.round(v * 1000) / 1000);
    this.store.update(id, { projector: { ...base, position: pos, mode: base.mode || 'ortho' } },
      { coalesceKey: 'decal-move:' + id });
  }

  /** 旋转环拖拽：绕**世界轴** worldAxis 转 angle（弧度），位置与尺寸都不变。
   *  这是正交 OBB「改朝向」的唯一入口 —— 以前 ortho 模式的朝向锁死在生成时，
   *  用户只能删了重建。增量每次乘到按下瞬间的 base0 上，所以来回拖不会累积漂移。 */
  _applyDecalRotate(id, worldAxis, angle, base) {
    if (!base || !Number.isFinite(angle)) return;
    const q = quatNormalize(quatMul(quatFromAxis(worldAxis, angle), base.quaternion));
    this.store.update(id, { projector: { ...base, quaternion: q, mode: base.mode || 'ortho' } },
      { coalesceKey: 'decal-rot:' + id });
  }

  /**
   * 拖动「模拟相机」（光心）→ 目标点（远平面中心）保持不动，投射方向随之改变。
   *
   * 这正是需求「视锥体生成后可以拖动模拟相机位置来调整投射方向」的实现：
   *   · 目标固定 → 拖动光心等价于绕目标旋转/偏移投射方向，画面仍然投在同一块墙上；
   *   · fov / aspect / far 全部沿用，只有 position + quaternion（朝向）变化；
   *   · points[0] 就是光心锚点，同步写回，保证「双击飞入 / 列表定位」仍然一致。
   */
  _applyDecalAim(id, base, d, farCenter) {
    if (!base) return;
    const eye = [
      base.position[0] + d[0],
      base.position[1] + d[1],
      base.position[2] + d[2]
    ];
    const next = makeFrustumProjector(eye, farCenter, {
      fov: base.fov, aspect: base.aspect, far: base.far, near: base.near
    });
    if (!next) return;
    const a = this.store.get(id);
    if (!a) return;
    const pts = a.points.map(p => p.slice());
    if (pts[0]) {
      pts[0] = eye.map(v => Math.round(v * 1000) / 1000);
    }
    this.store.update(id, { projector: next, points: pts }, { coalesceKey: 'decal-aim:' + id });
  }

  _applyDecalDrag(id, axis, world) {
    const a = this.store.get(id);
    if (!a || !a.projector) return;
    const p = a.projector;
    const c = p.position;
    if (axis === 'move') {
      this.store.update(id, { projector: { ...p, position: [world.x, world.y, world.z] } });
      return;
    }
    const localAxis = axis[1] === 'x' ? [1, 0, 0] : axis[1] === 'y' ? [0, 1, 0] : [0, 0, 1];
    const worldAxis = rotateByQuat(localAxis, p.quaternion);
    const rel = { x: world.x - c[0], y: world.y - c[1], z: world.z - c[2] };
    const dist = Math.abs(rel.x * worldAxis[0] + rel.y * worldAxis[1] + rel.z * worldAxis[2]);
    const idx = axis[1] === 'x' ? 0 : axis[1] === 'y' ? 1 : 2;
    if (p.mode === 'persp') {
      /* 透视视锥：手柄分别位于远平面半宽 / 半高 / 远距处，
         所以拖动距离就是要写的新值。写回前把 half 与 fov/aspect 重新对齐：
         · ±X → 改远平面半宽（宽高比变）
         · ±Y → 改远平面半高（竖直 FOV 变）
         · +Z → 改远距（半宽半高等比缩放，FOV 不变） */
      const far0 = Math.max(0.3, Number(p.half[2]) || 1);
      let halfX = Math.max(0.02, p.half[0]);
      let halfY = Math.max(0.02, p.half[1]);
      let far = far0;
      if (idx === 0) halfX = Math.max(0.02, dist);
      else if (idx === 1) halfY = Math.max(0.02, dist);
      else {
        far = Math.max(0.3, dist);
        const k = far / far0;
        halfX *= k; halfY *= k;
      }
      const fov = 2 * Math.atan2(halfY, far) * 180 / Math.PI;
      const aspect = halfX / Math.max(1e-4, halfY);
      const next = retuneFrustumProjector({ ...p, half: [halfX, halfY, far] }, { far, fov, aspect });
      if (next) this.store.update(id, { projector: next });
      return;
    }
    const half = p.half.slice();
    half[idx] = Math.max(0.05, dist);   // 手柄位于半尺寸处，拖动距离即新半尺寸
    this.store.update(id, { projector: { ...p, half, depth: half[2] * 2 } });
  }

  // ------------------------------------------------------------- 展板拖拽（移动 / 四角缩放）
  _attachBoardDrag(a, n) {
    const el = n.el;
    const start = (e) => {
      const a2 = this.store.get(a.id);
      if (!a2 || a2.locked || this.isLocked(a.id)) return;   // 选中其它对象时本对象锁定
      if (this.isPreview()) return;                    // 预览态只读
      const sel = this.getSelectedSet();
      if (!sel.includes(a.id)) return;
      if (e.button === 2) return;                       // 右键交给「取消」逻辑
      // 引线锚点圆点由 _attachBoardAnchor 独占，别把它的拖拽当成「移动展板」
      if (e.target.closest?.('[data-role="board-anchor"]')) return;
      // 已选中时点击视频 / 网页 / 内容滚动区，交给媒体本身（播放、拖进度条、滚动）
      if (this.getSelected() === a.id &&
          e.target.closest?.('video, iframe, .ed-board-web, .ed-board-body')) return;
      const corner = e.target.closest?.('.ed-board-corner')?.dataset?.corner;
      const as = n.parts.anchorScreen ? { ...n.parts.anchorScreen } : null;
      // 【点击不改位置的根因】展板悬浮在锚点上方，若拖动时用「鼠标当前屏幕坐标」
      // 去 pickSync，得到的会是板后场景表面的点，展板会瞬间跳到光标下面。
      // 因此记录按下瞬间**锚点**的视口坐标，拖动时按鼠标位移平移这个锚点。
      let anchorClient = null;
      if (as) {
        const hr = this.host.getBoundingClientRect();
        anchorClient = { x: hr.left + as.ax, y: hr.top + as.ay };
      }
      const selBase = new Map();
      for (const id of this.getSelectedSet()) {
        const aa = this.store.get(id); if (!aa) continue;
        selBase.set(id, { points: aa.points.map(p => p.slice()) });
      }
      this._drag = {
        id: a.id,
        mode: corner || 'move',
        corner,
        // 按下瞬间左键确实按着，才启用「buttons 变 0 即收尾」的兜底（合成事件 buttons=0）
        armed: (e.buttons & 1) === 1,
        sx: e.clientX, sy: e.clientY, moved: false,
        as, anchorClient,
        initSize: a2.style.size ? { ...a2.style.size } : { w: 1.8, h: 1.35 },
        base: { points: a2.points.map(p => p.slice()) },
        selBase,
      };
      // 不调用 preventDefault：它会打断真实鼠标 mousedown -> click 序列，
      // 导致「单击展板选不中、属性面板不展示内容」。防选中已由 CSS user-select:none 保证。
      // 也不能无条件抑制 click —— 只有真正拖动过才抑制。
      try { el.setPointerCapture(e.pointerId); } catch { /* noop */ }
      e.stopPropagation();
    };
    const move = (e) => {
      const d = this._drag;
      if (!d) return;
      // 左键已松开却没收到 pointerup（在 iframe 外松手 / 系统吞事件）：立刻收尾，
      // 否则拖拽状态一直挂着，之后动一下鼠标展板还在跟着跑
      if (d.armed && e.pointerType !== 'touch' && (e.buttons & 1) === 0) {
        end(e);                                      // 左键已松开：停止平移 / 缩放展板
        return;
      }
      if (!d.moved) {
        if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) <= DRAG_PX) { e.stopPropagation(); return; }
        d.moved = true;
        this._suppressClick = true;                   // 真拖拽：抑制随后的误触 click
      }
      if (d.mode === 'move') {
        // 单击（moved=false）永远走不到这里：展板的 points[0] 不会被改写。
        if (!d.anchorClient) { e.stopPropagation(); return; }
        let dx = e.clientX - d.sx, dy = e.clientY - d.sy;
        // 对齐吸附：把移动组屏幕包围盒按光标位移偏移后与未选中标注对齐
        const ctx = this._context();
        const sel = this.getSelectedSet();
        if (ctx && sel.length) {
          let gx0 = Infinity, gy0 = Infinity, gx1 = -Infinity, gy1 = -Infinity, has = false;
          for (const id of sel) { const bb = this._bbox(ctx, this.store.get(id)); if (!bb) continue; has = true; gx0 = Math.min(gx0, bb.x0); gy0 = Math.min(gy0, bb.y0); gx1 = Math.max(gx1, bb.x1); gy1 = Math.max(gy1, bb.y1); }
          const group = has ? { x0: gx0, y0: gy0, x1: gx1, y1: gy1 } : null;
          const targets = this.store.list(this.getScene()).filter(x => !sel.includes(x.id)).map(x => this._bbox(ctx, x)).filter(Boolean);
          if (group && targets.length) { const snap = this._computeAlign(group, targets, dx, dy); dx = snap.dx; dy = snap.dy; this._drawGuides(snap.guides); } else this._clearGuides();
        } else this._clearGuides();
        this.onBoardMove?.(d.id, d.anchorClient.x + dx, d.anchorClient.y + dy);
        // 多选：其余选中展板随主选中整体平移（用主选中世界位移驱动）
        if (d.selBase) {
          const cur = this.store.get(d.id);
          if (cur && cur.points[0]) {
            const wd = [cur.points[0][0] - d.base.points[0][0], cur.points[0][1] - d.base.points[0][1], cur.points[0][2] - d.base.points[0][2]];
            for (const [id, base] of d.selBase) {
              if (id === d.id) continue;
              const np = base.points.map(p => [p[0] + wd[0], p[1] + wd[1], p[2] + wd[2]]);
              this.store.update(id, { points: np }, { coalesceKey: 'move-sel:' + id });
            }
          }
        }
      } else {
        const as = d.as; if (!as) return;
        const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
        const wp = BOARD_BASE_PX * as.zoom;
        const wSign = (d.corner === 'tr' || d.corner === 'br') ? 1 : -1;
        let w = d.initSize.w + (wSign * 2 * dx) / wp;
        let h = d.initSize.h + (2 * dy) / wp;
        w = Math.max(0.3, Math.min(12, w));
        h = Math.max(0.25, Math.min(12, h));
        this.onBoardResize?.(d.id, { w: Math.round(w * 100) / 100, h: Math.round(h * 100) / 100 });
      }
      e.stopPropagation();
    };
    const end = (e) => {
      if (!this._drag) return;
      const moved = this._drag.moved;
      this._drag = null;
      this._clearGuides();
      try { el.releasePointerCapture(e.pointerId); } catch { /* noop */ }
      e.stopPropagation();
      // 只有拖动过才需要抑制 click；单击走原生 click -> 选中并展示属性内容
      if (moved) setTimeout(() => { this._suppressClick = false; }, 0);
    };
    el.addEventListener('pointerdown', start);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  // ------------------------------------------------------------- 引线锚点拖拽（编辑态 + MESH 吸附）
  _attachBoardAnchor(a, n) {
    const dot = n.parts.board.dot;
    const start = (e) => {
      const a2 = this.store.get(a.id);
      if (!a2 || a2.locked || this.isLocked(a.id) || this.isPreview() || !this.isEditable()) return;
      if (e.button === 2) return;
      this._anchorDrag = {
        id: a.id, pointerId: e.pointerId,
        armed: (e.buttons & 1) === 1,               // 左键按下态（合成事件为 0）
        sx: e.clientX, sy: e.clientY, moved: false,
      };
      this._suppressClick = true;
      try { dot.setPointerCapture(e.pointerId); } catch { /* noop */ }
      e.stopPropagation(); e.preventDefault();
      this.onPick(a.id, 'select');                  // 拾取即选中：属性面板自动展示内容
      this.onBoardAnchor?.(a.id, e.clientX, e.clientY, 'start');
    };
    const move = (e) => {
      const d = this._anchorDrag;
      if (!d) return;
      if (d.armed && e.pointerType !== 'touch' && (e.buttons & 1) === 0) {
        end(e);                                      // 左键已松开：停止调整引线锚点
        return;
      }
      // 同样加阈值：单纯点击锚点不能写入 leadTo（否则导引线也会「变位置」）
      if (!d.moved) {
        if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) <= DRAG_PX) { e.stopPropagation(); return; }
        d.moved = true;
      }
      this.onBoardAnchor?.(a.id, e.clientX, e.clientY, 'move');
      e.stopPropagation();
    };
    const end = (e) => {
      if (!this._anchorDrag) return;
      this._anchorDrag = null;
      try { dot.releasePointerCapture(e.pointerId); } catch { /* noop */ }
      this.onBoardAnchor?.(a.id, e.clientX, e.clientY, 'end');
      e.stopPropagation();
      setTimeout(() => { this._suppressClick = false; }, 0);
    };
    dot.addEventListener('pointerdown', start);
    dot.addEventListener('pointermove', move);
    dot.addEventListener('pointerup', end);
    dot.addEventListener('pointercancel', end);
  }

  // ------------------------------------------------------------- 草稿预览
  _drawDraft(ctx) {
    const draft = this.draft;
    if (!draft || !draft.points.length) {
      this.layer.classList.remove('ed-drawing');
      if (this._draft) { this._draft.g.remove(); this._draft = null; }
      return;
    }
    this.layer.classList.add('ed-drawing');
    if (!this._draft) {
      const g = svg('g', { class: 'ed-draft-g' });
      // 深色描边光晕 + 亮色主线：3DGS 场景本身很亮，2px 虚线几乎看不见，
      // 用户会误判成「动线只画出了点」。双层线保证任意背景下都有清晰的线。
      const halo = svg('polyline', { class: 'ed-draft-halo' });
      const line = svg('polyline', { class: 'ed-draft' });
      const flow = svg('g', { class: 'ed-draft-flow' });
      const rubber = svg('polyline', { class: 'ed-draft-rubber' });
      const handles = svg('g', { class: 'ed-draft-handles' });
      const cross = svg('g', { class: 'ed-draft-cross' });
      g.append(halo, line, flow, rubber, handles, cross);
      this.svg.appendChild(g);
      this._draft = { g, halo, line, flow, flowSegs: [], flowSig: null, flowWorld: null,
        rubber, handles, cross, dots: [] };
    }
    const d = this._draft;
    const pts = draft.points.map(p => this._project(ctx, p));
    const ok = pts.filter(Boolean);
    const coords = ok.map(p => `${p.x},${p.y}`).join(' ');
    d.line.setAttribute('points', coords);
    d.halo.setAttribute('points', coords);

    // 动线草稿预览：与成稿一致使用**世界空间贴合面片**（落点变化时重新贴合，
    // 点击之间不重复打射线；光标延伸段用直线近似）。不再是屏幕 billboard 箭头。
    const cur = this.cursor ? this._project(ctx, this.cursor) : null;
    let polys = [];
    if (draft.kind === 'line' && ok.length >= 2) {
      const sigD = JSON.stringify(draft.points) + '|' + this.drapeVersion();
      if (d.flowSig !== sigD) {
        d.flowSig = sigD;
        d.flowWorld = this.drapeLine ? this.drapeLine(draft.points) : draft.points;
      }
      const base = (d.flowWorld || draft.points)
        .filter(p => Array.isArray(p) && p.length >= 3 && p.every(Number.isFinite))
        .map(p => [p[0], p[1] + 0.03, p[2]]);
      const worldPrev = (cur && this.cursor && Array.isArray(this.cursor))
        ? base.concat([[this.cursor[0], (this.cursor[1] || 0) + 0.03, this.cursor[2] || 0]])
        : base;
      const halfW = Math.max(0.12, Math.min(2, 0.7 * 0.45));
      const polysW = arrowChainWorld(worldPrev, halfW, Math.max(0.8, halfW * 4.6),
        (performance.now() / 1000 * 0.7) % 1, {
          arrow: true,
          viewDir: ctx.fwd ? [ctx.fwd.x, ctx.fwd.y, ctx.fwd.z] : null
        });
      polys = polysW.map(poly => {
        const pr = poly.map(p => this._project(ctx, p));
        return pr.every(Boolean) ? pr.map(p => [p.x, p.y]) : null;
      }).filter(Boolean);
    }
    while (d.flowSegs.length < polys.length) {
      const p = svg('polygon', { class: 'ed-draft-flow-seg' });
      d.flow.appendChild(p); d.flowSegs.push(p);
    }
    d.flowSegs.forEach((el, i) => {
      if (i >= polys.length) { el.style.display = 'none'; return; }
      el.style.display = '';
      el.setAttribute('points', polys[i].map(([x, y]) =>
        `${x.toFixed(1)},${y.toFixed(1)}`).join(' '));
    });

    // 顶点手柄：让「已经落了几个点」一目了然
    while (d.dots.length < ok.length) {
      const c = svg('circle', { r: 4, class: 'ed-draft-dot' });
      d.handles.appendChild(c); d.dots.push(c);
    }
    d.dots.forEach((c, i) => {
      c.style.display = i < ok.length ? '' : 'none';
      if (i < ok.length) { c.setAttribute('cx', ok[i].x); c.setAttribute('cy', ok[i].y); }
    });

    // 橡皮筋：最后一个顶点 -> 鼠标位置
    if (cur && ok.length) {
      const last = ok[ok.length - 1];
      d.rubber.setAttribute('points', `${last.x},${last.y} ${cur.x},${cur.y}`);
      d.rubber.style.display = '';
      d.cross.style.display = '';
      d.cross.innerHTML =
        `<line x1="${cur.x - 7}" y1="${cur.y}" x2="${cur.x + 7}" y2="${cur.y}"></line>` +
        `<line x1="${cur.x}" y1="${cur.y - 7}" x2="${cur.x}" y2="${cur.y + 7}"></line>` +
        `<circle cx="${cur.x}" cy="${cur.y}" r="3.5"></circle>`;
    } else {
      d.rubber.style.display = 'none';
      d.cross.style.display = 'none';
    }

    /* 透视贴花草稿：落第一个点之后就把「将要生成的视锥体」实时画出来。
       不这样做的话，用户点第二点前完全看不到视场范围，只能靠猜。 */
    if (!d.frustum) d.frustum = { g: svg('g', { class: 'ed-draft-frustum' }), lines: [] };
    if (!d.frustum.g.parentNode) d.g.appendChild(d.frustum.g);
    const target = (draft.kind === 'frustum' && draft.points.length >= 1) ? this.cursor : null;
    const prj = target ? makeFrustumProjector(draft.points[0], target) : null;
    const cv = prj ? projectorVolumeCorners(prj) : null;
    const cp = cv ? cv.map(p => this._project(ctx, p)) : null;
    const frustumVisible = !!(cp && cp.every(Boolean));
    d.frustum.g.style.display = frustumVisible ? '' : 'none';
    if (frustumVisible) {
      const edges = [[0, 1], [1, 3], [3, 2], [2, 0], [4, 5], [5, 7], [7, 6], [6, 4],
        [0, 4], [1, 5], [2, 6], [3, 7]];
      while (d.frustum.lines.length < edges.length) {
        const ln = svg('line', { class: 'ed-draft-frustum-edge' });
        d.frustum.g.appendChild(ln); d.frustum.lines.push(ln);
      }
      d.frustum.lines.forEach((ln, i) => {
        const e = edges[i];
        if (!e) { ln.style.display = 'none'; return; }
        ln.style.display = '';
        ln.setAttribute('x1', cp[e[0]].x.toFixed(1)); ln.setAttribute('y1', cp[e[0]].y.toFixed(1));
        ln.setAttribute('x2', cp[e[1]].x.toFixed(1)); ln.setAttribute('y2', cp[e[1]].y.toFixed(1));
      });
    }
  }
}

function c_of(a) { return a.style.color || '#22d3ee'; }

/** 屏幕折线总长（px）：用于判定贴合结果是否塌缩成一点 / 段长自适应 */
/* screenPathLength 已随动线面片改为世界空间（schema.arrowChainWorld 内部按
   三维弧长计算）而删除；屏幕折线长度不再被任何渲染路径引用。 */

/** 展板媒体：全部直接渲染进世界锚定的 .ed-board 里，不打开任何独立页面。
 *  只有签名变化才重建（见 _drawBoard），iframe / video 不会因为每帧刷新而重载。 */
function boardMediaHtml(media) {
  if (!media) return '';
  const url = esc(media.url || '');
  switch (media.type) {
    case 'image':
      return `<img class="ed-board-img" src="${url}" alt="${esc(media.caption || '')}">` +
        (media.caption ? `<div class="ed-board-cap">${esc(media.caption)}</div>` : '');
    case 'video':
      return `<video class="ed-board-video" src="${url}" controls muted loop playsinline preload="metadata"></video>` +
        (media.caption ? `<div class="ed-board-cap">${esc(media.caption)}</div>` : '');
    case 'webpage':
      // iframe 内嵌在三维展板内；sandbox 去掉 allow-popups，避免点链接弹出独立页面。
      // 未选中时由 CSS 遮罩接管点击（用于选中 / 拖拽展板），选中后可直接操作网页。
      return `<div class="ed-board-web" data-url="${url}">
        <iframe src="${url}" title="${esc(media.caption || '展板网页内容')}"
          sandbox="allow-scripts allow-same-origin allow-forms"
          referrerpolicy="no-referrer"></iframe>
        <span class="ed-board-web-tag">◫ ${esc(media.caption || '网页')}</span>
      </div>`;
    case 'text':
      return `<div class="ed-board-note">${esc(media.caption || media.url || '')}</div>`;
    case 'link':
      return `<div class="ed-board-link"><span>↗ 链接</span><em>${esc(media.caption || media.url || '')}</em></div>`;
    default:
      return '';
  }
}

/* ---------------------------------------------------------------- 演示视频流
 * 三维实体屏默认没有片源时，用离屏 canvas 生成一段循环画面并通过
 * captureStream 喂给真正的 <video>：既能验证/展示「屏在播放视频」，
 * 又完全不发网络请求（回归里的 HTTP>=400 / console error 汇总不受影响）。
 * 用户在属性面板填入视频 URL 后立即切换为真实片源。 */
const _demoStreams = new Map();      // label -> { stream, timer }
function demoVideoStream(label = '三维实体屏 · 实时画面') {
  if (_demoStreams.has(label)) return _demoStreams.get(label).stream;
  try {
    const cv = document.createElement('canvas');
    cv.width = 640; cv.height = 360;
    const g = cv.getContext('2d');
    if (!g || typeof cv.captureStream !== 'function') return null;
    let t = 0;
    const draw = () => {
      t++;
      const bg = g.createLinearGradient(0, 0, 640, 360);
      bg.addColorStop(0, '#062b3d'); bg.addColorStop(1, '#0a1626');
      g.fillStyle = bg; g.fillRect(0, 0, 640, 360);
      g.strokeStyle = 'rgba(56,214,245,.13)'; g.lineWidth = 1;
      for (let x = 0; x <= 640; x += 40) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 360); g.stroke(); }
      for (let y = 0; y <= 360; y += 40) { g.beginPath(); g.moveTo(0, y); g.lineTo(640, y); g.stroke(); }
      for (let i = 0; i < 16; i++) {
        const v = 48 + 132 * Math.abs(Math.sin(t / 24 + i * 0.42));
        g.fillStyle = i % 3 === 0 ? '#a78bfa' : '#22d3ee';
        g.fillRect(46 + i * 35, 300 - v, 22, v);
      }
      g.fillStyle = '#e9faff'; g.font = 'bold 25px sans-serif';
      g.fillText(label, 40, 54);
      g.fillStyle = '#7fe3fb'; g.font = '15px monospace';
      g.fillText('PLAYING  ' + String(Math.floor(t / 15)).padStart(5, '0'), 40, 84);
      g.fillStyle = '#34d399'; g.beginPath(); g.arc(602, 46, 7, 0, Math.PI * 2); g.fill();
      g.strokeStyle = 'rgba(127,227,251,.5)'; g.strokeRect(20, 20, 600, 320);
    };
    draw();
    const timer = setInterval(draw, 66);
    const stream = cv.captureStream(15);
    _demoStreams.set(label, { stream, timer });
    return stream;
  } catch { return null; }
}
function stopDemoVideoStream() {
  for (const { stream, timer } of _demoStreams.values()) {
    clearInterval(timer);
    try { stream.getTracks().forEach(tr => tr.stop()); } catch { /* noop */ }
  }
  _demoStreams.clear();
}

/**
 * 把四个投影角点重排成「纹理 u 朝屏幕右、v 朝屏幕下」的顺序。
 *
 * quad 固定为 (0,0)(1,0)(1,1)(0,1)。俯视地面时局部 u、v 常常同时反向
 * （整体 180° 旋转），只看叉积是正的、发现不了问题，视频文字会倒着贴上去；
 * 因此必须分别检查两条边的屏幕方向，必要时各翻一次。
 * 叉积为负则是真镜像，需要奇数次翻转才能恢复正确绕序。
 */
function orientQuad(quad) {
  const ux = quad[1][0] - quad[0][0], uy = quad[1][1] - quad[0][1];
  const vx = quad[3][0] - quad[0][0], vy = quad[3][1] - quad[0][1];
  let flipU = ux < 0;
  const flipV = vy < 0;
  if (ux * vy - uy * vx < 0 && flipU === flipV) flipU = !flipU;
  const at = (u, v) => quad[v ? (u ? 2 : 3) : (u ? 1 : 0)];
  const u0 = flipU ? 1 : 0, u1 = flipU ? 0 : 1;
  const v0 = flipV ? 1 : 0, v1 = flipV ? 0 : 1;
  return [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)];
}

function isPreviewFade(a, d, alwaysVisible) {
  // 深度关闭 = 2D 叠加语义：标注始终可见，不按距离淡出
  if (alwaysVisible) return false;
  return !a.style.labelAlways && d > 18 && a.kind === 'point';
}

/**
 * 3DGS 落点拾取（异步、可降级、支持深度开关）
 *
 * 优先级（深度「开」）：
 *   L1 碰撞 MESH  : MeshCollision.queryRay() —— 官方 PLY+btree 三角网 + BVH，
 *                    与漫游碰撞体同一份几何，最精确，且天然可求法线。
 *   L2 高斯深度图 : viewer.picker().pick(nx, ny) —— 注意它是 **Promise**，
 *                    且参数是 0..1 归一化坐标（引擎 clampPixel 内乘 size）。
 *                    旧实现把 Promise 当 Vec3 读，深度拾取从未生效。
 *   L3 参考平面   : 地面 Y=groundY / 相机朝向垂直墙平面。
 *   L4 相机前悬浮 : 保证任何环境都能落点。
 *
 * 深度「关」：所有顶点投影到「本次绘制锁定的平面」（垂直于进入绘制时的相机视线，
 *   距相机 planeDistance 米）。线 / 面 / 展板因此严格共面，不会因贴不同深度的
 *   墙面凹凸而扭曲 —— 这是「点线面能画进三维场景」的关键。
 *
 * 坐标：PlayCanvas CameraComponent.screenToWorld / worldToScreen 使用
 *   graphicsDevice.clientRect（CSS 像素），所以屏幕坐标直接用 clientX-rect.left。
 */
import { ensureMesh, rayHitMesh, nearestMeshPoint, meshState } from './mesh-pick.js';
import { resamplePolyline, decalGridPoints } from './schema.js';

function toArray(p) {
  if (!p) return null;
  if (Array.isArray(p)) return p.slice(0, 3).map(Number);
  if (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) return [p.x, p.y, p.z];
  if (p.position) return toArray(p.position);
  if (p.point) return toArray(p.point);
  return null;
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
function unit(v) { const l = Math.hypot(...v) || 1; return v.map(n => n / l); }

/** 给 Promise 加超时，避免异步拾取器异常时无限挂起 */
function withTimeout(p, ms) {
  return new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; reject(new Error('timeout')); } }, ms);
    Promise.resolve(p).then(
      v => { if (!done) { done = true; clearTimeout(t); resolve(v); } },
      e => { if (!done) { done = true; clearTimeout(t); reject(e); } }
    );
  });
}

export function createPicker({ getViewer, getOptions = () => ({}) }) {
  let eventPicker = null;      // 兼容旧引擎：picker:ready 事件带来的 wrapper
  let listening = false;
  let mesh = null;             // MeshCollision 实例
  let meshPromise = null;      // 后台预热用的 Promise（不阻塞交互）
  let meshScene = null;
  let drawPlane = null;        // { point:[x,y,z], n:[x,y,z] } 锁定绘制平面
  let lastSource = '-';

  function listen() {
    const v = getViewer();
    if (!v || listening) return;
    if (typeof v.events?.on === 'function') {
      v.events.on('picker:ready', p => { eventPicker = p; });
      listening = true;
    }
  }

  function pickerHandle() {
    const v = getViewer();
    if (!v) return eventPicker;
    // viewer/index.js 的 handle 暴露了延迟 getter（引擎 picker 是懒创建的）
    const p = typeof v.picker === 'function' ? v.picker() : v.picker;
    return p || eventPicker;
  }

  function camera() {
    const v = getViewer();
    const cam = v?.app?.root?.findComponent?.('camera');
    const dev = v?.app?.graphicsDevice;
    const canvas = dev?.canvas;
    return cam && canvas ? { cam, dev, canvas } : null;
  }

  /** 屏幕 CSS 像素 -> 相机世界射线（单位方向，不做 t<=1 截断） */
  function ray(cam, x, y) {
    const pos = cam.entity.getPosition();
    const a = pos.clone(), b = pos.clone();
    const near = Math.max(0.01, (cam.nearClip || 0.1) + 0.01);
    cam.screenToWorld(x, y, near, a);
    cam.screenToWorld(x, y, near + 100, b);
    const dir = unit([b.x - a.x, b.y - a.y, b.z - a.z]);
    return { origin: [pos.x, pos.y, pos.z], dir };
  }

  function axisPlane(origin, dir, axis, value) {
    const k = axis === 'y' ? 1 : axis === 'x' ? 0 : 2;
    if (Math.abs(dir[k]) < 1e-6) return null;
    const t = (value - origin[k]) / dir[k];
    if (t < 0.05 || t > 500) return null;
    const p = [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
    p[k] = value;
    return p;
  }

  function wallPlane(origin, dir, camFwd, anchor) {
    const n = unit([camFwd.x || 0, 0, camFwd.z || -1]);
    const denom = dot(dir, n);
    if (Math.abs(denom) < 1e-6) return null;
    const t = dot(sub(anchor, origin), n) / denom;
    if (t < 0.05 || t > 500) return null;
    return [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
  }

  function planeIntersect(origin, dir, plane) {
    const denom = dot(dir, plane.n);
    if (Math.abs(denom) < 1e-6) return null;
    const t = dot(sub(plane.point, origin), plane.n) / denom;
    if (t < 0.05 || t > 500) return null;
    return [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
  }

  /**
   * 预加载碰撞 MESH，避免第一次落点等待（ensureMesh 自身按场景缓存 Promise）
   *
   * 【关键】这里 **不再 await**。ensureMesh 内部最多轮询 32 次 × 250ms = 8s，
   * 早期实现把它放在 pickAsync 的热路径里 await，导致用户点一下后最长
   * 8 秒没有任何反馈（表现为「显示不及时 / 卡住」）。
   * 现在改成：后台预热 + 命中缓存，MESH 就绪后 pickAsync 自然走 L1。
   */
  function warmup(scene) {
    listen();
    if (!scene) return Promise.resolve(mesh);
    if (meshPromise && meshScene === scene) return meshPromise;
    meshScene = scene;
    meshPromise = ensureMesh(scene, getViewer)
      .then(m => { mesh = m; return m; })
      .catch(() => null);
    return meshPromise;
  }

  /**
   * 同步落点（不等任何异步资源）
   *
   * 用于「鼠标移动时的即时预览」：每帧跟随光标的落点必须零延迟，
   * 走异步拾取（深度图 Promise / MESH 轮询）必然掉帧。
   * 只用「已就绪的 MESH 同步射线求交」+ 参考平面兜底。
   */
  function pickSync(clientX, clientY) {
    const ctx = camera();
    if (!ctx) return null;
    const { cam, canvas } = ctx;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;

    const opt = getOptions();
    const { origin, dir } = ray(cam, x, y);
    const fwd = cam.entity.forward;

    if (opt.depthOn === false) {
      // 深度关：与正式落点一致，落在锁定的绘制平面上
      if (drawPlane) {
        const p = planeIntersect(origin, dir, drawPlane);
        if (p) return { pos: p, source: 'plane' };
      }
    } else {
      const hit = rayHitMesh(mesh, origin, dir, 300);
      if (hit) return { pos: hit.pos, source: 'mesh', normal: hit.normal };
    }
    const g = axisPlane(origin, dir, 'y', Number(opt.groundY ?? -0.644));
    if (g) return { pos: g, source: 'ground' };
    const w = wallPlane(origin, dir, fwd, opt.wallAnchor || [0, 0, 0]);
    if (w) return { pos: w, source: 'wall' };
    const d = Number(opt.freeDistance ?? 3);
    return { pos: origin.map((v, i) => v + dir[i] * d), source: 'fallback' };
  }

  /**
   * 屏幕位置 -> 最近的碰撞 MESH 表面点（供展板引线锚点拖拽吸附）
   *
   * 三级策略，保证「拖到哪儿都尽量贴在模型上」：
   *   L1 光标处主射线命中 MESH —— 直接吸附，零偏移；
   *   L2 主射线落空（擦过物体边缘 / 落在空隙）时，在光标周围按半径递增
   *      环形投射 12 条辅助射线，取**离光标最近**的一处 MESH 命中；
   *   L3 全部射线都落空时，用三角网空间哈希查「离同步落点最近的三角面」，
   *      把自由落点投影到真实表面上。
   * 返回 snapped 标记，便于 UI 提示 / 自动化回归判断吸附是否真的发生。
   * 全程同步（只查已就绪的 BVH），拖动过程不会因等待异步资源而卡顿。
   */
  function snapToMesh(clientX, clientY) {
    const ctx = camera();
    if (!ctx) return null;
    const { cam, canvas } = ctx;
    const rect = canvas.getBoundingClientRect();
    const cast = (sx, sy) => {
      const x = sx - rect.left, y = sy - rect.top;
      if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
      const { origin, dir } = ray(cam, x, y);
      return rayHitMesh(mesh, origin, dir, 400);
    };
    const primary = cast(clientX, clientY);
    if (primary) return { ...primary, snapped: true, source: 'mesh', offsetPx: 0 };

    for (const r of [7, 14, 24, 38]) {
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        const h = cast(clientX + Math.cos(a) * r, clientY + Math.sin(a) * r);
        if (h) return { ...h, snapped: true, source: 'mesh', offsetPx: r };
      }
    }
    const fallback = pickSync(clientX, clientY);
    if (!fallback) return null;
    const near = nearestMeshPoint(mesh, fallback.pos, 4);
    if (near) return { ...near, snapped: true, source: 'mesh', offsetPx: -1 };
    return { ...fallback, snapped: false };
  }

  /**
   * 把一个世界点垂直投影到脚下最近的碰撞 MESH 表面（动线贴地用）。
   *
   * 【天花板 Bug —— 已修】旧版从 `p.y + 4m` 往下打 10m 射线：展厅层高通常
   * 3~3.5m，射线起点已经在天花板上方，第一个命中就是天花板而不是脚下地面。
   * 垂直射线的 XZ 自洽校验又永远成立，于是绘制中的草稿看着正常、双击结束后
   * 整条动线被吸到天花板上「乱飞」。
   *
   * 现在只从采样点上方 `up=0.18m` 向下找 2.5m 内的表面，并强制要求命中点
   * **不高于采样点**（天花板命中一律丢弃）；再配合 drapePolyline 的垂直位移
   * 上限做二次保险。XZ 自洽校验继续保留，防 mock 固定返回值把线吸塌成一点。
   */
  function drapeSurface(p, up = 0.18) {
    if (!mesh || !Array.isArray(p) || p.length < 3) return null;
    const ok = (q) => !!q && Math.hypot(q[0] - p[0], q[2] - p[2]) < 0.5 &&
      q[1] <= p[1] + up + 0.02 && q[1] >= p[1] - 2.5;
    const hit = rayHitMesh(mesh, [p[0], p[1] + up, p[2]], [0, -1, 0], 2.5);
    if (ok(hit?.pos)) return hit.pos;
    // 采样点略微陷入表面（深度噪声）时，从下方 0.45m 向上找最近一层，
    // 射线最长 0.7m，够不到天花板。
    const under = rayHitMesh(mesh, [p[0], p[1] - 0.45, p[2]], [0, 1, 0], 0.7);
    if (ok(under?.pos)) return under.pos;
    // 竖直墙面 / 屋檐下：最近三角面兜底
    const near = nearestMeshPoint(mesh, p, 0.8);
    if (ok(near?.pos)) return near.pos;
    return null;
  }

  /**
   * 折线贴合模型：先按 step 米等距重采样（长直段跨台阶 / 坡道也必须补点），
   * 再逐点垂直吸附到 MESH 表面。返回值与相机无关，可整段缓存，
   * 因此只在顶点 / 带宽 / MESH 就绪状态变化时重算，不会每帧打几百条射线。
   */
  function drapePolyline(points, step = 0.45) {
    const dense = resamplePolyline(points, step);
    return dense.map(p => {
      const q = drapeSurface(p);
      // 二次保险：任何 >1.5m 的垂直跳变都判为错误吸附（天花板 / 远处另一层），
      // 宁可保留原始落点，也不能让整条线飞走。
      return q && Math.abs(q[1] - p[1]) <= 1.5 ? q : p;
    });
  }

  /** 世界点 -> canvas CSS 像素（与 depthUnproject 的入参同一坐标系）。
   *  在相机背后 / 投影非有限值时返回 null，调用方跳过该采样点。 */
  function worldToCanvas(cam, canvas, p) {
    const cr = canvas.getBoundingClientRect();
    const dev = getViewer()?.app?.graphicsDevice;
    const dw = dev?.clientRect?.width || cr.width || 1;
    const dh = dev?.clientRect?.height || cr.height || 1;
    const cp = cam.entity.getPosition();
    const fwd = cam.entity.forward;
    if ((p[0] - cp.x) * fwd.x + (p[1] - cp.y) * fwd.y + (p[2] - cp.z) * fwd.z <= 0.05) return null;
    const tmp = cp.clone(), out = cp.clone();
    tmp.set(p[0], p[1], p[2]);
    cam.worldToScreen(tmp, out);
    if (!Number.isFinite(out.x) || !Number.isFinite(out.y)) return null;
    // worldToScreen 用 graphicsDevice.clientRect（可能是 DPR 尺度），换回 CSS 像素
    return { x: out.x * (cr.width / dw) + cr.left, y: out.y * (cr.height / dh) + cr.top };
  }

  /**
   * 【动线贴地 · 深度版】与贴花（unprojectRect）完全同源，不依赖碰撞 MESH。
   *
   * 为什么需要这条路径：`drapePolyline` 只能吸附「碰撞三角网」，而本工程多数
   * 场景没有 collision-manifest（纯 3DGS），于是动线只会落在几个原始落点上，
   * 长直段跨台阶 / 坡道时从空中穿过 —— 这就是「动线不贴地」的根因。
   *
   * 做法：折线等距重采样 -> 每个采样点用当前相机投到屏幕 -> 取该像素的
   * 场景深度反算世界表面点（depthUnproject，与贴花逐像素反算同一函数）。
   * 相机沿视线看到的那层表面即命中结果，天然不会像垂直向下射线那样撞天花板。
   *
   * 与 drapePolyline 一致的两个工程约束：
   *   · **批量并发**（每批 6 个）避免把上百次 GPU readback 一次塞进拾取队列；
   *   · **采样上限**（默认 64 点）：深度反算是逐像素 readback，长线必须抽稀，
   *     否则一条 100m 动线会卡住几百毫秒。
   * 结果与相机无关，可整段缓存 / 持久化，只在顶点或模型版本变化时重算。
   *
   * @returns {Promise<{points:number[][], step:number, samples:number, stats:object, source:string}|null>}
   */
  async function drapePolylineDepth(points, step = 0.9, opts = {}) {
    const ctx = camera();
    if (!ctx) return null;
    const { cam, canvas } = ctx;
    const cr = canvas.getBoundingClientRect();
    if (!cr.width || !cr.height) return null;
    const src = (points || []).filter(p => Array.isArray(p) && p.length >= 3 && p.every(Number.isFinite));
    if (src.length < 2) return null;

    // 采样密度：总长 / step，但不超过 maxSamples（每个采样点 = 一次 GPU readback）
    let len = 0;
    for (let i = 1; i < src.length; i++) {
      len += Math.hypot(src[i][0] - src[i - 1][0], src[i][1] - src[i - 1][1], src[i][2] - src[i - 1][2]);
    }
    const maxSamples = Math.max(8, Math.min(200, Number(opts.maxSamples) || 64));
    const stepUse = Math.max(0.15, Math.min(Math.max(0.1, Number(step) || 0.9), len / maxSamples || step));
    const dense = resamplePolyline(src, stepUse);
    if (dense.length < 2) return null;

    const pickTimeout = Math.max(500, Number(opts.pickTimeout) || 900);
    const maxDrop = Number(opts.maxDrop) || 6;      // 单点垂直位移上限（防误吸到远处另一层）
    const hits = new Array(dense.length).fill(null);
    const stats = {};

    for (let off = 0; off < dense.length; off += 6) {
      const batch = dense.slice(off, off + 6);
      // 每批并发 6 个：sp = 采样点的屏幕像素，h = 该像素反算出的表面点
      const res = await Promise.all(batch.map(async (p) => {
        const sp = worldToCanvas(cam, canvas, p);
        if (!sp) return { sp: null, h: null };
        let h = null;
        try { h = await depthUnproject(sp.x, sp.y, { pickTimeout }); } catch (_) { h = null; }
        return { sp, h };
      }));
      res.forEach(({ sp, h }, k) => {
        const p = dense[off + k];
        /* 三重校验，缺一不可：
           ① 来源只接受「相机视线命中的真实表面」：depth（高斯深度图）/ mesh
              （碰撞网）。ground / free 是拾取链兜底出来的参考平面（groundY 是
              人工标定的），拿它做贴地会把整条线拉到错误高度。
           ② 垂直位移上限：防误吸到远处另一层 / 天花板。
           ③ **同视线校验**：把命中点重新投影回屏幕，必须仍落在本采样点的像素上
              （±4px）。没有这一步，任何「固定返回值」的拾取实现（测试替身 /
              异常时返回首点 / 射线打偏）都能把整条动线塌成一个点。 */
        let ok = false;
        if (h && (h.source === 'depth' || h.source === 'mesh') &&
            Math.abs(h.pos[1] - p[1]) <= maxDrop) {
          if (sp) {
            const q = worldToCanvas(cam, canvas, h.pos);
            ok = !!q && Math.abs(q.x - sp.x) <= 4 && Math.abs(q.y - sp.y) <= 4;
          } else {
            ok = true;                       // 采样点本身不可投影（背后），无需校验
          }
        }
        if (ok) {
          hits[off + k] = h.pos;
          stats[h.source] = (stats[h.source] || 0) + 1;
        } else {
          stats.miss = (stats.miss || 0) + 1;
        }
      });
    }

    /* ---------- 第二轮兜底：深度 / 视线网都拿不到的采样点 ----------
       典型场景：门洞 / 窗洞边缘、深度图空洞、拾取超时。
       先试「垂直吸附到碰撞网」（drapeSurface，跨门框、栏杆这类薄结构最有效），
       仍失败就先空着，等下面按「空洞跨度」决定插值还是保留。 */
    for (let i = 0; i < dense.length; i++) {
      if (hits[i]) continue;
      const p = dense[i];
      const s = drapeSurface(p);
      if (s && Math.abs(s[1] - p[1]) <= maxDrop) {
        hits[i] = s;
        stats.surface = (stats.surface || 0) + 1;
      }
    }

    // 整条线一个真实命中都没有时（无深度图 / 全被遮挡）：退到标定地面平面，
    // 避免「整条动线悬在半空」。只在垂直位移 ≤ 3m 内生效（跨层数据不乱吸）。
    if (!hits.some(Boolean)) {
      const gy = Number(getOptions().groundY);
      if (Number.isFinite(gy)) {
        for (let i = 0; i < dense.length; i++) {
          const p = dense[i];
          if (Math.abs(gy - p[1]) <= 3) {
            hits[i] = [p[0], gy, p[2]];
            stats.ground = (stats.ground || 0) + 1;
          }
        }
      }
    }

    // 空洞索引：左右最近的有效采样点（用于插值补齐，见下）
    const prevIdx = new Array(dense.length).fill(-1);
    const nextIdx = new Array(dense.length).fill(-1);
    for (let i = 1; i < dense.length; i++) prevIdx[i] = hits[i - 1] ? i - 1 : prevIdx[i - 1];
    for (let i = dense.length - 2; i >= 0; i--) nextIdx[i] = hits[i + 1] ? i + 1 : nextIdx[i + 1];

    /* 允许插值的最大空洞跨度（弧长，米）。超过它就不是「深度图的小洞」，
       而是真的跨过了一个门洞 / 挑空 —— 硬拉一条直线过去就是「飘在空中」。 */
    const maxGap = Number(opts.maxGap) > 0 ? Number(opts.maxGap) : 2.0;
    const arcAt = (i) => (i > 0 ? Math.hypot(
      dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1], dense[i][2] - dense[i - 1][2]) : 0);

    const outPts = dense.map((p, i) => {
      const h = hits[i];
      if (h) {
        // 深度图有噪声：Y 取前后邻域中值压掉单点跳变（XZ 保留采样值，不让线横向抖动）
        const a = hits[i - 1] || h, b = hits[i + 1] || h;
        const ys = [a[1], h[1], b[1]].sort((x, y) => x - y);
        return [h[0], ys[1], h[2]];
      }
      const pi = prevIdx[i], ni = nextIdx[i];
      // 空洞两端都有效且跨度可接受：线性插值（不能保留悬空原始点）
      if (pi >= 0 && ni >= 0) {
        let gap = 0;
        for (let k = pi + 1; k <= ni; k++) gap += arcAt(k);
        if (gap <= maxGap) {
          const t = (i - pi) / (ni - pi);
          const A = hits[pi], B = hits[ni];
          stats.filled = (stats.filled || 0) + 1;
          return [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t];
        }
        // 跨度太大：不硬拉斜线，改成「沿水平走、只借两端高度」的贴地折线，
        // 视觉上是地上一段直线，而不是悬空的斜跳。
        const t = (i - pi) / (ni - pi);
        stats.bridged = (stats.bridged || 0) + 1;
        return [p[0], hits[pi][1] + (hits[ni][1] - hits[pi][1]) * t, p[2]];
      }
      // 首尾外侧：沿用最近有效点的高度，只保留本采样点的水平位置
      const only = hits[pi >= 0 ? pi : ni];
      if (only) {
        stats.filled = (stats.filled || 0) + 1;
        return [p[0], only[1], p[2]];
      }
      return p.slice();
    });

    /* ---------- 第三轮：纵向离群压制（「动线飘在空中」的直接修复） ----------
       窗口 5 中值滤波：任何比邻域中值高出/低于 1.2m 以上的点都判为错误吸附
       （深度图把远处的墙 / 天花板算进来了），直接压回中值高度，横纵不变。 */
    const MAX_JUMP = 1.2;
    const ys = outPts.map(p => p[1]);
    for (let i = 0; i < outPts.length; i++) {
      const w = [];
      for (let k = Math.max(0, i - 2); k <= Math.min(outPts.length - 1, i + 2); k++) w.push(ys[k]);
      w.sort((a, b) => a - b);
      const m = w[(w.length / 2) | 0];
      if (Math.abs(outPts[i][1] - m) > MAX_JUMP) {
        outPts[i] = [outPts[i][0], m, outPts[i][2]];
        stats.outlier = (stats.outlier || 0) + 1;
      }
    }

    // 主导来源只看真实命中（其余都是统计项）
    const source = Object.keys(stats)
      .filter(k => !['miss', 'filled', 'bridged', 'outlier'].includes(k))
      .sort((a, b) => (stats[b] || 0) - (stats[a] || 0))[0] || 'none';
    return { points: outPts, step: stepUse, samples: dense.length, stats, source };
  }

  /**
   * 贴面矩形：把切平面上的规则网格逐点吸附到碰撞 MESH 表面。
   *
   * 每个网格点沿「表面法向反方向」打一条射线（起点抬到表面上方 up 米），
   * 命中点必须同时满足：
   *   · 沿法向的偏移有限（|along| < up+3）—— 排除打到远处另一面墙；
   *   · 垂直于法向的横向偏移 < 0.6 m —— 排除擦边斜射 / mock 固定返回值。
   * 落空时用三角网最近点兜底，再不行就保留切平面原点。
   * 结果 lift 米沿法向抬起，避免与模型共面穿插（DOM/SVG 叠加层的等效偏移）。
   * 与相机无关，可整块缓存，绝不每帧打几百条射线。
   */
  function drapeQuad(frame, nu = 8, nv = 8, lift = 0.02) {
    const grid = decalGridPoints(frame, nu, nv);
    const n = unit(frame.normal || [0, 1, 0]);
    // 与 drapeSurface 同理：起点只在切平面上方 0.25m，绝不能抬到 3.5m ——
    // 那样第一个命中会是天花板，整块贴面被吸到屋顶。
    const up = 0.25;
    const validate = (hitPos, p) => {
      const d = sub(hitPos, p);
      const along = dot(d, n);
      const lateral = Math.hypot(d[0] - n[0] * along, d[1] - n[1] * along, d[2] - n[2] * along);
      return along <= up + 0.02 && along >= -2.5 && lateral < 0.6;
    };
    const pts = grid.points.map((p) => {
      if (!mesh) return p.slice();
      const origin = [p[0] + n[0] * up, p[1] + n[1] * up, p[2] + n[2] * up];
      const down = [-n[0], -n[1], -n[2]];
      const hit = rayHitMesh(mesh, origin, down, 2.8);
      let target = null;
      if (hit && validate(hit.pos, p)) target = hit.pos;
      if (!target) {
        const near = nearestMeshPoint(mesh, p, 1.2);
        if (near && validate(near.pos, p)) target = near.pos;
      }
      const q = target || p;
      return [q[0] + n[0] * lift, q[1] + n[1] * lift, q[2] + n[2] * lift];
    });
    return { points: pts, nu: grid.nu, nv: grid.nv, idx: grid.idx };
  }

  /** 该世界点是否被前方模型遮挡（逐注记深度检测）。
   *  命中点必须落在「相机 → 标注」这条视线上，否则忽略（防 mock 固定值误伤）。 */
  function occluded(worldPoint) {
    const ctx = camera();
    if (!ctx || !mesh || !Array.isArray(worldPoint)) return false;
    const cp = ctx.cam.entity.getPosition();
    const o = [cp.x, cp.y, cp.z];
    const v = [worldPoint[0] - o[0], worldPoint[1] - o[1], worldPoint[2] - o[2]];
    const dist = Math.hypot(v[0], v[1], v[2]);
    if (dist < 0.8) return false;
    const dir = v.map(n => n / dist);
    const hit = rayHitMesh(mesh, o, dir, dist - 0.4);
    if (!hit) return false;
    const t = (hit.pos[0] - o[0]) * dir[0] + (hit.pos[1] - o[1]) * dir[1]
      + (hit.pos[2] - o[2]) * dir[2];
    const off = Math.hypot(
      hit.pos[0] - (o[0] + dir[0] * t),
      hit.pos[1] - (o[1] + dir[1] * t),
      hit.pos[2] - (o[2] + dir[2] * t)
    );
    return off < 0.45 && t < dist - 0.4;
  }

  /**
   * @returns {Promise<{pos:number[], source:string, normal?:number[]}|null>}
   */
  async function pickAsync(clientX, clientY) {
    listen();
    const ctx = camera();
    if (!ctx) return null;
    const { cam, canvas } = ctx;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;

    const opt = getOptions();
    const depthOn = opt.depthOn !== false;
    const { origin, dir } = ray(cam, x, y);
    const fwd = cam.entity.forward;
    const out = (pos, source, normal) => {
      lastSource = source;
      return normal ? { pos, source, normal } : { pos, source };
    };

    if (!depthOn) {
      // 关闭深度：锁定一张垂直于「开始绘制时视线」的平面，全部顶点共面
      if (!drawPlane) {
        const n = unit([fwd?.x || 0, fwd?.y || 0, fwd?.z || -1]);
        const d = Number(opt.planeDistance ?? 6);
        drawPlane = { point: origin.map((v, i) => v + n[i] * d), n };
      }
      const p = planeIntersect(origin, dir, drawPlane);
      if (p) return out(p, 'plane');
    } else {
      // L1 碰撞 MESH 优先（有真实三角形就用真实三角形求交）
      // 注意：这里 **绝不 await warmup()**。碰撞体是异步加载的，
      // 在热路径里等它会让一次点击卡住最多 8 秒。
      // 预热在 mount 时就后台启动了，MESH 就绪后本分支自然命中。
      if (!mesh && opt.scene && !meshPromise) warmup(opt.scene);
      const hit = rayHitMesh(mesh, origin, dir, 300);
      if (hit) return out(hit.pos, 'mesh', hit.normal);

      // L2 高斯深度图（异步 + 归一化坐标）；加超时兜底，避免拾取器卡死时无限等待
      const ph = pickerHandle();
      if (ph && typeof ph.pick === 'function') {
        try {
          const raw = await withTimeout(Promise.resolve(ph.pick(x / rect.width, y / rect.height)), 900);
          const p = toArray(raw);
          if (p && p.every(Number.isFinite)) {
            const d = Math.hypot(...sub(p, origin));
            if (d > 0.05 && d < 500) return out(p, 'depth');
          }
        } catch (_) { /* 深度图不可用，继续降级 */ }
      }

      // L3 参考平面：地面 / 相机朝向的垂直墙
      const g = axisPlane(origin, dir, 'y', Number(opt.groundY ?? -0.644));
      if (g) return out(g, 'ground', [0, 1, 0]);
      const w = wallPlane(origin, dir, fwd, opt.wallAnchor || [0, 0, 0]);
      if (w) return out(w, 'wall');
    }

    // L4 相机前方固定距离，保证永远能落点
    const d = Number(opt.freeDistance ?? 3);
    return out(origin.map((v, i) => v + dir[i] * d), depthOn ? 'fallback' : 'free');
  }

  /**
   * 【深度反算】单个屏幕像素 -> 世界表面点。
   *
   * 优先用引擎自带的高斯深度拾取器：它读取 3DGS 帧的深度缓冲，
   * 由 `screen(x, y) + depth` 反投影出该像素**真正看到的表面**世界坐标
   * （viewer/index.js 的 Picker.pick(nx, ny) -> getWorldPoint）。
   * 深度图不可用时退化为「同屏幕点的相机射线 × 碰撞 MESH / 参考平面」，
   * 保证无 GPU / 老引擎 / headless 环境下也能产出可用的表面网格。
   *
   * 与 drapeSurface 的关键区别：这里射线是**从相机沿视线**打出去的，
   * 命中一定是用户眼前那层表面，绝不会像垂直向下射线那样先撞到天花板。
   */
  async function depthUnproject(clientX, clientY, opt = {}) {
    const ctx = camera();
    if (!ctx) return null;
    const { cam, canvas } = ctx;
    const cr = canvas.getBoundingClientRect();
    const x = clientX - cr.left, y = clientY - cr.top;
    if (x < 0 || y < 0 || x > cr.width || y > cr.height) return null;
    listen();
    const ph = pickerHandle();
    const pickTimeout = Math.max(500, Number(opt.pickTimeout) || 900);
    if (ph && typeof ph.pick === 'function') {
      try {
        const raw = await withTimeout(Promise.resolve(ph.pick(x / cr.width, y / cr.height)), pickTimeout);
        const p = toArray(raw);
        if (p && p.every(Number.isFinite)) {
          const { origin } = ray(cam, x, y);
          const d = Math.hypot(...sub(p, origin));
          if (d > 0.05 && d < 500) return { pos: p, source: 'depth' };
        }
      } catch (_) { /* 深度图不可用，走下面的等价射线 */ }
    }
    const { origin, dir } = ray(cam, x, y);
    const hit = rayHitMesh(mesh, origin, dir, 300);
    if (hit) return { pos: hit.pos, source: 'mesh', normal: hit.normal };
    const g = axisPlane(origin, dir, 'y', Number(getOptions().groundY ?? -0.644));
    if (g) return { pos: g, source: 'ground', normal: [0, 1, 0] };
    return { pos: origin.map((v, i) => v + dir[i] * 3), source: 'free' };
  }

  /** 网格里偶发的空采样（深度图空洞 / 射线落空）用最近的有效邻居补齐 */
  function fillGridGaps(points, U, V) {
    const at = (i, j) => points[j * (U + 1) + i];
    for (let j = 0; j <= V; j++) {
      for (let i = 0; i <= U; i++) {
        if (at(i, j)) continue;
        let best = null, bestD = Infinity;
        for (let jj = 0; jj <= V; jj++) {
          for (let ii = 0; ii <= U; ii++) {
            const q = at(ii, jj);
            if (!q) continue;
            const d = (ii - i) * (ii - i) + (jj - j) * (jj - j);
            if (d < bestD) { bestD = d; best = q; }
          }
        }
        points[j * (U + 1) + i] = best ? best.slice() : [0, 0, 0];
      }
    }
  }

  /* ---------------- 深度快照的批量取样（贴面矩形性能关键） ----------------
     引擎 Picker.pick() 是「队列 + 每个点一次同步 GPU 回读」（texture.read immediate），
     6×6 网格 = 49 次回读，而且 queue.run 是串行的 —— 真机上单次 30~200ms，
     整整 2~10 秒。这就是「贴面矩形计算特别慢」的根因，和采集密度关系不大。
     下面的快路径只做一次 prepare()（快照）+ 一次覆盖整个矩形的 readAround()，
     再在 CPU 上按引擎同样的口径逐点取深度并反投影：回读次数 49 -> 1。 */
  const SAMPLE_R_PX = 2;          // 与引擎 SURFACE_RADIUS_PX 一致
  const SAMPLE_TRIALS = 4;        // 与引擎 PICK_TRIALS 一致（RGBA16F 四通道采样）
  const SAMPLE_PCT = 0.3;         // 与引擎 SURFACE_OPACITY 一致：取 30% 分位（抗高斯空洞）
  /* 快路径的硬超时：prepare 会真的渲一遍 pick pass（7.4M 高斯），真机几十毫秒，
     但无头 SwiftShader 可达几十秒。超时一律回退慢路径 —— 宁可这次慢，
     也绝不能让一张贴面矩形把编辑器卡死。 */
  const FAST_TIMEOUT = 4000;
  /* 快路径连续失败计数。慢后端（无头 SwiftShader 渲 7.4M 高斯）一次 prepare 就可能
     几十秒；连续 3 次超时就本会话彻底停用快路径，避免每次重建贴花都白等一轮。 */
  let fastFail = 0;
  /* 快路径只自检一次就够了：换算口径（归一化线性深度 -> 世界点）与行序是常量。 */
  let fastVerified = false;

  /** 复刻引擎 surfaceDepth：半径 2px 圆盘 × 4 通道，取 30% 分位，剔除 >=1 的无效值 */
  function sampleDepthAt(depthAt, x, y) {
    const arr = [];
    for (let dy = -SAMPLE_R_PX; dy <= SAMPLE_R_PX; dy++) {
      for (let dx = -SAMPLE_R_PX; dx <= SAMPLE_R_PX; dx++) {
        if (dx * dx + dy * dy > SAMPLE_R_PX * SAMPLE_R_PX) continue;
        for (let t = 0; t < SAMPLE_TRIALS; t++) {
          const d = depthAt(x + dx, y + dy, t);
          if (d !== null && Number.isFinite(d)) arr.push(d);
        }
      }
    }
    if (!arr.length) return null;
    arr.sort((a, b) => a - b);
    const v = arr[Math.max(0, Math.ceil(arr.length * SAMPLE_PCT) - 1)];
    return Number.isFinite(v) && v >= 0 && v < 1 ? v : null;
  }

  /** 一次快照 + 一次块回读 -> 整块矩形的世界表面点。
   *  返回 null 表示「快路径不可用」（旧引擎 / 拾取器未就绪），调用方退回逐点 pick。 */
  async function depthGridBlock(cr, rect, U, V, cam, mesh) {
    if (fastFail >= 3) return null;
    const ph = pickerHandle();
    if (!ph || typeof ph.prepare !== 'function' || typeof ph.readAround !== 'function') return null;
    /* 快路径**故意不进引擎的 PickQueue**：`ph.prepare()` 内部要真的渲一遍 pick pass，
       慢后端上可能几十秒不返回；一旦塞进串行队列，后面所有 pick 都被堵死
       （表现是「编辑器整体卡住」，比慢更糟）。这里独立执行 + 外层硬超时，
       超时就回退逐点慢路径，并累加失败计数。 */
    const task = (async () => {
      let sample = null;
      try { sample = await withTimeout(Promise.resolve(ph.prepare()), FAST_TIMEOUT); }
      catch (_) { return null; }                  // 超时 / 后端不支持：回退逐点慢路径
      if (!sample) return null;
      const { width, height } = sample;
      if (!(width > 1 && height > 1)) return null;
      const [u0, v0, u1, v1] = rect;
      const px0 = Math.max(0, Math.floor(u0 * width)), px1 = Math.min(width - 1, Math.ceil(u1 * width));
      const py0 = Math.max(0, Math.floor(v0 * height)), py1 = Math.min(height - 1, Math.ceil(v1 * height));
      if (px1 < px0 || py1 < py0) return null;
      const cx = Math.round((px0 + px1) / 2), cy = Math.round((py0 + py1) / 2);
      const margin = Math.max(Math.ceil((px1 - px0) / 2), Math.ceil((py1 - py0) / 2)) + SAMPLE_R_PX + 2;
      let depthAt = null;
      try { depthAt = await withTimeout(Promise.resolve(ph.readAround(cx, cy, margin, width, height)), FAST_TIMEOUT); }
      catch (_) { return null; }
      if (typeof depthAt !== 'function') return null;

      const near = Math.max(0.001, Number(cam.nearClip) || 0.1);
      const far = Math.max(near + 0.01, Number(cam.farClip) || 1000);
      const fwd = cam.entity.forward;
      const groundY = Number(getOptions().groundY ?? -0.644);
      const points = new Array((U + 1) * (V + 1)).fill(null);
      const stats = {};
      for (let j = 0; j <= V; j++) {
        for (let i = 0; i <= U; i++) {
          const sx = cr.left + (u0 + (u1 - u0) * i / U) * cr.width;
          const sy = cr.top + (v0 + (v1 - v0) * j / V) * cr.height;
          // CSS 像素 -> 快照像素（pickTargetSize 就是 CSS 尺寸，这里按比例兜一层）
          const px = Math.min(width - 1, Math.max(0, Math.round((sx - cr.left) / cr.width * width)));
          const py = Math.min(height - 1, Math.max(0, Math.round((sy - cr.top) / cr.height * height)));
          const { origin, dir } = ray(cam, sx - cr.left, sy - cr.top);
          let hit = null;
          const nd = sampleDepthAt(depthAt, px, py);
          if (nd !== null) {
            // 引擎快照存的是「视空间线性深度 / far」；换算成沿视线的世界距离再反投影
            const z = near + nd * (far - near);
            const cos = dir[0] * fwd.x + dir[1] * fwd.y + dir[2] * fwd.z;
            const k = z / Math.max(1e-4, cos);
            const p = [origin[0] + dir[0] * k, origin[1] + dir[1] * k, origin[2] + dir[2] * k];
            const d = Math.hypot(p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]);
            if (Number.isFinite(d) && d > 0.05 && d < 500) hit = { pos: p, source: 'depth' };
          }
          if (!hit) {                              // 深度空洞：碰撞网格兜底（同步，零回读）
            const m = rayHitMesh(mesh, origin, dir, 300);
            if (m) hit = { pos: m.pos, source: 'mesh' };
          }
          if (!hit) {
            const g = axisPlane(origin, dir, 'y', groundY);
            if (g) hit = { pos: g, source: 'ground' };
          }
          if (hit) {
            points[j * (U + 1) + i] = hit.pos;
            stats[hit.source] = (stats[hit.source] || 0) + 1;
          }
        }
      }
      /* 交叉自检（每个会话只做一次）：快路径的「归一化线性深度 -> 世界点」是本工程
         按引擎口径复刻的，行序 / 深度语义一旦有偏差，贴面矩形会整体错位 —— 那比
         「慢」严重得多。这里用引擎自己的 depthUnproject 抽中心点核对，偏差 >0.5m
         就判定快路径不可信、直接回退（并计入失败），保证「快」永远不会以「错」为代价。 */
      if (!fastVerified) {
        const ref = await depthUnproject(
          cr.left + (u0 + (u1 - u0) * 0.5) * cr.width,
          cr.top + (v0 + (v1 - v0) * 0.5) * cr.height,
          { pickTimeout: 1500 });
        const mi = Math.round(U / 2), mj = Math.round(V / 2);
        const mine = points[mj * (U + 1) + mi];
        if (ref && ref.pos && mine) {
          const d = Math.hypot(ref.pos[0] - mine[0], ref.pos[1] - mine[1], ref.pos[2] - mine[2]);
          if (d > 0.5) return null;              // 口径不一致：放弃快路径
        }
        fastVerified = true;
      }
      return { points, stats, samples: points.length, readbacks: 1, width, height };
    })();
    try {
      const out = await withTimeout(task, FAST_TIMEOUT);
      fastFail = 0;
      return out;
    } catch (_) {
      fastFail++;                                 // 超时：计入失败，回退慢路径
      return null;
    }
  }

  /* ---------------- 辅助线的「场景深度判断」 ----------------
     编辑器里的 OBB 线框 / 视锥台棱 / 旋转环都画在 SVG 上，天然没有深度缓冲，
     于是「墙后的棱」会和「墙上的棱」一样实线画出来，看起来线框穿墙而过。
     这里用与贴面矩形同一条深度快照快路径（1 次 prepare + 1 次 readAround）
     逐点判定：视线方向上的**表面距离**比该点更近，说明该点被前方表面挡住。

     评价口径与 depthGridBlock 完全一致（同快照 / 同 30% 分位 / 同线性深度换算），
     所以「贴花贴在哪面墙上」与「线框哪里被挡」不会互相矛盾。 */
  async function probeOcclusion(worldPoints, opts = {}) {
    if (fastFail >= 3) return null;              // 快路径已判定不可用：直接放弃（不阻塞绘制）
    const ctx = camera();
    if (!ctx || !Array.isArray(worldPoints) || !worldPoints.length) return null;
    const ph = pickerHandle();
    if (!ph || typeof ph.prepare !== 'function' || typeof ph.readAround !== 'function') return null;
    const cr = ctx.canvas.getBoundingClientRect();
    if (!(cr.width > 1 && cr.height > 1)) return null;

    const bias = Math.max(0.05, Number(opts.bias) || 0.2);
    const cp = ctx.cam.entity.getPosition();
    const items = [];
    for (const p of worldPoints) {
      if (!Array.isArray(p) || p.length < 3) { items.push(null); continue; }
      const sp = worldToCanvas(ctx.cam, ctx.canvas, p);
      if (!sp) { items.push(null); continue; }
      const x = sp.x - cr.left, y = sp.y - cr.top;
      if (!(x >= 0 && y >= 0 && x <= cr.width && y <= cr.height)) { items.push(null); continue; }
      items.push({ p, x, y, dist: Math.hypot(p[0] - cp.x, p[1] - cp.y, p[2] - cp.z) });
    }
    const blocked = new Array(worldPoints.length).fill(false);
    const valid = items.filter(Boolean);
    if (!valid.length) return { ready: true, blocked, probes: 0 };

    // readAround 是「中心 + 半径」的正方形块：取所有采样点的最小覆盖框
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const it of valid) {
      if (it.x < minX) minX = it.x; if (it.x > maxX) maxX = it.x;
      if (it.y < minY) minY = it.y; if (it.y > maxY) maxY = it.y;
    }
    const cx = Math.round((minX + maxX) / 2), cy = Math.round((minY + maxY) / 2);
    const margin = Math.ceil(Math.max(maxX - minX, maxY - minY) / 2) + SAMPLE_R_PX + 2;
    /* 采样点分布过广（整台视锥体铺满屏幕）时块回读会到几十 MB：
       宁可这一帧不做深度判断（全部按可见画），也不把主线程卡住。 */
    const maxMargin = Math.max(64, Math.min(720, Number(opts.maxMargin) || 420));
    if (margin > maxMargin) return null;

    /* 同 depthGridBlock：不进引擎队列（避免 prepare 挂起把整条 pick 队列堵死） */
    const task = (async () => {
        let sample = null;
        try { sample = await withTimeout(Promise.resolve(ph.prepare()), FAST_TIMEOUT); }
        catch (_) { return null; }
        if (!sample) return null;
        const width = sample.width | 0, height = sample.height | 0;
        if (!(width > 1 && height > 1)) return null;
        let depthAt = null;
        try { depthAt = await withTimeout(Promise.resolve(ph.readAround(cx, cy, margin, width, height)), FAST_TIMEOUT); }
        catch (_) { return null; }
        if (typeof depthAt !== 'function') return null;
        const near = Math.max(0.001, Number(ctx.cam.nearClip) || 0.1);
        const far = Math.max(near + 0.01, Number(ctx.cam.farClip) || 1000);
        const fwd = ctx.cam.entity.forward;
        const sxr = width / cr.width, syr = height / cr.height;
        let probes = 0;
        items.forEach((it, i) => {
          if (!it) return;
          const px = Math.min(width - 1, Math.max(0, Math.round(it.x * sxr)));
          const py = Math.min(height - 1, Math.max(0, Math.round(it.y * syr)));
          const nd = sampleDepthAt(depthAt, px, py);
          if (nd === null) return;                  // 深度空洞：无法判定，保守当作可见
          const z = near + nd * (far - near);
          const { dir } = ray(ctx.cam, it.x, it.y);
          const cos = dir[0] * fwd.x + dir[1] * fwd.y + dir[2] * fwd.z;
          const sd = z / Math.max(1e-4, cos);       // 沿视线的表面距离
          probes++;
          if (sd < it.dist - bias) blocked[i] = true;
        });
        return { ready: true, blocked, probes, margin };
    })();
    try {
      const out = await withTimeout(task, FAST_TIMEOUT);
      fastFail = 0;
      return out;
    } catch (_) {
      fastFail++;
      return null;
    }
  }

  /**
   * 【贴面矩形的核心】把屏幕上框出的归一化矩形逐点深度反算成世界表面网格。
   *
   *  · rectUV 是 [u0,v0,u1,v1]（0..1，相对 canvas），与窗口分辨率无关；
   *  · 输出 (nu+1)×(nv+1) 个世界点，行优先；每个点独立取自该像素的深度，
   *    所以墙面凹凸 / 台阶 / 斜顶都会真实弯折，而不是一张悬空平面；
   *  · 结果写进注记的 surface 字段持久化，之后每帧只需重新投影这些世界点，
   *    相机移动时贴面会保持贴在模型上；
   *  · **优先走 depthGridBlock 快路径**（1 次回读）；只有旧引擎/拾取器未就绪时
   *    才退回「逐点 pick」的老路径（每点一次回读，很慢）。
   */
  async function unprojectRect(rectUV, nu = 8, nv = 8, opts = {}) {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const ctx = camera();
    if (!ctx || !Array.isArray(rectUV) || rectUV.length !== 4) return null;
    const cr = ctx.canvas.getBoundingClientRect();
    if (!cr.width || !cr.height) return null;
    const U = Math.max(1, Math.min(24, Math.round(nu)));
    const V = Math.max(1, Math.min(24, Math.round(nv)));
    let [u0, v0, u1, v1] = rectUV.map(Number);
    if (![u0, v0, u1, v1].every(Number.isFinite)) return null;
    if (u1 < u0) [u0, u1] = [u1, u0];
    if (v1 < v0) [v0, v1] = [v1, v0];
    u0 = Math.max(0, Math.min(1, u0)); u1 = Math.max(0, Math.min(1, u1));
    v0 = Math.max(0, Math.min(1, v0)); v1 = Math.max(0, Math.min(1, v1));
    if (u1 - u0 < 0.01) u1 = Math.min(1, u0 + 0.01);
    if (v1 - v0 < 0.01) v1 = Math.min(1, v0 + 0.01);
    const rect = [u0, v0, u1, v1];
    const now = () => ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);

    if (!mesh && opts.scene && !meshPromise) warmup(opts.scene);
    // ---- 快路径：一次快照 + 一次块回读 ----
    const fast = await depthGridBlock(cr, rect, U, V, ctx.cam, mesh);
    if (fast) {
      fillGridGaps(fast.points, U, V);
      const dominant = Object.keys(fast.stats).sort((a, b) => fast.stats[b] - fast.stats[a])[0] || 'free';
      return {
        rect, nu: U, nv: V, points: fast.points, source: dominant,
        samples: fast.samples, stats: fast.stats,
        readbacks: fast.readbacks, ms: Math.round(now()), fast: true,
      };
    }

    // ---- 慢路径（兼容旧引擎）：逐点 pick，每点一次 GPU 回读 ----
    const jobs = [];
    for (let j = 0; j <= V; j++) {
      for (let i = 0; i <= U; i++) {
        jobs.push({
          i, j,
          x: cr.left + (u0 + (u1 - u0) * i / U) * cr.width,
          y: cr.top + (v0 + (v1 - v0) * j / V) * cr.height,
        });
      }
    }
    const points = new Array(jobs.length).fill(null);
    const stats = {};
    const pickTimeout = Math.max(500, Number(opts.pickTimeout) || 900);
    for (let off = 0; off < jobs.length; off += 6) {
      const batch = jobs.slice(off, off + 6);
      const hits = await Promise.all(batch.map(s => depthUnproject(s.x, s.y, { pickTimeout })));
      batch.forEach((s, k) => {
        const h = hits[k];
        points[s.j * (U + 1) + s.i] = h ? h.pos : null;
        if (h) stats[h.source] = (stats[h.source] || 0) + 1;
      });
    }
    fillGridGaps(points, U, V);
    const dominant = Object.keys(stats).sort((a, b) => stats[b] - stats[a])[0] || 'free';
    return {
      rect, nu: U, nv: V, points,
      source: dominant, samples: points.length, stats,
      readbacks: jobs.length, ms: Math.round(now()), fast: false,
    };
  }

  return {
    pickAsync,
    // 兼容同步调用方：仍返回 Promise，请优先用 pickAsync
    pick: pickAsync,
    /** 深度反算：单个屏幕点 / 整块屏幕矩形 -> 世界表面（贴面矩形用） */
    depthUnproject,
    unprojectRect,
    /** 辅助线深度判断：一批世界点是否被前方表面挡住（OBB 棱 / 视锥体棱 / 旋转环用） */
    probeOcclusion,
    /** 同步落点：给「光标跟随预览」用，零等待 */
    pickSync,
    /** 吸附到最近碰撞 MESH：给「展板引线锚点拖拽」用 */
    snapToMesh,
    /** 折线贴合模型表面：动线（line）渲染用，结果与相机无关、可缓存 */
    drapePolyline,
    /** 折线贴地（深度反算版，与贴花同源、不依赖碰撞 MESH）：异步，边界同上 */
    drapePolylineDepth,
    drapeSurface,
    /** 贴面矩形网格逐点吸附 MESH 表面（decal 渲染用，可缓存） */
    drapeQuad,
    /** 逐注记深度检测：该世界点是否被前方模型挡住 */
    occluded,
    /**
     * 贴合缓存版本号：MESH 就绪 / 三角面数 / 表面高度任一变化都要重算。
     * 只比三角面数不够 —— 换模型或换 LOD 时面数可能恰好相同，表面却完全不同，
     * 那会让动线与贴面矩形继续沿用旧的吸附结果（贴在空气里）。
     * 三个固定 XZ 的垂直探针每帧只有 3 条射线，足以代表「表面变了」。
     */
    get drapeVersion() {
      if (!mesh) return 0;
      const tris = mesh.triangles?.count || 1;
      let probe = '';
      try {
        for (const [x, z] of [[0, 0], [3.25, 3.25], [-2.5, 7.75]]) {
          // 探针也要贴着人眼高度往下打，从 24m 高空只会命中屋顶
          const h = rayHitMesh(mesh, [x, 2.2, z], [0, -1, 0], 8);
          probe += (h ? h.pos[1].toFixed(2) : 'x') + ',';
        }
      } catch (_) { probe = 'err,'; }
      return tris + '|' + probe;
    },
    warmup,
    /** 开始 / 结束一次「线面展板」绘制：重置锁定平面 */
    beginStroke() { drawPlane = null; },
    endStroke() { drawPlane = null; },
    get drawPlaneLocked() { return !!drawPlane; },
    get lastSource() { return lastSource; },
    get depthReady() { listen(); return !!pickerHandle(); },
    /** 暴露引擎 Picker（供 decal-projection 取实时表面深度纹理 renderView） */
    enginePicker: () => pickerHandle(),
    get meshReady() { return !!mesh; },
    meshInfo: (scene) => meshState(scene),
    get meshTriangles() { try { return mesh?.triangles?.count || 0; } catch (_) { return 0; } },
  };
}

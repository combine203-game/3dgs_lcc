/**
 * 实时深度图 · 独立视口（两个来源，可同时开）
 * ----------------------------------------------------------------
 *   · gsplat —— 3DGS 表面深度（引擎 Picker 的 RGBA16F 深度视图，与贴花投射同源）
 *   · mesh   —— 碰撞网格深度（**CPU 光栅化**：用主相机这一帧的 proj×view
 *               把碰撞三角网格 z-buffer 光栅化，16 bit 打包进 RGBA8 上传，
 *               见 web/mesh-depth-raster.js）
 *
 * 两个视口的形态、交互、取数口径、着色映射**完全一致**，所以可以直接并排比对：
 * 同机位、同 near/far、同对数映射（近亮远暗）、无表面同为品红。差异大的地方
 * 就是「碰撞体表面」与「splat 表面」不贴合的地方（贴花投射 / 漫游贴地都吃
 * 这份几何）。
 *
 * 形态（2026-11-25 改版）：**不再整幅替换主画面**。深度渲染在自己的屏幕空间
 * 视口里 —— HTML 浮动面板，标题栏拖动移动、右下角手柄拖动缩放，视口区域对应
 * 画布上的一块矩形（uRect）。视口外的片元在 shader 里 discard，主窗口的 3DGS
 * 画面一个像素都不动。
 *
 * 为什么两个来源都走「GPU 采样叠加」，而不是「回读纹理 + 2D canvas 面板」：
 *   回读在 WebGL2 能用（Texture#read → readPixelsAsync），但在 WebGPU 上返回
 *   一整片 0 —— pick 目标纹理没有 COPY_SRC，copyTextureToBuffer 直接失败，而
 *   引擎把 WebGPU 校验错误静默吞掉，于是面板永远是纯白。采样这条路则是引擎
 *   自己在用的（贴花每帧都在 sample 同一张纹理），两个后端都稳。
 *
 * 关键约束（改动前先读）：
 *   - 视口位置每帧从 DOM 实测（body 的 getBoundingClientRect 换算成画布归一化
 *     矩形），拖动 / 缩放后必须 `renderNextFrame = true` 才会重画。
 *   - gsplat：renderView() 会把 8.8M 高斯重画一遍；mesh：CPU 光栅化整份碰撞
 *     三角网格再 upload（毫秒级，实测记在 state().rasterMs）。两者都按
 *     PICK_INTERVAL 节流；相机静止时仍保留上一张纹理，画面不会闪。
 *   - mesh 为什么不用引擎离屏通道：自建 Layer + 自建相机在这个构建里只清屏不
 *     提交 draw（贴花 Pass1 同坑），深度图整片空；CPU 光栅化则完全确定，
 *     两个后端、任何纹理分辨率都一致，也才有可能和 3DGS 深度逐像素对齐。
 *   - 两个 pass 都会改脏设备状态，frameend 里必须 `app.renderNextFrame = true`，
 *     否则主画面会黑一帧甚至停住。
 *   - 视口区域的 DOM 一律 pointer-events:none：主画面的旋转 / 漫游手势可以
 *     穿过深度视口继续用，只有标题栏和缩放手柄吃指针。
 *
 *   const dv = initDepthView({ getViewer: () => window.__viewer })
 *   dv.toggle() / open() / close() / setRange(m) / state() / viewport()
 *   dv.mesh  // 碰撞 Mesh 深度视口的同一套 API
 *   window.__mgDepth / window.__mgMeshDepth  // 供 CDP / 控制台回归读取
 */
import { resolveEngineAdapter } from './engine/index.js';
import { RENDER_HOOKS } from './engine/engine-adapter.js';
import {
  DEPTH_VIEW_VERTEX_GLSL, DEPTH_VIEW_VERTEX_WGSL,
  DEPTH_VIEW_FRAGMENT_GLSL, DEPTH_VIEW_FRAGMENT_WGSL
} from './engine/depth-shaders.js';
/* 碰撞 mesh 的 SoA triangles → flat 三角网格，与贴花 Pass1 共用同一份转换
   （同一份几何、同一个坐标系：Y-up 米制世界，不需要再做轴变换）。 */
import { flatCollisionTriangles } from './editor/decal-projection.js';
import { createRaster, rasterize } from './mesh-depth-raster.js';

const PICK_INTERVAL = 250;        // ms：深度快照刷新节流（4 fps 足够看结构）
const RANGE_NEAR = 1.0;           // m：对数映射下限（小于 1 m 的一律当最近）
const RANGES = [15, 30, 60, 120]; // m：可切换的映射上限（默认 30 m，室内层次最清楚）
const EMPTY_RGB = '#c7008c';      // 品红：无表面（与引擎 PickDepthOverlay 同约定）
const MIN_W = 240;                // px：视口最小宽度
const MIN_H = 170;                // px：视口最小高度
const GEO_CHECK_MS = 600;         // ms：碰撞体是否换了的检查间隔（引用比较，很便宜）

const PANELS = {
  gsplat: {
    mode: 0,
    ids: {
      box: 'mg-depthbox', body: 'mg-depth-body', drag: 'mg-depth-drag', grip: 'mg-depth-grip',
      legend: 'mg-depth-canvas', stat: 'mg-depth-stat', range: 'mg-depth-range',
      rangeBtn: 'mg-depth-range-btn', close: 'mg-depth-close',
      btn: 'mg-depth', state: 'mg-depth-state'
    }
  },
  mesh: {
    mode: 1,
    ids: {
      box: 'mg-meshbox', body: 'mg-mesh-body', drag: 'mg-mesh-drag', grip: 'mg-mesh-grip',
      legend: 'mg-mesh-canvas', stat: 'mg-mesh-stat', range: 'mg-mesh-range',
      rangeBtn: 'mg-mesh-range-btn', close: 'mg-mesh-close',
      btn: 'mg-mesh', state: 'mg-mesh-state'
    }
  }
};

export function initDepthView({ getViewer } = {}) {
  const viewerOf = () => {
    try {
      const v = typeof getViewer === 'function' ? getViewer() : null;
      return v && v.app ? v : null;
    } catch (_) { return null; }
  };
  const pickerOf = (v) => {
    try {
      const p = typeof v.picker === 'function' ? v.picker() : v.picker;
      return p && typeof p.renderView === 'function' ? p : null;
    } catch (_) { return null; }
  };

  const v0 = viewerOf();
  if (!v0) return null;

  let adapter = null;
  try {
    adapter = resolveEngineAdapter({
      getApp: () => viewerOf()?.app || null,
      getCameraEntity: () => {
        const cam = viewerOf()?.app?.root?.findComponent?.('camera');
        return cam?.entity || null;
      },
      getPickView: () => {
        const v = viewerOf();
        const p = v && pickerOf(v);
        const pv = p && p.renderView();
        return pv && pv.texture ? pv : null;
      }
    });
  } catch (err) {
    console.warn('[depth-view] 引擎适配器初始化失败：', err);
  }

  /* 调试口：诊断脚本 / 控制台要能直接看适配器能力（不参与渲染逻辑） */
  window.__mgDepthAdapter = adapter;

  const gsplat = createPanel('gsplat');
  const mesh = createPanel('mesh');
  if (!gsplat) return null;

  /* 兼容旧接口：window.__mgDepth 仍是 3DGS 视口，额外挂 .mesh 指向第二个视口。
     注意不能 `{ ...gsplat.api }`：isOpen / supported 是 getter，展开会变成常量快照。 */
  const api = {
    open: gsplat.api.open,
    close: gsplat.api.close,
    toggle: gsplat.api.toggle,
    setRange: gsplat.api.setRange,
    state: gsplat.api.state,
    viewport: gsplat.api.viewport,
    get isOpen() { return gsplat.api.isOpen; },
    get supported() { return gsplat.api.supported; },
    source: 'gsplat',
    mesh: mesh ? mesh.api : null
  };
  window.__mgDepth = api;
  window.__mgMeshDepth = mesh ? mesh.api : null;
  return api;

  /* ------------------------------------------------------------------ 面板 */
  function createPanel(kind) {
    const cfg = PANELS[kind];
    if (!cfg) return null;
    const id = cfg.ids;
    const box = document.getElementById(id.box);
    const bodyEl = document.getElementById(id.body);
    const dragEl = document.getElementById(id.drag);
    const gripEl = document.getElementById(id.grip);
    const legend = document.getElementById(id.legend);
    const statEl = document.getElementById(id.stat);
    const rangeEl = document.getElementById(id.range);
    const rangeBtn = document.getElementById(id.rangeBtn);
    const closeBtn = document.getElementById(id.close);
    const headBtn = document.getElementById(id.btn);
    const stateEl = document.getElementById(id.state);
    const stageEl = document.getElementById('mg-stage');
    if (!box || !bodyEl) return null;

    /* 3DGS 主画布：PlayCanvas 在 #mg-stage 里异步插入，每次现查（不缓存） */
    const sceneCanvas = () => {
      const c = stageEl && stageEl.querySelector('canvas');
      return c && c.getBoundingClientRect ? c : null;
    };

    const isMesh = kind === 'mesh';
    const state = {
      open: false, ready: false, pickReady: false, pickSize: [0, 0],
      picks: 0, renders: 0, errors: 0, lastError: null,
      rangeFar: RANGES[1], backend: '', supported: false,
      source: kind, mode: cfg.mode,
      rect: [0, 0, 0, 0],           // 视口在画布上的归一化矩形（左上原点）
      rectPx: [0, 0, 0, 0],         // 视口物理像素 [x, y, w, h]
      sizeCss: [0, 0],              // 视口 CSS 像素 [w, h]
      tris: 0,                      // 碰撞 mesh 三角形数（mesh 视口）
      meshReady: false,             // 碰撞几何已转换好（mesh 视口）
      rasterSize: [0, 0],           // CPU 光栅化纹理尺寸
      rasterMs: 0,                  // 最近一次光栅化耗时（ms）
      rasterTris: 0                 // 最近一次真正画进纹理的三角形数
    };

    /* -------------------------------------------------- 视口矩形（每帧实测）
       归一化到画布：拖动 / 缩放后由 onPrerender 直接读到新值，不需要额外同步。 */
    function measureRect() {
      const cnv = sceneCanvas();
      if (!cnv) return null;
      const cr = cnv.getBoundingClientRect();
      const br = bodyEl.getBoundingClientRect();
      if (cr.width < 8 || cr.height < 8 || br.width < 4 || br.height < 4) return null;
      const rs = (adapter && adapter.getRenderSize()) || [cr.width, cr.height];
      const kx = cr.width ? rs[0] / cr.width : 1;
      const ky = cr.height ? rs[1] / cr.height : 1;
      const nx = (br.left - cr.left) / cr.width;
      const ny = (br.top - cr.top) / cr.height;
      const nw = br.width / cr.width;
      const nh = br.height / cr.height;
      return {
        rect: [nx, ny, nw, nh],
        rectPx: [
          Math.round((br.left - cr.left) * kx), Math.round((br.top - cr.top) * ky),
          Math.round(br.width * kx), Math.round(br.height * ky)
        ],
        sizeCss: [Math.round(br.width), Math.round(br.height)]
      };
    }

    function requestRepaint() {
      const v = viewerOf();
      if (v) v.app.renderNextFrame = true;
    }

    /* ---------------------------------------------------------- 图例卡
       没有回读就没有实时数值，这里画一条对数色标 + 区间刻度，标出「近=白」。 */
    function drawLegend() {
      if (!legend) return;
      const cssW = Math.max(80, legend.clientWidth || 240);
      const cssH = Math.max(20, legend.clientHeight || 30);
      if (legend.width !== cssW) legend.width = cssW;
      if (legend.height !== cssH) legend.height = cssH;
      const ctx = legend.getContext('2d');
      if (!ctx) return;
      const w = legend.width, h = legend.height;
      ctx.clearRect(0, 0, w, h);

      const chip = 12;
      const barY = Math.round(h * 0.42), barH = Math.max(8, h - barY - 2);
      const barW = Math.max(10, w - chip - 6);
      const grad = ctx.createLinearGradient(2, 0, 2 + barW, 0);
      for (let i = 0; i <= 10; i++) {
        const t = i / 10;
        const g = Math.round(255 * (1 - t));
        grad.addColorStop(t, `rgb(${g},${g},${g})`);
      }
      ctx.fillStyle = grad;
      ctx.fillRect(2, barY, barW, barH);
      ctx.fillStyle = EMPTY_RGB;
      ctx.fillRect(w - chip - 2, barY, chip, barH);

      ctx.fillStyle = '#9fbfe8';
      ctx.font = `${Math.min(10, Math.max(8, Math.round(h * 0.3)))}px Consolas, monospace`;
      ctx.textBaseline = 'top';
      ctx.fillText(`近 ${RANGE_NEAR} m`, 2, 0);
      const farLabel = `远 ${state.rangeFar} m`;
      ctx.fillText(farLabel, w - ctx.measureText(farLabel).width - chip - 6, 0);
    }

    /* ------------------------------------------------------------ GPU 叠加层 */
    const quad = adapter && adapter.isReady() ? adapter.createFullscreenQuad() : null;
    const material = quad ? adapter.createShaderMaterial({
      name: isMesh ? 'MeshDepthViewOverlay' : 'DepthViewOverlay',
      vertexGLSL: DEPTH_VIEW_VERTEX_GLSL, vertexWGSL: DEPTH_VIEW_VERTEX_WGSL,
      fragmentGLSL: DEPTH_VIEW_FRAGMENT_GLSL, fragmentWGSL: DEPTH_VIEW_FRAGMENT_WGSL
    }) : null;
    let renderable = null;
    const isWebGPU = adapter && adapter.getBackendType
      ? adapter.getBackendType() === 'webgpu' : false;
    const UV_SIGN_Y = isWebGPU ? 1 : -1;
    const UV_OFFSET_Y = isWebGPU ? 0 : 1;
    const PICK_FLIP_Y = isWebGPU ? 1 : 0;
    /* mesh 视口靠「数据纹理 + 主相机 ViewProj」自算深度，缺任一能力就禁用按钮，
       而不是静默不出图 */
    const meshCapable = !isMesh || !!(adapter
      && typeof adapter.createDataTexture === 'function'
      && typeof adapter.updateDataTexture === 'function'
      && typeof adapter.getCameraViewProjection === 'function');

    if (material && quad && meshCapable) {
      adapter.setMaterialBlendState(material, {
        blend: 'none', depthTest: false, depthWrite: false, cull: false
      });
      // 视口矩形还没量出来之前先别画（shader 会当成 0 面积整片 discard）
      adapter.setMaterialParameter(material, 'uPickReady', 0);
      adapter.setMaterialParameter(material, 'uRect', [0, 0, 0, 0]);
      adapter.setMaterialParameter(material, 'uMode', cfg.mode);
      renderable = adapter.createRenderable(quad.mesh, material, quad.node);
      if (renderable) {
        adapter.setRenderableFlags(renderable, {
          castShadow: false, receiveShadow: false, pick: false, cull: false
        });
        adapter.setRenderableVisible(renderable, false);
        adapter.addRenderable(renderable);
        state.supported = true;
        state.backend = isWebGPU ? 'webgpu' : 'webgl';
      }
    }
    if (!state.supported) {
      console.warn('[depth-view] ' + kind + ' 深度视口不可用（叠加层或数据纹理能力缺失），功能已禁用');
    }

    let tex = null;               // 当前采样的深度纹理句柄
    let texSize = null;           // [w, h]
    let texReady = false;
    let lastSync = 0;
    let lastCol = null;            // mesh：当前几何对应的碰撞体引用
    let lastGeoCheck = 0;
    let geo = null;                // mesh：flat 三角网格（{positions, indices}）
    let rast = null;               // mesh：CPU 光栅化的复用帧缓冲
    let rasterGeo = null;          // mesh：上一张纹理对应的几何引用
    let rasterView = null;         // mesh：上一张纹理对应的 ViewProj + near/far（18 float）

    /** 机位与裁剪面都没变（Float32Array 逐项比对，18 次比较，可忽略） */
    function sameView(vp, nf) {
      if (!rasterView) return false;
      for (let i = 0; i < 16; i++) if (vp[i] !== rasterView[i]) return false;
      return nf[0] === rasterView[16] && nf[1] === rasterView[17];
    }

    /* ------------------------------------------------- mesh 深度纹理管理
       纹理尺寸只跟画布比例挂钩（面板怎么拖都不重建，shader 里 contain 信箱），
       一半分辨率足够：像素级对齐靠的是同一份 ViewProj，不是分辨率。 */
    function ensureMeshTexture() {
      if (!isMesh) return null;
      if (tex) return tex;
      if (!adapter || typeof adapter.createDataTexture !== 'function') return null;
      const rs = adapter.getRenderSize();
      const cw = Math.max(64, rs[0] || 1280);
      const ch = Math.max(64, rs[1] || 720);
      const w = Math.max(64, Math.min(1024, Math.round(cw * 0.5)));
      const h = Math.max(48, Math.round(w * ch / cw));
      try {
        rast = createRaster(w, h);
        tex = adapter.createDataTexture({
          name: 'mesh-depth-rgba8', width: w, height: h, format: 'rgba8', filter: 'nearest'
        });
      } catch (err) {
        tex = null;
        rast = null;
        state.errors++;
        state.lastError = String((err && err.message) || err);
      }
      if (!tex) {
        if (statEl) statEl.textContent = '深度数据纹理创建失败（后端不支持 RGBA8 数据纹理）';
        return null;
      }
      texSize = [w, h];
      state.rasterSize = [w, h];
      window.__mgMeshDepthTex = tex;   // 调试口：诊断脚本用来确认纹理句柄
      return tex;
    }

    /** 碰撞体换了（切场景 / 首次就绪）才重新转几何，几十万三角形不能每帧转 */
    function syncMeshGeometry(v) {
      if (!isMesh) return;
      const now = performance.now();
      if (now - lastGeoCheck < GEO_CHECK_MS) return;
      lastGeoCheck = now;
      let col = null;
      try { col = typeof v.collision === 'function' ? v.collision() : null; } catch (_) { col = null; }
      if (!col || col === lastCol) return;
      const tris = flatCollisionTriangles(col);
      if (!tris) return;
      lastCol = col;
      geo = tris;
      state.tris = Math.round(tris.indices.length / 3);
      state.meshReady = true;
      texReady = false;
      state.pickReady = false;
      if (statEl) statEl.textContent = `碰撞三角 ${state.tris.toLocaleString()} · 光栅化中…`;
      requestRepaint();
    }

    function refreshTexture(v) {
      if (!isMesh) {
        /* 3DGS：Picker 的深度视图（RGBA16F，4 通道随机试验） */
        const p = pickerOf(v);
        const pv = p && p.renderView();
        const t = pv && pv.texture;
        if (!t) return false;
        tex = t;
        texSize = [t.width | 0, t.height | 0];
        texReady = true;
        state.pickReady = true;
        state.pickSize = texSize;
        state.picks++;
        state.ready = true;
        if (statEl) {
          statEl.textContent = `深度快照 ${texSize[0]}×${texSize[1]} · `
            + `${(1000 / PICK_INTERVAL).toFixed(0)} 次/秒`;
        }
        return true;
      }
      /* 碰撞 mesh：主相机这一帧的 proj×view + 碰撞三角 → CPU 光栅化 → 上传 */
      const t = ensureMeshTexture();
      if (!t || !geo || !rast) return false;
      const vp = adapter.getCameraViewProjection();
      if (!vp) return false;
      const nf = adapter.getCameraNearFar();
      /* 机位没动就复用上一张（光栅化是主线程活，静止时不该每 250 ms 花几十毫秒） */
      if (texReady && geo === rasterGeo && sameView(vp, nf)) return true;
      const t0 = performance.now();
      const rgba = rasterize(rast, geo, vp, nf[0], nf[1]);
      adapter.updateDataTexture(t, rgba);
      state.rasterMs = +(performance.now() - t0).toFixed(1);
      state.rasterTris = rast.drawn;
      rasterGeo = geo;
      if (!rasterView) rasterView = new Float32Array(18);
      rasterView.set(vp, 0);
      rasterView[16] = nf[0];
      rasterView[17] = nf[1];
      texReady = true;
      state.pickReady = true;
      state.pickSize = texSize;
      state.picks++;
      state.ready = true;
      if (statEl && !state.errors) {
        statEl.textContent = `碰撞三角 ${state.rasterTris.toLocaleString()} · `
          + `${texSize[0]}×${texSize[1]} · 光栅 ${state.rasterMs.toFixed(1)} ms`;
      }
      return true;
    }

    function onFrameEnd() {
      const v = viewerOf();
      if (!v || !state.open) return;
      if (isMesh) {
        if (!ensureMeshTexture()) { v.app.renderNextFrame = true; return; }
        syncMeshGeometry(v);
      }
      const now = performance.now();
      if (now - lastSync >= PICK_INTERVAL) {
        try {
          refreshTexture(v);
        } catch (err) {
          state.errors++;
          state.lastError = String((err && err.message) || err);
          if (state.errors === 1) console.warn('[depth-view] ' + kind + ' 深度刷新失败：', state.lastError);
        }
        lastSync = now;
      }
      // 纹理上传 / pick pass 都会改脏设备状态：必须显式要求下一帧重画主画面
      v.app.renderNextFrame = true;
    }

    /* 每帧把视口矩形喂给 shader。视口外靠 shader 的 discard 保持主画面不变，
       几何仍是屏幕四边形（不引入引擎级 viewport / scissor，双后端都一致）。 */
    function onPrerender() {
      if (!state.open || !renderable || !material) return;
      const v = viewerOf();
      if (!v) return;
      const m = measureRect();
      if (!m) {
        adapter.setRenderableVisible(renderable, false);
        return;
      }
      try {
        const setP = (k, val) => adapter.setMaterialParameter(material, k, val);
        state.rect = m.rect;
        state.rectPx = m.rectPx;
        state.sizeCss = m.sizeCss;
        setP('pickDepth', tex);
        setP('uPickSize', texSize || [1, 1]);
        setP('uPickReady', texReady ? 1 : 0);
        setP('uMode', cfg.mode);
        setP('uResolution', adapter.getRenderSize());
        setP('uRect', m.rect);
        setP('uUVSignY', UV_SIGN_Y);
        setP('uUVOffsetY', UV_OFFSET_Y);
        setP('uPickFlipY', PICK_FLIP_Y);
        const nf = adapter.getCameraNearFar();
        setP('nearClip', nf[0]);
        setP('farClip', nf[1]);
        setP('uRangeNear', RANGE_NEAR);
        setP('uRangeFar', state.rangeFar);
        adapter.setRenderableVisible(renderable, true);
        state.renders++;
      } catch (err) {
        state.errors++;
        state.lastError = String((err && err.message) || err);
      }
    }

    function hook(on) {
      if (!state.supported) return;
      adapter.removeRenderHook(RENDER_HOOKS.AFTER_RENDER, onFrameEnd);
      adapter.removeRenderHook(RENDER_HOOKS.BEFORE_RENDER, onPrerender);
      if (!on) return;
      adapter.addRenderHook(RENDER_HOOKS.AFTER_RENDER, onFrameEnd);
      adapter.addRenderHook(RENDER_HOOKS.BEFORE_RENDER, onPrerender);
    }

    function setOpen(next) {
      const want = !!next && state.supported;
      state.open = want;
      box.hidden = !want;
      if (stateEl) stateEl.textContent = want ? '开' : '关';
      if (headBtn) {
        headBtn.classList.toggle('mg-on', want);
        headBtn.disabled = !state.supported;
        headBtn.title = state.supported
          ? (isMesh ? '碰撞 Mesh 深度视口（与 3DGS 深度对比）' : '实时深度图视口（N）')
          : '当前设备/后端不支持深度图';
      }
      if (want) {
        texReady = false;
        state.pickReady = false;
        lastSync = 0;
        if (isMesh && ensureMeshTexture()) syncMeshGeometry(viewerOf() || {});
        if (statEl) statEl.textContent = isMesh ? '碰撞几何准备中…' : '深度快照准备中…';
        if (rangeEl) rangeEl.textContent = `区间 ${RANGE_NEAR} → ${state.rangeFar} m`;
        drawLegend();
        hook(true);
        requestRepaint();
      } else {
        hook(false);
        if (renderable) adapter.setRenderableVisible(renderable, false);
        // 立即要求重画：否则关闭后要等下一次相机交互深度视口才消失
        requestRepaint();
      }
      return want;
    }

    function setRange(idxOrMeters) {
      let next;
      if (typeof idxOrMeters === 'number' && RANGES.includes(idxOrMeters)) next = idxOrMeters;
      else next = RANGES[(RANGES.indexOf(state.rangeFar) + 1) % RANGES.length];
      state.rangeFar = next;
      if (rangeBtn) rangeBtn.textContent = next + ' m';
      if (rangeEl) rangeEl.textContent = `区间 ${RANGE_NEAR} → ${next} m`;
      drawLegend();
      requestRepaint();
      return next;
    }

    /* --------------------------------------------------- 拖动移动 / 拖动缩放
       统一在 pointerdown 时把 right/bottom 定位改成 left/top 绝对定位，
       之后拖动只改 left/top（移动）或 width/height（缩放），并夹在 #mg-stage 内。 */
    function clampLimits() {
      const host = box.offsetParent || stageEl || document.body;
      const pr = host.getBoundingClientRect();
      const sr = (stageEl || host).getBoundingClientRect();
      const w = box.offsetWidth, h = box.offsetHeight;
      const minL = sr.left - pr.left + 4;
      const minT = sr.top - pr.top + 4;
      return {
        minL, minT,
        maxL: Math.max(minL, sr.right - pr.left - w - 4),
        maxT: Math.max(minT, sr.bottom - pr.top - h - 4),
        maxW: Math.max(MIN_W, sr.width - 8),
        maxH: Math.max(MIN_H, sr.height - 8)
      };
    }

    function bindPointer(handle, mode) {
      if (!handle) return;
      let drag = null;
      handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if (e.target && e.target.closest && e.target.closest('button')) return;
        const host = box.offsetParent || stageEl || document.body;
        const pr = host.getBoundingClientRect();
        const br = box.getBoundingClientRect();
        drag = {
          sx: e.clientX, sy: e.clientY,
          left: br.left - pr.left, top: br.top - pr.top,
          w: br.width, h: br.height
        };
        box.style.left = drag.left + 'px';
        box.style.top = drag.top + 'px';
        box.style.width = Math.round(drag.w) + 'px';
        box.style.height = Math.round(drag.h) + 'px';
        box.style.right = 'auto';
        box.style.bottom = 'auto';
        try { handle.setPointerCapture(e.pointerId); } catch (_) { /* noop */ }
        e.preventDefault();
        e.stopPropagation();
      });
      handle.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
        const lim = clampLimits();
        if (mode === 'move') {
          const left = Math.min(lim.maxL, Math.max(lim.minL, drag.left + dx));
          const top = Math.min(lim.maxT, Math.max(lim.minT, drag.top + dy));
          box.style.left = Math.round(left) + 'px';
          box.style.top = Math.round(top) + 'px';
        } else {
          const w = Math.min(lim.maxW, Math.max(MIN_W, drag.w + dx));
          const h = Math.min(lim.maxH, Math.max(MIN_H, drag.h + dy));
          box.style.width = Math.round(w) + 'px';
          box.style.height = Math.round(h) + 'px';
          drawLegend();
        }
        requestRepaint();
        e.preventDefault();
      });
      const end = (e) => {
        if (!drag) return;
        drag = null;
        try { handle.releasePointerCapture(e.pointerId); } catch (_) { /* noop */ }
        drawLegend();
        requestRepaint();
      };
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    }
    bindPointer(dragEl, 'move');
    bindPointer(gripEl, 'resize');

    rangeBtn?.addEventListener('click', () => setRange());
    closeBtn?.addEventListener('click', () => setOpen(false));
    /* 侧栏 / 字体变化会改面板尺寸，图例跟着重画 */
    if (legend && typeof ResizeObserver === 'function') {
      try { new ResizeObserver(() => drawLegend()).observe(legend); } catch (_) { /* noop */ }
    }
    box.hidden = true;
    if (rangeBtn) rangeBtn.textContent = RANGES[1] + ' m';
    drawLegend();

    const api = {
      open: () => setOpen(true),
      close: () => setOpen(false),
      toggle: () => setOpen(!state.open),
      get isOpen() { return state.open; },
      setRange,
      state: () => ({ ...state, rangeNear: RANGE_NEAR }),
      /* 视口在页面上的 CSS 矩形（诊断脚本据此只统计深度视口内的像素） */
      viewport: () => {
        const r = bodyEl.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
      },
      supported: state.supported,
      source: kind
    };
    return { api, state };
  }
}

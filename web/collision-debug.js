/**
 * 碰撞体可视化调试（工具栏）。
 *
 * 两种可视化，互相印证：
 *   1) 碰撞网格线框：引擎自带 MeshDebugOverlay，画的是真正参与物理查询的
 *      三角形，由 viewer.state.collisionOverlayEnabled 控制。
 *   2) 分块包围盒：collision-manifest.json 的 parts[].bound（官方米制 Z-up
 *      AABB），用 app.scene.immediate.drawWireAlignedBox 逐帧画线。
 *
 * 分块包围盒提供两套坐标系对照，用来定位「碰撞体盒子看着不对」：
 *   meter = 当前生效：只把官方米制 Z-up 转成 PlayCanvas Y-up
 *           （world = (x, z, -y)），与 3DGS / 出生点 / 漫游路径同尺度；
 *   log   = 2026-11-09 之前的旧变换 (logc(x), logc(z), -logc(y))，
 *           会把碰撞体压到 ±4。仅保留作历史对照，不应再命中相机。
 * 默认画 meter；若相机只落在 log 盒子里，说明碰撞数据仍是旧的压缩版本。
 */
const logc = (v) => Math.sign(v) * Math.log1p(Math.abs(v));
const $ = (id) => document.getElementById(id);

const PALETTE = [
  { r: 1, g: 0.36, b: 0.36, a: 1 }, { r: 1, g: 0.72, b: 0.28, a: 1 },
  { r: 0.55, g: 1, b: 0.40, a: 1 }, { r: 0.30, g: 0.88, b: 1, a: 1 },
  { r: 0.55, g: 0.62, b: 1, a: 1 }, { r: 1, g: 0.46, b: 0.90, a: 1 },
  { r: 0.92, g: 0.92, b: 0.32, a: 1 }, { r: 0.38, g: 1, b: 0.80, a: 1 }
];
const HIT_COLOR = { r: 0.20, g: 1, b: 0.30, a: 1 };
const AXIS_COLOR = { r: 1, g: 1, b: 1, a: 1 };

function boxFromBound(bound, mode) {
  const { min, max } = bound;
  if (mode === 'meter') {
    // 米制 Z-up -> Y-up，仅轴变换：world = (x, z, -y)
    return {
      min: { x: min[0], y: min[2], z: -max[1] },
      max: { x: max[0], y: max[2], z: -min[1] }
    };
  }
  // 旧版 lcc2-collision.js 的 log 压缩：world = (logc(x), logc(z), -logc(y))
  // 现在只用于历史对照，碰撞网格已改为上面的 meter 变换。
  return {
    min: { x: logc(min[0]), y: logc(min[2]), z: -logc(max[1]) },
    max: { x: logc(max[0]), y: logc(max[2]), z: -logc(min[1]) }
  };
}

const inside = (b, p) => p &&
  p[0] >= b.min.x && p[0] <= b.max.x &&
  p[1] >= b.min.y && p[1] <= b.max.y &&
  p[2] >= b.min.z && p[2] <= b.max.z;

function union(boxes) {
  if (!boxes.length) return null;
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const b of boxes) {
    for (const k of ['x', 'y', 'z']) {
      min[k] = Math.min(min[k], b.min[k]);
      max[k] = Math.max(max[k], b.max[k]);
    }
  }
  return { min, max };
}

const fmtB = (b) => b
  ? '[' + [b.min.x, b.min.y, b.min.z].map((v) => v.toFixed(3)).join(', ') + '] → [' +
    [b.max.x, b.max.y, b.max.z].map((v) => v.toFixed(3)).join(', ') + ']'
  : '—';
const fmtP = (p) => p ? '[' + p.map((v) => v.toFixed(3)).join(', ') + ']' : '相机未就绪';

export function initCollisionDebug(viewer, manifestUrl) {
  const state = {
    boxes: false,      // 分块包围盒线框
    mode: 'meter',     // 'meter'(当前生效) | 'log'(旧压缩，仅对照)
    xray: true,        // true = 不做深度测试，盒子始终可见
    parts: [],         // [{file, box:{log, meter}, bvhNodes}]
    error: null
  };

  const cameraPos = () => {
    const cam = viewer.app?.root?.findComponent('camera');
    if (!cam?.entity) return null;
    const e = cam.entity.getPosition();
    return [e.x, e.y, e.z];
  };

  /* ---------- 每帧画分块 AABB ---------- */
  const onPreRender = () => {
    if (!state.boxes || !state.parts.length) return;
    const scene = viewer.app.scene;
    const layer = scene.defaultDrawLayer;
    if (!layer) return;
    const depthTest = !state.xray;
    const p = cameraPos();
    for (let i = 0; i < state.parts.length; i++) {
      const b = state.parts[i].box[state.mode];
      const color = inside(b, p) ? HIT_COLOR : PALETTE[i % PALETTE.length];
      scene.immediate.drawWireAlignedBox(b.min, b.max, color, depthTest, layer);
    }
    // 相机位置画一个小盒子，便于判断「我在哪个盒子里」
    if (p) {
      const s = state.mode === 'meter' ? 0.5 : 0.08;
      scene.immediate.drawWireAlignedBox(
        { x: p[0] - s, y: p[1] - s, z: p[2] - s },
        { x: p[0] + s, y: p[1] + s, z: p[2] + s },
        AXIS_COLOR, depthTest, layer);
    }
  };
  viewer.app.scene.on('prerender', onPreRender);

  /* ---------- 诊断信息 ---------- */
  function diagnose() {
    const p = cameraPos();
    const logBoxes = state.parts.map((r) => r.box.log);
    const meterBoxes = state.parts.map((r) => r.box.meter);
    const hitLog = logBoxes.filter((b) => inside(b, p)).length;
    const hitMeter = meterBoxes.filter((b) => inside(b, p)).length;
    const ci = window.__mgCollisionInfo;
    const st = viewer.state;
    const lines = [
      '分块 ' + state.parts.length + ' · 三角形 ' + (ci?.tris ?? '—') +
        ' · 顶点 ' + (ci?.nv ?? '—') + ' · 载入 ' + (ci?.ms ?? '—') + ' ms',
      '碰撞空间: ' + (ci?.space ?? '未知') +
        ' · 胶囊高: ' + (globalThis.__MG_WALK?.capsuleHeight ?? '—') + ' m',
      '碰撞状态: hasCollision=' + !!st?.hasCollision +
        '  walkAllowed=' + !!st?.walkAllowed +
        '  overlay=' + !!st?.hasCollisionOverlay,
      '',
      '碰撞网格(米制 Y-up, 当前生效)',
      '  ' + fmtB(union(meterBoxes)),
      '旧 log 压缩(已废弃, 仅对照)',
      '  ' + fmtB(union(logBoxes)),
      '',
      '相机 ' + fmtP(p),
      '命中盒子: meter=' + hitMeter + ' · log=' + hitLog,
      ''
    ];
    // 原点附近 log 盒子也会包住相机，不能只靠 hitLog 判断；以运行时
    // 碰撞空间标记为准（lcc2-collision.js 加载完成后写入 __mgCollisionInfo）。
    const meterSpace = !!ci?.space?.startsWith?.('meter');
    if (!state.parts.length) {
      lines.push(state.error || '碰撞清单尚未载入');
    } else if (hitMeter > 0 && meterSpace) {
      lines.push('✓ 相机落在 ' + hitMeter + ' 个米制盒子内（绿色高亮），');
      lines.push('  碰撞网格与 3DGS / 出生点已在同一坐标系。');
    } else if (hitMeter === 0 && hitLog > 0) {
      lines.push('⚠ 相机只落在旧 log 压缩盒子里：碰撞数据仍是压缩版本，');
      lines.push('  与米制 3DGS 错位，请检查 lcc2-collision.js。');
    } else if (hitMeter > 0) {
      lines.push('相机位于 ' + hitMeter + ' 个米制盒子内（绿色高亮）。');
    } else {
      lines.push('相机不在任何分块包围盒内：可能在室外，或仍有偏移。');
    }
    return lines.join('\n');
  }

  function refresh() {
    const el = $('mg-col-info');
    if (el) el.textContent = diagnose();
    // 同步引擎自带 overlay 按钮（V 键也会改这个状态）
    const meshBtn = $('mg-col-mesh');
    if (meshBtn) {
      const on = !!viewer.state.collisionOverlayEnabled;
      meshBtn.textContent = '碰撞网格 ' + (on ? '开' : '关');
      meshBtn.classList.toggle('mg-on', on);
    }
    const boxBtn = $('mg-col-boxes');
    if (boxBtn) {
      boxBtn.textContent = '分块包围盒 ' + (state.boxes ? '开' : '关');
      boxBtn.classList.toggle('mg-on', state.boxes);
    }
    const modeSel = $('mg-col-mode');
    if (modeSel) modeSel.value = state.mode;
    const xray = $('mg-col-xray');
    if (xray) xray.checked = state.xray;
  }

  function repaint() {
    viewer.app.renderNextFrame = true;
    refresh();
  }

  function setMeshOverlay(on) {
    // 碰撞体是异步加载的；attachCollision 注册监听之后赋值才会驱动 overlay
    if (on && !viewer.state.hasCollisionOverlay) {
      let tries = 0;
      const t = setInterval(() => {
        if (viewer.state.hasCollisionOverlay || ++tries > 40) {
          clearInterval(t);
          viewer.state.collisionOverlayEnabled = !!on;
          repaint();
        }
      }, 250);
      return;
    }
    viewer.state.collisionOverlayEnabled = !!on;
    repaint();
  }

  /* ---------- UI ---------- */
  $('mg-col-mesh')?.addEventListener('click', () =>
    setMeshOverlay(!viewer.state.collisionOverlayEnabled));
  $('mg-col-boxes')?.addEventListener('click', () => {
    state.boxes = !state.boxes;
    repaint();
  });
  $('mg-col-mode')?.addEventListener('change', (e) => {
    state.mode = e.target.value === 'meter' ? 'meter' : 'log';
    repaint();
  });
  $('mg-col-xray')?.addEventListener('change', (e) => {
    state.xray = !!e.target.checked;
    repaint();
  });
  $('mg-col-refresh')?.addEventListener('click', refresh);
  viewer.events?.on('collisionOverlayEnabled:changed', refresh);

  // CDP / 控制台调试接口
  const api = {
    getState: () => ({ ...state, parts: state.parts.length }),
    diagnose,
    refresh,
    setBoxes: (on) => { state.boxes = !!on; repaint(); },
    setMode: (m) => { state.mode = m === 'meter' ? 'meter' : 'log'; repaint(); },
    setMeshOverlay,
    boxes: () => state.parts.map((r, i) => ({
      i, file: r.file, bvhNodes: r.bvhNodes,
      log: r.box.log, meter: r.box.meter
    }))
  };
  window.__mgCollisionDebug = api;
  refresh();

  // 清单与碰撞网格各自异步加载，加载完再刷一次诊断
  (async () => {
    try {
      const resp = await fetch(manifestUrl);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const m = await resp.json();
      state.parts = (m.parts || []).map((p) => ({
        file: p.ply,
        bvhNodes: p.bvhNodes ?? null,
        box: { log: boxFromBound(p.bound, 'log'), meter: boxFromBound(p.bound, 'meter') }
      }));
      refresh();
    } catch (e) {
      state.error = '碰撞清单载入失败: ' + String(e?.message ?? e);
      refresh();
    }
  })();
  const poll = setInterval(() => {
    if (window.__mgCollisionInfo) {
      clearInterval(poll);
      refresh();
    }
  }, 500);
  setTimeout(() => clearInterval(poll), 30000);

  return api;
}

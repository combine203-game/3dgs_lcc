/**
 * human-layer.js — 把「MotionBricks 驱动的 3DGS 数字人」叠进现有 3DGS 场景。
 *
 * 形态（见 docs/DECISIONS.md D1）：同页第二个渲染上下文。
 *   · 现有 PlayCanvas(WebGL2) 渲染 SOG 场景，画面保持不动；
 *   · 本模块建一个透明 canvas 覆盖其上（pointer-events:none），用 three.js 渲染
 *     高斯化身；
 *   · 每帧从 window.__viewer 读相机实体位姿 / fov，写入 three 相机 —— 两套渲染
 *     共享同一个世界（Y-up、右手、米制），因此视差、比例天然一致。
 *
 * 数据流：MotionBricks(ORT WebGPU, Worker) → 36 关节姿态 → RetargetedCharacter
 *        → Mixamo 骨骼世界矩阵 → SplatAvatar（GPU LBS + EWA）→ 屏幕
 *
 * 契约：docs/CONTRACT.md §4。调试句柄：window.__mgHuman。
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { SplatAvatar } from './splat-avatar.js';
import { MotionDriver } from './motion-driver.js';

const EYE = 1.6;          // 与 app.js __MG_WALK.eyeHeight 一致
const TARGET_HEIGHT = 1.75;

/** ?splatsize=0.005 可覆盖高斯半径（调参用；缺省 = 按采样间距自适应） */
function splatSizeFromUrl() {
  try {
    const v = new URLSearchParams(location.search).get('splatsize');
    const n = v == null ? NaN : Number(v);
    return isFinite(n) && n > 0 ? n : null;
  } catch (_) { return null; }
}

const state = {
  phase: 'boot',          // boot | loading | ready | error
  ready: false,
  backend: '-',
  modelReady: false,
  gait: 'stand',
  mode: 'stay',
  fps: 0,
  genMs: 0,
  count: 0,
  bones: 0,
  height: 0,
  error: null,
  visible: true,
  groundY: null,
  srcStage: '-'
};

const log = (...a) => console.log('[human]', ...a);

/* ------------------------------------------------------------------ 启动 */

function waitForViewer(timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const tick = () => {
      const v = window.__viewer;
      if (v && v.app && v.app.root) return resolve(v);
      if (performance.now() - t0 > timeoutMs) return reject(new Error('等待 __viewer 超时'));
      setTimeout(tick, 150);
    };
    tick();
  });
}

function waitForSceneLoaded(viewer, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const tick = () => {
      const st = viewer.state || {};
      if (st.loaded || performance.now() - t0 > timeoutMs) return resolve(!!st.loaded);
      setTimeout(tick, 200);
    };
    tick();
  });
}

/* ------------------------------------------------------------------ 主体 */

export async function initHumanLayer(opts = {}) {
  const viewer = opts.viewer || (await waitForViewer());
  await waitForSceneLoaded(viewer);

  /* ---- 透明 overlay canvas ---- */
  const canvas = document.createElement('canvas');
  canvas.id = 'mg-human-layer';
  Object.assign(canvas.style, {
    position: 'fixed', inset: '0', width: '100%', height: '100%',
    pointerEvents: 'none', zIndex: '3'
  });
  document.body.appendChild(canvas);

  const renderer = new THREE.WebGLRenderer({
    canvas, alpha: true, antialias: false, premultipliedAlpha: true,
    powerPreference: 'high-performance'
  });
  renderer.setClearAlpha(0);
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 200);
  camera.matrixAutoUpdate = true;

  /* 环境光只影响回退网格，不影响高斯（高斯用自身颜色） */
  scene.add(new THREE.HemisphereLight('#ffffff', '#888899', 2.0));
  const sun = new THREE.DirectionalLight('#ffffff', 1.6);
  sun.position.set(2, 5, 3);
  scene.add(sun);

  /* 落地阴影：一张径向渐变贴片，避免「悬空」观感 */
  const shadow = makeShadow();
  scene.add(shadow);

  const root = new THREE.Group();          // 数字人世界根（位置 = 脚底）
  scene.add(root);

  let avatar = null, driver = null, gltfScene = null, mesh = null;
  let lastT = performance.now();
  let fpsAcc = 0, fpsN = 0, fpsT = 0;

  /* ---- 加载人物与动作 ---- */
  async function load() {
    state.phase = 'loading';
    setStatus('加载角色…');
    const gltf = await new GLTFLoader().loadAsync(opts.assetUrl || './human/assets/astronaut.glb');
    gltfScene = gltf.scene;
    gltfScene.traverse((o) => { if (o.isSkinnedMesh && !mesh) mesh = o; });
    if (!mesh) throw new Error('astronaut.glb 中没有 SkinnedMesh');

    /* 身高归一：astronaut 实测 1.36 m，按包围盒缩放到 1.75 m */
    const box = new THREE.Box3().setFromObject(gltfScene);
    const h = box.max.y - box.min.y;
    const k = h > 0.2 ? TARGET_HEIGHT / h : 1;
    gltfScene.scale.multiplyScalar(k);
    state.height = +(h * k).toFixed(3);

    /* 动作驱动（模型缺失也能返回，以绑定姿态显示） */
    driver = await MotionDriver.create({
      modelUrl: opts.modelUrl || './human/model/mmm_v6_soma_q8h.onnx',
      ortUrl: opts.ortUrl || './human/vendor/ort/ort.webgpu.min.mjs',
      backend: opts.backend || 'auto',
      /* 关掉库的「按腿长放大人体」：astronaut 是 Q 版比例，开 matchSize 会被拉到 3.4 m。
         改为保持原始比例，由本层统一缩放到 1.75 m（代价：步态有轻微滑步，见 README 已知限制）。 */
      matchSize: false,
      onProgress: (stage, loaded, total) => {
        state.srcStage = stage;
        if (stage === 'model') setStatus(`下载模型 ${Math.round((loaded || 0) / 1e6)}${total ? ' / ' + Math.round(total / 1e6) : ''} MB`);
        else if (stage === 'warmup') setStatus('模型预热…');
        else setStatus('初始化推理后端…');
      }
    }).catch((e) => { state.error = String(e?.message || e); return null; });

    if (driver) {
      await driver.bindCharacter(gltfScene);
      root.add(driver.characterObject || gltfScene);
      state.backend = driver.stats.backend || '-';
      state.modelReady = !!driver.stats.modelReady;
      if (driver.stats.error) state.error = driver.stats.error;
    } else {
      root.add(gltfScene);
    }

    /* 高斯化身 */
    root.updateWorldMatrix(true, true);
    try {
      avatar = await SplatAvatar.create({
        mesh, count: opts.count || 120000,
        size: opts.size != null ? opts.size : splatSizeFromUrl(),   /* null = 按采样间距自适应 */
        opacity: opts.opacity ?? 0.85
      });
      scene.add(avatar.object);
      state.count = avatar.stats.splats || avatar.stats.count || 0;
      state.bones = avatar.stats.bones || 0;
      state.splatSize = avatar.stats.size;
      state.spacing = avatar.stats.spacing;
      log('高斯半径', JSON.stringify({ size: avatar.stats.size, spacing: avatar.stats.spacing }));
    } catch (e) {
      state.error = '高斯化身初始化失败：' + String(e?.message || e);
      mesh.visible = true;               // 回退：直接显示蒙皮网格
      log(e);
    }

    placeInFront(opts.distance || 3.2);
    state.phase = 'ready';
    state.ready = true;
    setStatus(state.error ? state.error : '就绪');
    log('就绪', JSON.stringify({ backend: state.backend, model: state.modelReady, splats: state.count, err: state.error }));
  }

  /* ---- 放置：相机前方地面上 ---- */
  function placeInFront(meters = 2.6) {
    syncCamera();
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
    dir.normalize();
    const p = camera.position.clone().addScaledVector(dir, meters);
    const groundY = state.groundY != null ? state.groundY : (camera.position.y - EYE);
    /* 朝向角：「模型正面 = 局部 +X」，把 +X 转到「角色→相机」方向 → θ = atan2(−d.z, d.x)，
       d = 角色→相机。这个公式在 `tools/probe_yaw.mjs` 的四方向标定里确认过（DECISIONS D9）。 */
    const yaw = Math.atan2(-(camera.position.z - p.z), camera.position.x - p.x);

    /* 位置：把外层 group 放到目标点（脚底 = groundY），再按 hips 反推一次抵消骨骼里的位移。
       已知局限：MotionBricks 的地面位姿由 controller 持有，走动之后它会继续推进，
       group 上的偏移会被抵消一部分 —— 「走过一段路再按重新放置」落点会偏 1–2 m。
       干净的复位需要改写 controller.pose（driver.teleport，实验性，未收敛，默认不启用）。 */
    root.position.set(p.x, groundY, p.z);
    root.rotation.y = yaw;
    const hp = charPos(new THREE.Vector3());
    if (isFinite(hp.x) && (hp.x || hp.z)) {
      root.position.x += p.x - hp.x;
      root.position.z += p.z - hp.z;
    }

    const fp = charPos(new THREE.Vector3());
    shadow.position.set(fp.x, groundY + 0.01, fp.z);
    patrol.from.set(fp.x, groundY, fp.z);
    patrol.to.set(fp.x + 1.4, groundY, fp.z);
    nav.dir.copy(dir);
    nav.pendingAnchor = true;
    state.placedAt = { x: +fp.x.toFixed(2), z: +fp.z.toFixed(2), yaw: +yaw.toFixed(3) };
    state.yaw = yaw;
    log('放置', JSON.stringify(state.placedAt));
  }

  /** 运行期量测：世界包围盒高度 / 相机距离 / 根高（供验证脚本断言，不参与渲染） */
  function measure() {
    const box = new THREE.Box3();
    const target = (driver && driver.characterObject) || gltfScene;
    if (target) box.setFromObject(target);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    return {
      height: +size.y.toFixed(3),
      width: +size.x.toFixed(3),
      minY: +box.min.y.toFixed(3),
      maxY: +box.max.y.toFixed(3),
      camDist: +camera.position.distanceTo(center).toFixed(2),
      rootY: +root.position.y.toFixed(3),
      scale: +gltfScene.scale.x.toFixed(3)
    };
  }

  /* ---- 相机同步 ---- */
  let camComp = null;
  function syncCamera() {
    if (!camComp) {
      try { camComp = viewer.app.root.findComponent('camera'); } catch (_) { camComp = null; }
      if (!camComp) return;
    }
    const ent = camComp.entity;
    const p = ent.getPosition();
    const q = ent.getRotation();
    camera.position.set(p.x, p.y, p.z);
    camera.quaternion.set(q.x, q.y, q.z, q.w);
    const w = canvas.clientWidth || innerWidth, h = canvas.clientHeight || innerHeight;
    if (Math.abs(camera.aspect - w / h) > 1e-4) {
      camera.aspect = w / h;
      camera.fov = camComp.fov || 70;
      camera.near = Math.max(0.05, camComp.nearClip || 0.1);
      camera.far = camComp.farClip || 200;
      camera.updateProjectionMatrix();
    }
  }

  /* ---- 自主往返 ---- */
  const patrol = { from: new THREE.Vector3(), to: new THREE.Vector3(), dir: 1, next: 0 };
  /* 驻留模式下的往返方向与锚点 */
  const nav = { dir: new THREE.Vector3(0, 0, -1), anchor: new THREE.Vector3(), pendingAnchor: true };

  /* 取「人」的世界位置：MotionBricks 的位移落在 hips 骨骼上，角色 Group 的原点是不动的，
     所以判断走到哪必须读 hips，不能读 characterObject.position。 */
  let hipsObj = null;
  function charPos(out) {
    const co = (driver && driver.characterObject) || gltfScene;
    if (!hipsObj && co) {
      hipsObj = co.getObjectByName('mixamorigHips') || co.getObjectByName('Hips') ||
        co.getObjectByName('mixamorig:Hips') || null;
    }
    return (hipsObj || co || root).getWorldPosition(out);
  }

  /* ---- 主循环 ---- */
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min((now - lastT) / 1000, 0.1);
    lastT = now;

    syncCamera();
    shadow.position.set(root.position.x, root.position.y + 0.01, root.position.z);

    if (driver && state.ready) {
      const p0 = charPos(new THREE.Vector3());   // 惰性初始化 hipsObj（判断位移用）
      /* 朝向：placeInFront 已经用「模型正面 = 局部 +X」算好了 yaw，这里不再做二次校正。
         早期的「读 hips 骨骼 matrixWorld 的 +X 作前向」是错的 —— 骨骼局部轴与网格轴不同，
         实测会额外引入 +90° 旋转，导致人侧对镜头（见 DECISIONS D9）。 */
      /* 只要不是站立，就持续给「世界方向」让它真的走起来：
         stay  = 在放置点前后 1.2 m 往返；
         patrol= 在两个路径点之间往返。到点就掉头。 */
      if (state.gait !== 'stand') {
        /* 一走起来就把「面向相机」的偏航收回去，交给控制器自己的 heading
           （否则人的朝向 = 控制器朝向 + 这个常数偏角，走起来会歪着走） */
        root.rotation.y *= 0.85;
        const p = charPos(new THREE.Vector3());
        if (nav.pendingAnchor) { nav.anchor.copy(p); nav.pendingAnchor = false; }
        const leg = state.mode === 'patrol' ? 2.4 : 1.2;
        if (p.distanceTo(nav.anchor) > leg) {
          /* 超出往返半径就掉头，避免一路走进墙里 */
          nav.dir.multiplyScalar(-1);
          nav.anchor.copy(p);
        }
        driver.drive(nav.dir, state.gait);
      }
      driver.update(dt);
      state.genMs = driver.stats.genMs || 0;
      state.backend = driver.stats.backend || state.backend;
      if (driver.stats.error) state.error = driver.stats.error;
    }

    if (avatar) {
      avatar.setVisible(state.visible);
      avatar.updateBones();
      avatar.updateSort(camera);
      shadow.visible = state.visible;
    }
    shadow.visible = state.visible && !avatar;

    renderer.render(scene, camera);

    /* FPS */
    fpsAcc += dt; fpsN++;
    if (now - fpsT > 500) { state.fps = Math.round(fpsN / Math.max(fpsAcc, 1e-3)); fpsAcc = 0; fpsN = 0; fpsT = now; }
    updateHud();
  });

  /* ---- UI ---- */
  const ui = buildUI({
    onGait: (g) => { state.gait = g; if (driver) driver.setGait(g); ui.mark(); },
    onMode: (m) => { state.mode = m; ui.mark(); },
    onToggle: () => { state.visible = !state.visible; ui.mark(); },
    onPlace: () => placeInFront(opts.distance || 3.2),
    onNudge: (dy) => { state.groundY = root.position.y + dy; root.position.y = state.groundY; shadow.position.y = state.groundY + 0.01; }
  });
  let statusEl = ui.status;
  function setStatus(t) { if (statusEl) statusEl.textContent = t; }
  function updateHud() { ui.tick(state); }

  load().catch((e) => {
    state.phase = 'error';
    state.error = String(e?.message || e);
    setStatus('失败：' + state.error);
    log(e);
  });

  return {
    state,
    setGait: (g) => { state.gait = g; driver && driver.setGait(g); ui.mark(); },
    setMode: (m) => { state.mode = m; ui.mark(); },
    placeInFront,
    toggle: (v) => { state.visible = v !== false; ui.mark(); },
    setGroundY: (y) => { state.groundY = y; root.position.y = y; },
    /* 直接设定朝向（弧度，语义同 placeInFront 的 yaw）：有驱动就写进 pose heading，
       否则退化为外层 group 旋转。取消自动校正 —— 标定模型前向用。 */
    setYaw: (r) => { const v = +r || 0; root.rotation.y = v; state.yaw = v; return v; },
    getYaw: () => state.yaw || 0,
    setSplatSize: (s) => { if (avatar && avatar.setSplatSize) { avatar.setSplatSize(s); state.splatSize = avatar.stats.size; } },
    measure,
    /* 诊断：人相对相机在哪、是否落在视锥内（出交付截图/排障用，不参与渲染） */
    diag: () => {
      const p = charPos(new THREE.Vector3());
      const v = p.clone().project(camera);
      return {
        charPos: { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) },
        camPos: { x: +camera.position.x.toFixed(2), y: +camera.position.y.toFixed(2), z: +camera.position.z.toFixed(2) },
        dist: +camera.position.distanceTo(p).toFixed(2),
        ndc: { x: +v.x.toFixed(2), y: +v.y.toFixed(2), z: +v.z.toFixed(2) },
        inView: Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1 && v.z > -1 && v.z < 1,
        visible: state.visible
      };
    },
    _internals: () => ({ avatar, driver, scene, camera, renderer })
  };
}

/* ------------------------------------------------------------------ 工具 */

function makeShadow() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const rg = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  rg.addColorStop(0, 'rgba(0,0,0,0.55)');
  rg.addColorStop(0.55, 'rgba(0,0,0,0.22)');
  rg.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = rg;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(1.5, 1.5).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
  );
  m.renderOrder = -1;
  return m;
}

function buildUI(handlers) {
  const wrap = document.createElement('div');
  wrap.id = 'mg-human-ui';
  wrap.innerHTML = `
    <style>
      #mg-human-ui{position:fixed;left:16px;bottom:16px;z-index:40;font:13px/1.5 -apple-system,"Segoe UI",sans-serif;
        background:rgba(18,20,26,.86);color:#eee;border:1px solid rgba(255,255,255,.14);border-radius:12px;
        padding:12px 14px;backdrop-filter:blur(8px);box-shadow:0 8px 28px rgba(0,0,0,.35);min-width:240px}
      #mg-human-ui h4{margin:0 0 6px;font-size:13px;font-weight:600;letter-spacing:.02em;display:flex;gap:6px;align-items:center}
      #mg-human-ui h4 i{width:7px;height:7px;border-radius:50%;background:#8b8f9a;display:inline-block}
      #mg-human-ui .row{display:flex;gap:6px;margin-top:6px}
      #mg-human-ui button{flex:1;min-height:30px;border-radius:8px;border:1px solid rgba(255,255,255,.16);
        background:rgba(255,255,255,.06);color:#dfe3ea;cursor:pointer;font-size:12px}
      #mg-human-ui button[aria-pressed="true"]{background:#e8eaef;color:#14161b;border-color:#e8eaef;font-weight:600}
      #mg-human-ui button:disabled{opacity:.4;cursor:default}
      #mg-human-ui .meta{margin-top:8px;color:#9aa0ad;font-size:11px;line-height:1.55;font-variant-numeric:tabular-nums}
      #mg-human-ui .err{color:#ff9d8a}
    </style>
    <h4><i></i><span>3DGS 数字人 · MotionBricks</span></h4>
    <div class="row">
      <button data-gait="stand">站立</button><button data-gait="walk">行走</button><button data-gait="run">奔跑</button>
    </div>
    <div class="row">
      <button data-mode="stay">驻留</button><button data-mode="patrol">往返</button>
      <button data-act="place" title="放到相机前方">重新放置</button>
    </div>
    <div class="row">
      <button data-act="toggle">隐藏</button>
      <button data-act="down" title="整体下移 2cm">↓2cm</button>
      <button data-act="up" title="整体上移 2cm">↑2cm</button>
    </div>
    <div class="meta"><span id="mg-human-status">初始化…</span></div>
    <div class="meta" id="mg-human-stats"></div>`;
  document.body.appendChild(wrap);
  /* 面板必须始终在小地图（左下，z-index:26，高约 257px）上方：
     小地图可折叠/隐藏、窗口可缩放，所以每次读它的实时矩形来算 bottom 偏移。 */
  const minimap = document.getElementById('mg-minimap');
  function placePanel() {
    const r = minimap ? minimap.getBoundingClientRect() : null;
    const above = (r && r.height > 8 && r.top > 0) ? Math.round(innerHeight - r.top + 10) : 16;
    wrap.style.bottom = Math.max(16, above) + 'px';
  }
  placePanel();
  addEventListener('resize', placePanel);
  setInterval(placePanel, 800);
  const $ = (s) => wrap.querySelector(s);
  const btns = [...wrap.querySelectorAll('button')];
  btns.forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.gait) handlers.onGait(b.dataset.gait);
    else if (b.dataset.mode) handlers.onMode(b.dataset.mode);
    else if (b.dataset.act === 'place') handlers.onPlace();
    else if (b.dataset.act === 'toggle') handlers.onToggle();
    else if (b.dataset.act === 'down') handlers.onNudge(-0.02);
    else if (b.dataset.act === 'up') handlers.onNudge(0.02);
  }));
  return {
    status: $('#mg-human-status'),
    mark() { /* 状态由 tick 统一刷新 */ },
    tick(s) {
      btns.forEach((b) => {
        if (b.dataset.gait) b.setAttribute('aria-pressed', String(b.dataset.gait === s.gait));
        else if (b.dataset.mode) b.setAttribute('aria-pressed', String(b.dataset.mode === s.mode));
        else if (b.dataset.act === 'toggle') b.textContent = s.visible ? '隐藏' : '显示';
      });
      const modelTxt = s.modelReady ? '已加载' : (s.phase === 'loading' ? '加载中' : '未就绪');
      $('#mg-human-stats').innerHTML =
        `后端 ${s.backend} · 模型 ${modelTxt} · 推理 ${s.genMs ? s.genMs.toFixed(0) + 'ms' : '—'}<br>` +
        `高斯 ${(s.count / 1000).toFixed(0)}k · 骨骼 ${s.bones} · ${s.fps} FPS` +
        (s.error ? `<br><span class="err">${s.error}</span>` : '');
    }
  };
}

/* ------------------------------------------------------------------ 自启 */

(function boot() {
  const q = new URLSearchParams(location.search);
  if (q.get('human') === '0') return;
  if (q.get('human') === '1') {
    initHumanLayer().then((h) => { window.__mgHuman = h; }).catch((e) => { console.error('[human] 启动失败', e); });
    return;
  }
  /* 默认：给一个入口按钮，不自动下模型 */
  const btn = document.createElement('button');
  btn.textContent = '数字人';
  btn.id = 'mg-human-btn';
  Object.assign(btn.style, {
    position: 'fixed', left: '16px', bottom: '16px', zIndex: '8', height: '34px', padding: '0 14px',
    borderRadius: '10px', border: '1px solid rgba(255,255,255,.16)', background: 'rgba(18,20,26,.86)',
    color: '#e8eaef', fontSize: '13px', cursor: 'pointer', backdropFilter: 'blur(8px)'
  });
  btn.addEventListener('click', () => {
    btn.disabled = true; btn.textContent = '加载中…';
    initHumanLayer().then((h) => { window.__mgHuman = h; btn.remove(); })
      .catch((e) => { btn.disabled = false; btn.textContent = '数字人（失败）'; console.error(e); });
  });
  document.body.appendChild(btn);
})();

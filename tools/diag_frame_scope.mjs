/**
 * 逐帧真实执行诊断：验证 error scope 异步回调竞态是否导致贴花显示/隐藏交替（闪烁）
 * ----------------------------------------------------------------
 * 不修改产品代码，只 import 真实模块 + mock adapter，逐帧调用 onPrerender/onFrameEnd，
 * 记录每一帧「渲染时刻」的 renderable.visible。
 *
 * 关键 mock：模拟真实 WebGPU 的 popErrorScope().then 异步回调，且
 *   - 贴花可见的帧（scope 内有贴花提交）→ 报 validation error
 *   - 贴花隐藏的帧（复测帧）→ 无 error
 * 这样若竞态存在，会看到 visible 在 true/false 间无限交替。
 */
import { createDecalProjection } from '../web/editor/decal-projection.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { console.log('  PASS  ' + name); pass++; }
  else { console.log('  FAIL  ' + name + (extra ? '  ::  ' + extra : '')); fail++; }
};

// ---- DOM mock ----
function mockCtx() {
  return { fillStyle: '', strokeStyle: '', lineWidth: 1, font: '',
    fillRect() {}, strokeRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
    stroke() {}, fillText() {}, clearRect() {}, drawImage() {} };
}
function el(tag) {
  return { tagName: String(tag).toUpperCase(), width: 1, height: 1, style: {}, dataset: {},
    _listeners: {}, addEventListener() {}, removeEventListener() {}, removeAttribute() {},
    setAttribute() {}, load() {}, play() { return Promise.resolve(); }, pause() {},
    appendChild(c) { return c; }, remove() {}, getContext() { return mockCtx(); } };
}
globalThis.document = { createElement: el, body: el('body') };
globalThis.window = { __viewer: null };
globalThis.performance = globalThis.performance || { now: () => Date.now() };

const projector = { position: [0, 1, 0], quaternion: [0, 0, 0, 1], half: [2, 1.5, 0.25] };
const decal = { id: 'd1', projector, shadow: null, videoUrl: null, visible: true, opacity: 0.9,
  edge: 0.12, cull: false, boxScale: 1, depthMode: 1 };

// shared instance ref so mock can observe its visibility
let instRef = null;

/* mode='decal'：仅贴花提交时报错（复测关贴花后错误消失 → 判定贴花的错 → degrade）
   mode='engine'：贴花开关都报错（复测仍有错 → 判定引擎自身 → 忽略，视频保留） */
function makeAdapter(mode = 'decal') {
  const hooks = { beforeRender: [], afterRender: [] };
  const mat = () => ({ params: {} });
  const tex = (spec) => ({ spec, size: [spec?.width || 1, spec?.height || 1] });
  let scopeSawDecal = false;
  const adapter = {
    _hooks: hooks, _calls: [], _errors: [],
    _log(n) { this._calls.push(n); },
    getEngineKind() { return 'playcanvas'; }, isReady() { return true; },
    getRenderSize() { return [1920, 1080]; }, getBackendType() { return 'webgpu'; },
    getPixelRatio() { return 1; }, requestRender() { this._log('requestRender'); },
    addRenderHook(p, cb) { hooks[p].push(cb); },
    removeRenderHook(p, cb) { hooks[p] = hooks[p].filter(x => x !== cb); },
    observeGpuErrors() { return null; },
    // ★ WebGPU error scope：真实 adapter 是 popErrorScope().then → 异步
    beginGpuErrorScope() {
      scopeSawDecal = !!(instRef && instRef.renderable && instRef.renderable._visible);
      return true;
    },
    endGpuErrorScope(cb) {
      const err = (mode === 'engine' || scopeSawDecal)
        ? 'mock validation error' : null;
      if (err) this._errors.push(err);
      Promise.resolve(err).then(e => cb(e));   // 异步，模拟真实时序
      return true;
    },
    getScene() { return {}; }, getCameraEntity() { return {}; },
    getCameraPosition() { return [0, 1, 0]; },
    getCameraInverseViewProjection() { return new Float32Array(16); },
    getCameraNearFar() { return [0.1, 100]; },
    createShaderMaterial() { return mat(); },
    setMaterialParameter(m, k, v) { m.params[k] = v; },
    destroyMaterial() {}, setMaterialBlendState() {},
    createCanvasTexture(spec) { return tex(spec); },
    updateCanvasTexture() { this._log('updateCanvasTexture'); },
    getTextureSize(t) { return t ? t.size : [1, 1]; }, getTextureFormat() { return 'rgba8'; },
    createDataTexture(spec) { return tex(spec); }, updateDataTexture() {}, destroyTexture() {},
    createFullscreenQuad() { return { mesh: { id: 'quad' }, node: { id: 'quadNode' } }; },
    createRenderable(mesh) { return { mesh, _visible: false }; },
    addRenderable() {}, removeRenderable() {},
    setRenderableVisible(r, v) { if (r) r._visible = !!v; },
    createSceneNode(name) { return { name }; },
    createMesh() { return { id: 'mesh' }; }, destroyMesh() {},
    getDepthPickView() { return null; }, getPickingBackend() { return 'depth'; },
    setRenderableFlags() {},
    composeRigidMatrix() { return new Float32Array(16); },
    invertMatrix() { return new Float32Array(16); },
    rotateVectorByQuaternion() { return [0, 0, 1]; },
    createDepthPass(spec) { return { id: 1, spec, texture: tex({ width: spec.size[0], height: spec.size[1] }) }; },
    setDepthPassGeometry() { return true; }, setDepthPassProjector() { return true; },
    setDepthPassEnabled() {}, getDepthPassTexture(p) { return p && p.texture; },
    getDepthPassViewProjection() { return new Float32Array(16); }, destroyDepthPass() {}
  };
  return adapter;
}

console.log('\n========== 逐帧 error scope 竞态诊断 ==========');

async function runScenario(mode) {
  const a = makeAdapter(mode);
  const m = createDecalProjection({ adapter: a, getDecals: () => [decal] });
  m.setOptions({ maxFps: 0, uploadFps: 0 });   // 解除 timer，避免 setTimeout 干扰逐帧
  m.sync([decal]);
  instRef = [...m.instances.values()][0];

  const before = a._hooks.beforeRender[0];
  const after = a._hooks.afterRender[0];
  const trace = [];
  for (let f = 0; f < 10; f++) {
    before();                                    // onPrerender（本帧是否隐藏贴花在此决定）
    const visibleAtRender = !!instRef.renderable._visible;   // 渲染时刻的可见性
    after();                                     // onFrameEnd（endScope 异步 + 同步恢复）
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); // 等 popErrorScope 回调
    const dbg = m.debug();
    trace.push({ f, visibleAtRender, degraded: dbg.degraded,
      scoped: dbg.scopedErrors, foreign: dbg.foreignErrors });
  }
  console.log(`\n---- 场景 mode=${mode} ----`);
  console.log('帧号 | 渲染时刻贴花可见 | degraded | scoped | foreign');
  for (const t of trace) {
    console.log(`  ${t.f}  |      ${t.visibleAtRender ? 'true ' : 'false'}       |   ${t.degraded ? 'true ' : 'false'}   |   ${t.scoped}    |   ${t.foreign}`);
  }
  const visSeq = trace.map(t => t.visibleAtRender);
  const toggles = visSeq.slice(1).filter((v, i) => v !== visSeq[i]).length;
  console.log('可见性切换次数 =', toggles, ' GPU errors =', a._errors.length,
    ' scoped =', m.debug().scopedErrors, ' foreign =', m.debug().foreignErrors);
  return { visSeq, toggles, dbg: m.debug() };
}

// 场景 A：贴花自身错误 → 应立即降级隐藏，之后稳定，不逐帧交替
const decalRun = await runScenario('decal');
check('[贴花错] 不闪烁：可见性切换 <= 1 次', decalRun.toggles <= 1,
  '切换 ' + decalRun.toggles + ' 次，序列=' + decalRun.visSeq.join(','));
check('[贴花错] 归因收敛：scopedErrors=1 且已降级',
  decalRun.dbg.scopedErrors === 1 && decalRun.dbg.degraded === true,
  'scoped=' + decalRun.dbg.scopedErrors + ' degraded=' + decalRun.dbg.degraded);
check('[贴花错] 降级后稳定隐藏：末帧=false', decalRun.visSeq.at(-1) === false,
  '末帧=' + decalRun.visSeq.at(-1));

// 场景 B：引擎自身错误（贴花关掉也报）→ 首次复测隐藏 1 帧判定为 foreign 后冻结结论，
// 之后永久稳定可见。允许 <=2 次切换（true→false→true 的首次归因探测），绝不逐帧交替。
const engineRun = await runScenario('engine');
check('[引擎错] 不持续闪烁：可见性切换 <= 2 次（仅首次归因探测）', engineRun.toggles <= 2,
  '切换 ' + engineRun.toggles + ' 次，序列=' + engineRun.visSeq.join(','));
check('[引擎错] 归因后稳定：末 5 帧全部可见', engineRun.visSeq.slice(-5).every(v => v === true),
  '末5帧=' + engineRun.visSeq.slice(-5).join(','));
check('[引擎错] 不误降级：degraded=false 且视频保持可见',
  engineRun.dbg.degraded === false && engineRun.visSeq.at(-1) === true,
  'degraded=' + engineRun.dbg.degraded + ' 末帧=' + engineRun.visSeq.at(-1));
check('[引擎错] 归因正确：foreignErrors>=1、scopedErrors=0',
  engineRun.dbg.foreignErrors >= 1 && engineRun.dbg.scopedErrors === 0,
  'foreign=' + engineRun.dbg.foreignErrors + ' scoped=' + engineRun.dbg.scopedErrors);

console.log(`\n========== ${pass} PASS / ${fail} FAIL ==========`);

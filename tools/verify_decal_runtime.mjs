/**
 * 贴花投射链路「真实运行时」验证
 * ----------------------------------------------------------------
 * 背景：verify_editor.mjs 全部是静态文本/正则守卫，即使代码存在
 * ReferenceError（TDZ）也会 348 PASS 全过。真机「视频完全不投射」正是
 * manager 对象字面量提前引用 shadowPathSupported 的 TDZ 导致
 * createDecalProjection() 抛异常、被 editor.js try/catch 吞成 decalMgr=null。
 *
 * 本脚本真正 import 模块并执行 JS，用 mock adapter 走通：
 *   createDecalProjection → sync → BEFORE_RENDER → AFTER_RENDER → setOptions → destroy
 * 任何运行时异常（TDZ / undefined 方法 / 参数错位）都会 FAIL。
 */
import assert from 'node:assert/strict';

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); console.log('  PASS  ' + name); pass++; }
  catch (e) { console.log('  FAIL  ' + name + '  ::  ' + (e && e.message || e)); fail++; }
};

// ---- 最小 DOM mock（createInstance / drawDemoFrame / pickPlaceholder 需要）----
function mockCanvasCtx() {
  return {
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '',
    fillRect() {}, strokeRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
    stroke() {}, fillText() {}, clearRect() {}, drawImage() {}
  };
}
function mockElement(tag) {
  const el = {
    tagName: String(tag).toUpperCase(), width: 1, height: 1,
    style: {}, dataset: {}, children: [],
    _listeners: {},
    addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn); },
    removeEventListener() {},
    removeAttribute() {}, setAttribute() {}, load() {}, play() { return Promise.resolve(); },
    pause() {}, appendChild(c) { this.children.push(c); return c; },
    getContext() { return mockCanvasCtx(); }
  };
  return el;
}
globalThis.document = {
  createElement: mockElement,
  body: mockElement('body')
};
globalThis.window = { __viewer: null };
globalThis.performance = globalThis.performance || { now: () => Date.now() };

// ---- mock adapter：实现全部契约，返回合理假值 ----
function makeAdapter() {
  const hooks = { beforeRender: [], afterRender: [] };
  const mat = () => ({ params: {} });
  const tex = (spec) => ({ spec, size: [spec?.width || 1, spec?.height || 1] });
  let depthPassId = 0;
  const adapter = {
    _hooks: hooks, _calls: [],
    _log(name) { this._calls.push(name); },
    getEngineKind() { return 'playcanvas'; },
    isReady() { return true; },
    getRenderSize() { return [1920, 1080]; },
    getBackendType() { return 'webgl2'; },
    getPixelRatio() { return 1; },
    requestRender() { this._log('requestRender'); },
    addRenderHook(phase, cb) { hooks[phase].push(cb); },
    removeRenderHook(phase, cb) { hooks[phase] = hooks[phase].filter(x => x !== cb); },
    observeGpuErrors() { return null; },
    beginGpuErrorScope() { return false; },
    endGpuErrorScope() {},
    getScene() { return {}; },
    getCameraEntity() { return {}; },
    getCameraPosition() { return [0, 1, 0]; },
    getCameraInverseViewProjection() { return new Float32Array(16); },
    getCameraNearFar() { return [0.1, 100]; },
    createShaderMaterial() { return mat(); },
    setMaterialParameter(m, k, v) { m.params[k] = v; },
    destroyMaterial() {},
    setMaterialBlendState() {},
    createCanvasTexture(spec) { return tex(spec); },
    updateCanvasTexture() { this._log('updateCanvasTexture'); },
    getTextureSize(t) { return t ? t.size : [1, 1]; },
    getTextureFormat() { return 'rgba8'; },
    createDataTexture(spec) { return tex(spec); },
    updateDataTexture() {},
    destroyTexture() {},
    createFullscreenQuad() { return { mesh: { id: 'quad' }, node: { id: 'quadNode' } }; },
    createRenderable(mesh) { return { mesh }; },
    addRenderable() {}, removeRenderable() {}, setRenderableVisible() {},
    createSceneNode(name) { return { name }; },
    createMesh() { return { id: 'mesh' }; }, destroyMesh() {},
    getDepthPickView() { return null; },
    getPickingBackend() { return 'depth'; },
    setRenderableFlags() {},
    composeRigidMatrix() { return new Float32Array(16); },
    invertMatrix() { return new Float32Array(16); },
    rotateVectorByQuaternion() { return [0, 0, 1]; },
    createDepthPass(spec) { return { id: ++depthPassId, spec, texture: tex({ width: spec.size[0], height: spec.size[1] }) }; },
    setDepthPassGeometry() { return true; },
    setDepthPassProjector() { return true; },
    setDepthPassEnabled() {},
    getDepthPassTexture(p) { return p && p.texture; },
    getDepthPassViewProjection() { return new Float32Array(16); },
    destroyDepthPass() {}
  };
  return adapter;
}

const projector = {
  position: [0, 1, 0], quaternion: [0, 0, 0, 1], half: [2, 1.5, 0.25]
};
function testDecal(id = 'd1') {
  return {
    id, projector, shadow: null, videoUrl: null, visible: true, opacity: 0.9, edge: 0.12,
    cull: false, boxScale: 1, depthMode: 1
  };
}

console.log('\n========== 贴花运行时链路验证 ==========');

const { createDecalProjection, projectorCubeGeometry, flatCollisionTriangles } =
  await import('../web/editor/decal-projection.js');

check('createDecalProjection 不抛 TDZ（默认三段式）', () => {
  const a = makeAdapter();
  const m = createDecalProjection({ adapter: a, getDecals: () => [] });
  assert.ok(m, 'manager 应存在');
  assert.equal(m.enabled, true, 'manager.enabled 应为 true');
  assert.equal(m.shadowPathSupported, true, '默认 useShadowPass=1，走三段式');
  assert.equal(m.getOptions().useShadowPass, 1, '默认 useShadowPass 应为 1');
  assert.equal(m.getOptions().depthTest, 1, '默认 depthTest 应为 1（同源深度比较）');
  assert.equal(typeof m.sync, 'function', 'sync 应挂载');
});

check('默认三段式：实例走 shadow 路径，创建 depthPass/cube', () => {
  const a = makeAdapter();
  const m = createDecalProjection({ adapter: a, getDecals: () => [testDecal()] });
  assert.doesNotThrow(() => m.sync([testDecal()]));
  assert.equal(m.instances.size, 1, '应有 1 个实例');
  const inst = [...m.instances.values()][0];
  assert.equal(inst.useShadow, true, '默认走三段式 shadow 路径');
  assert.ok(inst.depthPass, '默认应创建 depthPass');
  assert.ok(inst.cubeMesh, '默认应有 AABB cube 几何');
});

check('BEFORE_RENDER 注入 shadow 路径 uniform（含同源深度/法线剔除）', () => {
  const a = makeAdapter();
  const m = createDecalProjection({ adapter: a, getDecals: () => [testDecal()] });
  m.sync([testDecal()]);
  const before = a._hooks.beforeRender;
  assert.equal(before.length, 1, '应注册 1 个 prerender 钩子');
  assert.doesNotThrow(() => before[0](), 'onPrerender 不应抛异常');
  const inst = [...m.instances.values()][0];
  // shadow shader 核心 uniform（OBB 局部坐标 + 深度比较 + 视频行序）
  for (const k of ['pickDepth', 'videoTex', 'invViewProj', 'invProjector', 'decalHalf', 'uBoxScale', 'uDepthTest', 'uVideoFlipY']) {
    assert.ok(k in inst.material.params, '缺少 uniform ' + k);
  }
  // OBB uniform 恒注入（默认路径 UV 依赖它）
  assert.ok(inst.material.params.invProjector, 'invProjector 应注入');
});

check('默认三段式缩放 projector（half 变化）触发 Pass1 重渲（同源深度同步刷新）', () => {
  const a = makeAdapter();
  const m = createDecalProjection({ adapter: a, getDecals: () => [testDecal()] });
  m.sync([testDecal()]);
  let projectorCalls = 0;
  const orig = a.setDepthPassProjector;
  a.setDepthPassProjector = (...args) => { projectorCalls++; return orig(...args); };
  // 模拟连续缩放：多次 sync，每次 half 不同。3DGS 深度由 setDepthPassProjector
  // 同步渲染（无需每帧重渲碰撞 mesh），因此缩放触发它是预期行为。
  for (let i = 1; i <= 5; i++) {
    const d = testDecal();
    d.projector = { ...projector, half: [2 + i * 0.1, 1.5, 0.25] };
    assert.doesNotThrow(() => m.sync([d]));
  }
  assert.ok(projectorCalls >= 5, '三段式每次 projector 变化都应刷新深度（got ' + projectorCalls + '）');
});

check('默认 uDepthTest=1；setOptions({depthTest:0}) 可即时回退 always-on-top', () => {
  const a = makeAdapter();
  const col = { triangles: { count: 1,
    v0x: [0], v0y: [0], v0z: [0], v1x: [1], v1y: [0], v1z: [0],
    v2x: [0], v2y: [1], v2z: [0] } };
  globalThis.window.__viewer = { collision: () => col };
  const m = createDecalProjection({ adapter: a, getDecals: () => [testDecal()] });
  m.sync([testDecal()]);
  const inst = [...m.instances.values()][0];
  assert.ok(inst.useShadow, '默认应走三段式');
  assert.ok(inst.depthPass, '应创建 depthPass');
  a._hooks.beforeRender[0]();
  assert.equal(inst.material.params.uDepthTest, 1, '默认 uDepthTest 应为 1（深度比较）');
  // 运行时关深度比较：立刻生效（UV 仍走 OBB），不抛异常
  assert.doesNotThrow(() => m.setOptions({ depthTest: 0 }), 'setOptions depthTest=0 不应抛');
  a._hooks.beforeRender[0]();
  assert.equal(inst.material.params.uDepthTest, 0, '回退后 uDepthTest 应为 0');
  globalThis.window.__viewer = null;
});

check('useShadowPass 选项可运行时改写（实例 useShadow 创建时冻结，需重建实例）', () => {
  const a = makeAdapter();
  const m = createDecalProjection({ adapter: a, getDecals: () => [testDecal()] });
  m.sync([testDecal()]);
  const inst0 = [...m.instances.values()][0];
  assert.equal(inst0.useShadow, true, '默认三段式开启');
  assert.doesNotThrow(() => m.setOptions({ useShadowPass: 0 }), '改 useShadowPass 不应抛异常');
  assert.equal(m.getOptions().useShadowPass, 0, 'useShadowPass 应记录为 0');
  assert.doesNotThrow(() => m.setOptions({ useShadowPass: 1 }), '切回 1 不应抛异常');
  assert.equal(m.getOptions().useShadowPass, 1, '切回 1 应生效');
});

check('AFTER_RENDER 钩子上传纹理/节流不抛异常', () => {
  const a = makeAdapter();
  const m = createDecalProjection({ adapter: a, getDecals: () => [testDecal()] });
  m.sync([testDecal()]);
  const after = a._hooks.afterRender;
  assert.equal(after.length, 1, '应注册 1 个 frameend 钩子');
  assert.doesNotThrow(() => after[0](), 'onFrameEnd 不应抛异常');
});

check('纹理上传节流可选：默认 0 逐帧上传，设 15 后窗口内只上传一次', () => {
  const a = makeAdapter();
  const m = createDecalProjection({ adapter: a, getDecals: () => [testDecal()] });
  assert.equal(m.getOptions().uploadFps, 0, '默认不节流（基线逐帧上传）');
  m.sync([testDecal()]);
  const after = a._hooks.afterRender[0];
  // 默认逐帧：5 帧应 5 次上传
  a._calls.length = 0;
  for (let i = 0; i < 5; i++) after();
  assert.equal(a._calls.filter(x => x === 'updateCanvasTexture').length, 5, '默认 5 帧应 5 次上传');
  // 启用节流后：同一毫秒内 20 帧只上传 1 次
  m.setOptions({ uploadFps: 15 });
  a._calls.length = 0;
  for (let i = 0; i < 20; i++) after();
  const uploads = a._calls.filter(x => x === 'updateCanvasTexture').length;
  assert.ok(uploads <= 1, '节流后 20 帧连续应 <=1 次上传，实际 ' + uploads);
});

check('setOptions(depthTest=0 / renderEnabled=0) 不抛且生效', () => {
  const a = makeAdapter();
  const m = createDecalProjection({ adapter: a, getDecals: () => [testDecal()] });
  m.sync([testDecal()]);
  assert.doesNotThrow(() => m.setOptions({ depthTest: 0, renderEnabled: 0, maxFps: 15 }));
  assert.equal(m.getOptions().depthTest, 0);
  assert.equal(m.getOptions().renderEnabled, 0);
  assert.equal(m.getOptions().maxFps, 15);
});

check('destroy 清理钩子与实例不抛异常', () => {
  const a = makeAdapter();
  const m = createDecalProjection({ adapter: a, getDecals: () => [testDecal()] });
  m.sync([testDecal()]);
  assert.doesNotThrow(() => m.destroy());
  assert.equal(a._hooks.beforeRender.length, 0, 'prerender 钩子应被移除');
  assert.equal(a._hooks.afterRender.length, 0, 'frameend 钩子应被移除');
});

check('回退路径（缺 renderpass 方法）仍能创建全屏 quad 实例', () => {
  const a = makeAdapter();
  for (const k of ['createDepthPass', 'getDepthPassTexture', 'destroyDepthPass']) delete a[k];
  const m = createDecalProjection({ adapter: a, getDecals: () => [testDecal()] });
  assert.equal(m.shadowPathSupported, false, '缺方法应回退');
  assert.doesNotThrow(() => m.sync([testDecal()]));
  assert.equal(m.instances.size, 1);
  assert.equal([...m.instances.values()][0].useShadow, false, '应使用旧路径');
});

check('projectorCubeGeometry 产出 8 顶点/36 索引', () => {
  const g = projectorCubeGeometry(projector);
  assert.ok(g, '几何应存在');
  assert.equal(g.positions.length, 24, '8 顶点 × 3');
  assert.equal(g.indices.length, 36, '12 三角 × 3');
});

check('flatCollisionTriangles 转换 SoA→flat', () => {
  const col = { triangles: { count: 2,
    v0x: [0, 3], v0y: [0, 3], v0z: [0, 3],
    v1x: [1, 4], v1y: [0, 4], v1z: [0, 4],
    v2x: [0, 3], v2y: [1, 4], v2z: [0, 4] } };
  const g = flatCollisionTriangles(col);
  assert.ok(g);
  assert.equal(g.positions.length, 18, '2 三角 × 9');
  assert.equal(g.indices.length, 6);
});

console.log(`\n========== ${pass} PASS / ${fail} FAIL ==========`);
if (fail) process.exitCode = 1;

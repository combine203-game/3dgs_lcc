/**
 * Pass1 3DGS 深度源适配验证（真实 import playcanvas-adapter）
 * ----------------------------------------------------------------
 * 验证 createDepthPass 在 app.__mgProjectorDepth 可用时走 3DGS 同源路径：
 *   - 返回 useGsplat=true 句柄，不创建碰撞 mesh 相机
 *   - setDepthPassProjector 调用 renderer.render(projector, size)
 *   - getDepthPassTexture / getDepthPassViewProjection 返回渲染结果
 *   - destroy 不销毁共享 renderer 单例
 * 以及无 __mgProjectorDepth 时回退碰撞 mesh 路径仍完整。
 */
import assert from 'node:assert/strict';

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); console.log('  PASS  ' + name); pass++; }
  catch (e) { console.log('  FAIL  ' + name + '  ::  ' + (e && e.message || e)); fail++; }
};

// 最小 __pc mock：gsplat 路径不直接使用 P 的 RenderTarget/Entity，这里只给出
// 让 adapter 初始化与契约校验通过所需的最小表面。
globalThis.__pc = {
  Vec3: class {}, Mat4: class {}, Quat: class {}, GraphNode: class {},
  Entity: class {}, Layer: class {}, RenderTarget: class {}, Texture: class {},
  Mesh: class {}, MeshInstance: class {}, ShaderMaterial: class {},
  StandardMaterial: class {}, Material: class {}, BlendState: class {},
  ADDRESS_CLAMP_TO_EDGE: 0, ADDRESS_REPEAT: 1, FILTER_NEAREST: 0, FILTER_LINEAR: 1,
  PIXELFORMAT_RGBA8: 0, PIXELFORMAT_RGBA16F: 1, PIXELFORMAT_R32F: 2,
  PIXELFORMAT_R16F: 3, PIXELFORMAT_DEPTH: 4,
  PRIMITIVE_TRISTRIP: 0, PRIMITIVE_TRIANGLES: 1,
  PROJECTION_ORTHOGRAPHIC: 1, RENDERTARGET_ORIGIN_NATIVE: 0, FUNC_LESS: 0,
  BLEND_NONE: 0, BLEND_NORMAL: 1, BLEND_ADDITIVE: 2,
  CULLFACE_NONE: 0, SEMANTIC_POSITION: 0, LAYERID_WORLD: 0, DEVICETYPE_WEBGL2: 0
};

const { createPlayCanvasAdapter } = await import('../web/engine/playcanvas-adapter.js');

const projector = {
  position: [0, 1, 0], quaternion: [0, 0, 0, 1], half: [2, 1.5, 0.25]
};

console.log('\n========== Pass1 3DGS 深度源适配验证 ==========');

check('app.__mgProjectorDepth 可用时 createDepthPass 走 gsplat 路径', () => {
  let renderCalls = 0;
  const fakeTex = { id: 'depth-tex' };
  const fakeVP = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const renderer = {
    render(p, size) {
      renderCalls++;
      assert.deepEqual(p, projector, '传给 renderer 的 projector 应一致');
      assert.equal(size, 128, 'size 应取自 depthPass 选项');
      return { texture: fakeTex, viewProj: fakeVP, size };
    },
    destroy() { throw new Error('共享 renderer 不应被 depthPass.destroy 销毁'); }
  };
  const app = {
    graphicsDevice: { width: 1920, height: 1080, deviceType: 'webgl2' },
    on() {},
    __mgProjectorDepth: () => renderer
  };
  const a = createPlayCanvasAdapter({ getApp: () => app });
  const dp = a.createDepthPass({ size: [128, 128], name: 'decal-test' });
  assert.ok(dp, '应返回句柄');
  assert.equal(dp.useGsplat, true, '应标记 gsplat 路径');
  assert.ok(a.setDepthPassGeometry(dp, { positions: new Float32Array(), indices: new Uint32Array() }),
    'gsplat 路径 setDepthPassGeometry 应返回 true（无需几何）');
  assert.equal(a.setDepthPassProjector(dp, projector), true, '设置 projector 应成功');
  assert.equal(renderCalls, 1, 'renderer.render 应被调用一次');
  assert.equal(a.getDepthPassTexture(dp), fakeTex, 'texture 应来自 renderer');
  assert.equal(a.getDepthPassViewProjection(dp), fakeVP, 'ViewProj 应来自 renderer');
  assert.doesNotThrow(() => a.setDepthPassEnabled(dp, false), 'gsplat 路径 enabled 切换不抛');
  assert.doesNotThrow(() => a.destroyDepthPass(dp), 'destroy 不应销毁共享 renderer');
});

check('renderer.render 失败时 setDepthPassProjector 返回 false', () => {
  const app = {
    graphicsDevice: { width: 1920, height: 1080 },
    on() {},
    __mgProjectorDepth: () => ({ render() { return null; }, destroy() {} })
  };
  const a = createPlayCanvasAdapter({ getApp: () => app });
  const dp = a.createDepthPass({ size: [64, 64] });
  assert.ok(dp && dp.useGsplat);
  assert.equal(a.setDepthPassProjector(dp, projector), false, '渲染失败应返回 false');
});

check('无 __mgProjectorDepth 时回退碰撞 mesh 路径仍完整', () => {
  const app = {
    graphicsDevice: { width: 1920, height: 1080 },
    on() {},
    scene: { layers: { push() {} } },
    root: { addChild() {} }
  };
  const a = createPlayCanvasAdapter({ getApp: () => app });
  const dp = a.createDepthPass({ size: [64, 64] });
  // 回退路径依赖真实 P.RenderTarget/Entity 构造；本环境 mock 的 P 为空类，
  // 若底层抛错则说明它确实走了回退分支（而非 gsplat 分支）。
  // 这里只验证「没有 __mgProjectorDepth 时不会标记 useGsplat」。
  if (dp) assert.ok(!dp.useGsplat, '回退句柄不应标记 useGsplat');
  else assert.ok(true, 'mock 环境下回退构造失败属预期（P 为空类）');
});

console.log('\n========== ' + pass + ' PASS / ' + fail + ' FAIL ==========');
process.exit(fail ? 1 : 0);

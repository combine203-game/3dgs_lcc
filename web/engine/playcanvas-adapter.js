/**
 * PlayCanvas 适配器实现
 * ----------------------------------------------------------------
 * 本文件是**唯一**允许直接引用 PlayCanvas 具体类的文件（契约层之外）。
 * 编辑器与贴花模块只通过 engine-adapter.js 的契约接口访问引擎。
 *
 * 契约方法与语义见 engine-adapter.js 的 ADAPTER_CONTRACT。
 *
 * 矩阵约定：PlayCanvas 的 Mat4.data 本身就是列主序 + 列向量约定，
 * 与 GLSL / WGSL 直接兼容，故此处不做任何转置。
 */
import { ENGINE_KINDS, RENDER_HOOKS, createEngineAdapter } from './engine-adapter.js';

function getPc() {
  return globalThis.__pc || null;
}

/**
 * @param {object} opts
 * @param {() => object|null} opts.getApp          取得 pc.Application
 * @param {() => object|null} [opts.getCameraEntity] 取得带 camera 组件的实体
 * @param {() => object|null} [opts.getPickView]   取得 Picker 深度视图
 */
export function createPlayCanvasAdapter({ getApp, getCameraEntity, getPickView } = {}) {
  const P = getPc();
  const app = getApp ? getApp() : null;
  const device = app && app.graphicsDevice ? app.graphicsDevice : null;

  const adapter = {
    // ---- A. 生命周期与渲染上下文 ----
    getEngineKind() { return ENGINE_KINDS.PLAYCANVAS; },

    isReady() {
      return !!(app && app.scene && device && device.width > 0 && device.height > 0);
    },

    getRenderSize() {
      return device ? [device.width || 0, device.height || 0] : [0, 0];
    },

    getBackendType() {
      if (!device) return 'webgl2';
      return (device.deviceType === 'webgpu' || device.isWebGPU === true) ? 'webgpu' : 'webgl2';
    },

    getPixelRatio() {
      // PlayCanvas 的 device.maxPixelRatio 与全局 DPR 取小，保证与实际后备缓冲一致
      const dpr = (typeof globalThis !== 'undefined' && globalThis.devicePixelRatio) || 1;
      const max = device && Number.isFinite(device.maxPixelRatio) ? device.maxPixelRatio : dpr;
      return Math.max(0.1, Math.min(dpr, max));
    },

    requestRender() {
      if (app) app.renderNextFrame = true;
    },

    addRenderHook(phase, callback) {
      if (!app || typeof callback !== 'function') return;
      // PlayCanvas 的事件名与契约相位一一映射
      if (phase === RENDER_HOOKS.BEFORE_RENDER) app.on('prerender', callback);
      else if (phase === RENDER_HOOKS.AFTER_RENDER) app.on('frameend', callback);
    },

    removeRenderHook(phase, callback) {
      if (!app || typeof callback !== 'function') return;
      if (phase === RENDER_HOOKS.BEFORE_RENDER) app.off('prerender', callback);
      else if (phase === RENDER_HOOKS.AFTER_RENDER) app.off('frameend', callback);
    },

    observeGpuErrors(callback) {
      if (!device || typeof callback !== 'function') return null;
      try {
        // device.wgpu 是引擎 WebgpuDevice 持有的原生 GPUDevice（WebGL2 下为 undefined）
        const wgpu = device.wgpu;
        if (!wgpu || typeof wgpu.addEventListener !== 'function') return null;
        const handler = (ev) => callback(ev && ev.error ? ev.error : ev);
        wgpu.addEventListener('uncapturederror', handler);
        return () => { try { wgpu.removeEventListener('uncapturederror', handler); } catch (_) { /* noop */ } };
      } catch (_) { return null; }
    },

    /* GPU 错误作用域：把「本作用域内产生的错误」与「全局未捕获错误」分开。
       贴花用它做归因 —— 只有贴花自己绘制时产生的错误才允许触发降级，
       引擎其它 mesh 的 pipeline 失效（例如窗口尺寸变化后重建 VertexState）
       不再连带把贴花全隐藏。 */
    beginGpuErrorScope() {
      try {
        const wgpu = device && device.wgpu;
        if (!wgpu || typeof wgpu.pushErrorScope !== 'function') return false;
        wgpu.pushErrorScope('validation');
        return true;
      } catch (_) { return false; }
    },

    endGpuErrorScope(callback) {
      try {
        const wgpu = device && device.wgpu;
        if (!wgpu || typeof wgpu.popErrorScope !== 'function') return false;
        wgpu.popErrorScope().then((err) => {
          if (typeof callback === 'function') {
            callback(err ? (err.message || String(err)) : null);
          }
        }).catch(() => { if (typeof callback === 'function') callback(null); });
        return true;
      } catch (_) { return false; }
    },

    // ---- B. 场景与相机 ----
    getScene() { return app ? app.scene : null; },

    getCameraEntity() {
      if (getCameraEntity) return getCameraEntity();
      const cam = app && app.root ? app.root.findComponent('camera') : null;
      return cam && cam.entity ? cam.entity : null;
    },

    getCameraPosition() {
      const e = adapter.getCameraEntity();
      if (!e || typeof e.getPosition !== 'function') return [0, 0, 0];
      const p = e.getPosition();
      return p ? [p.x, p.y, p.z] : [0, 0, 0];
    },

    getCameraInverseViewProjection() {
      const e = adapter.getCameraEntity();
      const cam = e && e.camera;
      if (!cam) return null;
      // mul2(proj, view) = projection × view，与引擎 getWorldPoint 的数学一致
      const inv = new P.Mat4().mul2(cam.projectionMatrix, cam.viewMatrix).invert();
      return Float32Array.from(inv.data);
    },

    getCameraNearFar() {
      const e = adapter.getCameraEntity();
      const cam = e && e.camera;
      return cam ? [cam.nearClip, cam.farClip] : [0.1, 1000];
    },

    // ---- C. 材质与着色器 ----
    createShaderMaterial(spec) {
      if (!P || !P.ShaderMaterial) return null;
      const m = new P.ShaderMaterial();
      m.shaderDesc = {
        uniqueName: spec.name || 'DecalProjection',
        vertexGLSL: spec.vertexGLSL,
        vertexWGSL: spec.vertexWGSL,
        fragmentGLSL: spec.fragmentGLSL,
        fragmentWGSL: spec.fragmentWGSL,
        attributes: spec.attributes || { vertex_position: P.SEMANTIC_POSITION }
      };
      m.update();
      return m;
    },

    setMaterialParameter(material, name, value) {
      if (!material) return;
      material.setParameter(name, value);
    },

    destroyMaterial(material) {
      if (!material) return;
      try { material.destroy(); } catch (_) { /* noop */ }
    },

    setMaterialBlendState(material, state = {}) {
      if (!material) return;
      const blend = state.blend || 'normal';
      material.blendType = blend === 'none' ? P.BLEND_NONE : P.BLEND_NORMAL;
      material.cull = state.cull === false ? P.CULLFACE_NONE : P.CULLFACE_NONE;
      material.depthTest = state.depthTest !== false;
      material.depthWrite = state.depthWrite === true;
    },

    // ---- D. 纹理与视频 ----
    createCanvasTexture(options = {}) {
      if (!P || !P.Texture) return null;
      const fmtMap = {
        rgba8: P.PIXELFORMAT_RGBA8,
        rgba16f: P.PIXELFORMAT_RGBA16F,
        rgba32f: P.PIXELFORMAT_RGBA32F
      };
      const filterMap = {
        nearest: P.FILTER_NEAREST,
        linear: P.FILTER_LINEAR
      };
      const addrMap = {
        clamp: P.ADDRESS_CLAMP_TO_EDGE,
        repeat: P.ADDRESS_REPEAT
      };
      const tex = new P.Texture(device, {
        name: options.name || 'decal-texture',
        width: options.width || 2,
        height: options.height || 2,
        format: fmtMap[options.format] || P.PIXELFORMAT_RGBA8,
        mipmaps: options.mipmaps === true,
        minFilter: filterMap[options.filter] || P.FILTER_LINEAR,
        magFilter: filterMap[options.filter] || P.FILTER_LINEAR,
        addressU: addrMap[options.address] || P.ADDRESS_CLAMP_TO_EDGE,
        addressV: addrMap[options.address] || P.ADDRESS_CLAMP_TO_EDGE
      });
      return tex;
    },

    updateCanvasTexture(texture, source) {
      if (!texture || !source) return;
      try { texture.setSource(source); } catch (_) { /* noop */ }
    },

    getTextureSize(texture) {
      if (!texture) return [0, 0];
      return [texture.width || 0, texture.height || 0];
    },

    getTextureFormat(texture) {
      if (!texture) return null;
      const P = getPc();
      if (!P) return null;
      const fmt = texture.format;
      if (fmt === P.PIXELFORMAT_RGBA16F) return 'rgba16f';
      if (fmt === P.PIXELFORMAT_RGBA32F) return 'rgba32f';
      if (fmt === P.PIXELFORMAT_RGBA8) return 'rgba8';
      return 'unknown';
    },

    destroyTexture(texture) {
      if (!texture) return;
      try { texture.destroy(); } catch (_) { /* noop */ }
    },

    // ---- E. 几何与绘制 ----
    createFullscreenQuad() {
      if (!P || !P.Mesh || !P.GraphNode) return null;
      const mesh = new P.Mesh(device);
      /* 顶点流的分量数必须与 shader 的 attribute 声明一致（2 分量），
         否则真实 GPU 上 WebGPU 的 VertexState 校验会丢弃 slot 0：
         「Vertex attribute slot 0 used in vertexMain is not present in
          the VertexState」→ 贴花 pipeline 整个无效，一个像素都不出。
         引擎自己的 createFullscreenMesh 同样是 setPositions(Float32Array, 2)。
         注意：SwiftShader 对此校验宽松，headless 探针看不出问题，必须真机验。 */
      mesh.setPositions(new Float32Array([
        -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5
      ]), 2);
      mesh.update(P.PRIMITIVE_TRISTRIP);
      const node = new P.GraphNode('DecalProjection');
      node.setLocalScale(2, -2, 1);
      node.getWorldTransform();
      return { mesh, node };
    },

    createRenderable(mesh, material, node) {
      if (!P || !P.MeshInstance || !mesh || !material) return null;
      const mi = new P.MeshInstance(mesh, material, node);
      mi.cull = false;
      mi.castShadow = false;
      mi.receiveShadow = false;
      mi.pick = false;
      mi.visible = false;
      return mi;
    },

    addRenderable(renderable) {
      const layer = app && app.scene ? app.scene.defaultDrawLayer : null;
      if (!renderable || !layer) return;
      try { layer.addMeshInstances([renderable], true); } catch (_) { /* noop */ }
    },

    removeRenderable(renderable) {
      if (!renderable) return;
      try {
        const layer = app && app.scene ? app.scene.defaultDrawLayer : null;
        if (layer) layer.removeMeshInstances([renderable], true);
      } catch (_) { /* noop */ }
      try { renderable.destroy(); } catch (_) { /* noop */ }
    },

    setRenderableVisible(renderable, visible) {
      if (!renderable) return;
      renderable.visible = !!visible;
    },

    // ---- F. 拾取与数学 ----
    getDepthPickView() {
      if (!getPickView) return null;
      const pv = getPickView();
      if (!pv || !pv.texture) return null;
      return {
        texture: pv.texture,
        width: pv.texture.width || 1,
        height: pv.texture.height || 1,
        renders: typeof pv.renders === 'number' ? pv.renders : 0
      };
    },

    getPickingBackend() { return getPickView ? 'playcanvas-picker' : 'none'; },

    setRenderableFlags(renderable, flags = {}) {
      if (!renderable) return;
      if ('castShadow' in flags) renderable.castShadow = !!flags.castShadow;
      if ('receiveShadow' in flags) renderable.receiveShadow = !!flags.receiveShadow;
      if ('pick' in flags) renderable.pick = !!flags.pick;
      if ('cull' in flags) renderable.cull = !!flags.cull;
    },

    composeRigidMatrix(position, quaternion) {
      if (!P || !P.Mat4 || !P.Quat || !P.Vec3) return null;
      if (!Array.isArray(position) || !Array.isArray(quaternion)) return null;
      const q = new P.Quat(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
      // 引擎的 Mat4 没有 setFromQuat（那是 Mat3 / Quat 的 API），只有 setTRS。
      // 旧写法在 onPrerender 里每帧抛 TypeError，直接从 app.fire('prerender')
      // 冒泡中断 app.render()，整个 3DGS 主帧画不出来 —— 表现为进入编辑即黑屏。
      const m = new P.Mat4().setTRS(
        new P.Vec3(position[0], position[1], position[2]), q, new P.Vec3(1, 1, 1)
      );
      return Float32Array.from(m.data);
    },

    invertMatrix(matrix) {
      if (!P || !P.Mat4 || !matrix || matrix.length !== 16) return null;
      const m = new P.Mat4();
      m.data.set(matrix);
      const inv = m.clone().invert();
      // PlayCanvas 的 invert() 对奇异矩阵会写入全 0；此时判定失败
      let sum = 0;
      for (let i = 0; i < 16; i++) sum += Math.abs(inv.data[i]);
      if (!Number.isFinite(sum) || sum < 1e-12) return null;
      return Float32Array.from(inv.data);
    },

    rotateVectorByQuaternion(vector, quaternion) {
      if (!P || !P.Quat || !P.Vec3) return [0, 0, 1];
      if (!Array.isArray(vector) || !Array.isArray(quaternion)) return [0, 0, 1];
      const q = new P.Quat(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
      const out = new P.Vec3();
      q.transformVector(new P.Vec3(vector[0], vector[1], vector[2]), out);
      return [out.x, out.y, out.z];
    }
  };

  return createEngineAdapter(adapter, {
    onMissing: (missing) => {
      console.warn('[engine-adapter] PlayCanvas 适配器缺失契约方法：', missing.join(', '));
    }
  });
}

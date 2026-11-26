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

  /* Pass1 深度相机默认关闭（静态场景只需在 projector 变化时渲一次），
     渲染完成的下一帧由这里关掉，避免每帧重画碰撞 mesh 把 GPU 拖垮。 */
  const pendingDepthPasses = new Set();
  if (app && typeof app.on === 'function') {
    app.on('frameend', () => {
      for (const pass of pendingDepthPasses) {
        pass.framesLeft--;
        if (pass.framesLeft <= 0) {
          try { pass.camera.camera.enabled = false; } catch (_) { /* noop */ }
          pendingDepthPasses.delete(pass);
          // 主画面必须在 Pass1 之后重绘一次，否则编辑态留在离屏 RT 上（黑屏）
          app.renderNextFrame = true;
        }
      }
    });
  }

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

    /* 主相机这一帧的 proj × view（列主序 + 列向量）。CPU 光栅化碰撞 mesh 深度时
       必须和 3DGS 采样同口径，所以直接用引擎刚渲染完帧里的那两份矩阵。
       用 copy + mul 而不是 mul2(a, b)：这个构建的矩阵实现曾在离屏通道里产出过
       垃圾矩阵（贴花 / mesh 深度整片空的真凶之一），copy+mul 是验证过的写法。 */
    getCameraViewProjection() {
      const e = adapter.getCameraEntity();
      const cam = e && e.camera;
      if (!cam || !P || !P.Mat4) return null;
      try {
        const vp = new P.Mat4();
        vp.copy(cam.projectionMatrix);
        vp.mul(cam.viewMatrix);
        return Float32Array.from(vp.data);
      } catch (_) { return null; }
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
      if (P.PIXELFORMAT_R32F !== undefined && fmt === P.PIXELFORMAT_R32F) return 'r32f';
      return 'unknown';
    },

    /* CPU 数据纹理：shadowmap 深度图用 R32F，逐纹素写一个归一化深度。
       PlayCanvas 的标准更新路径是 texture.lock().set(typedArray) + unlock()，
       引擎自身的灯光/聚簇纹理（index.js 23410/23634）正是这么做的。 */
    createDataTexture(options = {}) {
      if (!P || !P.Texture) return null;
      const fmtMap = { r32f: P.PIXELFORMAT_R32F, rgba8: P.PIXELFORMAT_RGBA8 };
      const fmt = fmtMap[options.format] != null ? fmtMap[options.format] : P.PIXELFORMAT_R32F;
      const filterMap = { nearest: P.FILTER_NEAREST, linear: P.FILTER_LINEAR };
      const flt = filterMap[options.filter] != null ? filterMap[options.filter] : P.FILTER_NEAREST;
      const tex = new P.Texture(device, {
        name: options.name || 'decal-data-texture',
        width: Math.max(1, options.width || 1),
        height: Math.max(1, options.height || 1),
        format: fmt,
        mipmaps: false,
        minFilter: flt, magFilter: flt,
        addressU: P.ADDRESS_CLAMP_TO_EDGE,
        addressV: P.ADDRESS_CLAMP_TO_EDGE
      });
      return tex;
    },

    updateDataTexture(texture, data) {
      if (!texture || !data) return;
      try {
        const dst = texture.lock();
        dst.set(data);
        texture.unlock();
      } catch (_) { /* noop */ }
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

    createSceneNode(name) {
      if (!P || !P.GraphNode) return null;
      return new P.GraphNode(name || 'DecalNode');
    },

    createMesh(positions, indices, componentCount) {
      if (!P || !P.Mesh || !positions) return null;
      try {
        const mesh = new P.Mesh(device);
        mesh.setPositions(positions, componentCount || 3);
        if (indices) mesh.setIndices(indices);
        mesh.update(P.PRIMITIVE_TRIANGLES);
        return mesh;
      } catch (_) { return null; }
    },

    destroyMesh(mesh) {
      if (!mesh) return;
      try { mesh.destroy(); } catch (_) { /* noop */ }
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
    },

    // ---- G. 深度预通道（Shadow-Map Decal Pass1）----
    // 规格要求：从虚拟正交相机渲染「场景本身」到深度纹理。优先走 bundle 暴露的
    // 3DGS 深度入口（同源，消除跨源椒盐）；不可用时回退到碰撞 mesh depth-only pass。
    createDepthPass(options = {}) {
      if (!app || !device) return null;
      const size = Array.isArray(options.size) ? options.size : [256, 256];
      const w = Math.max(4, Math.floor(size[0]));
      const h = Math.max(4, Math.floor(size[1]));
      const name = options.name || 'decal-shadow';
      const getProjDepth = app.__mgProjectorDepth;
      if (typeof getProjDepth === 'function') {
        try {
          const rd = getProjDepth();
          if (rd) {
            return {
              useGsplat: true, renderer: rd, size: w,
              texture: null, projVP: null, projector: null
            };
          }
        } catch (e) {
          console.warn('[decal-depth-pass] 3DGS 深度入口不可用，回退碰撞 mesh：' +
            (e && e.message || e));
        }
      }
      if (!P || !P.RenderTarget || !P.Entity || !P.Layer) return null;
      try {
        /* D32_FLOAT 深度纹理：PIXELFORMAT_DEPTH 在 WebGL2 = DEPTH_COMPONENT32F，
           WebGPU = depth32float（PlayCanvas 2.23.3 源码确认）。只有 depthBuffer、
           没有 colorBuffer → 合法 depth-only RenderTarget。 */
        const texture = new P.Texture(device, {
          name: name + '-depth', width: w, height: h,
          format: P.PIXELFORMAT_DEPTH, mipmaps: false,
          minFilter: P.FILTER_NEAREST, magFilter: P.FILTER_NEAREST,
          addressU: P.ADDRESS_CLAMP_TO_EDGE, addressV: P.ADDRESS_CLAMP_TO_EDGE
        });
        const target = new P.RenderTarget({
          depthBuffer: texture, samples: 1,
          origin: P.RENDERTARGET_ORIGIN_NATIVE, autoResolve: false
        });
        const layer = new P.Layer({
          name: name + '-layer', clearColorBuffer: false, clearDepthBuffer: true
        });
        app.scene.layers.push(layer);

        /* 颜色写掩码全关 + 深度测试/写入开 = depth-only pass（与引擎阴影 pass 同范式）。 */
        const material = new P.StandardMaterial();
        material.redWrite = false; material.greenWrite = false;
        material.blueWrite = false; material.alphaWrite = false;
        material.depthTest = true; material.depthWrite = true;
        material.cull = P.CULLFACE_NONE;
        material.update();

        const node = new P.GraphNode(name + '-geo');
        const camera = new P.Entity(name + '-cam', app);
        camera.addComponent('camera', {
          projection: P.PROJECTION_ORTHOGRAPHIC,
          nearClip: 0.01, farClip: 100,
          orthoHeight: 1, aspectRatio: 1,
          clearColorBuffer: false, clearDepthBuffer: true,
          renderTarget: target,
          priority: -100,
          layers: [layer.id]
        });
        app.root.addChild(camera);
        // 默认关闭：静态场景只在 projector 变化后渲一次，避免每帧重画碰撞 mesh
        camera.camera.enabled = false;

        return {
          texture, target, layer, material, node, camera,
          mesh: null, meshInstance: null, framesLeft: 0, projector: null
        };
      } catch (e) {
        console.warn('[decal-depth-pass] 创建失败：' + (e && e.message || e));
        return null;
      }
    },

    setDepthPassGeometry(pass, triangles) {
      if (!pass || !triangles || !P || !P.MeshInstance) return false;
      if (pass.useGsplat) {
        // 3DGS 深度源不需要碰撞 mesh：场景本身就是被渲染对象。
        pass.geometryReady = true;
        return true;
      }
      try {
        if (pass.meshInstance) {
          pass.layer.removeMeshInstances([pass.meshInstance], false);
          pass.meshInstance.destroy();
          pass.meshInstance = null;
        }
        if (pass.mesh) { pass.mesh.destroy(); pass.mesh = null; }
        const positions = triangles.positions;
        const indices = triangles.indices;
        if (!positions || !positions.length) return false;
        const mesh = new P.Mesh(device);
        mesh.setPositions(positions, 3);
        if (indices && indices.length) mesh.setIndices(indices);
        mesh.update(P.PRIMITIVE_TRIANGLES);
        const mi = new P.MeshInstance(mesh, pass.material, pass.node);
        mi.castShadow = false; mi.receiveShadow = false; mi.pick = false;
        mi.cull = false; mi.visible = true;
        pass.layer.addMeshInstances([mi], false);   // 不透明列表：depth-only pass
        pass.mesh = mesh; pass.meshInstance = mi;
        // 几何变了但相机没变也要重渲一次
        if (pass.projector) adapter.setDepthPassProjector(pass, pass.projector);
        return true;
      } catch (e) {
        console.warn('[decal-depth-pass] 几何更新失败：' + (e && e.message || e));
        return false;
      }
    },

    setDepthPassProjector(pass, projector) {
      if (!pass || !projector || !Array.isArray(projector.position) ||
          !Array.isArray(projector.quaternion) || !Array.isArray(projector.half)) return false;
      if (pass.useGsplat) {
        // 同步渲染一次：正交投影仪相机 -> 3DGS 深度纹理。静态场景只在 projector
        // 变化时渲染，热路径无额外开销。
        try {
          const res = pass.renderer.render(projector, pass.size);
          if (!res) return false;
          pass.texture = res.texture;
          pass.projVP = res.viewProj;
          pass.projector = projector;
          pass.framesLeft = 0; // 不需要 frameend 关相机（renderer 内部自己关）
          return true;
        } catch (e) {
          console.warn('[decal-depth-pass] 3DGS 深度渲染失败：' + (e && e.message || e));
          return false;
        }
      }
      try {
        const cam = pass.camera.camera;
        const pos = projector.position;
        const q = projector.quaternion;
        const half = projector.half;
        const nrm = adapter.rotateVectorByQuaternion([0, 0, 1], q);
        const up = adapter.rotateVectorByQuaternion([0, 1, 0], q);
        const margin = 1.0;
        const isPersp = projector.mode === 'persp';
        /* 两种视锥：
           · ortho：相机退到 OBB 背面（局部 -Z 一侧），正交视锥 = OBB 的 XY 范围；
           · persp：position 即光心，相机站在光心沿 +Z 看出去，竖直 fov 由
             「远平面半高 / 远距」反推，near/far 直接取 projector 的值。
           切换模式时两个模式的属性都要显式写一遍，避免上一次的模式残留。 */
        const nf = Math.max(0.02, Number(projector.near) || half[2] * 0.02);
        const ff = Math.max(nf + 0.05, Number(projector.far) || half[2]);
        const eye = isPersp
          ? new P.Vec3(pos[0], pos[1], pos[2])
          : new P.Vec3(
            pos[0] - nrm[0] * (half[2] + margin),
            pos[1] - nrm[1] * (half[2] + margin),
            pos[2] - nrm[2] * (half[2] + margin));
        const target = new P.Vec3(
          pos[0] + nrm[0] * (isPersp ? ff : half[2]),
          pos[1] + nrm[1] * (isPersp ? ff : half[2]),
          pos[2] + nrm[2] * (isPersp ? ff : half[2])
        );
        pass.camera.setPosition(eye);
        pass.camera.lookAt(target, new P.Vec3(up[0], up[1], up[2]));
        cam.projection = isPersp ? P.PROJECTION_PERSPECTIVE : P.PROJECTION_ORTHOGRAPHIC;
        cam.aspectRatio = Math.max(0.05, half[0] / Math.max(0.05, half[1]));
        if (isPersp) {
          cam.fov = Math.min(150, Math.max(2,
            2 * Math.atan2(Math.max(1e-4, half[1]), ff) * 180 / Math.PI));
          cam.nearClip = nf;
          cam.farClip = ff;
        } else {
          cam.orthoHeight = Math.max(0.05, half[1]);
          cam.nearClip = 0.01;
          cam.farClip = 2 * half[2] + 2 * margin + 2;
        }
        pass.projector = projector;
        cam.enabled = true;
        pass.framesLeft = 1;
        pendingDepthPasses.add(pass);
        app.renderNextFrame = true;
        return true;
      } catch (e) {
        console.warn('[decal-depth-pass] 投影仪更新失败：' + (e && e.message || e));
        return false;
      }
    },

    setDepthPassEnabled(pass, enabled) {
      if (!pass) return;
      if (pass.useGsplat) return; // 3DGS 深度源是同步渲染的，无相机常驻开关
      if (!pass.camera) return;
      try {
        pass.camera.camera.enabled = !!enabled;
        if (enabled) {
          pass.framesLeft = 1;
          pendingDepthPasses.add(pass);
          app.renderNextFrame = true;
        } else {
          pendingDepthPasses.delete(pass);
        }
      } catch (_) { /* noop */ }
    },

    getDepthPassTexture(pass) { return pass ? pass.texture : null; },

    getDepthPassViewProjection(pass) {
      if (!pass) return null;
      if (pass.useGsplat) return pass.projVP || null;
      if (!pass.camera || !P || !P.Mat4) return null;
      try {
        const cam = pass.camera.camera;
        const vp = new P.Mat4().mul2(cam.projectionMatrix, cam.viewMatrix);
        return Float32Array.from(vp.data);
      } catch (_) { return null; }
    },

    destroyDepthPass(pass) {
      if (!pass) return;
      pendingDepthPasses.delete(pass);
      if (pass.useGsplat) {
        // renderer 是共享单例（由 viewer 管理生命周期），这里只清引用，不销毁。
        pass.texture = null; pass.projVP = null; pass.renderer = null;
        return;
      }
      try {
        if (pass.meshInstance) pass.layer.removeMeshInstances([pass.meshInstance], false);
        if (pass.mesh) pass.mesh.destroy();
      } catch (_) { /* noop */ }
      try { pass.layer.destroy(); } catch (_) { /* noop */ }
      try { pass.camera.destroy(); } catch (_) { /* noop */ }
      try { pass.texture.destroy(); } catch (_) { /* noop */ }
      try { pass.target.destroy(); } catch (_) { /* noop */ }
      try { pass.material.destroy(); } catch (_) { /* noop */ }
    },

  };

  return createEngineAdapter(adapter, {
    onMissing: (missing) => {
      console.warn('[engine-adapter] PlayCanvas 适配器缺失契约方法：', missing.join(', '));
    }
  });
}

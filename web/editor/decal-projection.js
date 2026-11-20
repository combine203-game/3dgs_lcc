/**
 * 屏幕空间 / 投影式延迟贴花（Projected Deferred Decal）
 * ----------------------------------------------------------------
 * 参考游戏引擎 decals 的主流实现（Valve CS 弹痕、Unreal Decal Actor + DBuffer、
 * Unity DecalProjector）：用一个「投影机 OBB」+ 全屏后处理 shader，逐像素从
 * 真实渲染深度重建世界坐标，做盒内判定 + 背面剔除，再采样视频纹理叠加到画面上。
 *
 * 关键特性（区别于上一轮被否决的「重构 mesh 去贴合」方案）：
 *   - 零几何生成：不重建任何网格，只画一个全屏 quad；
 *   - 像素级贴合：每帧用 Picker 的实时表面深度重建世界点，因此无论模型表面
 *     如何起伏 / 被遮挡，贴花都精确贴在 splat 表面上，而不是浮在空中或卡在切平面上；
 *   - 不读场景颜色缓冲（WebGL/WebGPU 都不能采样正在写的帧缓冲）：直接把视频色
 *     以 BLEND_NORMAL 半透明叠到已经渲染好的 splat 帧上，等价于 emissive 投影。
 *
 * 深度来源：Picker.renderView() 返回的 RGBA16F 纹理，每个通道是一次随机试验的
 * 「最近存活归一化线性深度」，1.0 表示空（无表面）。shader 采用引擎同族口径
 * （5×5 邻域圆盘 13 texel × 4 次试验，取 30% 分位数，见 viewer/index.js 的
 * surfaceDepth），再按引擎 getWorldPoint 的同款数学重建世界坐标，因此投影机
 * （由引擎同款深度反算的世界点构造）与 shader 重建自洽，贴花天然对齐。
 *
 * 归一化基准：投影机 OBB 的 half 是「半长」（盒面 |L| = half）。shader 里
 * ln = L / (decalHalf * uBoxScale)，uBoxScale=1.0 时盒面 |ln|=1，整框都算命中；
 * uBoxScale=0.5 复现历史行为（只接受每轴内侧 1/4）——那正是「框线清楚、框内
 * 只有中间一小块」的根因。UV 映射为 u = ln.x*0.5+0.5，v 由 uVideoFlipY 控制
 * （默认翻转：canvas 视频纹理 flipY=false， shader 用 texelFetch 直取行号，
 *  不翻会让视频上下颠倒）。
 *
 * 防御式设计：适配器不可用（非真实渲染运行时 / headless mock）或 shader
 * 编译失败时，console.warn 并禁用，绝不抛出未捕获异常。
 *
 * 【引擎解耦】本模块不引用任何 PlayCanvas 专有类型。引擎访问全部走
 * web/engine/engine-adapter.js 的契约接口，由 web/engine/playcanvas-adapter.js
 * 提供实现。后续接入 Babylon.js / three.js 只需新增适配器，本模块零改动。
 */
import {
  DECAL_VERTEX_GLSL, DECAL_VERTEX_WGSL,
  DECAL_FRAGMENT_PREAMBLE_GLSL, DECAL_FRAGMENT_BODY_GLSL, DECAL_FRAGMENT_WGSL,
  DECAL_SHADOW_VERTEX_GLSL, DECAL_SHADOW_VERTEX_WGSL,
  DECAL_SHADOW_FRAGMENT_GLSL, DECAL_SHADOW_FRAGMENT_WGSL
} from '../engine/decal-shaders.js';
import { RENDER_HOOKS } from '../engine/engine-adapter.js';
import { projectorVolumeCorners } from './schema.js';

/** 投影机体积的 8 角点 → 立方体顶点/索引（Pass3 绘制几何）。
 *  顺序与 projectorVolumeCorners 一致：idx = ix*4 + iy*2 + iz。
 *  ortho = OBB；persp = 视锥台（近平面 0..3 / 远平面 4..7）——索引缓冲完全复用：
 *  「z- / z+」两个面就是视锥的近 / 远裁剪面，四条连接边就是视锥的四条棱。 */
export function projectorCubeGeometry(projector) {
  const corners = projectorVolumeCorners(projector);
  if (!corners || corners.length < 8) return null;
  const positions = new Float32Array(24);
  for (let i = 0; i < 8; i++) {
    positions[i * 3] = corners[i][0];
    positions[i * 3 + 1] = corners[i][1];
    positions[i * 3 + 2] = corners[i][2];
  }
  const indices = new Uint16Array([
    0, 1, 3, 0, 3, 2,   // x-
    4, 6, 7, 4, 7, 5,   // x+
    0, 4, 5, 0, 5, 1,   // y-
    2, 3, 7, 2, 7, 6,   // y+
    0, 2, 6, 0, 6, 4,   // z-
    1, 5, 7, 1, 7, 3    // z+
  ]);
  return { positions, indices };
}

/** 碰撞 mesh 的 SoA triangles → depth-only pass 需要的 flat 三角网格。
 *  只在 col 引用变化时重建，避免每帧复制几十万三角形。 */
export function flatCollisionTriangles(col) {
  const t = col && col.triangles;
  const n = t && Number.isFinite(t.count) ? Math.max(0, Math.floor(t.count)) : 0;
  if (!n) return null;
  const positions = new Float32Array(n * 9);
  const indices = new Uint32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const k = i * 9;
    positions[k] = t.v0x[i]; positions[k + 1] = t.v0y[i]; positions[k + 2] = t.v0z[i];
    positions[k + 3] = t.v1x[i]; positions[k + 4] = t.v1y[i]; positions[k + 5] = t.v1z[i];
    positions[k + 6] = t.v2x[i]; positions[k + 7] = t.v2y[i]; positions[k + 8] = t.v2z[i];
    indices[i * 3] = i * 3; indices[i * 3 + 1] = i * 3 + 1; indices[i * 3 + 2] = i * 3 + 2;
  }
  return { positions, indices };
}

/**
 * @param {object} opts
 * @param {object} opts.adapter         引擎适配器（engine-adapter 契约接口）
 * @param {() => Array} opts.getDecals   当前可见且带 projector 的 decal 注记列表
 * @returns {object} manager { enabled, sync, destroy }
 */
export function createDecalProjection({ adapter, getDecals, useShadowPass } = {}) {
  /* 运行期可调参数（面板/诊断可改）：
     boxScale  —— OBB 归一化基准。1.0 = 盒面 |ln|=1（整框命中，正确行为）；
                  0.5 复现历史行为（只命中每轴内侧 1/4，即「框线清楚、框内一小块」）。
                  保留 0.5 作为可回退开关，而不是把旧语义写死在 shader 里。
     depthMode —— 1 = 引擎同族口径（5×5 邻域 30% 分位）；0 = 单 texel 中位（性能兜底）。
     debugMode —— 0 正常；1 深度灰度；2 失败分类着色（红=XY 出盒，绿=Z 出盒，蓝=被剔除）。 */
  /* 紧急熔断：整屏闪烁（弱 GPU TDR）时，必须能在不改代码/不卸载模块的前提下
     立即停掉贴花驱动的永动渲染循环。两个入口：
       · URL 带 decal=0，或 sessionStorage.mg_decal_stop=1 —— 页面加载即关闭（止血）；
       · 运行时 __mgEditor.decalMgr.setOptions({renderEnabled:0}) —— 不刷新立即生效。
     关掉后 onFrameEnd 不再 requestRender / 不再上传纹理，GPU 立刻空载。 */
  let stoppedByEntry = false;
  try {
    stoppedByEntry = /(?:^|[?&])decal=0(?:&|$)/.test(
      (typeof location !== 'undefined' && location.search) || '') ||
      ((typeof sessionStorage !== 'undefined' && sessionStorage.getItem('mg_decal_stop')) === '1');
  } catch (_) { /* noop */ }
  const options = {
    boxScale: 1.0, depthMode: 1, debugMode: 0,
    /* ★ 2026-11-20 修订（真机/取证实测）：**默认关闭深度比较**，走 always-on-top。
       证据：本构建主画面由自定义高斯渲染器接管（引擎 gsplat meshInstance 被隐藏），
       Pass1 的 RenderPassPicker 渲不出任何 splat → 深度图全 1.0（空）→ shader 里
       `mapD >= 0.999999 → discard` 会把整块贴花全部丢弃。实测开启后投射差值为 0
       （只有包围盒、画面里没有视频），关闭后立刻恢复（Δ≈6.6）。
       depthTest=1 保留为可选：仅在引擎自带 splat pick 通道可用的构建里才成立；
       开启方式：URL ?depthTest=1 / sessionStorage mg_decal_depth='1' /
       setOptions({depthTest:1})。三段式几何（Pass3 AABB cube）与 OBB UV 仍默认启用。 */
    depthTest: (() => {
      try {
        if (/(?:^|[?&])depthTest=0(?:&|$)/.test((typeof location !== 'undefined' && location.search) || '')) return 0;
        if (/(?:^|[?&])depthTest=1(?:&|$)/.test((typeof location !== 'undefined' && location.search) || '')) return 1;
        const ss = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('mg_decal_depth') : null;
        if (ss === '1') return 1;
        if (ss === '0') return 0;
      } catch (_) {}
      return 0;
    })(),
    useShadowPass: (() => {
      if (Number.isFinite(Number(useShadowPass))) return Number(useShadowPass) ? 1 : 0;
      try {
        if (/(?:^|[?&])shadowPass=0(?:&|$)/.test((typeof location !== 'undefined' && location.search) || '')) return 0;
        if ((typeof sessionStorage !== 'undefined' && sessionStorage.getItem('mg_shadow_pass')) === '0') return 0;
      } catch (_) {}
      return 1;
    })(),
    shadowSize: 256,               // Pass1 深度纹理边长（正交投影，256² 足够）
    /* 视频纹理行序修正：投影机局部 +Y 指向框选区上方，而 PlayCanvas Texture
       默认 flipY=false（canvas 行0=图像顶部），texelFetch 的 v=0 取图像顶部，
       两者同向会让投射视频上下颠倒。1=翻转 v（默认）；0=回退旧（颠倒）行为。 */
    videoFlipY: 1,
    /* renderEnabled=0 是整屏闪烁的紧急熔断；默认 1 保持原行为。 */
    renderEnabled: stoppedByEntry ? 0 : 1,
    /* 贴花驱动的主渲染帧率上限。onFrameEnd 的 requestRender 是为了防止
       picker pass 破坏 framebuffer 后的「编辑黑屏」。恢复到无 GPU pass 基线
       的 30fps（用户确认机器性能没问题，闪烁真因是 error scope 逻辑竞态，非负载）。
       设 >=120 或 0 解除节流。 */
    maxFps: 30,
    /* 视频纹理上传节流（可选）：texture.setSource(canvas) 多数驱动上是同步上传。
       默认 0 = 不节流（恢复基线逐帧上传，保证视频流畅）；仅在确实需要降载时设
       15 之类的值。★ 闪烁真因是 error scope 竞态（见 endScope 修复），不是上传带宽。 */
    uploadFps: 0,
    /* 降噪三件套（默认全开）：PCF 软覆盖 + 法线夹角剔除 + 软 mask。
       normalCut=0.90 来自真实墙面法线 cos 分布（p5=0.935, min=0.712）：
       剔除约 2% 边缘掠射点，不误杀墙面主体（0.35 太松形同虚设，实测 0 剔除）。 */
    pcf: 1, normalCut: 0.90, softMask: 1
  };
  /* 【TDZ 修复】manager / warn 必须先于任何引用完成初始化：此前 manager 对象
     字面量直接引用了下方才 const 声明的 shadowPathSupported，且 stoppedByEntry
     分支又提前调用了下方才声明的 warn —— 两次 ReferenceError 会让
     createDecalProjection() 一进入就抛异常，被 editor.js 的 try/catch 吞掉后
     decalMgr 恒为 null，贴花彻底静默失效（真机表现：视频完全不投射）。 */
  const warn = (m) => console.warn('[decal-projection] ' + m);
  const numOr = (v, dflt) => (Number.isFinite(Number(v)) ? Number(v) : dflt);
  if (stoppedByEntry) warn('检测到 decal=0 / mg_decal_stop=1：贴花驱动渲染已熔断（GPU 空载），场景保持静态。');

  const manager = {
    enabled: false,
    shadowPathSupported: false,   // 占位：由下方能力探测完成后回填（避免 TDZ）
    instances: new Map(),     // id -> { material, renderable, video, texture, url, half, projector }
    destroy() {}
  };

  // ---- 适配器不可用（非真实渲染运行时 / headless mock）时安全降级 ----
  if (!adapter || typeof adapter.createShaderMaterial !== 'function' || !adapter.isReady()) {
    warn('引擎适配器未就绪（headless / mock 或非真实渲染运行时），GPU 贴花已禁用');
    return manager;
  }

  const isWebGPU = adapter.getBackendType ? adapter.getBackendType() === 'webgpu' : false;
  /* 标准 Shadow-Map Decal 三段式需要的引擎能力。缺任一项则回退旧全屏 quad 路径，
     绝不让贴花拖垮主渲染（历史铁律：叠加特效故障必须自隔离）。 */
  const shadowPathCapable = [
    'createDepthPass', 'setDepthPassGeometry', 'setDepthPassProjector',
    'getDepthPassTexture', 'getDepthPassViewProjection', 'destroyDepthPass',
    'createMesh', 'destroyMesh'
  ].every(k => typeof adapter[k] === 'function');
  /* 默认走旧全屏 quad 基线；只有显式 useShadowPass=1 且 adapter 支持时才走三段式。 */
  const shadowPathSupported = shadowPathCapable && !!options.useShadowPass;
  manager.shadowPathSupported = shadowPathSupported;   // 回填（供 editor.js 跳过 CPU 深度图）

  // 帧缓冲坐标 -> 左上原点屏幕 UV 的映射（WebGL 原点左下需翻转，WebGPU 原点左上无需）
  const UV_SIGN_Y = isWebGPU ? 1 : -1;
  const UV_OFFSET_Y = isWebGPU ? 0 : 1;

  const vertexGLSL = DECAL_VERTEX_GLSL;
  const vertexWGSL = DECAL_VERTEX_WGSL;
  const fragmentGLSL = DECAL_FRAGMENT_PREAMBLE_GLSL + DECAL_FRAGMENT_BODY_GLSL;
  const fragmentWGSL = DECAL_FRAGMENT_WGSL;

  // ---------------------------------------------------------------- 全屏 quad 实体（与 PickDepthOverlay 同范式）
  const quad = adapter.createFullscreenQuad();
  if (!quad) {
    warn('适配器无法创建全屏 quad，GPU 贴花已禁用');
    return manager;
  }
  const quadMesh = quad.mesh;
  const quadNode = quad.node;

  let shaderOk = true;
  function makeMaterial() {
    const m = adapter.createShaderMaterial({
      name: 'DecalProjection',
      vertexGLSL, vertexWGSL, fragmentGLSL, fragmentWGSL
    });
    if (!m) return null;
    adapter.setMaterialBlendState(m, {
      blend: 'normal', depthTest: false, depthWrite: false, cull: false
    });
    return m;
  }

  function makeShadowMaterial() {
    const m = adapter.createShaderMaterial({
      name: 'DecalShadowProjection',
      vertexGLSL: DECAL_SHADOW_VERTEX_GLSL, vertexWGSL: DECAL_SHADOW_VERTEX_WGSL,
      fragmentGLSL: DECAL_SHADOW_FRAGMENT_GLSL, fragmentWGSL: DECAL_SHADOW_FRAGMENT_WGSL
    });
    if (!m) return null;
    adapter.setMaterialBlendState(m, {
      blend: 'normal', depthTest: false, depthWrite: false, cull: false
    });
    return m;
  }

  // ---------------------------------------------------------------- 投影机矩阵工具（走适配器，无引擎专有类型）
  function mat4FromProjector(position, quaternion, half) {
    const m = adapter.composeRigidMatrix(position, quaternion);
    if (!m) return null;
    const inv = adapter.invertMatrix(m);
    if (!inv) return null;
    // 世界法向 = 本地 +Z 经旋转后的方向
    const normal = adapter.rotateVectorByQuaternion([0, 0, 1], quaternion);
    return { inv, normal, half };
  }

  // ---------------------------------------------------------------- 单个 decal 实例
  function createInstance(dec) {
    const useShadow = shadowPathSupported;
    const material = useShadow ? makeShadowMaterial() : makeMaterial();
    if (!material) return null;
    // shader 首行是 uPickReady < 0.5 时 discard。实例一创建就置 0，保证在
    // onPrerender 成功注入真实深度纹理之前，绝不输出任何像素盖黑 3DGS 画面。
    adapter.setMaterialParameter(material, 'uPickReady', 0);

    let mesh, node, cubeMesh = null;
    if (useShadow) {
      // 标准方案 Pass3：投影仪视锥 AABB 立方体（世界坐标），独立节点保持单位变换
      const cube = projectorCubeGeometry(dec.projector) || projectorCubeGeometry({
        position: [0, 0, 0], quaternion: [0, 0, 0, 1], half: [0.25, 0.25, 0.25]
      });
      cubeMesh = cube ? adapter.createMesh(cube.positions, cube.indices, 3) : null;
      mesh = cubeMesh;
      node = adapter.createSceneNode('DecalCube');
    } else {
      mesh = quadMesh; node = quadNode;
    }
    if (!mesh || !node) { adapter.destroyMaterial(material); return null; }
    const renderable = adapter.createRenderable(mesh, material, node);
    if (!renderable) {
      adapter.destroyMaterial(material);
      if (cubeMesh) adapter.destroyMesh(cubeMesh);
      return null;
    }
    adapter.setRenderableFlags(renderable, { castShadow: false, receiveShadow: false, pick: false, cull: false });
    adapter.setRenderableVisible(renderable, false);
    adapter.addRenderable(renderable);

    // 视频元素 + GPU 纹理
    const video = document.createElement('video');
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
    video.preload = 'auto';
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');

    const texture = adapter.createCanvasTexture({
      name: 'decal-video',
      width: DECAL_TEX_W, height: DECAL_TEX_H,
      format: 'rgba8',
      mipmaps: false,
      filter: 'linear',
      address: 'clamp'
    });
    // 初值即最终尺寸的内容：后续上传永不改变纹理尺寸（见 DECAL_TEX_W 注释）
    adapter.updateCanvasTexture(texture, drawDemoFrame(0));

    // 视频帧转绘画布：与纹理同尺寸，drawImage 到这里再上传，纹理永不重建
    const blitCanvas = document.createElement('canvas');
    blitCanvas.width = DECAL_TEX_W; blitCanvas.height = DECAL_TEX_H;
    const blitCtx = blitCanvas.getContext('2d');

    /* 旧路径才需要 CPU 填充的 R32F 深度图；标准方案用 GPU Pass1 的 D32_FLOAT 纹理。 */
    let shadowTex = null;
    if (!useShadow) {
      shadowTex = adapter.createDataTexture({
        name: 'decal-shadow-depth', width: 2, height: 2, format: 'r32f', filter: 'nearest'
      });
      if (shadowTex) adapter.updateDataTexture(shadowTex, new Float32Array([1, 1, 1, 1]));
    }

    const inst = {
      id: dec.id, material, renderable, video, texture, shadowTex,
      blitCanvas, blitCtx, node, cubeMesh,
      useShadow, depthPass: null, projVP: null, colRef: null, cubeKey: null, depthPassOk: false,
      url: null, half: [0.25, 0.25, 0.25], projector: null, shadow: null, opacity: 0.9, edge: 0.12, cull: 1,
      boxScale: options.boxScale, depthMode: options.depthMode, debugMode: options.debugMode,
      videoFlipY: options.videoFlipY,
      pcf: options.pcf, normalCut: options.normalCut, softMask: options.softMask,
      visible: false,
      videoErr: null
    };
    // 视频 URL 不可访问 / 跨域失败时必须有可观测信号，否则「只有包围盒没有视频」
    // 无从排查。错误记到实例上（debug() 可读）并 warn 一次。
    video.addEventListener('error', () => {
      inst.videoErr = 'code=' + (video.error && video.error.code) + ' src=' + (inst.url || '');
      warn('贴花视频加载失败（检查 URL 可访问性与 CORS）：' + inst.videoErr);
    });
    return inst;
  }

  // ---------------------------------------------------------------- 内置演示画面
  // 面板承诺「留空播放内置演示画面」，但此前的占位纹理是全透明的 —— 留空时
  // shader 里 vid.a=0 直接 discard，用户看到的就是「只有包围盒、没有视频」。
  // 这里补上真正的内置演示：动画条纹画布，逐帧上传，零外部资源。
  /* 固定纹理尺寸（1024×576）：绝不在运行期 resize。首次内容上传若改变纹理
     尺寸，引擎会销毁旧 GPU 纹理，而上一帧的在途 submit 还引用着它 ——
     Dawn 报 "Destroyed texture used in a submit"，整条 command buffer 提交
     失败（整屏黑 / 贴花消失）。视频与演示画面都先绘入同尺寸画布再上传。 */
  const DECAL_TEX_W = 1024, DECAL_TEX_H = 576;
  const demoCanvas = document.createElement('canvas');
  demoCanvas.width = DECAL_TEX_W; demoCanvas.height = DECAL_TEX_H;
  const demoCtx = demoCanvas.getContext('2d');
  function drawDemoFrame(now) {
    const w = demoCanvas.width, h = demoCanvas.height;
    const t = (now / 1000) % 4;
    // 亮色主题：暗色地面 / 墙面上都有强对比，投射内容一眼可见
    demoCtx.fillStyle = 'rgb(235,242,250)';
    demoCtx.fillRect(0, 0, w, h);
    demoCtx.strokeStyle = 'rgba(20,90,160,0.9)';
    demoCtx.lineWidth = 14;
    const step = 64, off = (t * 48) % step;
    for (let x = -h; x < w + h; x += step) {
      demoCtx.beginPath();
      demoCtx.moveTo(x + off, 0);
      demoCtx.lineTo(x + off + h, h);
      demoCtx.stroke();
    }
    demoCtx.strokeStyle = 'rgb(255,140,0)';
    demoCtx.lineWidth = 8;
    demoCtx.strokeRect(4, 4, w - 8, h - 8);
    demoCtx.fillStyle = 'rgb(200,40,20)';
    demoCtx.font = 'bold 30px sans-serif';
    demoCtx.fillText('DECAL DEMO', 24, 46);
    return demoCanvas;
  }

  function setVideoUrl(inst, url) {
    if (inst.url === url) return;
    inst.url = url || null;
    inst.videoErr = null;
    if (inst.url) {
      inst.video.src = inst.url;
      const p = inst.video.play();
      if (p && p.catch) p.catch(() => {/* 自动播放被拦截：静音循环通常允许 */});
    } else {
      inst.video.removeAttribute('src');
      inst.video.load();
    }
  }

  function destroyInstance(inst) {
    adapter.removeRenderable(inst.renderable);
    adapter.destroyMaterial(inst.material);
    adapter.destroyTexture(inst.texture);
    // 标准路径的深度纹理归 depthPass 所有；只有旧 CPU 路径单独持有 shadowTex
    if (!inst.useShadow && inst.shadowTex) adapter.destroyTexture(inst.shadowTex);
    if (inst.cubeMesh) adapter.destroyMesh(inst.cubeMesh);
    if (inst.depthPass) adapter.destroyDepthPass(inst.depthPass);
    try { inst.video.pause(); inst.video.removeAttribute('src'); inst.video.load(); } catch (_) {}
  }

  // ---------------------------------------------------------------- shadowmap 深度图同步
  /* 深度图尺寸变化时重建纹理（引擎纹理尺寸固定）。上传一次即可静态复用。 */
  function syncShadow(inst, shadow) {
    inst.shadow = shadow || null;
    if (!shadow || !shadow.depth || !shadow.size) {
      if (inst.shadowTex) {
        try { adapter.updateDataTexture(inst.shadowTex, new Float32Array([1, 1, 1, 1])); } catch (_) {}
      }
      return;
    }
    const [w, h] = shadow.size;
    const sz = adapter.getTextureSize ? adapter.getTextureSize(inst.shadowTex) : [0, 0];
    if (sz[0] !== w || sz[1] !== h) {
      if (inst.shadowTex) adapter.destroyTexture(inst.shadowTex);
      inst.shadowTex = adapter.createDataTexture({
        name: 'decal-shadow-depth', width: w, height: h, format: 'r32f', filter: 'nearest'
      });
    }
    /* 兼容刷新后的 JSON 文档：depth 从 Float32Array 变成普通数组/对象，
       texture.lock() 返回的 typed array 不接受普通对象。统一转成 Float32Array。 */
    let data = shadow.depth;
    if (data && !ArrayBuffer.isView(data)) {
      if (Array.isArray(data) || Number.isFinite(data.length)) {
        const len = Number(data.length) || 0;
        data = Float32Array.from({ length: len }, (_, i) => Number(data[i]) || 0);
      }
    }
    if (inst.shadowTex && data) adapter.updateDataTexture(inst.shadowTex, data);
  }

  /* 标准三段式 Pass1 同步：projector 变化时重建 OBB 立方体，并让 depth-only 相机
     渲一次碰撞 mesh。深度纹理由 GPU 生成，shader 与它同源比较（不再是跨源射线图）。 */
  function rebuildCube(inst, projector) {
    const geo = projectorCubeGeometry(projector);
    if (!geo) return false;
    const newMesh = adapter.createMesh(geo.positions, geo.indices, 3);
    if (!newMesh) return false;
    if (inst.renderable) adapter.removeRenderable(inst.renderable);
    if (inst.cubeMesh) adapter.destroyMesh(inst.cubeMesh);
    inst.cubeMesh = newMesh;
    inst.renderable = adapter.createRenderable(newMesh, inst.material, inst.node);
    if (!inst.renderable) return false;
    adapter.setRenderableFlags(inst.renderable, { castShadow: false, receiveShadow: false, pick: false, cull: false });
    adapter.setRenderableVisible(inst.renderable, !!inst.visible);
    adapter.addRenderable(inst.renderable);
    return true;
  }

  function syncShadowPass(inst, projector) {
    /* 深度比较关闭（默认 always-on-top）：绝不启动/重渲 Pass1 深度相机。
       ★ 这是「缩放包围盒黑屏闪烁」的根治：开启 Pass1 时每次 projector 变化都会
         setDepthPassProjector → cam.enabled=true + renderNextFrame → 每帧重渲几十万
         三角碰撞 mesh → 弱 GPU TDR。默认路径 UV 用 OBB 局部坐标，根本不需要深度图。
       这里只同步 Pass3 的 AABB cube 几何（便宜，纯 CPU 算 8 角）。 */
    if (!options.depthTest) {
      if (inst.depthPass) adapter.setDepthPassEnabled(inst.depthPass, false);
      if (!projector) return;
      // mode / near 也进 key：透视视锥改 fov 或近平面时 half 可能不变（far 不变），
      // 但体几何的近平面截面要跟着变，否则线框与 Pass1 视锥对不上。
      const key = JSON.stringify([projector.position, projector.quaternion, projector.half,
        projector.mode || 'ortho', projector.near, projector.far]);
      if (key !== inst.cubeKey && rebuildCube(inst, projector)) inst.cubeKey = key;
      return;
    }
    if (!projector) {
      if (inst.depthPass) adapter.setDepthPassEnabled(inst.depthPass, false);
      return;
    }
    if (!inst.depthPass) {
      const sz = Math.max(4, Math.floor(options.shadowSize || 256));
      inst.depthPass = adapter.createDepthPass({ size: [sz, sz], name: 'decal-' + inst.id });
    }
    if (!inst.depthPass) return;

    /* ★ 2026-11-20：Pass1 深度源分两条（用户定稿：默认同源 3DGS） */
    if (inst.depthPass.useGsplat) {
      // 3DGS 路径：深度图由正交相机渲染 3DGS 本身得到，不需要碰撞 mesh。
      // depthPassOk 由「深度渲染成功」驱动：失败则自动回退 always-on-top（视频仍可见）。
      try { inst.depthPassOk = !!adapter.setDepthPassProjector(inst.depthPass, projector); }
      catch (_) { inst.depthPassOk = false; }
      if (inst.depthPassOk) {
        inst.shadowTex = adapter.getDepthPassTexture(inst.depthPass);
        inst.projVP = adapter.getDepthPassViewProjection(inst.depthPass) || inst.projVP;
      }
    } else {
      /* ★ 修订：碰撞 mesh 回退与 shader 口径不兼容 —— 它写的是 D32 深度纹理
         （单通道、按深度附件采样），而 Pass3 的 FS 按「RGBA16F 4 通道伯努利试验
         + 3×3 邻域 30% 分位」解码。两者混用会让 mapD 恒≈0 或绑定类型非法，
         表现为整块贴花被丢光。这里直接禁用该分支并明确告警，不再假装支持。 */
      inst.depthPassOk = false;
      inst.shadowTex = null;
      inst.projVP = null;
      if (!inst.collisionFallbackWarned) {
        inst.collisionFallbackWarned = true;
        warn('Pass1 3DGS 深度入口不可用，碰撞 mesh 深度图与 Pass3 解码口径不兼容，' +
          '深度比较已跳过（贴花按 always-on-top 正常显示）');
      }
      adapter.setDepthPassEnabled(inst.depthPass, false);
    }
    const key = JSON.stringify([projector.position, projector.quaternion, projector.half,
      projector.mode || 'ortho', projector.near, projector.far]);
    if (key !== inst.cubeKey) {
      if (rebuildCube(inst, projector)) inst.cubeKey = key;
    }
  }

  // ---------------------------------------------------------------- 同步 decal 列表 -> 实例
  function sync(decals) {
    if (!shaderOk) return;
    const next = new Set();
    for (const dec of (decals || [])) {
      next.add(dec.id);
      let inst = manager.instances.get(dec.id);
      if (!inst) {
        inst = createInstance(dec);
        if (!inst) continue;               // 适配器创建失败：跳过本条，不影响其余
        manager.instances.set(dec.id, inst);
      }
      setVideoUrl(inst, dec.videoUrl);
      const pr = dec.projector;
      // 校验投影机数据：half 含 0 / NaN 会让 shader 里 ln = L / decalHalf 除零，
      // 判定退化为「整屏都在盒内」，全屏 quad 把画面盖掉。数据不合法时宁可不显示。
      const valid = pr &&
        Array.isArray(pr.position) && pr.position.length === 3 &&
        Array.isArray(pr.quaternion) && pr.quaternion.length === 4 &&
        Array.isArray(pr.half) && pr.half.length === 3 &&
        pr.half.every(h => Number.isFinite(h) && h > 0) &&
        [...pr.position, ...pr.quaternion].every(Number.isFinite);
      if (valid) {
        inst.projector = pr;
        inst.half = pr.half;
        // 标准三段式优先；引擎不支持 depth-only pass 时回退旧 CPU 深度图路径
        if (inst.useShadow) syncShadowPass(inst, pr);
        else syncShadow(inst, dec.shadow);
      } else {
        inst.projector = null;
        if (inst.useShadow) syncShadowPass(inst, null);
        else syncShadow(inst, null);
      }
      inst.opacity = Number(dec.opacity ?? 0.9);
      inst.edge = Number(dec.edge ?? 0.12);
      inst.cull = dec.cull === false ? 0 : 1;
      // 运行期可覆盖项：归一化基准 / 深度采样口径 / 调试模式
      inst.boxScale = numOr(dec.boxScale, options.boxScale);
      inst.depthMode = numOr(dec.depthMode, options.depthMode);
      inst.debugMode = numOr(dec.debugMode, options.debugMode);
      inst.videoFlipY = numOr(dec.videoFlipY, options.videoFlipY);
      // 降噪三件套：可由注记或 setOptions 覆盖（pcf/softMask 0|1，normalCut 为 dot 下限）
      inst.pcf = numOr(dec.pcf, options.pcf);
      inst.normalCut = numOr(dec.normalCut, options.normalCut);
      inst.softMask = numOr(dec.softMask, options.softMask);
      // pick 纹理行序覆盖（诊断用；未设置时按后端默认）
      if (dec.pickFlipY !== undefined && dec.pickFlipY !== null) inst.pickFlipY = !!dec.pickFlipY;
      adapter.setRenderableVisible(inst.renderable, !!dec.visible && !!inst.projector && !degraded);
      inst.visible = !!dec.visible && !!inst.projector && !degraded;
    }
    // 删除已不存在的
    for (const [id, inst] of manager.instances) {
      if (!next.has(id)) { destroyInstance(inst); manager.instances.delete(id); }
    }
  }

  // ---------------------------------------------------------------- 每帧更新 uniform
  // 占位 pick 纹理：1×1 RGBA8，通道全 255 → nd 最小值 = 1.0 → shader 直接 discard。
  // 真实 pick 纹理就绪前也始终绑定一个合法纹理，避免把 null 绑到 sampler 上。
  const pickPlaceholder = adapter.createCanvasTexture({
    name: 'decal-pick-placeholder', width: 1, height: 1,
    format: 'rgba8', mipmaps: false, filter: 'nearest', address: 'clamp'
  });
  const _phCanvas = document.createElement('canvas');
  _phCanvas.width = 1; _phCanvas.height = 1;
  const _phCtx = _phCanvas.getContext('2d');
  _phCtx.fillStyle = 'rgb(255,255,255)';
  _phCtx.fillRect(0, 0, 1, 1);
  adapter.updateCanvasTexture(pickPlaceholder, _phCanvas);

  let pickTexture = pickPlaceholder, pickSize = [1, 1], pickReady = false, pickRenders = -1;

  /* 帧率节流（防整屏闪烁）：编辑态的 requestRender 链本是无意的 60fps 永动满载。
     直接在 frameend 里跳过 requestRender 会断掉按需渲染链（画面永久停止），
     所以未到节流点时用一个 setTimeout 补帧，保证链不断、实际帧率 <= maxFps。
     弱 GPU 渲染耗时本身 > 间隔时，frameend 的 elapsed 自然 >= interval → 立即
     请求下一帧，不会二次加速，最终帧率取 min(maxFps, 硬件上限)。 */
  let lastRenderReq = 0;
  let makeupTimer = null;
  function requestThrottled() {
    const cap = Number(options.maxFps);
    const interval = (Number.isFinite(cap) && cap > 0 && cap < 120) ? (1000 / cap) : 0;
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (!interval) {   // 解除节流（maxFps>=120 或 0）：恢复旧的全速行为
      if (makeupTimer) { clearTimeout(makeupTimer); makeupTimer = null; }
      lastRenderReq = now;
      adapter.requestRender();
      return;
    }
    const elapsed = now - lastRenderReq;
    if (elapsed >= interval - 1) {
      if (makeupTimer) { clearTimeout(makeupTimer); makeupTimer = null; }
      lastRenderReq = now;
      adapter.requestRender();
    } else if (!makeupTimer) {
      makeupTimer = setTimeout(() => {
        makeupTimer = null;
        if (!options.renderEnabled) return;
        lastRenderReq = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        adapter.requestRender();
      }, Math.max(1, interval - elapsed));
    }
  }

  /* 纹理上传节流：独立于 requestRender 的帧率。即使主渲染因节流降到 15fps，
     仍可能每个实例都 setSource 一张 1024×576 canvas；多个投影矩形时带宽叠加。
     这里按上传时刻节流，未达间隔的帧沿用上一帧纹理内容（GPU 完全不上传）。 */
  let lastTexUpload = 0;
  function uploadDue() {
    const cap = Number(options.uploadFps);
    if (!Number.isFinite(cap) || cap <= 0 || cap >= 120) return true;  // 解除节流
    const interval = 1000 / cap;
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (now - lastTexUpload >= interval - 1) { lastTexUpload = now; return true; }
    return false;
  }

  let pickWarned = false;
  function onFrameEnd() {
    /* 紧急熔断（整屏闪烁止血）：renderEnabled=0 时既不上传纹理也不请求下一帧，
       彻底断开「frameend → requestRender → 下一帧 → frameend」的永动循环，
       GPU 立即空载。不做 endScope：熔断期间没有贴花提交，无需错误归因。 */
    if (!options.renderEnabled) return;
    // 结束贴花错误作用域：本帧的错误会在 popErrorScope 的回调里归因
    endScope();
    // 复测帧结束：恢复贴花显示（下一帧 onPrerender 会按状态重新同步）
    if (probeDecalsOff) {
      probeDecalsOff = false;
      setDecalsVisible(true);
    }
    let pv = null;
    try {
      pv = adapter.getDepthPickView();
    } catch (e) {
      // 引擎 Picker 的 shader chunk patch 在版本不匹配时会抛错。不能让它从
      // 帧尾钩子冒泡进引擎主循环：那会打断帧尾状态，并每帧重复抛。
      if (!pickWarned) {
        pickWarned = true;
        warn('pickView 获取失败，已跳过 GPU 贴花深度更新：' + (e?.message || e));
      }
    }
    if (pv && pv.texture && typeof pv.renders === 'number' && pv.renders !== pickRenders) {
      pickRenders = pv.renders;
      pickTexture = pv.texture;
      pickSize = [pv.width || 1, pv.height || 1];
      pickReady = true;
    }
    // Pass1 渲染完成后刷新投影仪 ViewProj（相机矩阵此时最可靠）
    for (const inst of manager.instances.values()) {
      if (inst.useShadow && inst.depthPass) {
        const vp = adapter.getDepthPassViewProjection(inst.depthPass);
        if (vp) inst.projVP = vp;
      }
    }
    // 让视频纹理跟随最新帧上传（引擎对 video/canvas 源按帧重传）。
    // 有 URL 用视频（先绘入固定尺寸转绘画布，纹理永不重建）；URL 为空
    // 则上传内置演示画面（动画条纹）——「留空播放内置演示画面」是真实行为。
    // ★ 上传节流：setSource 是同步 GPU 上传，多个矩形叠加时是「添加矩形就闪」的
    //   主因；未到 uploadFps 间隔的帧完全跳过（复用上一帧纹理，画面无损）。
    if (uploadDue()) {
      for (const inst of manager.instances.values()) {
        const v = inst.video;
        if (inst.url && v && v.readyState >= 2 && v.videoWidth > 0) {
          try {
            inst.blitCtx.drawImage(v, 0, 0, DECAL_TEX_W, DECAL_TEX_H);
            adapter.updateCanvasTexture(inst.texture, inst.blitCanvas);
          } catch (_) {}
        } else if (!inst.url) {
          try { adapter.updateCanvasTexture(inst.texture, drawDemoFrame(performance.now())); } catch (_) {}
        }
      }
    }
    /* 关键：引擎 Picker 的 pick pass 会把 graphicsDevice 的 renderTarget 留在
       离屏 framebuffer、并把 clearColor 设成白色（farColor），且 endRenderPass
       不负责恢复。Viewer 首帧后已切按需渲染（autoRender=false），编辑态又只有
       一帧 renderNextFrame；若这里不显式再请求主帧，默认 framebuffer 永远不再
       重绘，3DGS 画面就此消失，只剩 #mg-stage 的深色底 —— 即「进入编辑黑屏」。
       每帧请求一次主帧，保证 backBuffer 始终被主渲染覆盖；经节流后 <= maxFps。 */
    requestThrottled();
  }

  let prerenderWarned = false;
  function onPrerender() {
    /* 熔断期间不喂任何贴花 uniform（renderable 由 setOptions 统一隐藏）。 */
    if (!options.renderEnabled) return;
    /* 复测帧：临时关掉贴花，看错误是否消失 —— 用来把「引擎自己的 pipeline 失效」
       与「贴花自己的故障」区分开，避免别人的错误把贴花全隐藏。 */
    if (suspicion && suspicion.probeNextFrame) {
      suspicion.probeNextFrame = false;
      probeDecalsOff = true;
      setDecalsVisible(false);
      beginScope();
      return;
    }
    probeDecalsOff = false;
    beginScope();
    // degraded = 已发生 GPU validation error，实例已全部隐藏，本帧不再喂 uniform
    if (degraded || !manager.instances.size) return;
    // prerender 钩子是从引擎渲染内部触发的：这里任何异常都会中断主帧
    // 渲染，让整个 3DGS 画面消失。贴花只是叠加特效，必须完全隔离故障。
    try {
      const invViewProj = adapter.getCameraInverseViewProjection();
      if (!invViewProj) return;
      const res = adapter.getRenderSize();
      const nearFar = adapter.getCameraNearFar();
      const camPos = adapter.getCameraPosition();

      for (const inst of manager.instances.values()) {
        if (!inst.renderable || !inst.visible) continue;
        const mat = inst.material;
        const setP = (k, v) => adapter.setMaterialParameter(mat, k, v);
        setP('pickDepth', pickTexture);
        setP('uPickSize', pickSize);
        setP('uPickReady', pickReady ? 1 : 0);
        setP('videoTex', inst.texture);
        setP('uVideoSize', adapter.getTextureSize(inst.texture));
        setP('invViewProj', invViewProj);
        setP('nearClip', nearFar[0]);
        setP('farClip', nearFar[1]);
        setP('uResolution', res);
        setP('uUVSignY', UV_SIGN_Y);
        setP('uUVOffsetY', UV_OFFSET_Y);
        // pick 快照纹理的行序：WebGPU 行0=顶部(1)，WebGL 行0=底部(0)。
        // inst.pickFlipY 可显式覆盖（诊断用：0/1 切换可验证行序判断是否正确）。
        setP('uPickFlipY', inst.pickFlipY != null ? (inst.pickFlipY ? 1 : 0) : (isWebGPU ? 1 : 0));
        setP('decalOpacity', inst.opacity);
        setP('decalEdge', inst.edge);
        setP('uCull', inst.cull);
        // 归一化基准：1.0 = 盒面 |ln|=1（整框命中，旧行为是 0.5 只命中内侧 1/4）
        setP('uBoxScale', inst.boxScale);
        // 深度口径：1 = 引擎同族 5×5 邻域 30% 分位；0 = 单 texel 中位（兜底）
        setP('uDepthMode', inst.depthMode);
        setP('uDebugMode', inst.debugMode);
        // 视频行序修正（默认 1）：canvas 纹理未 flipY，shader 侧翻 v
        setP('uVideoFlipY', inst.videoFlipY);
        // 相机世界位置：把深度差分重建的法向统一翻向可见侧
        setP('uCameraPos', camPos);

        /* 标准三段式 Pass3（AABB cube 几何）：
           · 默认 always-on-top：UV 走 OBB 局部坐标（invProjector/decalHalf），
             不启动 Pass1、不做深度比较 → 视频全部可见、缩放不闪。
           · 可选深度比较（depthTest=1）：才用 Pass1 的 D32_FLOAT 深度图 + uProjVP。 */
        if (inst.useShadow) {
          // ★ 无论深度比较开关如何，都必须注入 OBB 局部坐标 uniform：默认路径
          //   shader 用 invProjector*W 算投影 UV，缺它会让所有像素 UV=0 → 视频全丢。
          if (inst.projector) {
            const mp = mat4FromProjector(inst.projector.position, inst.projector.quaternion, inst.projector.half);
            if (mp) {
              setP('invProjector', mp.inv);
              setP('decalHalf', mp.half);
              setP('projectorNormal', mp.normal);
            }
            /* 透视视锥体开关：1 = 局部坐标按 L.z 做透视除法（uv 与 fov 自洽），
               0 = 原来的正交 OBB 归一化。near 用于近平面裁掉"光心背后/太近"的像素。
               ★ 这条路径不需要 Pass1：invProjector 是 CPU 由 position/quaternion
                 直接算的，与深度图无关，所以透视贴花在 depthTest=0 时也不会触发
                 深度重渲（不会缩放黑屏闪烁）。 */
            const isPersp = inst.projector.mode === 'persp';
            setP('uPersp', isPersp ? 1 : 0);
            setP('uProjNear', isPersp
              ? Math.max(0.01, Number(inst.projector.near) || (inst.projector.half[2] * 0.02))
              : 0);
          }
          // 深度比较仅在显式开启 + Pass1 真正装载几何 + projVP 就位时才开；
          // 默认（depthTest=0）恒为 0 → 完全不依赖 Pass1，视频始终在前。
          const canDepthTest = options.depthTest && inst.depthPassOk && !!inst.projVP;
          setP('uDepthTest', canDepthTest ? 1 : 0);
          setP('uShadowBias', 0.002);
          if (canDepthTest) {
            const shTex = inst.shadowTex ||
              (inst.depthPass && adapter.getDepthPassTexture(inst.depthPass));
            if (shTex) setP('shadowDepth', shTex);
            setP('uShadowSize', shTex ? adapter.getTextureSize(shTex) : [1, 1]);
            if (inst.projVP) setP('uProjVP', inst.projVP);
            // 法线点积剔除阈值（三段式 Pass3）；projectorNormal 已在上方 OBB 块注入
            setP('uNormalCut', inst.normalCut);
          }
          continue;
        }

        // ---- 旧路径 shadowmap uniform（有 CPU 有效深度图时）----
        const sh = inst.shadow;
        const shadowOn = !!(sh && sh.depth && sh.size && inst.shadowTex);
        setP('uShadowReady', shadowOn ? 1 : 0);
        if (shadowOn) {
          setP('shadowDepth', inst.shadowTex);
          setP('uShadowSize', sh.size);
          setP('uVirtualCam', sh.vcam);
          setP('uVirtualRight', sh.right);
          setP('uVirtualUp', sh.up);
          setP('uVirtualForward', [-sh.normal[0], -sh.normal[1], -sh.normal[2]]);
          setP('uVirtualHalf', [inst.half[0], inst.half[1]]);
          setP('uVirtualFar', sh.far);
          setP('uShadowBias', 0.05);   // 归一化深度容差（真机验证 P90≈0.008）
          // 降噪三件套（PCF 软覆盖 / 法线夹角剔除 / 软 mask）
          setP('uPcf', inst.pcf);
          setP('uNormalCut', inst.normalCut);
          setP('uSoftMask', inst.softMask);
        }

        if (inst.projector) {
          const mp = mat4FromProjector(inst.projector.position, inst.projector.quaternion, inst.projector.half);
          if (mp) {
            setP('invProjector', mp.inv);
            setP('decalHalf', mp.half);
            setP('projectorNormal', mp.normal);
          }
        }
      }
    } catch (e) {
      if (!prerenderWarned) {
        prerenderWarned = true;
        warn('贴花 uniform 更新失败，本帧跳过（不影响主渲染）：' + (e?.message || e));
      }
    }
  }

  // ---------------------------------------------------------------- WebGPU 错误观测 + 自动降级
  /* 引擎 WebgpuDevice 对 uncapturederror 的处理是空操作（_uncapturedErrorHandler
     只读了一下 ev.error）。任何 WebGPU validation error 都会让整条 command buffer
     提交失败 —— 表现为整屏纯色黑屏，且 F12 / CDP 一条错误都看不到。所以：
     1) 挂自己的监听，把错误以 console.error 输出（用户 F12 与诊断脚本都能看到）；
     2) 贴花激活期间出错则自动降级：隐藏全部贴花实例。宁可不显示贴花，
        也不能让用户面对黑屏 —— 这是「叠加特效绝不拖垮主渲染」的最后防线。

     ★ 归因（重要）：uncapturederror 是**全局**的 —— 引擎任何 mesh 的 pipeline
     出错（典型：窗口尺寸变化后重建 VertexState，报
     "Vertex attribute slot 0 used in vertexMain is not present in the VertexState"）
     都会走同一个回调。早期实现「任何错误都降级」，结果是**别人家的错误把贴花
     全隐藏**，用户看到「框线在、视频没了」，而贴花本身完全正常。
     现在改为两路：
       · 作用域路径：贴花绘制前 beginGpuErrorScope、绘制后 endGpuErrorScope，
         只有这个作用域里冒出来的错误才判定为「贴花的错」→ 降级。
       · 全局路径：其余错误只记录与告警，**不降级**。 */
  let gpuErrors = 0;
  let degraded = false;
  let scopedErrors = 0;
  let foreignErrors = 0;
  let lastGpuError = null;   // 完整错误文本（诊断用；console 与探针日志会截断）
  function degrade(reason) {
    if (degraded) return;
    degraded = true;
    for (const inst of manager.instances.values()) {
      adapter.setRenderableVisible(inst.renderable, false);
      inst.visible = false;
    }
    warn('WebGPU 渲染出错，贴花已自动降级隐藏（主画面恢复，仅损失贴花显示）'
      + (reason ? '：' + reason : ''));
    // 页面可见提示：否则用户只看到「包围盒在、视频没了」，不知道发生了降级
    try {
      const t = document.createElement('div');
      t.textContent = 'GPU 贴花渲染出错，已自动隐藏投射画面（标注与主画面不受影响），详情见控制台';
      t.dataset.role = 'decal-degrade-toast';
      t.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:99999;' +
        'background:rgba(30,30,36,.92);color:#ffd27d;padding:10px 18px;border-radius:8px;font:13px sans-serif;';
      document.body.appendChild(t);
      setTimeout(() => t.remove(), 8000);
    } catch (_) { /* noop */ }
  }
  function hookGpuErrors() {
    try {
      // 通过适配器订阅底层 GPU 未捕获错误（WebGPU uncapturederror 等）。
      // 各引擎的订阅方式不同，差异全部收敛在适配器内。
      const off = adapter.observeGpuErrors((err) => {
        gpuErrors++;
        foreignErrors++;
        const msg = (err && err.message) ? err.message : String(err);
        lastGpuError = msg;
        console.error('[decal-projection] GPU 未捕获错误（非贴花作用域，未降级）:', msg);
      });
      if (off) manager.__offGpuErrors = off;
    } catch (_) { /* 非 WebGPU 或无法挂钩：保持静默 */ }
  }

  /* 贴花专属错误作用域：绘制前开、绘制后关，关掉时才知道这个作用域里有没有错。
     作用域里的错误一定来自贴花自己参与的提交 → 才允许降级。

     ★ 自动归因二分：作用域里有错时，**不能立刻断定是贴花的错** —— 引擎其它
       mesh 在同一帧里提交的 pipeline 也落在同一个作用域里（如窗口尺寸变化后
       重建 VertexState 报 "Vertex attribute slot 0 ... is not present in the
       VertexState"）。所以做一次二分复测：
         第 1 帧：贴花开着 → 有错  → 进入「嫌疑」态，下一帧关掉贴花复测
         第 2 帧：贴花关着 → 仍有错 → 是别人的错（引擎自身），**不降级**
         第 2 帧：贴花关着 → 无错   → 是贴花的错 → 降级隐藏
       这样既保住「贴花坏了必须自动降级」的安全网，又不再被别人的错误牵连。 */
  let scopeOpen = false;
  let suspicion = null;          // null | {msg, probeNextFrame:boolean}
  let probeDecalsOff = false;    // 复测帧：临时关掉贴花
  /* ★ 已判定为「引擎自身」的错误消息集合。真机引擎的 validation error（如 Dawn
     VertexState）是持续每帧出现的：若每次都走『隐藏贴花一帧复测』，贴花就会每两帧
     隐藏一次 = 持续闪烁（即使归因正确不降级）。冻结结论：同一条消息一旦被复测证明
     与非贴花无关，后续直接计入 foreign 并忽略，不再触发 probeNextFrame/隐藏。
     新消息（真正的贴花故障）仍可独立复测、必要时降级。 */
  const foreignResolvedMsgs = new Set();
  function beginScope() {
    if (scopeOpen) return;
    if (typeof adapter.beginGpuErrorScope !== 'function') return;
    try {
      scopeOpen = adapter.beginGpuErrorScope() === true;
    } catch (_) { scopeOpen = false; }
  }
  function endScope() {
    if (!scopeOpen) return;
    scopeOpen = false;
    if (typeof adapter.endGpuErrorScope !== 'function') return;
    /* ★ 2026-11-19 闪烁根因修复：popErrorScope() 的回调是异步的（Promise.then），
       而 onFrameEnd 紧接着同步执行 `probeDecalsOff=false; setDecalsVisible(true)`。
       原实现在回调里读全局 probeDecalsOff —— 等回调真正跑时它已被同步代码重置为
       false，于是「复测帧无错→是贴花的错→degrade」与「复测帧有错→非贴花→忽略」
       两条分支永远走不到，每次都被当成「首次捕获」重新置 probeNextFrame=true，
       贴花每帧隐藏/恢复交替 = 可见闪烁（真机「添加投影矩形就开始闪」）。
       修复：把本帧是否复测帧在 endScope 调用瞬间快照下来，回调只用快照值。 */
    const wasProbeFrame = probeDecalsOff;
    try {
      adapter.endGpuErrorScope((msg) => {
        if (!msg) {
          // 本帧无错：若上一帧是嫌疑态，说明关掉贴花后错误消失 → 是贴花的错
          if (suspicion && wasProbeFrame) {
            scopedErrors++;
            degrade(suspicion.msg);
            suspicion = null;
          }
          return;
        }
        gpuErrors++;
        lastGpuError = String(msg);
        if (wasProbeFrame) {
          // 复测帧（贴花已关）仍有错 → 与贴花无关，是引擎自身的错误
          foreignErrors++;
          foreignResolvedMsgs.add(String(msg));   // 冻结结论：后续同消息不再复测隐藏（防持续闪烁）
          console.warn('[decal-projection] GPU 错误复测：关闭贴花后依然报错，判定为非贴花故障，已忽略:',
            String(msg).slice(0, 200));
          suspicion = null;
          return;
        }
        // 已知引擎错误：直接忽略，不再进入嫌疑态（否则每两帧隐藏贴花一次 = 闪烁）
        if (foreignResolvedMsgs.has(String(msg))) { suspicion = null; return; }
        // 首次捕获到错：进入嫌疑态，下一帧关掉贴花复测
        suspicion = { msg: String(msg), probeNextFrame: true };
        console.error('[decal-projection] GPU 错误（待归因，下一帧复测）:', String(msg).slice(0, 200));
      });
    } catch (_) { /* noop */ }
  }

  /* 复测帧临时关掉全部贴花渲染（本帧结束后恢复） */
  function setDecalsVisible(v) {
    for (const inst of manager.instances.values()) {
      if (!inst.renderable) continue;
      const on = v && inst.projector && !degraded;
      adapter.setRenderableVisible(inst.renderable, !!on);
      inst.visible = !!on;
    }
  }

  // ---------------------------------------------------------------- 防御式启用
  try {
    // 先验证一个实例的 shader 能编译：做一次离屏构造，失败则整体禁用
    const probe = makeMaterial();
    if (probe) adapter.destroyMaterial(probe);
  } catch (e) {
    shaderOk = false;
    warn('shader 编译/构造失败，GPU 贴花已禁用：' + (e && e.message ? e.message : e));
    manager.enabled = false;
    manager.sync = () => {};
    manager.destroy = () => {};
    return manager;
  }

  hookGpuErrors();
  adapter.addRenderHook(RENDER_HOOKS.AFTER_RENDER, onFrameEnd);
  adapter.addRenderHook(RENDER_HOOKS.BEFORE_RENDER, onPrerender);
  manager.enabled = true;

  manager.sync = sync;
  /* 诊断钩子：测试与真机排查用。pickReady=1 表示引擎 Picker 的真实深度快照
     纹理已绑定；degraded=true 表示已触发 fail-safe（发生了 GPU validation error）。 */
  manager.debug = () => ({
    enabled: manager.enabled,
    degraded, gpuErrors, pickReady, pickSize, lastGpuError,
    // 错误归因：scopedErrors = 贴花自身作用域内捕获；foreignErrors = 复测证明与他者无关
    scopedErrors, foreignErrors,
    pickTextureFormat: adapter.getTextureFormat ? adapter.getTextureFormat(pickTexture) : null,
    options: { ...options },
    renderEnabled: options.renderEnabled,
    maxFps: options.maxFps,
    uploadFps: options.uploadFps,
    // pick 纹理是设备像素，屏幕是 CSS 像素；DPR>1 时两者不一致会导致块状采样
    dpr: adapter.getPixelRatio ? adapter.getPixelRatio() : ((typeof globalThis !== 'undefined' && globalThis.devicePixelRatio) || 1),
    instances: [...manager.instances.values()].map(i => {
      const ts = adapter.getTextureSize ? adapter.getTextureSize(i.texture) : [0, 0];
      return {
        id: i.id,
        visible: !!i.visible,
        hasProjector: !!i.projector,
        videoUrl: i.url || null,
        demoMode: !i.url,
        videoReady: !!(i.url && i.video && i.video.readyState >= 2 && i.video.videoWidth > 0),
        videoErr: i.videoErr || null,
        texW: ts[0], texH: ts[1],
        /* 深度图就绪口径统一：新三段式看 depthPassOk + shadowTex，旧路径看
           CPU 深度图。此前新路径恒报 false，真机排查会被误读成「深度图没就绪」。 */
        shadowReady: !!(i.useShadow ? (i.depthPassOk && i.shadowTex)
          : (i.shadow && i.shadow.depth && i.shadowTex)),
        shadowSize: i.shadow ? i.shadow.size : null,
        shadowHits: i.shadow ? i.shadow.hits : null,
        depthTestOption: options.depthTest,
        boxScale: i.boxScale, depthMode: i.depthMode, debugMode: i.debugMode, cull: i.cull,
        pcf: i.pcf, normalCut: i.normalCut, softMask: i.softMask,
        // 三段式诊断：depthPass 是否可用、projVP/shadowTex 是否就位、实际深度比较是否开启
        useShadow: !!i.useShadow,
        depthPassOk: !!i.depthPassOk,
        hasProjVP: !!i.projVP,
        hasShadowTex: !!i.shadowTex,
        effectiveDepthTest: !!(options.depthTest && i.depthPassOk)
      };
    })
  });
  /* 运行期调参入口：面板开关与真机诊断脚本共用。
     立即对已有实例生效（下一帧 onPrerender 会读取）。 */
  manager.setOptions = (patch) => {
    if (!patch || typeof patch !== 'object') return { ...options };
    for (const k of ['boxScale', 'depthMode', 'debugMode', 'videoFlipY', 'depthTest', 'shadowSize', 'pcf', 'normalCut', 'softMask', 'renderEnabled', 'maxFps', 'uploadFps', 'useShadowPass']) {
      if (k in patch && Number.isFinite(Number(patch[k]))) options[k] = Number(patch[k]);
    }
    /* renderEnabled 切换时立即同步 renderable 可见性：熔断=隐藏（配合 onFrameEnd
       停循环彻底空载），恢复=按标注自身的 visible+projector 决定，不擅自显示。 */
    if ('renderEnabled' in patch) {
      for (const inst of manager.instances.values()) {
        if (!inst.renderable) continue;
        const on = !!options.renderEnabled && inst.visible && !!inst.projector && !degraded;
        adapter.setRenderableVisible(inst.renderable, !!on);
      }
    }
    /* depthTest 切换：立即按新口径重配每个实例，不等下一次标注变更。
       0→1：为已有 projector 创建 depthPass 并渲一次；1→0：关掉 Pass1（停止重渲）。
       这样真机 A/B（`setOptions({depthTest:1})`）无需改动标注即可立刻对比。 */
    if ('depthTest' in patch) {
      for (const inst of manager.instances.values()) {
        if (!inst.useShadow) continue;
        if (inst.projector) syncShadowPass(inst, inst.projector);
        else if (!options.depthTest && inst.depthPass) adapter.setDepthPassEnabled(inst.depthPass, false);
      }
    }
    /* 诊断/调参参数立即下沉到实例：否则 setOptions({debugMode:2}) 对已创建的
       贴花无效，真机/脚本调试会误以为「探针没有输出」。 */
    for (const k of ['boxScale', 'depthMode', 'debugMode', 'videoFlipY', 'cull', 'pcf', 'normalCut', 'softMask']) {
      if (k in patch && Number.isFinite(Number(patch[k]))) {
        for (const inst of manager.instances.values()) inst[k] = Number(patch[k]);
      }
    }
    return { ...options };
  };
  manager.getOptions = () => ({ ...options });
  manager.destroy = () => {
    if (makeupTimer) { clearTimeout(makeupTimer); makeupTimer = null; }
    adapter.removeRenderHook(RENDER_HOOKS.AFTER_RENDER, onFrameEnd);
    adapter.removeRenderHook(RENDER_HOOKS.BEFORE_RENDER, onPrerender);
    if (typeof manager.__offGpuErrors === 'function') {
      try { manager.__offGpuErrors(); } catch (_) { /* noop */ }
      manager.__offGpuErrors = null;
    }
    for (const inst of manager.instances.values()) destroyInstance(inst);
    manager.instances.clear();
  };
  return manager;
}

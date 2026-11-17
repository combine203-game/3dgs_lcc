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
 * 只有中间一小块」的根因。UV 映射统一为 uv = ln.xy * 0.5 + 0.5。
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
  DECAL_FRAGMENT_PREAMBLE_GLSL, DECAL_FRAGMENT_BODY_GLSL, DECAL_FRAGMENT_WGSL
} from '../engine/decal-shaders.js';
import { RENDER_HOOKS } from '../engine/engine-adapter.js';

/**
 * @param {object} opts
 * @param {object} opts.adapter         引擎适配器（engine-adapter 契约接口）
 * @param {() => Array} opts.getDecals   当前可见且带 projector 的 decal 注记列表
 * @returns {object} manager { enabled, sync, destroy }
 */
export function createDecalProjection({ adapter, getDecals } = {}) {
  /* 运行期可调参数（面板/诊断可改）：
     boxScale  —— OBB 归一化基准。1.0 = 盒面 |ln|=1（整框命中，正确行为）；
                  0.5 复现历史行为（只命中每轴内侧 1/4，即「框线清楚、框内一小块」）。
                  保留 0.5 作为可回退开关，而不是把旧语义写死在 shader 里。
     depthMode —— 1 = 引擎同族口径（5×5 邻域 30% 分位）；0 = 单 texel 中位（性能兜底）。
     debugMode —— 0 正常；1 深度灰度；2 失败分类着色（红=XY 出盒，绿=Z 出盒，蓝=被剔除）。 */
  const options = { boxScale: 1.0, depthMode: 1, debugMode: 0 };
  const numOr = (v, dflt) => (Number.isFinite(Number(v)) ? Number(v) : dflt);

  const manager = {
    enabled: false,
    instances: new Map(),     // id -> { material, renderable, video, texture, url, half, projector }
    destroy() {}
  };

  const warn = (m) => console.warn('[decal-projection] ' + m);

  // ---- 适配器不可用（非真实渲染运行时 / headless mock）时安全降级 ----
  if (!adapter || typeof adapter.createShaderMaterial !== 'function' || !adapter.isReady()) {
    warn('引擎适配器未就绪（headless / mock 或非真实渲染运行时），GPU 贴花已禁用');
    return manager;
  }

  const isWebGPU = adapter.getBackendType ? adapter.getBackendType() === 'webgpu' : false;

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
    const material = makeMaterial();
    if (!material) return null;
    // shader 首行是 uPickReady < 0.5 时 discard。实例一创建就置 0，保证在
    // onPrerender 成功注入真实深度纹理之前，全屏 quad 绝不输出任何像素
    // （uniform 未初始化时整屏 quad 可能盖黑 3DGS 画面）。
    adapter.setMaterialParameter(material, 'uPickReady', 0);
    const renderable = adapter.createRenderable(quadMesh, material, quadNode);
    if (!renderable) {
      adapter.destroyMaterial(material);
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

    const inst = {
      id: dec.id, material, renderable, video, texture,
      blitCanvas, blitCtx,
      url: null, half: [0.25, 0.25, 0.25], projector: null, opacity: 0.9, edge: 0.12, cull: 1,
      boxScale: options.boxScale, depthMode: options.depthMode, debugMode: options.debugMode,
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
    try { inst.video.pause(); inst.video.removeAttribute('src'); inst.video.load(); } catch (_) {}
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
      } else {
        inst.projector = null;
      }
      inst.opacity = Number(dec.opacity ?? 0.9);
      inst.edge = Number(dec.edge ?? 0.12);
      inst.cull = dec.cull === false ? 0 : 1;
      // 运行期可覆盖项：归一化基准 / 深度采样口径 / 调试模式
      inst.boxScale = numOr(dec.boxScale, options.boxScale);
      inst.depthMode = numOr(dec.depthMode, options.depthMode);
      inst.debugMode = numOr(dec.debugMode, options.debugMode);
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

  let pickWarned = false;
  function onFrameEnd() {
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
    // 让视频纹理跟随最新帧上传（引擎对 video/canvas 源按帧重传）。
    // 有 URL 用视频（先绘入固定尺寸转绘画布，纹理永不重建）；URL 为空
    // 则上传内置演示画面（动画条纹）——「留空播放内置演示画面」是真实行为。
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
    /* 关键：引擎 Picker 的 pick pass 会把 graphicsDevice 的 renderTarget 留在
       离屏 framebuffer、并把 clearColor 设成白色（farColor），且 endRenderPass
       不负责恢复。Viewer 首帧后已切按需渲染（autoRender=false），编辑态又只有
       一帧 renderNextFrame；若这里不显式再请求主帧，默认 framebuffer 永远不再
       重绘，3DGS 画面就此消失，只剩 #mg-stage 的深色底 —— 即「进入编辑黑屏」。
       每帧请求一次主帧，保证 backBuffer 始终被主渲染覆盖。 */
    adapter.requestRender();
  }

  let prerenderWarned = false;
  function onPrerender() {
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
        // 相机世界位置：把深度差分重建的法向统一翻向可见侧
        setP('uCameraPos', camPos);

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
    try {
      adapter.endGpuErrorScope((msg) => {
        if (!msg) {
          // 本帧无错：若上一帧是嫌疑态，说明关掉贴花后错误消失 → 是贴花的错
          if (suspicion && probeDecalsOff) {
            scopedErrors++;
            degrade(suspicion.msg);
            suspicion = null;
          }
          return;
        }
        gpuErrors++;
        if (probeDecalsOff) {
          // 复测帧（贴花已关）仍有错 → 与贴花无关，是引擎自身的错误
          foreignErrors++;
          console.warn('[decal-projection] GPU 错误复测：关闭贴花后依然报错，判定为非贴花故障，已忽略:',
            String(msg).slice(0, 200));
          suspicion = null;
          return;
        }
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
    degraded, gpuErrors, pickReady, pickSize,
    // 错误归因：scopedErrors = 贴花自身作用域内捕获；foreignErrors = 复测证明与他者无关
    scopedErrors, foreignErrors,
    pickTextureFormat: adapter.getTextureFormat ? adapter.getTextureFormat(pickTexture) : null,
    options: { ...options },
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
        boxScale: i.boxScale, depthMode: i.depthMode, debugMode: i.debugMode, cull: i.cull
      };
    })
  });
  /* 运行期调参入口：面板开关与真机诊断脚本共用。
     立即对已有实例生效（下一帧 onPrerender 会读取）。 */
  manager.setOptions = (patch) => {
    if (!patch || typeof patch !== 'object') return { ...options };
    for (const k of ['boxScale', 'depthMode', 'debugMode']) {
      if (k in patch && Number.isFinite(Number(patch[k]))) options[k] = Number(patch[k]);
    }
    return { ...options };
  };
  manager.getOptions = () => ({ ...options });
  manager.destroy = () => {
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

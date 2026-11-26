/**
 * 贴花投影 shader 源码（引擎层）
 * ----------------------------------------------------------------
 * 从 web/editor/decal-projection.js 抽出，使编辑器模块不再内嵌着色器。
 *
 * 分层：
 *   - DECAL_VERTEX_GLSL / DECAL_VERTEX_WGSL：顶点着色器（PlayCanvas 形态）
 *   - DECAL_FRAGMENT_PREAMBLE_GLSL：uniform 声明块（依赖后端 uniform 布局）
 *   - DECAL_FRAGMENT_BODY_GLSL：**纯算法**（深度重建 + 盒内判定 + 剔除 + UV），
 *     任何支持 GLSL ES 3.0 的后端（PlayCanvas WebGL2 / Babylon.js / three.js）可直接复用
 *   - DECAL_FRAGMENT_WGSL：PlayCanvas 专有 WGSL 形态（uniform 命名空间 + pcPosition 内建），
 *     其他引擎需另写等价实现（Babylon.js WebGPU 路径的 uniform buffer 布局不同）
 *
 * 本文件由 tools/extract_decal_shaders.mjs 一次性生成后手工维护。
 */

/** 贴花用到的全部 uniform 名称（JS 侧 setParameter 必须与之一致） */
export const DECAL_UNIFORM_NAMES = [
  'pickDepth', 'videoTex', 'uPickSize', 'uVideoSize', 'uPickReady',
  'invViewProj', 'invProjector', 'decalHalf', 'projectorNormal',
  'nearClip', 'farClip', 'decalOpacity', 'decalEdge', 'uCull',
  'uResolution', 'uUVSignY', 'uUVOffsetY', 'uPickFlipY',
  'uBoxScale', 'uDepthMode', 'uDebugMode', 'uCameraPos', 'uVideoFlipY',
  // shadowmap 路线新增
  'shadowDepth', 'uShadowSize', 'uShadowReady', 'uVirtualCam',
  'uVirtualRight', 'uVirtualUp', 'uVirtualForward', 'uVirtualHalf',
  'uVirtualFar', 'uShadowBias',
  // 已废弃的降噪参数：改为「视频始终在前」后 shader 不再使用；声明保留做兼容
  'uPcf', 'uNormalCut', 'uSoftMask'
];

export const DECAL_VERTEX_GLSL = /* glsl */ `
    attribute vec2 vertex_position;
    uniform mat4 matrix_model;
    void main(void) {
      gl_Position = matrix_model * vec4(vertex_position, 0.0, 1.0);
    }`;

export const DECAL_VERTEX_WGSL = /* wgsl */ `
    attribute vertex_position: vec2f;
    uniform matrix_model: mat4x4f;
    @vertex fn vertexMain(input: VertexInput) -> VertexOutput {
      var output: VertexOutput;
      output.position = uniform.matrix_model * vec4f(input.vertex_position, 0.0, 1.0);
      return output;
    }`;

export const DECAL_FRAGMENT_PREAMBLE_GLSL = /* glsl */ `
    precision highp float;
    uniform sampler2D pickDepth;     // RGBA16F：每通道一次试验的归一化线性深度，1.0=空
    uniform sampler2D videoTex;
    uniform vec2  uPickSize;
    uniform vec2  uVideoSize;
    uniform float uPickReady;
    uniform mat4  invViewProj;       // invert(projection * view)
    uniform mat4  invProjector;      // invert(OBB 旋转平移)
    uniform vec3  decalHalf;         // OBB 半尺寸（米）
    uniform vec3  projectorNormal;   // 投影机本地 +Z 的世界方向
    uniform float nearClip;
    uniform float farClip;
    uniform float decalOpacity;
    uniform float decalEdge;         // 边缘软过渡占比 [0,0.5]
    uniform float uCull;             // 1=背面剔除
    uniform vec2  uResolution;       // 帧缓冲像素尺寸
    uniform float uUVSignY;
    uniform float uUVOffsetY;
    uniform float uPickFlipY;        // pick 快照纹理行序：WebGPU 行0=顶部(1)，WebGL 行0=底部(0)
    uniform float uVideoFlipY;       // 视频纹理行序修正：1=翻转 v（默认，canvas 上传未 flipY，行0=图像顶部）
    uniform float uBoxScale;         // OBB 归一化基准：1.0=盒面 |ln|=1（整框）；0.5=旧行为（仅内侧 1/4）
    uniform float uDepthMode;        // 1=引擎同族 5×5 邻域 30% 分位；0=单 texel 4 通道中位（性能兜底）
    uniform float uDebugMode;        // 0 正常；1 深度灰度；2 失败分类着色
    uniform vec3  uCameraPos;        // 相机世界位置（把重建法向统一翻向可见侧）
    // ---- shadowmap 路线 ----
    uniform sampler2D shadowDepth;   // R32F：虚拟相机视角的确定性表面深度（1.0=空）
    uniform vec2  uShadowSize;       // 深度图尺寸（纹素）
    uniform float uShadowReady;      // 1=投影机带有效深度图，走 shadowmap 路线
    uniform vec3  uVirtualCam;       // 虚拟相机世界位置
    uniform vec3  uVirtualRight;     // 虚拟相机右轴（世界）
    uniform vec3  uVirtualUp;        // 虚拟相机上轴（世界）
    uniform vec3  uVirtualForward;   // 虚拟相机视线方向（世界，= -normal）
    uniform vec2  uVirtualHalf;      // 视锥 XY 半尺寸（= OBB half.xy）
    uniform float uVirtualFar;       // 深度归一化用的 far
    uniform float uShadowBias;       // 深度比较容差（归一化）
    // ---- 已废弃的降噪参数（视频始终在前后不再使用，保留声明做兼容）----
    uniform float uPcf;
    uniform float uNormalCut;
    uniform float uSoftMask;
`;

export const DECAL_FRAGMENT_BODY_GLSL = /* glsl */ `    /* 单 texel 的 4 通道中位：丢弃单次随机试验的离群值。引擎 surfaceDepth 的
       分位口径本身就是抗离群的，这里用中位近似同一意图（4 次比较，成本极低）。 */
    float channelMedian(vec4 t) {
      float lo = min(min(t.r, t.g), min(t.b, t.a));
      float hi = max(max(t.r, t.g), max(t.b, t.a));
      return (t.r + t.g + t.b + t.a - lo - hi) * 0.5;
    }

    /* 引擎同族口径（viewer/index.js surfaceDepth）：
       5×5 邻域圆盘（半径 2 → 13 个 texel）× 4 次随机试验，取 30% 分位数。
       引擎在 CPU 上按需算单点；贴花要逐像素用，故用部分选择排序取第 k 小。
       旧实现取「单 texel 4 通道 min」= 最乐观的那次试验 → 世界点系统性偏近，
       被盒内判定大量丢弃，这是「框线清楚、框内几乎空白」的主因之一。 */
    float pickSurfaceDepth(vec2 puv) {
      vec2 sz = uPickSize;
      ivec2 c = ivec2(clamp(puv * sz, vec2(0.0), sz - vec2(1.0)));
      float s[52];
      int n = 0;
      for (int dy = -2; dy <= 2; dy++) {
        for (int dx = -2; dx <= 2; dx++) {
          if (dx * dx + dy * dy > 4) continue;
          ivec2 q = clamp(c + ivec2(dx, dy), ivec2(0), ivec2(sz) - ivec2(1));
          vec4 t = texelFetch(pickDepth, q, 0);
          s[n] = t.r; s[n + 1] = t.g; s[n + 2] = t.b; s[n + 3] = t.a;
          n += 4;
        }
      }
      int k = int(ceil(float(n) * 0.3)) - 1;      // SURFACE_OPACITY = 0.3
      k = max(k, 0);
      /* 选择排序必须排到 k 为止（含 k）：只排到 k-1 的话 s[k] 仍留在未排序的
         残余里，取到的是「远端候选中的任意一个」而不是第 k 小 —— 每个像素的
         深度在远端候选间随机跳变，重建的世界点跟着抖动，贴花呈椒盐点状。
         引擎原版是全排序后取 samples[k]，这里用部分选择排序取等价结果。 */
      for (int i = 0; i <= k && i < n; i++) {
        int mi = i;
        float mv = s[i];
        for (int j = i + 1; j < n; j++) {
          if (s[j] < mv) { mv = s[j]; mi = j; }
        }
        s[mi] = s[i]; s[i] = mv;
      }
      return s[k];
    }

    float pickFastDepth(vec2 puv) {
      vec2 sz = uPickSize;
      ivec2 q = ivec2(clamp(puv * sz, vec2(0.0), sz - vec2(1.0)));
      return channelMedian(texelFetch(pickDepth, q, 0));
    }

    /* pick 纹理 UV → 屏幕（左上原点）坐标。WebGPU 行0=顶部，WebGL 行0=底部。 */
    vec2 pickToScreen(vec2 puv) {
      return vec2(puv.x, mix(1.0 - puv.y, puv.y, uPickFlipY));
    }

    /* 与引擎 getWorldPoint 同款数学：归一化线性深度 → NDC → 世界坐标 */
    vec3 worldFromPick(vec2 puv, float nd) {
      vec2 scr = pickToScreen(puv);
      vec2 ndc = vec2(scr.x * 2.0 - 1.0, (1.0 - scr.y) * 2.0 - 1.0);
      float ndcZ = (farClip * nd) / (nd * (farClip - nearClip) + nearClip);
      vec4 clip = vec4(ndc, ndcZ * 2.0 - 1.0, 1.0);
      vec4 W = invViewProj * clip;
      return W.xyz / W.w;
    }

    /* ---- 视频始终在前（always-on-top projected decal）--------------------------------
       遮挡错误根因：贴花用「3DGS pick 深度重建的 dW」与「碰撞 mesh shadow 深度
       dMap」做跨源比较，两者在树冠/稀疏/多层表面差米级，二值判定把抖动放大成
       椒盐、破洞、外溢。smoothPickDepth（3×3 中位）只是治标，且多付 9 次采样。
       决策：彻底不做深度遮挡测试。深度只用来把屏幕像素重建成世界点 W，从而
       算投影 UV（保持贴花随相机移动的三维贴合），不参与「是否显示视频」的判定。
       投影范围完全由 projector 局部盒决定，视频在盒内无条件显示。 */

    /* 背面剔除（可选，默认关）：用深度差分重建真实表面法向，而不是屏幕导数。
       随机深度下 dFdx/dFdy 的符号会抖动，导数法向只会误杀不会增值。 */
    bool decalBackfacing(vec2 pickUV, vec3 world) {
      vec2 texel = 1.0 / uPickSize;
      vec2 puvX = pickUV + vec2(texel.x, 0.0);
      vec2 puvY = pickUV + vec2(0.0, texel.y);
      vec3 pX = worldFromPick(puvX, pickFastDepth(puvX));
      vec3 pY = worldFromPick(puvY, pickFastDepth(puvY));
      vec3 nrm = normalize(cross(pX - world, pY - world));
      vec3 toCam = uCameraPos - world;
      if (dot(nrm, toCam) < 0.0) nrm = -nrm;
      return dot(nrm, projectorNormal) < -0.25;
    }

    /* Always-on-top projected decal（视频始终在前）：
       主相机像素反投影的世界点 W 用 invProjector 变换到投影机局部空间，
       |L / (decalHalf*uBoxScale)| <= 1 才在投影锥内；命中后直接用 ln.xy 采样视频。
       ★ 没有跨源深度遮挡测试：W 只用于算投影 UV，不再拿 dW 与 shadow 深度
       dMap 比较。视频在投影锥内无条件显示，因此不会有像素遮挡错误/椒盐/破洞。
       单 texel 深度重建（无平滑、无排序），成本为历史最低。 */
    void decalProject(out vec2 uvOut, out float ndOut) {
      uvOut = vec2(-1.0); ndOut = 0.0;
      vec2 frag = gl_FragCoord.xy;
      vec2 uvTL = vec2(frag.x / uResolution.x,
                       frag.y / uResolution.y * uUVSignY + uUVOffsetY);
      vec2 pickUV = vec2(uvTL.x, mix(1.0 - uvTL.y, uvTL.y, uPickFlipY));
      float nd = pickFastDepth(pickUV);                    // 单 texel 4 通道中位
      if (nd >= 1.0) return;
      vec3 W = worldFromPick(pickUV, nd);                  // 仅用于投影 UV
      vec3 L = (invProjector * vec4(W, 1.0)).xyz;
      vec3 ln = L / (decalHalf * uBoxScale);
      if (any(greaterThan(abs(ln), vec3(1.0)))) return;    // 投影锥外
      ndOut = nd;
      /* 投影机局部 +Y 指向屏幕上方（buildDecalProjector 用 toward 把法向翻向相机后，
         up = cross(normal, right) 即屏幕上方向）；但 canvas/video 纹理上传时
         PlayCanvas Texture 默认 flipY=false（playcanvas.dbg.mjs:11604），
         texelFetch 的 v=0 取到的是画布第一行（图像顶部）。两者同向会让视频
         上下颠倒。uVideoFlipY=1 时翻转 v，使 ln.y>0（框选区上方）采到图像上半。 */
      float vy = ln.y * 0.5 + 0.5;
      uvOut = vec2(ln.x * 0.5 + 0.5, mix(vy, 1.0 - vy, uVideoFlipY));
    }

    void main(void) {
      if (uPickReady < 0.5) discard;
      vec2 frag = gl_FragCoord.xy;
      vec2 uvTL = vec2(frag.x / uResolution.x,
                       frag.y / uResolution.y * uUVSignY + uUVOffsetY);
      vec2 pickUV = vec2(uvTL.x, mix(1.0 - uvTL.y, uvTL.y, uPickFlipY));
      vec2 uv; float nd; float edgeCoord; vec3 world;
      decalProject(uv, nd);
      if (uv.x < 0.0) {
        if (uDebugMode > 1.5) { gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0); return; }
        discard;
      }
      world = worldFromPick(pickUV, nd);
      edgeCoord = max(abs(uv.x * 2.0 - 1.0), abs(uv.y * 2.0 - 1.0));
      if (uDebugMode > 0.5 && uDebugMode < 1.5) { gl_FragColor = vec4(vec3(clamp(nd, 0.0, 1.0)), 1.0); return; }
      if (uCull > 0.5 && decalBackfacing(pickUV, world)) {
        if (uDebugMode > 1.5) { gl_FragColor = vec4(0.0, 0.0, 1.0, 1.0); return; }
        discard;
      }
      vec2 vpx = clamp(uv * uVideoSize, vec2(0.0), max(uVideoSize - vec2(1.0), vec2(0.0)));
      vec4 vid = texelFetch(videoTex, ivec2(vpx), 0);
      float edge = smoothstep(1.0, 1.0 - decalEdge, edgeCoord);
      /* 视频始终在前：无跨源深度遮挡、无 PCF 软覆盖、无法线剔除。
         alpha 只由视频自身透明度 × 不透明度 × 投影盒边缘软过渡决定。 */
      float a = vid.a * decalOpacity * edge;
      if (a <= 0.004) discard;
      gl_FragColor = vec4(vid.rgb, a);
    }`;

export const DECAL_FRAGMENT_WGSL = /* wgsl */ `
    var pickDepth: texture_2d<f32>;
    var videoTex: texture_2d<f32>;
    var shadowDepth: texture_2d<f32>;
    uniform uPickSize: vec2f;
    uniform uVideoSize: vec2f;
    uniform uPickReady: f32;
    uniform invViewProj: mat4x4f;
    uniform invProjector: mat4x4f;
    uniform decalHalf: vec3f;
    uniform projectorNormal: vec3f;
    uniform nearClip: f32;
    uniform farClip: f32;
    uniform decalOpacity: f32;
    uniform decalEdge: f32;
    uniform uCull: f32;
    uniform uResolution: vec2f;
    uniform uUVSignY: f32;
    uniform uUVOffsetY: f32;
    uniform uPickFlipY: f32;
    uniform uVideoFlipY: f32;
    uniform uBoxScale: f32;
    uniform uDepthMode: f32;
    uniform uDebugMode: f32;
    uniform uCameraPos: vec3f;
    uniform uShadowSize: vec2f;
    uniform uShadowReady: f32;
    uniform uVirtualCam: vec3f;
    uniform uVirtualRight: vec3f;
    uniform uVirtualUp: vec3f;
    uniform uVirtualForward: vec3f;
    uniform uVirtualHalf: vec2f;
    uniform uVirtualFar: f32;
    uniform uShadowBias: f32;
    uniform uPcf: f32;
    uniform uNormalCut: f32;
    uniform uSoftMask: f32;

    fn channelMedian(t: vec4f) -> f32 {
      let lo = min(min(t.r, t.g), min(t.b, t.a));
      let hi = max(max(t.r, t.g), max(t.b, t.a));
      return (t.r + t.g + t.b + t.a - lo - hi) * 0.5;
    }

    /* 引擎同族口径（viewer/index.js surfaceDepth）：
       5×5 邻域圆盘（半径 2 → 13 个 texel）× 4 次随机试验，取 30% 分位数。 */
    fn pickSurfaceDepth(puv: vec2f) -> f32 {
      let sz = uniform.uPickSize;
      let c = vec2i(clamp(puv * sz, vec2f(0.0), sz - vec2f(1.0)));
      var s: array<f32, 52>;
      var n: i32 = 0;
      for (var dy: i32 = -2; dy <= 2; dy = dy + 1) {
        for (var dx: i32 = -2; dx <= 2; dx = dx + 1) {
          if (dx * dx + dy * dy > 4) { continue; }
          let q = clamp(c + vec2i(dx, dy), vec2i(0), vec2i(sz) - vec2i(1));
          // 纹理按裸名访问：PlayCanvas 会把 var pickDepth: texture_2d<f32>; 抽出并重写为
          // @group(N) @binding(slot) var pickDepth，uniform. 前缀只对 uniform buffer 字段有效。
          let t = textureLoad(pickDepth, q, 0);
          s[n] = t.r; s[n + 1] = t.g; s[n + 2] = t.b; s[n + 3] = t.a;
          n = n + 4;
        }
      }
      var k: i32 = i32(ceil(f32(n) * 0.3)) - 1;
      k = max(k, 0);
      /* 选择排序排到 k 为止（含 k）：否则 s[k] 留在未排序残余里 → 深度随机跳变 */
      for (var i: i32 = 0; i <= k && i < n; i = i + 1) {
        var mi: i32 = i;
        var mv: f32 = s[i];
        for (var j: i32 = i + 1; j < n; j = j + 1) {
          if (s[j] < mv) { mv = s[j]; mi = j; }
        }
        s[mi] = s[i]; s[i] = mv;
      }
      return s[k];
    }

    fn pickFastDepth(puv: vec2f) -> f32 {
      let sz = uniform.uPickSize;
      let q = vec2i(clamp(puv * sz, vec2f(0.0), sz - vec2f(1.0)));
      return channelMedian(textureLoad(pickDepth, q, 0));
    }

    fn pickToScreen(puv: vec2f) -> vec2f {
      return vec2f(puv.x, select(1.0 - puv.y, puv.y, uniform.uPickFlipY > 0.5));
    }

    fn worldFromPick(puv: vec2f, nd: f32) -> vec3f {
      let scr = pickToScreen(puv);
      let ndc = vec2f(scr.x * 2.0 - 1.0, (1.0 - scr.y) * 2.0 - 1.0);
      let ndcZ = (uniform.farClip * nd) / (nd * (uniform.farClip - uniform.nearClip) + uniform.nearClip);
      let clip = vec4f(ndc, ndcZ * 2.0 - 1.0, 1.0);
      let W = uniform.invViewProj * clip;
      return W.xyz / W.w;
    }

    /* 视频始终在前（always-on-top projected decal），与 GLSL 完全同构。
       深度只重建世界点算投影 UV，不做跨源遮挡测试。 */

    /* 背面剔除（可选，默认关）：深度差分重建真实法向，避免导数法向符号抖动。 */
    fn decalBackfacing(pickUV: vec2f, world: vec3f) -> bool {
      let texel = vec2f(1.0, 1.0) / uniform.uPickSize;
      let puvX = pickUV + vec2f(texel.x, 0.0);
      let puvY = pickUV + vec2f(0.0, texel.y);
      let pX = worldFromPick(puvX, pickFastDepth(puvX));
      let pY = worldFromPick(puvY, pickFastDepth(puvY));
      var nrm = normalize(cross(pX - world, pY - world));
      let toCam = uniform.uCameraPos - world;
      if (dot(nrm, toCam) < 0.0) { nrm = -nrm; }
      return dot(nrm, uniform.projectorNormal) < -0.25;
    }

    /* Always-on-top projected decal：返回 (uv.x, uv.y, nd)；uv.x<0 表示未命中。
       命中 = projector 局部盒；无跨源深度遮挡、无 PCF、无法线剔除。
       单 texel 深度重建世界点只用于算投影 UV。 */
    fn decalProject(pickUV: vec2f) -> vec3f {
      let nd = pickFastDepth(pickUV);
      if (nd >= 1.0) { return vec3f(-1.0, 0.0, 0.0); }
      let W = worldFromPick(pickUV, nd);
      let L = (uniform.invProjector * vec4f(W, 1.0)).xyz;
      let ln = L / (uniform.decalHalf * uniform.uBoxScale);
      if (any(abs(ln) > vec3f(1.0))) { return vec3f(-1.0, 0.0, nd); }
      /* 与 GLSL 同构：canvas 纹理 flipY=false → 视频 v 必须翻转。 */
      let vy = ln.y * 0.5 + 0.5;
      let vOut = mix(vy, 1.0 - vy, uniform.uVideoFlipY);
      return vec3f(ln.x * 0.5 + 0.5, vOut, nd);
    }

    @fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
      var output: FragmentOutput;
      if (uniform.uPickReady < 0.5) { discard; }
      let frag = pcPosition.xy;
      let uvTL = vec2f(frag.x / uniform.uResolution.x,
                       frag.y / uniform.uResolution.y * uniform.uUVSignY + uniform.uUVOffsetY);
      let pickUV = vec2f(uvTL.x, select(1.0 - uvTL.y, uvTL.y, uniform.uPickFlipY > 0.5));
      let r = decalProject(pickUV);
      let uv = r.xy;
      let nd = r.z;
      if (uv.x < 0.0) {
        if (uniform.uDebugMode > 1.5) { output.color = vec4f(1.0, 0.0, 0.0, 1.0); return output; }
        discard;
      }
      let world = worldFromPick(pickUV, nd);
      let edgeCoord = max(abs(uv.x * 2.0 - 1.0), abs(uv.y * 2.0 - 1.0));
      if (uniform.uDebugMode > 0.5 && uniform.uDebugMode < 1.5) { output.color = vec4f(vec3f(clamp(nd, 0.0, 1.0)), 1.0); return output; }
      if (uniform.uCull > 0.5 && decalBackfacing(pickUV, world)) {
        if (uniform.uDebugMode > 1.5) { output.color = vec4f(0.0, 0.0, 1.0, 1.0); return output; }
        discard;
      }
      let vpx = clamp(uv * uniform.uVideoSize, vec2f(0.0), max(uniform.uVideoSize - vec2f(1.0), vec2f(0.0)));
      let vid = textureLoad(videoTex, vec2i(vpx), 0);
      let edge = smoothstep(1.0, 1.0 - uniform.decalEdge, edgeCoord);
      /* 视频始终在前：无跨源深度遮挡、无 PCF 软覆盖、无法线剔除。 */
      let a = vid.a * uniform.decalOpacity * edge;
      if (a <= 0.004) { discard; }
      output.color = vec4f(vid.rgb, a);
      return output;
    }`;

/* ============================================================================
 * 标准三段式 Shadow-Map Decal（用户指定方案）的 Pass3
 * ----------------------------------------------------------------------------
 * Pass1（adapter.createDepthPass）：正交投影仪相机 → D32_FLOAT 深度纹理。
 * Pass2：主渲染（3DGS splatting）。
 * Pass3（本段）：绘制投影仪视锥 AABB 立方体（主相机光栅化，只覆盖候选像素）；
 *   VS 额外输出投影仪齐次坐标 vProj；
 *   FS 用主相机深度重建世界点 W，再乘 uProjVP 得到精确 uvProj 与 fragD
 *   （★ 不能直接用插值 vProj：那是盒子表面，贴花会浮在空中）；
 *   与 Pass1 深度纹理同源比较 + depthBias，通过后按 uvProj 采样视频。
 *
 * 深度比较方向：常规深度（越近越小）下 fragD > mapD + bias 表示场景表面在
 * shadow map 记录的表面之后 → 被遮挡 discard。
 * ========================================================================== */

export const DECAL_SHADOW_UNIFORM_NAMES = [
  'uProjVP', 'shadowDepth', 'uShadowSize', 'uShadowBias', 'uDepthTest',
  'pickDepth', 'uPickSize', 'uPickReady', 'invViewProj', 'nearClip', 'farClip',
  'uResolution', 'uUVSignY', 'uUVOffsetY', 'uPickFlipY', 'uVideoFlipY',
  'videoTex', 'uVideoSize', 'decalOpacity', 'decalEdge',
  // always-on-top 默认路径：投影机局部坐标算 UV，不依赖 Pass1 深度相机矩阵
  'invProjector', 'decalHalf', 'uBoxScale',
  // 透视投影机（视锥体）开关 + 近平面：透视贴花走 L.z 透视除法
  'uPersp', 'uProjNear',
  // 三段式：投影仪世界法向（法线点积剔除）+ 法线剔除阈值 + 相机位置 + 调试探针
  'projectorNormal', 'uNormalCut', 'uCameraPos', 'uDebugMode'
];

export const DECAL_SHADOW_VERTEX_GLSL = /* glsl */ `
    attribute vec3 vertex_position;
    uniform mat4 matrix_model;
    uniform mat4 matrix_viewProjection;
    uniform mat4 uProjVP;
    varying vec4 vProj;
    void main(void) {
      vec4 world = matrix_model * vec4(vertex_position, 1.0);
      vProj = uProjVP * world;                 // 投影仪齐次坐标（用户方案 Pass3 VS）
      gl_Position = matrix_viewProjection * world;  // 主相机裁剪坐标：只覆盖候选屏幕像素
    }`;

export const DECAL_SHADOW_VERTEX_WGSL = /* wgsl */ `
    attribute vertex_position: vec3f;
    uniform matrix_model: mat4x4f;
    uniform matrix_viewProjection: mat4x4f;
    uniform uProjVP: mat4x4f;
    varying vProj: vec4f;
    @vertex fn vertexMain(input: VertexInput) -> VertexOutput {
      var output: VertexOutput;
      let world = uniform.matrix_model * vec4f(input.vertex_position, 1.0);
      output.vProj = uniform.uProjVP * world;
      output.position = uniform.matrix_viewProjection * world;
      return output;
    }`;

export const DECAL_SHADOW_FRAGMENT_GLSL = /* glsl */ `
    precision highp float;
    uniform sampler2D pickDepth;      // 主相机深度（RGBA16F，4 通道随机试验）
    uniform sampler2D videoTex;
    uniform sampler2D shadowDepth;    // Pass1 投影仪 D32_FLOAT 深度
    uniform vec2  uPickSize;
    uniform vec2  uVideoSize;
    uniform vec2  uResolution;
    uniform vec2  uShadowSize;
    uniform float uPickReady;
    uniform float uUVSignY;
    uniform float uUVOffsetY;
    uniform float uPickFlipY;
    uniform float uVideoFlipY;
    uniform float decalOpacity;
    uniform float decalEdge;
    uniform float uShadowBias;
    uniform float uDepthTest;         // 1=标准 shadow-map 深度比较；0=always-on-top（默认，视频始终在前）
    uniform float uNormalCut;         // 法线点积剔除阈值（0=关闭）；表面背向投影仪时 discard
    uniform float uDebugMode;         // 0 正常；2 诊断：Pass1 深度图状态着色（蓝=UV越界/品红=空/绿=有深度）
    uniform vec3  projectorNormal;    // 投影仪世界法向（投射方向，OBB 局部 +Z）
    uniform vec3  uCameraPos;        // 相机世界位置（法线剔除时统一翻向可见侧）
    uniform mat4  invViewProj;
    uniform mat4  invProjector;       // invert(投影机旋转平移)：always-on-top 路径算投影 UV
    uniform vec3  decalHalf;          // ortho=OBB 半尺寸；persp=远平面半宽/半高/远距
    uniform float uBoxScale;
    uniform float uPersp;             // 1=透视投影机（视锥体）；0=正交 OBB
    uniform float uProjNear;          // 透视近平面距离（沿光轴，米）
    uniform float nearClip;
    uniform float farClip;
    // ★ 声明文本必须与 DECAL_SHADOW_VERTEX_GLSL 里那一行**逐字符一致**（单空格）。
    //   PlayCanvas WebGL2 的 WebglShaderProcessorGLSL 会把 VS/FS 的 uniform 行
    //   并集按「整行字符串」去重后重新声明到两个阶段；此前这里是双空格的 mat4 声明
    //   而顶点侧是单空格 → 去重失败 → 生成两份 uniform mat4 uProjVP 声明
    //   → 编译报 uProjVP redefinition → 整块贴花在 WebGL2 后端完全不投射
    //   （WebGPU/WGSL 路径不受影响，所以只在 WebGL2 上表现为「什么都没画」）。
    uniform mat4 uProjVP;
    varying vec4 vProj;

    float channelMedian(vec4 t) {
      float lo = min(min(t.r, t.g), min(t.b, t.a));
      float hi = max(max(t.r, t.g), max(t.b, t.a));
      return (t.r + t.g + t.b + t.a - lo - hi) * 0.5;
    }
    /* Pass1 深度图是 4 通道伯努利试验（每通道一次最近幸存深度，1=空）。
       与引擎 surfaceDepth 同口径：3×3 邻域 × 4 通道 = 36 样本取 30% 分位，
       得到确定性表面深度，消除单通道随机试验的椒盐/破洞。 */
    float shadowSurfaceDepth(vec2 uv) {
      vec2 sz = uShadowSize;
      ivec2 c = ivec2(clamp(uv * sz, vec2(0.0), sz - vec2(1.0)));
      float s[36];
      int n = 0;
      for (int dy = -1; dy <= 1; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
          ivec2 q = clamp(c + ivec2(dx, dy), ivec2(0), ivec2(sz) - ivec2(1));
          vec4 t = texelFetch(shadowDepth, q, 0);
          s[n] = t.r; s[n + 1] = t.g; s[n + 2] = t.b; s[n + 3] = t.a;
          n += 4;
        }
      }
      int k = max(int(ceil(float(n) * 0.3)) - 1, 0);
      for (int i = 0; i <= k && i < n; i++) {
        int mi = i; float mv = s[i];
        for (int j = i + 1; j < n; j++) {
          if (s[j] < mv) { mv = s[j]; mi = j; }
        }
        s[mi] = s[i]; s[i] = mv;
      }
      return s[k];
    }
    /* 主相机深度同样用 4 通道 30% 分位重建世界点，确保与 Pass1 同源同口径。 */
    float pickSurfaceDepthShadow(vec2 puv) {
      vec2 sz = uPickSize;
      ivec2 c = ivec2(clamp(puv * sz, vec2(0.0), sz - vec2(1.0)));
      float s[52];
      int n = 0;
      for (int dy = -2; dy <= 2; dy++) {
        for (int dx = -2; dx <= 2; dx++) {
          if (dx * dx + dy * dy > 4) continue;
          ivec2 q = clamp(c + ivec2(dx, dy), ivec2(0), ivec2(sz) - ivec2(1));
          vec4 t = texelFetch(pickDepth, q, 0);
          s[n] = t.r; s[n + 1] = t.g; s[n + 2] = t.b; s[n + 3] = t.a;
          n += 4;
        }
      }
      int k = max(int(ceil(float(n) * 0.3)) - 1, 0);
      for (int i = 0; i <= k && i < n; i++) {
        int mi = i; float mv = s[i];
        for (int j = i + 1; j < n; j++) {
          if (s[j] < mv) { mv = s[j]; mi = j; }
        }
        s[mi] = s[i]; s[i] = mv;
      }
      return s[k];
    }
    vec2 pickToScreen(vec2 puv) {
      return vec2(puv.x, mix(1.0 - puv.y, puv.y, uPickFlipY));
    }
    vec3 worldFromPick(vec2 puv, float nd) {
      vec2 scr = pickToScreen(puv);
      vec2 ndc = vec2(scr.x * 2.0 - 1.0, (1.0 - scr.y) * 2.0 - 1.0);
      float ndcZ = (farClip * nd) / (nd * (farClip - nearClip) + nearClip);
      vec4 clip = vec4(ndc, ndcZ * 2.0 - 1.0, 1.0);
      vec4 W = invViewProj * clip;
      return W.xyz / W.w;
    }
    void main(void) {
      if (uPickReady < 0.5) discard;
      vec2 frag = gl_FragCoord.xy;
      vec2 uvTL = vec2(frag.x / uResolution.x,
                       frag.y / uResolution.y * uUVSignY + uUVOffsetY);
      vec2 pickUV = vec2(uvTL.x, mix(1.0 - uvTL.y, uvTL.y, uPickFlipY));
      /* 三段式开启时用 30% 分位重建（与 Pass1 同源同口径，消椒盐）；
         always-on-top 基线仍用单 texel 中位（最低成本）。 */
      float nd = (uDepthTest > 0.5) ? pickSurfaceDepthShadow(pickUV)
                                    : channelMedian(texelFetch(pickDepth,
                        ivec2(clamp(pickUV * uPickSize, vec2(0.0), uPickSize - vec2(1.0))), 0));
      if (nd >= 1.0) discard;
      vec3 W = worldFromPick(pickUV, nd);           // 场景表面点（主相机深度重建）

      /* 默认 always-on-top：用 OBB 局部坐标算投影 UV，不依赖 Pass1 深度相机矩阵。
         这样 depthTest=0 时完全不需要启动 Pass1（缩放 projector 不会触发深度重渲→不闪），
         且视频在投影盒内无条件显示（视频始终在前→不会因跨源深度比较丢像素）。 */
      vec3 L = (invProjector * vec4(W, 1.0)).xyz;
      vec3 ln;
      if (uPersp > 0.5) {
        /* 透视视锥体：局部 +Z = 光轴，decalHalf = [远平面半宽, 远平面半高, 远距]。
           截面半尺寸随视距线性增长（k = L.z / far），于是
           ln.xy = (L.xy / (L.z·tan(fov/2)·aspect)) 就是在「远平面坐标系」里的
           归一化坐标 —— 与正交路径的 ln 定义完全一致，下面的
           |ln|<=1 判定与 uvProj 换算一个字都不用改。
           近平面之前（光心背后 / 贴着光心）直接丢，避免 L.z → 0 时除法爆掉。 */
        if (L.z <= uProjNear) discard;
        ln = vec3(decalHalf.z * L.x / (L.z * decalHalf.x),
                  decalHalf.z * L.y / (L.z * decalHalf.y),
                  L.z / decalHalf.z);
      } else {
        ln = L / (decalHalf * uBoxScale);
      }
      if (any(greaterThan(abs(ln), vec3(1.0)))) discard;
      vec2 uvProj = ln.xy * 0.5 + 0.5;

      /* 标准三段式深度比较（uDepthTest=1）：Pass1 用正交相机渲染 3DGS 本身到
         RGBA16F 4 通道深度图，与这里的主相机 3DGS 重建点 W 同源。
         ★ 深度方向：pick shader 输出 gl_FragCoord.z（常规深度，越近越小，1=空），
           用户规格「当前 Z 比深度图 Z 小很多→被遮挡」是 reversed-Z/距离口径的表述，
           在常规深度下等价为 fragD > mapD + bias → 被遮挡（数值方向相反、语义相同）。
           照字面取反会重蹈「贴花完全看不到」的历史覆辙。 */
      if (uDepthTest > 0.5) {
        /* 诊断探针（uDebugMode=2）：区分「Pass1 深度为空（品红）」/「投影 UV 越界（蓝）」
           /「深度图有内容（绿）」，真机与 headless 都用它定位 shadow 路径失效点。 */
        if (uDebugMode > 1.5) {
          vec4 pcD = uProjVP * vec4(W, 1.0);
          vec3 cD = pcD.xyz / max(abs(pcD.w) > 1e-6 ? pcD.w : 1e-6, 1e-6);
          vec2 dUVD = cD.xy * 0.5 + 0.5;
          if (any(lessThan(dUVD, vec2(0.0))) || any(greaterThan(dUVD, vec2(1.0)))) {
            gl_FragColor = vec4(0.0, 0.0, 1.0, 1.0); return;
          }
          float mapDD = shadowSurfaceDepth(dUVD);
          if (mapDD >= 0.999999) { gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0); return; }
          gl_FragColor = vec4(0.0, 1.0, 0.0, 1.0); return;
        }
        if (vProj.w <= 0.0) discard;
        vec4 pc = uProjVP * vec4(W, 1.0);
        vec3 c = pc.xyz / pc.w;
        vec2 dUV = c.xy * 0.5 + 0.5;
        if (any(lessThan(dUV, vec2(0.0))) || any(greaterThan(dUV, vec2(1.0)))) discard;
        /* 深度口径必须与 Pass1 对齐：Pass1 的 4 通道深度写的是**归一化线性深度**
           (dist - near) / (far - near)（透视相机走 getPickDepth 的 else 分支）；
           正交投影下 gl_FragCoord.z 与线性深度等价，所以老路径用 c.z*0.5+0.5 就对；
           透视投影下 NDC z 是非线性的，直接比会把「近处」当成「远处」，
           必须换成线性深度。pc.w 在透视投影里就是沿光轴的视距。 */
        float fragD;
        if (uPersp > 0.5) {
          fragD = (pc.w - uProjNear) / max(decalHalf.z - uProjNear, 1e-4);
        } else {
          fragD = c.z * 0.5 + 0.5;
        }
        float mapD = shadowSurfaceDepth(dUV);      // 4 通道 × 3×3 邻域 30% 分位
        if (mapD >= 0.999999) discard;             // 投影仪没看到任何 3DGS 表面
        if (fragD > mapD + uShadowBias) discard;   // 被遮挡（常规深度：越大越远）
        /* 法线点积剔除（用户规格的额外优化）：用主相机深度的邻域世界点重建表面
           法线，翻向相机后与 projectorNormal（投射方向）点积；背向投影仪（夹角
           过大）→ discard，防止贴花沿掠射角拉伸糊在侧面。uNormalCut<=0 关闭。
           ★ 用世界空间法线而非光空间深度梯度：梯度符号随 Y 轴约定翻转、且随机
           深度噪声大，历史上多次误杀；世界法线方向明确、可按相机翻向。 */
        if (uNormalCut > 0.0) {
          vec2 texel = 1.0 / uPickSize;
          vec2 puvX = pickUV + vec2(texel.x, 0.0);
          vec2 puvY = pickUV + vec2(0.0, texel.y);
          float ndX = pickSurfaceDepthShadow(puvX);
          float ndY = pickSurfaceDepthShadow(puvY);
          if (ndX < 1.0 && ndY < 1.0) {
            vec3 pX = worldFromPick(puvX, ndX);
            vec3 pY = worldFromPick(puvY, ndY);
            vec3 nrm = normalize(cross(pX - W, pY - W));
            if (dot(nrm, uCameraPos - W) < 0.0) nrm = -nrm;  // 统一翻向相机
            if (dot(nrm, projectorNormal) < uNormalCut) discard; // 背向投影仪
          }
        }
        uvProj = dUV;                              // 深度比较开启时用光空间 UV（与深度同源）
      }
      vec2 vuv = vec2(uvProj.x, mix(uvProj.y, 1.0 - uvProj.y, uVideoFlipY));
      vec2 vpx = clamp(vuv * uVideoSize, vec2(0.0), max(uVideoSize - vec2(1.0), vec2(0.0)));
      vec4 vid = texelFetch(videoTex, ivec2(vpx), 0);
      float edgeCoord = max(abs(uvProj.x * 2.0 - 1.0), abs(uvProj.y * 2.0 - 1.0));
      float edge = smoothstep(1.0, 1.0 - decalEdge, edgeCoord);
      float a = vid.a * decalOpacity * edge;
      if (a <= 0.004) discard;
      gl_FragColor = vec4(vid.rgb, a);
    }`;

export const DECAL_SHADOW_FRAGMENT_WGSL = /* wgsl */ `
    var pickDepth: texture_2d<f32>;
    var videoTex: texture_2d<f32>;
    var shadowDepth: texture_2d<f32>;
    uniform uPickSize: vec2f;
    uniform uVideoSize: vec2f;
    uniform uResolution: vec2f;
    uniform uShadowSize: vec2f;
    uniform uPickReady: f32;
    uniform uUVSignY: f32;
    uniform uUVOffsetY: f32;
    uniform uPickFlipY: f32;
    uniform uVideoFlipY: f32;
    uniform decalOpacity: f32;
    uniform decalEdge: f32;
    uniform uShadowBias: f32;
    uniform uDepthTest: f32;
    uniform uNormalCut: f32;
    uniform uDebugMode: f32;
    uniform projectorNormal: vec3f;
    uniform uCameraPos: vec3f;
    uniform invViewProj: mat4x4f;
    uniform invProjector: mat4x4f;
    uniform decalHalf: vec3f;
    uniform uBoxScale: f32;
    uniform uPersp: f32;      // 1=透视投影机（视锥体）；0=正交 OBB
    uniform uProjNear: f32;   // 透视近平面距离（沿光轴，米）
    uniform nearClip: f32;
    uniform farClip: f32;
    uniform uProjVP: mat4x4f;
    varying vProj: vec4f;

    fn channelMedian(t: vec4f) -> f32 {
      let lo = min(min(t.r, t.g), min(t.b, t.a));
      let hi = max(max(t.r, t.g), max(t.b, t.a));
      return (t.r + t.g + t.b + t.a - lo - hi) * 0.5;
    }
    // Pass1 4 通道试验深度：3×3 邻域 × 4 = 36 样本取 30% 分位（确定性表面深度）
    fn shadowSurfaceDepth(uv: vec2f) -> f32 {
      let sz = uniform.uShadowSize;
      let c = vec2i(clamp(uv * sz, vec2f(0.0), sz - vec2f(1.0)));
      var s: array<f32, 36>;
      var n = 0;
      for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
          let q = clamp(c + vec2i(dx, dy), vec2i(0), vec2i(sz) - vec2i(1));
          let t = textureLoad(shadowDepth, q, 0);
          s[n] = t.r; s[n + 1] = t.g; s[n + 2] = t.b; s[n + 3] = t.a;
          n += 4;
        }
      }
      let k = max(i32(ceil(f32(n) * 0.3)) - 1, 0);
      for (var i = 0; i <= k && i < n; i++) {
        var mi = i; var mv = s[i];
        for (var j = i + 1; j < n; j++) {
          if (s[j] < mv) { mv = s[j]; mi = j; }
        }
        s[mi] = s[i]; s[i] = mv;
      }
      return s[k];
    }
    // 主相机深度同源口径：5×5 圆盘 × 4 = 52 样本取 30% 分位
    fn pickSurfaceDepthShadow(puv: vec2f) -> f32 {
      let sz = uniform.uPickSize;
      let c = vec2i(clamp(puv * sz, vec2f(0.0), sz - vec2f(1.0)));
      var s: array<f32, 52>;
      var n = 0;
      for (var dy = -2; dy <= 2; dy++) {
        for (var dx = -2; dx <= 2; dx++) {
          if (dx * dx + dy * dy > 4) { continue; }
          let q = clamp(c + vec2i(dx, dy), vec2i(0), vec2i(sz) - vec2i(1));
          let t = textureLoad(pickDepth, q, 0);
          s[n] = t.r; s[n + 1] = t.g; s[n + 2] = t.b; s[n + 3] = t.a;
          n += 4;
        }
      }
      let k = max(i32(ceil(f32(n) * 0.3)) - 1, 0);
      for (var i = 0; i <= k && i < n; i++) {
        var mi = i; var mv = s[i];
        for (var j = i + 1; j < n; j++) {
          if (s[j] < mv) { mv = s[j]; mi = j; }
        }
        s[mi] = s[i]; s[i] = mv;
      }
      return s[k];
    }
    fn pickToScreen(puv: vec2f) -> vec2f {
      return vec2f(puv.x, select(1.0 - puv.y, puv.y, uniform.uPickFlipY > 0.5));
    }
    fn worldFromPick(puv: vec2f, nd: f32) -> vec3f {
      let scr = pickToScreen(puv);
      let ndc = vec2f(scr.x * 2.0 - 1.0, (1.0 - scr.y) * 2.0 - 1.0);
      let ndcZ = (uniform.farClip * nd) / (nd * (uniform.farClip - uniform.nearClip) + uniform.nearClip);
      let clip = vec4f(ndc, ndcZ * 2.0 - 1.0, 1.0);
      let W = uniform.invViewProj * clip;
      return W.xyz / W.w;
    }
    @fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
      var output: FragmentOutput;
      if (uniform.uPickReady < 0.5) { discard; }
      let frag = pcPosition.xy;
      let uvTL = vec2f(frag.x / uniform.uResolution.x,
                       frag.y / uniform.uResolution.y * uniform.uUVSignY + uniform.uUVOffsetY);
      let pickUV = vec2f(uvTL.x, select(1.0 - uvTL.y, uvTL.y, uniform.uPickFlipY > 0.5));
      var nd: f32;
      if (uniform.uDepthTest > 0.5) {
        nd = pickSurfaceDepthShadow(pickUV);
      } else {
        let sz = uniform.uPickSize;
        let q = vec2i(clamp(pickUV * sz, vec2f(0.0), sz - vec2f(1.0)));
        nd = channelMedian(textureLoad(pickDepth, q, 0));
      }
      if (nd >= 1.0) { discard; }
      let W = worldFromPick(pickUV, nd);

      // 默认 always-on-top：投影机局部空间算 UV，不依赖 Pass1 深度相机矩阵
      let L = (uniform.invProjector * vec4f(W, 1.0)).xyz;
      var ln: vec3f;
      if (uniform.uPersp > 0.5) {
        // 透视视锥体：局部 +Z = 光轴，截面半尺寸随视距线性增长。
        // 近平面之前丢弃（避免 L.z → 0 时除法爆掉）；ln.xy 与正交路径同定义。
        if (L.z <= uniform.uProjNear) { discard; }
        ln = vec3f(uniform.decalHalf.z * L.x / (L.z * uniform.decalHalf.x),
                   uniform.decalHalf.z * L.y / (L.z * uniform.decalHalf.y),
                   L.z / uniform.decalHalf.z);
      } else {
        ln = L / (uniform.decalHalf * uniform.uBoxScale);
      }
      if (any(abs(ln) > vec3f(1.0))) { discard; }
      var uvProj = ln.xy * 0.5 + vec2f(0.5, 0.5);

      // 标准三段式：Pass1 用正交相机渲 3DGS 本身，与这里同源。
      // 常规深度（近小远大，1=空）：fragD > mapD + bias → 被遮挡。
      if (uniform.uDepthTest > 0.5) {
        // 诊断探针（uDebugMode=2）：蓝=投影 UV 越界 / 品红=Pass1 深度为空 / 绿=有深度
        if (uniform.uDebugMode > 1.5) {
          let pcD = uniform.uProjVP * vec4f(W, 1.0);
          // WGSL 没有 C 风格三元运算，必须用 select(falseValue, trueValue, cond)
          let cD = pcD.xyz / max(select(1e-6, pcD.w, abs(pcD.w) > 1e-6), 1e-6);
          let dUVD = cD.xy * 0.5 + vec2f(0.5, 0.5);
          if (any(dUVD < vec2f(0.0)) || any(dUVD > vec2f(1.0))) {
            output.color = vec4f(0.0, 0.0, 1.0, 1.0); return output;
          }
          let mapDD = shadowSurfaceDepth(dUVD);
          if (mapDD >= 0.999999) { output.color = vec4f(1.0, 0.0, 1.0, 1.0); return output; }
          output.color = vec4f(0.0, 1.0, 0.0, 1.0); return output;
        }
        if (input.vProj.w <= 0.0) { discard; }
        let pc = uniform.uProjVP * vec4f(W, 1.0);
        let c = pc.xyz / pc.w;
        let dUV = c.xy * 0.5 + vec2f(0.5, 0.5);
        if (any(dUV < vec2f(0.0)) || any(dUV > vec2f(1.0))) { discard; }
        // 深度口径与 Pass1 对齐：透视投影下 NDC z 非线性，
        // 必须用 pc.w（沿光轴视距）换算成归一化线性深度再比较。
        var fragD: f32;
        if (uniform.uPersp > 0.5) {
          fragD = (pc.w - uniform.uProjNear) /
            max(uniform.decalHalf.z - uniform.uProjNear, 1e-4);
        } else {
          fragD = c.z * 0.5 + 0.5;
        }
        let mapD = shadowSurfaceDepth(dUV);
        if (mapD >= 0.999999) { discard; }
        if (fragD > mapD + uniform.uShadowBias) { discard; }
        // 法线点积剔除：世界空间重建法线，翻向相机后与投射方向点积
        if (uniform.uNormalCut > 0.0) {
          let texel = 1.0 / uniform.uPickSize;
          let puvX = pickUV + vec2f(texel.x, 0.0);
          let puvY = pickUV + vec2f(0.0, texel.y);
          let ndX = pickSurfaceDepthShadow(puvX);
          let ndY = pickSurfaceDepthShadow(puvY);
          if (ndX < 1.0 && ndY < 1.0) {
            let pX = worldFromPick(puvX, ndX);
            let pY = worldFromPick(puvY, ndY);
            var nrm = normalize(cross(pX - W, pY - W));
            if (dot(nrm, uniform.uCameraPos - W) < 0.0) { nrm = -nrm; }
            if (dot(nrm, uniform.projectorNormal) < uniform.uNormalCut) { discard; }
          }
        }
        uvProj = dUV;
      }
      let vuv = vec2f(uvProj.x, mix(uvProj.y, 1.0 - uvProj.y, uniform.uVideoFlipY));
      let vpx = vec2i(clamp(vuv * uniform.uVideoSize, vec2f(0.0), uniform.uVideoSize - vec2f(1.0)));
      let vid = textureLoad(videoTex, vpx, 0);
      let edgeCoord = max(abs(uvProj.x * 2.0 - 1.0), abs(uvProj.y * 2.0 - 1.0));
      let edge = smoothstep(1.0, 1.0 - uniform.decalEdge, edgeCoord);
      let a = vid.a * uniform.decalOpacity * edge;
      if (a <= 0.004) { discard; }
      output.color = vec4f(vid.rgb, a);
      return output;
    }`;

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
  'uBoxScale', 'uDepthMode', 'uDebugMode', 'uCameraPos'
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
    uniform float uBoxScale;         // OBB 归一化基准：1.0=盒面 |ln|=1（整框）；0.5=旧行为（仅内侧 1/4）
    uniform float uDepthMode;        // 1=引擎同族 5×5 邻域 30% 分位；0=单 texel 4 通道中位（性能兜底）
    uniform float uDebugMode;        // 0 正常；1 深度灰度；2 失败分类着色
    uniform vec3  uCameraPos;        // 相机世界位置（把重建法向统一翻向可见侧）
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

    void main(void) {
      if (uPickReady < 0.5) discard;
      vec2 frag = gl_FragCoord.xy;
      vec2 uvTL = vec2(frag.x / uResolution.x,
                       frag.y / uResolution.y * uUVSignY + uUVOffsetY);  // 屏幕坐标，y 向下
      // pick 快照采样：WebGL 纹理行0=底部（uvBL），WebGPU 纹理行0=顶部（uvTL）。
      // 行序弄反 = 深度图上下镜像 = 重建世界点几乎全部落在投影盒外 = 「只有包围盒没有视频」。
      vec2 pickUV = vec2(uvTL.x, mix(1.0 - uvTL.y, uvTL.y, uPickFlipY));
      float nd = uDepthMode > 0.5 ? pickSurfaceDepth(pickUV) : pickFastDepth(pickUV);
      if (nd >= 1.0) discard;                                          // 该像素无表面
      vec3 world = worldFromPick(pickUV, nd);
      vec3 L = (invProjector * vec4(world, 1.0)).xyz;                  // 刚性变换，w=1
      // 归一化基准：uBoxScale=1.0 时盒面 |ln|=1（即整框都算命中）；
      // uBoxScale=0.5 复现旧行为（只接受每轴内侧 1/4），保留为回退开关。
      vec3 ln = L / (decalHalf * uBoxScale);
      bool outXY = any(greaterThan(abs(ln.xy), vec2(1.0)));
      bool outZ = abs(ln.z) > 1.0;
      if (outXY || outZ) {
        if (uDebugMode > 1.5) { gl_FragColor = vec4(outXY ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0), 1.0); return; }
        discard;
      }
      if (uCull > 0.5) {
        // 用深度差分重建「真实表面法向」，而不是屏幕空间导数法向：
        // 随机深度下 dFdx/dFdy 的符号会抖动，导数法向只会误杀不会增值。
        vec2 texel = 1.0 / uPickSize;
        vec2 puvX = pickUV + vec2(texel.x, 0.0);
        vec2 puvY = pickUV + vec2(0.0, texel.y);
        vec3 pX = worldFromPick(puvX, pickFastDepth(puvX));
        vec3 pY = worldFromPick(puvY, pickFastDepth(puvY));
        vec3 nrm = normalize(cross(pX - world, pY - world));
        vec3 toCam = uCameraPos - world;
        if (dot(nrm, toCam) < 0.0) nrm = -nrm;                         // 统一翻向可见侧
        if (dot(nrm, projectorNormal) < -0.25) {                       // 软剔除：只挡真背面
          if (uDebugMode > 1.5) { gl_FragColor = vec4(0.0, 0.0, 1.0, 1.0); return; }
          discard;
        }
      }
      vec2 uv = ln.xy * 0.5 + 0.5;
      vec2 vpx = clamp(uv * uVideoSize, vec2(0.0), max(uVideoSize - vec2(1.0), vec2(0.0)));
      vec4 vid = texelFetch(videoTex, ivec2(vpx), 0);
      float edge = smoothstep(1.0, 1.0 - decalEdge, max(abs(ln.x), abs(ln.y)));
      float a = vid.a * decalOpacity * edge;
      if (uDebugMode > 0.5 && uDebugMode < 1.5) { gl_FragColor = vec4(vec3(nd), 1.0); return; }
      if (a <= 0.001) discard;
      gl_FragColor = vec4(vid.rgb, a);
    }`;

export const DECAL_FRAGMENT_WGSL = /* wgsl */ `
    var pickDepth: texture_2d<f32>;
    var videoTex: texture_2d<f32>;
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
    uniform uBoxScale: f32;
    uniform uDepthMode: f32;
    uniform uDebugMode: f32;
    uniform uCameraPos: vec3f;

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

    @fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
      var output: FragmentOutput;
      if (uniform.uPickReady < 0.5) { discard; }
      let frag = pcPosition.xy;
      let uvTL = vec2f(frag.x / uniform.uResolution.x,
                       frag.y / uniform.uResolution.y * uniform.uUVSignY + uniform.uUVOffsetY);
      // pick 快照采样行序：WebGPU 纹理行0=顶部（直接用 uvTL），WebGL 行0=底部（uvBL）
      let pickUV = vec2f(uvTL.x, select(1.0 - uvTL.y, uvTL.y, uniform.uPickFlipY > 0.5));
      let nd = select(pickFastDepth(pickUV), pickSurfaceDepth(pickUV), uniform.uDepthMode > 0.5);
      if (nd >= 1.0) { discard; }
      let world = worldFromPick(pickUV, nd);
      let L = (uniform.invProjector * vec4f(world, 1.0)).xyz;
      // 归一化基准：uBoxScale=1.0 时盒面 |ln|=1（整框命中）；0.5 复现旧行为。
      let ln = L / (uniform.decalHalf * uniform.uBoxScale);
      let outXY = any(abs(ln.xy) > vec2f(1.0));
      let outZ = abs(ln.z) > 1.0;
      if (outXY || outZ) {
        if (uniform.uDebugMode > 1.5) {
          output.color = vec4f(select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), outXY), 1.0);
          return output;
        }
        discard;
      }
      if (uniform.uCull > 0.5) {
        // 深度差分重建真实表面法向（避免屏幕空间导数法向的符号抖动）
        let texel = vec2f(1.0, 1.0) / uniform.uPickSize;
        let puvX = pickUV + vec2f(texel.x, 0.0);
        let puvY = pickUV + vec2f(0.0, texel.y);
        let pX = worldFromPick(puvX, pickFastDepth(puvX));
        let pY = worldFromPick(puvY, pickFastDepth(puvY));
        var nrm = normalize(cross(pX - world, pY - world));
        let toCam = uniform.uCameraPos - world;
        if (dot(nrm, toCam) < 0.0) { nrm = -nrm; }
        if (dot(nrm, uniform.projectorNormal) < -0.25) {
          if (uniform.uDebugMode > 1.5) { output.color = vec4f(0.0, 0.0, 1.0, 1.0); return output; }
          discard;
        }
      }
      let uv = ln.xy * 0.5 + vec2f(0.5, 0.5);
      let vpx = clamp(uv * uniform.uVideoSize, vec2f(0.0), max(uniform.uVideoSize - vec2f(1.0), vec2f(0.0)));
      let vid = textureLoad(videoTex, vec2i(vpx), 0);
      let edge = smoothstep(1.0, 1.0 - uniform.decalEdge, max(abs(ln.x), abs(ln.y)));
      let a = vid.a * uniform.decalOpacity * edge;
      if (uniform.uDebugMode > 0.5 && uniform.uDebugMode < 1.5) { output.color = vec4f(vec3f(nd), 1.0); return output; }
      if (a <= 0.001) { discard; }
      output.color = vec4f(vid.rgb, a);
      return output;
    }`;

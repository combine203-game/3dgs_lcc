/**
 * 实时深度图视口的着色器（引擎层，GLSL + WGSL 双后端）。
 * ----------------------------------------------------------------
 * 一个材质、两种数据源（uMode）：
 *   uMode = 0  gsplat —— 引擎 Picker 的 RGBA16F 纹理（4 通道随机试验，1.0 = 空）；
 *   uMode = 1  mesh   —— CPU 光栅化的碰撞 mesh 深度，RGBA8：16 bit 打包在 RG
 *                        （R 高 8 位 / G 低 8 位，值 = 1-nd），A = 0 表示空洞。
 *                        见 web/mesh-depth-raster.js（走 CPU 是因为引擎离屏通道
 *                        在这个构建里只清屏不提交 draw）。
 * 归一化口径两者一致：[near, far] 线性 → nd ∈ [0,1]，所以能逐像素对比。
 *
 * gsplat 的取数口径与贴花投射完全同源：引擎 Picker 的 `renderView()` 返回的
 * RGBA16F 纹理，每个通道是一次随机试验的「最近存活归一化线性深度」，1.0 = 该像素
 * 没有表面。所以这里的取数口径直接照抄 decal-shaders.js：
 *   - 行序分后端：WebGPU 行 0 = 顶部，WebGL 行 0 = 底部（uPickFlipY）；
 *   - 帧缓冲坐标 → 左上原点 UV 需按后端给 uUVSignY / uUVOffsetY 做翻转；
 *   - 深度取 4 通道的**最小值**（= 4 次随机试验里最近的一次命中）。
 *     贴花那边用中位数是为了贴合表面不掉色，这里相反：中位数在薄结构 / 边缘
 *     上只要 3 次试验落空就判成「无表面」，深度图会撒满品红噪点；取最小则
 *     只有在 4 次全落空时才画品红，画面干净得多，语义上也正是「最近表面」。
 *
 * 形态：**独立视口**，不再整幅替换主画面。
 *   uRect = [x, y, w, h] 是视口在画布上的归一化矩形（左上原点）。
 *   四边形依旧铺满屏幕（引擎那边不用改几何 / 视口裁剪），但视口外的片元直接
 *   discard —— 主窗口的 3DGS 画面一个像素都不动。视口内先按 pick 纹理纵横比
 *   做 contain 信箱（panel 形状随意拖，深度图不变形），信箱边填深色。
 *
 * 就绪前不再 discard（否则视口会「透」出底下的主画面），改为铺视口底色；
 * 这是整幅覆盖时代留下来的老约束，换成独立视口后已经可以安全放开。
 *
 * 映射：z = near + nd*(far-near) 米，再按对数区间 [uRangeNear, uRangeFar]
 * 归一化成 0..1，近亮远暗。对数是为了让 1~5 m 的室内结构与 60 m 外的
 * 远景同时分层（线性映射下近处全白、远处全黑，看不出结构）。
 */

export const DEPTH_VIEW_UNIFORM_NAMES = [
  'pickDepth', 'uPickSize', 'uPickReady', 'uResolution', 'uRect', 'uMode',
  'uUVSignY', 'uUVOffsetY', 'uPickFlipY',
  'nearClip', 'farClip', 'uRangeNear', 'uRangeFar'
];

export const DEPTH_VIEW_VERTEX_GLSL = /* glsl */ `
    attribute vec2 vertex_position;
    uniform mat4 matrix_model;
    void main(void) {
      gl_Position = matrix_model * vec4(vertex_position, 0.0, 1.0);
    }`;

export const DEPTH_VIEW_VERTEX_WGSL = /* wgsl */ `
    attribute vertex_position: vec2f;
    uniform matrix_model: mat4x4f;
    @vertex fn vertexMain(input: VertexInput) -> VertexOutput {
      var output: VertexOutput;
      output.position = uniform.matrix_model * vec4f(input.vertex_position, 0.0, 1.0);
      return output;
    }`;

export const DEPTH_VIEW_FRAGMENT_GLSL = /* glsl */ `
    uniform sampler2D pickDepth;
    uniform vec2  uPickSize;
    uniform vec2  uResolution;
    uniform vec4  uRect;
    uniform float uMode;
    uniform float uPickReady;
    uniform float uUVSignY;
    uniform float uUVOffsetY;
    uniform float uPickFlipY;
    uniform float nearClip;
    uniform float farClip;
    uniform float uRangeNear;
    uniform float uRangeFar;

    /* 4 次试验里最近的一次命中：1.0 表示该次试验没打到表面 */
    float channelNearest(vec4 v) {
      return min(min(v.x, v.y), min(v.z, v.w));
    }

    void main(void) {
      vec2 frag = gl_FragCoord.xy;
      vec2 uvTL = vec2(frag.x / uResolution.x,
                       frag.y / uResolution.y * uUVSignY + uUVOffsetY);
      vec2 p = (uvTL - uRect.xy) / max(uRect.zw, vec2(1e-5));
      if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) discard;   // 视口外：主画面保持原样

      /* 中性深灰：信箱边与未就绪底色都属于「深度视口自己的边框」，
         RGB 必须相等，否则会被像素统计当成彩色内容（拖窄面板时信箱占比可达 25%） */
      vec3 edge = vec3(0.028);
      if (uPickReady < 0.5) {              // 深度未就绪：铺视口底色，不「透」出主画面
        gl_FragColor = vec4(edge, 1.0);
        return;
      }

      /* contain 信箱：面板怎么拖，深度图都不变形 */
      float panelAspect = (uRect.z * uResolution.x) / max(uRect.w * uResolution.y, 1e-5);
      float imgAspect = uPickSize.x / max(uPickSize.y, 1.0);
      vec2 fit = vec2(1.0);
      if (panelAspect > imgAspect) fit.x = imgAspect / panelAspect;
      else                        fit.y = panelAspect / imgAspect;
      vec2 q = (p - (1.0 - fit) * 0.5) / fit;
      if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) {
        gl_FragColor = vec4(edge, 1.0);
        return;
      }

      vec2 pickUV = vec2(q.x, mix(1.0 - q.y, q.y, uPickFlipY));
      ivec2 t = ivec2(clamp(pickUV * uPickSize, vec2(0.0), uPickSize - vec2(1.0)));
      vec4 smp = texelFetch(pickDepth, t, 0);
      float nd;
      bool hasSurface;
      if (uMode < 0.5) {
        /* 3DGS：4 通道随机试验取最近命中，1.0 = 无表面 */
        nd = channelNearest(smp);
        hasSurface = nd < 0.999;
      } else {
        /* 碰撞 mesh（CPU 光栅化）：16 bit 打包在 RG（R 高 8 位 / G 低 8 位），
           A = 255 表示该像素有表面；A = 0 才是空洞（远处 nd=1 时 RG 也是 0）。 */
        hasSurface = smp.a > 0.5;
        nd = 1.0 - (smp.r * 65280.0 + smp.g * 255.0) / 65535.0;
      }
      if (!hasSurface) {                   // 该像素没有表面：品红，与引擎调试面板同约定
        gl_FragColor = vec4(0.78, 0.0, 0.55, 1.0);
        return;
      }
      float z = nearClip + nd * (farClip - nearClip);
      float s = clamp(log(max(z, uRangeNear) / uRangeNear) / log(uRangeFar / uRangeNear),
                      0.0, 1.0);
      float g = 1.0 - s;                   // 近亮远暗
      gl_FragColor = vec4(g, g, g, 1.0);
    }`;

export const DEPTH_VIEW_FRAGMENT_WGSL = /* wgsl */ `
    var pickDepth: texture_2d<f32>;
    uniform uPickSize: vec2f;
    uniform uResolution: vec2f;
    uniform uRect: vec4f;
    uniform uMode: f32;
    uniform uPickReady: f32;
    uniform uUVSignY: f32;
    uniform uUVOffsetY: f32;
    uniform uPickFlipY: f32;
    uniform nearClip: f32;
    uniform farClip: f32;
    uniform uRangeNear: f32;
    uniform uRangeFar: f32;

    /* 4 次试验里最近的一次命中：1.0 表示该次试验没打到表面 */
    fn channelNearest(v: vec4f) -> f32 {
      return min(min(v.x, v.y), min(v.z, v.w));
    }

    @fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
      var output: FragmentOutput;
      let frag = pcPosition.xy;
      let uvTL = vec2f(frag.x / uniform.uResolution.x,
                       frag.y / uniform.uResolution.y * uniform.uUVSignY + uniform.uUVOffsetY);
      let p = (uvTL - uniform.uRect.xy) / max(uniform.uRect.zw, vec2f(1e-5));
      if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) {
        discard;                           // 视口外：主画面保持原样
      }

      // 中性深灰，理由同 GLSL：信箱边不能算成彩色内容
      let edge = vec3f(0.028);
      if (uniform.uPickReady < 0.5) {
        output.color = vec4f(edge, 1.0);
        return output;
      }

      /* contain 信箱：面板怎么拖，深度图都不变形 */
      let panelAspect = (uniform.uRect.z * uniform.uResolution.x) /
                        max(uniform.uRect.w * uniform.uResolution.y, 1e-5);
      let imgAspect = uniform.uPickSize.x / max(uniform.uPickSize.y, 1.0);
      var fit = vec2f(1.0, 1.0);
      if (panelAspect > imgAspect) { fit.x = imgAspect / panelAspect; }
      else { fit.y = panelAspect / imgAspect; }
      let q = (p - (vec2f(1.0, 1.0) - fit) * 0.5) / fit;
      if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) {
        output.color = vec4f(edge, 1.0);
        return output;
      }

      // WGSL 没有三元运算符，必须用 select(falseValue, trueValue, cond)
      let pickUV = vec2f(q.x, select(1.0 - q.y, q.y, uniform.uPickFlipY > 0.5));
      let t = vec2i(clamp(pickUV * uniform.uPickSize,
                          vec2f(0.0), uniform.uPickSize - vec2f(1.0)));
      let sample4 = textureLoad(pickDepth, t, 0);
      // 0 = 3DGS pick（4 通道取最近命中，1.0 = 空）
      // 1 = 碰撞 mesh（CPU 光栅化，16 bit 在 RG，A=0 表示空洞）
      var nd = channelNearest(sample4);
      var hasSurface = nd < 0.999;
      if (uniform.uMode > 0.5) {
        hasSurface = sample4.a > 0.5;
        nd = 1.0 - (sample4.r * 65280.0 + sample4.g * 255.0) / 65535.0;
      }
      if (!hasSurface) {
        output.color = vec4f(0.78, 0.0, 0.55, 1.0);
        return output;
      }
      let z = uniform.nearClip + nd * (uniform.farClip - uniform.nearClip);
      let s = clamp(log(max(z, uniform.uRangeNear) / uniform.uRangeNear) /
                    log(uniform.uRangeFar / uniform.uRangeNear), 0.0, 1.0);
      let g = 1.0 - s;
      output.color = vec4f(g, g, g, 1.0);
      return output;
    }`;

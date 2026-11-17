/**
 * PcSplatAvatar — 单引擎（PlayCanvas 2.23.3 原生）3DGS 高斯化身  [v2]
 * ============================================================================
 * 与 v1 (`splat-avatar.js`) 的区别：
 *   · v1：three.js InstancedBufferGeometry + THREE.ShaderMaterial，跑在**第二个
 *     WebGL 上下文**上，再透明叠加到 PlayCanvas canvas。
 *   · v2：数据仍然从 three 的 SkinnedMesh 采样（上游 three-motionbricks 要求），
 *     但**渲染完全交给 PlayCanvas**：`__pc.Mesh` + `MeshInstance` + `ShaderMaterial`
 *     挂进 `app.scene.defaultDrawLayer`，和 SOG 场景共用同一个 graphicsDevice、
 *     同一台相机、同一个渲染循环。页面里不再有第二个 WebGL 上下文。
 *
 * 数据通道（全部 RGBA32F 浮点纹理，vertex shader 用 texelFetch 取）：
 *   splatTex : 每 splat 8 texel —— 中心/半径、法向/alpha、颜色/quat.x、quat.yzw、
 *              骨骼索引、骨骼权重、2 个预留槽。
 *   boneTex  : 每骨骼 4 texel（一个 mat4，LBS 混合矩阵）。每帧更新。
 *   orderTex : 每绘制序 1 texel，存「该次序对应的 splat id」。每帧由桶排序更新。
 *   几何     : 4 顶点 quad + 6 索引，setInstancing(true,true) + instancingCount=n，
 *              `gl_InstanceID` 即绘制序，查 orderTex 得到 splat id。
 *              引擎自带 GSplatQuadRenderer 用的就是这套范式（bundle:62509）。
 *
 * 采样算法、LBS 矩阵推导、EWA 投影、8192 桶排序键与 v1 完全一致（见 CONTRACT §2），
 * 因此外观、身高、性能基线可直接对比。
 */
import * as THREE from 'three';

const BUCKETS = 8192;
const TEX_W = 1024;             /* 浮点纹理宽度；maxTextureSize 实测 8192 */
const SLOTS = 8;                /* 每 splat 占用的 texel 数 */
const RGBA32F = 14;             /* bundle: PIXELFORMAT_RGBA32F = 14（__pc 未导出） */

/* ------------------------------------------------------------------ shader */

const VERT_GLSL = /* glsl */`
attribute vec3 vertex_position;      /* xy = quad corner ∈ [-1,1] */

/* 三个矩阵全部用引擎内置 uniform（由 PlayCanvas 每帧自动注入）。
   实测：自定义 mat4 名（uModel/uView/uProj）即使 setParameter/getParameter 有值，
   shader 侧仍可能拿不到，导致 clip.w=0、整批片元被裁掉。矩阵一律走内置名。 */
uniform mat4 matrix_model;
uniform mat4 matrix_view;
uniform mat4 matrix_projection;
uniform vec4 viewport_size;          /* 引擎每帧注入：xy=宽高, zw=1/宽高 */
uniform float uOpacity;
uniform sampler2D splatTex;
uniform sampler2D boneTex;
uniform sampler2D orderTex;

varying vec3 vColor;
varying float vAlpha;
varying vec2 vLocal;

ivec2 splatAddr(int sid, int slot) {
  int t = sid * ${SLOTS} + slot;
  return ivec2(t % ${TEX_W}, t / ${TEX_W});
}
vec4 slot(int sid, int n) { return texelFetch(splatTex, splatAddr(sid, n), 0); }
vec4 boneRow(float bi, float row) {
  return texelFetch(boneTex, ivec2(int(bi) * 4 + int(row), 0), 0);
}
mat3 quatToMat3(vec4 q) {
  float x = q.x, y = q.y, z = q.z, w = q.w;
  float x2 = x + x, y2 = y + y, z2 = z + z;
  float xx = x * x2, xy = x * y2, xz = x * z2;
  float yy = y * y2, yz = y * z2, zz = z * z2;
  float wx = w * x2, wy = w * y2, wz = w * z2;
  return mat3(
    1.0 - (yy + zz), xy + wz, xz - wy,
    xy - wz, 1.0 - (xx + zz), yz + wx,
    xz + wy, yz - wx, 1.0 - (xx + yy)
  );
}
void accumBone(inout vec4 c0, inout vec4 c1, inout vec4 c2, inout vec4 c3, float bi, float w) {
  if (w > 0.0001) {
    c0 += w * boneRow(bi, 0.0);
    c1 += w * boneRow(bi, 1.0);
    c2 += w * boneRow(bi, 2.0);
    c3 += w * boneRow(bi, 3.0);
  }
}
vec2 projJac(vec3 b, vec3 vp, float fx, float fy, float iz) {
  float k = iz * iz;
  return vec2(fx * (b.x * iz - vp.x * b.z * k),
              fy * (b.y * iz - vp.y * b.z * k));
}

void main(void) {
  int ordinal = gl_InstanceID;
  int sid = int(texelFetch(orderTex, ivec2(ordinal % ${TEX_W}, ordinal / ${TEX_W}), 0).r + 0.5);

  vec4 s0 = slot(sid, 0);   /* center.xyz, scale */
  vec4 s1 = slot(sid, 1);   /* normal.xyz, alpha */
  vec4 s2 = slot(sid, 2);   /* color.rgb, quat.x */
  vec4 s3 = slot(sid, 3);   /* quat.yzw */
  vec4 s4 = slot(sid, 4);   /* boneIdx */
  vec4 s5 = slot(sid, 5);   /* boneW */

  /* ---- 1. LBS ---- */
  vec4 c0 = vec4(0.0), c1 = vec4(0.0), c2 = vec4(0.0), c3 = vec4(0.0);
  accumBone(c0, c1, c2, c3, s4.x, s5.x);
  accumBone(c0, c1, c2, c3, s4.y, s5.y);
  accumBone(c0, c1, c2, c3, s4.z, s5.z);
  accumBone(c0, c1, c2, c3, s4.w, s5.w);
  mat4 M = mat4(c0, c1, c2, c3);
  mat3 A = mat3(c0.xyz, c1.xyz, c2.xyz);

  vec3 pLocal = (M * vec4(s0.xyz, 1.0)).xyz;
  vec3 nrm = A * s1.xyz;
  float nl = length(nrm);
  vec3 n = nl > 1e-6 ? nrm / nl : normalize(s1.xyz);

  vec4 world = matrix_model * vec4(pLocal, 1.0);
  vec4 vp = matrix_view * world;
  vec4 clip = matrix_projection * vp;

  vColor = s2.xyz;
  vAlpha = s1.w * uOpacity;
  vLocal = vertex_position.xy * 3.0;
  gl_Position = clip;

  if (clip.w < 0.05) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    vAlpha = 0.0;
    return;
  }

  /* ---- 2. 椭圆朝向 ---- */
  mat3 R = quatToMat3(vec4(s2.w, s3.x, s3.y, s3.z));
  vec3 t = A * R[0];
  vec3 zAxis = n;
  vec3 xAxis = t - zAxis * dot(zAxis, t);
  float xl = length(xAxis);
  if (xl < 1e-5) {
    vec3 helper = abs(zAxis.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    xAxis = normalize(cross(helper, zAxis));
  } else {
    xAxis /= xl;
  }
  vec3 yAxis = cross(zAxis, xAxis);
  mat3 frame = mat3(xAxis, yAxis, zAxis);
  float s = s0.w;
  mat3 S = mat3(vec3(s, 0.0, 0.0), vec3(0.0, s, 0.0), vec3(0.0, 0.0, s * 0.35));
  mat3 MV3 = mat3(matrix_view * matrix_model);
  mat3 Q = MV3 * frame * S;

  /* ---- 3. 屏幕空间 2x2 协方差 ---- */
  float z = max(-vp.z, 0.05);
  float iz = 1.0 / z;
  float fx = matrix_projection[0][0] * 0.5 * viewport_size.x;
  float fy = matrix_projection[1][1] * 0.5 * viewport_size.y;
  vec2 e0 = projJac(Q[0], vp.xyz, fx, fy, iz);
  vec2 e1 = projJac(Q[1], vp.xyz, fx, fy, iz);
  vec2 e2 = projJac(Q[2], vp.xyz, fx, fy, iz);
  float a11 = e0.x * e0.x + e1.x * e1.x + e2.x * e2.x + 0.3;
  float a12 = e0.x * e0.y + e1.x * e1.y + e2.x * e2.y;
  float a22 = e0.y * e0.y + e1.y * e1.y + e2.y * e2.y + 0.3;

  /* ---- 4. 特征分解 → 3σ 椭圆 ---- */
  float mid = 0.5 * (a11 + a22);
  float diff = 0.5 * (a11 - a22);
  float disc = sqrt(max(diff * diff + a12 * a12, 0.0));
  float l1 = max(mid + disc, 1e-4);
  float l2 = max(mid - disc, 0.09);
  vec2 v1 = abs(a12) > 1e-8 ? normalize(vec2(a12, l1 - a11))
                            : (a11 >= a22 ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
  vec2 v2 = vec2(-v1.y, v1.x);
  vec2 delta = vertex_position.x * v1 * (sqrt(l1) * 3.0)
             + vertex_position.y * v2 * (sqrt(l2) * 3.0);
  gl_Position.xy += delta * (2.0 * viewport_size.zw) * clip.w;
}
`;

const FRAG_GLSL = /* glsl */`
precision highp float;
varying vec3 vColor;
varying float vAlpha;
varying vec2 vLocal;
void main(void) {
  float r2 = dot(vLocal, vLocal);
  if (r2 > 9.0) discard;
  float e0 = 0.011109;
  float g = exp(-0.5 * r2);
  float alpha = max(g - e0, 0.0) / (1.0 - e0) * vAlpha;
  if (alpha < 0.00392) discard;
  gl_FragColor = vec4(vColor, alpha);
}
`;

/* ------------------------------------------------------------------ WGSL
 * 有头 Chrome 默认走 WebGPU。宿主 createGraphicsDevice() 只传了 deviceTypes，
 * 没传 glslangUrl/twgslUrl → device.hasTranspilers === false，GLSL 材质会报
 * "Cannot transpile shader ... glslang/twgsl are not available" 并静默不出像素
 * （tools/probe_webgpu_shader.mjs 实测）。因此 WebGPU 后端必须提供 WGSL 版本。
 *
 * PlayCanvas 2.x 的 WGSL ShaderMaterial 语法（见 bundle: immediateLine_default）：
 *   attribute <name>: <type>;   → input.<name>
 *   uniform <name>: <type>;     → uniform.<name>（内置 view UBO 成员同名，可直接引用）
 *   var <name>: texture_2d<f32>; → material.setParameter(<name>, Texture) 绑定
 *   varying <name>: <type>;     → output.<name> / input.<name>
 *   @vertex  fn vertexMain(input: VertexInput)  -> VertexOutput   （output.position）
 *   @fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput（output.color）
 *   input.instanceIndex 等价于 GLSL 的 gl_InstanceID，textureLoad 等价于 texelFetch。
 * WGSL 没有 inout / 三元 ?: / 向量 swizzle 赋值，改用显式循环、select() 与整体重建 vec4f。
 */
const VERT_WGSL = /* wgsl */`
attribute vertex_position: vec3f;

uniform matrix_model: mat4x4f;
uniform matrix_view: mat4x4f;
uniform matrix_projection: mat4x4f;
uniform viewport_size: vec4f;
uniform uOpacity: f32;

var splatTex: texture_2d<f32>;
var boneTex: texture_2d<f32>;
var orderTex: texture_2d<f32>;

varying vColor: vec3f;
varying vAlpha: f32;
varying vLocal: vec2f;

fn splatAddr(sid: i32, n: i32) -> vec2i {
  let t = sid * ${SLOTS} + n;
  return vec2i(t % ${TEX_W}, t / ${TEX_W});
}
fn slotData(sid: i32, n: i32) -> vec4f {
  return textureLoad(splatTex, splatAddr(sid, n), 0);
}
fn boneRow(bi: i32, row: i32) -> vec4f {
  return textureLoad(boneTex, vec2i(bi * 4 + row, 0), 0);
}
fn quatToMat3(q: vec4f) -> mat3x3f {
  let x = q.x; let y = q.y; let z = q.z; let w = q.w;
  let x2 = x + x; let y2 = y + y; let z2 = z + z;
  let xx = x * x2; let xy = x * y2; let xz = x * z2;
  let yy = y * y2; let yz = y * z2; let zz = z * z2;
  let wx = w * x2; let wy = w * y2; let wz = w * z2;
  return mat3x3f(
    vec3f(1.0 - (yy + zz), xy + wz, xz - wy),
    vec3f(xy - wz, 1.0 - (xx + zz), yz + wx),
    vec3f(xz + wy, yz - wx, 1.0 - (xx + yy))
  );
}
fn projJac(b: vec3f, vp: vec3f, fx: f32, fy: f32, iz: f32) -> vec2f {
  let k = iz * iz;
  return vec2f(fx * (b.x * iz - vp.x * b.z * k),
               fy * (b.y * iz - vp.y * b.z * k));
}

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let ordinal: i32 = i32(input.instanceIndex);
  let sid: i32 = i32(textureLoad(orderTex, vec2i(ordinal % ${TEX_W}, ordinal / ${TEX_W}), 0).r + 0.5);

  let s0 = slotData(sid, 0);
  let s1 = slotData(sid, 1);
  let s2 = slotData(sid, 2);
  let s3 = slotData(sid, 3);
  let s4 = slotData(sid, 4);
  let s5 = slotData(sid, 5);

  /* ---- 1. LBS ---- */
  var c0 = vec4f(0.0); var c1 = vec4f(0.0);
  var c2 = vec4f(0.0); var c3 = vec4f(0.0);
  for (var k: i32 = 0; k < 4; k = k + 1) {
    let w = s5[k];
    if (w > 0.0001) {
      let bi = i32(s4[k]);
      c0 = c0 + w * boneRow(bi, 0);
      c1 = c1 + w * boneRow(bi, 1);
      c2 = c2 + w * boneRow(bi, 2);
      c3 = c3 + w * boneRow(bi, 3);
    }
  }
  let M = mat4x4f(c0, c1, c2, c3);
  let A = mat3x3f(c0.xyz, c1.xyz, c2.xyz);
  let pLocal = (M * vec4f(s0.xyz, 1.0)).xyz;
  let nrm = A * s1.xyz;
  let nl = length(nrm);
  let n = select(normalize(s1.xyz), nrm / max(nl, 1e-6), nl > 1e-6);

  let world = uniform.matrix_model * vec4f(pLocal, 1.0);
  let vp = uniform.matrix_view * world;
  var clip = uniform.matrix_projection * vp;

  output.vColor = s2.xyz;
  output.vAlpha = s1.w * uniform.uOpacity;
  output.vLocal = input.vertex_position.xy * 3.0;

  if (clip.w >= 0.05) {
    /* ---- 2. 椭圆朝向 ---- */
    let R = quatToMat3(vec4f(s2.w, s3.x, s3.y, s3.z));
    let t = A * R[0];
    let zAxis = n;
    var xAxis = t - zAxis * dot(zAxis, t);
    let xl = length(xAxis);
    if (xl < 1e-5) {
      let helper = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(zAxis.y) < 0.9);
      xAxis = normalize(cross(helper, zAxis));
    } else {
      xAxis = xAxis / xl;
    }
    let yAxis = cross(zAxis, xAxis);
    let frame = mat3x3f(xAxis, yAxis, zAxis);
    let s = s0.w;
    let S = mat3x3f(vec3f(s, 0.0, 0.0), vec3f(0.0, s, 0.0), vec3f(0.0, 0.0, s * 0.35));
    let mv = uniform.matrix_view * uniform.matrix_model;
    let MV3 = mat3x3f(mv[0].xyz, mv[1].xyz, mv[2].xyz);
    let Q = MV3 * frame * S;

    /* ---- 3. 屏幕空间 2x2 协方差 ---- */
    let z = max(-vp.z, 0.05);
    let iz = 1.0 / z;
    let fx = uniform.matrix_projection[0][0] * 0.5 * uniform.viewport_size.x;
    let fy = uniform.matrix_projection[1][1] * 0.5 * uniform.viewport_size.y;
    let e0 = projJac(Q[0], vp.xyz, fx, fy, iz);
    let e1 = projJac(Q[1], vp.xyz, fx, fy, iz);
    let e2 = projJac(Q[2], vp.xyz, fx, fy, iz);
    let a11 = e0.x * e0.x + e1.x * e1.x + e2.x * e2.x + 0.3;
    let a12 = e0.x * e0.y + e1.x * e1.y + e2.x * e2.y;
    let a22 = e0.y * e0.y + e1.y * e1.y + e2.y * e2.y + 0.3;

    /* ---- 4. 特征分解 → 3σ 椭圆 ---- */
    let mid = 0.5 * (a11 + a22);
    let diff = 0.5 * (a11 - a22);
    let disc = sqrt(max(diff * diff + a12 * a12, 0.0));
    let l1 = max(mid + disc, 1e-4);
    let l2 = max(mid - disc, 0.09);
    let v1base = select(vec2f(0.0, 1.0), vec2f(1.0, 0.0), a11 >= a22);
    let v1 = select(v1base, normalize(vec2f(a12, l1 - a11)), abs(a12) > 1e-8);
    let v2 = vec2f(-v1.y, v1.x);
    let delta = input.vertex_position.x * v1 * (sqrt(l1) * 3.0)
              + input.vertex_position.y * v2 * (sqrt(l2) * 3.0);
    let dxy = delta * (2.0 * uniform.viewport_size.zw) * clip.w;
    clip = vec4f(clip.xy + dxy, clip.z, clip.w);
  } else {
    output.vAlpha = 0.0;
    clip = vec4f(0.0, 0.0, 2.0, 1.0);
  }
  output.position = clip;
  return output;
}
`;

const FRAG_WGSL = /* wgsl */`
varying vColor: vec3f;
varying vAlpha: f32;
varying vLocal: vec2f;
@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
  var output: FragmentOutput;
  let r2 = dot(input.vLocal, input.vLocal);
  if (r2 > 9.0) { discard; }
  let e0 = 0.011109;
  let g = exp(-0.5 * r2);
  let alpha = max(g - e0, 0.0) / (1.0 - e0) * input.vAlpha;
  if (alpha < 0.00392) { discard; }
  output.color = vec4f(input.vColor, alpha);
  return output;
}
`;

const DIAG_SIMPLE_WGSL_VS = /* wgsl */`
attribute vertex_position: vec3f;
uniform matrix_model: mat4x4f;
uniform matrix_view: mat4x4f;
uniform matrix_projection: mat4x4f;
var splatTex: texture_2d<f32>;
var orderTex: texture_2d<f32>;
varying vColor: vec3f;
@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let ordinal: i32 = i32(input.instanceIndex);
  let sid: i32 = i32(textureLoad(orderTex, vec2i(ordinal % ${TEX_W}, ordinal / ${TEX_W}), 0).r + 0.5);
  let t = sid * ${SLOTS};
  let s0 = textureLoad(splatTex, vec2i(t % ${TEX_W}, t / ${TEX_W}), 0);
  var clip = uniform.matrix_projection * uniform.matrix_view * uniform.matrix_model * vec4f(s0.xyz, 1.0);
  clip = vec4f(clip.xy + input.vertex_position.xy * 0.004 * clip.w, clip.z, clip.w);
  output.position = clip;
  output.vColor = vec3f(1.0, 0.2, 0.85);
  return output;
}
`;
const DIAG_SIMPLE_WGSL_FS = /* wgsl */`
varying vColor: vec3f;
@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
  var output: FragmentOutput;
  output.color = vec4f(input.vColor, 0.85);
  return output;
}
`;

/* 调试钩子：?diagSimple=1 时跳过 LBS/EWA，直接用 splat 静止中心画洋红点。
   用于把「绘制链路问题」与「shader 数值问题」分开，正常交付不会启用。 */
const DIAG_SIMPLE_VS = /* glsl */`
attribute vec3 vertex_position;
uniform mat4 matrix_model;
uniform mat4 matrix_view;
uniform mat4 matrix_projection;
uniform sampler2D splatTex;
uniform sampler2D orderTex;
varying vec3 vColor;
void main(void) {
  int ordinal = gl_InstanceID;
  int sid = int(texelFetch(orderTex, ivec2(ordinal % ${TEX_W}, ordinal / ${TEX_W}), 0).r + 0.5);
  int t = sid * ${SLOTS};
  vec4 s0 = texelFetch(splatTex, ivec2(t % ${TEX_W}, t / ${TEX_W}), 0);
  vec4 clip = matrix_projection * matrix_view * matrix_model * vec4(s0.xyz, 1.0);
  clip.xy += vertex_position.xy * 0.004 * clip.w;
  gl_Position = clip;
  vColor = vec3(1.0, 0.2, 0.85);
}
`;
const DIAG_SIMPLE_FS = /* glsl */`
precision highp float;
varying vec3 vColor;
void main(void) { gl_FragColor = vec4(vColor, 0.85); }
`;

function diagSimpleEnabled() {
  try { return new URLSearchParams(location.search).has('diagSimple'); } catch (_) { return false; }
}

/* ------------------------------------------------------------------ 工具 */

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 把 three Texture 解码成 (u,v)->[r,g,b] 采样器；与 v1 完全一致。 */
async function makeColorSampler(texture) {
  try {
    const img = texture && texture.image;
    if (!img) return null;
    if (typeof img.decode === 'function' && !img.width) await img.decode();
    const w = img.width || img.videoWidth || 0;
    const h = img.height || img.videoHeight || 0;
    if (!w || !h) return null;
    const canvas = (typeof OffscreenCanvas !== 'undefined')
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const flip = !!texture.flipY;
    const wrapS = texture.wrapS === THREE.ClampToEdgeWrapping;
    const wrapT = texture.wrapT === THREE.ClampToEdgeWrapping;
    const texel = (x, y) => {
      const i = ((y * w) + x) * 4;
      return [data[i] / 255, data[i + 1] / 255, data[i + 2] / 255];
    };
    return (u, v) => {
      let uu = wrapS ? Math.min(Math.max(u, 0), 1) : u - Math.floor(u);
      let vv = wrapT ? Math.min(Math.max(v, 0), 1) : v - Math.floor(v);
      if (flip) vv = 1 - vv;
      const fx = uu * w - 0.5, fy = vv * h - 0.5;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      const wrapX = (x) => (x < 0 ? (wrapS ? 0 : w - 1) : (x >= w ? (wrapS ? w - 1 : 0) : x));
      const wrapY = (y) => (y < 0 ? (wrapT ? 0 : h - 1) : (y >= h ? (wrapT ? h - 1 : 0) : y));
      const c00 = texel(wrapX(x0), wrapY(y0)), c10 = texel(wrapX(x0 + 1), wrapY(y0));
      const c01 = texel(wrapX(x0), wrapY(y0 + 1)), c11 = texel(wrapX(x0 + 1), wrapY(y0 + 1));
      const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty);
      const w01 = (1 - tx) * ty, w11 = tx * ty;
      return [
        c00[0] * w00 + c10[0] * w10 + c01[0] * w01 + c11[0] * w11,
        c00[1] * w00 + c10[1] * w10 + c01[1] * w01 + c11[1] * w11,
        c00[2] * w00 + c10[2] * w10 + c01[2] * w01 + c11[2] * w11
      ];
    };
  } catch (e) {
    console.warn('[PcSplatAvatar] 贴图采样不可用，退化为材质颜色：', e && e.message);
    return null;
  }
}

function pcTexture(P, device, name, w, h) {
  const tex = new P.Texture(device, {
    name, width: w, height: h, format: RGBA32F,
    mipmaps: false,
    minFilter: P.FILTER_NEAREST, magFilter: P.FILTER_NEAREST,
    addressU: P.ADDRESS_CLAMP_TO_EDGE, addressV: P.ADDRESS_CLAMP_TO_EDGE
  });
  return tex;
}

/* ------------------------------------------------------------------ 主体 */

export class PcSplatAvatar {
  constructor(P, app) {
    this.P = P;
    this.app = app;
    this.device = app.graphicsDevice;
    this.object = new P.GraphNode('PcSplatAvatar');   /* 供 layer 挂载；不承载世界变换 */
    this.object.getWorldTransform();
    this.stats = {
      count: 0, buildMs: 0, splats: 0, bones: 0,
      sortMs: 0, boneMs: 0, frameMs: 0, error: null,
      renderer: 'playcanvas', engine: 'single'
    };
    this._n = 0;
    this._opacity = 0.85;
    this._opacityScale = 1;
    this._disposed = false;
    this._viewport = [1, 1];
    this._visible = true;
  }

  static async create(o = {}) {
    const t0 = performance.now();
    const P = o.P || globalThis.__pc;
    const app = o.app || (o.viewer && o.viewer.app);
    if (!P || !P.Mesh || !P.ShaderMaterial || !P.Texture) {
      throw new Error('PcSplatAvatar: 缺少 globalThis.__pc（需要真实 PlayCanvas 运行时）');
    }
    if (!app || !app.graphicsDevice || !app.scene?.defaultDrawLayer) {
      throw new Error('PcSplatAvatar: 缺少 PlayCanvas app / defaultDrawLayer');
    }
    const av = new PcSplatAvatar(P, app);
    try {
      await av._build(o);
    } catch (e) {
      av.stats.error = (e && e.message) || String(e);
      console.error('[PcSplatAvatar] 初始化失败：', e);
      av.dispose();
      throw e;
    }
    av.stats.buildMs = +(performance.now() - t0).toFixed(1);
    return av;
  }

  /* ---------------------------------------------------------- 构建 */
  async _build(o) {
    const mesh = o.mesh;
    if (!mesh || !mesh.isSkinnedMesh) throw new Error('PcSplatAvatar: 需要 THREE.SkinnedMesh');
    if (!mesh.skeleton || !mesh.skeleton.bones.length) throw new Error('PcSplatAvatar: 骨架为空');

    const P = this.P, d = this.device;
    const count = Math.max(1, Math.floor(o.count != null ? o.count : 120000));
    let size = o.size != null ? +o.size : null;
    const opacity = o.opacity != null ? o.opacity : 0.85;

    this.mesh = mesh;
    this.skeleton = mesh.skeleton;
    this._opacity = opacity;
    this.stats.count = count;
    this.stats.bones = this.skeleton.bones.length;

    mesh.updateWorldMatrix(true, false);
    const geo = mesh.geometry;
    const posAttr = geo.attributes.position;
    const norAttr = geo.attributes.normal;
    const uvAttr = geo.attributes.uv;
    const sjAttr = geo.attributes.skinIndex;
    const swAttr = geo.attributes.skinWeight;
    if (!posAttr) throw new Error('PcSplatAvatar: geometry 缺少 position');
    if (!norAttr) geo.computeVertexNormals();
    if (!sjAttr || !swAttr) throw new Error('PcSplatAvatar: geometry 缺少 skinIndex/skinWeight');

    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const sampler = mat && mat.map ? await makeColorSampler(mat.map) : null;
    const baseColor = (mat && mat.color) ? mat.color : new THREE.Color(1, 1, 1);
    const vcolAttr = geo.attributes.color || null;
    const vcolItem = vcolAttr ? vcolAttr.itemSize : 0;

    /* --- 三角面面积累积表 --- */
    const index = geo.index;
    const triCount = Math.floor((index ? index.count : posAttr.count) / 3);
    const cum = new Float64Array(triCount);
    let totalArea = 0;
    for (let t = 0; t < triCount; t++) {
      const ia = index ? index.getX(t * 3) : t * 3;
      const ib = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const ic = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      const ax = posAttr.getX(ia), ay = posAttr.getY(ia), az = posAttr.getZ(ia);
      const bx = posAttr.getX(ib), by = posAttr.getY(ib), bz = posAttr.getZ(ib);
      const cx = posAttr.getX(ic), cy = posAttr.getY(ic), cz = posAttr.getZ(ic);
      const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
      const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      totalArea += 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
      cum[t] = totalArea;
    }
    if (!(totalArea > 0)) throw new Error('PcSplatAvatar: 网格面积为 0，无法采样');

    const spacing = Math.sqrt(totalArea / count);
    if (size == null) size = Math.min(0.02, Math.max(0.0015, spacing * 1.2));
    this.stats.spacing = +spacing.toFixed(4);
    this.stats.size = +size.toFixed(4);
    this._size = size;

    /* --- 采样：每个 splat 写 8 个 RGBA texel --- */
    const n = count;
    const splatH = Math.ceil(n * SLOTS / TEX_W);
    this._splatH = splatH;
    const splatArr = new Float32Array(TEX_W * splatH * 4);

    const boneIdx = new Uint16Array(n * 4);     /* CPU 排序用 */
    const boneW = new Float32Array(n * 4);
    const splatCtr = new Float32Array(n * 3);
    const scJit = new Float32Array(n);

    const rnd = mulberry32(0x51a7 ^ 20261113);
    const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _qRoll = new THREE.Quaternion();
    const _xAxis = new THREE.Vector3(), _yAxis = new THREE.Vector3(), _n = new THREE.Vector3();
    const _up = new THREE.Vector3();
    const AXIS_Z = new THREE.Vector3(0, 0, 1), AXIS_X = new THREE.Vector3(1, 0, 0);
    const jIdx = [0, 0, 0, 0], jW = [0, 0, 0, 0];
    let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;

    for (let s = 0; s < n; s++) {
      const r = rnd() * totalArea;
      let lo = 0, hi = triCount - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < r) lo = mid + 1; else hi = mid; }
      const t = lo;
      const ia = index ? index.getX(t * 3) : t * 3;
      const ib = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const ic = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      let b1 = rnd(), b2 = rnd();
      if (b1 + b2 > 1) { b1 = 1 - b1; b2 = 1 - b2; }
      const w0 = 1 - b1 - b2, w1 = b1, w2 = b2;

      const px = posAttr.getX(ia) * w0 + posAttr.getX(ib) * w1 + posAttr.getX(ic) * w2;
      const py = posAttr.getY(ia) * w0 + posAttr.getY(ib) * w1 + posAttr.getY(ic) * w2;
      const pz = posAttr.getZ(ia) * w0 + posAttr.getZ(ib) * w1 + posAttr.getZ(ic) * w2;
      let nx = norAttr.getX(ia) * w0 + norAttr.getX(ib) * w1 + norAttr.getX(ic) * w2;
      let ny = norAttr.getY(ia) * w0 + norAttr.getY(ib) * w1 + norAttr.getY(ic) * w2;
      let nz = norAttr.getZ(ia) * w0 + norAttr.getZ(ib) * w1 + norAttr.getZ(ic) * w2;
      const nlen = Math.hypot(nx, ny, nz);
      if (nlen > 1e-8) { nx /= nlen; ny /= nlen; nz /= nlen; } else { nx = 0; ny = 1; nz = 0; }

      let cr = baseColor.r, cg = baseColor.g, cb = baseColor.b;
      if (sampler && uvAttr) {
        const u = uvAttr.getX(ia) * w0 + uvAttr.getX(ib) * w1 + uvAttr.getX(ic) * w2;
        const v = uvAttr.getY(ia) * w0 + uvAttr.getY(ib) * w1 + uvAttr.getY(ic) * w2;
        const c = sampler(u, v);
        if (c) { cr = c[0]; cg = c[1]; cb = c[2]; }
      }
      if (vcolAttr) {
        const vr = vcolAttr.getX(ia) * w0 + vcolAttr.getX(ib) * w1 + vcolAttr.getX(ic) * w2;
        const vg = vcolItem > 1 ? vcolAttr.getY(ia) * w0 + vcolAttr.getY(ib) * w1 + vcolAttr.getY(ic) * w2 : vr;
        const vb = vcolItem > 2 ? vcolAttr.getZ(ia) * w0 + vcolAttr.getZ(ib) * w1 + vcolAttr.getZ(ic) * w2 : vr;
        cr *= vr; cg *= vg; cb *= vb;
      }

      jIdx[0] = jIdx[1] = jIdx[2] = jIdx[3] = 0;
      jW[0] = jW[1] = jW[2] = jW[3] = 0;
      const corners = [ia, ib, ic], cw = [w0, w1, w2];
      for (let ci = 0; ci < 3; ci++) {
        const vi = corners[ci], cwi = cw[ci];
        if (cwi <= 0) continue;
        for (let k = 0; k < 4; k++) {
          const ww = swAttr.getComponent(vi, k) * cwi;
          if (ww <= 0.0001) continue;
          const jj = Math.round(sjAttr.getComponent(vi, k));
          let same = -1;
          for (let q = 0; q < 4; q++) if (jIdx[q] === jj && jW[q] > 0) { same = q; break; }
          if (same >= 0) { jW[same] += ww; continue; }
          let slot = -1;
          for (let q = 0; q < 4; q++) if (jW[q] <= 0) { slot = q; break; }
          if (slot < 0) {
            let m = 0;
            for (let q = 1; q < 4; q++) if (jW[q] < jW[m]) m = q;
            if (ww <= jW[m]) continue;
            slot = m;
          }
          jIdx[slot] = jj; jW[slot] = ww;
        }
      }
      let wsum = jW[0] + jW[1] + jW[2] + jW[3];
      if (wsum <= 1e-6) { jIdx[0] = 0; jW[0] = 1; wsum = 1; }
      const wInv = 1 / wsum;

      _n.set(nx, ny, nz);
      _up.copy(Math.abs(nz) < 0.95 ? AXIS_Z : AXIS_X);
      _xAxis.crossVectors(_up, _n);
      if (_xAxis.lengthSq() < 1e-8) _xAxis.copy(AXIS_X);
      _xAxis.normalize();
      _yAxis.crossVectors(_n, _xAxis);
      _m.makeBasis(_xAxis, _yAxis, _n);
      _q.setFromRotationMatrix(_m);
      _qRoll.setFromAxisAngle(AXIS_Z, rnd() * Math.PI * 2);
      _q.multiply(_qRoll);

      const jf = 0.75 + rnd() * 0.5;
      scJit[s] = jf;
      splatCtr[s * 3] = px; splatCtr[s * 3 + 1] = py; splatCtr[s * 3 + 2] = pz;
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
      if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;

      const base = s * SLOTS * 4;
      splatArr[base + 0] = px;  splatArr[base + 1] = py;  splatArr[base + 2] = pz;
      splatArr[base + 3] = size * 0.5 * jf;
      splatArr[base + 4] = nx;  splatArr[base + 5] = ny;  splatArr[base + 6] = nz;
      splatArr[base + 7] = 1.0;
      splatArr[base + 8] = cr;  splatArr[base + 9] = cg;  splatArr[base + 10] = cb;
      splatArr[base + 11] = _q.x;
      splatArr[base + 12] = _q.y; splatArr[base + 13] = _q.z; splatArr[base + 14] = _q.w;
      splatArr[base + 15] = 0;
      for (let q = 0; q < 4; q++) {
        splatArr[base + 16 + q] = jIdx[q];
        splatArr[base + 20 + q] = jW[q] * wInv;
        boneIdx[s * 4 + q] = jIdx[q];
        boneW[s * 4 + q] = jW[q] * wInv;
      }
    }

    /* 脚底对齐 */
    const footOffset = -minY;
    if (Math.abs(footOffset) > 0.005) {
      for (let s = 0; s < n; s++) {
        splatArr[s * SLOTS * 4 + 1] += footOffset;
        splatCtr[s * 3 + 1] += footOffset;
      }
      minY = 0; maxY += footOffset;
    }
    this._footOffset = Math.abs(footOffset) > 0.005 ? footOffset : 0;

    /* 每高斯相对「加权骨骼绑定位置」的偏移（排序键用，与 v1 一致） */
    const nb0 = this.skeleton.bones.length;
    const boneRest = new Float32Array(nb0 * 3);
    {
      const im = new THREE.Matrix4();
      const bindInv0 = mesh.bindMatrixInverse;
      for (let b = 0; b < nb0; b++) {
        const inv = this.skeleton.boneInverses[b];
        if (inv) im.copy(inv).invert(); else im.identity();
        im.premultiply(bindInv0);
        const el = im.elements;
        boneRest[b * 3] = el[12]; boneRest[b * 3 + 1] = el[13]; boneRest[b * 3 + 2] = el[14];
      }
    }
    const restOff = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const k = i * 4;
      let ox = 0, oy = 0, oz = 0;
      for (let q = 0; q < 4; q++) {
        const w = boneW[k + q];
        if (w <= 0) continue;
        const b3 = boneIdx[k + q] * 3;
        ox += w * boneRest[b3]; oy += w * boneRest[b3 + 1]; oz += w * boneRest[b3 + 2];
      }
      restOff[i * 3] = splatCtr[i * 3] - ox;
      restOff[i * 3 + 1] = splatCtr[i * 3 + 1] - oy;
      restOff[i * 3 + 2] = splatCtr[i * 3 + 2] - oz;
    }
    let maxOff = 0;
    for (let i = 0; i < n; i++) {
      const l = Math.hypot(restOff[i * 3], restOff[i * 3 + 1], restOff[i * 3 + 2]);
      if (l > maxOff) maxOff = l;
    }
    this._maxOff = maxOff + 1e-3;
    this._restOff = restOff;
    this._bounds = { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
    this.stats.height = +(maxY - minY).toFixed(3);

    /* --- GPU 资源 --- */
    this._splatTex = pcTexture(P, d, 'human-splat-data', TEX_W, splatH);
    const st = this._splatTex.lock();
    st.set(splatArr.subarray(0, Math.min(st.length, splatArr.length)));
    this._splatTex.unlock();

    const nb = this.skeleton.bones.length;
    this._boneData = new Float32Array(nb * 16);
    this._boneTex = pcTexture(P, d, 'human-bone-mat', nb * 4, 1);
    this._boneTex.lock(); this._boneTex.unlock();

    const orderH = Math.ceil(n / TEX_W);
    this._orderW = TEX_W;
    this._orderH = orderH;
    this._orderTex = pcTexture(P, d, 'human-sort-order', TEX_W, orderH);
    const ot = this._orderTex.lock();
    for (let i = 0; i < n; i++) ot[i * 4] = i;   /* 初始为自然序 */
    this._orderTex.unlock();

    /* --- PlayCanvas 材质 / 网格 --- */
    const material = new P.ShaderMaterial();
    material.name = 'HumanSplatMaterial';
    material.cull = P.CULLFACE_NONE;
    material.blendType = P.BLEND_NORMAL;
    /* SOG 场景自身 depthWrite=false，深度缓冲里没有可用遮挡信息；
       depthTest=true 会被其它 pass 留下的深度误杀整批高斯片元。与探针一致置 false。 */
    material.depthTest = false;
    material.depthWrite = false;
    /* 双后端：WebGL2 走 GLSL，WebGPU 走 WGSL。
       ShaderGenerator.createShaderDefinition 的判定是
       `device.isWebGPU && !!desc.vertexWGSL && !!desc.fragmentWGSL`；
       两者都给，引擎按当前 device 自动选，无需业务层分支。
       WebGPU 下 GLSL 会因宿主未加载 glslang/twgsl 而编译失败（见 WGSL 注释）。 */
    const simple = diagSimpleEnabled();
    const isWebGPU = !!(d.isWebGPU || d.deviceType === 'webgpu');
    material.shaderDesc = {
      uniqueName: simple ? 'HumanSplatDiagSimple' : 'HumanSplatEWA',
      vertexGLSL: simple ? DIAG_SIMPLE_VS : VERT_GLSL,
      fragmentGLSL: simple ? DIAG_SIMPLE_FS : FRAG_GLSL,
      vertexWGSL: simple ? DIAG_SIMPLE_WGSL_VS : VERT_WGSL,
      fragmentWGSL: simple ? DIAG_SIMPLE_WGSL_FS : FRAG_WGSL,
      attributes: { vertex_position: P.SEMANTIC_POSITION }
    };
    this.stats.shaderLanguage = isWebGPU ? 'wgsl' : 'glsl';
    material.update();
    material.setParameter('splatTex', this._splatTex);
    material.setParameter('boneTex', this._boneTex);
    material.setParameter('orderTex', this._orderTex);
    material.setParameter('uOpacity', opacity);
    this.material = material;

    const quad = new P.Mesh(d);
    quad.setPositions([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
    quad.setIndices([0, 1, 2, 0, 2, 3]);
    quad.update(P.PRIMITIVE_TRIANGLES);
    this.meshPc = quad;

    const inst = new P.MeshInstance(quad, material, this.object);
    inst.setInstancing(true, true);
    inst.instancingCount = n;
    inst.cull = false;
    inst.castShadow = false;
    inst.pick = false;
    inst.visible = true;
    this.meshInstance = inst;
    this.app.scene.defaultDrawLayer.addMeshInstances([inst], true);

    /* --- 排序常驻缓冲 --- */
    this._n = n;
    this._boneIdx = boneIdx;
    this._boneW = boneW;
    this._boneDepth = new Float32Array(nb);
    this._bonePos = new Float32Array(nb * 3);
    this._keys = new Float32Array(n);
    this._bucket = new Uint16Array(n);
    this._order = new Uint32Array(n);
    this._counts = new Int32Array(BUCKETS);
    this._offs = new Int32Array(BUCKETS);
    this._scJit = scJit;
    this._t1 = new THREE.Matrix4();
    this._t2 = new THREE.Matrix4();
    this._t3 = new THREE.Matrix4();

    this.stats.splats = n;
    this.stats.texMB = +((TEX_W * splatH * 16 + nb * 4 * 16 + TEX_W * orderH * 16) / 1048576).toFixed(2);

    this._origVisible = mesh.visible;
    mesh.visible = false;                 /* 原网格不参与渲染（本来也没有 three renderer） */
    this.updateBones();
  }

  /* ---------------------------------------------------------- 每帧 */

  /** three 骨骼世界矩阵 → boneTex。调用前应已 skeleton.update / root.updateWorldMatrix。 */
  updateBones() {
    const t0 = performance.now();
    const sk = this.skeleton, bones = sk.bones, invs = sk.boneInverses, nb = bones.length;
    const root = this._rootObject() || this.mesh;
    root.updateWorldMatrix(true, true);

    const bind = this.mesh.bindMatrix, bindInv = this.mesh.bindMatrixInverse;
    const out = this._boneData;
    const t1 = this._t1, t2 = this._t2, t3 = this._t3;
    for (let i = 0; i < nb; i++) {
      const b = bones[i], inv = invs[i];
      if (inv) t1.multiplyMatrices(b.matrixWorld, inv); else t1.copy(b.matrixWorld);
      t2.multiplyMatrices(bindInv, t1);
      t3.multiplyMatrices(t2, bind);
      t3.toArray(out, i * 16);
      const e = b.matrixWorld.elements;
      this._bonePos[i * 3] = e[12];
      this._bonePos[i * 3 + 1] = e[13];
      this._bonePos[i * 3 + 2] = e[14];
    }
    const bt = this._boneTex.lock();
    bt.set(out);
    this._boneTex.unlock();
    this.stats.boneMs = +(performance.now() - t0).toFixed(2);
  }

  /**
   * 桶排序（由远到近），写 orderTex。禁止全量 Array.sort。
   * cameraComp：PlayCanvas CameraComponent；用其 viewMatrix 代替 v1 的 three matrixWorldInverse。
   */
  updateSort(cameraComp) {
    const t0 = performance.now();
    const n = this._n;
    if (!n || !cameraComp) { this.stats.sortMs = 0; return; }
    const vm = cameraComp.viewMatrix || (cameraComp.camera && cameraComp.camera.viewMatrix);
    if (!vm) return;
    const e = vm.data || vm;
    const bd = this._boneDepth, bp = this._bonePos, nb = bd.length;
    for (let b = 0; b < nb; b++) {
      const o = b * 3;
      bd[b] = -(e[2] * bp[o] + e[6] * bp[o + 1] + e[10] * bp[o + 2] + e[14]);
    }
    const rzx = -e[2], rzy = -e[6], rzz = -e[10];
    const me = this.mesh.matrixWorld.elements;
    const rlx = me[0] * rzx + me[1] * rzy + me[2] * rzz;
    const rly = me[4] * rzx + me[5] * rzy + me[6] * rzz;
    const rlz = me[8] * rzx + me[9] * rzy + me[10] * rzz;

    let mn = Infinity, mx = -Infinity;
    for (let b = 0; b < nb; b++) { const dd = bd[b]; if (dd < mn) mn = dd; if (dd > mx) mx = dd; }
    const L = this._maxOff;
    mn -= L; mx += L;

    const bi = this._boneIdx, bw = this._boneW, off = this._restOff;
    const counts = this._counts, offs = this._offs, bucket = this._bucket;
    counts.fill(0);
    const span = Math.max(mx - mn, 1e-4);
    const inv = (BUCKETS - 1) / span;
    for (let i = 0; i < n; i++) {
      const k = i * 4, o3 = i * 3;
      const dd = bw[k] * bd[bi[k]] + bw[k + 1] * bd[bi[k + 1]]
               + bw[k + 2] * bd[bi[k + 2]] + bw[k + 3] * bd[bi[k + 3]]
               + rlx * off[o3] + rly * off[o3 + 1] + rlz * off[o3 + 2];
      let b = ((dd - mn) * inv) | 0;
      if (b < 0) b = 0; else if (b > BUCKETS - 1) b = BUCKETS - 1;
      b = (BUCKETS - 1) - b;
      bucket[i] = b; counts[b]++;
    }
    let sum = 0;
    for (let b = 0; b < BUCKETS; b++) { offs[b] = sum; sum += counts[b]; }
    const order = this._order;
    for (let i = 0; i < n; i++) order[offs[bucket[i]]++] = i;

    const ot = this._orderTex.lock();
    for (let k = 0; k < n; k++) ot[k * 4] = order[k];
    this._orderTex.unlock();
    this.stats.sortMs = +(performance.now() - t0).toFixed(2);
  }

  /** 每帧由 human-layer 调用：同步 node 变换 + 视口。矩阵由引擎自动注入。 */
  updateFrame(cameraComp) {
    const t0 = performance.now();
    const m = this.material;
    if (!m) return;
    /* three 的骨架根持有全部世界变换（放置、朝向、身高缩放）。把它同步到
       PlayCanvas GraphNode，引擎就会把正确的 matrix_model 注入 shader。
       自定义 mat4 uniform 在本引擎里不可靠（实测 getParameter 有值但 shader 收不到），
       所以矩阵一律走内置名。 */
    this.mesh.updateWorldMatrix(true, false);
    if (!this._dp) {
      this._dp = { p: new THREE.Vector3(), q: new THREE.Quaternion(), s: new THREE.Vector3() };
    }
    const { p, q, s } = this._dp;
    this.mesh.matrixWorld.decompose(p, q, s);
    this.object.setLocalPosition(p.x, p.y, p.z);
    this.object.setLocalRotation(q.x, q.y, q.z, q.w);
    this.object.setLocalScale(s.x, s.y, s.z);
    this.object.getWorldTransform();
    const w = this.device.width || 1, h = this.device.height || 1;
    if (w > 1 && h > 1) {
      this._viewport[0] = w; this._viewport[1] = h;
    }
    this.stats.frameMs = +(performance.now() - t0).toFixed(2);
    this.stats.frameCalls = (this.stats.frameCalls || 0) + 1;
  }

  _rootObject() {
    let o = this.mesh;
    let guard = 0;
    while (o.parent && guard++ < 64) o = o.parent;
    return o;
  }

  /* ---------------------------------------------------------- 控制 */

  setVisible(v) {
    this._visible = !!v;
    if (this.meshInstance) this.meshInstance.visible = !!v;
  }
  setOpacityScale(s) {
    this._opacityScale = Math.min(1, Math.max(0, +s || 0));
    if (this.material) this.material.setParameter('uOpacity', this._opacity * this._opacityScale);
  }
  /** 运行期改高斯半径：只重写 splatTex 的 scale 通道，不重采样。 */
  setSplatSize(size) {
    const s = Math.max(1e-4, +size || 0);
    const st = this._splatTex && this._splatTex.lock();
    if (!st) return;
    const n = this._n, jit = this._scJit;
    for (let k = 0; k < n; k++) st[(k * SLOTS + 0) * 4 + 3] = s * 0.5 * (jit ? jit[k] : 1);
    this._splatTex.unlock();
    this._size = s;
    this.stats.size = +s.toFixed(4);
  }
  setViewport(w, h) {
    this._viewport[0] = Math.max(1, w | 0);
    this._viewport[1] = Math.max(1, h | 0);
  }
  fallback(err) {
    if (err) this.stats.error = (err && err.message) || String(err);
    this.setVisible(false);
    if (this.mesh) this.mesh.visible = this._origVisible !== false;
    console.warn('[PcSplatAvatar] 回退：', this.stats.error);
  }
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    try {
      if (this.meshInstance) {
        this.app.scene.defaultDrawLayer.removeMeshInstances([this.meshInstance], true);
      }
      if (this.meshPc) this.meshPc.destroy();
      if (this.material) this.material.destroy();
      for (const t of [this._splatTex, this._boneTex, this._orderTex]) if (t) t.destroy();
      if (this.mesh && this._origVisible !== false) this.mesh.visible = true;
    } catch (e) { console.warn('[PcSplatAvatar] dispose:', e && e.message); }
  }
}

export default PcSplatAvatar;

/**
 * splat-avatar.js — 骨骼驱动的高斯化身（3DGS 风格）渲染模块
 *
 * 契约见 docs/CONTRACT.md §2：
 *   SplatAvatar.create({mesh,count,size,opacity}) -> object / updateBones() / updateSort(camera)
 *   / stats / setVisible() / setOpacityScale() / dispose()
 *
 * 实现要点：
 *   1. 面积加权三角面采样 + 重心坐标插值 POSITION/NORMAL/UV/JOINTS_0/WEIGHTS_0，权重取 top-4 归一化。
 *   2. 颜色从 material.map 像素按 UV 双线性取（兼容 three 的 flipY / wrap），失败退化为材质颜色×顶点色。
 *   3. LBS：p' = Σ wᵢ·(Wᵢ·Bᵢ⁻¹)·p，骨骼矩阵每帧写入 RGBA32F DataTexture（每骨骼 4 texel）。
 *      采样点保存在 mesh 局部空间；本模块额外左乘 bindMatrix⁻¹ / 右乘 bindMatrix，
 *      使得 object.matrixWorld = mesh.matrixWorld 时与 three 内置蒙皮完全一致。
 *   4. EWA：Σ = (R·S)(R·S)ᵀ → 视图空间 → 投影雅可比 → 屏幕 2×2 协方差 → 特征分解得椭圆两轴。
 *      size 语义：可见半径（≈2σ），内部 σ = size/2，四边形半径 3σ = 1.5·size。
 *   5. 排序：8192 桶 counting sort，键 = Σwᵢ·depth(boneᵢ) + 采样点相对骨骼的精确视深偏移，
 *      每帧重写 index（由远到近），禁止全量 Array.sort。120k 高斯实测 2.1~4.5 ms（本机 VM）。
 *
 * 关于「每实例属性 / InstancedBufferGeometry」：
 *   高斯数据以逐顶点属性 + 每高斯 4 顶点（两个三角形，6 索引）承载，单 draw call。
 *   InstancedBufferGeometry 的实例顺序无法用 index 改变，只能靠重写全部实例属性做排序；
 *   实测 120k×25 float 的重排 + 上传约 15 ms/帧，直接违反「排序 ≤3 ms」预算；
 *   改用 index 重排后为 2~4 ms 级，故采用本方案（CONTRACT §2-1 的验收项是排序本身）。
 */

import * as THREE from 'three';

const BUCKETS = 8192;

const VERT = /* glsl */`
uniform sampler2D uBoneTex;
uniform vec2 uBoneTexSize;
uniform vec2 uViewport;
uniform float uOpacity;

attribute vec2 aCorner;
attribute vec3 aCenter;
attribute vec3 aNormal;
attribute float aScale;
attribute vec4 aQuat;
attribute vec3 aColor;
attribute float aAlpha;
attribute vec4 aBoneIdx;
attribute vec4 aBoneW;

varying vec3 vColor;
varying float vAlpha;
varying vec2 vLocal;

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

vec4 boneRow(float bi, float row) {
  float x = (bi * 4.0 + row + 0.5) / uBoneTexSize.x;
  return texture2D(uBoneTex, vec2(x, 0.5));
}

void accumBone(inout vec4 c0, inout vec4 c1, inout vec4 c2, inout vec4 c3, float bi, float w) {
  if (w > 0.0001) {
    c0 += w * boneRow(bi, 0.0);
    c1 += w * boneRow(bi, 1.0);
    c2 += w * boneRow(bi, 2.0);
    c3 += w * boneRow(bi, 3.0);
  }
}

/* 视图/屏幕空间投影雅可比（像素单位）：d(screen)/d(view) · b */
vec2 projJac(vec3 b, vec3 vp, float fx, float fy, float iz) {
  float k = iz * iz;
  return vec2(
    fx * (b.x * iz - vp.x * b.z * k),
    fy * (b.y * iz - vp.y * b.z * k)
  );
}

void main() {
  /* ---- 1. 线性混合蒙皮（LBS） ---- */
  vec4 c0 = vec4(0.0), c1 = vec4(0.0), c2 = vec4(0.0), c3 = vec4(0.0);
  accumBone(c0, c1, c2, c3, aBoneIdx.x, aBoneW.x);
  accumBone(c0, c1, c2, c3, aBoneIdx.y, aBoneW.y);
  accumBone(c0, c1, c2, c3, aBoneIdx.z, aBoneW.z);
  accumBone(c0, c1, c2, c3, aBoneIdx.w, aBoneW.w);

  mat4 M = mat4(c0, c1, c2, c3);
  mat3 A = mat3(c0.xyz, c1.xyz, c2.xyz);

  vec4 pLocal = M * vec4(aCenter, 1.0);

  /* 法向用同一混合矩阵的 3x3 部分（CONTRACT §2-3） */
  vec3 nrm = A * aNormal;
  float nl = length(nrm);
  vec3 n = nl > 1e-6 ? nrm / nl : normalize(aNormal);

  vec4 world = modelMatrix * pLocal;
  vec4 vp = viewMatrix * world;
  vec4 clip = projectionMatrix * vp;

  vColor = aColor;
  vAlpha = aAlpha * uOpacity;
  vLocal = aCorner * 3.0;
  gl_Position = clip;

  if (clip.w < 0.05) {           /* 相机背后：剔除，避免四边形翻转成大三角形 */
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    vAlpha = 0.0;
    return;
  }

  /* ---- 2. 椭圆朝向：局部 +Z 对齐（蒙皮后的）法向，保留高斯自身 roll ---- */
  mat3 R = quatToMat3(aQuat);
  vec3 t = A * R[0];
  vec3 zAxis = n;
  vec3 xAxis = t - zAxis * dot(zAxis, t);
  float xl = length(xAxis);
  if (xl < 1e-5) {               /* 退化：用任意正交基 */
    vec3 helper = abs(zAxis.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    xAxis = normalize(cross(helper, zAxis));
  } else {
    xAxis /= xl;
  }
  vec3 yAxis = cross(zAxis, xAxis);
  mat3 frame = mat3(xAxis, yAxis, zAxis);

  /* 各向异性比 1 : 1 : 0.35（≤3，CONTRACT §2-2）：薄片贴在表面 */
  float s = aScale;
  mat3 S = mat3(vec3(s, 0.0, 0.0), vec3(0.0, s, 0.0), vec3(0.0, 0.0, s * 0.35));

  mat3 MV3 = mat3(viewMatrix * modelMatrix);
  mat3 Q = MV3 * frame * S;

  /* ---- 3. 屏幕空间 2x2 协方差：Σ = Σᵢ cᵢ·cᵢᵀ，cᵢ = J·Qᵢ（3 列逐列投影，恒半正定） ---- */
  float z = max(-vp.z, 0.05);
  float iz = 1.0 / z;
  float fx = projectionMatrix[0][0] * 0.5 * uViewport.x;
  float fy = projectionMatrix[1][1] * 0.5 * uViewport.y;

  vec2 e0 = projJac(Q[0], vp.xyz, fx, fy, iz);
  vec2 e1 = projJac(Q[1], vp.xyz, fx, fy, iz);
  vec2 e2 = projJac(Q[2], vp.xyz, fx, fy, iz);

  float a11 = e0.x * e0.x + e1.x * e1.x + e2.x * e2.x;
  float a12 = e0.x * e0.y + e1.x * e1.y + e2.x * e2.y;
  float a22 = e0.y * e0.y + e1.y * e1.y + e2.y * e2.y;

  /* 低通：至少 0.3 px，避免亚像素高斯消失 */
  a11 += 0.3;
  a22 += 0.3;

  /* ---- 4. 2x2 特征分解 → 椭圆两轴（3σ 覆盖） ---- */
  float mid = 0.5 * (a11 + a22);
  float diff = 0.5 * (a11 - a22);
  float disc = sqrt(max(diff * diff + a12 * a12, 0.0));
  float l1 = max(mid + disc, 1e-4);
  float l2 = max(mid - disc, 0.09);
  vec2 v1 = abs(a12) > 1e-8 ? normalize(vec2(a12, l1 - a11))
                            : (a11 >= a22 ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
  vec2 v2 = vec2(-v1.y, v1.x);

  vec2 axis1 = v1 * (sqrt(l1) * 3.0);
  vec2 axis2 = v2 * (sqrt(l2) * 3.0);
  vec2 delta = aCorner.x * axis1 + aCorner.y * axis2;

  gl_Position.xy += delta * (2.0 / uViewport) * clip.w;
}
`;

const FRAG = /* glsl */`
precision highp float;

varying vec3 vColor;
varying float vAlpha;
varying vec2 vLocal;

void main() {
  float r2 = dot(vLocal, vLocal);
  if (r2 > 9.0) discard;
  float e0 = 0.011109;                       /* exp(-0.5*3²)，边缘归零避免方形接缝 */
  float g = exp(-0.5 * r2);
  float alpha = max(g - e0, 0.0) / (1.0 - e0) * vAlpha;
  if (alpha < 0.00392) discard;              /* < 1/255 */
  gl_FragColor = vec4(vColor, alpha);
}
`;

/* ------------------------------------------------------------------ 工具 */

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 把 Texture 解码成 (u,v)->[r,g,b] 的采样器；失败返回 null。 */
async function makeColorSampler(texture) {
  try {
    let img = texture && texture.image;
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

    /* 双线性采样（减少 UV 噪声造成的色斑） */
    const texel = (x, y) => {
      const i = ((y * w) + x) * 4;
      return [data[i] / 255, data[i + 1] / 255, data[i + 2] / 255];
    };

    return (u, v) => {
      let uu = wrapS ? Math.min(Math.max(u, 0), 1) : u - Math.floor(u);
      let vv = wrapT ? Math.min(Math.max(v, 0), 1) : v - Math.floor(v);
      if (flip) vv = 1 - vv;
      const fx = uu * w - 0.5;
      const fy = vv * h - 0.5;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      const wrapX = (x) => (x < 0 ? (wrapS ? 0 : w - 1) : (x >= w ? (wrapS ? w - 1 : 0) : x));
      const wrapY = (y) => (y < 0 ? (wrapT ? 0 : h - 1) : (y >= h ? (wrapT ? h - 1 : 0) : y));
      const c00 = texel(wrapX(x0), wrapY(y0));
      const c10 = texel(wrapX(x0 + 1), wrapY(y0));
      const c01 = texel(wrapX(x0), wrapY(y0 + 1));
      const c11 = texel(wrapX(x0 + 1), wrapY(y0 + 1));
      const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty);
      const w01 = (1 - tx) * ty, w11 = tx * ty;
      return [
        c00[0] * w00 + c10[0] * w10 + c01[0] * w01 + c11[0] * w11,
        c00[1] * w00 + c10[1] * w10 + c01[1] * w01 + c11[1] * w11,
        c00[2] * w00 + c10[2] * w10 + c01[2] * w01 + c11[2] * w11,
      ];
    };
  } catch (e) {
    console.warn('[SplatAvatar] 贴图采样不可用，退化为材质颜色：', e && e.message);
    return null;
  }
}

/* ------------------------------------------------------------------ 主体 */

export class SplatAvatar {
  constructor() {
    this.object = new THREE.Group();
    this.object.name = 'SplatAvatar';
    this.stats = {
      count: 0, buildMs: 0, splats: 0,
      bones: 0, sortMs: 0, boneMs: 0, error: null,
    };
    this._n = 0;
    this._opacity = 0.85;
    this._opacityScale = 1;
    this._disposed = false;
    this._viewport = new THREE.Vector2(1, 1);
    this._renderer = null;
  }

  static async create(o = {}) {
    const t0 = performance.now();
    const av = new SplatAvatar();
    try {
      await av._build(o);
    } catch (e) {
      av.stats.error = (e && e.message) || String(e);
      console.error('[SplatAvatar] 初始化失败：', e);
      throw e;
    }
    av.stats.buildMs = +(performance.now() - t0).toFixed(1);
    return av;
  }

  /* ---------------------------------------------------------- 构建 */

  async _build(o) {
    const mesh = o.mesh;
    if (!mesh || !mesh.isSkinnedMesh) throw new Error('SplatAvatar: 需要 THREE.SkinnedMesh');
    if (!mesh.skeleton || !mesh.skeleton.bones.length) throw new Error('SplatAvatar: 骨架为空');

    const count = Math.max(1, Math.floor(o.count != null ? o.count : 120000));
    /* size = 可见半径。null（默认）时按「采样间距」自适应，见下面 totalArea 之后 */
    let size = o.size != null ? +o.size : null;
    const opacity = o.opacity != null ? o.opacity : 0.85;

    this.mesh = mesh;
    this.skeleton = mesh.skeleton;
    this._renderer = o.renderer || null;
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
    if (!posAttr) throw new Error('SplatAvatar: geometry 缺少 position');
    if (!norAttr) geo.computeVertexNormals();
    if (!sjAttr || !swAttr) throw new Error('SplatAvatar: geometry 缺少 skinIndex/skinWeight');

    /* --- 材质颜色采样 --- */
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const sampler = mat && mat.map ? await makeColorSampler(mat.map) : null;
    const baseColor = (mat && mat.color) ? mat.color : new THREE.Color(1, 1, 1);
    const vcolAttr = geo.attributes.color || null;
    const vcolItem = vcolAttr ? vcolAttr.itemSize : 0;

    /* --- 三角面面积累积表（索引化几何展开） --- */
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
    if (!(totalArea > 0)) throw new Error('SplatAvatar: 网格面积为 0，无法采样');

    /* 采样间距：面积上均匀铺 count 个点，相邻点平均距离 ≈ sqrt(A/count)。
       高斯半径默认取 1.2×间距 —— 取太大会糊成彩团（每点盖住 3–4 个邻居、alpha 叠加饱和），
       太小则漏光出现麻点。这是 R4 观感缺陷（「像彩色毛球」）的根因修正。 */
    const spacing = Math.sqrt(totalArea / count);
    if (size == null) size = Math.min(0.02, Math.max(0.0015, spacing * 1.2));
    this.stats.spacing = +spacing.toFixed(4);
    this.stats.size = +size.toFixed(4);
    this._size = size;

    /* --- 采样 --- */
    const n = count;
    const v4 = n * 4;
    const aCorner = new Float32Array(v4 * 2);
    const aCenter = new Float32Array(v4 * 3);
    const aNormal = new Float32Array(v4 * 3);
    const aScale = new Float32Array(v4);
    const aQuat = new Float32Array(v4 * 4);
    const aColor = new Float32Array(v4 * 3);
    const aAlpha = new Float32Array(v4);
    const aBoneIdx = new Float32Array(v4 * 4);
    const aBoneW = new Float32Array(v4 * 4);
    const scJit = new Float32Array(n);          /* 每高斯半径抖动，供 setSplatSize 复用 */

    const boneIdx = new Uint16Array(n * 4);    /* 仅供 CPU 排序 */
    const boneW = new Float32Array(n * 4);
    const splatCtr = new Float32Array(n * 3);  /* 每高斯中心（排序用） */

    const rnd = mulberry32(0x51a7 ^ 20261113);
    const CORNERS = [-1, -1, 1, -1, -1, 1, 1, 1];

    const _m = new THREE.Matrix4();
    const _q = new THREE.Quaternion();
    const _qRoll = new THREE.Quaternion();
    const _xAxis = new THREE.Vector3();
    const _yAxis = new THREE.Vector3();
    const _n = new THREE.Vector3();
    const _up = new THREE.Vector3();
    const AXIS_Z = new THREE.Vector3(0, 0, 1);
    const AXIS_X = new THREE.Vector3(1, 0, 0);

    /* top-4 选择用的临时表 */
    const jIdx = [0, 0, 0, 0];
    const jW = [0, 0, 0, 0];

    let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;

    for (let s = 0; s < n; s++) {
      const r = rnd() * totalArea;
      let lo = 0, hi = triCount - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] < r) lo = mid + 1; else hi = mid;
      }
      const t = lo;
      const ia = index ? index.getX(t * 3) : t * 3;
      const ib = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const ic = index ? index.getX(t * 3 + 2) : t * 3 + 2;

      let b1 = rnd(), b2 = rnd();
      if (b1 + b2 > 1) { b1 = 1 - b1; b2 = 1 - b2; }
      const w0 = 1 - b1 - b2, w1 = b1, w2 = b2;

      /* 位置 */
      const px = posAttr.getX(ia) * w0 + posAttr.getX(ib) * w1 + posAttr.getX(ic) * w2;
      const py = posAttr.getY(ia) * w0 + posAttr.getY(ib) * w1 + posAttr.getY(ic) * w2;
      const pz = posAttr.getZ(ia) * w0 + posAttr.getZ(ib) * w1 + posAttr.getZ(ic) * w2;

      /* 法向 */
      let nx = norAttr.getX(ia) * w0 + norAttr.getX(ib) * w1 + norAttr.getX(ic) * w2;
      let ny = norAttr.getY(ia) * w0 + norAttr.getY(ib) * w1 + norAttr.getY(ic) * w2;
      let nz = norAttr.getZ(ia) * w0 + norAttr.getZ(ib) * w1 + norAttr.getZ(ic) * w2;
      const nlen = Math.hypot(nx, ny, nz);
      if (nlen > 1e-8) { nx /= nlen; ny /= nlen; nz /= nlen; } else { nx = 0; ny = 1; nz = 0; }

      /* 颜色 */
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

      /* 骨骼权重：3 顶点 × 4 槽聚合成关节字典，取 top-4 归一化 */
      jIdx[0] = jIdx[1] = jIdx[2] = jIdx[3] = 0;
      jW[0] = jW[1] = jW[2] = jW[3] = 0;
      const corners = [ia, ib, ic];
      const cw = [w0, w1, w2];
      for (let ci = 0; ci < 3; ci++) {
        const vi = corners[ci];
        const cwi = cw[ci];
        if (cwi <= 0) continue;
        for (let k = 0; k < 4; k++) {
          const ww = swAttr.getComponent(vi, k) * cwi;
          if (ww <= 0.0001) continue;
          const jj = Math.round(sjAttr.getComponent(vi, k));
          /* 插入 top-4（同关节合并） */
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
          jIdx[slot] = jj;
          jW[slot] = ww;
        }
      }
      let wsum = jW[0] + jW[1] + jW[2] + jW[3];
      if (wsum <= 1e-6) { jIdx[0] = 0; jW[0] = 1; wsum = 1; }
      const wInv = 1 / wsum;

      /* 朝向：局部 +Z 对齐法向，再随机 roll */
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
      const sc = size * 0.5 * jf;   /* size = 可见半径(≈2σ)，σ = size/2；3σ 裁剪半径 = 1.5·size */
      scJit[s] = jf;

      splatCtr[s * 3] = px; splatCtr[s * 3 + 1] = py; splatCtr[s * 3 + 2] = pz;

      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
      if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;

      /* 写 4 个顶点 */
      for (let v = 0; v < 4; v++) {
        const vi = s * 4 + v;
        aCorner[vi * 2] = CORNERS[v * 2];
        aCorner[vi * 2 + 1] = CORNERS[v * 2 + 1];

        aCenter[vi * 3] = px;
        aCenter[vi * 3 + 1] = py;
        aCenter[vi * 3 + 2] = pz;

        aNormal[vi * 3] = nx;
        aNormal[vi * 3 + 1] = ny;
        aNormal[vi * 3 + 2] = nz;

        aQuat[vi * 4] = _q.x; aQuat[vi * 4 + 1] = _q.y; aQuat[vi * 4 + 2] = _q.z; aQuat[vi * 4 + 3] = _q.w;

        aScale[vi] = sc;
        aColor[vi * 3] = cr; aColor[vi * 3 + 1] = cg; aColor[vi * 3 + 2] = cb;
        aAlpha[vi] = 1.0;

        aBoneIdx[vi * 4] = jIdx[0]; aBoneIdx[vi * 4 + 1] = jIdx[1];
        aBoneIdx[vi * 4 + 2] = jIdx[2]; aBoneIdx[vi * 4 + 3] = jIdx[3];
        aBoneW[vi * 4] = jW[0] * wInv; aBoneW[vi * 4 + 1] = jW[1] * wInv;
        aBoneW[vi * 4 + 2] = jW[2] * wInv; aBoneW[vi * 4 + 3] = jW[3] * wInv;
      }

      boneIdx[s * 4] = jIdx[0]; boneIdx[s * 4 + 1] = jIdx[1];
      boneIdx[s * 4 + 2] = jIdx[2]; boneIdx[s * 4 + 3] = jIdx[3];
      boneW[s * 4] = jW[0] * wInv; boneW[s * 4 + 1] = jW[1] * wInv;
      boneW[s * 4 + 2] = jW[2] * wInv; boneW[s * 4 + 3] = jW[3] * wInv;
    }

    /* --- 脚底对齐：网格原点不在脚底则整体平移 --- */
    const footOffset = -minY;
    if (Math.abs(footOffset) > 0.005) {
      for (let i = 1; i < aCenter.length; i += 3) aCenter[i] += footOffset;
      minY = 0; maxY += footOffset;
    }
    if (Math.abs(footOffset) > 0.005) {
      for (let i = 1; i < splatCtr.length; i += 3) splatCtr[i] += footOffset;
    }
    this._footOffset = Math.abs(footOffset) > 0.005 ? footOffset : 0;

    /* 每高斯相对「加权骨骼绑定位置」的偏移（绑定姿态下使排序键等于精确视深） */
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

    /* --- geometry --- */
    const g = new THREE.BufferGeometry();
    const mk = (arr, isize) => new THREE.BufferAttribute(arr, isize).setUsage(THREE.StaticDrawUsage);
    g.setAttribute('aCorner', mk(aCorner, 2));
    g.setAttribute('aCenter', mk(aCenter, 3));
    g.setAttribute('aNormal', mk(aNormal, 3));
    g.setAttribute('aScale', mk(aScale, 1));
    g.setAttribute('aQuat', mk(aQuat, 4));
    g.setAttribute('aColor', mk(aColor, 3));
    g.setAttribute('aAlpha', mk(aAlpha, 1));
    g.setAttribute('aBoneIdx', mk(aBoneIdx, 4));
    g.setAttribute('aBoneW', mk(aBoneW, 4));

    /* 每高斯 4 顶点 + 6 索引（两个三角形，THREE.Mesh 固定按 gl.TRIANGLES 绘制）
       顶点：0=(-1,-1) 1=(1,-1) 2=(-1,1) 3=(1,1)
       三角：0,1,2 / 2,1,3 */
    const idxArr = new Uint32Array(n * 6);
    for (let k = 0; k < n; k++) {
      const v = k * 4, o = k * 6;
      idxArr[o] = v; idxArr[o + 1] = v + 1; idxArr[o + 2] = v + 2;
      idxArr[o + 3] = v + 2; idxArr[o + 4] = v + 1; idxArr[o + 5] = v + 3;
    }
    const idxAttr = new THREE.BufferAttribute(idxArr, 1);
    idxAttr.setUsage(THREE.DynamicDrawUsage);
    g.setIndex(idxAttr);
    g.setDrawRange(0, n * 6);
    g.boundingSphere = new THREE.Sphere(
      new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2),
      Math.max(0.1, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) * 0.5 + 0.05)
    );
    this.geometry = g;
    this._indexAttr = idxAttr;
    this._indexArr = idxArr;
    this._scJit = scJit;

    /* --- 骨骼矩阵 DataTexture（每骨骼 4 texel） --- */
    const nb = this.skeleton.bones.length;
    this._boneData = new Float32Array(nb * 16);
    const texW = nb * 4;
    this._boneTex = new THREE.DataTexture(this._boneData, texW, 1, THREE.RGBAFormat, THREE.FloatType);
    this._boneTex.minFilter = THREE.NearestFilter;
    this._boneTex.magFilter = THREE.NearestFilter;
    this._boneTex.wrapS = THREE.ClampToEdgeWrapping;
    this._boneTex.wrapT = THREE.ClampToEdgeWrapping;
    this._boneTex.generateMipmaps = false;
    this._boneTex.needsUpdate = true;

    /* --- material --- */
    this._material = new THREE.ShaderMaterial({
      uniforms: {
        uBoneTex: { value: this._boneTex },
        uBoneTexSize: { value: new THREE.Vector2(texW, 1) },
        uViewport: { value: this._viewport },
        uOpacity: { value: opacity },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    this.material = this._material;
    this._mesh = new THREE.Mesh(g, this._material);
    this._mesh.frustumCulled = false;
    this._mesh.renderOrder = 10;
    this.object.add(this._mesh);

    /* --- 排序用的常驻缓冲 --- */
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

    this.stats.splats = n;

    /* --- 隐藏原网格，避免双重渲染 --- */
    this._origVisible = mesh.visible;
    mesh.visible = false;

    /* --- 单例矩阵 --- */
    this._t1 = new THREE.Matrix4();
    this._t2 = new THREE.Matrix4();
    this._t3 = new THREE.Matrix4();
    this._pm = new THREE.Matrix4();

    /* 首帧：根变换 + 骨骼矩阵 + 排序 */
    this._syncRoot();
    this.updateBones();
    this._material.uniforms.uOpacity.value = opacity * this._opacityScale;
  }

  /* ---------------------------------------------------------- 每帧 */

  /** 骨骼世界矩阵 → DataTexture。调用前应已 skeleton.update / scene.updateMatrixWorld。 */
  updateBones() {
    const t0 = performance.now();
    const sk = this.skeleton;
    const bones = sk.bones;
    const invs = sk.boneInverses;
    const nb = bones.length;

    /* 保证骨骼世界矩阵是最新的（幂等，67 节点级开销可忽略） */
    const root = this._rootObject() || this.mesh;
    root.updateWorldMatrix(true, true);
    this._syncRoot();

    const bind = this.mesh.bindMatrix;
    const bindInv = this.mesh.bindMatrixInverse;
    const out = this._boneData;
    const t1 = this._t1, t2 = this._t2, t3 = this._t3;

    for (let i = 0; i < nb; i++) {
      const b = bones[i];
      const inv = invs[i];
      /* M = bindInv · (boneWorld · boneInverse) · bind */
      if (inv) t1.multiplyMatrices(b.matrixWorld, inv);
      else t1.copy(b.matrixWorld);
      t2.multiplyMatrices(bindInv, t1);
      t3.multiplyMatrices(t2, bind);
      t3.toArray(out, i * 16);

      const e = b.matrixWorld.elements;
      this._bonePos[i * 3] = e[12];
      this._bonePos[i * 3 + 1] = e[13];
      this._bonePos[i * 3 + 2] = e[14];
    }
    this._boneTex.needsUpdate = true;
    this.stats.boneMs = +(performance.now() - t0).toFixed(2);
  }

  /**
   * 桶排序（由远到近），重写 index。禁止全量 Array.sort。
   *
   * 排序键 = Σ wᵢ·depth(boneᵢ) + rZL·(p_rest − Σ wᵢ·bone_restᵢ)
   *   · 前半部分是 CONTRACT §2-1 要求的「骨骼加权深度」；
   *   · 后半部分是采样点相对所属骨骼的精确视深偏移（同一骨骼内的高斯不会同键，
   *     否则头部这类大骨骼内部的前后遮挡会乱序，出现色斑）。
   *   绑定姿态下二者之和等于采样点的精确视深。
   */
  updateSort(camera) {
    const t0 = performance.now();
    const n = this._n;
    if (!n || !camera) { this.stats.sortMs = 0; return; }

    camera.updateMatrixWorld();
    const e = camera.matrixWorldInverse.elements;
    const bd = this._boneDepth;
    const bp = this._bonePos;
    const nb = bd.length;
    for (let b = 0; b < nb; b++) {
      const o = b * 3;
      bd[b] = -(e[2] * bp[o] + e[6] * bp[o + 1] + e[10] * bp[o + 2] + e[14]);
    }

    /* 世界视深方向 → mesh 局部空间 */
    const rzx = -e[2], rzy = -e[6], rzz = -e[10];
    const me = this.object.matrixWorld.elements;
    const rlx = me[0] * rzx + me[1] * rzy + me[2] * rzz;
    const rly = me[4] * rzx + me[5] * rzy + me[6] * rzz;
    const rlz = me[8] * rzx + me[9] * rzy + me[10] * rzz;

    /* 深度区间：骨骼深度范围 ± 最大局部偏移，省掉一次全量 min/max 遍历 */
    let mn = Infinity, mx = -Infinity;
    for (let b = 0; b < nb; b++) {
      const d = bd[b];
      if (d < mn) mn = d;
      if (d > mx) mx = d;
    }
    const L = this._maxOff;
    mn -= L; mx += L;

    const bi = this._boneIdx;
    const bw = this._boneW;
    const off = this._restOff;
    const counts = this._counts;
    const offs = this._offs;
    const bucket = this._bucket;
    counts.fill(0);

    const span = Math.max(mx - mn, 1e-4);
    const inv = (BUCKETS - 1) / span;
    for (let i = 0; i < n; i++) {
      const k = i * 4, o3 = i * 3;
      const d = bw[k] * bd[bi[k]] + bw[k + 1] * bd[bi[k + 1]]
        + bw[k + 2] * bd[bi[k + 2]] + bw[k + 3] * bd[bi[k + 3]]
        + rlx * off[o3] + rly * off[o3 + 1] + rlz * off[o3 + 2];
      let b = ((d - mn) * inv) | 0;
      if (b < 0) b = 0; else if (b > BUCKETS - 1) b = BUCKETS - 1;
      b = (BUCKETS - 1) - b;          /* 反转：桶 0 = 最远（先画远处） */
      bucket[i] = b;
      counts[b]++;
    }

    const _t1 = performance.now();
    let sum = 0;
    for (let b = 0; b < BUCKETS; b++) { offs[b] = sum; sum += counts[b]; }

    /* 散列：先把排序结果落到 order（4B/高斯散写），再顺序写 index（顺序写快得多） */
    const order = this._order;
    for (let i = 0; i < n; i++) order[offs[bucket[i]]++] = i;

    const idx = this._indexArr;
    for (let k = 0, o = 0; k < n; k++) {
      const v = order[k] << 2;
      idx[o] = v; idx[o + 1] = v + 1; idx[o + 2] = v + 2;
      idx[o + 3] = v + 2; idx[o + 4] = v + 1; idx[o + 5] = v + 3;
      o += 6;
    }
    this._indexAttr.needsUpdate = true;
    const _t2 = performance.now();
    this.stats._keyMs = +(_t1 - t0).toFixed(2);
    this.stats._writeMs = +(_t2 - _t1).toFixed(2);

    this.stats.sortMs = +(performance.now() - t0).toFixed(2);
  }

  /* ---------------------------------------------------------- 控制 */

  setVisible(v) {
    this.object.visible = !!v;
  }

  setOpacityScale(s) {
    this._opacityScale = Math.min(1, Math.max(0, +s || 0));
    if (this._material) {
      this._material.uniforms.uOpacity.value = this._opacity * this._opacityScale;
    }
  }

  /** 运行期改高斯半径（只重写 aScale，不重采样）。size 语义同 create({size})。 */
  setSplatSize(size) {
    const s = Math.max(1e-4, +size || 0);
    const attr = this.geometry && this.geometry.getAttribute('aScale');
    if (!attr) return;
    const arr = attr.array, n = this._n, jit = this._scJit;
    for (let k = 0; k < n; k++) {
      const v = s * 0.5 * (jit ? jit[k] : 1);
      const o = k * 4;
      arr[o] = v; arr[o + 1] = v; arr[o + 2] = v; arr[o + 3] = v;
    }
    attr.needsUpdate = true;
    this._size = s;
    this.stats.size = +s.toFixed(4);
  }

  /** 视口（drawingBuffer 像素）。给 renderer 时自动读取。 */
  setViewport(w, h) {
    this._viewport.set(Math.max(1, w | 0), Math.max(1, h | 0));
  }

  /** 初始化失败兜底：原网格恢复显示，高斯隐藏。 */
  fallback(err) {
    if (err) this.stats.error = (err && err.message) || String(err);
    if (this.mesh) this.mesh.visible = this._origVisible !== false;
    if (this.object) this.object.visible = false;
    console.warn('[SplatAvatar] 回退为原始蒙皮网格：', this.stats.error);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._mesh && this._mesh.parent) this._mesh.parent.remove(this._mesh);
    if (this.object && this.object.parent) this.object.parent.remove(this.object);
    if (this.geometry) this.geometry.dispose();
    if (this._material) this._material.dispose();
    if (this._boneTex) this._boneTex.dispose();
    if (this.mesh && this._origVisible !== false) this.mesh.visible = true;
  }

  /* ---------------------------------------------------------- 内部 */

  _rootObject() {
    let o = this.mesh;
    let guard = 0;
    while (o.parent && guard++ < 64) o = o.parent;
    this._rootObj = o;
    return o;
  }

  /** object 的世界矩阵跟随 mesh（含根运动），换算为父级局部矩阵。 */
  _syncRoot() {
    if (!this.mesh) return;
    const mw = this.mesh.matrixWorld;

    /* 视口：优先从 renderer 读取；未传 renderer 时退化为窗口尺寸（保证不出现 (1,1) 导致高斯不可见） */
    if (this._renderer && this._renderer.getDrawingBufferSize) {
      const v = this._renderer.getDrawingBufferSize(this._v2 || (this._v2 = new THREE.Vector2()));
      if (v.x > 1) this._viewport.set(v.x, v.y);
    } else if (typeof window !== 'undefined') {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(window.innerWidth * dpr);
      const h = Math.round(window.innerHeight * dpr);
      if (w > 1 && h > 1 && (this._viewport.x !== w || this._viewport.y !== h)) this._viewport.set(w, h);
    }

    if (this.object.parent && this.object.parent.matrixWorld) {
      this._pm.copy(this.object.parent.matrixWorld).invert().multiply(mw);
    } else {
      this._pm.copy(mw);
    }
    this._pm.decompose(this.object.position, this.object.quaternion, this.object.scale);
    if (!isFinite(this.object.position.x)) {
      this._pm.identity();
      this.object.position.set(0, 0, 0);
      this.object.quaternion.identity();
      this.object.scale.set(1, 1, 1);
    }
  }
}

export default SplatAvatar;

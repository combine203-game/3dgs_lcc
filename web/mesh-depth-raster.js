/**
 * 碰撞 Mesh 深度 · CPU 光栅化（无引擎依赖的纯函数模块）
 * ----------------------------------------------------------------
 * 为什么不用引擎的离屏相机来做这份深度：
 *   这个 PlayCanvas 构建里，自建 Layer + 自建相机的离屏通道**只清屏不提交 draw**
 *   （层在 layerList 里、相机 layers=[id]、几何也在层里，实测 0 次 draw；同样的
 *   几何挂到既有的 World 层立刻出图）。历史上贴花 Pass1「深度为空」也是同一个坑。
 *   与其和渲染管线搏斗，不如自己算出深度：碰撞几何本来就已经在 JS 里
 *   （lcc2-collision 的 SoA triangles），透视投影 + z-buffer 光栅化是确定性的，
 *   两个后端、任何分辨率都一致，还能按需要降频。
 *
 * 口径必须和 3DGS 深度视口**完全一致**，否则没法对比：
 *   · 同一个投影矩阵（主相机的 proj × view）；
 *   · 同一条深度轴：clip.w 就是视空间深度（PlayCanvas 透视投影 row3 = (0,0,-1,0)，
 *     即 w = -z_view，与 depth-shaders 里 `vDepth = -(uView*world).z` 同号）；
 *   · 同一个归一化：[near, far] 线性 → nd ∈ [0,1]。
 *
 * 输出：RGBA8，把 1-nd 打成 16 bit（R = 高 8 位，G = 低 8 位，A = 255）。
 *   A = 0 表示「这个像素没有表面」—— 65536 级量化在 105 m 视距上约 1.6 mm，
 *   足够看清「碰撞体表面 vs splat 表面」的偏差；8 bit 单通道只有 0.4 m，不可用。
 *   用 A 而不是「RGB 全 0」做覆盖标记：贴地平板正好落在 far 上时 nd=1，
 *   编码结果也是 R=G=0，靠 RGB 会把它误判成空洞。
 *
 * 近平面：整三角形丢弃是不行的 —— 站在房间里时地面的三角形横跨相机前后，
 * 一丢就是大半块地。这里在齐次空间对 w >= near 做 Sutherland-Hodgman 裁剪，
 * 裁出的 3/4 边形再扇形三角化。远平面不裁（碰撞体都在 far 内侧）。
 *
 * 阶段划分（便于单测）：
 *   createRaster(w, h)                → 复用的帧缓冲
 *   rasterize(rast, tris, vp, near, far) → 写入 rast.rgba
 */

/** 复用缓冲：invW 每像素 1/w（越大越近，0 = 空），rgba 是最终纹理数据 */
export function createRaster(width, height) {
  const w = Math.max(1, width | 0);
  const h = Math.max(1, height | 0);
  return {
    w, h,
    invW: new Float32Array(w * h),
    rgba: new Uint8ClampedArray(w * h * 4),
    drawn: 0                        // 本帧真正光栅化的三角形数（诊断用）
  };
}

/* 裁剪 / 投影的暂存区（三角形裁完最多 4 个顶点；单线程，模块级复用即可） */
const CLIP = 8;
const cx4 = new Float32Array(CLIP);
const cy4 = new Float32Array(CLIP);
const cw4 = new Float32Array(CLIP);
const sx4 = new Float32Array(CLIP);
const sy4 = new Float32Array(CLIP);
const siw4 = new Float32Array(CLIP);

/**
 * @param {object} rast   createRaster 的返回值（会被就地覆盖）
 * @param {{positions:Float32Array, indices:Uint32Array}} tris  世界坐标 flat 三角网格
 * @param {Float32Array} vp  列主序 4x4（proj × view）
 * @param {number} near
 * @param {number} far
 * @returns {Uint8ClampedArray} rast.rgba
 */
export function rasterize(rast, tris, vp, near, far) {
  const { w, h, invW, rgba } = rast;
  invW.fill(0);
  rgba.fill(0);
  rast.drawn = 0;
  if (!tris || !tris.positions || !tris.indices || !vp) return rgba;

  const pos = tris.positions;
  const idx = tris.indices;
  const nTri = (idx.length / 3) | 0;
  const m0 = vp[0], m1 = vp[1], m2 = vp[2], m3 = vp[3];
  const m4 = vp[4], m5 = vp[5], m6 = vp[6], m7 = vp[7];
  const m8 = vp[8], m9 = vp[9], m10 = vp[10], m11 = vp[11];
  const m12 = vp[12], m13 = vp[13], m14 = vp[14], m15 = vp[15];
  const halfW = w * 0.5, halfH = h * 0.5;
  const zNear = Math.max(1e-4, near);
  const zFar = Math.max(zNear + 1e-3, far);
  let drawn = 0;

  for (let t = 0; t < nTri; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;

    /* --- 顶点 → 齐次裁剪坐标（只关心 x/y/w，z 用不到） --- */
    let px = pos[a], py = pos[a + 1], pz = pos[a + 2];
    let w0 = m3 * px + m7 * py + m11 * pz + m15;
    let x0 = m0 * px + m4 * py + m8 * pz + m12;
    let y0 = m1 * px + m5 * py + m9 * pz + m13;

    px = pos[b]; py = pos[b + 1]; pz = pos[b + 2];
    let w1 = m3 * px + m7 * py + m11 * pz + m15;
    let x1 = m0 * px + m4 * py + m8 * pz + m12;
    let y1 = m1 * px + m5 * py + m9 * pz + m13;

    px = pos[c]; py = pos[c + 1]; pz = pos[c + 2];
    let w2 = m3 * px + m7 * py + m11 * pz + m15;
    let x2 = m0 * px + m4 * py + m8 * pz + m12;
    let y2 = m1 * px + m5 * py + m9 * pz + m13;

    /* --- 近平面裁剪：保留 w >= zNear 的部分 --- */
    cx4[0] = x0; cy4[0] = y0; cw4[0] = w0;
    cx4[1] = x1; cy4[1] = y1; cw4[1] = w1;
    cx4[2] = x2; cy4[2] = y2; cw4[2] = w2;
    let n = 0;
    if (w0 >= zNear && w1 >= zNear && w2 >= zNear) {
      n = 3;
    } else if (w0 < zNear && w1 < zNear && w2 < zNear) {
      continue;
    } else {
      for (let i = 0; i < 3; i++) {
        const j = (i + 1) % 3;
        const wi = cw4[i], wj = cw4[j];
        const ini = wi >= zNear, inj = wj >= zNear;
        if (ini) {
          cx4[n] = cx4[i]; cy4[n] = cy4[i]; cw4[n] = wi; n++;
        }
        if (ini !== inj) {
          const k = (zNear - wi) / (wj - wi);
          cx4[n] = cx4[i] + (cx4[j] - cx4[i]) * k;
          cy4[n] = cy4[i] + (cy4[j] - cy4[i]) * k;
          cw4[n] = zNear;
          n++;
        }
      }
    }
    if (n < 3) continue;

    /* --- 透视除法 → 屏幕坐标（左上原点）与 1/w --- */
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const iw = 1 / cw4[i];
      const sx = cx4[i] * iw * halfW + halfW;
      const sy = halfH - cy4[i] * iw * halfH;
      sx4[i] = sx; sy4[i] = sy; siw4[i] = iw;
      if (sx < minX) minX = sx;
      if (sx > maxX) maxX = sx;
      if (sy < minY) minY = sy;
      if (sy > maxY) maxY = sy;
    }

    let x0i = Math.floor(minX), x1i = Math.ceil(maxX);
    let y0i = Math.floor(minY), y1i = Math.ceil(maxY);
    if (x0i < 0) x0i = 0;
    if (y0i < 0) y0i = 0;
    if (x1i > w - 1) x1i = w - 1;
    if (y1i > h - 1) y1i = h - 1;
    if (x0i > x1i || y0i > y1i) continue;

    drawn++;

    /* --- 扇形三角化（n=3 时就是原三角形） --- */
    for (let f = 1; f < n - 1; f++) {
      const ax = sx4[0], ay = sy4[0], aiw = siw4[0];
      const bx = sx4[f], by = sy4[f], biw = siw4[f];
      const dx = sx4[f + 1], dy = sy4[f + 1], diw = siw4[f + 1];

      /* 有向面积：退化三角形跳过（两个方向都收，碰撞体法向不可信） */
      const area = (bx - ax) * (dy - ay) - (dx - ax) * (by - ay);
      if (!(area > 1e-9) && !(area < -1e-9)) continue;
      const invArea = 1 / area;

      /* 该扇形的子包围盒（扇形可能比整体包围盒小） */
      let fx0 = Math.floor(Math.min(ax, bx, dx)), fx1 = Math.ceil(Math.max(ax, bx, dx));
      let fy0 = Math.floor(Math.min(ay, by, dy)), fy1 = Math.ceil(Math.max(ay, by, dy));
      if (fx0 < x0i) fx0 = x0i;
      if (fy0 < y0i) fy0 = y0i;
      if (fx1 > x1i) fx1 = x1i;
      if (fy1 > y1i) fy1 = y1i;
      if (fx0 > fx1 || fy0 > fy1) continue;

      for (let yy = fy0; yy <= fy1; yy++) {
        const sy = yy + 0.5;
        for (let xx = fx0; xx <= fx1; xx++) {
          const sx = xx + 0.5;
          /* 重心坐标（屏幕空间，1/w 线性插值） */
          const l1 = ((sx - ax) * (dy - ay) - (dx - ax) * (sy - ay)) * invArea;
          if (l1 < 0) continue;
          const l2 = ((bx - ax) * (sy - ay) - (sx - ax) * (by - ay)) * invArea;
          if (l2 < 0) continue;
          const l0 = 1 - l1 - l2;
          if (l0 < 0) continue;
          const iw = l0 * aiw + l1 * biw + l2 * diw;
          const k = yy * w + xx;
          if (iw > invW[k]) invW[k] = iw;
        }
      }
    }
  }

  /* --- 编码：nd → 1-nd → 16 bit（R 高 / G 低），A = 覆盖标记 --- */
  const span = zFar - zNear;
  const invSpan = 1 / span;
  for (let k = 0, p = 0; k < invW.length; k++, p += 4) {
    const iw = invW[k];
    if (!(iw > 0)) continue;                        // 无表面：保持全 0（A 也是 0）
    let nd = (1 / iw - zNear) * invSpan;
    if (!(nd >= 0)) nd = 0; else if (nd > 1) nd = 1;
    /* 1-nd 的小端 16 bit：近处大、远处小 */
    let q = Math.round((1 - nd) * 65535);
    if (q < 0) q = 0; else if (q > 65535) q = 65535;
    rgba[p] = q >> 8;
    rgba[p + 1] = q & 255;
    rgba[p + 2] = 0;
    rgba[p + 3] = 255;
  }
  rast.drawn = drawn;
  return rgba;
}

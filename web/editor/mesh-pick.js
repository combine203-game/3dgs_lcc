/**
 * 碰撞体 MESH 拾取（最高优先级）
 *
 * 工程自带 XGrids 官方分块 PLY + btree，app.js 已把它构造成引擎的
 * MeshCollision（内部自带 BVH + queryRay / querySurfaceNormal）。
 * 这里直接复用 Viewer 那份实例（viewer.collision()，由 viewer/index.js
 * 暴露的只读 getter 提供），不重复下载、不重复构建 BVH。
 * 若 getter 不可用（旧版引擎），才降级为自行解码 PLY。
 */
const cache = new Map();     // scene -> Promise<MeshCollision|null>
const info = new Map();      // scene -> { status, tris, parts, ms, error, reused }

function stateOf(scene) {
  if (!info.has(scene)) info.set(scene, { status: 'idle', tris: 0, parts: 0, ms: 0, error: null, reused: false });
  return info.get(scene);
}

export function meshState(scene) { return { ...stateOf(scene) }; }

function triCount(col) {
  try { return col?.triangles?.count || 0; } catch (_) { return 0; }
}

export async function ensureMesh(scene, getViewer) {
  if (cache.has(scene)) return cache.get(scene);
  const st = stateOf(scene);
  const p = (async () => {
    st.status = 'loading';
    const t0 = performance.now();
    // L1：复用 Viewer 已加载的碰撞体。官方 PLY+btree 是异步 attach 的，
    // 编辑器可能比它先就绪，轮询等待（上限 8s）可避免二次解码 18 MB 网格。
    try {
      for (let i = 0; i < 32; i++) {
        const v = getViewer();
        // 旧引擎没有这个 getter，不必白等，直接自己解码
        if (typeof v?.collision !== 'function') break;
        const col = v.collision();
        if (col && typeof col.queryRay === 'function') {
          Object.assign(st, {
            status: 'ready', tris: triCount(col), parts: 0,
            ms: Math.round(performance.now() - t0), error: null, reused: true
          });
          return col;
        }
        await new Promise(r => setTimeout(r, 250));
      }
    } catch (_) { /* getter 抛错也不能中断拾取链，直接走 L2 */ }

    // L2：旧引擎没有 getter，用官方解码器自己加载一份（仅一次）
    try {
      const loader = window.__mgLoadLcc2Collision;
      if (typeof loader !== 'function') throw new Error('官方碰撞解码器未加载');
      const app = getViewer()?.app;
      const url = './sog/' + encodeURIComponent(scene) + '/collision-manifest.json';
      const col = await loader(app, url);
      if (!col || typeof col.queryRay !== 'function') throw new Error('碰撞体缺少 queryRay');
      const meta = window.__mgCollisionInfo || {};
      Object.assign(st, {
        status: 'ready', tris: triCount(col) || meta.tris || 0,
        parts: (meta.parts || []).length,
        ms: Math.round(performance.now() - t0), error: null, reused: false
      });
      return col;
    } catch (err) {
      st.status = 'error';
      st.error = String(err?.message ?? err);
      console.warn('[editor/mesh] 碰撞体不可用，退回深度图 / 平面拾取：', err);
      return null;
    }
  })();
  cache.set(scene, p);
  return p;
}

/**
 * 射线 × 碰撞 MESH 求交（Möller–Trumbore + BVH，由引擎 MeshCollision 提供）
 * @param {number[]} origin 相机世界坐标
 * @param {number[]} dir    射线方向（无需归一化，引擎内部会归一化）
 * @returns {{pos:number[], source:'mesh', normal?:number[]}|null}
 */
/* ---------------------------------------------------------------- 最近面吸附
 * 拖拽展板引线锚点时，射线可能从物体边缘擦过去（一点都没命中）。
 * 这时用「碰撞 MESH 三角形」做一次真正的最近点查询：把三角形质心装进
 * 2m 体素哈希，只查目标点周围的格子，再算点到三角形的最近点。
 * 网格只建一次并缓存在 WeakMap 上，不重复下载 / 不重复构建 BVH。
 */
const grids = new WeakMap();

function meshGrid(col) {
  const t = col?.triangles;
  if (!t || !t.count || !t.v0x?.length) return null;
  const cell = 2;
  const buckets = new Map();
  for (let i = 0; i < t.count; i++) {
    const cx = (t.v0x[i] + t.v1x[i] + t.v2x[i]) / 3;
    const cy = (t.v0y[i] + t.v1y[i] + t.v2y[i]) / 3;
    const cz = (t.v0z[i] + t.v1z[i] + t.v2z[i]) / 3;
    const k = `${Math.floor(cx / cell)},${Math.floor(cy / cell)},${Math.floor(cz / cell)}`;
    let arr = buckets.get(k);
    if (!arr) { arr = []; buckets.set(k, arr); }
    arr.push(i);
  }
  return { cell, buckets, t };
}

const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** 点到三角形的最近点（Real-Time Collision Detection, Ericson 5.1.5） */
function closestOnTri(p, a, b, c) {
  const ab = sub3(b, a), ac = sub3(c, a), ap = sub3(p, a);
  const d1 = dot3(ab, ap), d2 = dot3(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub3(p, b), d3 = dot3(ab, bp), d4 = dot3(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return [a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v];
  }
  const cp = sub3(p, c), d5 = dot3(ab, cp), d6 = dot3(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return [a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w];
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return [b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w];
  }
  const denom = 1 / (va + vb + vc), v = vb * denom, w = vc * denom;
  return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
}

/**
 * @param {number[]} p 待吸附的世界坐标
 * @returns {{pos:number[], normal:number[], distance:number, source:'mesh'}|null}
 */
export function nearestMeshPoint(col, p, maxDist = 4) {
  if (!col || !Array.isArray(p) || p.length < 3) return null;
  let g = grids.get(col);
  if (g === undefined) { g = meshGrid(col); grids.set(col, g); }
  if (!g) return null;                       // 旧引擎 / mock 没有三角数组时跳过
  const { cell, buckets, t } = g;
  const r = Math.ceil(maxDist / cell);
  const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell), cz = Math.floor(p[2] / cell);
  let best = null, bestD2 = maxDist * maxDist;
  for (let x = cx - r; x <= cx + r; x++)
    for (let y = cy - r; y <= cy + r; y++)
      for (let z = cz - r; z <= cz + r; z++) {
        const arr = buckets.get(`${x},${y},${z}`);
        if (!arr) continue;
        for (const i of arr) {
          const q = closestOnTri(p,
            [t.v0x[i], t.v0y[i], t.v0z[i]],
            [t.v1x[i], t.v1y[i], t.v1z[i]],
            [t.v2x[i], t.v2y[i], t.v2z[i]]);
          const d2 = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2;
          if (d2 < bestD2) {
            bestD2 = d2;
            best = { pos: q, normal: [t.nx[i], t.ny[i], t.nz[i]], distance: Math.sqrt(d2) };
          }
        }
      }
  return best ? { ...best, source: 'mesh' } : null;
}

export function rayHitMesh(col, origin, dir, maxDist = 300) {
  if (!col || typeof col.queryRay !== 'function') return null;
  try {
    const h = col.queryRay(origin[0], origin[1], origin[2], dir[0], dir[1], dir[2], maxDist);
    if (!h || ![h.x, h.y, h.z].every(Number.isFinite)) return null;
    const pos = [h.x, h.y, h.z];
    let normal = null;
    try {
      const len = Math.hypot(...dir) || 1;
      const n = col.querySurfaceNormal(h.x, h.y, h.z, -dir[0] / len, -dir[1] / len, -dir[2] / len);
      if (n && [n.nx, n.ny, n.nz].every(Number.isFinite)) normal = [n.nx, n.ny, n.nz];
    } catch (_) { /* 法线只是附加信息 */ }
    return { pos, source: 'mesh', normal };
  } catch (_) {
    return null;
  }
}

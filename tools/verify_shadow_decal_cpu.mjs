/**
 * 标准 Shadow-Map Decal（三段式）无头 CPU 验证
 * ----------------------------------------------------------------
 * 无头 SwiftShader 下 CDP/toDataURL 会触发 Dawn VertexState 错误、帧缓冲交替
 * 全白，像素证据一律作废。本脚本复现 Pass1 正交投影 + Pass3 深度判定的数学，
 * 用真机探针报告里的 projector + 49 个框选表面点验证：
 *
 *   ① OBB 局部盒命中（正交 ViewProj 下等价于 uvProj ∈ [0,1]²）
 *   ② uvProj 落在 [0,1]、深度落在 [0,1]（Pass1 depth-only RT 的有效域）
 *   ③ 深度比较方向：场景点沿视线远离投影仪 → 深度变大 → 被遮挡 discard；
 *      靠近投影仪 → 深度变小 → 通过（常规深度，与 shader 的 fragD>mapD+bias 对应）
 *   ④ 视频行序：局部 +Y（框选区上方）映射到更小的 v（图像上半）
 *
 * 用法：node tools/verify_shadow_decal_cpu.mjs [report.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = process.argv[2] || path.join(ROOT, 'tools', 'probe-real-report.json');
const BIAS = 0.002;             // 与 decal-projection.js 的 uShadowBias 一致
const MARGIN = 1.0;             // 与 playcanvas-adapter.js setDepthPassProjector 一致

const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
];

function rotateByQuat(v, q) {
  const u = [q[0], q[1], q[2]], w = q[3];
  const uv = cross(u, v), uuv = cross(u, uv);
  return [
    v[0] + 2 * (w * uv[0] + uuv[0]),
    v[1] + 2 * (w * uv[1] + uuv[1]),
    v[2] + 2 * (w * uv[2] + uuv[2])
  ];
}

/** 世界点 → projector 局部坐标（正交相机与 OBB 同基，ViewProj 等价于此线性映射） */
function worldToLocal(W, projector) {
  const p = projector.position;
  const d = [W[0] - p[0], W[1] - p[1], W[2] - p[2]];
  const qc = [-projector.quaternion[0], -projector.quaternion[1],
    -projector.quaternion[2], projector.quaternion[3]];
  return rotateByQuat(d, qc);
}

/** 正交 Pass1 的 window z（相机在局部 -Z 侧，near=0.01，far=2*halfZ+2*margin+2） */
function localDepth(lz, halfZ) {
  const near = 0.01;
  const far = 2 * halfZ + 2 * MARGIN + 2;
  const dist = lz + halfZ + MARGIN;   // 相机空间沿视线的距离
  return (dist - near) / (far - near);
}

function project(W, projector) {
  const L = worldToLocal(W, projector);
  const half = projector.half;
  const u = L[0] / half[0] * 0.5 + 0.5;
  // 与 shader 的 uVideoFlipY=1 一致：canvas 纹理 flipY=false，必须翻 v
  const v = 1.0 - (L[1] / half[1] * 0.5 + 0.5);
  const d = localDepth(L[2], half[2]);
  return { u, v, d, L };
}

let pass = true;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  -> ' + detail : ''));
  if (!ok) pass = false;
};

function main() {
  if (!fs.existsSync(REPORT)) throw new Error('找不到探针报告：' + REPORT);
  const r = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
  const proj = r.projector;
  const pts = (r.surface?.pts || []).filter(p => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite));
  if (!proj || !pts.length) throw new Error('报告缺少 projector 或 surface.pts');
  const half = proj.half;

  console.log('\n===== 标准 Shadow-Map Decal 三段式 CPU 验证 =====');
  console.log('  报告 =', path.basename(REPORT), ' 采样点 =', pts.length);
  console.log('  投影机 half =', half.map(v => v.toFixed(2)).join(','));

  check('projector 位置/四元数/half 有效',
    Array.isArray(proj.position) && proj.position.every(Number.isFinite) &&
    Array.isArray(proj.quaternion) && proj.quaternion.every(Number.isFinite) &&
    half.every(h => Number.isFinite(h) && h > 0));

  const uv = pts.map(p => project(p, proj));
  const inUV = uv.filter(p => p.u >= 0 && p.u <= 1 && p.v >= 0 && p.v <= 1);
  const inDepth = uv.filter(p => p.d >= 0 && p.d <= 1);
  check('① 49 点在正交投影 uvProj ∈ [0,1]²（OBB 由这些点拟合）',
    inUV.length === pts.length, inUV.length + '/' + pts.length);
  check('② 深度落在 Pass1 D32_FLOAT 的有效域 [0,1]',
    inDepth.length === pts.length, inDepth.length + '/' + pts.length);
  console.log('  uv 范围 = u[' + Math.min(...uv.map(p => p.u)).toFixed(3) + ',' +
    Math.max(...uv.map(p => p.u)).toFixed(3) + '] v[' +
    Math.min(...uv.map(p => p.v)).toFixed(3) + ',' +
    Math.max(...uv.map(p => p.v)).toFixed(3) + ']');
  console.log('  depth 范围 = [' + Math.min(...uv.map(p => p.d)).toFixed(3) + ',' +
    Math.max(...uv.map(p => p.d)).toFixed(3) + ']  bias =', BIAS);

  // ③ 深度比较方向：远离投影仪（局部 -Z）→ 深度变大 → fragD > mapD + bias → discard
  const nrm = rotateByQuat([0, 0, 1], proj.quaternion);
  let dirOk = 0;
  for (const W of pts) {
    const base = project(W, proj);
    // 相机在局部 -Z 侧朝 +Z 看：沿 +normal 移动 = 远离相机 = 深度变大
    const away = project([W[0] + nrm[0], W[1] + nrm[1], W[2] + nrm[2]], proj);
    const closer = project([W[0] - nrm[0], W[1] - nrm[1], W[2] - nrm[2]], proj);
    const awayDiscard = away.d > base.d + BIAS;   // 被遮挡：discard
    const closerPass = closer.d <= base.d + BIAS; // 可见：通过
    if (awayDiscard && closerPass) dirOk++;
  }
  check('③ 深度比较方向正确（远离→depth 增大→被遮挡；靠近→通过）',
    dirOk === pts.length, dirOk + '/' + pts.length);

  // ④ 行序：局部 +Y 最大的点（框选区上方）必须映射到更小的 v
  let hi = pts[0], lo = pts[0], maxY = -Infinity, minY = Infinity;
  for (const W of pts) {
    const ly = worldToLocal(W, proj)[1];
    if (ly > maxY) { maxY = ly; hi = W; }
    if (ly < minY) { minY = ly; lo = W; }
  }
  const uHi = project(hi, proj), uLo = project(lo, proj);
  check('④ 视频行序修正：框选区上方（局部 +Y）映射到更小的 v',
    uHi.v < uLo.v, 'v(' + uHi.v.toFixed(3) + ') < v(' + uLo.v.toFixed(3) + ')');

  console.log('\n' + (pass ? '★ 全部 PASS' : '✗ 存在未达标项'));
  return pass;
}

try { process.exit(main() ? 0 : 1); }
catch (e) { console.error('验证失败：' + (e?.message || e)); process.exit(2); }

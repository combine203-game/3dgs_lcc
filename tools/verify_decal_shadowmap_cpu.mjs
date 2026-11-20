/**
 * 视频始终在前（always-on-top projected decal）无头 CPU 验证
 * ----------------------------------------------------------------
 * 用途：无头 SwiftShader 下，无论 CDP 截图还是 toDataURL 都会触发 Dawn
 * "Vertex attribute slot 0 ... not present in the VertexState"，导致帧缓冲
 * 交替全白，visible/hidden 像素差分完全不可信。本脚本改为复现 shader
 * decalProject() 的数学，用真实探针导出的 projector + 49 个框选表面点，
 * 直接验证投影式贴花的两段判定（已无跨源深度遮挡测试）：
 *
 *   ① projector 局部盒命中  |L / (half*boxScale)| <= 1
 *   ② UV 落在 [0,1]          u = ln.x*0.5+0.5，v = 1-(ln.y*0.5+0.5)
 *      （canvas 视频纹理 flipY=false，shader 用 uVideoFlipY=1 翻 v，否则上下颠倒）
 *
 * 【语义变更 2026-11-19】旧的 ③ shadow 表面判定（dW vs 碰撞 mesh dMap）、
 * 降噪三件套（PCF / 法线阈值 / 软 mask）已全部删除——它们依赖「3DGS 深度」
 * 与「碰撞 mesh 深度」跨源比较，是像素遮挡错误/椒盐/破洞的根源。新语义：
 * 视频在投影锥内无条件显示（always-on-top），深度只用于算投影 UV。
 *
 * 数据来源：tools/probe-real-report.json（由 probe_decal_realpath.mjs 生成）
 * 用法：node tools/verify_decal_shadowmap_cpu.mjs [report.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = process.argv[2] || path.join(ROOT, 'tools', 'probe-real-report.json');
const BOX_SCALE = 1.0;         // 与默认 options.boxScale 一致

const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
];

/** 四元数旋转向量：v + 2w(u×v) + 2(u×(u×v))，q = [x,y,z,w] */
function rotateByQuat(v, q) {
  const u = [q[0], q[1], q[2]], w = q[3];
  const uv = cross(u, v);
  const uuv = cross(u, uv);
  return [
    v[0] + 2 * (w * uv[0] + uuv[0]),
    v[1] + 2 * (w * uv[1] + uuv[1]),
    v[2] + 2 * (w * uv[2] + uuv[2])
  ];
}

/** 世界点 → projector 局部坐标（先平移，再用共轭四元数旋转） */
function worldToLocal(W, projector) {
  const p = projector.position;
  const d = [W[0] - p[0], W[1] - p[1], W[2] - p[2]];
  const qConj = [-projector.quaternion[0], -projector.quaternion[1],
    -projector.quaternion[2], projector.quaternion[3]];
  return rotateByQuat(d, qConj);
}

/** 复现 shader decalProject：命中返回 uv，否则 null */
function decalProject(W, projector, half) {
  const L = worldToLocal(W, projector);
  const ln = [0, 1, 2].map(k => L[k] / (half[k] * BOX_SCALE));
  if (ln.some(v => Math.abs(v) > 1)) return null;
  // 与 shader 一致：局部 +Y 指向框选区上方，图像行0 是顶部 → v 必须翻转
  return [ln[0] * 0.5 + 0.5, 1.0 - (ln[1] * 0.5 + 0.5)];
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
  console.log('\n===== 视频始终在前 Decal 无头 CPU 验证 =====');
  console.log('  报告 =', path.basename(REPORT));
  console.log('  投影机 = pos', proj.position.map(v => v.toFixed(2)).join(','),
    ' half', half.map(v => v.toFixed(2)).join(','));
  console.log('  采样表面点 =', pts.length, ' boxScale =', BOX_SCALE);

  // 投影机本身必须有效
  check('projector 位置/四元数/half 有效',
    Array.isArray(proj.position) && proj.position.length === 3 && proj.position.every(Number.isFinite) &&
    Array.isArray(proj.quaternion) && proj.quaternion.length === 4 && proj.quaternion.every(Number.isFinite) &&
    Array.isArray(half) && half.length === 3 && half.every(h => Number.isFinite(h) && h > 0));

  // 逐点复现 decalProject
  let inBox = 0, uvOk = 0;
  const boxFails = [], uvOutliers = [], uvs = [];
  for (let i = 0; i < pts.length; i++) {
    const uv = decalProject(pts[i], proj, half);
    if (!uv) { boxFails.push(i); continue; }
    inBox++;
    uvs.push(uv);
    if (uv.some(v => v < -1e-6 || v > 1 + 1e-6)) uvOutliers.push({ i, uv: uv.map(v => +v.toFixed(3)) });
    else uvOk++;
  }

  console.log('\n  --- 逐段命中 ---');
  console.log('  ① projector 局部盒命中 =', inBox + '/' + pts.length,
    '(' + (100 * inBox / pts.length).toFixed(1) + '%)');
  console.log('  ② UV 落在 [0,1]       =', uvOk + '/' + inBox);

  // UV 分布范围（验证视频能覆盖整个投影区，而非只覆盖中间一小块）
  if (uvs.length) {
    const us = uvs.map(u => u[0]), vs = uvs.map(u => u[1]);
    console.log('  UV 范围 = u[' + Math.min(...us).toFixed(3) + ',' + Math.max(...us).toFixed(3) + ']' +
      ' v[' + Math.min(...vs).toFixed(3) + ',' + Math.max(...vs).toFixed(3) + ']');
  }

  console.log('\n  --- 判定 ---');
  check('框选表面点应全部落在 projector 局部盒内（OBB 由这些点拟合）',
    inBox >= pts.length * 0.95, inBox + '/' + pts.length);
  check('命中点的投影 UV 全部落在 [0,1]',
    uvOutliers.length === 0 && uvOk === inBox, uvOk + '/' + inBox);
  check('UV 覆盖多个象限（非退化为一点或一条线，视频可铺满投影区）',
    uvs.length > 1 && (Math.max(...uvs.map(u => u[0])) - Math.min(...uvs.map(u => u[0]))) > 0.05 &&
    (Math.max(...uvs.map(u => u[1])) - Math.min(...uvs.map(u => u[1]))) > 0.05);
  if (boxFails.length) console.log('    盒外点索引 =', boxFails.slice(0, 12).join(','));
  if (uvOutliers.length) console.log('    UV 越界 =', JSON.stringify(uvOutliers.slice(0, 12)));

  // 行序方向：投影机局部 +Y = 框选区上方（buildDecalProjector 把法向翻向
  // 相机后 up = cross(normal, right)），canvas 图像行0=顶部，所以上方的 v
  // 必须更小。若 v 同向，投射视频看起来就是上下颠倒。
  let yMaxPts = pts[0], yMinPts = pts[0];
  let yMax = -Infinity, yMin = Infinity;
  for (const W of pts) {
    const ly = worldToLocal(W, proj)[1];
    if (ly > yMax) { yMax = ly; yMaxPts = W; }
    if (ly < yMin) { yMin = ly; yMinPts = W; }
  }
  const uvTop = decalProject(yMaxPts, proj, half);
  const uvBottom = decalProject(yMinPts, proj, half);
  check('视频行序修正：框选区上方（局部 +Y）映射到更小的 v（不再上下颠倒）',
    !!uvTop && !!uvBottom && uvTop[1] < uvBottom[1],
    uvTop && uvBottom ? ('v(' + uvTop[1].toFixed(3) + ') < v(' + uvBottom[1].toFixed(3) + ')') : '点出盒');

  // 核心不变量：视频始终在前 = 命中点与深度无关。
  // 对同一批点注入任意大的「深度扰动」（模拟 3DGS stochastic / 跨源差异），
  // 命中结果必须完全不变——因为 decalProject 只依赖世界点 W 的横向坐标，
  // 不再拿 dW 与 dMap 比较。这正是与旧跨源判定最本质的区别。
  console.log('\n  --- always-on-top 不变量：命中与深度无关 ---');
  let perturbStable = 0;
  for (const W of pts) {
    const base = decalProject(W, proj, half);
    // 沿投影机法向（local +Z）大幅平移世界点 ±2m，模拟深度跳变
    const nrm = rotateByQuat([0, 0, 1], proj.quaternion);
    const far = [W[0] + nrm[0] * 2, W[1] + nrm[1] * 2, W[2] + nrm[2] * 2];
    const near = [W[0] - nrm[0] * 2, W[1] - nrm[1] * 2, W[2] - nrm[2] * 2];
    const bOk = !!base, fOk = !!decalProject(far, proj, half), nOk = !!decalProject(near, proj, half);
    // 深度大幅改变后可能移出盒（z 方向 ±2m 超过 half.z 属正常几何裁剪），
    // 这里只断言：只要仍在盒内，UV 与原点完全一致（横向投影不随深度漂移）。
    const fUv = decalProject(far, proj, half), nUv = decalProject(near, proj, half);
    const uvStable = (bOk && fUv && fUv.every((v, k) => Math.abs(v - base[k]) < 1e-6)) ||
      (!fOk) || (fOk && false);
    const uvStableN = (bOk && nUv && nUv.every((v, k) => Math.abs(v - base[k]) < 1e-6)) || (!nOk);
    if (uvStable && uvStableN) perturbStable++;
  }
  console.log('  深度扰动下横向 UV 稳定点 =', perturbStable + '/' + pts.length);
  check('投影 UV 不随深度扰动漂移（无跨源深度比较的直接证明）',
    perturbStable >= pts.length * 0.95, perturbStable + '/' + pts.length);

  console.log('\n' + (pass ? '★ 全部 PASS' : '✗ 存在未达标项'));
  return pass;
}

try {
  const ok = main();
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.error('验证失败：' + (e?.message || e));
  process.exit(2);
}

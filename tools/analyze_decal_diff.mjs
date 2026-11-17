/**
 * 贴花可见/隐藏两帧差分的空间分布分析
 * ----------------------------------------------------------------
 * 用途：区分三种失败形态，光看覆盖率数字是分不出来的：
 *   A. 椒盐点（孤立噪点）    → 覆盖率低 + 变化像素绝大多数为孤立点
 *   B. 整块缺失              → 覆盖率低 + 变化像素几乎为 0
 *   C. 部分覆盖（表面只占盒投影的一部分）→ 覆盖率低 + 变化像素成片、连通
 * 做法：把差分掩码降采样成 64×32 网格打印；同时统计「孤立点比例」
 * （8 邻域内无变化像素的变化像素占比）与「变化像素成片度」。
 *
 * 用法： node tools/analyze_decal_diff.mjs [--rect=x,y,w,h] [--thr=12]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng } from './png-decode.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => {
  const a = process.argv.find(x => x.startsWith(`--${k}=`));
  return a ? a.split('=').slice(1).join('=') : d;
};
const THR = Number(arg('thr', 12));
const rectArg = arg('rect', '');

const visible = decodePng(fs.readFileSync(path.join(ROOT, 'tools', 'probe-decal-pixel-visible.png')));
const hidden = decodePng(fs.readFileSync(path.join(ROOT, 'tools', 'probe-decal-pixel-hidden.png')));
const W = Math.min(visible.width, hidden.width);
const H = Math.min(visible.height, hidden.height);

let rx = 0, ry = 0, rw = W, rh = H;
if (rectArg) {
  const [x, y, w, h] = rectArg.split(',').map(Number);
  rx = Math.max(0, x); ry = Math.max(0, y);
  rw = Math.min(W - rx, w); rh = Math.min(H - ry, h);
}

const mask = new Uint8Array(rw * rh);
let changed = 0;
for (let y = 0; y < rh; y++) {
  for (let x = 0; x < rw; x++) {
    const i = ((y + ry) * W + (x + rx)) * 4;
    const d = Math.max(
      Math.abs(visible.data[i] - hidden.data[i]),
      Math.abs(visible.data[i + 1] - hidden.data[i + 1]),
      Math.abs(visible.data[i + 2] - hidden.data[i + 2]));
    if (d > THR) { mask[y * rw + x] = 1; changed++; }
  }
}

// 孤立点：8 邻域全为 0
let isolated = 0;
for (let y = 0; y < rh; y++) {
  for (let x = 0; x < rw; x++) {
    if (!mask[y * rw + x]) continue;
    let nb = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= rw || ny >= rh) continue;
      if (mask[ny * rw + nx]) nb++;
    }
    if (nb === 0) isolated++;
  }
}

// 成片度：变化像素中「行连续段」的占比 —— 段数越少说明越成片
let segs = 0, rowPixels = 0;
for (let y = 0; y < rh; y++) {
  let inSeg = false;
  for (let x = 0; x < rw; x++) {
    const v = mask[y * rw + x];
    if (v) rowPixels++;
    if (v && !inSeg) { segs++; inSeg = true; }
    else if (!v) inSeg = false;
  }
}

// 每行覆盖率剖面（看是不是整片均匀）
console.log(`矩形 = ${rw}x${rh}  面积 = ${rw * rh}`);
console.log(`变化像素 = ${changed}  覆盖率 = ${(changed / (rw * rh)).toFixed(4)}`);
console.log(`孤立点 = ${isolated} (占变化像素 ${(isolated / (changed || 1) * 100).toFixed(1)}%)`);
console.log(`行连续段数 = ${segs}  平均段长 = ${(rowPixels / (segs || 1)).toFixed(1)} px`);

// 变化像素自身的包围盒 —— 贴花实际占用的屏幕区域
let bx0 = rw, by0 = rh, bx1 = -1, by1 = -1;
for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
  if (!mask[y * rw + x]) continue;
  if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
  if (y < by0) by0 = y; if (y > by1) by1 = y;
}
const bw = bx1 >= bx0 ? bx1 - bx0 + 1 : 0;
const bh = by1 >= by0 ? by1 - by0 + 1 : 0;
const bboxArea = bw * bh;
// 包围盒内部的孔洞率：区分「成片实心」与「稀疏噪点」
let hole = 0;
for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) if (!mask[y * rw + x]) hole++;
console.log(`变化像素包围盒 = ${bw}x${bh}  面积 = ${bboxArea}`);
console.log(`① 框体填充率 = ${(changed / (rw * rh)).toFixed(4)}  (分母 = OBB 屏幕外接矩形)`);
console.log(`② 贴花实心率 = ${(changed / (bboxArea || 1)).toFixed(4)}  (分母 = 贴花自身包围盒)`);
console.log(`   包围盒内孔洞 = ${hole} px (${(hole / (bboxArea || 1) * 100).toFixed(1)}%)`);

console.log('\n--- 差分掩码 64x32 降采样（每格 = 命中比例）---');
const GW = 64, GH = 32;
const chars = ' .:-=+*#%@';
for (let gy = 0; gy < GH; gy++) {
  let line = '';
  for (let gx = 0; gx < GW; gx++) {
    const x0 = Math.floor(gx * rw / GW), x1 = Math.floor((gx + 1) * rw / GW);
    const y0 = Math.floor(gy * rh / GH), y1 = Math.floor((gy + 1) * rh / GH);
    let hit = 0, tot = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { tot++; if (mask[y * rw + x]) hit++; }
    const f = tot ? hit / tot : 0;
    line += chars[Math.min(9, Math.floor(f * 10))];
  }
  console.log(line);
}

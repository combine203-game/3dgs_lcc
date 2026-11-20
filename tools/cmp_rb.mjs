import fs from 'node:fs';
import { decodePng } from './png-decode.mjs';
const R = [0.55, 0.3, 0.72, 0.45];
const a = decodePng(fs.readFileSync('tools/rb-visible.png'));
const b = decodePng(fs.readFileSync('tools/rb-hidden.png'));
console.log('尺寸', a.width + 'x' + a.height, b.width + 'x' + b.height);
const sx = Math.round(R[0] * a.width), sy = Math.round(R[1] * a.height);
const sw = Math.round((R[2] - R[0]) * a.width), sh = Math.round((R[3] - R[1]) * a.height);
let changed = 0, sumAbs = 0, maxD = 0;
const TH = 12;
for (let y = sy; y < sy + sh; y++) for (let x = sx; x < sx + sw; x++) {
  const i = (y * a.width + x) * 4;
  const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
  sumAbs += d; if (d > maxD) maxD = d; if (d > TH) changed++;
}
const area = sw * sh;
console.log(`框选区 [${sx},${sy},${sw},${sh}] 面积=${area}`);
console.log(`显著变化像素(>${TH})=${changed} 覆盖率=${(changed / area).toFixed(4)}`);
console.log(`平均像素差=${(sumAbs / area).toFixed(2)} 最大差=${maxD}`);
// 全图变化范围（找贴花实际落在哪）
let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1, allChanged = 0;
for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
  const i = (y * a.width + x) * 4;
  const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
  if (d > TH) { allChanged++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
}
console.log(`全图显著变化=${allChanged} 包围盒=[${minX},${minY} ~ ${maxX},${maxY}]`);

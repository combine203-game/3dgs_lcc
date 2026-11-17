/**
 * PNG 解码器（最小实现，零依赖）
 * ----------------------------------------------------------------
 * 只支持 Chrome CDP 截图实际会产出的组合：8 位深、真彩色 / 带 alpha、
 * 非隔行。够用即可，不必覆盖 PNG 全谱。
 *
 * 解码流程：读 IHDR → 拼接 IDAT → zlib inflate → 逐行反滤波（None/Sub/Up/Average/Paeth）。
 */
import zlib from 'node:zlib';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * @param {Buffer} buf PNG 文件字节
 * @returns {{width:number, height:number, data:Buffer}} data 为 RGBA8
 */
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('不是合法 PNG');
  let off = 8;
  let ihdr = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    off += 12 + len;                       // 4(len) + 4(type) + len + 4(crc)
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12]
      };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  if (!ihdr) throw new Error('PNG 缺少 IHDR');
  if (ihdr.bitDepth !== 8) throw new Error('仅支持 8 位深 PNG，实际 ' + ihdr.bitDepth);
  if (ihdr.interlace !== 0) throw new Error('不支持隔行 PNG');
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ihdr.colorType];
  if (!channels) throw new Error('不支持的 colorType: ' + ihdr.colorType);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { width, height } = ihdr;
  const bpp = channels;                    // 8 位深下每像素字节数 = 通道数
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = (prev && x >= bpp) ? prev[x - bpp] : 0;
      let v = line[x];
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + b) & 0xff; break;
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: v = (v + paeth(a, b, c)) & 0xff; break;
        default: throw new Error('未知 PNG 行滤波: ' + filter);
      }
      cur[x] = v;
    }
  }
  // 统一成 RGBA8
  const rgba = Buffer.alloc(width * height * 4, 255);
  for (let i = 0, n = width * height; i < n; i++) {
    const s = i * bpp, d = i * 4;
    if (channels === 1) { rgba[d] = rgba[d + 1] = rgba[d + 2] = out[s]; rgba[d + 3] = 255; }
    else if (channels === 2) { rgba[d] = rgba[d + 1] = rgba[d + 2] = out[s]; rgba[d + 3] = out[s + 1]; }
    else if (channels === 3) { rgba[d] = out[s]; rgba[d + 1] = out[s + 1]; rgba[d + 2] = out[s + 2]; rgba[d + 3] = 255; }
    else { rgba[d] = out[s]; rgba[d + 1] = out[s + 1]; rgba[d + 2] = out[s + 2]; rgba[d + 3] = out[s + 3]; }
  }
  return { width, height, data: rgba };
}

/** 统计像素的主色相（度，0-360）。用 HSV 的 H 分量，众数分桶后取桶中心。 */
export function dominantHue(rgba, width, height, mask) {
  const bins = new Array(36).fill(0);          // 36 桶 × 10°
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (mask && !mask(x, y)) continue;
      const r = rgba[i] / 255, g = rgba[i + 1] / 255, b = rgba[i + 2] / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const d = max - min;
      if (d < 0.08) continue;                    // 近灰：无有效色相
      let h;
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
      bins[Math.min(35, Math.floor(h / 10))]++;
    }
  }
  let best = 0, bestN = -1;
  for (let i = 0; i < 36; i++) if (bins[i] > bestN) { bestN = bins[i]; best = i; }
  if (bestN <= 0) return null;
  return best * 10 + 5;
}

/** 两色相的最小夹角差（度，0-180） */
export function hueDelta(a, b) {
  if (a == null || b == null) return null;
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

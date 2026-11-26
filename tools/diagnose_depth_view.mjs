#!/usr/bin/env node
/* 实时深度图视口验收（WebGPU + WebGL2 双后端）
 * ---------------------------------------------------------------
 * 用户需求：深度图要「重新开一个视口渲染，不改变主窗口的渲染内容，
 * 且该视口大小可调、位置可移动」。
 *
 * 本脚本用真实 Viewer 页验证：
 *   1. 默认数据源是 lcc2 流式（__MG_SOURCE === 'lcc2'，有分块请求）；
 *   2. 顶栏「深度」按钮存在、可点开，状态与 __mgDepth.isOpen 同步；
 *   3. 打开后有真实深度快照（pickReady、pickSize 与画布一致、0 错误）且有视口矩形；
 *   4. 视口内确实画的是深度图（灰阶 / 品红、有层次、非全黑全白）；
 *   5. **视口之外的画面与打开前一致**（主窗口渲染内容不被改变）；
 *   6. 拖标题栏能移动视口、拖右下角能缩放视口，移动后新位置仍是深度图；
 *   7. 关闭后视口隐藏，原区域恢复到彩色画面；
 *   8. 键位回归：N 开关视口，而 WASD 的「右移」D 漫游时不会把视口关掉。
 * 两个后端都要过：深度纹理的行序 / UV 翻转在两个后端相反，只测一个不算覆盖。
 *
 * 结论行：深度图[webgpu+webgl2]: PASS / FAIL
 * 用法： node tools/diagnose_depth_view.mjs [--wait=45000] [--scene=floor3]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 18147;
const CDP_PORT = 9277;
const BASE = `http://127.0.0.1:${PORT}`;
const ARG = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : d;
};
const WAIT = Number(ARG('wait', '45000'));
const SCENE = ARG('scene', 'floor3');
const SPAWN = ARG('spawn', SCENE === 'floor3' ? 'floor3' : 'floor1');
const OUT = path.join(ROOT, 'tools', 'shots');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)],
  { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'depthview_' + Date.now());
fs.mkdirSync(profile, { recursive: true });
const br = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader',
  '--window-size=1280,800', 'about:blank'
], { stdio: 'ignore' });

function cleanup() {
  try { br.kill(); } catch { /* noop */ }
  try { srv.kill(); } catch { /* noop */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* noop */ }
}

/* 最小 PNG 解码：8bit RGB/RGBA、非隔行（CDP 截图就这两种） */
function decodePng(buf) {
  let pos = 8; let w = 0, h = 0, bd = 0, ct = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(w * h * bpp);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const cur = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      if (ft === 1) cur[x] = (cur[x] + a) & 255;
      else if (ft === 2) cur[x] = (cur[x] + b) & 255;
      else if (ft === 3) cur[x] = (cur[x] + ((a + b) >> 1)) & 255;
      else if (ft === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        cur[x] = (cur[x] + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c))) & 255;
      }
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { w, h, bpp, data: out, bitDepth: bd };
}

/* 只统计三维画面区域：顶栏、左下小地图、右下深度图例、右上说明都是彩色 UI，
   整幅一起算会把「深度图是否灰阶」误判成失败。 */
const CROP = { x0: 0.12, x1: 0.88, y0: 0.13, y1: 0.80 };

/** 画面统计：亮度均值 / 标准差 / 品红占比 / 灰度像素占比 */
function imgStats(buf) {
  const img = decodePng(buf);
  let s = 0, s2 = 0, magenta = 0, gray = 0, n = 0;
  const x0 = Math.floor(img.w * CROP.x0), x1 = Math.floor(img.w * CROP.x1);
  const y0 = Math.floor(img.h * CROP.y0), y1 = Math.floor(img.h * CROP.y1);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = (y * img.w + x) * img.bpp;
      const r = img.data[p], g = img.data[p + 1], b = img.data[p + 2];
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      s += l; s2 += l * l; n++;
      if (r > 150 && g < 90 && b > 90) magenta++;              // 品红 = 无表面
      if (Math.max(r, g, b) - Math.min(r, g, b) <= 6) gray++;  // 近灰阶
    }
  }
  const mean = s / n;
  return {
    w: img.w, h: img.h,
    mean: +mean.toFixed(2),
    sd: +Math.sqrt(Math.max(0, s2 / n - mean * mean)).toFixed(2),
    magentaPct: +(100 * magenta / n).toFixed(2),
    grayPct: +(100 * gray / n).toFixed(2)
  };
}

/** 两张同尺寸图的平均亮度差（百分比） */
function diffPct(a, b) {
  const A = decodePng(a), B = decodePng(b);
  if (A.w !== B.w || A.h !== B.h) return null;
  let s = 0, n = 0;
  const x0 = Math.floor(A.w * CROP.x0), x1 = Math.floor(A.w * CROP.x1);
  const y0 = Math.floor(A.h * CROP.y0), y1 = Math.floor(A.h * CROP.y1);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = (y * A.w + x) * A.bpp;
      const la = 0.2126 * A.data[p] + 0.7152 * A.data[p + 1] + 0.0722 * A.data[p + 2];
      const lb = 0.2126 * B.data[p] + 0.7152 * B.data[p + 1] + 0.0722 * B.data[p + 2];
      s += Math.abs(la - lb); n++;
    }
  }
  return +(100 * s / n / 255).toFixed(2);
}

/* ------------------------------ 视口矩形相关的像素统计
   rect = { x, y, w, h }，页面 CSS 像素（deviceScaleFactor=1，截图同坐标）。
   统计分「视口内」和「视口外」两套：视口外必须保持彩色且与基线逐像素一致，
   这就是「不改变主窗口渲染内容」的硬指标。 */

function clampRect(img, rect) {
  return {
    x0: Math.max(0, Math.floor(rect.x)),
    y0: Math.max(0, Math.floor(rect.y)),
    x1: Math.min(img.w, Math.ceil(rect.x + rect.w)),
    y1: Math.min(img.h, Math.ceil(rect.y + rect.h))
  };
}

/** 视口内的统计：亮度均值 / 标准差 / 品红占比 / 灰阶占比 */
function rectStats(buf, rect) {
  const img = decodePng(buf);
  const r = clampRect(img, rect);
  let s = 0, s2 = 0, magenta = 0, gray = 0, n = 0;
  for (let y = r.y0; y < r.y1; y++) {
    for (let x = r.x0; x < r.x1; x++) {
      const p = (y * img.w + x) * img.bpp;
      const R = img.data[p], G = img.data[p + 1], B = img.data[p + 2];
      const l = 0.2126 * R + 0.7152 * G + 0.0722 * B;
      s += l; s2 += l * l; n++;
      if (R > 150 && G < 90 && B > 90) magenta++;
      if (Math.max(R, G, B) - Math.min(R, G, B) <= 6) gray++;
    }
  }
  if (!n) return { mean: 0, sd: 0, magentaPct: 0, grayPct: 0, n: 0 };
  const mean = s / n;
  return {
    mean: +mean.toFixed(2),
    sd: +Math.sqrt(Math.max(0, s2 / n - mean * mean)).toFixed(2),
    magentaPct: +(100 * magenta / n).toFixed(2),
    grayPct: +(100 * gray / n).toFixed(2),
    n
  };
}

/** 视口外（3D 画面裁切区内、去掉视口矩形）的统计 */
function outsideStats(buf, rect) {
  const img = decodePng(buf);
  const r = clampRect(img, rect);
  let s = 0, n = 0, gray = 0, sat = 0;
  const x0 = Math.floor(img.w * CROP.x0), x1 = Math.floor(img.w * CROP.x1);
  const y0 = Math.floor(img.h * CROP.y0), y1 = Math.floor(img.h * CROP.y1);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1) continue;
      const p = (y * img.w + x) * img.bpp;
      const R = img.data[p], G = img.data[p + 1], B = img.data[p + 2];
      s += 0.2126 * R + 0.7152 * G + 0.0722 * B; n++;
      sat += Math.max(R, G, B) - Math.min(R, G, B);
      if (Math.max(R, G, B) - Math.min(R, G, B) <= 6) gray++;
    }
  }
  if (!n) return { mean: 0, grayPct: 0, sat: 0, n: 0 };
  return {
    mean: +(s / n).toFixed(2),
    grayPct: +(100 * gray / n).toFixed(1),
    sat: +(sat / n).toFixed(2),
    n
  };
}

/** 视口外的平均亮度差（%）：主画面有没有被改动 */
function diffOutside(a, b, rect) {
  const A = decodePng(a), B = decodePng(b);
  if (A.w !== B.w || A.h !== B.h) return null;
  const r = clampRect(A, rect);
  let s = 0, n = 0;
  const x0 = Math.floor(A.w * CROP.x0), x1 = Math.floor(A.w * CROP.x1);
  const y0 = Math.floor(A.h * CROP.y0), y1 = Math.floor(A.h * CROP.y1);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1) continue;
      const p = (y * A.w + x) * A.bpp;
      const la = 0.2126 * A.data[p] + 0.7152 * A.data[p + 1] + 0.0722 * A.data[p + 2];
      const lb = 0.2126 * B.data[p] + 0.7152 * B.data[p + 1] + 0.0722 * B.data[p + 2];
      s += Math.abs(la - lb); n++;
    }
  }
  return n ? +(100 * s / n / 255).toFixed(2) : null;
}

/** 视口内的平均亮度差（%）：这块区域是否已经从彩色变成深度图 */
function diffInRect(a, b, rect) {
  const A = decodePng(a), B = decodePng(b);
  if (A.w !== B.w || A.h !== B.h) return null;
  const r = clampRect(A, rect);
  let s = 0, n = 0;
  for (let y = r.y0; y < r.y1; y++) {
    for (let x = r.x0; x < r.x1; x++) {
      const p = (y * A.w + x) * A.bpp;
      const la = 0.2126 * A.data[p] + 0.7152 * A.data[p + 1] + 0.0722 * A.data[p + 2];
      const lb = 0.2126 * B.data[p] + 0.7152 * B.data[p + 1] + 0.0722 * B.data[p + 2];
      s += Math.abs(la - lb); n++;
    }
  }
  return n ? +(100 * s / n / 255).toFixed(2) : null;
}

/** 用真实鼠标事件拖拽（pointerdown/move/up 由 Chrome 合成） */
async function dragMouse(from, to, steps = 10) {
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1
  });
  for (let i = 1; i <= steps; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: from.x + (to.x - from.x) * i / steps,
      y: from.y + (to.y - from.y) * i / steps,
      button: 'left', buttons: 1
    });
    await sleep(35);
  }
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1
  });
  await sleep(150);
}

/* 顶栏 / 标题栏 / 手柄在页面上的 CSS 矩形 */
async function uiRect(id) {
  const r = await E(`(()=>{const e=document.getElementById(${JSON.stringify(id)});
    if(!e) return null;
    const b=e.getBoundingClientRect();
    return {x:b.left,y:b.top,w:b.width,h:b.height};})()`);
  return r && typeof r.x === 'number' ? r : null;
}

let ws, seq = 0;
const pend = new Map();
const pageErrors = [];
const send = (method, params = {}) => new Promise((res) => {
  const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params }));
});
async function E(expression, timeoutMs = 90000) {
  try {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
      sleep(timeoutMs).then(() => ({ timeout: true }))
    ]);
    if (r.timeout) return { __timeout: true };
    if (r.result?.exceptionDetails) {
      return { __err: String(r.result.exceptionDetails.exception?.description
        || r.result.exceptionDetails.text || '').slice(0, 300) };
    }
    return r.result?.result?.value;
  } catch (err) { return { __err: String(err) }; }
}

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: !!ok, detail: detail === undefined ? null : detail });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail)));
};

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(r.result.data, 'base64');
  fs.writeFileSync(path.join(OUT, name + '.png'), buf);
  return buf;
}

async function runBackend(kind) {
  console.log(`\n[${kind}] ${SCENE}/${SPAWN}`);
  const url = `${BASE}/gs-viewer.html?scene=${SCENE}&spawn=${SPAWN}&renderer=${kind}`;
  await send('Page.navigate', { url });
  const t0 = Date.now();
  let st = null;
  while (Date.now() - t0 < WAIT) {
    await sleep(1000);
    st = await E(`(()=>{const v=window.__viewer;
      return {ready:!!v?.state?.loaded, source:window.__MG_SOURCE,
        backend:document.getElementById('mg-gpu')?.textContent||'',
        chunks:window.__mgStream?.state?.()?.chunkRequested ?? null,
        depth: !!window.__mgDepth, supported: !!window.__mgDepth?.supported};})()`);
    if (st?.ready) break;
  }
  check('页面加载完成', !!st?.ready, st && { source: st.source, chunks: st.chunks });
  check('默认数据源 = lcc2 流式', st?.source === 'lcc2', st && st.source);
  check('后端符合预期', kind === 'webgl'
    ? /WebGL/.test(st?.backend || '') : /WebGPU/.test(st?.backend || ''), st && st.backend);
  check('深度模块已挂载且可用', !!(st?.depth && st?.supported), st && { supported: st?.supported });

  // 彩色基线（打开视口之前的正常画面）
  await sleep(1200);
  const baseShot = await shot(`depth_view_${kind}_color`);
  const base = imgStats(baseShot);

  // 点顶栏按钮打开深度视口
  const clicked = await E(`(()=>{const b=document.getElementById('mg-depth');
    if(!b) return {__err:'no button'};
    b.click();
    return {isOpen:!!window.__mgDepth?.isOpen,
      text:document.getElementById('mg-depth-state')?.textContent};})()`);
  check('顶栏「深度」按钮可点开', clicked && clicked.isOpen === true, clicked);

  // 等第一张深度快照（headless 下 pick pass 可能 1-3 s）
  let ds = null;
  for (let i = 0; i < 25; i++) {
    await sleep(900);
    ds = await E(`window.__mgDepth?.state?.() || null`);
    if (ds && ds.pickReady && ds.renders > 0) break;
  }
  check('深度快照已就绪', !!(ds && ds.pickReady), ds && {
    picks: ds.picks, renders: ds.renders, pickSize: ds.pickSize
  });
  check('叠加层已提交绘制', !!(ds && ds.renders > 0), ds && { renders: ds.renders });
  check('无 GPU / 采样错误', !!(ds && ds.errors === 0), ds && {
    errors: ds.errors, lastError: ds.lastError
  });

  // 视口矩形：后续所有像素统计都按这块矩形分开算
  const vp = await E(`window.__mgDepth?.viewport?.() || null`);
  check('深度视口已建立且面积合理', !!(vp && vp.w > 200 && vp.h > 120), vp);
  if (!vp) return { kind, error: 'no viewport rect' };

  await sleep(1500);
  const depthShot = await shot(`depth_view_${kind}_depth`);
  const depIn = rectStats(depthShot, vp);
  const depOut = outsideStats(depthShot, vp);
  const inDiff = diffInRect(baseShot, depthShot, vp);
  const outDiff = diffOutside(baseShot, depthShot, vp);

  check('视口内已换成深度图（灰阶 / 品红为主）', depIn.grayPct + depIn.magentaPct > 80, depIn);
  check('视口内深度有层次（非全黑全白）', depIn.sd > 8 && depIn.mean > 6 && depIn.mean < 250,
    { mean: depIn.mean, sd: depIn.sd });
  check('视口内无表面像素占比合理（非整块无深度）', depIn.magentaPct < 90,
    { magentaPct: depIn.magentaPct });
  check('视口内确实变了（与彩色基线差 > 5%）', inDiff !== null && inDiff > 5, { diffIn: inDiff });
  /* 「不改变主窗口渲染内容」的硬指标：视口外的像素与打开前几乎逐点一致。
     机位漂移 / 流式补块会带来 0.1%~3% 的正常差异，超出 6% 只可能是主画面
     被深度图覆盖（那会是 20% 以上）。 */
  check('视口外主画面未被改动（与基线差 < 6%）', outDiff !== null && outDiff < 6,
    { diffOutside: outDiff });
  check('视口外仍是彩色画面', depOut.grayPct < 65, depOut);

  /* -------------------------------------------------- 拖动移动 ------------------
     落点必须避开不透明 HUD（特别是左下角小地图）：深度是在画布上画的，
     任何不透明的 DOM 面板都会把它盖住 —— 那是分层设计的必然结果，不是
     「深度没渲染」。这里往上拖到空白区，只验证「换位置后仍然出图」。 */
  const hd = await uiRect('mg-depth-drag');
  if (hd) {
    await dragMouse(
      { x: hd.x + hd.w * 0.35, y: hd.y + hd.h / 2 },
      { x: hd.x + hd.w * 0.35 - 220, y: hd.y + hd.h / 2 - 300 }
    );
  }
  const vpMoved = await E(`window.__mgDepth?.viewport?.() || null`);
  check('拖动标题栏可移动视口',
    !!(hd && vpMoved && Math.abs(vpMoved.x - vp.x) > 60 && Math.abs(vpMoved.y - vp.y) > 40),
    { before: [Math.round(vp.x), Math.round(vp.y)], after: vpMoved && [Math.round(vpMoved.x), Math.round(vpMoved.y)] });

  await sleep(1200);
  const movedShot = await shot(`depth_view_${kind}_moved`);
  const depMoved = rectStats(movedShot, vpMoved || vp);
  check('移动后新位置仍渲染深度图', depMoved.grayPct + depMoved.magentaPct > 80, depMoved);

  /* -------------------------------------------------- 拖动缩放 ------------------ */
  const gp = await uiRect('mg-depth-grip');
  if (gp) {
    await dragMouse(
      { x: gp.x + gp.w / 2, y: gp.y + gp.h / 2 },
      { x: gp.x + gp.w / 2 - 130, y: gp.y + gp.h / 2 - 90 }
    );
  }
  const vpResized = await E(`window.__mgDepth?.viewport?.() || null`);
  check('拖动右下角可缩放视口',
    !!(gp && vpResized && vpMoved && vpResized.w < vpMoved.w - 40 && vpResized.h < vpMoved.h - 30),
    { before: vpMoved && [Math.round(vpMoved.w), Math.round(vpMoved.h)],
      after: vpResized && [Math.round(vpResized.w), Math.round(vpResized.h)] });

  await sleep(1200);
  const smallShot = await shot(`depth_view_${kind}_resized`);
  const depSmall = rectStats(smallShot, vpResized || vpMoved || vp);
  check('缩放后视口内仍是深度图', depSmall.grayPct + depSmall.magentaPct > 80, depSmall);

  /* -------------------------------------------------- 关闭 ---------------------- */
  const closed = await E(`(()=>{window.__mgDepth?.close();
    return {open:!!window.__mgDepth?.isOpen,
      hidden:document.getElementById('mg-depthbox').hidden};})()`);
  check('关闭后视口隐藏', !!(closed && closed.open === false && closed.hidden === true), closed);
  await sleep(1500);
  const backShot = await shot(`depth_view_${kind}_back`);
  const back = imgStats(backShot);
  const backIn = rectStats(backShot, vpResized || vpMoved || vp);
  check('关闭后原视口区域恢复彩色', backIn.grayPct < 70,
    { grayPct: backIn.grayPct, mean: backIn.mean, depthGray: depSmall.grayPct });

  /* -------------------------------------------------- 键位回归 ------------------
     D 是 WASD 的「右移」。曾经把深度视口开关绑在 D 上，结果一按 D 漫游就把视口
     关掉 —— 用户看到的现象正是「键盘漫游时深度视口消失」。这里把两条都锁死。 */
  const keyN = { windowsVirtualKeyCode: 78, nativeVirtualKeyCode: 78, code: 'KeyN', key: 'n' };
  const keyD = { windowsVirtualKeyCode: 68, nativeVirtualKeyCode: 68, code: 'KeyD', key: 'd' };
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...keyN, text: 'n', unmodifiedText: 'n' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...keyN });
  await sleep(700);
  const keyOpen = await E(`!!window.__mgDepth?.isOpen`);
  check('N 键可打开深度视口', keyOpen === true, { open: keyOpen });

  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...keyD, text: 'd', unmodifiedText: 'd' });
  await sleep(1400);
  const duringD = await E(`!!window.__mgDepth?.isOpen`);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...keyD });
  check('按住 D 漫游不会关掉深度视口', duringD === true, { open: duringD });

  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...keyN, text: 'n', unmodifiedText: 'n' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...keyN });
  await sleep(700);
  const keyClosed = await E(`(()=>({open:!!window.__mgDepth?.isOpen,
    hidden:document.getElementById('mg-depthbox').hidden}))()`);
  check('N 键再按一次可关闭深度视口',
    !!(keyClosed && keyClosed.open === false && keyClosed.hidden === true), keyClosed);

  return {
    kind, state: ds, base, vp, depIn, depOut, inDiff, outDiff,
    vpMoved, vpResized, depMoved, depSmall, back, backIn
  };
}

async function main() {
  for (let i = 0; i < 80; i++) { try { await fetch(BASE + '/'); break; } catch { await sleep(250); } }
  let page = null;
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      page = list.find((t) => t.type === 'page');
      if (page) break;
    } catch { /* retry */ }
    await sleep(300);
  }
  if (!page) throw new Error('CDP 不可达');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => {
    const o = JSON.parse(e.data);
    if (o.id && pend.has(o.id)) { pend.get(o.id)(o); pend.delete(o.id); return; }
    if (o.method === 'Runtime.exceptionThrown') {
      pageErrors.push(o.params.exceptionDetails?.exception?.description
        || o.params.exceptionDetails?.text || '');
    } else if (o.method === 'Runtime.consoleAPICalled' && o.params.type === 'error') {
      pageErrors.push((o.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
    }
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride',
    { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

  const results = [];
  for (const kind of ['webgpu', 'webgl']) {
    try { results.push(await runBackend(kind)); }
    catch (err) { check(`[${kind}] 运行异常`, false, String(err && err.message || err)); }
  }

  const fails = checks.filter((c) => !c.ok);
  console.log('\n  pageerrors: ' + (pageErrors.length ? pageErrors.slice(0, 3).join(' | ') : '0'));
  console.log(`\n深度图[webgpu+webgl2]: ${fails.length ? 'FAIL' : 'PASS'}  `
    + `(${checks.length - fails.length}/${checks.length})`);
  if (fails.length) for (const f of fails) console.log('   FAIL: ' + f.name);
  fs.writeFileSync(path.join(OUT, 'depth_view_report.json'),
    JSON.stringify({ at: new Date().toISOString(), checks, results, pageErrors }, null, 2));
  return fails.length ? 1 : 0;
}

main()
  .then((code) => { cleanup(); process.exitCode = code; })
  .catch((err) => { console.error('诊断失败：', err); cleanup(); process.exitCode = 1; });

#!/usr/bin/env node
/* 碰撞 Mesh 深度视口验收（与 3DGS 深度并排对比）
 * ---------------------------------------------------------------
 * 用户需求：「再增加一个 mesh 碰撞体的深度图视口，用于和 3dgs 的深度图对比」。
 *
 * 实现要点（本脚本要守住的东西）：
 *   1. 碰撞 mesh 的深度走 **CPU 光栅化**（web/mesh-depth-raster.js）：主相机这一帧的
 *      proj×view + 碰撞三角 → z-buffer → 16 bit 打包进 RGBA8（A=0 表示空洞）。
 *      不用引擎离屏通道：自建 Layer + 自建相机在这个构建里只清屏不提交 draw；
 *      也不采样深度缓冲：WebGPU 不允许把 depth32float 绑成 texture_2d<f32>；
 *   2. 相机是主相机的透视视角（同机位 / 同 near/far / 同一条深度归一化），否则
 *      没法和 3DGS 深度对齐；
 *   3. 两个视口互相独立：各自的矩形里出各自的深度图，矩形外的主画面一个像素不动；
 *   4. 交互与 3DGS 视口一致：拖标题移动、拖右下角缩放。
 *
 * 校验项：
 *   · 两个视口都能开、都有面积；
 *   · 碰撞几何已转换（tris > 0）、CPU 光栅化已出图（rasterMs > 0）、0 GPU 错误；
 *   · 两个视口内都是「近灰阶 + 有层次」的深度图（sat 低、sd 高）；
 *   · 两个视口之外的主画面仍是彩色、且与打开前的基线一致（< 8%）；
 *   · 独立性：关掉 Mesh 视口，3DGS 视口的内容不变（差 < 4%），原 Mesh 区域回到彩色；
 *   · 拖动 Mesh 视口后新位置仍出图；拖右下角能缩小。
 *
 * 结论行：碰撞Mesh深度[webgpu+webgl2]: PASS / FAIL
 * 用法： node tools/diagnose_mesh_depth.mjs [--wait=45000] [--backend=webgpu]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 18159;
const CDP_PORT = 9289;
const BASE = `http://127.0.0.1:${PORT}`;
const ARG = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : d;
};
const WAIT = Number(ARG('wait', '45000'));
const ONLY = ARG('backend', 'both');
const SCENE = ARG('scene', 'floor3');
const SPAWN = ARG('spawn', SCENE === 'floor3' ? 'floor3' : 'floor1');
const OUT = path.join(ROOT, 'tools', 'shots');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)],
  { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'meshdepth_' + Date.now());
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

function decodePng(buf) {
  let pos = 8; let w = 0, h = 0, ct = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; }
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
  return { w, h, bpp, data: out };
}

/* 只统计三维画面区域：顶栏、左下小地图、各面板都是彩色 UI */
const CROP = { x0: 0.12, x1: 0.88, y0: 0.13, y1: 0.80 };

function clampRect(img, r) {
  return {
    x0: Math.max(0, Math.floor(r.x)), y0: Math.max(0, Math.floor(r.y)),
    x1: Math.min(img.w, Math.ceil(r.x + r.w)), y1: Math.min(img.h, Math.ceil(r.y + r.h))
  };
}
const inRects = (rects, x, y) => rects.some((r) =>
  x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);

/** 视口内统计：mean / sd / grayPct / sat */
function rectStats(buf, rect) {
  const img = decodePng(buf);
  const r = clampRect(img, rect);
  let s = 0, s2 = 0, gray = 0, sat = 0, n = 0;
  for (let y = r.y0; y < r.y1; y++) {
    for (let x = r.x0; x < r.x1; x++) {
      const p = (y * img.w + x) * img.bpp;
      const R = img.data[p], G = img.data[p + 1], B = img.data[p + 2];
      const l = 0.2126 * R + 0.7152 * G + 0.0722 * B;
      s += l; s2 += l * l; n++;
      sat += Math.max(R, G, B) - Math.min(R, G, B);
      if (Math.max(R, G, B) - Math.min(R, G, B) <= 6) gray++;
    }
  }
  if (!n) return { mean: 0, sd: 0, grayPct: 0, sat: 0, n: 0 };
  const mean = s / n;
  return {
    mean: +mean.toFixed(2), sd: +Math.sqrt(Math.max(0, s2 / n - mean * mean)).toFixed(2),
    grayPct: +(100 * gray / n).toFixed(1), sat: +(sat / n).toFixed(2), n
  };
}

/** 视口外（裁切区内、去掉所有视口矩形）的统计 */
function outsideStats(buf, rects) {
  const img = decodePng(buf);
  let s = 0, gray = 0, sat = 0, n = 0;
  const x0 = Math.floor(img.w * CROP.x0), x1 = Math.floor(img.w * CROP.x1);
  const y0 = Math.floor(img.h * CROP.y0), y1 = Math.floor(img.h * CROP.y1);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (inRects(rects, x, y)) continue;
      const p = (y * img.w + x) * img.bpp;
      const R = img.data[p], G = img.data[p + 1], B = img.data[p + 2];
      s += 0.2126 * R + 0.7152 * G + 0.0722 * B; n++;
      sat += Math.max(R, G, B) - Math.min(R, G, B);
      if (Math.max(R, G, B) - Math.min(R, G, B) <= 6) gray++;
    }
  }
  if (!n) return { mean: 0, grayPct: 0, sat: 0, n: 0 };
  return {
    mean: +(s / n).toFixed(2), grayPct: +(100 * gray / n).toFixed(1),
    sat: +(sat / n).toFixed(2), n
  };
}

function diffOutside(a, b, rects) {
  const A = decodePng(a), B = decodePng(b);
  if (A.w !== B.w || A.h !== B.h) return null;
  let s = 0, n = 0;
  const x0 = Math.floor(A.w * CROP.x0), x1 = Math.floor(A.w * CROP.x1);
  const y0 = Math.floor(A.h * CROP.y0), y1 = Math.floor(A.h * CROP.y1);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (inRects(rects, x, y)) continue;
      const p = (y * A.w + x) * A.bpp;
      const la = 0.2126 * A.data[p] + 0.7152 * A.data[p + 1] + 0.0722 * A.data[p + 2];
      const lb = 0.2126 * B.data[p] + 0.7152 * B.data[p + 1] + 0.0722 * B.data[p + 2];
      s += Math.abs(la - lb); n++;
    }
  }
  return n ? +(100 * s / n / 255).toFixed(2) : null;
}

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

let ws, seq = 0;
const pend = new Map();
const pageErrors = [];
const pageWarns = [];
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
async function uiRect(id) {
  const r = await E(`(()=>{const e=document.getElementById(${JSON.stringify(id)});
    if(!e) return null;
    const b=e.getBoundingClientRect();
    return {x:b.left,y:b.top,w:b.width,h:b.height};})()`);
  return r && typeof r.x === 'number' ? r : null;
}
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

async function runBackend(kind) {
  console.log(`\n[${kind}] ${SCENE}/${SPAWN}`);
  await send('Page.navigate', {
    url: `${BASE}/gs-viewer.html?scene=${SCENE}&spawn=${SPAWN}&renderer=${kind}`
  });
  const t0 = Date.now();
  let st = null;
  while (Date.now() - t0 < WAIT) {
    await sleep(1000);
    st = await E(`(()=>({ready:!!window.__viewer?.state?.loaded,
      backend:document.getElementById('mg-gpu')?.textContent||'',
      gs:!!window.__mgDepth, mesh:!!window.__mgMeshDepth,
      meshSupported:!!window.__mgMeshDepth?.supported,
      tris:window.__viewer?.collision?.()?.triangles?.count ?? null}))()`);
    if (st?.ready) break;
  }
  check('页面加载完成', !!st?.ready, { backend: st?.backend, collisionTris: st?.tris });
  check('两个深度视口模块均已挂载', !!(st?.gs && st?.mesh),
    { gs: st?.gs, mesh: st?.mesh });
  check('碰撞 Mesh 视口后端支持', !!st?.meshSupported, { supported: st?.meshSupported });
  check('后端符合预期', kind === 'webgl'
    ? /WebGL/.test(st?.backend || '') : /WebGPU/.test(st?.backend || ''), st && st.backend);

  // 彩色基线（两个视口都还没开）
  await sleep(1500);
  const baseShot = await shot(`mesh_depth_${kind}_color`);

  // 开 3DGS 视口
  await E(`document.getElementById('mg-depth')?.click(); 1`);
  // 开碰撞 Mesh 视口（按钮会顺带把 3DGS 视口也打开）
  await E(`document.getElementById('mg-mesh')?.click(); 1`);

  let sa = null, sb = null;
  for (let i = 0; i < 30; i++) {
    await sleep(900);
    sa = await E(`window.__mgDepth?.state?.() || null`);
    sb = await E(`window.__mgMeshDepth?.state?.() || null`);
    if (sa && sb && sa.pickReady && sb.pickReady && sb.meshReady
        && sa.renders > 0 && sb.renders > 0) break;
  }
  check('3DGS 视口已就绪', !!(sa && sa.open && sa.pickReady), sa && {
    open: sa.open, picks: sa.picks, renders: sa.renders, tex: sa.pickSize
  });
  check('碰撞 Mesh 视口已就绪', !!(sb && sb.open && sb.pickReady && sb.meshReady), sb && {
    open: sb.open, picks: sb.picks, renders: sb.renders, tex: sb.pickSize,
    tris: sb.tris, errors: sb.errors
  });
  check('碰撞几何已转换（三角形数 > 0）', !!(sb && sb.tris > 0), sb && { tris: sb.tris });
  const diag = await E(`(()=>({
    stat: document.getElementById('mg-mesh-stat')?.textContent || '',
    vpFactory: typeof window.__mgDepthAdapter?.getCameraViewProjection,
    texFactory: typeof window.__mgDepthAdapter?.createDataTexture,
    texHandle: !!window.__mgMeshDepthTex,
    rasterSize: window.__mgMeshDepth?.state?.()?.rasterSize || null,
    rasterMs: window.__mgMeshDepth?.state?.()?.rasterMs ?? null,
    collisionTris: window.__viewer?.collision?.()?.triangles?.count ?? null
  }))()`);
  check('碰撞深度走 CPU 光栅化（ViewProj + 数据纹理）',
    !!(diag && diag.vpFactory === 'function' && diag.texFactory === 'function'
      && diag.texHandle && diag.rasterMs > 0), diag);
  check('无 GPU / 采样错误', !!(sa && sb && sa.errors === 0 && sb.errors === 0),
    { gsErrors: sa?.errors, meshErrors: sb?.errors, last: sb?.lastError });

  const vpA = await E(`window.__mgDepth?.viewport?.() || null`);
  const vpB = await E(`window.__mgMeshDepth?.viewport?.() || null`);
  check('两个视口都有面积且不重叠',
    !!(vpA && vpB && vpA.w > 150 && vpB.w > 150 &&
      (vpA.x + vpA.w <= vpB.x + 2 || vpB.x + vpB.w <= vpA.x + 2)),
    { gs: vpA && [Math.round(vpA.x), Math.round(vpA.y), Math.round(vpA.w), Math.round(vpA.h)],
      mesh: vpB && [Math.round(vpB.x), Math.round(vpB.y), Math.round(vpB.w), Math.round(vpB.h)] });

  await sleep(1500);
  const bothShot = await shot(`mesh_depth_${kind}_both`);
  const inA = vpA ? rectStats(bothShot, vpA) : null;
  const inB = vpB ? rectStats(bothShot, vpB) : null;
  const outBoth = outsideStats(bothShot, [vpA, vpB].filter(Boolean));
  const outDiff = diffOutside(baseShot, bothShot, [vpA, vpB].filter(Boolean));

  check('3DGS 视口内是深度图（近灰阶、有层次）',
    !!(inA && inA.sat < 6 && inA.grayPct > 70 && inA.sd > 8), inA);
  check('碰撞 Mesh 视口内是深度图（近灰阶、有层次）',
    !!(inB && inB.sat < 6 && inB.grayPct > 70 && inB.sd > 8), inB);
  check('两个视口之外的画面仍是彩色', !!(outBoth && outBoth.grayPct < 65 && outBoth.sat > 4), outBoth);
  check('两个视口之外未被改动（与基线差 < 8%）', outDiff !== null && outDiff < 8,
    { diffOutside: outDiff });

  /* -------------------------------------------------- 独立性 -------------------- */
  await E(`window.__mgMeshDepth?.close(); 1`);
  await sleep(1500);
  const onlyGs = await shot(`mesh_depth_${kind}_onlygs`);
  const gsDelta = vpA ? diffInRect(onlyGs, bothShot, vpA) : null;
  const meshAreaNow = vpB ? rectStats(onlyGs, vpB) : null;
  check('关掉 Mesh 视口不影响 3DGS 视口内容（差 < 4%）',
    gsDelta !== null && gsDelta < 4, { diff: gsDelta });
  check('Mesh 视口区域回到彩色画面',
    !!(meshAreaNow && meshAreaNow.grayPct < 70), meshAreaNow);

  /* -------------------------------------------------- 交互 ---------------------- */
  await E(`window.__mgMeshDepth?.open(); 1`);
  await sleep(1200);
  const hd = await uiRect('mg-mesh-drag');
  if (hd) {
    await dragMouse(
      { x: hd.x + hd.w * 0.3, y: hd.y + hd.h / 2 },
      { x: hd.x + hd.w * 0.3 - 200, y: hd.y + hd.h / 2 - 120 }
    );
  }
  const vpMoved = await E(`window.__mgMeshDepth?.viewport?.() || null`);
  check('拖标题栏可移动 Mesh 视口',
    !!(hd && vpMoved && vpB && Math.abs(vpMoved.x - vpB.x) > 60 && Math.abs(vpMoved.y - vpB.y) > 40),
    { before: vpB && [Math.round(vpB.x), Math.round(vpB.y)],
      after: vpMoved && [Math.round(vpMoved.x), Math.round(vpMoved.y)] });

  await sleep(1300);
  const movedShot = await shot(`mesh_depth_${kind}_moved`);
  const movedStats = rectStats(movedShot, vpMoved || vpB);
  check('移动后新位置仍渲染碰撞深度', movedStats.sat < 6 && movedStats.grayPct > 70, movedStats);

  const gp = await uiRect('mg-mesh-grip');
  if (gp) {
    await dragMouse(
      { x: gp.x + gp.w / 2, y: gp.y + gp.h / 2 },
      { x: gp.x + gp.w / 2 - 120, y: gp.y + gp.h / 2 - 80 }
    );
  }
  const vpSized = await E(`window.__mgMeshDepth?.viewport?.() || null`);
  check('拖右下角可缩放 Mesh 视口',
    !!(gp && vpSized && vpMoved && vpSized.w < vpMoved.w - 40 && vpSized.h < vpMoved.h - 30),
    { before: vpMoved && [Math.round(vpMoved.w), Math.round(vpMoved.h)],
      after: vpSized && [Math.round(vpSized.w), Math.round(vpSized.h)] });

  /* -------------------------------------------------- 收尾 ---------------------- */
  const closed = await E(`(()=>{window.__mgMeshDepth?.close(); window.__mgDepth?.close();
    return {mesh:!!window.__mgMeshDepth?.isOpen, gs:!!window.__mgDepth?.isOpen,
      meshHidden:document.getElementById('mg-meshbox').hidden,
      gsHidden:document.getElementById('mg-depthbox').hidden};})()`);
  check('两个视口都能关闭',
    !!(closed && closed.mesh === false && closed.gs === false
      && closed.meshHidden === true && closed.gsHidden === true), closed);

  return { kind, sa, sb, vpA, vpB, inA, inB, outBoth, outDiff, gsDelta, movedStats };
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
    } else if (o.method === 'Runtime.consoleAPICalled' && o.params.type === 'warning') {
      pageWarns.push((o.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
    }
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride',
    { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

  const kinds = ONLY === 'both' ? ['webgpu', 'webgl'] : [ONLY];
  const results = [];
  for (const kind of kinds) {
    try { results.push(await runBackend(kind)); }
    catch (err) { check(`[${kind}] 运行异常`, false, String(err && err.message || err)); }
  }

  const fails = checks.filter((c) => !c.ok);
  console.log('\n  pageerrors: ' + (pageErrors.length ? pageErrors.slice(0, 3).join(' | ') : '0'));
  if (pageWarns.length) {
    for (const w of pageWarns.slice(0, 8)) console.log('  warn: ' + w);
  }
  console.log(`\n碰撞Mesh深度[${kinds.join('+')}]: ${fails.length ? 'FAIL' : 'PASS'}  `
    + `(${checks.length - fails.length}/${checks.length})`);
  if (fails.length) for (const f of fails) console.log('   FAIL: ' + f.name);
  fs.writeFileSync(path.join(OUT, 'mesh_depth_report.json'),
    JSON.stringify({ at: new Date().toISOString(), checks, results, pageErrors }, null, 2));
  return fails.length ? 1 : 0;
}

main()
  .then((code) => { cleanup(); process.exitCode = code; })
  .catch((err) => { console.error('诊断失败：', err); cleanup(); process.exitCode = 1; });

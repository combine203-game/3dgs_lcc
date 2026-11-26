#!/usr/bin/env node
/* 深度视口在「键盘漫游」时消失 · 定位脚本
 * ---------------------------------------------------------------
 * 现象：打开深度视口后按住 W/A/S/D 漫游，视口里的深度图会消失
 * （面板边框还在，里面变回主画面 / 变黑 / 整块没了）。
 *
 * 本脚本只做取证，不做判定，输出一条时间线：
 *   t | renders | picks | rect | #mg-stage canvas 数量 | 视口内像素特征
 * 用来区分三种可能：
 *   A) 面板被隐藏（DOM）        -> box.hidden / rect 变 0
 *   B) 四边形没再画（GPU）      -> renders 停止增长，或 measureRect 返回 null
 *   C) 深度快照断了（pick）     -> picks 停止增长 / errors 上升
 *
 * 用法： node tools/diagnose_depth_walk.mjs [--wait=45000] [--hold=3000]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 18157;
const CDP_PORT = 9287;
const BASE = `http://127.0.0.1:${PORT}`;
const ARG = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : d;
};
const WAIT = Number(ARG('wait', '45000'));
const HOLD = Number(ARG('hold', '3000'));
const OUT = path.join(ROOT, 'tools', 'shots');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)],
  { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'depthwalk_' + Date.now());
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

/** 视口内像素特征：mean / sd / grayPct / sat */
function rectStats(buf, rect) {
  const img = decodePng(buf);
  const x0 = Math.max(0, Math.floor(rect.x)), x1 = Math.min(img.w, Math.ceil(rect.x + rect.w));
  const y0 = Math.max(0, Math.floor(rect.y)), y1 = Math.min(img.h, Math.ceil(rect.y + rect.h));
  let s = 0, s2 = 0, gray = 0, sat = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
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
    mean: +mean.toFixed(1),
    sd: +Math.sqrt(Math.max(0, s2 / n - mean * mean)).toFixed(1),
    grayPct: +(100 * gray / n).toFixed(1),
    sat: +(sat / n).toFixed(2),
    n
  };
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
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(r.result.data, 'base64');
  fs.writeFileSync(path.join(OUT, name + '.png'), buf);
  return buf;
}

/** 一次采样：状态 + DOM + 画布清单 + 可选截图统计 */
async function sample(tag, withShot) {
  const info = await E(`(()=>{
    const api = window.__mgDepth;
    const st = api && api.state ? api.state() : null;
    const box = document.getElementById('mg-depthbox');
    const body = document.getElementById('mg-depth-body');
    const cs = box ? getComputedStyle(box) : null;
    const br = body ? body.getBoundingClientRect() : null;
    const cv = [...document.querySelectorAll('#mg-stage canvas')].map(c => {
      const r = c.getBoundingClientRect();
      return { id: c.id || '', cls: String(c.className || '').slice(0, 24),
        w: Math.round(r.width), h: Math.round(r.height),
        x: Math.round(r.left), y: Math.round(r.top), connected: c.isConnected };
    });
    return {
      open: st && st.open, renders: st && st.renders, picks: st && st.picks,
      errors: st && st.errors, pickReady: st && st.pickReady,
      rectPx: st && st.rectPx, sizeCss: st && st.sizeCss,
      hidden: box ? box.hidden : null,
      display: cs ? cs.display : null, visibility: cs ? cs.visibility : null,
      opacity: cs ? cs.opacity : null,
      bodyRect: br ? { x: Math.round(br.left), y: Math.round(br.top),
        w: Math.round(br.width), h: Math.round(br.height) } : null,
      canvases: cv
    };
  })()`);
  let px = null;
  const rect = info && (info.bodyRect || null);
  if (withShot && rect && rect.w > 8 && rect.h > 8) {
    const buf = await shot('depth_walk_' + tag);
    px = rectStats(buf, rect);
  }
  const row = {
    tag,
    open: info?.open, renders: info?.renders, picks: info?.picks,
    err: info?.errors, pickReady: info?.pickReady,
    rectPx: info?.rectPx, sizeCss: info?.sizeCss,
    hidden: info?.hidden, display: info?.display, opacity: info?.opacity,
    canvases: info?.canvases, px
  };
  console.log('  ' + JSON.stringify(row));
  return row;
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
  await send('Page.navigate', {
    url: `${BASE}/gs-viewer.html?scene=floor3&spawn=floor3&renderer=webgpu`
  });

  const t0 = Date.now();
  let ready = null;
  while (Date.now() - t0 < WAIT) {
    await sleep(1000);
    ready = await E(`(()=>({loaded:!!window.__viewer?.state?.loaded,
      depth:!!window.__mgDepth}))()`);
    if (ready?.loaded) break;
  }
  console.log('\n[load] ' + JSON.stringify(ready));

  await E(`window.__mgDepth?.open(); 1`);
  for (let i = 0; i < 25; i++) {
    await sleep(900);
    const st = await E(`window.__mgDepth?.state?.() || null`);
    if (st && st.pickReady && st.renders > 0) break;
  }
  console.log('\n==== 打开深度视口（静止） ====');
  await sample('idle', true);

  console.log('\n==== 按住 W 漫游 ====');
  const keyW = { windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87, code: 'KeyW', key: 'w' };
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...keyW, text: 'w', unmodifiedText: 'w' });
  const tStart = Date.now();
  let i = 0;
  while (Date.now() - tStart < HOLD) {
    i++;
    await sleep(700);
    await sample('walk' + i, i === 1 || i === 2);
  }
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...keyW });
  console.log('\n==== 松键后 ====');
  await sleep(1500);
  await sample('after', true);

  console.log('\n==== 再按住 D（右移）漫游 ====');
  const keyD = { windowsVirtualKeyCode: 68, nativeVirtualKeyCode: 68, code: 'KeyD', key: 'd' };
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...keyD, text: 'd', unmodifiedText: 'd' });
  const t2 = Date.now();
  i = 0;
  while (Date.now() - t2 < HOLD) {
    i++;
    await sleep(700);
    await sample('strafe' + i, i === 2);
  }
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...keyD });
  await sleep(1200);
  await sample('final', true);

  console.log('\n  pageerrors: ' + (pageErrors.length ? pageErrors.slice(0, 3).join(' | ') : '0'));
  fs.writeFileSync(path.join(OUT, 'depth_walk_report.json'),
    JSON.stringify({ at: new Date().toISOString(), pageErrors }, null, 2));
  return 0;
}

main()
  .then((code) => { cleanup(); process.exitCode = code; })
  .catch((err) => { console.error('诊断失败：', err); cleanup(); process.exitCode = 1; });

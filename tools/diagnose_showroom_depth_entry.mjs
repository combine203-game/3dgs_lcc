#!/usr/bin/env node
/* 展厅页「实时深度图」入口验收
 * ---------------------------------------------------------------
 * 用户反馈：「深度图视口打开的按钮找不到」。原因：站点默认入口是 index.html
 * （maoming-showroom 融合页），三维画面在全屏 iframe 里、顶栏被 .mg-bare
 * 整条隐藏，所以 gs-viewer 顶栏的「深度」按钮在展厅页根本不存在。
 * 修复后在父页「三维功能控制台」里加了「实时深度图 D」一项。
 *
 * 本脚本走真实用户路径验证：
 *   1. 打开 /index.html，等前台 iframe 的三维场景加载完成；
 *   2. 点底部快捷条「三维功能」→ 控制台可见；
 *   3. 控制台里存在「实时深度图 D」按钮，点它；
 *   4. iframe 内 __mgDepth.isOpen 变 true、pickReady、无错误，且有独立视口矩形；
 *   5. 视口内是纯灰阶深度图，视口外的三维画面仍是彩色（没有被整幅替换）；
 *   6. 再点一次 → isOpen false，整幅画面统计回到彩色基线。
 *
 * 结论行：展厅深度图入口: PASS / FAIL
 * 用法： node tools/diagnose_showroom_depth_entry.mjs [--wait=60000]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 18151;
const CDP_PORT = 9281;
const BASE = `http://127.0.0.1:${PORT}`;
const WAIT = Number((process.argv.find((a) => a.startsWith('--wait=')) || '').split('=')[1]) || 60000;
const OUT = path.join(ROOT, 'tools', 'shots');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)],
  { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'showroomdepth_' + Date.now());
fs.mkdirSync(profile, { recursive: true });
const br = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader',
  '--window-size=1440,900', 'about:blank'
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

/* 只统计三维画面：裁掉顶部导览条 / 底部快捷条 / 左右面板 */
const CROP = { x0: 0.16, x1: 0.84, y0: 0.22, y1: 0.78 };
function stats(buf) {
  const img = decodePng(buf);
  let s = 0, s2 = 0, gray = 0, n = 0, sat = 0;
  const x0 = Math.floor(img.w * CROP.x0), x1 = Math.floor(img.w * CROP.x1);
  const y0 = Math.floor(img.h * CROP.y0), y1 = Math.floor(img.h * CROP.y1);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = (y * img.w + x) * img.bpp;
      const r = img.data[p], g = img.data[p + 1], b = img.data[p + 2];
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      s += l; s2 += l * l; n++;
      sat += Math.max(r, g, b) - Math.min(r, g, b);
      if (Math.max(r, g, b) - Math.min(r, g, b) <= 6) gray++;
    }
  }
  const mean = s / n;
  return {
    mean: +mean.toFixed(2),
    sd: +Math.sqrt(Math.max(0, s2 / n - mean * mean)).toFixed(2),
    grayPct: +(100 * gray / n).toFixed(1),
    sat: +(sat / n).toFixed(2)
  };
}

/* 视口矩形内 / 外的像素统计（rect = 页面 CSS 像素） */
function clampRect(img, rect) {
  return {
    x0: Math.max(0, Math.floor(rect.x)),
    y0: Math.max(0, Math.floor(rect.y)),
    x1: Math.min(img.w, Math.ceil(rect.x + rect.w)),
    y1: Math.min(img.h, Math.ceil(rect.y + rect.h))
  };
}
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
    mean: +mean.toFixed(2),
    sd: +Math.sqrt(Math.max(0, s2 / n - mean * mean)).toFixed(2),
    grayPct: +(100 * gray / n).toFixed(1),
    sat: +(sat / n).toFixed(2),
    n
  };
}
function outsideStats(buf, rect) {
  const img = decodePng(buf);
  const r = clampRect(img, rect);
  let s = 0, gray = 0, n = 0, sat = 0;
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
    { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: BASE + '/index.html' });

  // 等前台 iframe 的三维场景就绪
  const t0 = Date.now();
  let ready = null;
  while (Date.now() - t0 < WAIT) {
    await sleep(1000);
    ready = await E(`(()=>{const fs=[...document.querySelectorAll('iframe.gs-scene-frame')];
      const f=fs.find(x=>x.dataset.active==='1')||fs[0];
      const w=f&&f.contentWindow;
      return {frames:fs.length, loaded:!!w?.__viewer?.state?.loaded,
        source:w?.__MG_SOURCE||null, depth:!!w?.__mgDepth,
        consoleBtn:!!document.getElementById('gsConsoleBtn')};})()`);
    if (ready?.loaded) break;
  }
  check('展厅页三维场景已加载', !!ready?.loaded, ready);
  check('默认流式数据源', ready?.source === 'lcc2', ready && ready.source);
  check('父页有「三维功能」入口', !!ready?.consoleBtn);
  check('iframe 内深度模块已挂载', !!ready?.depth);

  /* 先把「三维功能控制台」打开再取彩色基线：控制台是父页 DOM，永远盖在 iframe
     之上，它开合本身就会改动视口外区域的像素；基线必须包含控制台，否则
     「视口外未被改动」会被控制台的开合误判成深度图动了主画面。 */
  const opened = await E(`(()=>{const b=document.getElementById('gsConsoleBtn');
    if(!b) return {__err:'no gsConsoleBtn'};
    const panel=document.getElementById('gs-console');
    if(!panel) return {__err:'no console panel'};
    if(panel.hidden) b.click();
    return {panelOpen:!panel.hidden};})()`);
  check('「三维功能」控制台可打开', !!(opened && opened.panelOpen), opened);

  await sleep(1500);
  const baseShot = await shot('showroom_depth_color');
  const base = stats(baseShot);

  // 点「实时深度图 D」（控制台此时已展开，不再重复点按钮去闭合它）
  const clicked = await E(`(()=>{const b=document.getElementById('gsConsoleBtn');
    if(!b) return {__err:'no gsConsoleBtn'};
    const panel=document.getElementById('gs-console');
    if(!panel) return {__err:'no console panel'};
    if(panel.hidden) b.click();
    const btn=[...panel.querySelectorAll('.gs-btn')].find(x=>/深度图/.test(x.textContent||''));
    if(!btn) return {__err:'no depth button', labels:[...panel.querySelectorAll('.gs-btn')].slice(0,6).map(x=>x.textContent)};
    btn.click();
    return {label:btn.textContent, panelOpen:!panel.hidden};})()`);
  check('控制台里有「实时深度图」按钮且已点击',
    !!(clicked && clicked.label), clicked);

  // 等深度快照就绪
  let ds = null;
  for (let i = 0; i < 25; i++) {
    await sleep(900);
    ds = await E(`(()=>{const f=[...document.querySelectorAll('iframe.gs-scene-frame')]
      .find(x=>x.dataset.active==='1');
      const api=f&&f.contentWindow.__mgDepth;
      return api?api.state():null;})()`);
    if (ds && ds.pickReady && ds.renders > 0) break;
  }
  check('iframe 内深度图已开启', !!(ds && ds.open === true), ds);
  check('深度快照就绪且无错误',
    !!(ds && ds.pickReady && ds.errors === 0), ds && {
      picks: ds.picks, renders: ds.renders, errors: ds.errors, pickSize: ds.pickSize
    });

  /* 独立视口：深度只画在 #mg-depth-body 那块矩形里（iframe 内坐标 + iframe 偏移） */
  const vp = await E(`(()=>{const fs=[...document.querySelectorAll('iframe.gs-scene-frame')];
    const f=fs.find(x=>x.dataset.active==='1')||fs[0];
    const w=f&&f.contentWindow;
    const api=w&&w.__mgDepth;
    if(!api||!api.viewport) return null;
    const fr=f.getBoundingClientRect();
    const v=api.viewport();
    if(!v||v.w<10||v.h<10) return null;
    return {x:fr.left+v.x, y:fr.top+v.y, w:v.w, h:v.h};})()`);
  check('展厅深度视口已建立且有面积', !!(vp && vp.w > 150 && vp.h > 100), vp);

  await sleep(1500);
  const depthShot = await shot('showroom_depth_mode');
  const depIn = vp ? rectStats(depthShot, vp) : { grayPct: 0, sat: 0, sd: 0 };
  const depOut = vp ? outsideStats(depthShot, vp) : { grayPct: 0, sat: 0 };
  const outDiff = vp ? diffOutside(baseShot, depthShot, vp) : null;
  /* 展厅页的三维画面是自动漫游 / 播放态，机位会持续移动，所以「视口外与基线
     逐像素一致」在这里不成立（实测机位漂移就 7%）。改判统计特征：
     深度图是纯灰阶（sat≈4），主画面是彩色（sat≈13）；如果整幅被替换成深度，
     视口外的 sat 会掉到个位数、grayPct 会冲到 90%。 */
  check('视口内已换成深度图（近灰阶、低饱和）',
    depIn.sat < 6 && depIn.grayPct > 75 && depIn.sd > 15, { in: depIn, color: base });
  check('视口外主画面仍是彩色（未整幅替换）',
    depOut.grayPct < 60 && depOut.sat > 6 && depOut.grayPct < base.grayPct + 20,
    { out: depOut, color: base });
  check('视口外画面差异在机位漂移量级内（< 15%）', outDiff !== null && outDiff < 15,
    { diffOutside: outDiff });

  // 再点一次关闭（控制台保持展开，保证与彩色基线同态）
  await E(`(()=>{const b=document.getElementById('gsConsoleBtn');
    if(!b) return 0;
    const panel=document.getElementById('gs-console');
    if(panel&&panel.hidden) b.click();
    const btn=panel&&[...panel.querySelectorAll('.gs-btn')].find(x=>/深度图/.test(x.textContent||''));
    if(btn) btn.click();
    return 1;})()`);
  await sleep(1800);
  const closed = await E(`(()=>{const f=[...document.querySelectorAll('iframe.gs-scene-frame')]
    .find(x=>x.dataset.active==='1');
    const api=f&&f.contentWindow.__mgDepth;
    return {open:api?api.isOpen:null, hint:document.getElementById('toastText')?.textContent||null};})()`);
  check('再点一次可关闭深度图', !!(closed && closed.open === false), closed);
  const backShot = await shot('showroom_depth_back');
  const back = stats(backShot);
  const backIn = vp ? rectStats(backShot, vp) : { grayPct: 0 };
  /* 关闭后整幅三维画面必须回到彩色基线的统计水平（视口那块地砖本来就是灰的，
     单看那块区域分不出深度图与地砖，所以看整幅）。 */
  check('关闭后画面回到彩色基线',
    Math.abs(back.grayPct - base.grayPct) < 15 && back.sat > 6,
    { back, base, backIn });

  const fails = checks.filter((c) => !c.ok);
  console.log('\n  pageerrors: ' + (pageErrors.length ? pageErrors.slice(0, 3).join(' | ') : '0'));
  console.log(`\n展厅深度图入口: ${fails.length ? 'FAIL' : 'PASS'}  `
    + `(${checks.length - fails.length}/${checks.length})`);
  if (fails.length) for (const f of fails) console.log('   FAIL: ' + f.name);
  fs.writeFileSync(path.join(OUT, 'showroom_depth_report.json'),
    JSON.stringify({ at: new Date().toISOString(), checks, base, vp, depIn, depOut, outDiff, backIn, back, pageErrors }, null, 2));
  return fails.length ? 1 : 0;
}

main()
  .then((code) => { cleanup(); process.exitCode = code; })
  .catch((err) => { console.error('诊断失败：', err); cleanup(); process.exitCode = 1; });

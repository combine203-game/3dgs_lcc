#!/usr/bin/env node
/* 渲染效果 A/B：原始单文件 SOG（?source=sog，默认） vs .lcc2 八叉树分块流式（?source=lcc2）
 * ---------------------------------------------------------------
 * 同一机位、同一后端、同一视口，各截一张图并做像素统计：
 *   mean      画面平均亮度（判断整体偏亮 / 偏暗）
 *   sd        亮度标准差（判断层次与对比）
 *   dark%     暗部占比（luma < 40）—— 分块缺失 / alpha 不足会显著抬高
 *   hf        高频能量（4 邻域 Laplace 绝对均值）—— 糊块 / 大高斯拖影会显著降低
 *   cover%    非背景像素占比（luma > 12）—— 空洞 / 未请求分块会显著降低
 * 同机位两张图再算 mean|Δ|（crossDiff%），衡量两条链路是否画的是同一画面。
 *
 * 机位来源：./sog/<scene>/scene-meta.json 的 spawnPoints（两条链路共用同一
 * 米制世界与出生点，坐标完全一致，因此可以直接同机位对照）。
 *
 * 用法：
 *   node tools/compare_stream_vs_sog.mjs                       # 两个场景默认机位
 *   node tools/compare_stream_vs_sog.mjs --scenes=floor1
 *   node tools/compare_stream_vs_sog.mjs --source=sog --out=tools/shots/x
 *   node tools/compare_stream_vs_sog.mjs --wait=45000 --keep
 * 产物：<out>/<scene>_<pose>_<source>.png + report.json + 控制台结论表
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.env.PORT || 18141);
const CDP_PORT = Number(process.env.CDP_PORT || 9271);
const BASE = `http://127.0.0.1:${PORT}`;
const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : d;
};
const WAIT = Number(arg('wait', '40000'));
const KEEP = process.argv.includes('--keep');
const OUT = path.resolve(ROOT, arg('out', path.join('tools', 'shots', 'stream_vs_sog')));
const SCENES = arg('scenes', 'floor1,floor3').split(',').filter(Boolean);
const SOURCES = arg('sources', 'sog,lcc2').split(',').filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (v) => (Number.isFinite(v) ? +v.toFixed(2) : null);

fs.mkdirSync(OUT, { recursive: true });

/* ---------------------------------------------------------------- 进程管理 */
const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)],
  { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'ab_' + Date.now());
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

/* ------------------------------------------------------------ PNG 像素统计
   只支持 CDP 截图会产出的 8bit RGB/RGBA、非隔行 PNG；用 zlib 解压后按行
   unfilter，避免为了统计再引入三方依赖（本机 runtime python 没有 numpy）。 */
function decodePng(buf) {
  let pos = 8; let w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`不支持的 PNG: depth=${bitDepth} color=${colorType} interlace=${interlace}`);
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(w * h * bpp);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = Buffer.from(line);
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

function luma(img) {
  const { w, h, bpp, data } = img;
  const g = new Float32Array(w * h);
  for (let i = 0, p = 0; i < g.length; i++, p += bpp) {
    g[i] = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
  }
  return g;
}

function stats(img) {
  const g = luma(img);
  const { w, h } = img;
  let sum = 0, sum2 = 0, dark = 0, cover = 0;
  for (let i = 0; i < g.length; i++) {
    const v = g[i];
    sum += v; sum2 += v * v;
    if (v < 40) dark++;
    if (v > 12) cover++;
  }
  const n = g.length;
  const mean = sum / n;
  const sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  // 4 邻域 Laplace（跳过边框一行一列）
  let hf = 0, hn = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      hf += Math.abs(4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w]);
      hn++;
    }
  }
  return {
    w, h,
    mean: r2(mean), sd: r2(sd),
    darkPct: r2(100 * dark / n),
    coverPct: r2(100 * cover / n),
    hf: r2(hf / Math.max(1, hn))
  };
}

function crossDiff(a, b) {
  if (a.w !== b.w || a.h !== b.h) return null;
  const ga = luma(a), gb = luma(b);
  let s = 0;
  for (let i = 0; i < ga.length; i++) s += Math.abs(ga[i] - gb[i]);
  return r2(100 * s / ga.length / 255);
}

/** 把两张同尺寸图的亮度差写成放大后的灰度 PNG（--diff=1 时输出），
 *  局部团块 = 分块缺失 / 几何错位；整幅均匀 = 亮度 / 遮罩差异。 */
function writeDiffPng(a, b, file) {
  if (a.w !== b.w || a.h !== b.h) return false;
  const ga = luma(a), gb = luma(b);
  const { w, h } = a;
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < w; x++) {
      const d = Math.min(255, Math.round(Math.abs(ga[y * w + x] - gb[y * w + x]) * 4));
      const p = y * stride + 1 + x * 3;
      raw[p] = d; raw[p + 1] = d; raw[p + 2] = d;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]);
  fs.writeFileSync(file, png);
  return true;
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

/* ---------------------------------------------------------------- CDP 会话 */
let ws, seq = 0;
const pend = new Map();
const errors = [];

const send = (method, params = {}) => new Promise((res) => {
  const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params }));
});

/** 返回 {__err}/{__timeout} 而不是抛错：失败原因要写进报告 */
async function E(expression, timeoutMs = 60000) {
  try {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
      sleep(timeoutMs).then(() => ({ timeout: true }))
    ]);
    if (r.timeout) return { __timeout: true };
    if (r.result?.exceptionDetails) {
      return { __err: (r.result.exceptionDetails.exception?.description
        || r.result.exceptionDetails.text || '').slice(0, 400) };
    }
    return r.result?.result?.value;
  } catch (err) { return { __err: String(err) }; }
}

async function shot(name) {
  const rect = await E(`(()=>{const s=document.getElementById('mg-stage');
    const r=s.getBoundingClientRect();
    return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)};})()`);
  const clip = (rect && !rect.__err && rect.width > 10)
    ? { ...rect, scale: 1 } : { x: 0, y: 0, width: 1280, height: 800, scale: 1 };
  const r = await send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: false });
  if (!r.result?.data) throw new Error('截图失败');
  const buf = Buffer.from(r.result.data, 'base64');
  const file = path.join(OUT, name + '.png');
  fs.writeFileSync(file, buf);
  return { file, img: decodePng(buf) };
}

/* ------------------------------------------------------------- 单次渲染采样 */
async function renderSource(scene, poseName, pose, source) {
  const q = new URLSearchParams({
    scene,
    spawn: pose.spawn,
    source,
    collision: '0',       // 关碰撞：避免 walk 胶囊把机位拽走，两条链路机位必须一致
    fullload: '1'         // 跳过「首帧先钳制到最粗 LOD」，画质优先
  });
  // 流式观测 HUD 会压住左侧画面、污染像素统计：默认不挂（__mgStream 与 HUD 无关，
  // 不挂 HUD 也能读分块 / 字节 / 校验状态），需要截图带 HUD 时加 --hud=1。
  if (process.argv.includes('--hud=1')) q.set('stream', '1');
  // 排查用：--budget=N 覆盖流式渲染预算（百万点）；--mask=0 用未遮罩原始分块
  const budget = arg('budget', '');
  if (budget) q.set('budget', budget);
  const mask = arg('mask', '');
  if (mask && source === 'lcc2') q.set('mask', mask);
  await send('Page.navigate', { url: `${BASE}/gs-viewer.html?${q}` });

  const t0 = Date.now();
  let st = null;
  while (Date.now() - t0 < WAIT) {
    await sleep(1000);
    st = await E(`(()=>{const v=window.__viewer;
      if(!v) return {ready:false};
      const s=window.__mgStream?.state?.()||null;
      return {ready:!!v.state?.loaded, drawn:v.app?.stats?.frame?.gsplats??null,
        backend:window.__mgRenderer?.renderer||null,
        chunks:s?s.chunkRequested:null, chunkTotal:s?s.chunkTotal:null,
        bytes:s?s.chunkBytesText:null, issues:s?s.validationIssues:null,
        budget:v.app?.scene?.gsplat?.splatBudget??null};})()`);
    if (st?.ready) break;
  }
  /* 机位钉死：注入的 ?spawn 只是初始位姿，walk 胶囊 / 投掷动画都可能在揭幕
     之后把它挪走，所以这里反复 setCameraPose 直到读回的位置与目标一致，
     连续两次一致才算稳。两条链路必须停在同一机位才能谈画质对照。 */
  const pin = () => E(`(()=>{const v=window.__viewer;
    try{v.setCollisionEnabled?.(false);}catch(_){}
    v.setCameraPose?.(${JSON.stringify(pose.position)},${JSON.stringify(pose.target)},${pose.fov || 75});
    const c=v.app?.root?.findComponent('camera');const p=c?.entity?.getPosition?.();
    const t=${JSON.stringify(pose.position)};
    return p?Math.hypot(p.x-t[0],p.y-t[1],p.z-t[2]):-1;})()`);
  let ok = 0;
  for (let i = 0; i < 12 && ok < 2; i++) {
    const d = Number(await pin());
    ok = (d >= 0 && d < 0.05) ? ok + 1 : 0;
    await sleep(700);
  }

  /* 分块请求收敛：机位变了之后新分块才开始下载 / 解码，必须等标签数连续
     两次不变再截图，否则会把「还在流式加载」误判成「这一档 LOD 就是空洞」。 */
  let last = -1, stable = 0;
  for (let i = 0; i < 30; i++) {
    const s = await E(`(()=>{const w=window.__mgStream?.state?.();
      return w?w.chunkRequested:-1;})()`);
    const cur = Number(s);
    if (cur === last) stable++; else { stable = 0; last = cur; }
    if (stable >= 3) break;
    await sleep(1200);
  }
  // 收敛期间相机若被挪动则再钉一次（例如 walk 胶囊在两轮之间生效）
  await pin();
  await sleep(900);
  const cam = await E(`(()=>{const c=window.__viewer?.app?.root?.findComponent('camera');
    const e=c?.entity;const p=e?.getPosition?.();
    return p?{pos:[+p.x.toFixed(3),+p.y.toFixed(3),+p.z.toFixed(3)],fov:c.fov}:null;})()`);
  const snap = await E(`(()=>{const s=window.__mgStream?.state?.();
    return s?{source:s.source,space:s.space,mask:s.mask,chunkRequested:s.chunkRequested,
      chunkTotal:s.chunkTotal,chunkBytesText:s.chunkBytesText,firstFrameMs:s.firstFrameMs,
      loadedMs:s.loadedMs,validationIssues:s.validationIssues,
      drawn:window.__viewer?.app?.stats?.frame?.gsplats??null}:null;})()`);
  const pic = await shot(`${scene}_${poseName}_${source}`);
  return { source, cam, snap, stats: stats(pic.img), file: pic.file, img: pic.img };
}

/* ------------------------------------------------------------------ 主流程 */
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
      errors.push(o.params.exceptionDetails?.exception?.description
        || o.params.exceptionDetails?.text || '');
    } else if (o.method === 'Runtime.consoleAPICalled' && o.params.type === 'error') {
      errors.push((o.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
    }
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride',
    { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

  const report = { at: new Date().toISOString(), base: BASE, wait: WAIT, cases: [] };
  const rows = [];

  for (const scene of SCENES) {
    const meta = JSON.parse(fs.readFileSync(
      path.join(ROOT, 'web', 'sog', scene, 'scene-meta.json'), 'utf8'));
    const only = arg('poses', '').split(',').filter(Boolean);
    const poses = Object.entries(meta.spawnPoints || {})
      .filter(([key, sp]) => sp?.worldPosition && sp?.worldTarget)
      .filter(([key]) => !only.length || only.includes(key))
      .map(([key, sp]) => ({ name: key, spawn: key, position: sp.worldPosition, target: sp.worldTarget, fov: sp.fov || 75 }));
    for (const pose of poses) {
      const rendered = [];
      for (const source of SOURCES) {
        process.stdout.write(`  · ${scene}/${pose.name} @ ${source} ... `);
        const r = await renderSource(scene, pose.name, pose, source);
        rendered.push(r);
        process.stdout.write(`${r.stats.mean} mean / ${r.stats.hf} hf\n`);
      }
      const sog = rendered.find((r) => r.source === 'sog');
      const lcc = rendered.find((r) => r.source === 'lcc2');
      const diff = (sog && lcc) ? crossDiff(sog.img, lcc.img) : null;
      if (sog && lcc && process.argv.includes('--diff=1')) {
        writeDiffPng(sog.img, lcc.img, path.join(OUT, `${scene}_${pose.name}_diff.png`));
      }
      const c = {
        scene, pose: pose.name, position: pose.position, target: pose.target,
        frames: rendered.map((r) => ({
          source: r.source, file: path.relative(ROOT, r.file), cam: r.cam,
          stats: r.stats, stream: r.snap
        })),
        crossDiffPct: diff
      };
      report.cases.push(c);
      const line = [scene, pose.name];
      for (const r of rendered) {
        line.push(`${r.source}: mean ${r.stats.mean} sd ${r.stats.sd} `
          + `dark ${r.stats.darkPct}% cover ${r.stats.coverPct}% hf ${r.stats.hf}`);
      }
      if (diff !== null) line.push(`crossDiff ${diff}%`);
      rows.push(line);
    }
  }

  report.errors = errors.slice(0, 10);
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));

  console.log('\n================ 同机位 A/B（SOG vs .lcc2 流式）================');
  for (const row of rows) {
    console.log('  ' + row[0] + ' / ' + row[1]);
    for (const cell of row.slice(2)) console.log('     ' + cell);
  }
  console.log('\n  控制台错误：' + (errors.length ? errors.slice(0, 3).join(' | ') : '0'));
  console.log('  截图与 report.json -> ' + path.relative(ROOT, OUT));
}

main()
  .then(() => { if (!KEEP) cleanup(); else console.log('  (--keep：服务与浏览器保留)'); })
  .catch((e) => { console.error('A/B 失败：', e); cleanup(); process.exitCode = 1; });

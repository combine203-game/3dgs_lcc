/**
 * 在指定世界坐标生成 720° 等距柱状（equirectangular）全景图。
 * 原理：把相机放在该点，依次渲染 ±X/±Y/±Z 六个 90° 视野面（CDP 截图），
 * 再用 tools/stitch_panorama.py 按球面方向采样拼成 2:1 全景。
 *
 * 用法：
 *   node tools/generate_panorama.mjs --x=13.5 --z=17.8 [--y=2.29]
 *        [--scene=floor1] [--out=shots/pano_13.5_17.8.png] [--face=1024] [--wait=18000]
 *
 * 坐标约定：floor1 行走路径为米制 Y-up 世界坐标（x, y, z），(x,z) 直接取用户给的
 * 平面坐标；默认 y=2.29 来自最近标定机位（地面 0.69m + 眼高 1.6m）。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const SYS_PY = 'python';                       // 系统 Python 带 PIL + numpy（拼接用）
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const argOf = (k, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${k}=`));
  return a ? a.split('=')[1] : d;
};
const X = Number(argOf('x', 13.5)), Z = Number(argOf('z', 17.8));
const Y = Number(argOf('y', 2.29));
const SCENE = argOf('scene', 'floor1');
const OUT = path.resolve(ROOT, argOf('out', `shots/pano_${X}_${Z}.png`));
const FACE = Number(argOf('face', 1024));
const WAIT = Number(argOf('wait', 18000));
const PORT = Number(argOf('port', 8400 + (process.pid % 300)));
const CDP_PORT = PORT + 1000;
const BASE = `http://127.0.0.1:${PORT}`;
const FACES = path.join(ROOT, '.verify-profile', 'faces_' + Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(FACES, { recursive: true });
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'pano_' + Date.now());
fs.mkdirSync(profile, { recursive: true });
const br = spawn(CHROME, [
  '--headless=new', '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
  `--remote-debugging-port=${CDP_PORT}`, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--ignore-gpu-blocklist', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  `--window-size=${FACE},${FACE}`, 'about:blank'
], { stdio: 'ignore' });

function cleanup() {
  try { br.kill(); } catch { /* noop */ }
  try { srv.kill(); } catch { /* noop */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* noop */ }
  try { fs.rmSync(FACES, { recursive: true, force: true }); } catch { /* noop */ }
}

let ws, seq = 0;
const pend = new Map();
const send = (method, params = {}) => new Promise((res) => {
  const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params }));
});
const E = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'evaluate error');
  return r.result?.result?.value;
};

// 六个面的朝向：forward 与 stitch_panorama.py 的 BASES 严格一致
const EPS = 1e-4;
const dirs = [
  [1, 0, 0], [-1, 0, 0], [0, 1, EPS], [0, -1, EPS], [0, 0, 1], [0, 0, -1]
];
const names = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'];

async function main() {
  for (let i = 0; i < 100; i++) { try { await fetch(BASE + '/'); break; } catch { await sleep(250); } }
  let page = null;
  for (let i = 0; i < 100; i++) {
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
    if (o.id && pend.has(o.id)) { pend.get(o.id)(o); pend.delete(o.id); }
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: FACE, height: FACE, deviceScaleFactor: 1, mobile: false
  });

  const url = `${BASE}/gs-viewer.html?scene=${SCENE}&embed=showroom` +
    `&pos=${X},${Y},${Z}&look=${X + 1},${Y - 0.1},${Z}`;
  console.log('打开：', url);
  await send('Page.navigate', { url });
  await sleep(WAIT);

  // 只保留 canvas 及其祖先，隐藏全部 HUD，保证六面截图纯净
  const hidden = await E(`(()=>{
    const cv=document.querySelector('canvas'); if(!cv) return 'no-canvas';
    const keep=new Set(); for(let n=cv;n;n=n.parentElement) keep.add(n);
    document.querySelectorAll('body *').forEach(el=>{
      if(!keep.has(el)) el.style.setProperty('display','none','important');
    });
    const r=cv.getBoundingClientRect();
    return JSON.stringify({w:r.width,h:r.height,pos:window.__mgPose?.()||null});
  })()`);
  console.log('画布 / 机位：', hidden);
  const ready = await E(`!!(window.__viewer?.setCameraPose || window.__mgEmbed?.setCameraPose)`);
  if (!ready) throw new Error('setCameraPose 不可用');

  for (let i = 0; i < 6; i++) {
    const [dx, dy, dz] = dirs[i];
    const tx = X + dx, ty = Y + dy, tz = Z + dz;
    const ok = await E(`(()=>{
      const p=[${X},${Y},${Z}], t=[${tx},${ty},${tz}];
      const fn=window.__viewer?.setCameraPose||window.__mgEmbed?.setCameraPose;
      return !!fn?.call(window.__viewer||window.__mgEmbed,p,t,90);
    })()`);
    if (!ok) throw new Error(`setCameraPose 失败：${names[i]}`);
    await sleep(320);   // 等 2 帧以上，确保 renderer 用新机位出图
    const pose = await E(`JSON.stringify(window.__mgPose?.()||{})`);
    const cap = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const data = cap.result?.data;
    if (!data) throw new Error(`面 ${names[i]} 截图返回空：${JSON.stringify(cap).slice(0, 200)}`);
    fs.writeFileSync(path.join(FACES, `face${i}.png`), Buffer.from(data, 'base64'));
    console.log(`  面 ${i} ${names[i]} -> face${i}.png  机位=${pose}`);
  }

  const W = FACE * 4, H = FACE * 2;
  const st = spawn(SYS_PY, [path.join(ROOT, 'tools', 'stitch_panorama.py'), FACES, OUT, String(W)], {
    cwd: ROOT, stdio: 'inherit'
  });
  const code = await new Promise((r) => st.on('exit', r));
  if (code !== 0) throw new Error(`拼接失败（exit ${code}）`);
  const stat = fs.statSync(OUT);
  console.log(`720° 全景完成：${OUT} (${W}x${H}, ${(stat.size / 1048576).toFixed(2)} MB)`);
  cleanup();
  process.exit(0);
}
main().catch((e) => { console.error('全景生成失败：', e); cleanup(); process.exit(1); });

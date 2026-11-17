/**
 * 前向标定：把数字人放在镜头正前方，按 0/90/180/270° 四个偏航各出一张图，
 * 用来确定模型「脸」到底朝哪个局部轴（不再靠猜）。
 *
 * 用法：node tools/probe_yaw.mjs [--dist=2.2] [--scene=floor3] [--wait=240]
 * 产出：shots/yaw_0.png / yaw_90.png / yaw_180.png / yaw_270.png
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 8095;
const CDP_PORT = 9245;
const BASE = `http://127.0.0.1:${PORT}`;
const argOf = (k, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${k}=`));
  return a ? a.split('=')[1] : d;
};
const SCENE = argOf('scene', 'floor3');
const WAIT = Number(argOf('wait', 240));
const DIST = Number(argOf('dist', 2.2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'yaw_' + Date.now());
fs.mkdirSync(profile, { recursive: true });
const br = spawn(CHROME, [
  '--headless=new', '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
  `--remote-debugging-port=${CDP_PORT}`, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--ignore-gpu-blocklist', '--window-size=1600,900', 'about:blank'
], { stdio: 'ignore' });

function cleanup() {
  try { br.kill(); } catch { /* noop */ }
  try { srv.kill(); } catch { /* noop */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* noop */ }
}

let ws, seq = 0;
const pend = new Map();

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
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params }));
  });
  const E = async (expression) => {
    for (let i = 0; i < 3; i++) {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      const v = r.result?.result?.value;
      if (v !== undefined) return v;
      await sleep(120);
    }
    return {};
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: `${BASE}/gs-viewer.html?scene=${SCENE}&human=1` });
  await sleep(1500);
  for (let i = 0; i < 300; i++) {
    const s = await E(`(()=>{const v=window.__viewer;return !!(v&&v.state&&v.state.loaded)})()`);
    if (s) break;
    await sleep(500);
  }
  let st = null;
  for (let i = 0; i < WAIT * 2; i++) {
    st = await E(`(()=>{const h=window.__mgHuman;return h?{...h.state}:null})()`);
    if (st && st.ready) break;
    await sleep(500);
  }
  console.log('state=' + JSON.stringify(st));

  /* 放置一次，之后只改偏航；setYaw 会关掉自动朝向校正 */
  const CAMROT = Number(argOf('camrot', 0));
  if (CAMROT) {
    /* 先把原场景相机原地转 CAMROT 度，再放置 —— 用来验证「面向相机」公式是否与相机朝向无关 */
    const r = await E(`(()=>{const v=window.__viewer;const c=v.app.root.findComponent('camera');
      c.entity.rotateLocal(0,${CAMROT},0);const e=c.entity.getRotation();
      return {x:+e.x.toFixed(3),y:+e.y.toFixed(3),z:+e.z.toFixed(3),w:+e.w.toFixed(3)};})()`);
    console.log('相机旋转后 quat=' + JSON.stringify(r));
    await sleep(800);
  }
  const base = await E(`(()=>{const h=window.__mgHuman;h.setGait('stand');h.placeInFront(${DIST});
    const y=h.getYaw();h.setYaw(y);return y;})()`);
  console.log('placeInFront 的基准偏航 = ' + base.toFixed(4) + ' rad (' + (base * 180 / Math.PI).toFixed(1) + '°)');
  await sleep(2500);

  if (CAMROT) {
    const shot = await Promise.race([
      send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }),
      sleep(20000).then(() => null)
    ]);
    const out = path.join(ROOT, 'shots', `front_cam${CAMROT}.png`);
    if (shot && shot.result?.data) {
      fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
      console.log('  截图 ' + out);
    } else console.log('  截图失败');
    console.log('诊断=' + JSON.stringify(await E(`(()=>window.__mgHuman.diag())()`)));
    return;
  }

  for (const [name, deg] of [['yaw_0', 0], ['yaw_90', 90], ['yaw_180', 180], ['yaw_270', 270]]) {
    const yaw = base + deg * Math.PI / 180;
    await E(`(()=>{window.__mgHuman.setYaw(${yaw});return 1;})()`);
    await sleep(1500);
    const shot = await Promise.race([
      send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }),
      sleep(20000).then(() => null)
    ]);
    const out = path.join(ROOT, 'shots', name + '.png');
    if (shot && shot.result?.data) {
      fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
      console.log(`  ${name}  yaw=${(yaw * 180 / Math.PI).toFixed(1)}°  ->  ${out}`);
    } else console.log(`  ${name} 截图失败`);
  }
  console.log('诊断=' + JSON.stringify(await E(`(()=>window.__mgHuman.diag())()`)));
}

main()
  .then(() => { cleanup(); process.exit(0); })
  .catch((e) => { console.error('FAILED', e); cleanup(); process.exit(2); });

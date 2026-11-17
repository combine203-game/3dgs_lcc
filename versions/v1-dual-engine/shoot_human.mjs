/**
 * 交付截图脚本：把数字人放回镜头正前方、摆站立姿态，再出一张干净截图。
 *
 * 与 check_human.mjs 的区别：不做断言、只出图，并且会把「人的世界坐标 / 相机坐标 /
 * 屏幕投影」打出来，便于判断「人在不在画面里」。默认 headless（SwiftShader / WASM）。
 *
 * 用法：node tools/shoot_human.mjs [--scene=floor3] [--wait=240] [--dist=3.2] [--out=shots/deliver.png] [--headed]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const argOf = (k, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${k}=`));
  return a ? a.split('=')[1] : d;
};
/* 端口按进程号错开：上一轮的 chrome / serve 在 Windows 上未必能被 kill 掉，
   固定端口会连到旧实例上导致「打开」这一步一直挂着。 */
const PORT = Number(argOf('port', 8300 + (process.pid % 300)));
const CDP_PORT = Number(argOf('cdp', PORT + 1000));
const BASE = `http://127.0.0.1:${PORT}`;
const SCENE = argOf('scene', 'floor3');
const WAIT = Number(argOf('wait', 240));
const DIST = Number(argOf('dist', 3.2));
const OUT = argOf('out', 'shots/deliver.png');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'shoot_' + Date.now());
fs.mkdirSync(profile, { recursive: true });
const HEADED = process.argv.includes('--headed');
const br = spawn(CHROME, [
  ...(HEADED ? [] : ['--headless=new', '--use-gl=swiftshader', '--enable-unsafe-swiftshader']),
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

  const url = `${BASE}/gs-viewer.html?scene=${SCENE}&human=1`;
  console.log('[1] 打开 ' + url);
  await send('Page.navigate', { url });
  await sleep(1500);

  let loaded = false;
  for (let i = 0; i < 300; i++) {
    const s = await E(`(()=>{const v=window.__viewer;return !!(v&&v.state&&v.state.loaded)})()`);
    if (s) { loaded = true; break; }
    await sleep(500);
  }
  console.log('    场景加载=' + loaded);

  let st = null;
  for (let i = 0; i < WAIT * 2; i++) {
    st = await E(`(()=>{const h=window.__mgHuman;return h?{...h.state}:null})()`);
    if (st && st.ready) break;
    await sleep(500);
  }
  console.log('    state=' + JSON.stringify(st));

  /* 放到镜头正前方并站立 */
  const SIZE = Number(argOf('splatsize', 0));
  if (process.argv.includes('--walkfirst')) {
    /* 回归「走过一段路之后按重新放置」：先走 4 s，再放置，看还能不能回到镜头前 */
    await E(`(()=>{window.__mgHuman.setGait('walk');return 1;})()`);
    await sleep(4000);
    const w = await E(`(()=>window.__mgHuman.diag())()`);
    console.log('    走完 4s 位置=' + JSON.stringify(w && w.charPos));
  }
  await E(`(()=>{const h=window.__mgHuman;if(!h)return 0;h.setGait('stand');
    ${SIZE > 0 ? `h.setSplatSize(${SIZE});` : ''}
    h.placeInFront(${DIST});return 1;})()`);
  const YAWADD = Number(argOf('yawadd', 0));
  if (YAWADD) {
    await E(`(()=>{const h=window.__mgHuman;h.setYaw(h.getYaw()+${YAWADD});return 1;})()`);
    console.log('    追加偏航 ' + YAWADD + ' rad');
  }
  await sleep(4000);

  /* 诊断：人在不在画面里 */
  const diag = await E(`(()=>{
    const h=window.__mgHuman, v=window.__viewer;
    const cam=(v&&v.app&&v.app.root&&v.app.root.findComponent('camera'))?v.app.root.findComponent('camera').entity:null;
    const cp=cam?cam.getPosition():null;
    const info=h&&h.diag?h.diag():null;
    return {cam:cp&&{x:+cp.x.toFixed(2),y:+cp.y.toFixed(2),z:+cp.z.toFixed(2)}, diag:info, measure:h&&h.measure?h.measure():null};
  })()`);
  console.log('    诊断=' + JSON.stringify(diag));

  const shot = await Promise.race([
    send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }),
    sleep(20000).then(() => null)
  ]);
  const out = path.join(ROOT, OUT);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (shot && shot.result?.data) {
    fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
    console.log('    截图 ' + out + '  (' + fs.statSync(out).size + ' B)');
  } else {
    console.log('    截图失败');
  }
}

main()
  .then(() => { cleanup(); process.exit(0); })
  .catch((e) => { console.error('FAILED', e); cleanup(); process.exit(2); });

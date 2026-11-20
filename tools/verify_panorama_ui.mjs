#!/usr/bin/env node
/* 全景导出 UI 功能验收：真实 Viewer（不 mock），从展厅页点按钮 → 页内六面
   取帧 → 拼接 PNG → 校验尺寸 / 数据 / 机位恢复 / 零报错。
   用法：node tools/verify_panorama_ui.mjs [--wait=20000]
   结论行：全景功能: PASS / FAIL（供 qa_acceptance.mjs 判定） */
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
const WAIT = Number(argOf('wait', 20000));
const PORT = Number(argOf('port', 8600 + (process.pid % 300)));
const CDP_PORT = PORT + 1000;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'pano_ui_' + Date.now());
fs.mkdirSync(profile, { recursive: true });
const br = spawn(CHROME, [
  '--headless=new', '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
  `--remote-debugging-port=${CDP_PORT}`, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--ignore-gpu-blocklist', '--window-size=1280,800', 'about:blank'
], { stdio: 'ignore' });
function cleanup() {
  try { br.kill(); } catch { /* noop */ }
  try { srv.kill(); } catch { /* noop */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* noop */ }
}
let ws, seq = 0;
const pend = new Map(), errors = [];
const send = (method, params = {}) => new Promise((res) => {
  const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params }));
});
const E = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'evaluate error');
  return r.result?.result?.value;
};

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
    if (o.id && pend.has(o.id)) { pend.get(o.id)(o); pend.delete(o.id); return; }
    if (o.method === 'Runtime.consoleAPICalled' && o.params.type === 'error') {
      errors.push((o.params.args || []).map(a => a.value || a.description || '').join(' ').slice(0, 240));
    }
    if (o.method === 'Runtime.exceptionThrown') {
      errors.push('EXC: ' + (o.params.exceptionDetails?.exception?.description || '').slice(0, 240));
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(WAIT);

  // 等 iframe 里全景模块就绪
  let ready = false;
  for (let i = 0; i < 60; i++) {
    ready = await E(`!!(document.querySelector('iframe.gs-scene-frame')?.contentWindow?.__mgPanorama?.supported)`);
    if (ready) break;
    await sleep(500);
  }
  if (!ready) throw new Error('iframe 内 __mgPanorama 未就绪');

  const ui = await E(`(()=>{const d=document;
    const b=d.getElementById('gsPanoBtn'),p=d.getElementById('gsPanoPanel');
    b?.click();
    return JSON.stringify({btn:!!b,panelOpen:!!p&&!p.hidden,
      res:Array.from(d.getElementById('gsPanoRes')?.options||[]).map(o=>o.value),
      pos:d.getElementById('gsPanoPos')?.textContent||''});})()`);
  console.log('  UI：', ui);

  const before = await E(`JSON.stringify(document.querySelector('iframe.gs-scene-frame').contentWindow.__mgPose?.())`);
  const result = await E(`(async()=>{
    const w=document.querySelector('iframe.gs-scene-frame').contentWindow;
    const r=await w.__mgPanorama.generate({face:256,onProgress:(m)=>{window.__panoMsg=m;}});
    return JSON.stringify({prefix:r.dataUrl.slice(0,22),len:r.dataUrl.length,
      width:r.width,height:r.height,position:r.position,msg:window.__panoMsg});
  })()`);
  const after = await E(`JSON.stringify(document.querySelector('iframe.gs-scene-frame').contentWindow.__mgPose?.())`);
  console.log('  生成：', result);
  console.log('  机位 before/after：', before, '/', after);
  console.log('  页面错误：', errors.length, errors.slice(0, 4));

  let r = null; try { r = JSON.parse(result); } catch { /* noop */ }
  const saveTo = argOf('save', '');
  if (saveTo && r?.dataUrl === undefined) {
    // result 只回传摘要，像素在页面内；需要样图时单独再取一次（小尺寸足够核对方向）
    const raw = await E(`(async()=>{const w=document.querySelector('iframe.gs-scene-frame').contentWindow;
      const x=await w.__mgPanorama.generate({face:256});return x.dataUrl;})()`);
    fs.mkdirSync(path.dirname(path.resolve(ROOT, saveTo)), { recursive: true });
    fs.writeFileSync(path.resolve(ROOT, saveTo), Buffer.from(String(raw).split(',')[1], 'base64'));
    console.log('  样图：', saveTo);
  }
  let p0 = null, p1 = null; try { p0 = JSON.parse(before); p1 = JSON.parse(after); } catch { /* noop */ }
  const moved = p0?.position && p1?.position
    ? Math.hypot(...p0.position.map((v, i) => v - p1.position[i])) : 999;
  const u = JSON.parse(ui);
  const pass = u.btn === true && u.panelOpen === true &&
    JSON.stringify(u.res) === JSON.stringify(['2048', '4096', '8192']) &&
    r?.prefix === 'data:image/png;base64,' && r.len > 100000 &&
    r.width === 1024 && r.height === 512 && moved < 0.15 && errors.length === 0;
  console.log('  机位偏差：', moved.toFixed(3), 'm');
  console.log('  全景功能:', pass ? 'PASS' : 'FAIL');
  cleanup();
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error('  全景功能: FAIL', e); cleanup(); process.exit(1); });

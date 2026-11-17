/**
 * 诊断：引擎深度拾取的两条路径为何结果不同
 * ----------------------------------------------------------------
 * 路径 A（CPU 回读）：viewer.picker().pick(u,v) → pickBuffer.read(immediate) → 世界点
 *   —— 贴面矩形的深度反算走这条。
 * 路径 B（GPU 直读）：viewer.picker().renderView() → 深度纹理 → 贴花 shader 逐像素反算
 *   —— GPU 贴花走这条。
 *
 * 观测到「贴花能出像素，但贴面矩形深度反算退化成 mesh」，
 * 说明两条路径的可用性不一致。本脚本直接对比两条路径的返回。
 *
 * 用法： node tools/diag_pick_paths.mjs [--wait=20000]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 18141;
const CDP_PORT = 9267;
const BASE = `http://127.0.0.1:${PORT}`;
const WAIT = Number((process.argv.find(a => a.startsWith('--wait=')) || '').split('=')[1]) || 20000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)],
  { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'diagpick_' + Date.now());
fs.mkdirSync(profile, { recursive: true });
const br = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--autoplay-policy=no-user-gesture-required',
  '--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader',
  '--window-size=1280,800', 'about:blank'
], { stdio: 'ignore' });

function cleanup() {
  try { br.kill(); } catch { /* noop */ }
  try { srv.kill(); } catch { /* noop */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* noop */ }
}
process.on('exit', cleanup);

let ws, seq = 0;
const pend = new Map();

async function main() {
  for (let i = 0; i < 80; i++) { try { await fetch(BASE + '/'); break; } catch { await sleep(250); } }
  let page = null;
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      page = list.find(t => t.type === 'page');
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
  function send(method, params = {}) {
    return new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  }
  const E = async (expression, timeoutMs = 60000) => {
    try {
      const r = await Promise.race([
        send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
        sleep(timeoutMs).then(() => ({ timeout: true }))
      ]);
      if (r.timeout) return { __timeout: true };
      if (r.result?.exceptionDetails)
        return { __err: (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').slice(0, 500) };
      return r.result?.result?.value;
    } catch (err) { return { __err: String(err) }; }
  };

  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(WAIT);

  const DOC = `(()=>{const f=document.querySelector('iframe.gs-scene-frame[data-active="1"]')||document.querySelector('iframe.gs-scene-frame');return f?f.contentWindow:window;})()`;
  await E(`(()=>{document.getElementById('gsEditorBtn')?.click();return 1})()`);
  await sleep(4000);

  console.log('\n===== 路径 B：GPU 直读 renderView =====');
  const rv = await E(`(()=>{const W=${DOC};
    const v=W.__viewer;const p=v&&(typeof v.picker==='function'?v.picker():v.picker);
    if(!p)return {err:'no-picker'};
    try{const r=p.renderView();
      return r?{ok:1,texture:!!r.texture,width:r.width,height:r.height,renders:r.renders}:{err:'null-view'};
    }catch(e){return {err:'throw:'+e.message};}})()`);
  console.log('  renderView =', JSON.stringify(rv));

  console.log('\n===== 路径 A：CPU 回读 pick（直接调用引擎 picker）=====');
  const pk = await E(`(()=>{const W=${DOC};
    const v=W.__viewer;const p=v&&(typeof v.picker==='function'?v.picker():v.picker);
    if(!p)return {err:'no-picker'};
    const t0=performance.now();
    return p.pick(0.5,0.5).then(r=>({ok:1,ms:Math.round(performance.now()-t0),res:r}))
      .catch(e=>({err:'throw:'+(e&&e.message||e)}));})()`, 90000);
  console.log('  pick(0.5,0.5) =', JSON.stringify(pk));

  console.log('\n===== 路径 A2：pickSurface =====');
  const ps = await E(`(()=>{const W=${DOC};
    const v=W.__viewer;const p=v&&(typeof v.picker==='function'?v.picker():v.picker);
    if(!p)return {err:'no-picker'};
    const t0=performance.now();
    return p.pickSurface(0.5,0.5).then(r=>({ok:1,ms:Math.round(performance.now()-t0),res:r}))
      .catch(e=>({err:'throw:'+(e&&e.message||e)}));})()`, 90000);
  console.log('  pickSurface(0.5,0.5) =', JSON.stringify(ps));

  console.log('\n===== 编辑器 picker：depthUnproject 走的入口 =====');
  const ed = await E(`(()=>{const W=${DOC},ed=W.__mgEditor;
    const pk=ed&&ed.picker;
    return {hasPicker:!!pk, keys:pk?Object.keys(pk):null};})()`);
  console.log('  editor.picker =', JSON.stringify(ed));

  console.log('\n===== 手动调用 editor.picker.pickAsync =====');
  const pa = await E(`(()=>{const W=${DOC},ed=W.__mgEditor;
    const pk=ed&&ed.picker;if(!pk||!pk.pickAsync)return {err:'no-pickAsync'};
    const cv=W.document.querySelector('#mg-stage canvas');const r=cv.getBoundingClientRect();
    const t0=performance.now();
    return pk.pickAsync(r.left+r.width*0.5,r.top+r.height*0.5).then(x=>({ok:1,ms:Math.round(performance.now()-t0),res:x}))
      .catch(e=>({err:'throw:'+(e&&e.message||e)}));})()`, 90000);
  console.log('  pickAsync =', JSON.stringify(pa));

  console.log('\n===== 探针内部是否可达 editor.decalMgr =====');
  const dm = await E(`(()=>{const W=${DOC},ed=W.__mgEditor;
    const m=ed&&ed.decalMgr;
    return m&&m.debug?m.debug():null;})()`);
  console.log('  decalMgr.debug =', JSON.stringify(dm && {
    pickReady: dm.pickReady, pickSize: dm.pickSize, degraded: dm.degraded,
    gpuErrors: dm.gpuErrors
  }));
}

main().then(() => { cleanup(); process.exit(0); })
  .catch(e => { console.error('诊断失败:', e.message || e); cleanup(); process.exit(2); });

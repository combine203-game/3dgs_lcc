/**
 * 诊断：VertexState 错误到底来自贴花还是引擎自身
 * ----------------------------------------------------------------
 * 贴花的 GPU 错误钩子挂在 device 的全局 'uncapturederror' 上 —— 引擎任何
 * pipeline 出错都会让贴花降级隐藏。要判断这条
 *   "Vertex attribute slot 0 used in vertexMain is not present in the VertexState"
 * 是不是贴花自己的问题，必须做对照：
 *   组 A：进入编辑态，不注入任何贴花 → 若仍报错，说明是引擎自身的，与贴花无关
 *   组 B：注入贴花 → 看错误数是否增加
 *
 * 用法： node tools/diag_decal_vertexsource.mjs [--headed] [--wait=20000]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 18145;
const CDP_PORT = 9271;
const BASE = `http://127.0.0.1:${PORT}`;
const WAIT = Number((process.argv.find(a => a.startsWith('--wait=')) || '').split('=')[1]) || 20000;
const HEADED = process.argv.includes('--headed');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)],
  { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'diagvtxsrc_' + Date.now());
fs.mkdirSync(profile, { recursive: true });
const br = spawn(CHROME, [
  ...(HEADED ? [] : ['--headless=new']),
  `--remote-debugging-port=${CDP_PORT}`, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--autoplay-policy=no-user-gesture-required',
  ...(HEADED ? ['--enable-unsafe-webgpu'] : ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader']),
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
const gpuErrors = [];

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
    if (o.id && pend.has(o.id)) { pend.get(o.id)(o); pend.delete(o.id); return; }
    const txt = (o.params?.args || []).map(a => a.value ?? a.description ?? '').join(' ');
    if (o.method === 'Runtime.consoleAPICalled' && o.params.type === 'error') {
      gpuErrors.push(txt.replace(/\s+/g, ' ').slice(0, 180));
    }
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
        return { __err: (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').slice(0, 400) };
      return r.result?.result?.value;
    } catch (err) { return { __err: String(err) }; }
  };

  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(WAIT);
  const DOC = `(()=>{const f=document.querySelector('iframe.gs-scene-frame[data-active="1"]')||document.querySelector('iframe.gs-scene-frame');return f?f.contentWindow:window;})()`;

  console.log('\n===== 组 A：进入编辑态（不注入贴花）=====');
  const before = gpuErrors.length;
  await E(`(()=>{document.getElementById('gsEditorBtn')?.click();return 1})()`);
  await sleep(8000);
  const dbgA = await E(`(()=>{const W=${DOC},m=W.__mgEditor?.decalMgr;
    return m&&m.debug?m.debug():null;})()`);
  console.log('  编辑器已挂载');
  console.log('  贴花管理器实例数 =', dbgA?.instances?.length ?? 'n/a');
  console.log('  期间新增 console.error =', gpuErrors.length - before);
  console.log('  decalMgr 诊断 =', JSON.stringify({
    degraded: dbgA?.degraded, gpuErrors: dbgA?.gpuErrors, pickReady: dbgA?.pickReady
  }));
  if (gpuErrors.length > before) {
    console.log('  ---- 无贴花时的错误 ----');
    gpuErrors.slice(before).slice(0, 6).forEach(e => console.log('   * ' + e));
  }

  console.log('\n===== 组 B：注入贴花 =====');
  const beforeB = gpuErrors.length;
  const inj = await E(`(()=>{const W=${DOC},ed=W.__mgEditor;
    if(!ed)return 'no-editor';
    const list=ed.store.list();
    for(const a of list){if(a.kind==='decal'&&a.visible!==false)ed.store.update(a.id,{visible:false});}
    const tpl=list.find(a=>a.kind==='decal');if(!tpl)return 'no-template';
    const c=JSON.parse(JSON.stringify(tpl));
    c.id='vtx-decal-'+Date.now();c.visible=true;
    c.projector={position:[0,1.22,7.7],quaternion:[-0.7071,0,0,0.7071],half:[4,3,1.2],depth:2.4};
    ed.store.add(c);return c.id;})()`);
  console.log('  注入 =', inj);
  await sleep(6000);
  const dbgB = await E(`(()=>{const W=${DOC},m=W.__mgEditor?.decalMgr;
    return m&&m.debug?m.debug():null;})()`);
  console.log('  期间新增 console.error =', gpuErrors.length - beforeB);
  console.log('  decalMgr 诊断 =', JSON.stringify({
    degraded: dbgB?.degraded, gpuErrors: dbgB?.gpuErrors,
    pickReady: dbgB?.pickReady, instanceCount: dbgB?.instances?.length
  }));
  if (gpuErrors.length > beforeB) {
    console.log('  ---- 注入贴花后的错误 ----');
    gpuErrors.slice(beforeB).slice(0, 8).forEach(e => console.log('   * ' + e));
  }
}

main().then(() => { cleanup(); process.exit(0); })
  .catch(e => { console.error('诊断失败:', e.message || e); cleanup(); process.exit(2); });

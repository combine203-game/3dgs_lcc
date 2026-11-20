/**
 * 贴花性能诊断：室内场景，量化全屏 quad shader 的帧时间开销
 * ----------------------------------------------------------------
 * 对比三态帧间隔（rAF 中位/p90）：
 *   A 贴花可见 + depthMode=1（52 值排序慢路径）
 *   B 贴花可见 + depthMode=0（单 texel 中位快路径）
 *   C 贴花隐藏
 * 同时记录 OBB half 尺寸、instances、degraded、gpuErrors。
 *
 * 用法： node tools/diag_decal_perf.mjs --headed --wait=22000
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 18147, CDP_PORT = 9273;
const BASE = `http://127.0.0.1:${PORT}`;
const WAIT = Number((process.argv.find(a => a.startsWith('--wait=')) || '').split('=')[1]) || 22000;
const HEADED = process.argv.includes('--headed');
const LOG = path.join(ROOT, 'tools', 'diag-decal-perf.log');
fs.writeFileSync(LOG, '');
const log = s => { console.log(s); fs.appendFileSync(LOG, s + '\n'); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'perf_' + Date.now());
fs.mkdirSync(profile, { recursive: true });
const br = spawn(CHROME, [
  ...(HEADED ? [] : ['--headless=new']),
  `--remote-debugging-port=${CDP_PORT}`, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--autoplay-policy=no-user-gesture-required',
  ...(HEADED ? ['--enable-unsafe-webgpu'] : ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader']),
  '--window-size=1280,800', 'about:blank'
], { stdio: 'ignore' });
function cleanup() { try { br.kill(); } catch {} try { srv.kill(); } catch {} try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} }
process.on('exit', cleanup); process.on('SIGINT', () => { cleanup(); process.exit(130); });

let ws, seq = 0; const pend = new Map(); const errors = [];
function send(method, params = {}) { return new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); }); }

async function main() {
  for (let i = 0; i < 80; i++) { try { await fetch(BASE + '/'); break; } catch { await sleep(250); } }
  let page = null;
  for (let i = 0; i < 80; i++) {
    try { const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); page = list.find(t => t.type === 'page'); if (page) break; } catch {}
    await sleep(300);
  }
  if (!page) throw new Error('CDP 不可达');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = e => {
    const o = JSON.parse(e.data);
    if (o.id && pend.has(o.id)) { pend.get(o.id)(o); pend.delete(o.id); return; }
    if (o.method === 'Runtime.exceptionThrown') errors.push(o.params.exceptionDetails?.exception?.description || '');
    else if (o.method === 'Runtime.consoleAPICalled' && o.params.type === 'error') errors.push((o.params.args || []).map(a => a.value || '').join(' '));
  };
  const E = async (expression, timeoutMs = 60000) => {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
      sleep(timeoutMs).then(() => ({ timeout: true }))
    ]);
    if (r.timeout) return { __timeout: true };
    if (r.result?.exceptionDetails) return { __err: (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').slice(0, 500) };
    return r.result?.result?.value;
  };
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');

  const URL = BASE + '/?view=floor-1.html&edit=1&nocache=1';
  log('导航 = ' + URL);
  await send('Page.navigate', { url: URL });
  await sleep(WAIT + 5000);

  const DOC = `(()=>{const f=document.querySelector('iframe.gs-scene-frame[data-active="1"]')||document.querySelector('iframe.gs-scene-frame');return f?f.contentWindow:window;})()`;
  const mounted = await E(`(()=>!!(${DOC}).__mgEditor)()`);
  log('编辑器挂载 = ' + mounted);
  if (!mounted) { log('FAIL 编辑器未挂载'); log('JS错误=' + JSON.stringify(errors.slice(0,5))); return; }

  // 确保 demo_decal 生成 projector（用上次修复后的分位数逻辑）
  await E(`(()=>{const W=${DOC},ed=W.__mgEditor;ed.action('decal-rebuild','demo_decal');return 1;})()`);
  await sleep(6000);

  const st0 = await E(`(()=>{const W=${DOC},ed=W.__mgEditor;const a=ed.store.get('demo_decal');const m=ed.decalMgr;const d=m&&m.debug?m.debug():null;return {hasProj:!!a?.projector,half:a?.projector?.half,instances:d?.instances?.length,pickReady:d?.pickReady,degraded:d?.degraded,gpuErrors:d?.gpuErrors};})()`);
  log('贴花状态 = ' + JSON.stringify(st0));

  // 帧间隔测量函数（在 iframe window 上下文里跑 rAF）
  const measure = async (label) => {
    const r = await E(`(async()=>{
      const W=${DOC};
      const times=[]; let last=W.performance.now();
      for(let i=0;i<24;i++){
        await new Promise(res=>W.requestAnimationFrame(res));
        const now=W.performance.now(); times.push(now-last); last=now;
      }
      times.sort((a,b)=>a-b);
      return {min:+times[0].toFixed(1),med:+times[12].toFixed(1),p90:+times[21].toFixed(1),max:+times[23].toFixed(1)};
    })()`, 90000);
    log(label + ' 帧间隔ms = ' + JSON.stringify(r));
    return r;
  };

  log('\n===== A. 贴花可见 + depthMode=1（52 值排序）=====');
  await E(`(()=>{const W=${DOC},ed=W.__mgEditor;ed.store.update('demo_decal',{visible:true,depthMode:1});return 1;})()`);
  await sleep(1200);
  const A = await measure('A');

  log('\n===== B. 贴花可见 + depthMode=0（单 texel 中位）=====');
  await E(`(()=>{const W=${DOC},ed=W.__mgEditor;ed.store.update('demo_decal',{depthMode:0});return 1;})()`);
  await sleep(1200);
  const B = await measure('B');

  log('\n===== C. 贴花隐藏 =====');
  await E(`(()=>{const W=${DOC},ed=W.__mgEditor;ed.store.update('demo_decal',{visible:false});return 1;})()`);
  await sleep(1200);
  const C = await measure('C');

  log('\n===== 结论 =====');
  log('A(排序,可见) med=' + A.med + '  B(中位,可见) med=' + B.med + '  C(隐藏) med=' + C.med);
  const d = await E(`(()=>{const W=${DOC},m=W.__mgEditor.decalMgr;const x=m&&m.debug?m.debug():null;return {degraded:x?.degraded,gpuErrors:x?.gpuErrors,scopedErrors:x?.scopedErrors,foreignErrors:x?.foreignErrors};})()`);
  log('最终 GPU 状态 = ' + JSON.stringify(d));
  log('JS 错误数 = ' + errors.length + ' ' + JSON.stringify(errors.slice(0, 3)));
  ws.close();
}
main().catch(e => { log('FAIL ' + (e && e.stack || e)); process.exitCode = 1; });

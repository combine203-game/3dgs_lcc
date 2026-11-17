/**
 * 诊断：VertexState 错误是否由贴花的绘制触发
 * ----------------------------------------------------------------
 * 已确认：贴花自己的 pipeline 是 float32x2:L0（location 0 存在，VertexState 合法），
 * 引擎自己的 pipeline 是 float32x3:L0。但真机上仍报
 *   "Vertex attribute slot 0 used in vertexMain is not present in the VertexState"
 *
 * 本脚本做三组对照，判定错误归属：
 *   组 1：编辑器挂载，不注入贴花 → 观察错误
 *   组 2：注入贴花但 **visible=false**（贴花不绘制）→ 观察错误
 *   组 3：注入贴花且 visible=true（贴花绘制）→ 观察错误
 * 若 1/2 无错、3 有错 → 错误由贴花的绘制路径触发（但 pipeline 合法，
 *   则多半是「贴花与引擎某 mesh 共用 pipeline 缓存 / vertex buffer slot 冲突」）；
 * 若 1 就有错 → 与贴花无关，是引擎自身问题。
 *
 * 用法： node tools/diag_decal_attrib.mjs [--headed] [--wait=20000]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 18151;
const CDP_PORT = 9277;
const BASE = `http://127.0.0.1:${PORT}`;
const WAIT = Number((process.argv.find(a => a.startsWith('--wait=')) || '').split('=')[1]) || 20000;
const HEADED = process.argv.includes('--headed');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)],
  { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'diagattr_' + Date.now());
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
const errors = [];

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
      errors.push(txt.replace(/\s+/g, ' ').slice(0, 200));
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

  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(WAIT);
  const DOC = `(()=>{const f=document.querySelector('iframe.gs-scene-frame[data-active="1"]')||document.querySelector('iframe.gs-scene-frame');return f?f.contentWindow:window;})()`;
  const dbg = async () => {
    const v = await E(`(()=>{const W=${DOC},m=W.__mgEditor?.decalMgr;
      return m&&m.debug?m.debug():null;})()`);
    return v && !v.__err ? v : null;
  };

  const mark = async (n) => {
    const d = await dbg();
    console.log('  [' + n + '] gpuErrors =', d?.gpuErrors, ' degraded =', d?.degraded,
      ' 实例数 =', d?.instances?.length ?? 0);
  };

  console.log('\n===== 组 1：编辑器挂载，不注入贴花 =====');
  await E(`(()=>{document.getElementById('gsEditorBtn')?.click();return 1})()`);
  await sleep(10000);
  const n1 = errors.length;
  await mark('组1');
  console.log('  新增错误 =', n1);
  errors.slice(0, n1).slice(0, 3).forEach(e => console.log('   * ' + e));

  console.log('\n===== 组 2：注入贴花，visible=false（不绘制）=====');
  const e2 = errors.length;
  const inj = await E(`(()=>{const W=${DOC},ed=W.__mgEditor;
    const list=ed.store.list();
    for(const a of list){if(a.kind==='decal'&&a.visible!==false)ed.store.update(a.id,{visible:false});}
    const tpl=list.find(a=>a.kind==='decal');if(!tpl)return 'no-template';
    const c=JSON.parse(JSON.stringify(tpl));
    c.id='attr-decal-'+Date.now();c.visible=false;
    c.rect=[0.34,0.52,0.56,0.72];c.projector=null;c.surface=null;
    c.media=[{type:'video',url:'',caption:'演示'}];
    ed.store.add(c);return c.id;})()`);
  const ID = String(inj);
  console.log('  注入 =', ID, ' (visible=false)');
  await E(`(()=>{const W=${DOC},ed=W.__mgEditor;ed.action('decal-rebuild','${ID}');return 1;})()`);
  await sleep(10000);
  await mark('组2');
  console.log('  新增错误 =', errors.length - e2);
  errors.slice(e2).slice(0, 3).forEach(e => console.log('   * ' + e));

  console.log('\n===== 组 3：贴花 visible=true（真正绘制）=====');
  const e3 = errors.length;
  await E(`(()=>{const W=${DOC},ed=W.__mgEditor;ed.store.update('${ID}',{visible:true});return 1;})()`);
  await sleep(10000);
  await mark('组3');
  console.log('  新增错误 =', errors.length - e3);
  errors.slice(e3).slice(0, 3).forEach(e => console.log('   * ' + e));
}

main().then(() => { cleanup(); process.exit(0); })
  .catch(e => { console.error('诊断失败:', e.message || e); cleanup(); process.exit(2); });

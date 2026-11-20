/**
 * 无头诊断：观察 decal 注入后 projector 写回的时间序列，定位「状态栏成功但标注 projector:null」。
 * 只读观察，不改产品代码。用法：node tools/diag_headless_projector.mjs [--wait=22000]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 18161, CDP_PORT = 9281, BASE = `http://127.0.0.1:${PORT}`;
const WAIT = Number((process.argv.find(a => a.startsWith('--wait=')) || '').split('=')[1]) || 22000;
const LOG = path.join(ROOT, 'tools', 'diag-headless-projector.log');
fs.writeFileSync(LOG, '');
const log = s => { console.log(s); fs.appendFileSync(LOG, s + '\n'); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'hlproj_' + Date.now());
fs.mkdirSync(profile, { recursive: true });
const br = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`,
  '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader',
  '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });
function cleanup() { try { br.kill(); } catch {} try { srv.kill(); } catch {} try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} }
process.on('exit', cleanup); process.on('SIGINT', () => { cleanup(); process.exit(130); });
let ws, seq = 0; const pend = new Map(); const errors = [];
function send(method, params = {}) { return new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); }); }
async function main() {
  for (let i = 0; i < 80; i++) { try { await fetch(BASE + '/'); break; } catch { await sleep(250); } }
  let page = null;
  for (let i = 0; i < 80; i++) { try { const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); page = l.find(t => t.type === 'page'); if (page) break; } catch {} await sleep(300); }
  if (!page) throw new Error('CDP 不可达');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = e => { const o = JSON.parse(e.data); if (o.id && pend.has(o.id)) { pend.get(o.id)(o); pend.delete(o.id); return; } if (o.method === 'Runtime.exceptionThrown') errors.push((o.params.exceptionDetails?.exception?.description || o.params.exceptionDetails?.text || '').slice(0, 300)); };
  const E = async (expression, timeoutMs = 60000) => { const r = await Promise.race([send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }), sleep(timeoutMs).then(() => ({ timeout: true }))]); if (r.timeout) return { __timeout: true }; if (r.result?.exceptionDetails) return { __err: (r.result.exceptionDetails.exception?.description || '').slice(0, 700) }; return r.result?.result?.value; };
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Page.navigate', { url: BASE + '/?view=floor-1.html&edit=1&nocache=1' });
  await sleep(WAIT);
  const DOC = `(()=>{const f=document.querySelector('iframe.gs-scene-frame[data-active="1"]')||document.querySelector('iframe.gs-scene-frame');return f?f.contentWindow:window;})()`;
  log('编辑器挂载 = ' + await E(`(()=>!!(${DOC}).__mgEditor)()`));

  const dump = async (tag) => {
    const s = await E(`(()=>{const W=${DOC},ed=W.__mgEditor;
      const decs=ed.store.list().filter(a=>a.kind==='decal').map(a=>({
        id:a.id, visible:a.visible, locked:!!a.locked,
        rect:a.rect, hasProj:!!a.projector,
        shadowHits:a.projector&&a.projector.shadow?a.projector.shadow.hits:null,
        half:a.projector?a.projector.half:null
      }));
      const st=W.document.querySelector('[data-role="status"]');
      const dbg=ed.decalMgr&&typeof ed.decalMgr.debug==='function'?ed.decalMgr.debug():null;
      return {decs, status:st?st.textContent:'(无)',
        instances:dbg?dbg.instances.map(i=>({id:i.id,visible:i.visible,hasProjector:i.hasProjector,shadowReady:i.shadowReady})):null};
    })()`);
    log(`\n--- ${tag} ---\n` + JSON.stringify(s, null, 1));
  };
  await dump('T0 注入前');

  const SEL = [0.45, 0.4, 0.55, 0.55];
  const inject = await E(`(()=>{const W=${DOC},ed=W.__mgEditor;
    const list=ed.store.list();
    let tpl=list.find(a=>a.kind==='decal');
    if(!tpl)return 'no-template';
    const c=JSON.parse(JSON.stringify(tpl));
    c.id='real-decal-'+Date.now();c.title='realpath';c.visible=false;
    c.rect=${JSON.stringify(SEL)};c.projector=null;c.surface=null;
    ed.store.add(c);
    return c.id;})()`);
  log('\n注入 id = ' + inject);
  const ID = String(inject);
  await sleep(1500);
  await dump('T1 注入后 1.5s');

  const rb = await E(`(()=>{const W=${DOC},ed=W.__mgEditor;ed.action('decal-rebuild','${ID}');return 1;})()`);
  log('\n触发 rebuild = ' + JSON.stringify(rb));
  for (let k = 1; k <= 8; k++) {
    await sleep(1500);
    const p = await E(`(()=>{const W=${DOC},ed=W.__mgEditor;const a=ed.store.get('${ID}');
      return a&&a.projector?{half:a.projector.half,hits:a.projector.shadow&&a.projector.shadow.hits}:null;})()`);
    log(`T2+${k * 1.5}s projector = ` + JSON.stringify(p));
    if (p) break;
  }
  await dump('T3 最终');
  log('\nJS 错误 = ' + JSON.stringify(errors));
  ws.close();
}

main().then(() => { setTimeout(() => process.exit(0), 300); }).catch(e => { log('脚本失败: ' + (e?.stack || e)); setTimeout(() => process.exit(1), 300); });

/**
 * 无头诊断：用页面内 canvas.toDataURL() 读帧（不走 CDP 合成器截图），验证贴花是否真的产出像素。
 * 对比 visible / hidden 两态在框选区的像素差，同时观察是否触发 VertexState 错误。
 * 用法：node tools/diag_canvas_readback.mjs [--wait=22000] [--rect=...]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 18163, CDP_PORT = 9283, BASE = `http://127.0.0.1:${PORT}`;
const WAIT = Number((process.argv.find(a => a.startsWith('--wait=')) || '').split('=')[1]) || 22000;
const RECT = '0.55,0.3,0.72,0.45';
const LOG = path.join(ROOT, 'tools', 'diag-canvas-readback.log');
fs.writeFileSync(LOG, '');
const log = s => { console.log(s); fs.appendFileSync(LOG, s + '\n'); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'canvasrb_' + Date.now());
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
  const E = async (expression, timeoutMs = 90000) => { const r = await Promise.race([send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }), sleep(timeoutMs).then(() => ({ timeout: true }))]); if (r.timeout) return { __timeout: true }; if (r.result?.exceptionDetails) return { __err: (r.result.exceptionDetails.exception?.description || '').slice(0, 700) }; return r.result?.result?.value; };
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Page.navigate', { url: BASE + '/?view=floor-1.html&edit=1&nocache=1' });
  await sleep(WAIT);
  const DOC = `(()=>{const f=document.querySelector('iframe.gs-scene-frame[data-active="1"]')||document.querySelector('iframe.gs-scene-frame');return f?f.contentWindow:window;})()`;
  log('编辑器挂载 = ' + await E(`(()=>!!(${DOC}).__mgEditor)()`));

  const inject = await E(`(()=>{const W=${DOC},ed=W.__mgEditor;
    const list=ed.store.list();let tpl=list.find(a=>a.kind==='decal');
    if(!tpl)return 'no-template';const c=JSON.parse(JSON.stringify(tpl));
    c.id='rb-decal-'+Date.now();c.title='rb';c.visible=false;
    c.rect=${JSON.stringify(RECT.split(',').map(Number))};c.projector=null;c.surface=null;
    ed.store.add(c);return c.id;})()`);
  const ID = String(inject);
  log('注入 = ' + ID);
  await E(`(()=>{const W=${DOC},ed=W.__mgEditor;ed.action('decal-rebuild','${ID}');return 1;})()`);
  let proj = null;
  for (let i = 0; i < 40; i++) {
    proj = await E(`(()=>{const W=${DOC},ed=W.__mgEditor;const a=ed.store.get('${ID}');return a&&a.projector?true:false;})()`);
    if (proj === true) break;
    await sleep(1000);
  }
  log('投影机生成 = ' + proj);
  if (proj !== true) throw new Error('投影机未生成');

  // 用 toDataURL 读 canvas：在页面内用 2D canvas drawImage + getImageData 统计框选区
  const grab = async (visible, tag) => {
    await E(`(()=>{const W=${DOC},ed=W.__mgEditor;ed.store.update('${ID}',{visible:${visible}});return 1;})()`);
    await sleep(1500);
    const r = await E(`(async()=>{
      const W=${DOC};
      const cv=W.document.querySelector('#mg-stage canvas');
      if(!cv)return {err:'no-canvas'};
      const R=${JSON.stringify(RECT.split(',').map(Number))};
      const rect=cv.getBoundingClientRect();
      const sx=Math.round(R[0]*cv.width), sy=Math.round(R[1]*cv.height);
      const sw=Math.round((R[2]-R[0])*cv.width), sh=Math.round((R[3]-R[1])*cv.height);
      // WebGPU canvas 不能 drawImage 到 2D（安全限制），直接 toDataURL 再解码
      const url=cv.toDataURL('image/png');
      return {url, cw:cv.width, ch:cv.height, sx, sy, sw, sh, rect:[rect.width,rect.height]};
    })()`);
    if (r && r.url && r.url.startsWith('data:image/png')) {
      const b64 = r.url.split(',')[1];
      fs.writeFileSync(path.join(ROOT, 'tools', `rb-${tag}.png`), Buffer.from(b64, 'base64'));
      log(`[${tag}] canvas=${r.cw}x${r.ch} 框选=[${r.sx},${r.sy},${r.sw},${r.sh}] PNG字节=${b64.length}`);
      return r;
    }
    log(`[${tag}] 读帧失败 = ` + JSON.stringify(r));
    return null;
  };
  const vis = await grab(true, 'visible');
  const hid = await grab(false, 'hidden');
  const dbg = await E(`(()=>{const W=${DOC},m=W.__mgEditor.decalMgr;return m&&m.debug?m.debug():null;})()`);
  log('诊断 = ' + JSON.stringify({ gpuErrors: dbg?.gpuErrors, degraded: dbg?.degraded, instances: dbg?.instances?.length }));
  log('JS 错误 = ' + JSON.stringify(errors.slice(-6)));
  ws.close();
}
main().then(() => { setTimeout(() => process.exit(0), 300); }).catch(e => { log('脚本失败: ' + (e?.stack || e)); setTimeout(() => process.exit(1), 300); });

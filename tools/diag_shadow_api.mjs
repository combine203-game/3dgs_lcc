/**
 * 可行性探针：验证能否在「不改 bundle」的前提下，用反射拿到构造
 * 正交虚拟相机 + RenderTarget 深度图所需的引擎类。
 *
 * 目标：确认 __viewer.app / __pc 里能拿到
 *   - Entity 构造器 (app.root.constructor)
 *   - RenderTarget 构造器（从现有 camera.renderTarget 或 frameDepthTexture 的 target 反射）
 *   - Layer 构造器 + app.scene.layers
 *   - camera component 正交投影常量 PROJECTION_ORTHOGRAPHIC=1
 *   - 碰撞 mesh 三角面数量级
 * 只做只读反射 + 打印，不改任何场景状态。
 *
 * 用法：node tools/diag_shadow_api.mjs [--headed] [--wait=22000]
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
const LOG = path.join(ROOT, 'tools', 'diag-shadow-api.log');
fs.writeFileSync(LOG, '');
const log = s => { console.log(s); fs.appendFileSync(LOG, s + '\n'); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'shadowapi_' + Date.now());
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
  const E = async (expression, timeoutMs = 45000) => {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
      sleep(timeoutMs).then(() => ({ timeout: true }))
    ]);
    if (r.timeout) return { __timeout: true };
    if (r.result?.exceptionDetails) return { __err: (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').slice(0, 600) };
    return r.result?.result?.value;
  };
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');

  const URL = BASE + '/?view=floor-1.html&edit=1&nocache=1';
  log('导航 = ' + URL);
  await send('Page.navigate', { url: URL });
  await sleep(WAIT + 4000);

  const DOC = `(()=>{const f=document.querySelector('iframe.gs-scene-frame[data-active="1"]')||document.querySelector('iframe.gs-scene-frame');return f?f.contentWindow:window;})()`;
  const mounted = await E(`(()=>!!(${DOC}).__viewer)()`);
  log('viewer 挂载 = ' + mounted);

  const probe = await E(`(()=>{
    const W = ${DOC}, v = W.__viewer, pc = W.__pc;
    const out = {};
    out.hasViewer = !!v;
    out.viewerKeys = v ? Object.keys(v).filter(k=>/renderer|app|picker|collis|scene|splat|capture/i.test(k)) : [];
    out.hasPc = !!pc;
    out.pcKeys = pc ? Object.keys(pc) : [];
    const app = v && v.app;
    out.hasApp = !!app;
    if (app) {
      out.rootCtor = app.root && app.root.constructor && app.root.constructor.name;
      out.appKeys = Object.keys(app).filter(k=>/render|scene|layer|graph/i.test(k)).slice(0,30);
      const cam = app.root && app.root.findComponent && app.root.findComponent('camera');
      out.hasCam = !!cam;
      if (cam) {
        out.camCtor = cam.constructor && cam.constructor.name;
        out.camProps = ['projection','orthoHeight','nearClip','farClip','renderTarget','layers','aspectRatioMode'].map(k=>k+'='+JSON.stringify(cam[k]));
        const rt = cam.renderTarget;
        out.camRenderTarget = rt ? {ctor: rt.constructor && rt.constructor.name, keys: Object.keys(rt).slice(0,20)} : null;
      }
      const sc = app.scene;
      out.hasScene = !!sc;
      if (sc) {
        out.layerCount = sc.layers && sc.layers.length;
        if (sc.layers && sc.layers[0]) {
          out.layerCtor = sc.layers[0].constructor && sc.layers[0].constructor.name;
          out.layer0Name = sc.layers[0].name;
        }
      }
      const dev = app.graphicsDevice;
      out.deviceType = dev && dev.deviceType;
      out.backBufferCtor = dev && dev.backBuffer && dev.backBuffer.constructor && dev.backBuffer.constructor.name;
    }
    const col = v && v.collision && v.collision();
    if (col) {
      out.collisionCtor = col.constructor && col.constructor.name;
      out.trisCount = col.triangles ? col.triangles.count : null;
      out.collisionKeys = Object.keys(col).slice(0,20);
    }
    return out;
  })()`);
  log('\n===== 反射能力探测 =====');
  log(JSON.stringify(probe, null, 2));

  log('\n===== JS 错误 =====');
  log(JSON.stringify(errors.slice(0, 8), null, 2));
}
main().catch(e => log('FATAL ' + (e && e.stack || e))).finally(() => { try { ws && ws.close(); } catch {} setTimeout(() => process.exit(0), 300); });

/**
 * 可行性探针（只读反射 + 一次离屏正交深度渲染，不改产品代码）：
 * 验证「虚拟正交相机渲染 3DGS 场景得到 GPU 深度图」这条路线是否可落地。
 *
 * 三道门槛：
 *  G1. 能否从反射拿到 gsplatDirector / prepareForPicking，以及它的排序缓存是否绑定主相机。
 *  G2. 能否构造一个正交 camera entity（__pc.Entity + PROJECTION_ORTHOGRAPHIC + RenderTarget），
 *      并让 app 用它跑一次 pick pass，产出非全 1 的深度纹理。
 *  G3. pick pass 深度是 4 通道伯努利随机（每次以 alpha 概率写深度/否则 1.0）。
 *      采样同一正交视图多次，检查 4 通道是否抖动 -> 判断 shadow map 是否需要确定性口径改造。
 *
 * 用法：node tools/diag_ortho_depth_feasibility.mjs [--headed] [--wait=20000]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 18179, CDP_PORT = 9291, BASE = `http://127.0.0.1:${PORT}`;
const WAIT = Number((process.argv.find(a => a.startsWith('--wait=')) || '').split('=')[1]) || 20000;
const HEADED = process.argv.includes('--headed');
const LOG = path.join(ROOT, 'tools', 'diag-ortho-depth-feasibility.log');
fs.writeFileSync(LOG, '');
const log = s => { console.log(s); fs.appendFileSync(LOG, s + '\n'); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'orthodepth_' + Date.now());
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
    if (r.result?.exceptionDetails) return { __err: (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').slice(0, 800) };
    return r.result?.result?.value;
  };
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');

  // 强制 WebGL2：避开 WebGPU 帧外 readPixels 的 Dawn 错误，这里只验证管线可达性
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `try{sessionStorage.setItem('mg_fallback','1')}catch(e){}` });
  const URL = BASE + '/?view=floor-1.html&edit=1&nocache=1';
  log('导航 = ' + URL);
  await send('Page.navigate', { url: URL });
  await sleep(WAIT + 4000);

  const DOC = `(()=>{const f=document.querySelector('iframe.gs-scene-frame[data-active="1"]')||document.querySelector('iframe.gs-scene-frame');return f?f.contentWindow:window;})()`;
  const mounted = await E(`(()=>!!(${DOC}).__viewer)()`);
  log('viewer 挂载 = ' + JSON.stringify(mounted));

  // ---- G1: gsplatDirector / prepareForPicking 可达性 ----
  const g1 = await E(`(()=>{
    const W=${DOC}, v=W.__viewer, app=v&&v.app, out={};
    out.deviceType = app && app.graphicsDevice && app.graphicsDevice.deviceType;
    const r = app && app.renderer;
    out.rendererKeys = r ? Object.keys(r).filter(k=>/gsplat|sort|splat|render|layer/i.test(k)).slice(0,40) : null;
    out.gsplatDirector = !!(r && r.gsplatDirector);
    const gd = r && r.gsplatDirector;
    if (gd) {
      out.gdCtor = gd.constructor && gd.constructor.name;
      out.gdMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(gd)).filter(k=>/pick|prepare|render/i.test(k)).slice(0,40);
      out.hasPrepareForPicking = typeof gd.prepareForPicking === 'function';
    }
    return out;
  })()`);
  log('\n===== G1: gsplatDirector 可达性 =====\n' + JSON.stringify(g1, null, 2));

  // ---- G2: 构造正交相机 + 用现有 picker.renderView 拿主相机深度做对照 ----
  // 说明：Picker 类在 bundle 内、renderView 绑定主相机；外部无法直接给它换相机。
  // 这里先验证「渲染环境里正交相机 entity 能建、depth RT 能建」，作为改造前置条件。
  const g2 = await E(`(()=>{
    const W=${DOC}, v=W.__viewer, app=v&&v.app, pc=W.__pc, out={};
    if (!app || !pc) { out.error='no app/pc'; return out; }
    try {
      const cam = new pc.Entity('probe-ortho-cam');
      cam.addComponent('camera', {
        projection: pc.PROJECTION_ORTHOGRAPHIC,
        orthoHeight: 2, nearClip: 0.01, farClip: 20,
        clearColorBuffer: false, clearDepthBuffer: true, priority: -50
      });
      app.root.addChild(cam);
      out.camBuilt = true;
      out.projection = cam.camera.projection;
      out.orthoHeight = cam.camera.orthoHeight;
      const depthTex = new pc.Texture(app.graphicsDevice, {
        width:32, height:32, format:pc.PIXELFORMAT_DEPTH,
        mipmaps:false, minFilter:pc.FILTER_NEAREST, magFilter:pc.FILTER_NEAREST
      });
      const dv = new pc.RenderTarget({
        depthBuffer: depthTex, samples:1,
        origin: pc.RENDERTARGET_ORIGIN_NATIVE, autoResolve:false
      });
      out.depthRTBuilt = !!dv;
      // 把相机放到场景中心、朝下看（正交投影仪视角），准备喂给排序管线
      cam.setPosition(0, 20, 0);
      cam.lookAt(0, 0, 0);
      out.camPose = { pos: cam.getPosition().toString(), fwd: cam.forward.toString() };

      // 关键测试：gsplat 排序/投影管线能否接受这台正交相机
      // prepareForPicking(camera, width, height, layer) 内部用 camera.node + camera.projection
      try {
        const r = app.renderer, gd = r && r.gsplatDirector;
        const worldLayer = app.scene.layers.getLayerByName('World');
        out.usesGpuSort = r ? r.usesGpuSort : null;
        out.orthoHasNode = !!cam.camera.node;
        out.worldLayerFound = !!worldLayer;
        // 对照：用主相机调一次，确认管线本身在正常相机下能出结果
        const mainCam = app.root.findComponent('camera');
        let mainMi = null, mainErr = null;
        try { mainMi = gd && gd.prepareForPicking ? gd.prepareForPicking(mainCam, 32, 32, worldLayer) : null; }
        catch (e) { mainErr = String(e && e.message || e); }
        out.mainCameraPrepare = mainMi
          ? { ok:true, miCtor: mainMi.constructor && mainMi.constructor.name }
          : { ok:false, err: mainErr, note:'主相机也返回 null -> 环境/排序状态问题，非正交相机问题' };
        // 正交相机测试
        const mi = gd && gd.prepareForPicking
          ? gd.prepareForPicking(cam.camera, 32, 32, worldLayer) : null;
        out.orthoPrepareResult = mi
          ? { ok:true, miCtor: mi.constructor && mi.constructor.name }
          : { ok:false, note:'返回 null' };
      } catch (e) { out.orthoPrepareErr = String(e && e.message || e); }

      // 清理
      cam.destroy();
      if (dv && dv.destroy) dv.destroy();
      if (depthTex && depthTex.destroy) depthTex.destroy();
      out.cleaned = true;
    } catch (e) { out.error = String(e && e.message || e); }
    return out;
  })()`);
  log('\n===== G2: 正交相机 + depth RT 构造 =====\n' + JSON.stringify(g2, null, 2));

  // ---- G3: 主相机 pick 深度的 4 通道随机性（同一视图采样两次对比）----
  // 通过 picker.renderView() 拿纹理，但不能在 JS 里直接 readPixels（在 GPU 上）。
  // 用页面上现有的 __mgEditor 钩子（若有）读 PNG 对比；否则只报告语义来源（源码已确认伯努利）。
  const g3 = await E(`(()=>{
    const W=${DOC}, v=W.__viewer, out={};
    const pk = v && v.picker && v.picker();
    out.hasPicker = !!pk;
    out.pickerMethods = pk ? Object.keys(pk) : null;
    let view=null; try { view = pk && pk.renderView && pk.renderView(); } catch(e){ out.renderViewErr=String(e&&e.message||e); }
    out.hasView = !!view;
    if (view) out.view = { w:view.width, h:view.height, renders:view.renders, texCtor: view.texture && view.texture.constructor && view.texture.constructor.name, fmt: view.texture && view.texture.format };
    out.note = '4 通道伯努利随机深度：源码 index.js getSplatPickOutput() 每通道以 alpha 概率写深度/否则 1.0，MIN blend 取最近幸存者';
    return out;
  })()`);
  log('\n===== G3: pick 深度随机性来源 =====\n' + JSON.stringify(g3, null, 2));

  log('\n===== JS 错误 =====\n' + JSON.stringify(errors.slice(0, 10), null, 2));
  await send('Browser.close');
}

main().then(() => { cleanup(); process.exit(0); }).catch(e => { log('FATAL: ' + (e && e.stack || e)); cleanup(); process.exit(1); });

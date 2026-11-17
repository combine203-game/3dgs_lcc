/**
 * 贴花渲染链路聚焦诊断
 * ----------------------------------------------------------------
 * 用途：贴花「完全不显示」时，逐环定位断点。每一环都问一个可判定的
 * 事实，输出成表，便于一眼看出断在哪一环：
 *
 *   1. 适配器就绪？       engineAdapter.isReady() / getBackendType()
 *   2. 贴花实例存在？     decalMgr.instances.size
 *   3. 实例可见？         instances[].visible
 *   4. 深度快照就绪？     decalMgr.debug().pickReady + pickSize
 *   5. uniform 是否注入？  读取材质参数（读不到就说没注入）
 *   6. shader 编译状态？  抓 PlayCanvas 的 shader 编译错误
 *   7. 渲染层可见？       meshInstance.visible（引擎侧真实值）
 *   8. 调试着色有输出？   uDebugMode=1（深度灰度）/ =2（失败分类）截图
 *
 * 第 6 步是关键：PlayCanvas 编译 GLSL/WGSL 失败**不抛 JS 异常**，
 * 只是在控制台打一条 error，渲染层静默不输出。
 *
 * 用法： node tools/diagnose_decal_render.mjs [--wait=18000]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 18139;
const CDP_PORT = 9265;
const BASE = `http://127.0.0.1:${PORT}`;
const WAIT = Number((process.argv.find(a => a.startsWith('--wait=')) || '').split('=')[1]) || 18000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)],
  { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'decaldiag_' + Date.now());
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

let ws, seq = 0;
const pend = new Map();
const logs = [];

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
    if (o.method === 'Runtime.consoleAPICalled') {
      logs.push({ type: o.params.type, text: txt.slice(0, 600) });
    } else if (o.method === 'Runtime.exceptionThrown') {
      logs.push({ type: 'exception', text: (o.params.exceptionDetails?.exception?.description || o.params.exceptionDetails?.text || '').slice(0, 600) });
    } else if (o.method === 'Log.entryAdded') {
      logs.push({ type: 'log:' + o.params.entry.level, text: String(o.params.entry.text || '').slice(0, 600) });
    }
  };
  function send(method, params = {}) {
    return new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  }
  const E = async (expression, timeoutMs = 30000) => {
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

  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(WAIT);

  const DOC = `(()=>{const f=document.querySelector('iframe.gs-scene-frame[data-active="1"]')||document.querySelector('iframe.gs-scene-frame');return f?f.contentWindow:window;})()`;

  console.log('\n===== 0. 进入编辑态 =====');
  await E(`(()=>{document.getElementById('gsEditorBtn')?.click();return 1})()`);
  await sleep(3500);

  console.log('\n===== 1. 注入贴面矩形 =====');
  const inj = await E(`(()=>{const W=${DOC},ed=W.__mgEditor;if(!ed)return 'no-editor';
    const list=ed.store.list(),tpl=list.find(a=>a.kind==='decal');
    if(!tpl)return 'no-template';
    for(const a of list){if(a.kind==='decal'&&a.visible!==false)ed.store.update(a.id,{visible:false});}
    const c=JSON.parse(JSON.stringify(tpl));
    c.id='diag-decal-'+Date.now();c.title='诊断贴面';c.visible=true;
    c.projector={position:[0,1.22,7.7],quaternion:[-0.7071,0,0,0.7071],half:[4,3,1.2],depth:2.4};
    ed.store.add(c);return c.id;})()`);
  console.log('  注入 =', inj);
  const ID = String(inj);
  if (!/^diag-decal-/.test(ID)) throw new Error('注入失败: ' + inj);

  for (let i = 0; i < 30; i++) {
    const has = await E(`(()=>{const W=${DOC};const m=W.__mgEditor?.decalMgr;
      return !!(m&&m.instances&&m.instances.get('${ID}'));})()`);
    if (has === true) break;
    await sleep(300);
  }
  await E(`(()=>{const W=${DOC};ed=W.__mgEditor;ed.action('decal-rebuild','${ID}');return 1;})()`);
  await sleep(2500);
  for (let i = 0; i < 40; i++) {
    const pr = await E(`(()=>{const W=${DOC};const d=W.__mgEditor?.decalMgr?.debug?.();
      return d?d.pickReady:null;})()`);
    if (pr === true) break;
    await sleep(300);
  }
  await E(`(()=>{const W=${DOC};ed=W.__mgEditor;
    ed.action('media',{id:'${ID}',type:'video',url:''});return 1;})()`);
  await sleep(1500);

  console.log('\n===== 2. 逐环诊断 =====');
  const diag = await E(`(()=>{const W=${DOC},ed=W.__mgEditor,m=ed.decalMgr;
    if(!m)return {err:'no-decalMgr'};
    const inst=m.instances.get('${ID}');
    const d=typeof m.debug==='function'?m.debug():null;
    const out={
      managerEnabled:m.enabled,
      instanceExists:!!inst,
      instanceVisible:inst?inst.visible:null,
      renderableExists:inst?!!inst.renderable:null,
      renderableVisible:inst&&inst.renderable?inst.renderable.visible:null,
      hasProjector:inst?!!inst.projector:null,
      demoMode:inst?!inst.url:null,
      materialExists:inst?!!inst.material:null,
      materialType:inst&&inst.material?inst.material.constructor.name:null,
      pickReady:d?d.pickReady:null,
      pickSize:d?d.pickSize:null,
      pickFormat:d?d.pickTextureFormat:null,
      degraded:d?d.degraded:null,
      gpuErrors:d?d.gpuErrors:null,
      options:d?d.options:null,
      dpr:d?d.dpr:null,
      backend:W.__viewer?.app?.graphicsDevice?.deviceType||null,
      isWebGPU:W.__viewer?.app?.graphicsDevice?.isWebGPU===true
    };
    // uniform 读取：引擎材质参数表（读不到即未注入）
    try{
      const mp=inst&&inst.material?inst.material.parameters:null;
      out.paramKeys=mp?Object.keys(mp).sort():null;
      out.uPickReady=mp&&mp.uPickReady?mp.uPickReady.data:null;
      out.uBoxScale=mp&&mp.uBoxScale?mp.uBoxScale.data:null;
      out.uDepthMode=mp&&mp.uDepthMode?mp.uDepthMode.data:null;
      out.hasPickDepth=!!(mp&&mp.pickDepth);
      out.hasVideoTex=!!(mp&&mp.videoTex);
      out.invViewProjType=mp&&mp.invViewProj?typeof mp.invViewProj.data:'missing';
      out.invViewProjLen=mp&&mp.invViewProj&&mp.invViewProj.data?mp.invViewProj.data.length:null;
      out.invProjectorLen=mp&&mp.invProjector&&mp.invProjector.data?mp.invProjector.data.length:null;
    }catch(e){out.paramErr=String(e);}
    return out;})()`);
  console.log(JSON.stringify(diag, null, 2));

  console.log('\n===== 3. 调试着色（uDebugMode=1 深度灰度 / =2 失败分类）=====');
  for (const mode of [1, 2]) {
    await E(`(()=>{const W=${DOC},m=W.__mgEditor?.decalMgr;
      const inst=m&&m.instances.get('${ID}');
      if(!inst)return 0;
      inst.debugMode=${mode};return 1;})()`);
    await sleep(1200);
    const cv = await E(`(()=>{const W=${DOC};
      const cv=W.document.querySelector('#mg-stage canvas');if(!cv)return null;
      const r=cv.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};})()`);
    await E(`(()=>{const W=${DOC},d=W.document;
      const sel='.ed-layer,.ed-ui,.ed-guides,.ed-marquee,#mg-loading,#mg-error,#mg-bar,#mg-helpbox,#mg-toolsbox';
      d.querySelectorAll(sel).forEach(e=>{e.dataset.__ov=e.style.visibility;e.style.visibility='hidden';});
      const f=document.querySelector('iframe.gs-scene-frame');
      const keep=new Set();let e=f;while(e&&e!==document.documentElement){keep.add(e);e=e.parentElement;}
      document.querySelectorAll('body *').forEach(x=>{if(keep.has(x))return;x.dataset.__ov2=x.style.visibility;x.style.visibility='hidden';});
      return 1;})()`);
    const r = await send('Page.captureScreenshot', cv
      ? { format: 'png', clip: { x: cv.x, y: cv.y, width: cv.w, height: cv.h, scale: 1 } }
      : { format: 'png' });
    if (r.result?.data) {
      const f2 = path.join(ROOT, 'tools', `diagnose-decal-debug${mode}.png`);
      fs.writeFileSync(f2, Buffer.from(r.result.data, 'base64'));
      console.log('  debugMode=' + mode + ' 截图 -> ' + path.basename(f2));
    }
  }
  await E(`(()=>{const W=${DOC};const m=W.__mgEditor?.decalMgr;
    const inst=m&&m.instances.get('${ID}');if(inst)inst.debugMode=0;return 1;})()`);

  console.log('\n===== 4. 控制台日志（shader 编译错误在此）=====');
  const interesting = logs.filter(l =>
    /shader|WGSL|GLSL|compil|pipeline|validation|WebGPU|error|decal/i.test(l.type + ' ' + l.text));
  interesting.slice(0, 30).forEach(l => console.log('  [' + l.type + '] ' + l.text));
  console.log('  （日志总数 ' + logs.length + '，筛出 ' + interesting.length + ' 条相关）');

  fs.writeFileSync(path.join(ROOT, 'tools', 'diagnose-decal-render.json'),
    JSON.stringify({ diag, logs: interesting.slice(0, 60) }, null, 2));
  console.log('\n  report -> tools/diagnose-decal-render.json');
}

main().then(() => { cleanup(); process.exit(0); })
  .catch(e => { console.error('DIAG FAILED', e); cleanup(); process.exit(1); });

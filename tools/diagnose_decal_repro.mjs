/**
 * 「贴面矩形导致黑屏」专项复现 —— 补上旧测试的两个致命盲区：
 *
 *  1. 旧诊断固定跑 WebGL2/SwiftShader，而真机是 WebGPU。贴花 shader 有
 *     GLSL / WGSL 两套源码，WebGL2 全绿完全不能证明 WGSL 能编译。
 *  2. 旧诊断只「进入编辑态」，从没真正执行过「选贴面矩形工具 -> 两次落点」
 *     这个用户报障的操作；示例数据里已有的 decal 也不等于新建流程。
 *
 * 本脚本：强制 WebGPU 后端；真实 CDP 鼠标事件新建一条贴面矩形；隐藏全部 DOM
 * 后只截 WebGL canvas；采集 JS 异常 / console.error / 渲染后端 / 相机姿态。
 *
 * 用法： node tools/diagnose_decal_repro.mjs [--wait=18000] [--gl]
 *       --gl  强制退回 WebGL2，用于 A/B 对照
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 18134;
const CDP_PORT = 9260;
const BASE = `http://127.0.0.1:${PORT}`;
const WAIT = Number((process.argv.find(a => a.startsWith('--wait=')) || '').split('=')[1]) || 18000;
const FORCE_GL = process.argv.includes('--gl');
const PROBE_ONLY = process.argv.includes('--probe-only');
const EXTRA_FLAGS = (process.argv.find(a => a.startsWith('--flags=')) || '')
  .replace(/^--flags=/, '').split(',').filter(Boolean);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)],
  { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'decal_' + Date.now());
fs.mkdirSync(profile, { recursive: true });

const gpuFlags = EXTRA_FLAGS.length ? EXTRA_FLAGS : (FORCE_GL
  ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  : [
      // 实测唯一能在本机 headless 拿到 WebGPU adapter 的组合：
      // requestAdapter() -> { vendor:'google', architecture:'swiftshader' }。
      // 之前用 --enable-features=Vulkan + --use-vulkan=swiftshader 全部返回 adapter-null。
      '--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader'
      // 不要加 --use-gl=angle / --use-angle=swiftshader：实测会挤掉 WebGPU adapter，
      // 让 viewer 静默回退 WebGL2，测试就变成「测了个假后端」。
    ]);
const br = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  ...gpuFlags, '--window-size=1280,800', 'about:blank'
], { stdio: 'ignore' });

function cleanup() {
  try { br.kill(); } catch { /* noop */ }
  try { srv.kill(); } catch { /* noop */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* noop */ }
}

let ws, seq = 0;
const pend = new Map();
const errors = [];
const warns = [];
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
    if (o.method === 'Runtime.exceptionThrown')
      errors.push(o.params.exceptionDetails?.exception?.description || o.params.exceptionDetails?.text || '');
    else if (o.method === 'Runtime.consoleAPICalled' && o.params.type === 'error') errors.push(txt);
    else if (o.method === 'Runtime.consoleAPICalled' && o.params.type === 'warning') warns.push(txt);
    else if (o.method === 'Runtime.consoleAPICalled') logs.push(txt);
    else if (o.method === 'Log.entryAdded' && o.params.entry?.level === 'error')
      errors.push(o.params.entry.text || '');
  };
  function send(method, params = {}) {
    return new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  }
  const E = async (expression, timeoutMs = 25000) => {
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

  if (PROBE_ONLY) {
    // navigator.gpu 只在安全上下文可用；about:blank 不算，必须落到 localhost。
    // 用不存在的路径，避免加载整个 3DGS app 拖慢探测。
    await send('Page.navigate', { url: BASE + '/__gpu_probe__' });
    await sleep(900);
    const res = await E(`(async()=>{
      if(!navigator.gpu)return 'no-navigator-gpu';
      try{const a=await navigator.gpu.requestAdapter();
        if(!a)return 'adapter-null';
        let info=a.info||{};
        try{if(a.requestAdapterInfo)info=await a.requestAdapterInfo();}catch(_){}
        return 'adapter-ok:'+JSON.stringify({vendor:info.vendor,architecture:info.architecture,device:info.device,description:info.description});
      }catch(e){return 'error:'+(e?.message||e);}})()`, 20000);
    console.log('PROBE', JSON.stringify(gpuFlags), '=>', res);
    return;
  }

  await send('Page.navigate', { url: BASE + '/' });
  await sleep(WAIT);

  const DOC = `(()=>{const f=document.querySelector('iframe.gs-scene-frame[data-active="1"]')||document.querySelector('iframe.gs-scene-frame');return f?f.contentWindow:window;})()`;

  // 页面级 GPU 错误观测：引擎对 WebGPU uncapturederror 是空操作（validation error
  // 让整条 command buffer 提交失败 → 整屏黑，且 F12 一条错误都看不到）。
  // 这里挂自己的监听，把 GPU 错误变成 console.error 供 CDP 捕获。
  const gpuHook = await E(`(()=>{const W=${DOC};
    const gd=W.__viewer?.app?.graphicsDevice;const d=gd&&gd.wgpu;
    if(!d||typeof d.addEventListener!=='function')return 0;
    d.addEventListener('uncapturederror',ev=>{W.__gpuErr=(W.__gpuErr||0)+1;
      console.error('GPU-UNCAPTURED:',ev&&ev.error&&ev.error.message||String(ev&&ev.error||ev));});
    return 1;})()`);
  console.log('  GPU 错误监听已挂 =', gpuHook);

  const probeExpr = `(()=>{
    const W=${DOC},d=W.document,v=W.__viewer,app=v?.app,gd=app?.graphicsDevice;
    const cv=d.querySelector('#mg-stage canvas');
    let rect=null,abs=null;
    if(cv){const r=cv.getBoundingClientRect();rect=[r.x,r.y,r.width,r.height];
      const f=document.querySelector('iframe.gs-scene-frame');
      if(f&&f.contentWindow===W){const fr=f.getBoundingClientRect();abs=[r.x+fr.x,r.y+fr.y,r.width,r.height];}else abs=rect;}
    let backend=null,gpuApi=null;
    try{backend=gd?(gd.isWebGPU||gd.deviceType==='webgpu'?'webgpu':'webgl2'):null;}catch(_){}
    try{gpuApi=!!W.navigator.gpu;}catch(_){}
    let decals=null,decalMgr=null;
    try{decals=W.__mgEditor?.store?.list?.().filter(a=>a.kind==='decal').length??null;}catch(_){}
    try{decalMgr=W.__mgEditor?.decalMgr?.enabled??null;}catch(_){}
    return {rect,abs,backend,gpuApi,decals,decalMgr,
      editorOn:!!W.__mgEditor,tool:W.__mgEditor?.getState?.().tool??null,
      gsplats:app?.stats?.frame?.gsplats??null,
      autoRender:app?.autoRender??null,loading:d.getElementById('mg-loading')?.className||''};
  })()`;

  // 后端确认：navigator.gpu.requestAdapter 是否真能拿到 adapter
  const gpuAdapter = await E(`(async()=>{const W=${DOC};
    if(!W.navigator.gpu)return 'no-navigator-gpu';
    try{const a=await W.navigator.gpu.requestAdapter();return a?'adapter-ok':'adapter-null';}
    catch(e){return 'adapter-error:'+(e?.message||e);}})()`, 20000);
  console.log('  WebGPU adapter =', gpuAdapter);

  const hideDom = `(()=>{
    const W=${DOC},d=W.document;
    const sel='.ed-layer,.ed-ui,.ed-guides,.ed-marquee,#mg-loading,#mg-error,#mg-bar,#mg-helpbox,#mg-toolsbox,.sse-controlsWrap,.sse-controlsHint,.sse-infoPanel,.sse-joystick,.sse-panel';
    W.__hidden=d.querySelectorAll(sel);
    W.__hidden.forEach(e=>{e.dataset.__oldVis=e.style.visibility;e.style.visibility='hidden';});
    const f=document.querySelector('iframe.gs-scene-frame[data-active="1"]')||document.querySelector('iframe.gs-scene-frame');
    const keep=new Set();let e=f;
    while(e&&e!==document.documentElement){keep.add(e);e=e.parentElement;}
    window.__topHidden=[];
    document.querySelectorAll('body *').forEach(x=>{
      if(keep.has(x))return;
      window.__topHidden.push([x,x.style.visibility]);x.style.visibility='hidden';
    });
    return 1;
  })()`;
  const showDom = `(()=>{const W=${DOC};
    W.__hidden?.forEach(e=>{e.style.visibility=e.dataset.__oldVis||'';delete e.dataset.__oldVis;});W.__hidden=null;
    window.__topHidden?.forEach(([x,v])=>{x.style.visibility=v;});window.__topHidden=null;return 1;})()`;

  async function pixels(data) {
    return E(`(async(data)=>{
      const im=new Image();im.src='data:image/png;base64,'+data;await im.decode();
      const c=document.createElement('canvas');c.width=im.width;c.height=im.height;
      const g=c.getContext('2d');g.drawImage(im,0,0);const a=g.getImageData(0,0,c.width,c.height).data;
      let n=0,sum=0,sum2=0,dark=0;
      for(let y=0;y<c.height;y+=3)for(let x=0;x<c.width;x+=3){
        const i=(y*c.width+x)*4,L=0.2126*a[i]+0.7152*a[i+1]+0.0722*a[i+2];
        n++;sum+=L;sum2+=L*L;if(L<12)dark++;}
      const mean=n?sum/n:0,sd=n?Math.sqrt(Math.max(0,sum2/n-mean*mean)):0;
      return {n,mean:+mean.toFixed(2),sd:+sd.toFixed(2),
        nearBlack:+(dark/Math.max(1,n)).toFixed(4),blank:mean<18&&sd<14};
    })(${JSON.stringify(data)})`, 30000);
  }

  async function sample(label) {
    const p = await E(probeExpr);
    const r = p?.abs;
    const clip = r && r[2] > 2 && r[3] > 2
      ? { x: Math.max(0, r[0]), y: Math.max(0, r[1]), width: Math.max(2, r[2]), height: Math.max(2, r[3]), scale: 1 }
      : undefined;
    await E(hideDom);
    const shot = await send('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' });
    // 存图供人工检查（投射内容 / 包围盒 / 黑屏形态一目了然）
    try {
      if (shot.result?.data) fs.writeFileSync(
        path.join(ROOT, 'tools', `shot-${label.replace(/[^\w-]/g, '_')}.png`),
        Buffer.from(shot.result.data, 'base64'));
    } catch (_) { /* noop */ }
    await E(showDom);
    const px = shot.result?.data ? await pixels(shot.result.data) : null;
    console.log(`  [${label}] pure=${JSON.stringify(px)} backend=${p?.backend} gpuApi=${p?.gpuApi} decals=${p?.decals} decalMgr=${p?.decalMgr} gsplats=${p?.gsplats} ed=${p?.editorOn}`);
    return { label, probe: p, px };
  }

  const rows = [];
  console.log('\n===== 后端 / 浏览态基线 =====');
  for (let i = 0; i < 2; i++) { rows.push(await sample('browse-' + i)); await sleep(500); }

  console.log('\n===== 进入编辑态 =====');
  await E(`(()=>{document.getElementById('gsEditorBtn')?.click();return 1})()`);
  await sleep(2500);
  rows.push(await sample('editor'));

  // 真实选「贴面矩形」工具（点工具栏按钮，走 panel.js 的 click -> action('tool','decal')）
  const toolOk = await E(`(()=>{const W=${DOC},d=W.document;
    const b=d.querySelector('[data-act="tool"][data-v="decal"]');
    if(!b)return 'no-tool-button';b.click();return 'clicked';})()`);
  console.log('\n===== 新建贴面矩形（真实 CDP 鼠标两次落点）=====');
  console.log('  选工具 =', toolOk);
  const st = await E(probeExpr);
  console.log('  tool =', st?.tool);

  const r = st?.abs || [0, 0, 1258, 702];
  const x0 = r[0] + r[2] * 0.38, y0 = r[1] + r[3] * 0.40;
  const x1 = r[0] + r[2] * 0.62, y1 = r[1] + r[3] * 0.60;
  for (const [x, y] of [[x0, y0], [x1, y1]]) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(700);   // 拉开间隔，避免被识别成双击
  }
  await sleep(1200);

  /* CDP 点击可能被 onUI() 拦在已有标注 DOM 上（pickAsync 也不保证成功），
     所以再用 store 真实注入一条贴面矩形：走的是与用户操作完全相同的
     onChange -> syncDecals -> createInstance -> 全屏 quad 渲染链路。 */
  const injected = await E(`(()=>{const W=${DOC},ed=W.__mgEditor;if(!ed)return 'no-editor';
    const list=ed.store.list(),tpl=list.find(a=>a.kind==='decal');
    if(!tpl)return 'no-template';
    const before=list.filter(a=>a.kind==='decal').length;
    const c=JSON.parse(JSON.stringify(tpl));
    c.id='diag-decal-'+Date.now();c.title='诊断贴面矩形';
    if(Array.isArray(c.rect))c.rect=c.rect.map(v=>+(v+0.03).toFixed(4));
    /* 不用模板的历史 OBB（属于别的机位，会在当前视角留下不可判定的足印）。
       这里手工构造一个对准 headless 默认相机视野内已知地面深度的 OBB
       （探针实测：地面高约 1.17~1.23m、距相机约 7.7m）：position 在地面上，
       局部 +z（薄向）旋转到世界 +y，half=[2,1.5,0.35] —— 一块 4m×3m 的地面薄盒。
       shader 逐像素反算出的地面点应稳定落在盒内 → 投射为实心矩形。 */
    c.projector={position:[0,1.22,7.7],quaternion:[-0.7071,0,0,0.7071],
      half:[4,3,1.2],depth:2.4};
    ed.store.add(c);
    const after=ed.store.list().filter(a=>a.kind==='decal').length;
    return 'before='+before+' after='+after;})()`);
  console.log('  注入贴面矩形 =', injected);

  /* 注入的贴面复用了模板保存的投影机 OBB（属于历史机位），在当前默认相机下
     可能整个落在画面外，投射内容因此不可见 —— 会误判「贴花没画出来」。
     这里走与属性面板「↻ 按当前视角重建投影机」完全相同的 action，让 OBB
     对准当前相机，A/B 可见性对比才有意义。 */
  const rebuilt = await E(`(async()=>{const W=${DOC},ed=W.__mgEditor;if(!ed)return 'no-editor';
    const dec=ed.store.list().find(a=>a.kind==='decal'&&a.id.indexOf('diag-decal-')===0);
    if(!dec)return 'no-decal';
    if(typeof ed.action!=='function')return 'no-action';
    // 隐藏模板贴面：只保留重建过的实例，避免两个 OBB 足印混在一起干扰判断
    for(const a of ed.store.list()){
      if(a.kind==='decal'&&a.id.indexOf('diag-decal-')!==0&&a.visible!==false)
        ed.store.update(a.id,{visible:false});
    }
    ed.action('decal-rebuild',dec.id);
    for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,100));
      if(ed.store.get(dec.id)&&ed.store.get(dec.id).projector)break;}
    const a=ed.store.get(dec.id);
    return JSON.stringify({
      rebuilt:!!(a&&a.projector),
      source:a&&a.surface&&a.surface.source,
      stats:a&&a.surface&&a.surface.stats,
      rect:a&&a.rect,
      half:a&&a.projector&&a.projector.half,
      pos:a&&a.projector&&a.projector.position,
      status:W.document.querySelector('[data-role="status"]')?.textContent||''
    });})()`);
  console.log('  按当前视角重建投影机 =', rebuilt);
  /* 巨盒拦截：headless 里深度拾取超时 → 全部退化 MESH → 深度跨度巨大。
     新的数据层守卫必须拒绝建盒（面板提示"深度跨度过大"），且不得把
     手工 OBB 覆盖成巨盒。真机上深度拾取正常时则应正常建盒（小尺寸）。 */
  let rb = null; try { rb = JSON.parse(String(rebuilt)); } catch (_) {}
  const halfSum = rb?.half ? (rb.half[0] + rb.half[1]) : null;
  const guardOk = !rb || (rb.rebuilt === false && /深度跨度过大|重新框选/.test(rb.status || '')) ||
    (rb.rebuilt === true && halfSum != null && halfSum <= 16);
  console.log('  巨盒拦截: halfSum =', halfSum, ' status =', rb?.status, ' guardOk =', guardOk);

  // 读取贴花管理器诊断钩子：pickReady=1 才说明引擎 Picker 的真实深度快照
  // 纹理真的绑定进了全屏 quad 的管线（此前所有 headless 测试的共同盲区）。
  const mgrDbg = await E(`(()=>{const W=${DOC};
    return JSON.stringify(W.__mgEditor&&W.__mgEditor.decalMgr&&
      typeof W.__mgEditor.decalMgr.debug==='function'?W.__mgEditor.decalMgr.debug():null);})()`);
  console.log('  decalMgr.debug =', mgrDbg);

  for (const t of [0, 1500, 3500, 6000]) {
    if (t) await sleep(t === 1500 ? 1500 : (t === 3500 ? 2000 : 2500));
    rows.push(await sample('decal-' + t));
  }

  // 采样结束后再读一次：pickReady 要等 frameend 里 getPickView 返回新的 renders
  const mgrDbgEnd = await E(`(()=>{const W=${DOC};
    return JSON.stringify(W.__mgEditor&&W.__mgEditor.decalMgr&&
      typeof W.__mgEditor.decalMgr.debug==='function'?W.__mgEditor.decalMgr.debug():null);})()`);
  console.log('  decalMgr.debug(end) =', mgrDbgEnd);

  /* A/B 量化「投射内容真的画上了屏幕」：隐藏全部贴面采样一次，再恢复。
     贴花有内容（内置演示画面或视频）时，可见态与隐藏态的画面亮度必须
     有可测差异；此前占位纹理全透明，两者完全相等 —— 正是「只有包围盒
     没有视频」的量化特征。 */
  const abHide = await E(`(()=>{const W=${DOC},ed=W.__mgEditor;if(!ed)return 0;
    let n=0;for(const a of ed.store.list()){
      if(a.kind==='decal'&&a.visible!==false){ed.store.update(a.id,{visible:false});n++;}}
    return n;})()`);
  await sleep(1500);
  rows.push(await sample('decals-hidden'));
  await E(`(()=>{const W=${DOC},ed=W.__mgEditor;if(!ed)return 0;
    let n=0;for(const a of ed.store.list()){
      if(a.kind==='decal'&&a.visible===false){ed.store.update(a.id,{visible:true});n++;}}
    return n;})()`);
  await sleep(1200);
  console.log('  A/B: 隐藏贴面 =', abHide, '（已恢复显示）');

  console.log('\n================ 结论 ================');
  const base = rows.slice(0, 2).filter(r => r.px).map(r => r.px.mean);
  const baseMean = base.length ? base.reduce((a, b) => a + b, 0) / base.length : 0;
  const after = rows.filter(r => r.label.startsWith('decal-') && r.px);
  const editorRow = rows.find(r => r.label === 'editor');
  const editorMean = editorRow?.px?.mean ?? baseMean;
  const worst = after.length ? Math.min(...after.map(r => r.px.mean)) : 0;
  const blank = after.some(r => r.px.blank);
  const collapse = baseMean > 0 && worst < baseMean * 0.55;
  const drift = editorMean > 0
    ? Math.max(...after.map(r => Math.abs(r.px.mean - editorMean))) / editorMean : 1;
  // 编译期 / 渲染期错误关键字
  const shaderErrors = errors.filter(e => /WGSL|shader|WebGPU|pipeline|validation|compil/i.test(e));
  // 前置条件必须全绿，否则「没黑屏」可能只是因为编辑器压根没挂载 / 贴面没建出来。
  const editorOk = editorRow?.probe?.editorOn === true;
  const toolSelected = toolOk === 'clicked' && st?.tool === 'decal';
  const decalCreated = /after=(\d+)/.test(String(injected)) &&
    Number(String(injected).match(/after=(\d+)/)[1]) >
    Number(String(injected).match(/before=(\d+)/)[1]);
  console.log('  前置条件: 编辑器挂载 =', editorOk, ' 工具选中 =', toolSelected, ' 贴面已新建 =', decalCreated);
  console.log('  渲染后端 =', st?.backend, ' navigator.gpu =', st?.gpuApi, ' adapter =', gpuAdapter);
  console.log('  浏览态基线 mean =', baseMean.toFixed(2), ' 编辑态 mean =', editorMean.toFixed(2),
    ' 新建贴面后最低 mean =', worst.toFixed(2));
  console.log('  空白帧 =', blank, ' 亮度崩塌 =', collapse, ' 相对编辑态偏差 =', (drift * 100).toFixed(1) + '%');
  console.log('  JS/console 错误 =', errors.length, errors.slice(0, 4));
  console.log('  shader 相关错误 =', shaderErrors.length, shaderErrors.slice(0, 3));
  console.log('  warn =', warns.slice(0, 4));

  // GPU 管线健康判定：pickReady 必须=1（真实 Picker 深度纹理已绑定）、
  // 必须有可见实例、不允许 degraded、不允许任何 GPU uncaptured error。
  let dbg = null; try { dbg = JSON.parse(String(mgrDbgEnd)); } catch (_) {}
  const pageGpuErr = Number(await E(`(()=>{const W=${DOC};return W.__gpuErr||0;})()`)) || 0;
  const gpuErrTotal = pageGpuErr + (dbg?.gpuErrors ?? 0);
  const visibleInstances = Array.isArray(dbg?.instances)
    ? dbg.instances.filter(i => i.visible).length : null;
  const pickReadyOk = !dbg || !dbg.enabled
    ? false
    : (dbg.pickReady === true && visibleInstances > 0 && dbg.degraded === false);
  console.log('  GPU 管线: pickReady =', dbg?.pickReady, ' 可见实例 =', visibleInstances,
    ' degraded =', dbg?.degraded, ' GPU 错误 =', gpuErrTotal);

  // 投射可见性：可见态平均亮度 vs 隐藏态，必须有可测差异（>0.5/255）
  const hiddenRow = rows.find(r => r.label === 'decals-hidden');
  const visMeans = rows.filter(r => r.label.startsWith('decal-') && r.px).map(r => r.px.mean);
  const hiddenMean = hiddenRow?.px?.mean ?? null;
  const visAvg = visMeans.length ? visMeans.reduce((a, b) => a + b, 0) / visMeans.length : null;
  const projDelta = (visAvg != null && hiddenMean != null) ? Math.abs(visAvg - hiddenMean) : null;
  const projOk = projDelta != null && projDelta >= 0.5;
  console.log('  投射可见性: 可见态均值 =', visAvg?.toFixed(2), ' 隐藏态均值 =', hiddenMean?.toFixed(2),
    ' 差值 =', projDelta?.toFixed(2), projOk ? '(投射内容可见)' : '(贴花似乎没有画出内容!)');
  const demoOk = !dbg || dbg.instances?.every(i => i.demoMode || i.videoReady || i.videoErr === null);
  console.log('  内容源: demoMode/就绪 =', JSON.stringify(dbg?.instances?.map(i => ({ demo: i.demoMode, ready: i.videoReady, err: i.videoErr }))), ' =', demoOk);

  const fail = blank || collapse || shaderErrors.length > 0 || errors.length > 0 ||
    !editorOk || !toolSelected || !decalCreated || st?.backend !== 'webgpu' ||
    !pickReadyOk || gpuErrTotal > 0 || !projOk || !demoOk || !guardOk;
  console.log('  贴面矩形结果:', fail ? 'FAIL（黑屏 / shader 错误 / 前置未满足 / GPU 管线异常 / 投射不可见）' : 'PASS');
  if (st?.backend !== 'webgpu' && !FORCE_GL)
    console.log('  ⚠ 未真正跑在 WebGPU 后端，本次不能证明真机 WGSL 路径；请用支持 Dawn 的环境复测');

  fs.writeFileSync(path.join(ROOT, 'tools', `diagnose-decal-${FORCE_GL ? 'gl' : 'webgpu'}.json`),
    JSON.stringify({ gpuAdapter, baseMean, editorMean, worst, blank, collapse, drift,
      decalDebug: dbg, pageGpuErr, gpuErrTotal, pickReadyOk,
      visAvg, hiddenMean, projDelta, projOk, demoOk, rebuild: rb, guardOk,
      shaderErrors, errors, warns, fail, rows }, null, 2));
  console.log(`  report -> tools/diagnose-decal-${FORCE_GL ? 'gl' : 'webgpu'}.json`);
}

main().then(() => { cleanup(); process.exit(0); })
  .catch(e => { console.error('DIAG FAILED', e); cleanup(); process.exit(1); });

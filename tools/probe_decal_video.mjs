/**
 * 修复3真机验证探针 —— 贴面矩形视频播放（WebGPU 真实后端）。
 *
 *  背景：旧实现的实例由 decalMgr.sync(getDecals()) 驱动，但改片源后从不重喂
 *  sync → 实例一直停在 demoMode（内置演示画面）→「没法正常播放视频」。
 *  修复后 editor.js action() 末尾统一 syncDecals()，覆盖全部改片源路径。
 *
 *  本探针按用户真实操作链路逐条断言：
 *   A. 进入编辑态 → 注入贴面矩形（手工 OBB 对准默认相机视野内已知地面）
 *   B. decal-rebuild 按当前视角重建 → 等 pickReady=1（Picker 深度纹理真绑定）
 *   C. demo 态截图（DECAL DEMO 演示画面）
 *   D. ed.action('local-video', id) 设 ./media/test.mp4 —— 用户报障路径
 *      → 断言实例 videoUrl 更新、demoMode=false、videoReady=true、videoErr=null
 *   E. 改片源 ./media/test.mp4?v=2（旧 bug 的核心场景：改 URL 后实例必须重喂）
 *      → 断言 videoUrl 即时更新且仍就绪
 *   F. 视频播放态截图，纯 canvas 像素统计留档
 *
 * 用法： node tools/probe_decal_video.mjs [--wait=18000] [--gl]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 18135;
const CDP_PORT = 9261;
const BASE = `http://127.0.0.1:${PORT}`;
const WAIT = Number((process.argv.find(a => a.startsWith('--wait=')) || '').split('=')[1]) || 18000;
const FORCE_GL = process.argv.includes('--gl');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)],
  { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'decalvideo_' + Date.now());
fs.mkdirSync(profile, { recursive: true });

const gpuFlags = FORCE_GL
  ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  : ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader'];
const br = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--autoplay-policy=no-user-gesture-required',
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
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(WAIT);

  const DOC = `(()=>{const f=document.querySelector('iframe.gs-scene-frame[data-active="1"]')||document.querySelector('iframe.gs-scene-frame');return f?f.contentWindow:window;})()`;

  // WebGPU uncapturederror → console.error（引擎对 validation error 是空操作）
  await E(`(()=>{const W=${DOC};
    const gd=W.__viewer?.app?.graphicsDevice;const d=gd&&gd.wgpu;
    if(!d||typeof d.addEventListener!=='function')return 0;
    d.addEventListener('uncapturederror',ev=>{W.__gpuErr=(W.__gpuErr||0)+1;
      console.error('GPU-UNCAPTURED:',ev&&ev.error&&ev.error.message||String(ev&&ev.error||ev));});
    return 1;})()`);

  const hideDom = `(()=>{const W=${DOC},d=W.document;
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
    return 1;})()`;
  const showDom = `(()=>{const W=${DOC};
    W.__hidden?.forEach(e=>{e.style.visibility=e.dataset.__oldVis||'';delete e.dataset.__oldVis;});W.__hidden=null;
    window.__topHidden?.forEach(([x,v])=>{x.style.visibility=v;});window.__topHidden=null;return 1;})()`;

  async function shot(name) {
    const cv = await E(`(()=>{const W=${DOC},v=W.__viewer,app=v?.app;
      const cv=W.document.querySelector('#mg-stage canvas');
      if(!cv)return null;const r=cv.getBoundingClientRect();
      const f=document.querySelector('iframe.gs-scene-frame');
      const off=(f&&f.contentWindow===W)?[r.x+f.getBoundingClientRect().x,r.y+f.getBoundingClientRect().y]:[r.x,r.y];
      return {x:off[0],y:off[1],w:r.width,h:r.height};})()`);
    await E(hideDom);
    const r = await send('Page.captureScreenshot', cv && cv.w > 2 && cv.h > 2
      ? { format: 'png', clip: { x: Math.max(0, cv.x), y: Math.max(0, cv.y), width: Math.max(2, cv.w), height: Math.max(2, cv.h), scale: 1 } }
      : { format: 'png' });
    await E(showDom);
    if (r.result?.data) fs.writeFileSync(
      path.join(ROOT, 'tools', `probe-decal-video-${name}.png`),
      Buffer.from(r.result.data, 'base64'));
    console.log(`  截图 -> tools/probe-decal-video-${name}.png`);
    return !!r.result?.data;
  }

  const dbg = async () => {
    const v = await E(`(()=>{const W=${DOC};
      const m=W.__mgEditor?.decalMgr;
      return m&&typeof m.debug==='function'?m.debug():null;})()`);
    return v && !v.__err ? v : null;
  };

  console.log('\n===== A. 进入编辑态 =====');
  const backend = await E(`(()=>{const W=${DOC},gd=W.__viewer?.app?.graphicsDevice;
    return gd?(gd.isWebGPU||gd.deviceType==='webgpu'?'webgpu':'webgl2'):null;})()`);
  const edOn0 = await E(`(()=>{return !!(${DOC}).__mgEditor;})()`);
  await E(`(()=>{document.getElementById('gsEditorBtn')?.click();return 1})()`);
  await sleep(3000);
  const edOn = await E(`(()=>{return !!(${DOC}).__mgEditor;})()`);
  console.log('  后端 =', backend, ' 编辑器挂载 =', edOn0, '->', edOn);
  if (!edOn) throw new Error('编辑器未挂载');

  console.log('\n===== B. 注入贴面矩形 + 重建投影机 =====');
  const inj = await E(`(()=>{const W=${DOC},ed=W.__mgEditor;if(!ed)return 'no-editor';
    const list=ed.store.list(),tpl=list.find(a=>a.kind==='decal');
    if(!tpl)return 'no-template';
    for(const a of list){if(a.kind==='decal'&&a.visible!==false)ed.store.update(a.id,{visible:false});}
    const c=JSON.parse(JSON.stringify(tpl));
    c.id='probe-decal-'+Date.now();c.title='视频播放探针贴面';c.visible=true;
    /* 对准 headless 默认相机视野内已知地面（探针实测：地面高约 1.22m、距相机约 7.7m） */
    c.projector={position:[0,1.22,7.7],quaternion:[-0.7071,0,0,0.7071],half:[4,3,1.2],depth:2.4};
    ed.store.add(c);
    return c.id;})()`);
  console.log('  注入 =', inj);
  if (!/^probe-decal-/.test(String(inj))) throw new Error('贴面注入失败: ' + inj);
  const DECAL_ID = String(inj);

  // 确保实例存在（sync 由 store.onChange 驱动）
  for (let i = 0; i < 30; i++) {
    const d0 = await dbg();
    if (d0?.instances?.some(x => x.id === DECAL_ID)) break;
    await sleep(300);
  }
  // 按当前视角重建投影机（与属性面板 ↻ 按钮同一 action）
  await E(`(()=>{const W=${DOC},ed=W.__mgEditor;ed.action('decal-rebuild','${DECAL_ID}');return 1;})()`);
  await sleep(2000);

  // 等 pickReady（Picker 深度纹理真绑定进管线）
  let pickReady = false;
  for (let i = 0; i < 40; i++) {
    const d1 = await dbg();
    if (d1?.pickReady === true) { pickReady = true; break; }
    await sleep(300);
  }
  const dDemo = await dbg();
  console.log('  pickReady =', dDemo?.pickReady, ' degraded =', dDemo?.degraded,
    ' instances =', JSON.stringify(dDemo?.instances));

  console.log('\n===== C. demo 态截图（内置演示画面）=====');
  const shotDemo = await shot('demo');
  const demoInst = (dDemo?.instances || []).find(x => x.id === DECAL_ID) || {};

  console.log('\n===== D. action(local-video)：设置 ./media/test.mp4 =====');
  await E(`(()=>{const W=${DOC},ed=W.__mgEditor;ed.action('local-video','${DECAL_ID}');return 1;})()`);
  let videoInst = null, waitedMs = 0;
  for (let i = 0; i < 40; i++) {
    await sleep(500); waitedMs += 500;
    const d2 = await dbg();
    const inst = (d2?.instances || []).find(x => x.id === DECAL_ID);
    if (i % 4 === 0 || (inst && (inst.videoErr || inst.videoReady)))
      console.log(`  [D ${waitedMs}ms]`, JSON.stringify(inst), ' pickReady=', d2?.pickReady);
    if (inst && inst.videoUrl === './media/test.mp4' && inst.demoMode === false &&
        inst.videoReady === true && inst.videoErr === null) { videoInst = inst; break; }
    if (inst && inst.videoErr) { videoInst = inst; break; }
  }
  console.log('  等待 ' + waitedMs + 'ms ->', JSON.stringify(videoInst));
  const mediaUrlStored = await E(`(()=>{const W=${DOC},ed=W.__mgEditor;
    const a=ed.store.get('${DECAL_ID}');
    return a&&a.media&&a.media[0]?a.media[0].url:null;})()`);
  console.log('  store.media[0].url =', mediaUrlStored);
  await sleep(1200);           // 让视频至少解码几帧并上传纹理
  const shotVideo = await shot('video');

  console.log('\n===== E. 改片源 ./media/test.mp4?v=2（旧 bug 核心场景）=====');
  await E(`(()=>{const W=${DOC},ed=W.__mgEditor;
    ed.action('media',{id:'${DECAL_ID}',type:'video',url:'./media/test.mp4?v=2'});return 1;})()`);
  let remapInst = null, remapWaited = 0;
  for (let i = 0; i < 30; i++) {
    await sleep(500); remapWaited += 500;
    const d3 = await dbg();
    const inst = (d3?.instances || []).find(x => x.id === DECAL_ID);
    if (i % 4 === 0 || (inst && (inst.videoErr || inst.videoReady)))
      console.log(`  [E ${remapWaited}ms]`, JSON.stringify(inst));
    if (inst && inst.videoUrl === './media/test.mp4?v=2' && inst.videoReady === true &&
        inst.videoErr === null) { remapInst = inst; break; }
    if (inst && inst.videoErr) { remapInst = inst; break; }
  }
  console.log('  等待 ' + remapWaited + 'ms ->', JSON.stringify(remapInst));

  // 还原片源，避免示例数据被探针污染（store 是内存态，探针进程结束即丢弃）
  await E(`(()=>{const W=${DOC},ed=W.__mgEditor;
    ed.action('media',{id:'${DECAL_ID}',type:'video',url:''});return 1;})()`);
  await sleep(800);
  const restored = await dbg();
  const restoredInst = (restored?.instances || []).find(x => x.id === DECAL_ID);

  console.log('\n===== F. 最终状态 =====');
  const finalDbg = await dbg();
  const pageGpuErr = Number(await E(`(()=>{return (${DOC}).__gpuErr||0;})()`)) || 0;
  console.log('  最终 debug =', JSON.stringify(finalDbg));

  const passA = edOn === true;
  const passB = pickReady === true && (dDemo?.degraded === false);
  const passC = shotDemo === true && demoInst.demoMode === true && demoInst.hasProjector === true;
  const passD = !!videoInst && videoInst.videoUrl === './media/test.mp4' &&
    videoInst.demoMode === false && videoInst.videoReady === true && videoInst.videoErr === null &&
    mediaUrlStored === './media/test.mp4';
  const passE = !!remapInst && remapInst.videoUrl === './media/test.mp4?v=2' &&
    remapInst.videoReady === true && remapInst.videoErr === null;
  const passF = restoredInst && restoredInst.demoMode === true && restoredInst.videoUrl === null;
  const shaderErrors = errors.filter(e => /WGSL|shader|WebGPU|pipeline|validation|compil/i.test(e));
  const pass = passA && passB && passC && passD && passE && passF &&
    shaderErrors.length === 0 && errors.length === 0 && pageGpuErr === 0;

  console.log('\n================ 结论 ================');
  console.log('  A 编辑器挂载 =', passA ? 'PASS' : 'FAIL');
  console.log('  B pickReady=1 且未降级 =', passB ? 'PASS' : 'FAIL',
    `(pickReady=${dDemo?.pickReady} degraded=${dDemo?.degraded})`);
  console.log('  C demo 态演示画面 + 投影机 =', passC ? 'PASS' : 'FAIL',
    JSON.stringify(demoInst));
  console.log('  D local-video 播放 test.mp4 =', passD ? 'PASS' : 'FAIL',
    JSON.stringify(videoInst));
  console.log('  E 改片源即时重喂(?v=2) =', passE ? 'PASS' : 'FAIL',
    JSON.stringify(remapInst));
  console.log('  F 清空片源回退 demo =', passF ? 'PASS' : 'FAIL',
    JSON.stringify(restoredInst));
  console.log('  JS/console 错误 =', errors.length, errors.slice(0, 3));
  console.log('  shader 错误 =', shaderErrors.length);
  console.log('  GPU uncapturederror =', pageGpuErr);
  console.log('  warn =', warns.slice(0, 4));
  console.log('  后端 =', backend, FORCE_GL ? '(强制 WebGL2 对照)' : '(WebGPU 真实路径)');
  console.log('  贴面矩形视频播放:', pass ? 'PASS' : 'FAIL');

  fs.writeFileSync(path.join(ROOT, 'tools', 'probe-decal-video.json'),
    JSON.stringify({ backend, forceGL: FORCE_GL, decalId: DECAL_ID,
      pickReady, degraded: dDemo?.degraded, demoInst, videoInst, mediaUrlStored,
      remapInst, restoredInst, shotDemo, shotVideo,
      passA, passB, passC, passD, passE, passF,
      errors, shaderErrors, pageGpuErr, warns, pass }, null, 2));
  console.log('  report -> tools/probe-decal-video.json');
}

main().then(() => { cleanup(); process.exit(0); })
  .catch(e => { console.error('PROBE FAILED', e); cleanup(); process.exit(1); });

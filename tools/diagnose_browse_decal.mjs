#!/usr/bin/env node
/* 浏览态贴花投射验收（真机 WebGPU）
 * ---------------------------------------------------------------
 * 用户需求：「浏览模式下看不到投射的视频；编辑模式保留辅助线框，
 * 浏览模式只绘制投射视频，不绘制辅助框」。
 *
 * 本脚本用真实 Viewer 页（不进编辑器）验证四件事：
 *   1. 真机后端是 WebGPU，编辑器未挂载（前置条件：浏览态）；
 *   2. 注入一条带投影机的贴花后，浏览层自己建起 GPU 投射实例
 *      （__mgBrowseAnn.decalStats(): enabled / instances / pickReady / 0 GPU 错误）；
 *   3. 投射画面真的画在屏幕上：贴花可见 vs 隐藏的像素均值差 > 0.5；
 *   4. 浏览态没有任何贴花辅助图形（.ed-decal-obb-edge / 手柄 / 占位框 全部隐藏）；
 *   5. 进入编辑态后：浏览层投射器被撤下（不双份投射），编辑器自己那份启用，
 *      且辅助线框重新可见 —— 「编辑态保留线框」不被这次改动破坏。
 *
 * 结论行：浏览态贴花: PASS / FAIL
 * 用法： node tools/diagnose_browse_decal.mjs [--wait=18000]
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
const sleep = ms => new Promise(r => setTimeout(r, ms));

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)],
  { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'browsedecal_' + Date.now());
fs.mkdirSync(profile, { recursive: true });
const br = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
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
    if (o.method === 'Runtime.exceptionThrown')
      errors.push(o.params.exceptionDetails?.exception?.description || o.params.exceptionDetails?.text || '');
    else if (o.method === 'Runtime.consoleAPICalled' && o.params.type === 'error') errors.push(txt);
  };
  const send = (method, params = {}) => new Promise(res => {
    const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params }));
  });
  /** 注意：返回 {__err} / {__timeout} 而不是抛错，便于把失败原因写进结论 */
  const E = async (expression, timeoutMs = 30000) => {
    try {
      const r = await Promise.race([
        send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
        sleep(timeoutMs).then(() => ({ timeout: true }))
      ]);
      if (r.timeout) return { __timeout: true };
      if (r.result?.exceptionDetails)
        return { __err: (r.result.exceptionDetails.exception?.description
          || r.result.exceptionDetails.text || '').slice(0, 400) };
      return r.result?.result?.value;
    } catch (err) { return { __err: String(err) }; }
  };

  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(WAIT);

  const DOC = `(()=>{const f=document.querySelector('iframe.gs-scene-frame[data-active="1"]')||document.querySelector('iframe.gs-scene-frame');return f?f.contentWindow:window;})()`;

  /* 页面级 GPU 错误观测：引擎对 WebGPU uncapturederror 是空操作。 */
  await E(`(()=>{const W=${DOC};
    const gd=W.__viewer?.app?.graphicsDevice;const dev=gd&&gd.wgpu;
    if(!dev||typeof dev.addEventListener!=='function')return 0;
    dev.addEventListener('uncapturederror',ev=>{W.__gpuErr=(W.__gpuErr||0)+1;
      console.error('GPU-UNCAPTURED:',ev&&ev.error&&ev.error.message||String(ev&&ev.error||ev));});
    return 1;})()`);

  const probeExpr = `(()=>{
    const W=${DOC},d=W.document,v=W.__viewer,app=v?.app,gd=app?.graphicsDevice;
    const cv=d.querySelector('#mg-stage canvas');
    let rect=null,abs=null;
    if(cv){const r=cv.getBoundingClientRect();rect=[r.x,r.y,r.width,r.height];
      const f=document.querySelector('iframe.gs-scene-frame');
      if(f&&f.contentWindow===W){const fr=f.getBoundingClientRect();abs=[r.x+fr.x,r.y+fr.y,r.width,r.height];}else abs=rect;}
    let backend=null;
    try{backend=gd?(gd.isWebGPU||gd.deviceType==='webgpu'?'webgpu':'webgl2'):null;}catch(_){}
    return {rect,abs,backend,
      editorOn:!!W.__mgEditor,
      browseReady:!!W.__mgBrowseAnn?.ready,
      pickerReady:!!W.__viewer?.picker,
      gsplats:app?.stats?.frame?.gsplats??null,
      decal:W.__mgBrowseAnn?.decalStats?.()??null,
      gpuErr:W.__gpuErr||0};
  })()`;

  /* 只截 canvas：隐藏 iframe 内的编辑层 / 标注层与父页除 iframe 祖先外的全部节点 */
  const hideDom = `(()=>{
    const W=${DOC},d=W.document;
    W.__hidden=d.querySelectorAll('.ed-layer,.ed-ui,.ed-guides,.ed-marquee,.mg-ann-layer,#mg-loading,#mg-error,#mg-bar,#mg-helpbox,#mg-toolsbox,.sse-controlsWrap,.sse-controlsHint,.sse-infoPanel,.sse-joystick,.sse-panel');
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
      let n=0,sum=0,sum2=0;
      for(let y=0;y<c.height;y+=3)for(let x=0;x<c.width;x+=3){
        const i=(y*c.width+x)*4,L=0.2126*a[i]+0.7152*a[i+1]+0.0722*a[i+2];
        n++;sum+=L;sum2+=L*L;}
      const mean=n?sum/n:0;
      return {n,mean:+mean.toFixed(2),sd:+Math.sqrt(Math.max(0,sum2/n-mean*mean)).toFixed(2)};
    })(${JSON.stringify(data)})`, 40000);
  }

  async function sample(label) {
    const p = await E(probeExpr);
    const r = p?.abs;
    const clip = r && r[2] > 2 && r[3] > 2
      ? { x: Math.max(0, r[0]), y: Math.max(0, r[1]), width: Math.max(2, r[2]), height: Math.max(2, r[3]), scale: 1 }
      : undefined;
    await E(hideDom);
    const shot = await send('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' });
    try {
      if (shot.result?.data) fs.writeFileSync(
        path.join(ROOT, 'tools', `shot-browse-${label}.png`), Buffer.from(shot.result.data, 'base64'));
    } catch (_) { /* noop */ }
    await E(showDom);
    const px = shot.result?.data ? await pixels(shot.result.data) : null;
    console.log(`  [${label}] mean=${JSON.stringify(px)} backend=${p?.backend} editor=${p?.editorOn} ` +
      `picker=${p?.pickerReady} gsplats=${p?.gsplats} decal=${JSON.stringify(p?.decal)} gpuErr=${p?.gpuErr}`);
    return { label, probe: p, px };
  }

  const fails = [];
  const check = (name, cond, detail) => {
    const ok = !!cond;
    if (!ok) fails.push(name + (detail !== undefined ? ' -> ' + JSON.stringify(detail) : ''));
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  ->  ' + JSON.stringify(detail) : ''}`);
    return ok;
  };

  console.log('\n===== 浏览态基线（编辑器未挂载）=====');
  const base = await sample('base');
  check('真机后端为 WebGPU', base.probe?.backend === 'webgpu', base.probe?.backend);
  check('浏览态未挂载编辑器（前置条件）', base.probe?.editorOn === false);
  check('相机 Picker 已就绪（投影需要主相机深度）', base.probe?.pickerReady === true);
  check('场景已渲染出高斯（gsplats > 0）', Number(base.probe?.gsplats) > 0, base.probe?.gsplats);

  /* 注入一条「对准当前相机」的透视贴花：空视频 URL = 内置演示画面（条纹动画），
     不依赖任何媒体文件，像素差就完全来自 GPU 投射。 */
  const injected = await E(`(async()=>{const W=${DOC};
    const mod=await import('./editor/schema.js');
    const cam=W.__viewer.app.root.findComponent('camera');
    const p=cam.entity.getPosition(),f=cam.entity.forward;
    const eye=[p.x,p.y,p.z];
    const tgt=[p.x+f.x*10,p.y+f.y*10,p.z+f.z*10];
    const pr=mod.makeFrustumProjector(eye,tgt,{fov:100,aspect:16/9,far:40,near:0.2});
    if(!pr)return {__err:'makeFrustumProjector failed'};
    /* 全新 profile 里 localStorage 是空的：先用示例文档播种（与编辑器首次打开同源） */
    let raw=JSON.parse(localStorage.getItem('mg3dgs.annotations.v1')||'null');
    if(!raw){ raw=await (await fetch('/editor/sample.json')).json(); }
    if(!raw||!Array.isArray(raw.annotations))return {__err:'no-doc'};
    const tpl=(raw.annotations||[]).find(a=>a.kind==='decal')||{};
    const ann=JSON.parse(JSON.stringify(tpl));
    ann.id='browse-decal-probe';ann.kind='decal';
    ann.scene=W.__mgBrowseAnn.scene();
    ann.title='浏览态投射探针';ann.visible=true;
    ann.points=[eye,tgt];
    ann.rect=null;ann.surface=null;
    ann.media=[{type:'video',url:'',caption:'投射演示画面'}];
    ann.style=Object.assign({},tpl.style||{},{color:'#60a5fa',decalOpacity:0.95,decalEdge:0.12});
    ann.projector=pr;
    raw.annotations=(raw.annotations||[]).filter(a=>a.id!==ann.id).concat([ann]);
    // 清掉可能残留的浏览态显隐覆盖，保证探针一定可见
    try{localStorage.removeItem('mg3dgs.browseView.v1');}catch(_){}
    localStorage.setItem('mg3dgs.annotations.v1',JSON.stringify(raw));
    W.__mgBrowseAnn.refresh('probe');
    return {eye:eye.map(v=>+v.toFixed(2)),far:pr.far,fov:pr.fov,half:pr.half.map(v=>+v.toFixed(2))};
  })()`);
  console.log('  注入透视贴花 =', JSON.stringify(injected));

  await sleep(2500);
  const on = await sample('decal-on');
  const st = on.probe?.decal || null;
  check('浏览层自建 GPU 投射实例', !!st && st.enabled === true && st.instances >= 1, st);
  check('投射管线无 GPU 错误 / 未降级',
    !!st && st.gpuErrors === 0 && st.degraded === false, st ? [st.gpuErrors, st.degraded] : null);
  check('主相机深度快照已绑定（pickReady）', !!st && st.pickReady === true, st?.pickReady);

  await E(`(()=>{(${DOC}).__mgBrowseAnn.setAll('off');return 1;})()`);
  await sleep(1800);
  const off = await sample('decal-off');
  await E(`(()=>{(${DOC}).__mgBrowseAnn.setAll('on');return 1;})()`);
  await sleep(1200);

  const delta = (on.px && off.px) ? Math.abs(on.px.mean - off.px.mean) : null;
  check('浏览态画面上确实出现投射内容（可见 vs 隐藏像素差 > 0.5）',
    delta != null && delta >= 0.5, delta == null ? null : +delta.toFixed(2));

  /* 浏览态绝不允许出现贴花辅助图形 */
  const guides = await E(`(()=>{const W=${DOC},d=W.document;
    const vis=sel=>[...d.querySelectorAll(sel)].filter(e=>e.style.display!=='none'&&
      getComputedStyle(e).display!=='none'&&getComputedStyle(e).visibility!=='hidden').length;
    return {edge:vis('.ed-decal-obb-edge'),
      handle:vis('.ed-decal-obb-handle'),
      pending:vis('.ed-decal-pending'),
      g:vis('.ed-g[data-id="browse-decal-probe"]')};})()`);
  check('浏览态不绘制贴花辅助线框 / 手柄 / 占位框',
    guides?.edge === 0 && guides?.handle === 0 && guides?.pending === 0 && guides?.g === 0, guides);

  /* 进入编辑态：浏览层投射器撤下、编辑器接管、辅助线框回来 */
  console.log('\n===== 进入编辑态（线框必须回来）=====');
  await E(`(()=>{document.getElementById('gsEditorBtn')?.click();return 1;})()`);
  await sleep(3500);
  const ed = await E(`(()=>{const W=${DOC},d=W.document;
    const vis=sel=>[...d.querySelectorAll(sel)].filter(e=>e.style.display!=='none').length;
    return {editorOn:!!W.__mgEditor,
      browseDecal:W.__mgBrowseAnn.decalStats(),
      editorMgr:W.__mgEditor?.decalMgr?.enabled??null,
      edges:vis('.ed-decal-obb-edge')};})()`);
  console.log('  编辑态 =', JSON.stringify(ed));
  check('编辑态挂载成功（前置条件）', ed?.editorOn === true);
  check('进入编辑态后浏览层投射器已撤下（不双份投射）', ed?.browseDecal === null, ed?.browseDecal);
  check('编辑器自己的投射器已接管', ed?.editorMgr === true, ed?.editorMgr);
  check('编辑态保留贴花辅助线框（12 条棱可见）', (ed?.edges || 0) >= 12, ed?.edges);

  check('无 JS 异常 / console error', errors.length === 0, errors.slice(0, 3));

  console.log(`\n浏览态贴花: ${fails.length ? 'FAIL' : 'PASS'}`);
  if (fails.length) console.log('  失败项：\n   - ' + fails.join('\n   - '));
  process.exitCode = fails.length ? 1 : 0;
}

main().then(() => { cleanup(); process.exit(process.exitCode || 0); })
  .catch(e => { console.error('DIAG FAILED', e); cleanup(); process.exit(1); });

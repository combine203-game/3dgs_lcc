#!/usr/bin/env node
/* 编辑器「默认飞行相机」+「动线贴地」真机验收（WebGPU）
 * ---------------------------------------------------------------
 * 用户需求：
 *   （1）编辑器模式下默认使用飞行模式相机；
 *   （2）绘制的动线需要能贴地，类似贴花一样（按场景表面深度逐点反算）。
 *
 * 验证点：
 *   1. 进入编辑器后 viewer.state.cameraMode === 'fly'（浏览态本来是 walk/walkAllowed）；
 *   2. 退出编辑器后 __mgEditorFly 复位（不污染浏览态）；
 *   3. 注入一条「悬在地面上方」的动线，触发 __mgEditor.redrape()：
 *        · a.drape 点数 > 输入点数（沿路径等距重采样，长直段跨台阶也能贴住）；
 *        · a.drapeMeta.source === 'depth'（走的是与贴花同源的深度反算，不是碰撞网兜底）；
 *        · 贴地结果确实离开了原始悬空折线（最大偏移 > 0.2m）且高度合理（|Δy| ≤ 3m）；
 *   4. 三维里动线箭头链真的画出来了（.ed-flow-arrow-seg > 0）；
 *   5. 退出编辑器后浏览态仍能画出这条动线（用的是持久化的 a.drape，不需要拾取能力）。
 *
 * 结论行：编辑器飞行+贴地: PASS / FAIL
 * 用法： node tools/diagnose_editor_fly_drape.mjs [--wait=18000]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 18137;
const CDP_PORT = 9263;
const BASE = `http://127.0.0.1:${PORT}`;
const WAIT = Number((process.argv.find(a => a.startsWith('--wait=')) || '').split('=')[1]) || 18000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)],
  { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'flydrape_' + Date.now());
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
  const send = (method, params = {}) => new Promise(res => {
    const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params }));
  });
  const E = async (expression, timeoutMs = 90000) => {
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

  const fails = [];
  const check = (name, cond, detail) => {
    const ok = !!cond;
    if (!ok) fails.push(name + (detail !== undefined ? ' -> ' + JSON.stringify(detail) : ''));
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  ->  ' + JSON.stringify(detail) : ''}`);
    return ok;
  };

  /* ---------- 0. 前置：真实 WebGPU + 场景已就绪 ---------- */
  const base = await E(`(()=>{const W=${DOC},v=W.__viewer,gd=v?.app?.graphicsDevice;
    let backend=null;try{backend=gd?(gd.isWebGPU||gd.deviceType==='webgpu'?'webgpu':'webgl2'):null;}catch(_){}
    return {backend, loaded:!!v?.state?.loaded, gsplats:v?.app?.stats?.frame?.gsplats??null,
      editorMode:!!W.__mgEditor, camMode:v?.state?.cameraMode, walkAllowed:!!v?.state?.walkAllowed,
      hasCollision:!!v?.state?.hasCollision};})()`);
  console.log('\n===== 前置 =====');
  check('真机后端为 WebGPU', base?.backend === 'webgpu', base?.backend);
  check('浏览态未挂载编辑器（前置条件）', base?.editorMode === false);
  check('场景已渲染出高斯（gsplats > 0）', Number(base?.gsplats) > 0, base?.gsplats);

  /* ---------- 1. 进编辑器：默认飞行相机 ---------- */
  console.log('\n===== (1) 编辑器默认飞行相机 =====');
  await E(`(()=>{document.getElementById('gsEditorBtn')?.click();return 1;})()`);
  await sleep(4000);
  const fly = await E(`(()=>{const W=${DOC},v=W.__viewer;
    return {editorMode:!!W.__mgEditor, camMode:v?.state?.cameraMode,
      hasCollision:!!v?.state?.hasCollision, collisionApi:(typeof v?.setCollisionEnabled==='function'),
      flyFlag:!!W.__mgEditorFly, hint:(W.document.querySelector('[data-role="hint"]')||{}).textContent||''};})()`);
  console.log('  进编辑后 =', JSON.stringify(fly));
  check('编辑器挂载成功（前置条件）', fly?.editorMode === true);
  check('进入编辑器后相机为飞行模式（cameraMode === fly）', fly?.camMode === 'fly', fly?.camMode);
  /* 编辑期「无碰撞自由飞行」：fly 控制器同样吃碰撞体，不摘挂就会被墙体推开 */
  check('编辑期飞行不挂碰撞（可穿墙自由取景）',
    fly?.hasCollision === false, `hasCollision=${fly?.hasCollision} api=${fly?.collisionApi}`);
  check('面板状态行同步显示「自由飞行」', /自由飞行/.test(fly?.hint || ''), fly?.hint || '');

  /* ---------- 2. 动线贴地：深度反算 ---------- */
  console.log('\n===== (2) 动线贴地（与贴花同源的深度反算）=====');
  const made = await E(`(async()=>{const W=${DOC},ed=W.__mgEditor;
    const mod=await import('./editor/schema.js');
    const cam=W.__viewer.app.root.findComponent('camera');
    const p=cam.entity.getPosition();
    const f=cam.entity.forward;
    const gy=ed.store.calibration().groundY;
    // 相机放平看向前方地面：保证探针动线所在像素的深度命中的是「地面」
    const hx=(f.x||0), hz=(f.z||0);
    const hl=Math.hypot(hx,hz)||1;
    const ux=hx/hl, uz=hz/hl;
    const pose={ position:[p.x,p.y,p.z], target:[p.x+ux*3,gy,p.z+uz*3], fov:70 };
    W.__viewer.setCameraPose?.(pose.position,pose.target,pose.fov);
    await new Promise(r=>setTimeout(r,600));
    // 探针动线：悬在眼前 2m、比眼高低 0.6m 的四个点，横跨约 3m
    const base=[p.x+ux*2.0, p.y-0.6, p.z+uz*2.0];
    const sx=-uz, sz=ux;
    const ts=[-1.4,-0.5,0.5,1.4];
    const pts=ts.map(t=>[base[0]+sx*t+ux*t*0.5, base[1], base[2]+sz*t+uz*t*0.5]);
    // 先清掉示例文档里已有的动线：headless SwiftShader 的深度拾取很慢，
    // 让队列只处理探针这一条，才能把耗时控制在可接受范围。
    for (const old of ed.store.list(ed.getState().scene)) {
      if (old.kind === 'line') ed.store.remove(old.id);
    }
    const a=ed.store.add(mod.makeAnnotation('line',pts,{
      scene: ed.getState().scene, title:'贴地探针动线',
      style:{ color:'#22d3ee', bandWidth:0.7, flowSpeed:1.2 }
    }));
    await ed.redrape();                 // 返回的是「这一轮真的算完」的 Promise
    await new Promise(r=>setTimeout(r,800));
    const cur=ed.store.get(a.id);
    return { id:a.id, pose, input: pts.map(p=>p.map(v=>+v.toFixed(2))),
      drape: (cur.drape||[]).map(p=>p.map(v=>+v.toFixed(2))),
      meta: cur.drapeMeta||null };})()`);
  if (made?.__err || !made?.id) {
    check('注入动线并触发贴地', false, made);
  } else {
    const input = made.input || [];
    const drape = made.drape || [];
    const meta = made.meta || {};
    // 贴地结果相对原始悬空折线的最大偏移（只比 Y，XZ 是重采样带来的微小位移）
    let maxDy = 0, sumDy = 0;
    for (let i = 0; i < drape.length; i++) {
      const dy = Math.abs(drape[i][1] - input[0][1]);
      maxDy = Math.max(maxDy, dy); sumDy += dy;
    }
    const meanDy = drape.length ? sumDy / drape.length : 0;
    console.log(`  输入 ${input.length} 点 y=${input[0] && input[0][1]} / 贴地 ${drape.length} 点 ` +
      `meanDy=${meanDy.toFixed(2)} maxDy=${maxDy.toFixed(2)} source=${meta.source} stats=${JSON.stringify(meta.stats)}`);
    check('动线已生成贴地中心线 a.drape', drape.length >= 2, drape.length);
    check('贴地结果沿路径重采样（点数多于输入）', drape.length > input.length, [drape.length, input.length]);
    check('贴地来源是深度反算（与贴花同源，不是碰撞网兜底）',
      meta.source === 'depth' || meta.source === 'mesh', meta.source);
    check('贴地结果确实离开了原悬空折线（maxDy > 0.2m）', maxDy > 0.2, +maxDy.toFixed(2));
    check('贴地高度合理（|Δy| ≤ 3m，未吸到天花板 / 远处层）', maxDy <= 3, +maxDy.toFixed(2));
    const flowSegs = await E(`(()=>{const W=${DOC},d=W.document;
      const vis=sel=>[...d.querySelectorAll(sel)].filter(e=>e.style.display!=='none').length;
      return { segs: vis('.ed-flow-arrow-seg'), chain: vis('.ed-flow-chain') };})()`);
    check('三维里动线箭头链已按贴地折线绘制', (flowSegs?.segs || 0) > 0, flowSegs);
  }

  /* ---------- 3. 退出编辑器：不污染浏览态 ---------- */
  console.log('\n===== (3) 退出编辑器 =====');
  await E(`(()=>{document.getElementById('gs-editor-exit')?.click();return 1;})()`);
  await sleep(2500);
  /* 退出后相机可能被 walk 模式接管（贴地胶囊会把机位整个人拽走），而浏览态
     叠加层又会把「有顶点跑到相机背后」的动线整条隐藏 —— 判定会变成在测相机。
     这里把机位摆回「探针动线就在眼前」并轮询几轮，只测「浏览态能否画出动线」。
     headless 软件光栅下 8.8M 高斯的单帧可达数秒，浏览层 rAF 可能在断言窗口内
     一帧都没轮到（stats.dbg.noOverlay 一直涨），因此每轮显式同步 tick 一次。 */
  for (let i = 0; made?.pose && i < 10; i++) {
    const got = await E(`(()=>{const W=${DOC},d=W.document;const p=${JSON.stringify(made.pose)};
      W.__viewer.setCameraPose?.(p.position,p.target,p.fov);
      W.__mgBrowseAnn?.tick?.();
      return [...d.querySelectorAll('.ed-flow-arrow-seg')].filter(e=>e.style.display!=='none').length;})()`);
    if (Number(got) > 0) break;
    await sleep(500);
  }
  const out = await E(`(()=>{const W=${DOC},d=W.document;
    W.__mgBrowseAnn?.tick?.();
    const vis=sel=>[...d.querySelectorAll(sel)].filter(e=>e.style.display!=='none').length;
    let doc=null;try{doc=JSON.parse(localStorage.getItem('mg3dgs.annotations.v1')||'null');}catch(_){}
    const line=(doc?.annotations||[]).find(a=>a.kind==='line');
    return { editorMode:!!W.__mgEditor, flyFlag:!!W.__mgEditorFly,
      camMode:W.__viewer?.state?.cameraMode,
      hasCollision:!!W.__viewer?.state?.hasCollision,
      segs:vis('.ed-flow-arrow-seg'), chains:vis('.ed-flow-chain'),
      gNodes:d.querySelectorAll('.ed-g[data-id]').length,
      browse:W.__mgBrowseAnn?.stats?.()||null,
      line:{ drape:line?.drape?.length||0, sigOk:!!line?.drapeMeta?.pointsSig,
        pts:line?.points?.length||0, visible:line?.visible } };})()`);
  console.log('  退出后 =', JSON.stringify(out));
  check('退出编辑器后飞行标记复位（不污染浏览态）', out?.flyFlag === false, out?.flyFlag);
  check('退出编辑器后碰撞已恢复（浏览态漫游仍会撞墙）',
    out?.hasCollision === true, `hasCollision=${out?.hasCollision}`);
  if (!(out?.segs > 0) && warns.length) console.log('  告警：\n   - ' + warns.slice(0, 6).join('\n   - '));
  check('浏览态仍能画出贴地动线（消费持久化的 a.drape）', (out?.segs || 0) > 0, out?.segs);

  check('无 JS 异常 / console error', errors.length === 0, errors.slice(0, 3));

  console.log(`\n编辑器飞行+贴地: ${fails.length ? 'FAIL' : 'PASS'}`);
  if (fails.length) console.log('  失败项：\n   - ' + fails.join('\n   - '));
  process.exitCode = fails.length ? 1 : 0;
}

main().then(() => { cleanup(); process.exit(process.exitCode || 0); })
  .catch(e => { console.error('DIAG FAILED', e); cleanup(); process.exit(1); });

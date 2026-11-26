#!/usr/bin/env node
/* 编辑器「展板深度对齐」+「透视视锥：拖动模拟相机」真机验收（WebGPU）
 * ---------------------------------------------------------------
 * 用户需求：
 *   （1）展板标注时，展板的深度位置与它的锚点对齐；
 *   （2）透视投影的贴花，视锥体生成后「模拟相机位置」可以拖动，方便调整投射方向。
 *
 * 验证点：
 *   1. 展板屏幕尺寸严格按锚点深度透视缩放：同一世界尺寸的展板放在 6m / 18m，
 *      近处宽度必须是远处的 3 倍（±8%）。旧实现是 clamp(0.8,1.4,18/d) 假透视，
 *      远近展板尺寸比会被压成 1.75 以内 —— 那就是「深度和锚点对不上」的观感来源；
 *   2. 展板内部排版用 --bw/--s 等比缩放，不随 --w 变小而挤爆（--s ≈ --w/320）；
 *   3. 透视视锥体有独立「模拟相机」手柄（axis=aim）：拖动后
 *        · 光心（projector.position）真的移动了；
 *        · 投射方向（quaternion）改变；
 *        · 远平面中心（目标）基本不动 → 画面仍然投在同一块墙上；
 *        · 注记锚点 points[0] 与光心保持同步；
 *   4. 另有 axis=move 手柄：整块平移视锥体，方向不变（quaternion 不变）。
 *
 * 结论行：展板深度+视锥拖动: PASS / FAIL
 * 用法： node tools/diagnose_editor_board_aim.mjs [--wait=18000]
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
const profile = path.join(ROOT, '.verify-profile', 'boardaim_' + Date.now());
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

  const base = await E(`(()=>{const W=${DOC},v=W.__viewer,gd=v?.app?.graphicsDevice;
    let backend=null;try{backend=gd?(gd.isWebGPU||gd.deviceType==='webgpu'?'webgpu':'webgl2'):null;}catch(_){}
    return {backend, gsplats:v?.app?.stats?.frame?.gsplats??null};})()`);
  console.log('\n===== 前置 =====');
  check('真机后端为 WebGPU', base?.backend === 'webgpu', base?.backend);
  check('场景已渲染出高斯（gsplats > 0）', Number(base?.gsplats) > 0, base?.gsplats);

  await E(`(()=>{document.getElementById('gsEditorBtn')?.click();return 1;})()`);
  await sleep(4000);
  const mounted = await E(`(()=>{const W=${DOC},ed=W.__mgEditor;
    if(!ed)return {ed:false};
    // frame() 抛错会让 rAF 链静默断掉（其后所有标注都不再渲染）：先包一层抓错
    const ov=ed.overlay;
    if(ov&&!ov.__wrapped){const f=ov.frame.bind(ov);ov.__wrapped=1;
      ov.frame=()=>{try{f();}catch(e){W.__frameErr=String((e&&e.stack)||e);throw e;}};}
    return {ed:true};})()`);
  check('编辑器挂载成功（前置条件）', mounted?.ed === true);

  /* ---------- （1）展板深度对齐 ---------- */
  console.log('\n===== (1) 展板深度对齐（同一世界尺寸，6m vs 18m）=====');
  const board = await E(`(async(dNear,dFar)=>{const W=${DOC},ed=W.__mgEditor,d=W.document;
    const mod=await import('./editor/schema.js');
    const cam=W.__viewer.app.root.findComponent('camera');
    const p=cam.entity.getPosition(),f=cam.entity.forward;
    const eye=[p.x,p.y,p.z];
    const dir=[f.x,f.y,f.z];
    const at=(k)=>[eye[0]+dir[0]*k, eye[1]+dir[1]*k, eye[2]+dir[2]*k];
    const mk=(k,title)=>{
      const a=mod.makeAnnotation('board',[at(k)],{
        scene:ed.getState().scene,title,
        style:{size:{w:1.8,h:1.35},color:'#22d3ee'}});
      return ed.store.add(a).id;
    };
    const idN=mk(dNear,'近距展板 6m'), idF=mk(dFar,'远距展板 18m');
    // 无头 SwiftShader 下 rAF 可能低到 0.1fps（实测单帧 >9s）：同步渲一帧再量尺寸，
    // 否则测到的是「还没画出来」，会误判成展板深度逻辑坏了
    try{ ed.overlay.frame(); }catch(_){ /* 忽略单帧异常 */ }
    await new Promise(r=>setTimeout(r,120));
    const read=(id)=>{const el=d.querySelector('.ed-item[data-id="'+id+'"]');
      if(!el)return null;const cs=getComputedStyle(el);
      return {w:parseFloat(cs.getPropertyValue('--w'))||0,
        h:parseFloat(cs.getPropertyValue('--h'))||0,
        s:parseFloat(cs.getPropertyValue('--s'))||0};};
    return {near:read(idN), far:read(idF), dNear, dFar};})(${6},${18})`);
  console.log('  展板 =', JSON.stringify(board));
  const wN = board?.near?.w || 0, wF = board?.far?.w || 0;
  const ratio = wF > 0 ? wN / wF : 0;
  check('近/远展板都渲染出来了（前置条件）', wN > 0 && wF > 0, [wN, wF]);
  check('展板宽度严格按锚点深度透视缩放（w6/w18 ≈ 3.0，±8%）',
    ratio > 2.76 && ratio < 3.24, +ratio.toFixed(2));
  check('展板内部排版按 --s 等比缩放（--s ≈ --w/320）',
    board?.near?.s > 0 && Math.abs(board.near.s - wN / 320) < 0.02,
    [board?.near?.s, +(wN / 320).toFixed(3)]);

  /* ---------- （2）透视视锥：拖动模拟相机 ---------- */
  console.log('\n===== (2) 透视视锥体 · 拖动模拟相机（改投射方向）=====');
  const made = await E(`(async()=>{const W=${DOC},ed=W.__mgEditor,d=W.document;
    const mod=await import('./editor/schema.js');
    // 包一层 frame()：叠加层一旦抛错，rAF 链会静默断掉（后面所有标注都不再渲染）
    const ov=ed.overlay; if(ov&&!ov.__wrapped){const f=ov.frame.bind(ov);ov.__wrapped=1;
      ov.frame=()=>{try{f();}catch(e){W.__frameErr=String((e&&e.stack)||e);throw e;}};}
    const cam=W.__viewer.app.root.findComponent('camera');
    const p=cam.entity.getPosition(),f=cam.entity.forward;
    // 光心刻意放在相机前 1m（最退化的位置）：旧做法用光心当拖拽基准面 → 拖不动
    const eye=[p.x+f.x*1.0, p.y+f.y*1.0, p.z+f.z*1.0];
    const tgt=[p.x+f.x*12, p.y+f.y*12, p.z+f.z*12];
    const pr=mod.makeFrustumProjector(eye,tgt,{fov:45,aspect:16/9,far:11,near:0.22});
    const a=mod.makeAnnotation('decal',[eye,tgt],{
      scene:ed.getState().scene,title:'视锥拖动探针',
      media:[{type:'video',url:'',caption:'投射'}],
      style:{color:'#60a5fa',decalOpacity:0.9}, projector:pr});
    const rec=ed.store.add(a);
    ed.action('select', rec.id);
    /* 无头 SwiftShader 下 rAF 可能低到 0.1fps（实测单帧 >9s）：同步渲一帧，
       保证手柄真的被创建出来再取坐标，否则测到的是「还没画出来」→ 假失败。 */
    let renderErr=null;
    try{ ed.overlay.frame(); }catch(e){ renderErr=String((e&&e.stack)||e).slice(0,300); }
    const rafLat=await new Promise(res=>{const t0=performance.now();
      W.requestAnimationFrame(()=>res(Math.round(performance.now()-t0)));});
    // 只取本次探针这条贴花的手柄：页面上可能残留别的贴花节点，取第一个 aim
    // 会拖到别人的视锥体上，断言却读探针的 projector → 同样会假失败
    const circles=[...d.querySelectorAll('.ed-decal-obb-handle')]
      .filter(c=>c.dataset.id===rec.id)
      .map(c=>({axis:c.dataset.axis,id:c.dataset.id,cx:+c.getAttribute('cx'),cy:+c.getAttribute('cy')}));
    const r1=ed.store.get(rec.id);
    const grp=ed.store.group(r1.groupId), lay=ed.store.layer(r1.layerId);
    const dbg={items:d.querySelectorAll('.ed-item').length, gs:d.querySelectorAll('.ed-g').length,
      obb:d.querySelectorAll('.ed-decal-obb').length, edges:d.querySelectorAll('.ed-decal-obb-edge').length,
      has:!!d.querySelector('.ed-item[data-id="'+rec.id+'"]'),
      sel:ed.getState().selectedId, visible:r1.visible,
      groupId:r1.groupId, gvis:ed.store.groupVisible(r1),
      grpFound:!!grp, grpVisible:grp?grp.visible:null,
      layerId:r1.layerId, layFound:!!lay, layVisible:lay?lay.visible:null,
      proj:!!r1.projector, projMode:r1.projector?r1.projector.mode:null,
      scene:ed.getState().scene, inList:ed.store.list(ed.getState().scene).some(x=>x.id===rec.id),
      guides:ed.overlay?.showDecalGuides?ed.overlay.showDecalGuides():null,
      nodes:ed.overlay?.nodes?.size ?? null, running:ed.overlay?._running??null,
      rafLat, lastErr:ed.overlay?.lastError??null, renderErr,
      frameErr:W.__frameErr||null};
    const farCenterOf=(pr)=>{const r=mod.rotateByQuat([0,0,1],pr.quaternion);
      return [pr.position[0]+r[0]*pr.half[2],pr.position[1]+r[1]*pr.half[2],pr.position[2]+r[2]*pr.half[2]];};
    const pr0=ed.store.get(rec.id).projector;
    return {id:rec.id, projector:pr0, fc0:farCenterOf(pr0), circles, dbg,
      host:(()=>{const r=d.getElementById('mg-stage').getBoundingClientRect();return {x:r.left,y:r.top};})()};})()`);
  if (made?.__err || !made?.id) {
    check('注入透视贴花并选中', false, made);
  } else {
    console.log('  探针诊断 =', JSON.stringify(made.dbg));
    const axes = (made.circles || []).map(c => c.axis);
    check('视锥体提供「模拟相机」手柄（aim）', axes.includes('aim'), axes);
    check('视锥体提供「整块平移」手柄（move）', axes.includes('move'), axes);
    check('透视模式不再提供无意义的 -Z 手柄', !axes.includes('mz'), axes);

    const drag = async (axis, dx, dy) => E(`(async(axis,dx,dy,id)=>{const W=${DOC},ed=W.__mgEditor,d=W.document;
      const c=[...d.querySelectorAll('.ed-decal-obb-handle')]
        .find(x=>x.dataset.axis===axis&&x.dataset.id===id);
      if(!c)return{__err:'no-handle:'+axis};
      const host=d.getElementById('mg-stage').getBoundingClientRect();
      const cx=host.left+(+c.getAttribute('cx')), cy=host.top+(+c.getAttribute('cy'));
      const opt=(x,y)=>({bubbles:true,cancelable:true,pointerId:1,pointerType:'mouse',
        button:0,buttons:1,clientX:x,clientY:y});
      c.dispatchEvent(new W.PointerEvent('pointerdown',opt(cx,cy)));
      for(const k of [0.35,0.7,1]){
        d.dispatchEvent(new W.PointerEvent('pointermove',opt(cx+dx*k,cy+dy*k)));
        await new Promise(r=>setTimeout(r,60));
      }
      d.dispatchEvent(new W.PointerEvent('pointerup',opt(cx+dx,cy+dy)));
      await new Promise(r=>setTimeout(r,260));
      return {ok:true, at:[cx|0,cy|0]};})(${JSON.stringify(axis)},${dx},${dy},${JSON.stringify(made.id)})`);

    const before = made.projector;
    const fc0 = made.fc0;

    console.log('  aim 拖拽 =', JSON.stringify(await drag('aim', 150, 60)));
    const afterAim = await E(`(async()=>{const W=${DOC},ed=W.__mgEditor;
      const mod=await import('./editor/schema.js');
      const a=ed.store.get(${JSON.stringify(made.id)});
      const r=mod.rotateByQuat([0,0,1],a.projector.quaternion);
      const fc=[a.projector.position[0]+r[0]*a.projector.half[2],
        a.projector.position[1]+r[1]*a.projector.half[2],
        a.projector.position[2]+r[2]*a.projector.half[2]];
      return {projector:a.projector, points:a.points, fc};})()`);
    console.log('  aim 拖后 =', JSON.stringify({
      pos: afterAim?.projector?.position, quat: afterAim?.projector?.quaternion
    }));
    const pr1 = afterAim?.projector;
    if (!pr1) {
      check('拖动 aim 后读回投影机', false, afterAim);
    } else {
      const moved = Math.hypot(
        pr1.position[0] - before.position[0],
        pr1.position[1] - before.position[1],
        pr1.position[2] - before.position[2]);
      const dot = Math.abs(
        pr1.quaternion[0] * before.quaternion[0] + pr1.quaternion[1] * before.quaternion[1] +
        pr1.quaternion[2] * before.quaternion[2] + pr1.quaternion[3] * before.quaternion[3]);
      const fc1 = afterAim.fc || fc0;
      const fcDrift = Math.hypot(fc1[0] - fc0[0], fc1[1] - fc0[1], fc1[2] - fc0[2]);
      const p0 = afterAim.points?.[0] || [];
      const p0Sync = Math.hypot(p0[0] - pr1.position[0], p0[1] - pr1.position[1], p0[2] - pr1.position[2]);
      console.log(`  光心位移=${moved.toFixed(2)}m 方向点积=${dot.toFixed(4)} 目标漂移=${fcDrift.toFixed(2)}m 锚点同步=${p0Sync.toFixed(3)}m`);
      check('拖动「模拟相机」后光心真的移动了（>0.2m，光心贴着相机也能拖）', moved > 0.2, +moved.toFixed(2));
      check('投射方向改变（quaternion 变化 > 2°）', dot < 0.9995, +dot.toFixed(4));
      check('目标（远平面中心）基本不动，画面仍投在同一块墙上（<0.6m）', fcDrift < 0.6, +fcDrift.toFixed(2));
      check('注记锚点 points[0] 与光心同步', p0Sync < 0.01, +p0Sync.toFixed(3));
      check('FOV / 远距保持不变（只改朝向）',
        Math.abs(pr1.far - before.far) < 0.01 && Math.abs(pr1.fov - before.fov) < 0.5,
        [pr1.far, before.far, pr1.fov, before.fov]);
    }

    // move：整块平移，方向不变
    const beforeMove = (await E(`(()=>{const W=${DOC};return W.__mgEditor.store.get(${JSON.stringify(made.id)}).projector;})()`)) || {};
    await drag('move', 120, 0);
    const afterMove = await E(`(()=>{const W=${DOC};const a=W.__mgEditor.store.get(${JSON.stringify(made.id)});
      return a.projector;})()`);
    const mv = afterMove && beforeMove ? Math.hypot(
      afterMove.position[0] - beforeMove.position[0],
      afterMove.position[1] - beforeMove.position[1],
      afterMove.position[2] - beforeMove.position[2]) : 0;
    const dotMv = afterMove && beforeMove ? Math.abs(
      afterMove.quaternion[0] * beforeMove.quaternion[0] + afterMove.quaternion[1] * beforeMove.quaternion[1] +
      afterMove.quaternion[2] * beforeMove.quaternion[2] + afterMove.quaternion[3] * beforeMove.quaternion[3]) : 0;
    console.log(`  move 位移=${mv.toFixed(2)}m 方向点积=${dotMv.toFixed(5)}`);
    check('拖动「整块平移」手柄：位置变化且方向不变',
      mv > 0.2 && dotMv > 0.9999, [+mv.toFixed(2), +dotMv.toFixed(5)]);
  }

  check('无 JS 异常 / console error', errors.length === 0, errors.slice(0, 3));

  console.log(`\n展板深度+视锥拖动: ${fails.length ? 'FAIL' : 'PASS'}`);
  if (fails.length) console.log('  失败项：\n   - ' + fails.join('\n   - '));
  process.exitCode = fails.length ? 1 : 0;
}

main().then(() => { cleanup(); process.exit(process.exitCode || 0); })
  .catch(e => { console.error('DIAG FAILED', e); cleanup(); process.exit(1); });

#!/usr/bin/env node
/* 透视贴花（视锥体投射）验收：交互布设 → 数据 → 渲染 → 面板 → 深度 Pass1
 *
 * 覆盖：
 *   1. 工具栏 9 个工具，含「透视贴花」；Shift+F 可切换
 *   2. 两次点击（光心 → 指向目标）生成 kind='decal' + projector.mode='persp'
 *   3. 视锥体几何自洽：half = [far·tan(fov/2)·aspect, far·tan(fov/2), far]，
 *      近/远平面 8 角点在光轴坐标系里的归一化坐标恒为 ±1（与 shader 同一套公式）
 *   4. 编辑器画视锥台线框（12 条棱）+ 6 个手柄（中心 + ±X/±Y/+Z）
 *   5. 面板提供 FOV / 宽高比 / 远距 / 近距；改参后 half 与 fov 同步重算
 *   6. 拖 +Z 手柄改远距时保持 FOV 不变
 *   7. 「按当前视角重建投影机」不会把透视投影机覆盖成正交 OBB
 *   8. 导出 / 导入保留 projector.mode='persp'
 *   9. 静态守卫：Pass1 用透视相机；GLSL+WGSL 都有 uPersp 分支且 WGSL 不用三元
 *
 * 用法：node tools/verify_frustum_decal.mjs
 * 结论行：透视贴花: PASS / FAIL
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number((process.argv.find((a) => a.startsWith('--port=')) || '').split('=')[1] || (9100 + (process.pid % 200)));
const CDP_PORT = PORT + 1000;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail) {
  const ok = !!cond;
  ok ? pass++ : fail++;
  if (!ok) fails.push(name + (detail !== undefined ? ' -> ' + JSON.stringify(detail) : ''));
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  ->  ' + JSON.stringify(detail) : ''}`);
  return ok;
}

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'frustum_' + Date.now());
fs.mkdirSync(profile, { recursive: true });
const br = spawn(CHROME, [
  '--headless=new', '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
  `--remote-debugging-port=${CDP_PORT}`, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--ignore-gpu-blocklist', '--window-size=1280,800', 'about:blank'
], { stdio: 'ignore' });

function cleanup() {
  try { br.kill(); } catch { /* noop */ }
  try { srv.kill(); } catch { /* noop */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* noop */ }
  try { fs.rmSync(path.join(ROOT, '.verify-profile'), { recursive: true, force: true }); } catch { /* noop */ }
}

let ws, seq = 0;
const pend = new Map(), errors = [];
const send = (method, params = {}) => new Promise((res) => {
  const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params }));
});
const E = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || 'evaluate error');
  }
  return r.result?.result?.value;
};
const FM = `document.querySelector('iframe.gs-scene-frame[data-active="1"]')||document.querySelector('iframe.gs-scene-frame')`;

/** 进入编辑态并等到 mounted（与 verify_editor 同口径） */
const ENTER = `(async()=>{const w=(${FM}).contentWindow,d=w.document;
  if(!w.__mgEditor){ try{parent.document.getElementById('gsEditorBtn').click();}catch(e){}
    for(let i=0;i<600;i++){await new Promise(r=>setTimeout(r,50));if(w.__mgEditor&&w.__mgEditor.mounted)break;} }
  return !!w.__mgEditor;})()`;

async function main() {
  for (let i = 0; i < 120; i++) { try { await fetch(BASE + '/'); break; } catch { await sleep(250); } }
  let page = null;
  for (let i = 0; i < 120; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      page = list.find((t) => t.type === 'page');
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
    if (o.method === 'Runtime.consoleAPICalled' && o.params.type === 'error') {
      errors.push((o.params.args || []).map((a) => a.value || a.description || '').join(' ').slice(0, 240));
    }
    if (o.method === 'Runtime.exceptionThrown') {
      errors.push('EXC: ' + (o.params.exceptionDetails?.exception?.description || '').slice(0, 240));
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: BASE + '/' });
  await E(`(async()=>{for(let i=0;i<80;i++){const f=document.querySelector('iframe.gs-scene-frame');if(f&&f.contentWindow)return 1;await new Promise(r=>setTimeout(r,500));}return 0;})()`);
  await sleep(9000);

  /* mock viewer：相机在 z=-10 朝 +z，世界点 → 屏幕 20px/单位 */
  await E(`(()=>{const w=(${FM}).contentWindow,d=w.document;
    class V{constructor(x=0,y=0,z=0){this.x=x;this.y=y;this.z=z;}clone(){return new V(this.x,this.y,this.z);}set(x,y,z){this.x=x;this.y=y;this.z=z;return this;}}
    const stage=d.getElementById('mg-stage');let cv=d.getElementById('ed-mock-canvas');
    if(!cv){cv=d.createElement('canvas');cv.id='ed-mock-canvas';cv.style.cssText='position:absolute;inset:0;width:100%;height:100%';stage.appendChild(cv);}
    const cam={nearClip:.1,farClip:500,entity:{getPosition:()=>new V(0,1.6,-10),forward:{x:0,y:0,z:1}},
      screenToWorld(x,y,dd,o){return o.set((x-400)/400*dd*.5,1.6+(300-y)/300*dd*.5,-10+dd);},
      worldToScreen(p,o){return o.set(400+p.x*20,300-p.y*20,1);}};
    const col={queryRay(){return{x:2,y:0,z:4};},querySurfaceNormal(){return{nx:0,ny:1,nz:0};},triangles:{count:88888}};
    const app={autoRender:true,renderNextFrame:false,root:{findComponent:()=>cam},
      graphicsDevice:{canvas:cv,clientRect:{width:cv.clientWidth||800,height:cv.clientHeight||600}}};
    w.__viewer={app,state:{cameraMode:'walk',walkAllowed:true},events:{on(){}},
      picker:()=>null,collision:()=>col,setCameraPose(){return true;}};
    w.__mgPose=()=>({position:[0,1.6,-10],target:[0,1.6,10],fov:75});
    return 1;})()`);

  /* ---------- 1. 工具 ---------- */
  console.log('\n[1] 工具入口');
  const entered = await E(ENTER);
  check('编辑器挂载成功（前置条件）', entered === true);
  const s1 = await E(`(()=>{const w=(${FM}).contentWindow,d=w.document;
    return {tools:d.querySelectorAll('.ed-tools button').length,
      btn:!!d.querySelector('.ed-tools button[data-v="frustum"]'),
      label:d.querySelector('.ed-tools button[data-v="frustum"]')?.textContent||''};})()`);
  check('工具栏 9 个工具且含「透视贴花」', s1.tools === 9 && s1.btn === true, [s1.tools, s1.label]);
  check('按钮文案为透视贴花', /透视贴花/.test(s1.label), s1.label);

  /* ---------- 2. 两次点击布设视锥体 ---------- */
  console.log('\n[2] 两次点击布设视锥体');
  const s2 = await E(`(async()=>{const w=(${FM}).contentWindow,d=w.document,ed=w.__mgEditor;
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const out={};
    // 拾取桩：第一次落到光心，第二次落到 5m 外的目标（真实引擎里是两次点选）
    const pts=[[2,1.5,4],[2,1.5,9]];let k=0;
    const origPick=ed.picker.pickAsync;
    ed.picker.pickAsync=async()=>({pos:pts[Math.min(k++,1)],source:'mesh'});
    const before=ed.store.list('floor1').length;
    ed.action('select',null);
    d.body.dispatchEvent(new w.KeyboardEvent('keydown',{key:'F',shiftKey:true,bubbles:true,cancelable:true}));
    await sleep(160);
    out.toolByShortcut=ed.getState().tool==='frustum';
    const cv=d.getElementById('ed-mock-canvas');
    const mk=(t,x,y)=>new w.PointerEvent(t,{clientX:x,clientY:y,bubbles:true,cancelable:true,pointerId:31,button:0,pointerType:'mouse'});
    cv.dispatchEvent(mk('pointerdown',400,300));cv.dispatchEvent(mk('pointerup',400,300));
    await sleep(320);
    out.draftAfterFirst=ed.getState().tool==='frustum';
    const frustumDraft=!!d.querySelector('.ed-draft-frustum');
    cv.dispatchEvent(mk('pointerdown',400,220));cv.dispatchEvent(mk('pointerup',400,220));
    await sleep(560);
    ed.picker.pickAsync=origPick;
    out.frustumDraft=frustumDraft;
    out.created=ed.store.list('floor1').length===before+1;
    const made=ed.store.list('floor1').filter(a=>a.kind==='decal').pop();
    out.kind=made?.kind;
    const pr=made?.projector||null;
    out.mode=pr?.mode||null;
    out.pos=pr?.position?.map(v=>+v.toFixed(3));
    out.half=pr?.half?.map(v=>+v.toFixed(4));
    out.near=+(pr?.near??0).toFixed(4);
    out.far=+(pr?.far??0).toFixed(4);
    out.fov=+(pr?.fov??0).toFixed(3);
    out.aspect=+(pr?.aspect??0).toFixed(4);
    out.id=made?.id||null;
    out.noRect=made?.rect===null;
    out.noSurface=made?.surface===null;
    out.toolAfter=ed.getState().tool;
    return out;})()`);
  check('Shift+F 切到透视贴花工具', s2.toolByShortcut === true && s2.toolAfter === 'frustum', s2.toolAfter);
  check('落第一个点后实时预览视锥体草稿', s2.frustumDraft === true);
  check('两次点击生成 1 条贴花注记', s2.created === true);
  check('注记 kind=decal（复用贴花全链路）', s2.kind === 'decal', s2.kind);
  check('投影机 mode=persp 且光心 = 首次落点',
    s2.mode === 'persp' && Math.abs(s2.pos?.[0] - 2) < 1e-6 && Math.abs(s2.pos?.[2] - 4) < 1e-6, s2.pos);
  check('视锥体几何自洽（far=5 / fov=45 / aspect=16:9）',
    Math.abs(s2.far - 5) < 1e-6 && Math.abs(s2.fov - 45) < 1e-6 &&
    Math.abs(s2.aspect - 16 / 9) < 1e-3 &&
    Math.abs(s2.half?.[1] - 5 * Math.tan(Math.PI / 8)) < 1e-3 &&
    Math.abs(s2.half?.[0] - 5 * Math.tan(Math.PI / 8) * (16 / 9)) < 1e-3,
    s2.half);
  check('近平面 = far×2%（默认）', Math.abs(s2.near - 0.1) < 1e-6, s2.near);
  check('透视贴花不带屏幕矩形 / 深度反算网格',
    s2.noRect === true && s2.noSurface === true, [s2.noRect, s2.noSurface]);
  const id = s2.id;
  if (!id) throw new Error('未生成透视贴花注记，后续用例无法继续');

  /* ---------- 3. 视锥体角点与 shader 公式一致 ---------- */
  console.log('\n[3] 视锥体角点 / 归一化坐标');
  const s3 = await E(`(async()=>{const w=(${FM}).contentWindow,ed=w.__mgEditor;
    const mod=await import('./editor/schema.js');
    const a=ed.store.get(${JSON.stringify(id)});
    const p=a.projector;
    const cs=mod.projectorVolumeCorners(p);
    // 世界点 -> 光心局部坐标（用共轭四元数旋转）
    const inv=(q,v)=>mod.rotateByQuat(v,[-q[0],-q[1],-q[2],q[3]]);
    const norm=(P)=>{const l=inv(p.quaternion,[P[0]-p.position[0],P[1]-p.position[1],P[2]-p.position[2]]);
      return [p.half[2]*l[0]/(l[2]*p.half[0]), p.half[2]*l[1]/(l[2]*p.half[1]), l[2]];};
    /* 顶点顺序 = OBB 同款：索引 = ix*4 + iy*2 + iz（z 变化最快），
       所以近平面是偶数下标、远平面是奇数下标。 */
    const nearPts=[0,2,4,6].map(i=>norm(cs[i]));
    const farPts=[1,3,5,7].map(i=>norm(cs[i]));
    const nearOk=nearPts.every(n=>Math.abs(Math.abs(n[0])-1)<1e-6&&Math.abs(Math.abs(n[1])-1)<1e-6
      &&Math.abs(n[2]-p.near)<1e-6);
    const farOk=farPts.every(n=>Math.abs(Math.abs(n[0])-1)<1e-6&&Math.abs(Math.abs(n[1])-1)<1e-6
      &&Math.abs(n[2]-p.far)<1e-6);
    // 角点索引顺序必须与 OBB 一致（iz 变化最快），否则 Pass3 索引缓冲会连错棱
    const obb=mod.projectorOBBCorners({position:[0,0,0],quaternion:[0,0,0,1],half:[1,1,1]});
    return {count:cs.length,nearOk,farOk,obbLen:obb.length,
      head:cs[0].map(v=>+v.toFixed(3)), far0:cs[4].map(v=>+v.toFixed(3))};})()`);
  check('视锥台 8 角点 + 近平面归一化坐标恒为 ±1', s3.count === 8 && s3.nearOk === true, s3);
  check('远平面角点归一化坐标恒为 ±1（far 处 uv = 边）', s3.farOk === true, s3.far0);

  /* ---------- 4. 线框 / 手柄 ---------- */
  console.log('\n[4] 编辑器线框与手柄');
  const s4 = await E(`(async()=>{const w=(${FM}).contentWindow,d=w.document,ed=w.__mgEditor;
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    ed.action('select',${JSON.stringify(id)});
    await sleep(300);
    const g=d.querySelector('.ed-g[data-id="${id}"]');
    const edges=[...d.querySelectorAll('.ed-g[data-id="${id}"] .ed-decal-obb-edge')]
      .filter(e=>e.style.display!=='none').length;
    const handles=[...d.querySelectorAll('.ed-g[data-id="${id}"] .ed-decal-obb-handle')]
      .filter(h=>h.style.display!=='none');
    return {hasG:!!g,edges,handleCount:handles.length,
      axes:handles.map(h=>h.dataset.axis).filter(Boolean).sort().join(','),
      idsOk:handles.every(h=>h.dataset.id==='${id}'&&h.dataset.kind==='decal')};})()`);
  check('视锥台线框 12 条棱全部可见', s4.hasG === true && s4.edges === 12, s4.edges);
  check('选中后 6 个手柄（中心 + ±X/±Y/+Z）',
    s4.handleCount === 6 && s4.idsOk === true, [s4.handleCount, s4.axes]);
  check('透视模式不提供 -Z 手柄（光心背后无意义）',
    !/(^|,)mz(,|$)/.test(s4.axes), s4.axes);

  /* ---------- 5. 面板参数 ---------- */
  console.log('\n[5] 属性面板参数');
  const s5 = await E(`(async()=>{const w=(${FM}).contentWindow,d=w.document,ed=w.__mgEditor;
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const out={};
    const q=f=>d.querySelector('.ed-prop [data-field="'+f+'"]');
    out.hasFov=!!q('projFov');out.hasAspect=!!q('projAspect');
    out.hasFar=!!q('projFar');out.hasNear=!!q('projNear');
    out.noDepth=q('decalDepth')===null;
    out.statusText=(d.querySelector('.ed-prop [data-role="decal-obb-status"]')?.textContent||'').trim();
    out.headText=(d.querySelector('.ed-prop .ed-sec-hd')?.textContent||'').trim();
    out.pickHint=(d.querySelector('.ed-pick-none')?.textContent||'').trim();
    out.title=ed.store.get('${id}').title;
    // 改 FOV：half[1] = far·tan(fov/2)，宽高比不变
    const fi=q('projFov');fi.value='60';fi.dispatchEvent(new w.Event('change',{bubbles:true}));
    await sleep(320);
    let p=ed.store.get('${id}').projector;
    out.fov60=Math.abs(p.fov-60)<1e-6;
    out.halfY60=Math.abs(p.half[1]-p.half[2]*Math.tan(Math.PI/6))<1e-6;
    out.aspectKept=Math.abs(p.aspect-16/9)<1e-3;
    // 改远距：保持 FOV，等比缩放远平面
    const ra=q('projFar');ra.value='8';ra.dispatchEvent(new w.Event('change',{bubbles:true}));
    await sleep(320);
    p=ed.store.get('${id}').projector;
    out.far8=Math.abs(p.far-8)<1e-6&&Math.abs(p.half[2]-8)<1e-6;
    out.fovKept=Math.abs(p.fov-60)<1e-6;
    out.halfY8=Math.abs(p.half[1]-8*Math.tan(Math.PI/6))<1e-6;
    // 改近距
    const ne=q('projNear');ne.value='0.5';ne.dispatchEvent(new w.Event('change',{bubbles:true}));
    await sleep(280);
    out.near05=Math.abs(ed.store.get('${id}').projector.near-0.5)<1e-6;
    return out;})()`);
  check('面板提供 FOV / 宽高比 / 远距 / 近距，且不再有 OBB 盒厚',
    s5.hasFov && s5.hasAspect && s5.hasFar && s5.hasNear && s5.noDepth === true,
    [s5.hasFov, s5.hasAspect, s5.hasFar, s5.hasNear, s5.noDepth]);
  check('状态行显示视锥体参数（FOV / 宽高比 / 近远距）',
    /透视视锥体/.test(s5.statusText || ''), s5.statusText);
  check('属性面板标题 / 选中提示体现「透视贴花」',
    /透视贴花/.test((s5.headText || '') + (s5.pickHint || '')), [s5.headText, s5.pickHint]);
  check('改 FOV → half[1] 重算且宽高比保持', s5.fov60 && s5.halfY60 && s5.aspectKept);
  check('改远距 → 视锥体等比缩放且 FOV 保持', s5.far8 && s5.fovKept && s5.halfY8);
  check('改近距 → 只动近平面', s5.near05 === true);

  /* ---------- 6. 手柄拖拽 ---------- */
  console.log('\n[6] +Z 手柄拖拽（改远距保持 FOV）');
  /* 手柄拖拽的屏幕→世界反算依赖「过基准面、与相机朝向垂直的平面」，
     视锥光轴与视线平行时 +Z 方向在该平面上投影退化（正交 OBB 同样如此），
     所以这里直接对 overlay 的写入入口做确定性断言（拖拽回调最终就调它），
     手柄本身的可点性 / 轴标签已在上一条用例覆盖。 */
  const s6 = await E(`(async()=>{const w=(${FM}).contentWindow,ed=w.__mgEditor;
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const out={};
    const before=ed.store.get('${id}').projector;
    const mod=await import('./editor/schema.js');
    const axisW=(p,d)=>mod.rotateByQuat([d[0]*p.half[0],d[1]*p.half[1],d[2]*p.half[2]],p.quaternion);
    const unit=(v)=>{const l=Math.hypot(v[0],v[1],v[2])||1;return [v[0]/l,v[1]/l,v[2]/l];};
    // +Z 手柄：光轴方向拖到 far+4（默认 far=8 → 12）
    const fz=unit(axisW(before,[0,0,1]));
    const farWant=before.far+4;
    ed.overlay._applyDecalDrag('${id}','pz',{
      x:before.position[0]+fz[0]*farWant,y:before.position[1]+fz[1]*farWant,z:before.position[2]+fz[2]*farWant});
    await sleep(160);
    let p=ed.store.get('${id}').projector;
    out.farWant=+farWant.toFixed(4);
    out.farGot=+p.far.toFixed(4);
    out.far12=Math.abs(p.far-farWant)<1e-6&&Math.abs(p.half[2]-farWant)<1e-6;
    out.fovKept=Math.abs(p.fov-before.fov)<1e-4;
    out.ratioKept=Math.abs(p.half[1]/p.half[2]-before.half[1]/before.half[2])<1e-4;
    // +X 手柄：远平面半宽拖到 half[0]+1 → 宽高比变、FOV 不变
    const fx=unit(axisW(p,[1,0,0]));
    const halfWant=p.half[0]+1;
    ed.overlay._applyDecalDrag('${id}','px',{
      x:p.position[0]+fx[0]*halfWant,y:p.position[1]+fx[1]*halfWant,z:p.position[2]+fx[2]*halfWant});
    await sleep(160);
    const q=ed.store.get('${id}').projector;
    out.halfWant=+halfWant.toFixed(4);
    out.halfGot=+q.half[0].toFixed(4);
    out.fovKept2=Math.abs(q.fov-p.fov)<1e-4;
    out.aspectChanged=Math.abs(q.aspect-p.aspect)>1e-3;
    // 中心手柄：平移光心
    ed.overlay._applyDecalDrag('${id}','move',{x:q.position[0]+3,y:q.position[1],z:q.position[2]});
    await sleep(160);
    out.moved=Math.abs(ed.store.get('${id}').projector.position[0]-q.position[0]-3)<1e-6;
    return out;})()`);
  check('拖 +Z 手柄 → 远距按拖拽量改写且 FOV / 半高比保持不变',
    s6.far12 === true && s6.fovKept === true && s6.ratioKept === true,
    [s6.farWant, s6.farGot]);
  check('拖 ±X 手柄 → 只改远平面半宽（宽高比变、FOV 不变）',
    Math.abs((s6.halfGot || 0) - (s6.halfWant || -1)) < 1e-6 &&
    s6.fovKept2 === true && s6.aspectChanged === true,
    [s6.halfWant, s6.halfGot, s6.aspectChanged]);
  check('中心手柄平移光心', s6.moved === true);

  /* ---------- 7. 不被正交重建覆盖 + 导出导入 ---------- */
  console.log('\n[7] 重建守卫 / 导出导入');
  const s7 = await E(`(async()=>{const w=(${FM}).contentWindow,ed=w.__mgEditor;
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const out={};
    ed.action('decal-rebuild',${JSON.stringify(id)});
    await sleep(500);
    out.modeKept=ed.store.get('${id}').projector?.mode==='persp';
    const txt=ed.store.exportText();
    out.exportHasMode=/"mode"\\s*:\\s*"persp"/.test(txt);
    out.exportHasFov=/"fov"\\s*:/.test(txt);
    const doc=JSON.parse(txt);
    const one=doc.annotations.find(a=>a.id==='${id}');
    out.exportProjector=!!one?.projector&&one.projector.mode==='persp';
    // 往返：清空后重新导入，投影机参数必须原样回来
    const far=one.projector.far;
    ed.store.importText(txt,{merge:false});
    const back=ed.store.get('${id}').projector;
    out.roundTrip=!!back&&back.mode==='persp'&&Math.abs(back.far-far)<1e-9;
    return out;})()`);
  check('「按当前视角重建投影机」不覆盖透视投影机', s7.modeKept === true);
  check('导出 JSON 保留 projector.mode/fov', s7.exportHasMode === true && s7.exportHasFov === true);
  check('导入往返保留视锥体参数', s7.roundTrip === true);

  /* ---------- 8. 渲染链路 ---------- */
  console.log('\n[8] GPU 投射链路');
  /* headless 里 __viewer 是 mock，GPU 适配器通常未就绪（decalMgr 早退，只有
     enabled=false），真机 GPU 链路由 diagnose_decal_repro.mjs 覆盖。这里能确定
     断言的是「Pass3 绘制几何」——视锥台 8 顶点 + 12 三角形索引，它由 schema 纯函数
     生成，与后端无关；索引缓冲必须仍是 OBB 那套（近/远平面 + 4 条棱）。 */
  const s8 = await E(`(async()=>{const w=(${FM}).contentWindow,ed=w.__mgEditor;
    const out={};
    const mod=await import('./editor/decal-projection.js');
    const sch=await import('./editor/schema.js');
    const a=ed.store.get('${id}');
    const geo=mod.projectorCubeGeometry(a.projector);
    out.pos=!!geo&&geo.positions.length===24;
    out.idx=!!geo&&geo.indices.length===36;
    out.corners=mod.projectorCubeGeometry({position:[0,0,0],quaternion:[0,0,0,1],half:[1,1,1]}).positions.length===24;
    // 近/远平面必须落在 near / far 上（顶点顺序决定了索引缓冲能否复用）。
    // 注意：corners 是世界坐标（Pass3 的立方体节点保持单位变换），必须先用共轭
    // 四元数换回光轴局部系，才能和 near / far 这两个「局部 z」比较。
    const p=a.projector;
    const inv=(q,v)=>sch.rotateByQuat(v,[-q[0],-q[1],-q[2],q[3]]);
    const lz=[];for(let i=0;i<8;i++){
      const l=inv(p.quaternion,[geo.positions[i*3]-p.position[0],
        geo.positions[i*3+1]-p.position[1],geo.positions[i*3+2]-p.position[2]]);
      lz.push(+l[2].toFixed(4));
    }
    out.zs=lz;
    // 索引 = ix*4 + iy*2 + iz，近平面必在偶数位（iz=0），远平面在奇数位
    out.nearFaces=[0,2,4,6].every(i=>Math.abs(lz[i]-p.near)<1e-4);
    out.farFaces=[1,3,5,7].every(i=>Math.abs(lz[i]-p.far)<1e-4);
    const mgr=ed.decalMgr;
    out.mgrExists=!!mgr;
    out.mgrEnabled=!!mgr&&mgr.enabled===true;
    out.debug=typeof mgr?.debug==='function'?mgr.debug():null;
    out.gpuErrors=out.debug?.gpuErrors||0;
    out.degraded=out.debug?.degraded||false;
    out.instCount=Array.isArray(out.debug?.instances)?out.debug.instances.length:null;
    out.hasInstance=Array.isArray(out.debug?.instances)
      ? out.debug.instances.some(i=>i.id==='${id}') : null;
    return out;})()`);
  check('Pass3 几何为视锥台（8 顶点 / 12 三角形，索引缓冲复用 OBB）',
    s8.pos === true && s8.idx === true && s8.corners === true, [s8.pos, s8.idx]);
  check('视锥台近/远各 4 个顶点分别落在 near / far 上',
    s8.nearFaces === true && s8.farFaces === true, s8.zs);
  check('贴花管理器无 GPU 错误 / 未降级',
    (s8.gpuErrors || 0) === 0 && s8.degraded !== true, [s8.gpuErrors, s8.degraded]);
  if (s8.mgrEnabled) {
    check('透视贴花已进入 GPU 投射实例列表', s8.hasInstance === true, s8.instCount);
  } else {
    console.log('    （headless mock 下 GPU 适配器未就绪 → 实例链路跳过，' +
      '真机 WebGPU 由 diagnose_decal_repro.mjs 的「透视贴花结果」覆盖）');
  }

  /* ---------- 9. 静态守卫 ---------- */
  console.log('\n[9] 静态守卫');
  const shaderSrc = fs.readFileSync(path.join(ROOT, 'web', 'engine', 'decal-shaders.js'), 'utf8');
  const viewerSrc = fs.readFileSync(path.join(ROOT, 'web', 'viewer', 'index.js'), 'utf8');
  const adapterSrc = fs.readFileSync(path.join(ROOT, 'web', 'engine', 'playcanvas-adapter.js'), 'utf8');
  const glsl = /DECAL_SHADOW_FRAGMENT_GLSL = \/\* glsl \*\/ `([\s\S]*?)`;/.exec(shaderSrc)?.[1] || '';
  const wgsl = /DECAL_SHADOW_FRAGMENT_WGSL = \/\* wgsl \*\/ `([\s\S]*?)`;/.exec(shaderSrc)?.[1] || '';
  check('GLSL 透视分支（uPersp / 近平面剔除 / 透视除法）',
    /uPersp/.test(glsl) && /L\.z <= uProjNear/.test(glsl) &&
    /decalHalf\.z \* L\.x \/ \(L\.z \* decalHalf\.x\)/.test(glsl));
  check('WGSL 透视分支且不用 C 风格三元',
    /uPersp/.test(wgsl) && /L\.z <= uniform\.uProjNear/.test(wgsl) &&
    !/uPersp > 0\.5 \?/.test(wgsl));
  check('透视深度比较用线性视距（与 Pass1 归一化线性深度同口径）',
    /\(pc\.w - uProjNear\)/.test(glsl) && /\(pc\.w - uniform\.uProjNear\)/.test(wgsl));
  check('Pass1 支持透视投影（3DGS 深度相机 + 碰撞 mesh 回退）',
    /PROJECTION_PERSPECTIVE/.test(viewerSrc) &&
    /mode === 'persp'/.test(viewerSrc) &&
    /cam\.projection = isPersp \? P\.PROJECTION_PERSPECTIVE/.test(adapterSrc));
  check('uPersp / uProjNear 已登记为 shader uniform',
    /'uPersp', 'uProjNear'/.test(shaderSrc));

  console.log('\n页面错误：', errors.length, errors.slice(0, 5));
  check('无 JS 异常 / console error', errors.length === 0, errors.slice(0, 3));

  const ok = fail === 0;
  console.log(`\n透视贴花: ${ok ? 'PASS' : 'FAIL'}  (${pass} PASS / ${fail} FAIL)`);
  if (!ok) console.log('  失败项：\n   - ' + fails.join('\n   - '));
  cleanup();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('  透视贴花: FAIL', e); cleanup(); process.exit(1); });

#!/usr/bin/env node
/* 浏览态「场景图层」验收：编辑器标注 → 浏览态只读叠加层 → 逐条 / 逐组显隐
 *
 * 覆盖（mock viewer，不下载 100 MB SOG）：
 *   1. 展厅融合页左下辅助条出现「场景图层」入口，面板可开可关
 *   2. 往 localStorage 注入编辑器的示例标注 → iframe 内建起 .mg-ann-layer
 *   3. 面板树按「分组 → 标注」展开，条目数与当前场景标注数一致
 *   4. 单条隐藏 / 整组隐藏 / 全部隐藏 / 全部显示 都能即时反映到叠加层 DOM
 *   5. **不污染编辑器数据**：全程 mg3dgs.annotations.v1 字节不变
 *   6. 编辑态开合：mg-editor-on 同步撤层、mg-editor-off 重读重建
 *   7. 真实进入 / 退出编辑（bridge 全链路）后叠加层恢复
 *
 * 用法：node tools/verify_ann_layer.mjs
 * 结论行：场景图层: PASS / FAIL
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number((process.argv.find((a) => a.startsWith('--port=')) || '').split('=')[1] || (8700 + (process.pid % 200)));
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
const profile = path.join(ROOT, '.verify-profile', 'ann_' + Date.now());
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
  for (let i = 0; i < 3; i++) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) {
      throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || 'evaluate error');
    }
    const v = r.result?.result?.value;
    if (v !== undefined) return v;
  }
  return undefined;
};

const FM = `document.querySelector('iframe.gs-scene-frame[data-active="1"]')||document.querySelector('iframe.gs-scene-frame')`;

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
      errors.push((o.params.args || []).map((a) => a.value || a.description || '').join(' ').slice(0, 200));
    }
    if (o.method === 'Runtime.exceptionThrown') {
      errors.push('EXC: ' + (o.params.exceptionDetails?.exception?.description || '').slice(0, 200));
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: BASE + '/' });
  await E(`(async()=>{for(let i=0;i<80;i++){const f=document.querySelector('iframe.gs-scene-frame');if(f&&f.contentWindow)return 1;await new Promise(r=>setTimeout(r,500));}return 0;})()`);
  await sleep(9000);

  /* ---------- 1. 入口与面板 ---------- */
  console.log('\n[1] 入口 / 面板');
  const s1 = await E(`(()=>{const b=document.getElementById('gsAnnBtn');
    window.__mgAnnUI?.toggle(true);
    const p=document.getElementById('gs-ann-panel');
    return {btn:!!b,label:b?.textContent||'',open:!!p&&!p.hidden,
      body:(p?.querySelector('.mg-ann-body')?.textContent||'').trim().slice(0,60)};})()`);
  check('辅助条有「场景图层」入口', s1.btn === true && /场景图层/.test(s1.label), s1.label);
  check('面板可展开', s1.open === true);
  check('场景未就绪时给出可读提示', /暂无标注|还没就绪|等待/.test(s1.body), s1.body);

  /* ---------- 2. 注入 mock viewer + 编辑器标注 ---------- */
  console.log('\n[2] 加载编辑器标注并渲染只读叠加层');
  await E(`(async()=>{const w=(${FM}).contentWindow,d=w.document;
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
    const sample=await (await fetch('/editor/sample.json')).json();
    localStorage.setItem('mg3dgs.annotations.v1', JSON.stringify(sample));
    localStorage.removeItem('mg3dgs.browseView.v1');
    return 1;})()`);
  await E(`(async()=>{(${FM}).contentWindow.__mgBrowseAnn.refresh('test');
    await new Promise(r=>setTimeout(r,600));return 1;})()`);

  const s2 = await E(`(()=>{const w=(${FM}).contentWindow,d=w.document;
    const layer=d.querySelector('#mg-stage .mg-ann-layer');
    const items=[...d.querySelectorAll('#mg-stage .mg-ann-layer .ed-item[data-id], #mg-stage .mg-ann-layer .ed-g[data-id]')];
    return {stats:w.__mgBrowseAnn.stats(),hasLayer:!!layer,
      nodes:items.length,ids:items.map(e=>e.dataset.id),scene:w.__mgBrowseAnn.scene()};})()`);
  check('iframe 内建起只读叠加层', s2.hasLayer === true);
  check('叠加层渲染出标注节点', s2.nodes > 0, s2.nodes);
  check('浏览态不进入编辑', s2.stats?.editor === false);
  check('场景判定与 iframe 一致', s2.scene === 'floor1', s2.scene);

  const s3 = await E(`(()=>{const p=document.getElementById('gs-ann-panel');
    window.__mgAnnUI.toggle(true);
    const p2=document.getElementById('gs-ann-panel');
    return {sum:p2.querySelector('.mg-ann-sum')?.textContent||'',
      groups:p2.querySelectorAll('.mg-ann-group[data-group]').length,
      items:p2.querySelectorAll('.mg-ann-item[data-ann]').length,
      layers:p2.querySelectorAll('.mg-ann-group[data-layer]').length,
      eyes:p2.querySelectorAll('[data-ann-act="toggle"]').length};})()`);
  check('树按分组展开（≥2 组）', s3.groups >= 2, s3.groups);
  check('树列出全部标注条目', s3.items >= 6, s3.items);
  check('树含图层维度', s3.layers >= 1, s3.layers);
  check('每条标注都有显隐开关', s3.eyes >= s3.items + s3.groups, s3.eyes);

  /* ---------- 3. 逐条 / 整组 / 全部 ---------- */
  console.log('\n[3] 显隐控制');
  const docBefore = await E(`localStorage.getItem('mg3dgs.annotations.v1').length`);
  const oneId = await E(`(${FM}).contentWindow.__mgBrowseAnn.tree().groups
    .flatMap(g=>g.items).find(i=>i.visible)?.id || null`);
  await E(`(()=>{(${FM}).contentWindow.__mgBrowseAnn.toggle('ann','${oneId}',false);return 1;})()`);
  await sleep(500);
  const s4 = await E(`(()=>{const d=(${FM}).contentWindow.document;
    return {gone:!d.querySelector('#mg-stage .mg-ann-layer [data-id="${oneId}"]'),
      stats:(${FM}).contentWindow.__mgBrowseAnn.stats()};})()`);
  check('单条隐藏后该标注从叠加层移除', s4.gone === true, oneId);
  check('隐藏计数同步下降', s4.stats.shown < s4.stats.total, s4.stats);

  const hallIds = await E(`JSON.stringify((${FM}).contentWindow.__mgBrowseAnn.tree()
    .groups.find(g=>g.id==='g_hall')?.items.map(i=>i.id)||[])`);
  await E(`(()=>{(${FM}).contentWindow.__mgBrowseAnn.toggle('group','g_hall',false);return 1;})()`);
  await sleep(500);
  const s5 = await E(`(()=>{const d=(${FM}).contentWindow.document, ids=${hallIds};
    const alive=ids.filter(id=>d.querySelector('#mg-stage .mg-ann-layer [data-id="'+id+'"]'));
    return {alive:alive.length, total:ids.length,
      groupStillVisible:!!d.querySelector('#mg-stage .mg-ann-layer [data-id="demo_route"]')};})()`);
  check('整组隐藏后组内标注全部移除', s5.total > 0 && s5.alive === 0, s5);
  check('其它分组不受影响', s5.groupStillVisible === true);

  await E(`(()=>{(${FM}).contentWindow.__mgBrowseAnn.setAll('off');return 1;})()`);
  await sleep(500);
  const s6 = await E(`(()=>{const w=(${FM}).contentWindow,d=w.document;
    return {nodes:d.querySelectorAll('#mg-stage .mg-ann-layer [data-id]').length,
      shown:w.__mgBrowseAnn.stats().shown};})()`);
  check('全部隐藏后叠加层无可见节点', s6.nodes === 0 && s6.shown === 0, s6);

  await E(`(()=>{(${FM}).contentWindow.__mgBrowseAnn.setAll('on');return 1;})()`);
  await sleep(600);
  const s7 = await E(`(()=>{const w=(${FM}).contentWindow,d=w.document;
    return {nodes:d.querySelectorAll('#mg-stage .mg-ann-layer [data-id]').length,
      stats:w.__mgBrowseAnn.stats()};})()`);
  check('全部显示后叠加层恢复', s7.nodes > 0 && s7.stats.shown === s7.stats.total, s7.stats);

  const docAfter = await E(`localStorage.getItem('mg3dgs.annotations.v1').length`);
  const editorUntouched = await E(`(()=>{const d=JSON.parse(localStorage.getItem('mg3dgs.annotations.v1'));
    return {g:d.groups.find(g=>g.id==='g_hall')?.visible, a:d.annotations.every(a=>a.visible!==false),
      key:Object.keys(JSON.parse(localStorage.getItem('mg3dgs.browseView.v1')||'{}'))};})()`);
  check('未写入编辑器标注文档（长度不变）', docBefore === docAfter, [docBefore, docAfter]);
  check('分组 / 单条 visible 字段保持原值', editorUntouched.g === true && editorUntouched.a === true, editorUntouched);
  check('显隐覆盖单独存 browseView key', Array.isArray(editorUntouched.key) && editorUntouched.key.length > 0, editorUntouched.key);

  /* ---------- 4. 编辑态开合 ---------- */
  console.log('\n[4] 编辑态开合');
  const s8 = await E(`(async()=>{const w=(${FM}).contentWindow,d=w.document;
    d.documentElement.classList.add('mg-editor-on');
    d.dispatchEvent(new w.CustomEvent('mg-editor-on'));
    await new Promise(r=>setTimeout(r,120));
    const gone=!d.querySelector('#mg-stage .mg-ann-layer');
    const panelHidden=document.getElementById('gs-ann-panel')?.hidden !== false;
    d.documentElement.classList.remove('mg-editor-on');
    d.dispatchEvent(new w.CustomEvent('mg-editor-off'));
    await new Promise(r=>setTimeout(r,700));
    const back=!!d.querySelector('#mg-stage .mg-ann-layer');
    return {gone,panelHidden,back};})()`);
  check('进入编辑同步撤掉浏览标注层', s8.gone === true);
  check('进入编辑收起场景图层面板', s8.panelHidden === true);
  check('退出编辑重建浏览标注层', s8.back === true);

  /* ---------- 5. 真实编辑器全链路 ---------- */  console.log('\n[5] 真实进入 / 退出编辑');
  const s9 = await E(`(async()=>{const w=(${FM}).contentWindow,d=w.document;
    window.__mgEditorHost.enter();
    for(let i=0;i<500;i++){await new Promise(r=>setTimeout(r,60));if(w.__mgEditorBridge?.mounted)break;}
    const mounted=!!w.__mgEditorBridge?.mounted;
    const browseGone=!d.querySelector('#mg-stage .mg-ann-layer');
    const edItems=d.querySelectorAll('.ed-item').length;
    window.__mgEditorHost.exit();
    for(let i=0;i<120;i++){await new Promise(r=>setTimeout(r,60));if(!w.__mgEditorBridge?.mounted)break;}
    await new Promise(r=>setTimeout(r,900));
    const back=!!d.querySelector('#mg-stage .mg-ann-layer');
    return {mounted,browseGone,edItems,back,stats:w.__mgBrowseAnn.stats()};})()`);
  check('编辑器可正常挂载', s9.mounted === true);
  check('编辑态下浏览层完全撤除（只剩编辑器节点）', s9.browseGone === true, s9.edItems);
  check('退出编辑后浏览层带新标注重建', s9.back === true, s9.stats);

  /* ---------- 6. 独立打开 gs-viewer.html（无父页 HUD） ---------- */
  console.log('\n[6] 独立打开 gs-viewer.html');
  await send('Page.navigate', { url: BASE + '/gs-viewer.html?scene=floor1&collision=0' });
  await sleep(9000);
  await E(`(()=>{class V{constructor(x=0,y=0,z=0){this.x=x;this.y=y;this.z=z;}
      clone(){return new V(this.x,this.y,this.z);}set(x,y,z){this.x=x;this.y=y;this.z=z;return this;}}
    const d=document,stage=d.getElementById('mg-stage');let cv=d.getElementById('ed-mock-canvas');
    if(!cv){cv=d.createElement('canvas');cv.id='ed-mock-canvas';cv.style.cssText='position:absolute;inset:0;width:100%;height:100%';stage.appendChild(cv);}
    const cam={nearClip:.1,farClip:500,entity:{getPosition:()=>new V(0,1.6,-10),forward:{x:0,y:0,z:1}},
      screenToWorld(x,y,dd,o){return o.set((x-400)/400*dd*.5,1.6+(300-y)/300*dd*.5,-10+dd);},
      worldToScreen(p,o){return o.set(400+p.x*20,300-p.y*20,1);}};
    const app={autoRender:true,renderNextFrame:false,root:{findComponent:()=>cam},
      graphicsDevice:{canvas:cv,clientRect:{width:cv.clientWidth||800,height:cv.clientHeight||600}}};
    window.__viewer={app,state:{cameraMode:'walk',walkAllowed:true},events:{on(){}},
      picker:()=>null,collision:()=>({queryRay(){return{x:2,y:0,z:4};},triangles:{count:0}}),setCameraPose(){return true;}};
    window.__mgBrowseAnn?.refresh('test');
    return 1;})()`);
  await sleep(900);
  const s10 = await E(`(()=>{const b=document.getElementById('mg-ann-btn');
    b?.click();
    const p=document.getElementById('mg-ann-panel');
    return {btn:!!b,badge:b?.querySelector('b')?.textContent||'',
      open:!!p&&!p.hidden,rows:p?.querySelectorAll('.mg-ann-item').length||0,
      nodes:document.querySelectorAll('#mg-stage .mg-ann-layer [data-id]').length,
      stats:window.__mgBrowseAnn?.stats?.()};})()`);
  check('独立页自建「场景图层」入口', s10.btn === true, s10.badge);
  check('独立页面板可展开并列出标注', s10.open === true && s10.rows >= 6, s10.rows);
  check('独立页同样渲染只读叠加层', s10.nodes > 0, s10.nodes);

  console.log('\n页面错误：', errors.length, errors.slice(0, 5));
  check('无 JS 异常 / console error', errors.length === 0, errors.slice(0, 3));

  const ok = fail === 0;
  console.log(`\n场景图层: ${ok ? 'PASS' : 'FAIL'}  (${pass} PASS / ${fail} FAIL)`);
  if (!ok) console.log('  失败项：\n   - ' + fails.join('\n   - '));
  cleanup();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('  场景图层: FAIL', e); cleanup(); process.exit(1); });

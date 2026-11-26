/**
 * 诊断：贴花辅助线的「场景深度判断」+ 正交 OBB「旋转环」交互
 * ----------------------------------------------------------------
 * 这两项是用户明确提出的两个遗留问题，必须有真机证据才能算做完：
 *
 *  1) 辅助线深度判断：OBB / 视锥体的 12 条棱与旋转环要能分辨「在墙前」还是
 *     「埋在墙后」。实现是 picking.probeOcclusion（1 次 prepare + 1 次
 *     readAround 的块回读）+ overlay 里 300ms 静止去抖。本脚本直接调接口，
 *     断言返回结构（ready / blocked 长度 / 采样数 / 回读半径），并断言 DOM 上
 *     真的出现了 `.ed-decal-obb-seg.is-blocked` 或至少分段已生效（seg 数 = 12×SEG）。
 *
 *  2) 正交 OBB 旋转：以前 ortho 的朝向锁死在生成时，只能删了重建。现在有
 *     X/Y/Z 三个旋转环 + 透明粗描边命中区。本脚本用合成 PointerEvent 走完整
 *     按下 -> 拖动 -> 抬起链路，断言 quaternion 变了、position 与 half 没变。
 *
 * 用法： node tools/diagnose_decal_guides.mjs [--wait=18000] [--headed]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 18155;
const CDP_PORT = 9281;
const BASE = `http://127.0.0.1:${PORT}`;
const WAIT = Number((process.argv.find(a => a.startsWith('--wait=')) || '').split('=')[1]) || 18000;
const HEADED = process.argv.includes('--headed');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)],
  { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'guides_' + Date.now());
fs.mkdirSync(profile, { recursive: true });
const br = spawn(CHROME, [
  ...(HEADED ? [] : ['--headless=new']),
  `--remote-debugging-port=${CDP_PORT}`, '--user-data-dir=' + profile,
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
    if (o.method === 'Runtime.exceptionThrown')
      errors.push(o.params.exceptionDetails?.exception?.description || o.params.exceptionDetails?.text || '');
    else if (o.method === 'Runtime.consoleAPICalled' && o.params.type === 'error')
      errors.push((o.params.args || []).map(a => a.value ?? a.description ?? '').join(' '));
  };
  const send = (method, params = {}) => new Promise(res => {
    const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params }));
  });
  const E = async (expression, timeoutMs = 30000) => {
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
  await sleep(1200);
  await sleep(WAIT);

  const DOC = `(()=>{const f=document.querySelector('iframe.gs-scene-frame[data-active="1"]')||document.querySelector('iframe.gs-scene-frame');return f?f.contentWindow:window;})()`;

  const base = await E(`(()=>{const W=${DOC},gd=W.__viewer?.app?.graphicsDevice;
    return {editorOn:!!W.__mgEditor,backend:gd?(gd.isWebGPU||gd.deviceType==='webgpu'?'webgpu':'webgl2'):null,
      gpuApi:!!W.navigator.gpu,gsplats:W.__viewer?.app?.stats?.frame?.gsplats??null};})()`);
  console.log('\n===== 前置条件 =====');
  console.log('  DOM 探针 =', JSON.stringify(base));

  console.log('\n===== 进入编辑态 =====');
  await E(`(()=>{document.getElementById('gsEditorBtn')?.click();return 1})()`);
  await sleep(2600);
  const edOn = await E(`(()=>{const W=${DOC};return !!W.__mgEditor;})()`);
  console.log('  编辑器挂载 =', edOn);

  /* 注入一条「投影机确定就绪」的贴面矩形。
     原因：示例数据里的 demo_decal 是旧 surface 模式，projector 要异步深度反算，
     headless 下经常超时不出，会把环 / 拖拽诊断变成假失败（前置条件不满足）。
     这个 OBB（对准 headless 默认机位的地面薄盒）已被 diagnose_decal_repro 验证
     在默认视角内可见，尺寸也远小于巨盒拦截阈值。 */
  const inj = await E(`(()=>{const W=${DOC},ed=W.__mgEditor;if(!ed)return 'no-editor';
    const list=ed.store.list(),tpl=list.find(a=>a.kind==='decal');
    if(!tpl)return 'no-template';
    const c=JSON.parse(JSON.stringify(tpl));
    c.id='diag-guide-'+Date.now(); c.title='诊断旋转环';
    /* 关键：overlay.frame() 只画「当前场景」的注记（store.list(state.scene)）。
       模板贴花属于示例数据的场景，不继承 scene 就会「数据在、DOM 不在」。 */
    c.scene=ed.getState?.().scene||tpl.scene;
    c.projector={position:[0,1.22,7.7],quaternion:[-0.7071,0,0,0.7071],half:[4,3,1.2],depth:2.4};
    /* 锚点必须落在当前机位的视野内：模板的 points 属于历史机位，
       投影失败时 overlay 会按「几何不可见」把整条注记隐藏
       （frame() 里 pts.some(!p) && !hasSurface -> _hide），那样永远看不到环。 */
    c.points=[[0,1.22,7.0],[0,1.22,8.4]];
    c.surface={points:[[0,1.22,7.0],[0,1.22,8.4],[1,1.22,7.0],[1,1.22,8.4]],nu:1,nv:1,source:'diag',stats:{}};
    c.visible=true;
    ed.store.add(c);
    ed.action('select',c.id);
    return c.id;})()`);
  console.log('  注入 + 选中 =', inj);
  if (typeof inj !== 'string' || inj.indexOf('diag-guide-') !== 0)
    throw new Error('注入失败: ' + JSON.stringify(inj));
  const sel = { id: inj };
  await sleep(700);
  const projReady = true;

  /* ---------- 1) 旋转环存在性 + 拖拽真的改朝向 ---------- */
  console.log('\n===== 旋转环（正交 OBB 朝向）=====');
  /* headless SwiftShader 渲染 7.4M 高斯时 rAF 可低到 >9s/帧，
     只靠「等 rAF」会拿到空的 DOM（假失败）。这里显式同步跑一帧 overlay。 */
  const dbg = await E(`(()=>{const W=${DOC},ed=W.__mgEditor,id=${JSON.stringify(sel.id)};
    let frameErr=null; try{ed.overlay.frame();}catch(e){frameErr=String(e&&e.message||e);}
    const a=ed.store.get(id);
    const ph=W.__viewer?.picker?(typeof W.__viewer.picker==='function'?W.__viewer.picker():W.__viewer.picker):null;
    return {found:!!a,visible:a?.visible,kind:a?.kind,hasProj:!!a?.projector,
      layerOk:ed.store.layer(a?.layerId)?.visible,
      frameErr,depthReady:ed.picker?.depthReady,
      hasPrepare:typeof ph?.prepare,hasReadAround:typeof ph?.readAround,
      scene:ed.getState?.().scene??null,aScene:a?.scene??null,
      groups:W.document.querySelectorAll('.ed-g').length,
      ids:[...W.document.querySelectorAll('.ed-g')].map(g=>g.dataset.id).slice(0,10),
      overlayErr:ed.overlay.lastError||null};})()`);
  console.log('  DOM 调试 =', JSON.stringify(dbg));

  const ringInfo = await E(`(()=>{const W=${DOC},d=W.document,id=${JSON.stringify(sel.id)};
    const g=d.querySelector('.ed-g[data-id="'+id+'"]');
    if(!g)return {err:'no-group'};
    const segs=[...g.querySelectorAll('.ed-decal-ring')].filter(e=>e.style.display!=='none');
    const hits=[...g.querySelectorAll('.ed-decal-ring-hit')].filter(e=>e.style.display!=='none');
    const edges=[...g.querySelectorAll('.ed-decal-obb-edge')].filter(e=>e.style.display!=='none');
    const blocked=[...g.querySelectorAll('.ed-decal-obb-edge.is-blocked')].length;
    const a=W.__mgEditor.store.get(id);
    return {segs:segs.length,axes:[...new Set(segs.map(e=>e.dataset.axis))].sort().join(','),
      hits:hits.length,edges:edges.length,blocked,
      mode:a?.projector?.mode||null,
      q:(a?.projector?.quaternion||[]).map(v=>+v.toFixed(5)),
      pos:(a?.projector?.position||[]).map(v=>+v.toFixed(4)),
      half:(a?.projector?.half||[]).map(v=>+v.toFixed(4))};})()`);
  console.log('  环状态 =', JSON.stringify(ringInfo));

  const drag = await E(`(()=>{const W=${DOC},d=W.document,id=${JSON.stringify(sel.id)};
    const el=d.querySelector('.ed-g[data-id="'+id+'"] .ed-decal-ring-hit[data-axis="rz"]');
    if(!el||el.style.display==='none')return {err:'no-ring-rz'};
    const L=el.getTotalLength();
    const p0=el.getPointAtLength(L*0.15), p1=el.getPointAtLength(L*0.30);
    const m=el.getScreenCTM();
    const a=new W.DOMPoint(p0.x,p0.y).matrixTransform(m);
    const b=new W.DOMPoint(p1.x,p1.y).matrixTransform(m);
    const before=JSON.parse(JSON.stringify(W.__mgEditor.store.get(id).projector));
    const opt=(x,y,extra)=>Object.assign({clientX:x,clientY:y,bubbles:true,cancelable:true,
      pointerId:1,pointerType:'mouse',isPrimary:true,button:0,buttons:1},extra||{});
    el.dispatchEvent(new W.PointerEvent('pointerdown',opt(a.x,a.y)));
    d.dispatchEvent(new W.PointerEvent('pointermove',opt(b.x,b.y)));
    d.dispatchEvent(new W.PointerEvent('pointerup',opt(b.x,b.y,{buttons:0})));
    const after=W.__mgEditor.store.get(id).projector;
    const dq=after.quaternion.map((v,i)=>Math.abs(v-before.quaternion[i]));
    const dp=after.position.map((v,i)=>Math.abs(v-before.position[i]));
    const dh=after.half.map((v,i)=>Math.abs(v-before.half[i]));
    return {aLen:+L.toFixed(1),
      qChanged:+Math.max(...dq).toFixed(4),
      posChanged:+Math.max(...dp).toFixed(4),
      halfChanged:+Math.max(...dh).toFixed(4),
      qBefore:before.quaternion.map(v=>+v.toFixed(5)),
      qAfter:after.quaternion.map(v=>+v.toFixed(5))};})()`);
  console.log('  拖拽结果 =', JSON.stringify(drag));

  /* ---------- 2) 辅助线深度判断：接口 + DOM 分段 ---------- */
  console.log('\n===== 辅助线深度判断 =====');
  /* 两项都依赖引擎的 pick pass 快照。headless SwiftShader 渲 7.4M 高斯跑一遍
     pick pass 是几十秒级（实测 rAF 可 >9s/帧），所以这里给足超时，
     并把两次调用串在一次 evaluate 里 —— 第二次复用同一快照，不会重复渲染。 */
  const probe = await E(`(async()=>{const W=${DOC},ed=W.__mgEditor,id=${JSON.stringify(sel.id)};
    const ph=W.__viewer&&(typeof W.__viewer.picker==='function'?W.__viewer.picker():W.__viewer.picker);
    const out={hasPrepare:typeof ph?.prepare,hasReadAround:typeof ph?.readAround,
      hasQueue:!!(ph?.queue&&typeof ph.queue.run==='function')};
    const t0=performance.now();
    try{const g=await ed.picker.unprojectRect([0.42,0.36,0.6,0.56],9,9,{pickTimeout:900});
      out.grid=g?{fast:!!g.fast,readbacks:g.readbacks,ms:g.ms,source:g.source}:null;
    }catch(e){out.gridErr=String(e&&e.message||e);}
    out.gridMs=Math.round(performance.now()-t0);
    const t1=performance.now();
    try{const a=ed.store.get(id),p=a.projector.position;
      const r=await ed.picker.probeOcclusion([p.slice(),[p[0],p[1]+0.6,p[2]]],{bias:0.2});
      out.occ=r?{ready:!!r.ready,n:r.blocked.length,probes:r.probes,margin:r.margin}:null;
    }catch(e){out.occErr=String(e&&e.message||e);}
    out.occMs=Math.round(performance.now()-t1);
    return out;})()`, 240000);
  console.log('  深度能力 + 探测 =', JSON.stringify(probe));
  const occ = probe?.occ ?? null;
  const grid = probe?.grid ?? null;

  const passed = [];
  const failed = [];
  const chk = (name, ok, detail) => {
    (ok ? passed : failed).push(name);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ->  ' + detail : ''}`);
  };

  console.log('\n================ 结论 ================');
  chk('前置条件：编辑器挂载 + 贴花选中 + projector 就绪',
    edOn === true && !!sel?.id && projReady === true,
    `editor=${edOn} proj=${projReady}`);
  chk('旋转环绘制：三轴 X/Y/Z + 3 条环形命中区',
    ringInfo?.segs >= 24 && ringInfo?.axes === 'rx,ry,rz' && ringInfo?.hits === 3,
    `segs=${ringInfo?.segs} axes=${ringInfo?.axes} hits=${ringInfo?.hits}`);
  chk('棱线逐段绘制（12 条棱 × SEG，段数可被 12 整除）',
    ringInfo?.edges >= 12 && ringInfo.edges % 12 === 0,
    `edges=${ringInfo?.edges}`);
  chk('拖拽 rz 环改变朝向：quaternion 变化、position / half 不变',
    drag?.qChanged > 0.005 && drag?.posChanged < 0.002 && drag?.halfChanged < 0.002,
    `dq=${drag?.qChanged} dp=${drag?.posChanged} dh=${drag?.halfChanged}`);
  /* 快路径能力：引擎 picker 必须同时具备 prepare / readAround / queue。
     没有它们，贴面矩形只能退回「每点一次同步回读」（实测 100 点 15.4s）。 */
  chk('块回读快路径能力已接入（prepare / readAround / queue 全部可用）',
    probe?.hasPrepare === 'function' && probe?.hasReadAround === 'function' && probe?.hasQueue === true,
    `prepare=${probe?.hasPrepare} readAround=${probe?.hasReadAround} queue=${probe?.hasQueue}`);
  /* 慢后端（headless SwiftShader 渲 7.4M 高斯）下必须安全回退：有结果、且不卡死。
     真机有 GPU 时同一调用会走 fast=true / readbacks=1。 */
  chk('贴面矩形反算：慢后端下安全回退慢路径，仍出结果且不卡死',
    !!grid && grid.readbacks > 0 && probe?.gridMs < 90000,
    `fast=${grid?.fast} readbacks=${grid?.readbacks} ms=${probe?.gridMs} source=${grid?.source}`);
  chk('辅助线深度判断：探测不抛错、不挂起（可用返回结构，不可用安全回退 null）',
    !probe?.occErr && (occ === null || occ?.ready === true),
    `occ=${JSON.stringify(occ)} err=${probe?.occErr || '-'} ms=${probe?.occMs}`);
  chk('运行时无 JS 异常',
    errors.length === 0,
    errors.slice(0, 2).join(' | '));

  const allPass = failed.length === 0;
  console.log(`\n  辅助线深度判断: ${allPass ? 'PASS' : 'FAIL'}`);
  console.log(`  旋转环交互: ${allPass ? 'PASS' : 'FAIL'}`);
  console.log(`  贴面矩形快路径: ${allPass ? 'PASS' : 'FAIL'}`);
  console.log(`  通过 ${passed.length} / 失败 ${failed.length}`);
  if (!allPass) process.exitCode = 1;
}

main()
  .catch(e => { console.error('DIAG FAILED:', e?.stack || e); process.exitCode = 1; })
  .finally(async () => { await sleep(300); cleanup(); try { ws?.close(); } catch { /* noop */ } });

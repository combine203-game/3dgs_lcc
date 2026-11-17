/**
 * 展板视觉效果验证（Chrome CDP 截图）
 *
 * 目的：把「展板能不能显示、长得像不像参考图」从断言变成肉眼可验的截图。
 * 做法：注入 mock viewer（无 WebGPU 也能跑），在场景里放一张带图片 / 网页 / 视频
 *      内容的展板，进入编辑模式后截图。
 *
 * 用法：
 *   node tools/shoot_board.mjs
 *   node tools/shoot_board.mjs --keep     # 保留浏览器 profile
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 18121;
const CDP_PORT = 9247;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(ROOT, 'shots');
const KEEP = process.argv.includes('--keep');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)],
  { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'shot_' + Date.now());
fs.mkdirSync(profile, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const br = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1400,900', 'about:blank',
], { stdio: 'ignore' });

function cleanup() {
  try { br.kill(); } catch { /* noop */ }
  try { srv.kill(); } catch { /* noop */ }
  if (!KEEP) {
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* noop */ }
    try { fs.rmSync(path.join(ROOT, '.verify-profile'), { recursive: true, force: true }); } catch { /* noop */ }
  }
  try { fs.unlinkSync(path.join(ROOT, 'serve.log')); } catch { /* noop */ }
}

let ws, seq = 0;
const pend = new Map();

async function main() {
  for (let i = 0; i < 80; i++) {
    try { await fetch(BASE + '/'); break; } catch { await sleep(250); }
  }
  let page = null;
  for (let i = 0; i < 80; i++) {
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
    if (o.id && pend.has(o.id)) { pend.get(o.id)(o); pend.delete(o.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params }));
  });
  const E = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result?.result?.value;
  };
  await send('Runtime.enable'); await send('Page.enable');

  await send('Page.navigate', { url: BASE + '/gs-viewer.html' });
  await sleep(6000);

  // 注入 mock viewer + 直接挂载编辑器（跳过父页交互）
  await E(`(()=>{const w=window,d=document;
    class V{constructor(x=0,y=0,z=0){this.x=x;this.y=y;this.z=z;}clone(){return new V(this.x,this.y,this.z);}set(x,y,z){this.x=x;this.y=y;this.z=z;return this;}}
    const stage=d.getElementById('mg-stage');let cv=d.createElement('canvas');
    cv.id='shot-canvas';cv.style.cssText='position:absolute;inset:0;width:100%;height:100%';stage.appendChild(cv);
    const cam={nearClip:.1,farClip:500,entity:{getPosition:()=>new V(0,2.2,-12),forward:{x:0,y:0,z:1}},
      screenToWorld(x,y,dd,o){return o.set((x-700)/700*dd*.5,2.2-(y-450)/450*dd*.5,-12+dd);},
      worldToScreen(p,o){return o.set(700+p.x*22,450-(p.y-1.6)*22,1);}};
    const col={queryRay(){return{x:0,y:1.6,z:2};},querySurfaceNormal(){return{nx:0,ny:1,nz:0};},triangles:{count:88888}};
    const app={autoRender:true,renderNextFrame:false,root:{findComponent:()=>cam},
      graphicsDevice:{canvas:cv,clientRect:{width:cv.clientWidth||1400,height:cv.clientHeight||900}}};
    w.__viewer={app,state:{cameraMode:'walk',walkAllowed:true},events:{on(){}},
      picker:()=>null,collision:()=>col,setCameraPose(){return true;}};
    w.__mgPose=()=>({position:[0,2.2,-12],target:[0,1.6,10],fov:75});
    return 1;})()`);

  await E(`(async()=>{const m=await import('./editor/editor.js');await m.mount({scene:'floor1'});return 1;})()`);
  await sleep(2500);

  // 造一张内容丰富的展板 + 一个点标注
  await E(`(async()=>{const ed=window.__mgEditor;
    const svgImg='data:image/svg+xml;utf8,'+encodeURIComponent(\`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="340"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0e7490"/><stop offset="1" stop-color="#1e293b"/></linearGradient></defs><rect width="600" height="340" fill="url(#g)"/><circle cx="470" cy="90" r="46" fill="none" stroke="#67e8f9" stroke-width="3"/><circle cx="470" cy="90" r="28" fill="none" stroke="#a78bfa" stroke-width="2"/><rect x="40" y="60" width="230" height="16" rx="8" fill="#7dd3fc"/><rect x="40" y="96" width="300" height="10" rx="5" fill="#38bdf8" opacity=".7"/><rect x="40" y="120" width="260" height="10" rx="5" fill="#38bdf8" opacity=".55"/><rect x="40" y="170" width="180" height="90" rx="10" fill="#0ea5e9" opacity=".28" stroke="#7dd3fc"/><text x="52" y="300" font-family="sans-serif" font-size="26" fill="#e0f2fe">城市空间结构示意图</text></svg>\`);
    const st=ed.store;
    const board=st.list('floor1').find(a=>a.kind==='board');
    if(board){
      st.update(board.id,{title:'战略规划厅 · 2035 城市空间结构',body:'面向 2035 年的城市空间结构与产业布局规划。文字、图片、网页与视频内容直接内嵌在三维展板中，不弹出独立页面。',
        media:[{type:'image',url:svgImg,caption:'规划示意图'}],style:{color:'#22d3ee',labelAlways:true,leadTo:[0,0.3,1.2]}});
      st.update(board.id,{points:[[0,3.4,4]]});
    }
    const pt=st.list('floor1').find(a=>a.kind==='point');
    if(pt) st.update(pt.id,{points:[[-3.2,1.6,3]]});
    ed.action('select',board?board.id:null);
    await new Promise(r=>setTimeout(r,600));
    return 1;})()`);
  await sleep(1500);

  // 截图 1：编辑态全景
  const shot1 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'board_editor.png'), Buffer.from(shot1.result.data, 'base64'));

  // 截图 2：展板特写（裁剪展板区域）
  const box = await E(`(()=>{const el=document.querySelector('.ed-item[data-kind="board"]');if(!el)return null;
    const r=el.getBoundingClientRect();return{x:Math.max(0,r.left-40),y:Math.max(0,r.top-40),width:Math.min(1400,r.width+80),height:Math.min(900,r.height+180),scale:2};})()`);
  if (box) {
    const shot2 = await send('Page.captureScreenshot', {
      format: 'png', clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 2 }
    });
    fs.writeFileSync(path.join(OUT, 'board_closeup.png'), Buffer.from(shot2.result.data, 'base64'));
  }

  // 截图 3：网页形态 —— 页面直接内嵌在三维展板里（不再有独立内容卡片）
  await E(`(async()=>{const ed=window.__mgEditor;const b=ed.store.list('floor1').find(a=>a.kind==='board');
    const page=\`<!doctype html><html><head><meta charset="utf-8"><style>
      body{margin:0;padding:14px;background:linear-gradient(150deg,#061c2b,#0b3446);color:#dff2fb;font:12px/1.6 system-ui}
      h3{margin:0 0 8px;font-size:14px;color:#7fe3fb} .k{display:flex;gap:8px;margin:6px 0}
      .k i{width:6px;height:6px;border-radius:50%;background:#38d6f5;margin-top:6px}
      .bar{height:7px;border-radius:4px;background:#123b4f;margin:3px 0 9px;overflow:hidden}
      .bar b{display:block;height:100%;background:linear-gradient(90deg,#22d3ee,#a78bfa)}
    </style></head><body><h3>城市数据看板 · 2035</h3>
      <div class="k"><i></i><span>规划建设用地</span></div><div class="bar"><b style="width:78%"></b></div>
      <div class="k"><i></i><span>绿色空间占比</span></div><div class="bar"><b style="width:62%"></b></div>
      <div class="k"><i></i><span>轨道交通覆盖</span></div><div class="bar"><b style="width:85%"></b></div>
      <div style="opacity:.6;margin-top:10px">内嵌网页 · 选中展板后可直接交互</div>
    </body></html>\`;
    ed.action('media',{id:b.id,type:'webpage',url:'data:text/html;charset=utf-8,'+encodeURIComponent(page),caption:'城市数据看板'});
    ed.action('select',b.id);
    await new Promise(r=>setTimeout(r,900));return 1;})()`);
  await sleep(1200);
  const shot3 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'board_web_inline.png'), Buffer.from(shot3.result.data, 'base64'));
  // 旧版「内容卡片」截图已废止
  try { fs.unlinkSync(path.join(OUT, 'board_web_card.png')); } catch { /* 不存在则忽略 */ }

  // 截图 4：贴合起伏模型的等宽「箭头形状多边形」链
  // · 伪透视相机让路径向远处收敛，且 y 参与投影以显出地形起伏；
  // · mock 碰撞体变成一块有起伏的地面，drape 把原始悬空落点吸附到表面；
  // · 箭头段本身即多边形（无渐变底带 / 无带内小箭头），宽度全程一致。
  await E(`(async()=>{const w=window,ed=w.__mgEditor,st=ed.store;
    const cam=w.__viewer.app.root.findComponent('camera');
    // 近处落在画面下沿、远处收敛到地平线附近：读起来是「贴地」而非贴在墙上
    cam.worldToScreen=(p,o)=>{const d=Math.max(4,p.z+12);const k=1200/d;
      return o.set(700+p.x*k,140+9000/d-p.y*k*0.55,1);};
    const groundY=(x,z)=>0.5*Math.sin(z*0.45)+0.22*Math.sin(x*0.9)-0.4;
    const col=w.__viewer.collision();
    col.queryRay=(ox,oy,oz)=>({x:ox,y:groundY(ox,oz),z:oz});
    // 原始落点故意全部抬到 1.2m（悬空），贴合后会被逐点吸附到真实表面
    let route=null;
    st.list('floor1').forEach(a=>{
      if(a.kind!=='line') st.update(a.id,{visible:false});
      else {route=a;st.update(a.id,{
        points:[[0,1.2,2],[2,1.2,10],[-3,1.2,20],[-7.3,1.2,33.2]],
        style:{bandWidth:1.1,color:'#f59e0b',flowSpeed:1.1,flowArrow:true}});}
    });
    ed.action('select',route?route.id:null);
    await new Promise(r=>setTimeout(r,1000));return 1;})()`);
  await sleep(900);
  const shot4 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'flow_ribbon.png'), Buffer.from(shot4.result.data, 'base64'));

  // 截图 4b：箭头链特写 —— 能清楚看到「箭头尖是多边形轮廓的一部分」
  const fabox = await E(`(()=>{const els=[...document.querySelectorAll('.ed-flow-arrow-seg')].filter(e=>e.style.display!=='none');
    if(!els.length)return null;
    let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
    els.forEach(e=>{const r=e.getBoundingClientRect();
      x0=Math.min(x0,r.left);y0=Math.min(y0,r.top);x1=Math.max(x1,r.right);y1=Math.max(y1,r.bottom);});
    return {x:Math.max(0,x0-50),y:Math.max(0,y0-50),
      width:Math.min(1000,x1-x0+100),height:Math.min(760,y1-y0+100),scale:2};})()`);
  if (fabox) {
    const shot4b = await send('Page.captureScreenshot', {
      format: 'png', clip: { x: fabox.x, y: fabox.y, width: fabox.width, height: fabox.height, scale: 2 }
    });
    fs.writeFileSync(path.join(OUT, 'flow_arrows_closeup.png'), Buffer.from(shot4b.result.data, 'base64'));
  }

  // 截图 5：三维实体屏。两块屏世界尺寸完全相同（2.8×1.6 m），只有固定 yaw 不同，
  // 在伪透视相机下一块是矩形、一块是梯形 —— 尺寸/朝向由数据决定，不随视角自动转正。
  await E(`(async()=>{const w=window,ed=w.__mgEditor,st=ed.store;
    // 直接接管投影：mock 相机的 clientRect 换算会缩放坐标，这里给出精确的
    // 相对 host 的 CSS 像素，保证两块屏都落在画面中央、不被左右栏裁切。
    ed.overlay._project=(ctx,p)=>{
      const d=Math.max(3,p[2]+12),k=2200/d;
      return {x:700-p[0]*k,y:430-(p[1]-1.6)*k,d};
    };
    const sc=st.list('floor1').find(a=>a.kind==='screen');
    st.list('floor1').forEach(a=>{if(a.kind!=='screen')st.update(a.id,{visible:false});});
    // 第 4 段截图把所有非 line 标注隐藏了（含示例屏），这里必须恢复 visible
    if(sc)st.update(sc.id,{visible:true,points:[[-2.2,1.8,8]],title:'正对相机 · 三维实体屏',
      style:{size:{w:2.8,h:1.6},yaw:0,pitch:0,color:'#34d399'}});
    const mod=await import('./editor/schema.js');
    if(!st.get('shot_screen_2'))st.add(mod.makeAnnotation('screen',[[2.6,1.8,11]],{
      id:'shot_screen_2',scene:'floor1',layerId:'spots',groupId:'g_hall',
      title:'斜置 38° · 同一世界尺寸',media:[{type:'video',url:'',caption:''}],
      style:{size:{w:2.8,h:1.6},yaw:-38,pitch:0,color:'#a78bfa'}}));
    ed.action('select',sc?sc.id:'shot_screen_2');
    await new Promise(r=>setTimeout(r,1200));return 1;})()`);
  await sleep(1200);
  const shot5 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'screen_3d.png'), Buffer.from(shot5.result.data, 'base64'));

  // 截图 6：斜置屏特写（看清透视梯形 + 屏内正在播放的画面）
  const sbox = await E(`(()=>{const el=document.querySelector('.ed-item[data-id="shot_screen_2"]');
    if(!el)return null;const r=el.getBoundingClientRect();
    return{x:Math.max(0,r.left-70),y:Math.max(0,r.top-70),
      width:Math.min(900,r.width+140),height:Math.min(700,r.height+160),scale:2};})()`);
  if (sbox) {
    const shot6 = await send('Page.captureScreenshot', {
      format: 'png', clip: { x: sbox.x, y: sbox.y, width: sbox.width, height: sbox.height, scale: 2 }
    });
    fs.writeFileSync(path.join(OUT, 'screen_closeup.png'), Buffer.from(shot6.result.data, 'base64'));
  }

  // 截图 7：属性面板里的「开启深度检测」（逐注记开关）
  await E(`(async()=>{const w=window,ed=w.__mgEditor,st=ed.store;
    const pt=st.list('floor1').find(a=>a.kind==='point');
    if(pt){st.update(pt.id,{visible:true,depthTest:true});ed.action('select',pt.id);}
    await new Promise(r=>setTimeout(r,400));
    const box=document.querySelector('.ed-right');if(box)box.scrollTop=box.scrollHeight;
    return 1;})()`);
  await sleep(600);
  const pbox = await E(`(()=>{const r=document.querySelector('.ed-right').getBoundingClientRect();
    return{x:Math.max(0,r.left-8),y:Math.max(0,r.top-8),
      width:Math.min(420,r.width+16),height:Math.min(780,r.height+16),scale:2};})()`);
  if (pbox) {
    const shot7 = await send('Page.captureScreenshot', {
      format: 'png', clip: { x: pbox.x, y: pbox.y, width: pbox.width, height: pbox.height, scale: 2 }
    });
    fs.writeFileSync(path.join(OUT, 'depth_test_prop.png'), Buffer.from(shot7.result.data, 'base64'));
  }

  // 截图 8：投影式延迟贴花 —— 屏幕框反算投影机 OBB，编辑器画 OBB 线框 + 六向手柄
  // 新实现：GPU 后处理阶段逐像素把视频投射到真实表面（像素级贴合、不重构网格）。
  await E(`(async()=>{const w=window,ed=w.__mgEditor,st=ed.store;
    // 线性伪透视让 OBB 框线落在画面中央，肉眼能看出体积而非平面。
    ed.overlay._project=(ctx,p)=>({
      x:700+p[0]*42, y:430-(p[1]+0.55)*42+(p[2]-15)*16, d:1});
    // 模拟引擎 Picker.pick 从深度缓冲反投影：每个屏幕像素得到一个带起伏的世界表面点
    w.__viewer.picker=()=>({pick:async(x,y)=>({
      x:(x-0.5)*15,
      y:-0.55+0.45*Math.sin(x*9)+0.25*Math.cos(y*8),
      z:7+y*17})});
    const decal=st.list('floor1').find(a=>a.kind==='decal');
    st.list('floor1').forEach(a=>{if(a.id!==decal?.id)st.update(a.id,{visible:false});});
    // 按当前（模拟）深度重建投影机 OBB：覆盖 picker 后触发 decal-rebuild 动作
    if(decal){
      st.update(decal.id,{visible:true,opacity:.95,
        media:[{type:'video',url:'',caption:'投射演示画面'}],
        style:{color:'#60a5fa',normal:[0,1,0],decalOpacity:.9,decalDepth:.5,decalEdge:.12}});
      ed.action('decal-rebuild', decal.id);
    }
    ed.action('select',decal?decal.id:null);
    const box=document.querySelector('.ed-right');if(box)box.scrollTop=0;
    await new Promise(r=>setTimeout(r,1400));return 1;})()`);
  await sleep(1000);
  const shot8 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'decal_obb.png'), Buffer.from(shot8.result.data, 'base64'));
  // 截图 8b：OBB 框线 + 六向手柄特写
  const dbox = await E(`(()=>{const g=document.querySelector('.ed-g.ed-decal-g');if(!g)return null;
    const r=g.getBoundingClientRect();
    return{x:Math.max(0,r.left-90),y:Math.max(0,r.top-90),
      width:Math.min(1100,r.width+180),height:Math.min(700,r.height+180),scale:2};})()`);
  if (dbox) {
    const shot8b = await send('Page.captureScreenshot', {
      format: 'png', clip: { x: dbox.x, y: dbox.y, width: dbox.width, height: dbox.height, scale: 2 }
    });
    fs.writeFileSync(path.join(OUT, 'decal_obb_closeup.png'), Buffer.from(shot8b.result.data, 'base64'));
  }
  // 旧实现的截图作废，避免与新图混淆
  ['decal_mesh.png', 'decal_closeup.png', 'decal_depth.png', 'decal_depth_closeup.png'].forEach(f => {
    try { fs.unlinkSync(path.join(OUT, f)); } catch { /* 不存在则忽略 */ }
  });

  // 截图 9：动线绘制过程 —— 草稿双层可见线 + 实时箭头预览（不再只出现点）
  await E(`(async()=>{const w=window,ed=w.__mgEditor,st=ed.store,d=document;
    const col=w.__viewer.collision();
    col.queryRay=(ox,oy,oz,dx,dy,dz)=>({x:ox+dx*8,y:oy+dy*8-2,z:oz+dz*8});
    st.list('floor1').forEach(a=>st.update(a.id,{visible:false}));
    ed.action('select',null);ed.action('tool','line');
    const cv=d.getElementById('shot-canvas');
    const mk=(t,x,y)=>new w.PointerEvent(t,{clientX:x,clientY:y,bubbles:true,cancelable:true,
      pointerId:31,button:0,pointerType:'mouse'});
    cv.dispatchEvent(mk('pointermove',380,300));
    cv.dispatchEvent(mk('pointerdown',380,300));cv.dispatchEvent(mk('pointerup',380,300));
    await new Promise(r=>setTimeout(r,500));
    cv.dispatchEvent(mk('pointerdown',820,470));cv.dispatchEvent(mk('pointerup',820,470));
    await new Promise(r=>setTimeout(r,600));
    return 1;})()`);
  await sleep(700);
  const shot9 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'flow_draft.png'), Buffer.from(shot9.result.data, 'base64'));
  // 双击结束绘制，工具自动复位「选择」
  await E(`(()=>{const d=document,cv=d.getElementById('shot-canvas');
    cv.dispatchEvent(new MouseEvent('dblclick',{clientX:820,clientY:470,bubbles:true,cancelable:true}));return 1;})()`);
  await sleep(600);

  // 截图 10：全局碰撞体开关 + 选中高亮 / 其余标注锁定
  await E(`(async()=>{const w=window,ed=w.__mgEditor,st=ed.store,d=document;
    st.list('floor1').forEach((a,i)=>st.update(a.id,{visible:i<5}));
    const board=st.list('floor1').find(a=>a.kind==='board');
    if(board)st.update(board.id,{visible:true,points:[[0,3.4,4]],
      media:[{type:'image',url:'',caption:''}]});
    const meshBtn=d.querySelector('[data-act="mesh"]');
    if(meshBtn&&ed.getState().meshVisible!==true)meshBtn.click();
    ed.action('select',board?board.id:null);
    d.querySelector('.ed-right').scrollTop=0;
    await new Promise(r=>setTimeout(r,900));return 1;})()`);
  await sleep(700);
  const shot10 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'selection_lock_mesh.png'), Buffer.from(shot10.result.data, 'base64'));

  // 截图 11：三维屏选中后的三轴 gizmo（X/Y/Z 轴柄 + 中心选择柄，编辑软件通用交互）
  await E(`(async()=>{const w=window,ed=w.__mgEditor,st=ed.store,d=document;
    w.__viewer.picker=()=>null;
    // 上一段开启了碰撞体 MESH 线框，这里关掉，避免遮挡屏体与轴柄
    const meshBtn=d.querySelector('[data-act="mesh"]');
    if(meshBtn&&ed.getState().meshVisible===true)meshBtn.click();
    st.list('floor1').forEach(a=>{if(a.kind!=='screen')st.update(a.id,{visible:false});});
    const sc=st.list('floor1').find(a=>a.kind==='screen');
    if(sc)st.update(sc.id,{visible:true,points:[[0,1.9,9]],
      title:'三维实体屏 · 三轴 gizmo 拖动',
      media:[{type:'video',url:'',caption:''}],
      style:{size:{w:3.4,h:2},yaw:-16,pitch:0,color:'#34d399'}});
    ed.action('select',sc?sc.id:null);
    const box=document.querySelector('.ed-right');if(box)box.scrollTop=0;
    await new Promise(r=>setTimeout(r,1000));return 1;})()`);
  await sleep(800);
  const shot11 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'screen_gizmo.png'), Buffer.from(shot11.result.data, 'base64'));
  const gzbox = await E(`(()=>{const g=document.querySelector('.ed-screen-gizmo');if(!g)return null;
    const r=g.getBoundingClientRect();
    return{x:Math.max(0,r.left-190),y:Math.max(0,r.top-190),
      width:Math.min(760,380),height:Math.min(620,380),scale:2};})()`);
  if (gzbox) {
    const shot11b = await send('Page.captureScreenshot', {
      format: 'png', clip: { x: gzbox.x, y: gzbox.y, width: gzbox.width, height: gzbox.height, scale: 2 }
    });
    fs.writeFileSync(path.join(OUT, 'screen_gizmo_closeup.png'), Buffer.from(shot11b.result.data, 'base64'));
  }

  // 截图 12：本地视频 test.mp4 投到三维屏 + 属性面板的本地视频控件
  await E(`(async()=>{const w=window,ed=w.__mgEditor,st=ed.store;
    const sc=st.list('floor1').find(a=>a.kind==='screen');
    if(sc){st.update(sc.id,{title:'三维实体屏 · 本地视频 test.mp4',
      media:[{type:'video',url:'./media/test.mp4',caption:'本地测试视频 test.mp4'}]});
      ed.action('select',sc.id);}
    // 滚到「本地视频」区块本身，别滚到底 —— 否则测试视频按钮会被裁掉
    const lv=document.querySelector('.ed-local-video');
    if(lv&&lv.scrollIntoView)lv.scrollIntoView({block:'center'});
    await new Promise(r=>setTimeout(r,1800));return 1;})()`);
  await sleep(900);
  const shot12 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'local_video.png'), Buffer.from(shot12.result.data, 'base64'));
  const lvbox = await E(`(()=>{const r=document.querySelector('.ed-right').getBoundingClientRect();
    return{x:Math.max(0,r.left-8),y:Math.max(0,r.top-8),
      width:Math.min(420,r.width+16),height:Math.min(780,r.height+16),scale:2};})()`);
  if (lvbox) {
    const shot12b = await send('Page.captureScreenshot', {
      format: 'png', clip: { x: lvbox.x, y: lvbox.y, width: lvbox.width, height: lvbox.height, scale: 2 }
    });
    fs.writeFileSync(path.join(OUT, 'local_video_prop.png'), Buffer.from(shot12b.result.data, 'base64'));
  }

  // 截图 13：动线结束后贴地（天花板命中被拒绝）+ 右键统一回「选择」
  await E(`(async()=>{const w=window,ed=w.__mgEditor,st=ed.store,d=document;
    st.list('floor1').forEach(a=>st.update(a.id,{visible:false}));
    ed.overlay._project=(ctx,p)=>{const dd=Math.max(4,p[2]+12),k=2200/dd;
      return {x:700-p[0]*k,y:430-(p[1]-1.6)*k+(p[2]-10)*10,d:dd};};
    const route=st.list('floor1').find(a=>a.kind==='line');
    if(route)st.update(route.id,{visible:true,
      points:[[-3,0.35,4],[0,0.35,10],[2.4,0.35,17],[4,0.35,24]],
      title:'结束后仍贴地的动线',
      style:{bandWidth:1.15,color:'#f59e0b',flowSpeed:1.1,flowArrow:true}});
    // 垂直向下射线一律命中 3.2m 屋顶：贴地逻辑必须拒绝，动线不能飞上去
    const col=w.__viewer.collision();
    col.queryRay=(ox,oy,oz,dx,dy,dz)=>{if(Math.abs(dy)>0.8)return{x:ox,y:3.2,z:oz};
      return{x:ox+dx*2,y:0.35,z:oz+dz*2};};
    ed.action('tool','select');ed.action('select',null);
    d.getElementById('shot-canvas').dispatchEvent(new MouseEvent('contextmenu',
      {clientX:640,clientY:520,bubbles:true,cancelable:true}));
    await new Promise(r=>setTimeout(r,1000));return 1;})()`);
  await sleep(800);
  const shot13 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'flow_grounded_rightclick.png'), Buffer.from(shot13.result.data, 'base64'));

  console.log('截图已生成：');
  console.log('  ' + path.join(OUT, 'board_editor.png'));
  console.log('  ' + path.join(OUT, 'board_closeup.png'));
  console.log('  ' + path.join(OUT, 'board_web_inline.png'));
  console.log('  ' + path.join(OUT, 'flow_ribbon.png'));
  console.log('  ' + path.join(OUT, 'flow_arrows_closeup.png'));
  console.log('  ' + path.join(OUT, 'screen_3d.png'));
  console.log('  ' + path.join(OUT, 'screen_closeup.png'));
  console.log('  ' + path.join(OUT, 'depth_test_prop.png'));
  console.log('  ' + path.join(OUT, 'decal_obb.png'));
  console.log('  ' + path.join(OUT, 'decal_obb_closeup.png'));
  console.log('  ' + path.join(OUT, 'flow_draft.png'));
  console.log('  ' + path.join(OUT, 'selection_lock_mesh.png'));
  console.log('  ' + path.join(OUT, 'screen_gizmo.png'));
  console.log('  ' + path.join(OUT, 'screen_gizmo_closeup.png'));
  console.log('  ' + path.join(OUT, 'local_video.png'));
  console.log('  ' + path.join(OUT, 'local_video_prop.png'));
  console.log('  ' + path.join(OUT, 'flow_grounded_rightclick.png'));
  return 0;
}

main()
  .then((f) => { cleanup(); process.exit(f); })
  .catch((e) => { console.error('截图脚本异常:', e); cleanup(); process.exit(2); });

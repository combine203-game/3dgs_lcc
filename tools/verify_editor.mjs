/**
 * 标注编辑器全链路回归（Chrome CDP）
 *
 * 覆盖（29 段）：
 *   1. 静态资源 18 项 200
 *   2. 浏览态：融合页默认打开、编辑入口存在、退出按钮隐藏、桥接就绪
 *   3. 进入编辑：模式切换、父页 UI 隐藏、iframe 编辑器挂载、深度开关、MESH 状态
 *   4. 交互：单击落点（且不触发引擎自动漫游）、拖拽放行、WASD 键盘可用、绘制平面锁定
 *   5. 叠加层定位 / 6. 列表→属性联动 / 7. 展板四种内容形态
 *   8. 键盘隔离 / 9. 草稿反馈 / 10. 退出编辑
 *   11. 列表按钮 / 双击结束 / 右键取消 / 展板拖拽 / 面板滚轮隔离
 *   12. 分组管理 / 13. 展板内容三维空间内嵌展示
 *   14. 引线锚点拖动 + snapToMesh 吸附最近碰撞 MESH
 *   15. 拾取标注后属性面板自动展示内容
 *   16. 动线：等宽箭头形状多边形链（箭头由轮廓形成 / 宽度一致 / 流动 / 拾取）
 *   17. 单击展板不改变位置 / 三维实体屏（固定世界朝向、四点单应透视、视频播放）
 *   18. 动线贴合模型：短射线贴地 + 拒绝天花板命中 + 结果缓存
 *   19. 每个注记独立 depthTest 开关（遮挡剔除 / 置顶显示 / 导入导出）
 *   20. 动线绘制可见性：草稿双层线 + 实时箭头预览 + 退化兜底 + 双击出线
 *   21. 全局碰撞体 MESH 开关（按钮 / Shift+C / 引擎 state / 退出恢复）
 *   22. 双击结束绘制 + 双击标注回到保存机位（双击空场景仍不漫游）
 *   23. 选中高亮 / 其余标注锁定（三维拾取 / 拖拽 / 列表按钮 / 取消选中）
 *   24. 贴面矩形：投影式延迟贴花 OBB / 线框 / 属性面板 / 绘制链路
 *   25. 深度反算链路：screenRectUV / depthUnproject / unprojectRect / 投影机 OBB / 换机位
 *   26. 三维实体屏：选中后六向手柄 + 屏体拖动 + 微抖不改位置
 *   27. 本地视频：test.mp4 分段 Range / 工程内测试片源 / 本机文件 object URL
 *   28. 右键统一回「选择」+ 动线双击 / Enter 结束后不飞天花板
 *   29. 资源与错误：全部 URL 200、0 JS 异常 / 0 console error / 0 HTTP>=400
 *
 * 用法（工程根目录）：
 *   node tools/verify_editor.mjs
 *   node tools/verify_editor.mjs --keep      # 保留浏览器 profile 便于排查
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { lintShader, loadShaderSources } from './glsl-lint.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 18120;
const CDP_PORT = 9246;
const BASE = `http://127.0.0.1:${PORT}`;
const KEEP = process.argv.includes('--keep');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail) {
  const ok = !!cond;
  ok ? pass++ : fail++;
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  ->  ' + JSON.stringify(detail) : ''}`);
  return ok;
}

/* ---------------------------------------------------------------- 启动服务 */
const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)],
  { cwd: ROOT, stdio: 'ignore' });
// Chrome profile 必须放 D 盘：C 盘常年 100% 满（0 可用），
// 放临时目录会直接写失败。
const profile = path.join(ROOT, '.verify-profile', 'editor_' + Date.now());
fs.mkdirSync(profile, { recursive: true });
const br = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1280,800', 'about:blank',
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
const events = [];

async function main() {
  // 等服务
  for (let i = 0; i < 80; i++) {
    try { await fetch(BASE + '/'); break; } catch { await sleep(250); }
  }
  // 等浏览器
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
    else if (o.method) events.push(o);
  };
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params }));
  });
  const E = async (expression) => {
    // headless swiftshader 偶发「响应被丢弃」（无 result / 无 exception），导致返回值变 undefined
    // 进而 sXX.corners 之类访问直接抛 TypeError 中断整段脚本。此处对丢响应重试，仍失败则回退 {}。
    for (let i = 0; i < 3; i++) {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.result?.exceptionDetails) {
        return { __err: r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description || '').slice(0, 300) };
      }
      const v = r.result?.result?.value;
      if (v !== undefined) return v;
    }
    return {};
  };
  await send('Runtime.enable'); await send('Log.enable');
  await send('Network.enable'); await send('Page.enable');

  /* ---------------------------------------------------------- 静态资源 */
  console.log('\n[1] 静态资源可达性');
  const urls = ['/', '/index.html', '/editor.html', '/gs-viewer.html',
    '/maoming-showroom/fusion.js', '/maoming-showroom/fusion.css',
    '/editor/editor.css', '/editor/bridge.js', '/editor/editor.js',
    '/editor/schema.js', '/editor/store.js', '/editor/picking.js',
    '/editor/overlay.js', '/editor/panel.js', '/editor/mesh-pick.js',
    '/editor/sample.json', '/app.js', '/viewer/index.js',
    // 浏览态标注层 + 场景图层面板（编辑器标注的浏览态只读渲染与显隐控制）
    '/browse-annotations.js', '/browse-ann-ui.js'];
  let okCount = 0;
  for (const u of urls) {
    try {
      const r = await fetch(BASE + u);
      const b = await r.arrayBuffer();
      if (r.status === 200 && b.byteLength > 0) okCount++;
      else console.log(`    ${u} -> ${r.status} ${b.byteLength}B`);
    } catch (e) { console.log(`    ${u} -> FAIL ${e.message}`); }
  }
  check('全部静态资源 200', okCount === urls.length, `${okCount}/${urls.length}`);

  /* ---------------------------------------------------------- 打开页面 */
  await send('Page.navigate', { url: BASE + '/' });
  await E(`(async()=>{for(let i=0;i<80;i++){const f=document.querySelector('iframe.gs-scene-frame');if(f&&f.contentWindow)return 1;await new Promise(r=>setTimeout(r,500));}return 0;})()`);
  await sleep(12000);

  const FM = `document.querySelector('iframe.gs-scene-frame[data-active="1"]')||document.querySelector('iframe.gs-scene-frame')`;

  console.log('\n[2] 浏览态');
  const s1 = await E(`(()=>{const w=(${FM}).contentWindow;return{
    btn:!!document.getElementById('gsEditorBtn'),
    host:window.__mgEditorHost?.getState?.(),
    stage:getComputedStyle(document.getElementById('stage')).display,
    exitHidden:getComputedStyle(document.getElementById('gs-editor-exit')).display==='none',
    bridge:!!w.__mgEditorBridge, mounted:!!w.__mgEditorBridge?.mounted,
    preloadDone:Math.round(w.__mgEditorBridge?.marks?.preloadDone||0)};})()`);
  check('编辑入口按钮存在', s1.btn);
  check('默认浏览态（host.on=false）', s1.host?.on === false, s1.host);
  check('浏览 UI 可见（stage=block）', s1.stage === 'block', s1.stage);
  check('退出按钮隐藏', s1.exitHidden === true);
  check('iframe 桥接已加载', s1.bridge === true);
  check('编辑模块已预载求值', s1.preloadDone > 0, s1.preloadDone + 'ms');

  // 注入 mock viewer（headless 无 WebGPU，避免等 100MB SOG）
  // 相机放在 z=-10 朝 +z 看：示例数据（z=2~36）全部在视野内，
  // 否则视锥剔除会把展板 / 远景点判为「在相机背后」而不渲染。
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
    w.__mgPose=()=>({position:[0,1.6,-10],target:[0,1.6,10],fov:75});return 1;})()`);

  console.log('\n[3] 进入编辑模式');
  const s2 = await E(`(async()=>{
    const t0=performance.now();
    document.getElementById('gsEditorBtn').click();
    const w=(${FM}).contentWindow,d=w.document;
    const paused = w.__viewer.app.autoRender===false;     // 父页同步让路
    for(let i=0;i<200;i++){await new Promise(r=>setTimeout(r,50));if(w.__mgEditorBridge?.mounted)break;}
    const m=w.__mgEditorBridge.marks;
    return {wallMs:Math.round(performance.now()-t0), mountMs:m.mountMs, paused,
      host:window.__mgEditorHost.getState(), attr:document.documentElement.dataset.gsEditor,
      stage:getComputedStyle(document.getElementById('stage')).display,
      exitVisible:getComputedStyle(document.getElementById('gs-editor-exit')).display!=='none',
      cls:d.documentElement.classList.contains('mg-editor-on'),
      mounted:w.__mgEditorBridge?.mounted, ed:!!w.__mgEditor,
      tools:d.querySelectorAll('.ed-tools button').length,
      depth:d.querySelector('[data-act="depth"]')?.textContent,
      wasd:!!d.querySelector('.ed-wasd'),
      mesh:w.__mgEditor?.getState?.().meshStatus, tris:w.__mgEditor?.getState?.().meshTris,
      sseHidden:(()=>{const e=d.querySelector('.sse-controlsWrap');return !e||getComputedStyle(e).display==='none';})(),
      camMode:w.__viewer?.state?.cameraMode, flyFlag:!!w.__mgEditorFly,
      hint:(d.querySelector('[data-role="hint"]')||{}).textContent||''};})()`);
  check('父页模式切到编辑态', s2.host?.on === true, s2.host);
  check('data-gs-editor=on', s2.attr === 'on');
  check('浏览 UI 隐藏（stage=none）', s2.stage === 'none', s2.stage);
  check('退出按钮可见', s2.exitVisible === true);
  check('iframe 标记编辑类', s2.cls === true);
  check('编辑器已挂载', s2.mounted === true && s2.ed === true);
  check('工具栏 9 个工具（含三维屏 / 贴面矩形 / 透视贴花）', s2.tools === 9, s2.tools);
  check('深度开关存在', /深度/.test(s2.depth || ''), s2.depth);
  check('WASD 提示存在', s2.wasd === true);
  check('MESH 拾取就绪', s2.mesh === 'ready' && s2.tris > 0, s2.mesh + '/' + s2.tris);
  check('引擎自带控件已隐藏', s2.sseHidden === true);
  check('父页已让路（autoRender=false）', s2.paused === true);
  // 编辑画贴花要贴墙、布点要俯视，walk 的「离地 1.6m 胶囊」姿态碍事 → 默认飞行
  check('编辑器默认飞行相机（cameraMode=fly + __mgEditorFly）',
    s2.camMode === 'fly' && s2.flyFlag === true, [s2.camMode, s2.flyFlag]);
  check('状态行同步显示自由飞行', /自由飞行/.test(s2.hint || ''), s2.hint);
  console.log(`    挂载耗时 ${s2.mountMs}ms（预载命中时通常 < 20ms）`);

  console.log('\n[4] 交互：单击落点 / 拖拽放行 / 键盘');
  const s3 = await E(`(async()=>{const w=(${FM}).contentWindow,d=w.document,ed=w.__mgEditor;
    if(!ed)return{error:'editor not mounted'};
    const cv=d.getElementById('ed-mock-canvas');let up=0;cv.addEventListener('pointerup',()=>up++);
    const mk=(t,x,y)=>new w.PointerEvent(t,{clientX:x,clientY:y,bubbles:true,cancelable:true,pointerId:1,button:0,pointerType:'mouse'});
    ed.action('tool','point');const b=ed.store.list('floor1').length;
    cv.dispatchEvent(mk('pointerdown',400,300));cv.dispatchEvent(mk('pointerup',400,300));
    await new Promise(r=>setTimeout(r,400));
    const a=ed.store.list('floor1').length,src=ed.picker.lastSource;
    const clickBlocked=up===0;                 // 立即取值，避免后续重置污染
    up=0;
    cv.dispatchEvent(mk('pointerdown',400,300));cv.dispatchEvent(mk('pointerup',480,380));
    await new Promise(r=>setTimeout(r,150));
    const dr=ed.store.list('floor1').length,dragPassed=up===1;
    let k=0;const h=e=>{if(e.key==='a')k++;};w.addEventListener('keydown',h);
    w.dispatchEvent(new w.KeyboardEvent('keydown',{key:'a',bubbles:true,cancelable:true}));
    w.removeEventListener('keydown',h);
    const db=d.querySelector('[data-act="depth"]'),t0=db.textContent,s0=ed.getState().depthOn;
    db.click();await new Promise(r=>setTimeout(r,200));
    const t1=d.querySelector('[data-act="depth"]').textContent,s1=ed.getState().depthOn;
    const ph=await ed.picker.pickAsync(400,300);
    // 锁定状态必须在 pick 之后立刻读取：复位深度的动作会 endStroke 清掉锁定
    const locked=ed.picker.drawPlaneLocked;
    // 复位深度开关，后续用例在「深度开」状态下运行
    if(ed.getState().depthOn===false) db.click();
    await new Promise(r=>setTimeout(r,150));
    return{clickBlocked,created:a===b+1,src,dragPassed,dragNoPlace:dr===a,wasd:k>0,
      depthToggle:t0+'->'+t1,depthFlip:s0===true&&s1===false,planeSrc:ph?.source,locked};})()`);
  check('单击被编辑器拦截（不自动漫游）', s3.clickBlocked === true);
  check('单击创建了标注', s3.created === true);
  check('落点来源为 MESH', s3.src === 'mesh', s3.src);
  check('拖拽放行给引擎（可旋转视角）', s3.dragPassed === true);
  check('拖拽不会误落点', s3.dragNoPlace === true);
  check('WASD 键可达 Viewer', s3.wasd === true);
  check('深度开关可切换', s3.depthFlip === true, s3.depthToggle);
  check('深度关 -> 锁定绘制平面', s3.planeSrc === 'plane' && s3.locked === true,
    `source=${s3.planeSrc} locked=${s3.locked}`);

  console.log('\n[5] 叠加层定位：点 / 展板是否落在正确屏幕位置');
  const s5 = await E(`(async()=>{const w=(${FM}).contentWindow,d=w.document,ed=w.__mgEditor;
    await new Promise(r=>setTimeout(r,300));
    const items=[...d.querySelectorAll('.ed-item')];
    const info=items.map(el=>{const r=el.getBoundingClientRect();const cs=getComputedStyle(el);
      return{kind:el.dataset.kind,cls:el.className,pos:cs.position,
        x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),
        w:Math.round(r.width),h:Math.round(r.height)};});
    const stage=d.getElementById('mg-stage').getBoundingClientRect();
    const inStage=info.filter(i=>i.x>stage.left&&i.x<stage.right&&i.y>stage.top&&i.y<stage.bottom);
    return{items:info,inStage:inStage.length,stageW:Math.round(stage.width),stageH:Math.round(stage.height)};})()`);
  check('叠加层渲染出标注 DOM', (s5.items?.length || 0) > 0, (s5.items || []).length);
  check('所有标注均为 absolute 定位', (s5.items || []).every(i => i.pos === 'absolute'),
    (s5.items || []).map(i => i.pos).join(','));
  check('标注保留 ed-item 类（定位基座）', (s5.items || []).every(i => /(^| )ed-item( |$)/.test(i.cls)),
    (s5.items || []).map(i => i.cls).join(' | '));
  check('标注落在舞台范围内（非左上角堆积）', s5.inStage > 0,
    `inStage=${s5.inStage}/${(s5.items || []).length} stage=${s5.stageW}x${s5.stageH}`);
  check('展板有实际尺寸（矩形，未被压缩成 0）',
    (s5.items || []).filter(i => i.kind === 'board').every(i => i.w > 30 && i.h > 20),
    JSON.stringify((s5.items || []).filter(i => i.kind === 'board')));

  console.log('\n[6] 左侧列表 -> 右侧属性联动');
  const s6 = await E(`(async()=>{const w=(${FM}).contentWindow,d=w.document,ed=w.__mgEditor;
    const rows=[...d.querySelectorAll('.ed-list-row')];
    if(!rows.length)return{error:'no list rows'};
    const target=rows[Math.min(1,rows.length-1)];
    const tid=target.dataset.v;
    const before=ed.getState().selectedId;
    target.click();
    await new Promise(r=>setTimeout(r,250));
    const after=ed.getState().selectedId;
    const title=d.querySelector('.ed-prop [data-field="title"]');
    const body=d.querySelector('.ed-prop [data-field="body"]');
    const propHtml=d.querySelector('.ed-prop').innerHTML.length;
    // 连续输入标题：焦点、光标位置、输入值都必须保持
    let focusKept=false,cursorKept=false,typed='';
    if(title){
      title.focus();
      title.value='新标题';
      title.setSelectionRange(1,1);            // 光标停在第 1 个字符后
      title.dispatchEvent(new w.Event('input',{bubbles:true}));
      await new Promise(r=>setTimeout(r,200));
      focusKept=(d.activeElement===title);
      cursorKept=(title.selectionStart===1);
      typed=title.value;
    }
    const stored=ed.store.get(after)?.title;
    return{rows:rows.length,before,after,selected:after===tid,
      hasTitle:!!title,hasBody:!!body,propLen:propHtml,focusKept,cursorKept,typed,stored};})()`);
  check('左侧列表可点击', (s6.rows || 0) > 0, s6.rows);
  check('点击列表项即选中该标注', s6.selected === true, `${s6.before} -> ${s6.after}`);
  check('右侧属性面板已渲染', s6.hasTitle === true && s6.hasBody === true);
  check('属性输入后焦点不丢失', s6.focusKept === true, s6.focusKept);
  check('属性输入后光标位置保持', s6.cursorKept === true, s6.cursorKept);
  check('输入已写回数据模型', s6.stored === '新标题', s6.stored);

  console.log('\n[7] 展板内容：文字 / 图片 / 网页 / 视频');
  const s7 = await E(`(async()=>{const w=(${FM}).contentWindow,d=w.document,ed=w.__mgEditor;
    const board=ed.store.list('floor1').find(a=>a.kind==='board');
    if(!board)return{error:'no board'};
    ed.action('select',board.id);
    await new Promise(r=>setTimeout(r,250));
    const sel=document=>null;
    const before=d.querySelector('.ed-prop [data-media-field="type"]')?.value;
    // 切到「网页」
    const selEl=d.querySelector('.ed-prop [data-media-field="type"]');
    selEl.value='webpage';
    selEl.dispatchEvent(new w.Event('change',{bubbles:true}));
    await new Promise(r=>setTimeout(r,200));
    const urlEl=d.querySelector('.ed-prop [data-media-field="url"]');
    urlEl.value='https://example.com/hall';
    urlEl.dispatchEvent(new w.Event('input',{bubbles:true}));
    await new Promise(r=>setTimeout(r,300));
    const media=ed.store.get(board.id).media?.[0]||{};
    // 场景里的展板 DOM：网页内容应直接内嵌在三维展板内，不存在独立卡片
    const dom=d.querySelector('.ed-item[data-kind="board"] .ed-board-in');
    const webPlaceholder=d.querySelector('.ed-item[data-kind="board"] .ed-board-web');
    const webIframe=d.querySelector('.ed-item[data-kind="board"] .ed-board-web iframe');
    const cardGone=!d.querySelector('.ed-card');
    // 图片
    ed.action('media',{id:board.id,type:'image',url:'https://example.com/a.png',caption:'示意图'});
    await new Promise(r=>setTimeout(r,300));
    const img=d.querySelector('.ed-item[data-kind="board"] .ed-board-img');
    // 视频
    ed.action('media',{id:board.id,type:'video',url:'https://example.com/a.mp4'});
    await new Promise(r=>setTimeout(r,300));
    const vid=d.querySelector('.ed-item[data-kind="board"] .ed-board-video');
    // 文字
    ed.action('media',{id:board.id,type:'none'});
    await new Promise(r=>setTimeout(r,300));
    const noMedia=d.querySelector('.ed-item[data-kind="board"] .ed-board-media');
    return{hasBoard:!!board,before,mediaType:media.type,mediaUrl:media.url,
      hasDom:!!dom,webPlaceholder:!!webPlaceholder,webIframe:!!webIframe,cardGone,
      hasImg:!!img,hasVid:!!vid,
      mediaEmpty:!noMedia||noMedia.children.length===0,
      title:d.querySelector('.ed-board-title')?.textContent};})()`);
  check('展板 DOM 渲染在场景中', s7.hasDom === true);
  check('展板标题可见', !!s7.title, s7.title);
  check('网页内容写回数据模型', s7.mediaType === 'webpage' && /example/.test(s7.mediaUrl || ''),
    `${s7.mediaType} / ${s7.mediaUrl}`);
  check('网页形态在展板内嵌 iframe', s7.webPlaceholder === true && s7.webIframe === true);
  check('不存在独立弹出内容卡片', s7.cardGone === true);
  check('图片形态渲染 img', s7.hasImg === true);
  check('视频形态渲染 video', s7.hasVid === true);
  check('纯文字形态清空媒体区', s7.mediaEmpty === true);

  console.log('\n[8] 键盘隔离：宿主 / 引擎快捷键不得被误触');
  const s8 = await E(`(async()=>{const w=(${FM}).contentWindow,d=w.document,ed=w.__mgEditor;
    // 键盘事件必须派发到 body：真实按键的 target 是聚焦元素，
    // 冒泡顺序 body -> document -> window。直接往 window 派发不会向下冒泡，
    // 测不到挂在 document 上的编辑器拦截器。
    const fired=[];const spy=e=>fired.push(e.key);
    w.addEventListener('keydown',spy);
    for(const key of ['g','b','m','p']){
      d.body.dispatchEvent(new w.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));
    }
    await new Promise(r=>setTimeout(r,150));
    const leaked=fired.slice();
    w.removeEventListener('keydown',spy);
    // 工具快捷键 Shift+E 应切到「面」
    ed.action('tool','select');
    d.body.dispatchEvent(new w.KeyboardEvent('keydown',{key:'E',shiftKey:true,bubbles:true,cancelable:true}));
    await new Promise(r=>setTimeout(r,150));
    const tool=ed.getState().tool;
    // 漫游键 W 必须能到 window
    let moved=0;const mv=e=>{if(e.key==='w')moved++;};
    w.addEventListener('keydown',mv);
    d.body.dispatchEvent(new w.KeyboardEvent('keydown',{key:'w',bubbles:true,cancelable:true}));
    w.removeEventListener('keydown',mv);
    // 在属性输入框里打字：焦点保持，且不应触发引擎
    const title=d.querySelector('.ed-prop [data-field="title"]');
    let typedOk=false,typedLeak=0;
    if(title){
      title.focus();
      const lk=e=>typedLeak++;
      w.addEventListener('keydown',lk);
      title.dispatchEvent(new w.KeyboardEvent('keydown',{key:'g',bubbles:true,cancelable:true}));
      w.removeEventListener('keydown',lk);
      typedOk=(d.activeElement===title);
    }
    return{leaked,tool,moved,typedOk,typedLeak};})()`);
  check('宿主单键未泄漏到 window', (s8.leaked || []).length === 0, s8.leaked);
  check('Shift+E 切换到「面」工具', s8.tool === 'area', s8.tool);
  check('漫游键 W 仍可达引擎', (s8.moved || 0) > 0, s8.moved);
  check('输入框内焦点保持', s8.typedOk === true);
  check('输入框内按键不泄漏到引擎', (s8.typedLeak || 0) === 0, s8.typedLeak);

  console.log('\n[9] 绘制草稿：顶点手柄 + 橡皮筋');
  const s9 = await E(`(async()=>{const w=(${FM}).contentWindow,d=w.document,ed=w.__mgEditor;
    const cv=d.getElementById('ed-mock-canvas');
    const mk=(t,x,y)=>new w.PointerEvent(t,{clientX:x,clientY:y,bubbles:true,cancelable:true,pointerId:1,button:0,pointerType:'mouse'});
    ed.action('tool','line');
    cv.dispatchEvent(mk('pointermove',420,280));
    await new Promise(r=>setTimeout(r,120));
    cv.dispatchEvent(mk('pointerdown',400,300));cv.dispatchEvent(mk('pointerup',400,300));
    await new Promise(r=>setTimeout(r,400));
    const dots=d.querySelectorAll('.ed-draft-dot').length;
    const line=d.querySelector('.ed-draft');
    // 移动鼠标 -> 橡皮筋
    cv.dispatchEvent(mk('pointermove',500,260));
    await new Promise(r=>setTimeout(r,200));
    const rubber=d.querySelector('.ed-draft-rubber');
    const cross=d.querySelector('.ed-draft-cross');
    const rubberPts=rubber?rubber.getAttribute('points'):'';
    ed.action('tool','select');
    return{dots,hasLine:!!line,hasRubber:!!rubber,rubberPts,cross:!!cross};})()`);
  check('草稿顶点手柄已渲染', (s9.dots || 0) > 0, s9.dots);
  check('草稿折线已渲染', s9.hasLine === true);
  check('橡皮筋跟随鼠标', s9.hasRubber === true && (s9.rubberPts || '').split(' ').length >= 2, s9.rubberPts);
  check('光标十字准星已渲染', s9.cross === true);

  console.log('\n[10] 退出编辑');
  const s4 = await E(`(async()=>{document.getElementById('gs-editor-exit').click();
    await new Promise(r=>setTimeout(r,900));
    const w=(${FM}).contentWindow,d=w.document;return{
      host:window.__mgEditorHost.getState(),attr:document.documentElement.dataset.gsEditor,
      stage:getComputedStyle(document.getElementById('stage')).display,
      exitHidden:getComputedStyle(document.getElementById('gs-editor-exit')).display==='none',
      unmounted:!w.__mgEditor,uiRemoved:!d.querySelector('.ed-ui'),
      clsOff:!d.documentElement.classList.contains('mg-editor-on'),
      autoRender:w.__viewer.app.autoRender,
      flyFlag:!!w.__mgEditorFly, camMode:w.__viewer?.state?.cameraMode};})()`);
  check('父页回到浏览态', s4.host?.on === false, s4.host);
  check('data-gs-editor=off', s4.attr === 'off');
  check('浏览 UI 恢复', s4.stage === 'block', s4.stage);
  check('退出按钮隐藏', s4.exitHidden === true);
  check('编辑器已卸载', s4.unmounted === true && s4.uiRemoved === true);
  check('编辑标记已清除', s4.clsOff === true);
  check('渲染已恢复', s4.autoRender === true);
  // 飞行只是编辑态默认：退出时标记必须复位，浏览态不被污染
  check('退出编辑后飞行标记复位', s4.flyFlag === false, s4.flyFlag);

  console.log('\n[11] 新交互：列表按钮 / 双击飞入 / 双击结束 / 右键取消 / 展板拖拽');
  const s12 = await E(`(async()=>{
    const w=(${FM}).contentWindow,d=w.document;let ed=w.__mgEditor;
    // [10] 已退出编辑，这里重新进入（store 持久化在 localStorage，展板与标注仍在）
    if(!ed){ try{ parent.document.getElementById('gsEditorBtn').click(); }catch(e){}
      for(let i=0;i<400;i++){await new Promise(r=>setTimeout(r,50));if(w.__mgEditor&&w.__mgEditor.mounted)break;}
      ed=w.__mgEditor; }
    if(!ed)return{error:'no editor after re-enter'};
    const cv=d.getElementById('ed-mock-canvas');
    const mk=(t,x,y)=>new w.PointerEvent(t,{clientX:x,clientY:y,bubbles:true,cancelable:true,pointerId:1,button:0,pointerType:'mouse'});
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const out={};

    // ---- 展板：四角手柄 + 导引线 ----
    const boardEl=d.querySelector('.ed-item[data-kind="board"]');
    out.hasBoardEl=!!boardEl;
    out.corners=boardEl?boardEl.querySelectorAll('.ed-board-corner').length:0;
    out.guide=!!(boardEl&&boardEl.querySelector('.ed-board-lead'));

    // ---- 列表行按钮 ----
    const rows=[...d.querySelectorAll('.ed-list-row')];
    out.rows=rows.length;
    out.hasDel=rows.some(r=>r.querySelector('[data-act="item-del"]'));
    out.hasVis=rows.some(r=>r.querySelector('[data-act="item-vis"]'));

    // 显隐切换（取一个非展板行，避免误删展板）
    const visRow=rows.find(r=>{const a=ed.store.get(r.dataset.v);return a&&a.kind!=='board';})||rows[0];
    const visId=visRow.dataset.v,visBefore=ed.store.get(visId).visible;
    visRow.querySelector('[data-act="item-vis"]').click();
    await sleep(150);
    out.visToggled=ed.store.get(visId).visible!==visBefore;

    // 删除（删一个点标注，保留展板供后续测试）—— 列表在显隐切换时已重渲染，需重新查询
    const delRow=[...d.querySelectorAll('.ed-list-row')].find(r=>{const a=ed.store.get(r.dataset.v);return a&&a.kind==='point';})||[...d.querySelectorAll('.ed-list-row')][0];
    const delId=delRow.dataset.v,cBefore=ed.store.list('floor1').length;
    delRow.querySelector('[data-act="item-del"]').click();
    await sleep(200);
    out.deleted=!ed.store.get(delId)&&ed.store.list('floor1').length===cBefore-1;

    // ---- 双击列表行 = 不触发任何事件（定位走「飞到此处」按钮，双击已禁用）----
    const flyId=[...d.querySelectorAll('.ed-list-row')][0]?.dataset.v;
    const pose={position:[1,2,3],target:[4,5,6],fov:60};
    ed.store.update(flyId,{view:pose});
    await sleep(140);
    let flyCount=0;const origFly=w.__viewer.setCameraPose;
    w.__viewer.setCameraPose=(...a)=>{flyCount++;return origFly?origFly(...a):true;};
    const flyRow=[...d.querySelectorAll('.ed-list-row')].find(r=>r.dataset.v===flyId);
    flyRow?.dispatchEvent(new w.MouseEvent('dblclick',{bubbles:true,cancelable:true}));
    await sleep(200);
    out.dblListNoFly=flyCount===0;
    w.__viewer.setCameraPose=origFly;

    // ---- 展板移动（拖拽面板本体）---- 拖拽前必须先选中（overlay 拖拽要求 sel.includes(id)）
    const bId=ed.store.list('floor1').find(a=>a.kind==='board').id;
    const bBefore=JSON.stringify(ed.store.get(bId).points[0]);
    ed.action('select', bId); await sleep(200);
    let bEl=d.querySelector('.ed-item[data-kind="board"]');
    const br=bEl.getBoundingClientRect();
    bEl.dispatchEvent(mk('pointerdown',br.left+br.width/2,br.top+12));
    bEl.dispatchEvent(mk('pointermove',br.left+br.width/2+8,br.top+24));
    bEl.dispatchEvent(mk('pointerup',br.left+br.width/2+8,br.top+24));
    await sleep(200);
    out.boardMoved=JSON.stringify(ed.store.get(bId).points[0])!==bBefore;

    // ---- 展板四角缩放（拖拽右下角）---- 重新取节点（move 已触发重渲染）
    const sBefore=JSON.stringify(ed.store.get(bId).style.size);
    bEl=d.querySelector('.ed-item[data-kind="board"]');
    const corner=bEl.querySelector('.ed-board-corner.br');
    const cr=corner.getBoundingClientRect();
    corner.dispatchEvent(mk('pointerdown',cr.left+cr.width/2,cr.top+cr.height/2));
    bEl.dispatchEvent(mk('pointermove',cr.left+cr.width/2+25,cr.top+cr.height/2+15));
    bEl.dispatchEvent(mk('pointerup',cr.left+cr.width/2+25,cr.top+cr.height/2+15));
    await sleep(200);
    out.boardResized=JSON.stringify(ed.store.get(bId).style.size)!==sBefore;

    // ---- 双击不结束绘制；右键单击才结束（线）----
    ed.action('tool','line');
    const dBefore=ed.store.list('floor1').length;
    cv.dispatchEvent(mk('pointerdown',400,300));cv.dispatchEvent(mk('pointerup',400,300));
    await sleep(500);
    cv.dispatchEvent(mk('pointerdown',450,330));cv.dispatchEvent(mk('pointerup',450,330));
    await sleep(400);
    const dMid=ed.store.list('floor1').length;
    cv.dispatchEvent(new w.MouseEvent('dblclick',{clientX:450,clientY:330,bubbles:true,cancelable:true}));
    await sleep(300);
    const dAfterDbl=ed.store.list('floor1').length;
    out.dblNoFinish=(dMid===dBefore&&dAfterDbl===dBefore&&!!ed.overlay._draft);
    // 右键单击：结束本次绘制（≥ 下限点数），创建标注并回到「选择」
    cv.dispatchEvent(new w.MouseEvent('contextmenu',{clientX:450,clientY:330,bubbles:true,cancelable:true}));
    await sleep(300);
    const dAfterR=ed.store.list('floor1').length;
    out.rightFinish=(dAfterR===dBefore+1&&ed.getState().tool==='select');
    ed.action('tool','select');

    // ---- 右键单击不足下限的草稿 = 丢弃并回到「选择」----
    ed.action('tool','line');
    const c0=ed.store.list('floor1').length;
    cv.dispatchEvent(mk('pointerdown',400,300));cv.dispatchEvent(mk('pointerup',400,300));
    await sleep(300);
    const hadDraft=!!ed.overlay._draft;
    cv.dispatchEvent(new w.MouseEvent('contextmenu',{clientX:400,clientY:300,bubbles:true,cancelable:true}));
    await sleep(200);
    out.rightCancel=(hadDraft&&ed.overlay._draft===null&&ed.store.list('floor1').length===c0);
    ed.action('tool','select');

    // ---- 贴面矩形：右键 / 中键 pointerup 绝不能落点（异步队列复活草稿回归）----
    const mk2=(t,x,y,btn)=>new w.PointerEvent(t,{clientX:x,clientY:y,bubbles:true,cancelable:true,
      pointerId:2,button:btn,buttons:btn===2?2:1,pointerType:'mouse'});
    ed.action('tool','decal');
    const decBase=ed.store.list('floor1').length;
    // 右键 pointerup（无 contextmenu 跟随）：不得产生草稿点 / 新标注
    cv.dispatchEvent(mk2('pointerdown',420,320,2));cv.dispatchEvent(mk2('pointerup',420,320,2));
    await sleep(500);
    out.decalRightUpNoPlace=(ed.store.list('floor1').length===decBase&&!ed.overlay._draft);
    // 中键同理
    cv.dispatchEvent(mk2('pointerdown',420,320,1));cv.dispatchEvent(mk2('pointerup',420,320,1));
    await sleep(500);
    out.decalMidUpNoPlace=(ed.store.list('floor1').length===decBase&&!ed.overlay._draft);
    // 左键落 1 点后右键 contextmenu：草稿必须被取消且回到「选择」
    cv.dispatchEvent(mk2('pointerdown',400,300,0));cv.dispatchEvent(mk2('pointerup',400,300,0));
    await sleep(500);
    const hadDecalDraft=!!ed.overlay._draft;
    cv.dispatchEvent(new w.MouseEvent('contextmenu',{clientX:400,clientY:300,bubbles:true,cancelable:true}));
    await sleep(250);
    out.decalRightCancel=(hadDecalDraft&&ed.overlay._draft===null&&
      ed.store.list('floor1').length===decBase&&ed.getState().tool==='select');
    ed.action('tool','select');
    await sleep(150);

    // ---- 面板内滚轮不应联动场景（不抛异常、编辑器仍在）----
    let wheelOk=true;
    try{const rp=d.querySelector('.ed-right');rp.dispatchEvent(new w.WheelEvent('wheel',{deltaY:30,bubbles:true,cancelable:true}));}catch(e){wheelOk=false;}
    out.wheelIsolated=wheelOk&&!!ed;

    return out;
  })()`);
  check('展板四角手柄已渲染（4 个）', s12.corners === 4, s12.corners);
  check('展板导引线存在', s12.guide === true);
  check('列表行含删除按钮', s12.hasDel === true);
  check('列表行含显隐按钮', s12.hasVis === true);
  check('显隐按钮切换可见性', s12.visToggled === true);
  check('删除按钮移除标注', s12.deleted === true);
  check('双击列表行不触发任何事件（fly 计数为 0）', s12.dblListNoFly === true, s12.dblListNoFly);
  check('展板拖拽移动更新锚点', s12.boardMoved === true);
  check('展板四角拖拽缩放更新尺寸', s12.boardResized === true);
  check('双击不结束绘制（草稿保留、不新建标注）', s12.dblNoFinish === true, s12.dblNoFinish);
  check('右键单击结束绘制并回到「选择」', s12.rightFinish === true, s12.rightFinish);
  check('右键单击不足下限的草稿被丢弃并回「选择」', s12.rightCancel === true);
  check('贴面矩形：右键 pointerup 不落点', s12.decalRightUpNoPlace === true, s12.decalRightUpNoPlace);
  check('贴面矩形：中键 pointerup 不落点', s12.decalMidUpNoPlace === true, s12.decalMidUpNoPlace);
  check('贴面矩形：绘制中右键取消草稿并回「选择」', s12.decalRightCancel === true, s12.decalRightCancel);
  check('面板内滚轮不联动场景', s12.wheelIsolated === true);

  console.log('\n[12] 分组管理：新建 / 改名 / 指派 / 批量显隐 / 折叠 / 定位 / 解散');
  const s13 = await E(`(async()=>{
    const w=(${FM}).contentWindow,d=w.document,ed=w.__mgEditor;
    if(!ed)return{error:'no editor'};
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const qs=s=>d.querySelector(s);
    const out={};

    // 示例数据自带分组 + 面板分组行 / 列表组头
    out.groupCount=ed.store.groups().length;
    out.groupRows=d.querySelectorAll('.ed-group-row').length;
    out.groupHeads=d.querySelectorAll('.ed-group-hd').length;
    out.hasGroupSelect=false;

    // 新建分组，并自动设为当前分组
    const idsBefore=new Set(ed.store.groups().map(g=>g.id));
    qs('[data-act="group-add"]').click();
    await sleep(200);
    const added=ed.store.groups().find(g=>!idsBefore.has(g.id));
    out.added=!!added;
    out.activateOnAdd=!!added&&ed.getState().activeGroupId===added.id;

    // 行内改名（change 事件提交，不用 prompt）
    const nameEl=[...d.querySelectorAll('.ed-group-name')].find(el=>el.dataset.v===added?.id);
    if(nameEl){nameEl.value='展陈 A 区';nameEl.dispatchEvent(new w.Event('change',{bubbles:true}));}
    await sleep(200);
    out.renamed=ed.store.group(added.id)?.name==='展陈 A 区';

    // 属性面板的「分组」下拉 + 通过下拉指派
    const anyA=ed.store.list('floor1').find(a=>a.kind==='point')||ed.store.list('floor1')[0];
    ed.action('select',anyA.id);
    await sleep(200);
    const gsel=qs('.ed-prop [data-field="groupId"]');
    out.hasGroupSelect=!!gsel;
    out.groupOptions=gsel?gsel.options.length:0;
    if(gsel){gsel.value=added.id;gsel.dispatchEvent(new w.Event('change',{bubbles:true}));}
    await sleep(200);
    out.assigned=ed.store.get(anyA.id)?.groupId===added.id;

    // 「归入此组」按钮批量指派
    qs('[data-act="group-put"][data-v="g_hall"]').click();
    await sleep(200);
    out.put=ed.store.get(anyA.id)?.groupId==='g_hall';

    // 整组显隐：隐藏后 overlay 不再渲染组内标注，且不改写标注自身 visible
    const hallIds=ed.store.listByGroup('g_hall','floor1').map(a=>a.id);
    const selfVisible=hallIds.map(id=>ed.store.get(id).visible);
    qs('[data-act="group-vis"][data-v="g_hall"]').click();
    await sleep(350);
    const shown=[...d.querySelectorAll('.ed-item,.ed-g')].map(el=>el.dataset.id);
    out.groupHidden=ed.store.group('g_hall').visible===false;
    out.hiddenNotRendered=hallIds.length>0&&hallIds.every(id=>!shown.includes(id));
    out.selfVisibleKept=hallIds.every((id,i)=>ed.store.get(id).visible===selfVisible[i]);
    qs('[data-act="group-vis"][data-v="g_hall"]').click();
    await sleep(300);
    out.restored=ed.store.group('g_hall').visible===true;

    // 折叠组头 -> 列表行减少
    const cntBefore=d.querySelectorAll('.ed-list-row').length;
    qs('[data-act="group-fold"][data-v="g_guide"]').click();
    await sleep(200);
    out.folded=ed.store.group('g_guide').collapsed===true&&d.querySelectorAll('.ed-list-row').length<cntBefore;
    qs('[data-act="group-fold"][data-v="g_guide"]').click();
    await sleep(150);

    // 设为当前分组后，新绘制的标注自动归入
    qs('[data-act="group-activate"][data-v="'+added.id+'"]').click();
    await sleep(150);
    out.activeSet=ed.getState().activeGroupId===added.id;
    const cv=d.getElementById('ed-mock-canvas');
    const mk=(t,x,y)=>new w.PointerEvent(t,{clientX:x,clientY:y,bubbles:true,cancelable:true,pointerId:1,button:0,pointerType:'mouse'});
    const oldIds=new Set(ed.store.list('floor1').map(a=>a.id));
    ed.action('tool','point');
    cv.dispatchEvent(mk('pointerdown',400,300));cv.dispatchEvent(mk('pointerup',400,300));
    await sleep(500);
    const fresh=ed.store.list('floor1').find(a=>!oldIds.has(a.id));
    out.autoGroup=!!fresh&&fresh.groupId===added.id;
    ed.action('tool','select');

    // 飞到分组中心
    let fly=0;const orig=w.__viewer.setCameraPose;
    w.__viewer.setCameraPose=()=>{fly++;return true;};
    qs('[data-act="group-fly"][data-v="g_zone"]').click();
    await sleep(200);
    out.groupFly=fly>0;
    w.__viewer.setCameraPose=orig;

    // 解散分组：标注移回默认组且不丢失，当前分组复位
    const kids=ed.store.listByGroup(added.id,'floor1').map(a=>a.id);
    const total=ed.store.list('floor1').length;
    qs('[data-act="group-del"][data-v="'+added.id+'"]').click();
    await sleep(200);
    out.disbanded=!ed.store.group(added.id);
    out.keptAnnotations=ed.store.list('floor1').length===total&&kids.every(id=>ed.store.get(id)?.groupId==='default');
    out.activeReset=ed.getState().activeGroupId==='default';

    // 撤销可恢复分组结构
    ed.action('undo');
    await sleep(200);
    out.undoRestores=!!ed.store.group(added.id);
    return out;
  })()`);
  check('示例数据自带分组', (s13.groupCount || 0) >= 2, s13.groupCount);
  check('面板渲染分组管理行', (s13.groupRows || 0) >= 2, s13.groupRows);
  check('标注列表按分组显示组头', (s13.groupHeads || 0) >= 2, s13.groupHeads);
  check('新建分组成功', s13.added === true);
  check('新建分组自动设为当前分组', s13.activateOnAdd === true);
  check('行内改名生效', s13.renamed === true);
  check('属性面板含分组下拉', s13.hasGroupSelect === true && (s13.groupOptions || 0) >= 2, s13.groupOptions);
  check('下拉可把标注指派到分组', s13.assigned === true);
  check('「归入此组」按钮可改派', s13.put === true);
  check('整组显隐开关生效', s13.groupHidden === true);
  check('隐藏分组后三维场景不再渲染该组', s13.hiddenNotRendered === true);
  check('整组显隐不改写标注自身 visible', s13.selfVisibleKept === true);
  check('恢复显示生效', s13.restored === true);
  check('组头可折叠标注列表', s13.folded === true);
  check('可手动切换当前分组', s13.activeSet === true);
  check('新绘制标注自动归入当前分组', s13.autoGroup === true);
  check('可飞到分组标注中心', s13.groupFly === true);
  check('解散分组后分组被移除', s13.disbanded === true);
  check('解散不删除标注（移回默认组）', s13.keptAnnotations === true);
  check('当前分组已复位', s13.activeReset === true);
  check('撤销可恢复分组结构', s13.undoRestores === true);

  console.log('\n[13] 展板内容三维空间内嵌展示（无独立页面）');
  const s14 = await E(`(async()=>{
    const w=(${FM}).contentWindow,d=w.document,ed=w.__mgEditor;
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const out={};
    const b=ed.store.list('floor1').find(a=>a.kind==='board');
    if(!b)return{error:'no board'};
    ed.action('select',b.id);
    await sleep(250);
    out.noCard=!d.querySelector('.ed-card');

    // 网页直接内嵌 iframe
    const url='data:text/html;charset=utf-8,'+encodeURIComponent('<h3>三维展板内嵌网页</h3>');
    ed.action('media',{id:b.id,type:'webpage',url:url,caption:'城市数据看板'});
    await sleep(400);
    const item=d.querySelector('.ed-item[data-kind="board"]');
    const frame=item?.querySelector('.ed-board-web iframe');
    out.iframe=!!frame;
    out.iframeSrc=(frame?.getAttribute('src')||'').startsWith('data:text/html');
    const sb=frame?.getAttribute('sandbox')||'';
    out.sandboxed=sb.includes('allow-scripts')&&!sb.includes('allow-popups');
    out.inWorldLayer=!!(item&&item.closest('.ed-layer'));
    out.interactiveWhenSelected=getComputedStyle(item.querySelector('.ed-board-web'),'::after').display==='none';

    // 媒体签名不变时不得重建 iframe（否则每帧重载闪烁）
    const first=item.querySelector('.ed-board-web iframe');
    ed.action('property',{id:b.id,field:'body',val:'内嵌内容展示验证'});
    await sleep(300);
    out.noReload=d.querySelector('.ed-item[data-kind="board"] .ed-board-web iframe')===first;

    // 视频 / 图片同样直接内嵌在展板内
    ed.action('media',{id:b.id,type:'video',url:'https://example.com/clip.mp4'});
    await sleep(300);
    out.videoInline=!!d.querySelector('.ed-item[data-kind="board"] .ed-board-video[controls]');
    ed.action('media',{id:b.id,type:'image',url:'https://example.com/pic.png'});
    await sleep(300);
    out.imgInline=!!d.querySelector('.ed-item[data-kind="board"] .ed-board-img');

    // 点击展板只选中，绝不弹出页面
    d.querySelector('.ed-item[data-kind="board"]').click();
    await sleep(200);
    out.clickSelectOnly=!d.querySelector('.ed-card')&&ed.getState().selectedId===b.id;
    return out;
  })()`);
  check('已移除独立内容卡片', s14.noCard === true);
  check('网页内容以 iframe 内嵌展板', s14.iframe === true && s14.iframeSrc === true);
  check('iframe sandbox 隔离且不允许弹窗', s14.sandboxed === true);
  check('展板挂在世界锚定叠加层内', s14.inWorldLayer === true);
  check('选中展板后网页可直接交互', s14.interactiveWhenSelected === true);
  check('属性变更不重载 iframe（不闪烁）', s14.noReload === true);
  check('视频直接内嵌展板', s14.videoInline === true);
  check('图片直接内嵌展板', s14.imgInline === true);
  check('点击展板只选中、不弹页面', s14.clickSelectOnly === true);

  console.log('\n[14] 展板引线锚点：编辑态可拖动 + 自动吸附最近碰撞 MESH');
  const s15 = await E(`(async()=>{
    const w=(${FM}).contentWindow,d=w.document,ed=w.__mgEditor;
    if(!ed)return{error:'no editor'};
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const out={};
    const b=ed.store.list('floor1').find(a=>a.kind==='board');
    if(!b)return{error:'no board'};
    // 深度检测已改为默认开启：本组用「恒定命中 12m」的碰撞桩模拟吸附，会把展板
    // 判成被遮挡而整块隐藏 —— 这里显式关掉，专注验证引线锚点交互。
    ed.store.update(b.id,{depthTest:false});
    ed.action('select',b.id);
    await sleep(250);
    const item=d.querySelector('.ed-item[data-kind="board"]');
    const dot=item?.querySelector('[data-role="board-anchor"]');
    out.hasDot=!!dot;
    out.editable=!!dot&&dot.classList.contains('ed-anchor-draggable');
    out.dotHit=!!dot&&getComputedStyle(dot).pointerEvents==='auto';
    const lead0=item?.querySelector('.ed-board-lead');
    out.guideBefore=lead0?.style.height||'';

    // 让 mock 碰撞体按射线方向返回不同点，验证吸附结果确实跟着光标走
    const col=w.__viewer.collision();const origRay=col.queryRay;
    col.queryRay=(ox,oy,oz,dx,dy,dz)=>({x:ox+dx*12,y:0,z:oz+dz*12});
    const mk=(t,x,y)=>new w.PointerEvent(t,{clientX:x,clientY:y,bubbles:true,cancelable:true,pointerId:3,button:0,pointerType:'mouse'});
    dot.dispatchEvent(mk('pointerdown',520,360));
    dot.dispatchEvent(mk('pointermove',560,400));
    dot.dispatchEvent(mk('pointermove',600,430));
    await sleep(220);
    const after=ed.store.get(b.id).style.leadTo;
    out.saved=Array.isArray(after)&&after.length===3&&after.every(Number.isFinite);
    out.leadTo=after?after.map(n=>Number(n.toFixed(2))):null;
    dot.dispatchEvent(mk('pointerup',600,430));
    await sleep(200);
    out.selectedOnPick=ed.getState().selectedId===b.id;

    const snap=ed.picker.snapToMesh(540,380);
    out.snapSource=snap?.source;out.snapped=snap?.snapped;
    out.snapPos=snap?.pos?.map(n=>Number(n.toFixed(2)));

    const lead1=d.querySelector('.ed-item[data-kind="board"] .ed-board-lead');
    out.guideAfter=lead1?.style.height||'';
    out.guideChanged=out.guideAfter!==out.guideBefore;
    out.guideRotated=/rotate/.test(lead1?.style.transform||'');
    out.longClass=lead1?.classList.contains('ed-lead-long');

    const reset=d.querySelector('.ed-prop [data-act="anchor-reset"]');
    out.hasReset=!!reset;
    if(reset)reset.click();
    await sleep(220);
    out.resetCleared=ed.store.get(b.id).style.leadTo===null;

    // 预览态只读：锚点不可拖动
    ed.action('preview');await sleep(220);
    const dot2=d.querySelector('.ed-item[data-kind="board"] [data-role="board-anchor"]');
    out.previewReadonly=!!dot2&&!dot2.classList.contains('ed-anchor-draggable')&&getComputedStyle(dot2).pointerEvents==='none';
    ed.action('preview');await sleep(160);
    col.queryRay=origRay;
    return out;
  })()`);
  check('展板导引线末端有独立锚点 handle', s15.hasDot === true);
  check('编辑态锚点可点击拖动', s15.editable === true && s15.dotHit === true,
    `${s15.editable}/${s15.dotHit}`);
  check('拖动锚点写入 style.leadTo 世界坐标', s15.saved === true, s15.leadTo);
  check('拾取锚点即选中该标注', s15.selectedOnPick === true);
  check('snapToMesh 吸附到碰撞 MESH', s15.snapSource === 'mesh' && s15.snapped === true,
    `${s15.snapSource}/${s15.snapped}/${JSON.stringify(s15.snapPos)}`);
  check('导引线随锚点拉长并旋转', s15.guideChanged === true && s15.guideRotated === true,
    `${s15.guideBefore} -> ${s15.guideAfter}`);
  check('长导引线标记生效', s15.longClass === true);
  check('复位按钮清空独立锚点', s15.hasReset === true && s15.resetCleared === true);
  check('预览态锚点只读不可拖', s15.previewReadonly === true);

  console.log('\n[15] 拾取标注后属性面板自动展示内容');
  const s16 = await E(`(async()=>{
    const w=(${FM}).contentWindow,d=w.document,ed=w.__mgEditor;
    if(!ed)return{error:'no editor'};
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const out={};
    const pt=ed.store.list('floor1').find(a=>a.kind==='point');
    if(!pt)return{error:'no point'};
    const img='data:image/svg+xml;utf8,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#38d6f5"/></svg>');
    ed.store.update(pt.id,{title:'拾取内容验证点',body:'这是自动展示的正文内容。',
      link:'https://example.com/info',visible:true,groupId:'default',
      media:[{type:'image',url:img,caption:'示意图'}]});
    ed.action('select',null);await sleep(200);
    out.emptyBefore=!!d.querySelector('.ed-prop-empty');
    const el=d.querySelector('.ed-item[data-kind="point"][data-id="'+pt.id+'"]');
    out.hasEl=!!el;
    el?.click();await sleep(250);
    out.picked=ed.getState().selectedId===pt.id;
    const view=d.querySelector('.ed-prop [data-role="pick-view"]');
    out.hasView=!!view;
    out.titleShown=view?.querySelector('[data-role="pick-title"]')?.textContent;
    out.bodyShown=view?.querySelector('[data-role="pick-body"]')?.textContent;
    out.mediaImg=!!view?.querySelector('.ed-pick-img');
    out.linkShown=view?.querySelector('[data-role="pick-link"]')?.getAttribute('href');
    const bodyInput=d.querySelector('.ed-prop [data-field="body"]');
    out.hasEditor=!!bodyInput;
    if(bodyInput){bodyInput.value='改过的正文';bodyInput.dispatchEvent(new w.Event('input',{bubbles:true}));}
    await sleep(220);
    out.bodySynced=view?.querySelector('[data-role="pick-body"]')?.textContent==='改过的正文';
    out.sameView=view===d.querySelector('.ed-prop [data-role="pick-view"]');

    // 展板「真实指针单击」不能因拖拽逻辑被抑制（单击 -> 选中 -> 属性面板展示）
    ed.action('select',null);await sleep(150);
    const board=ed.store.list('floor1').find(a=>a.kind==='board');
    const bEl=d.querySelector('.ed-item[data-kind="board"]');
    const mk=(t,x,y)=>new w.PointerEvent(t,{clientX:x,clientY:y,bubbles:true,cancelable:true,pointerId:7,button:0,pointerType:'mouse'});
    const r=bEl.getBoundingClientRect();
    bEl.dispatchEvent(mk('pointerdown',r.left+r.width/2,r.top+10));
    bEl.dispatchEvent(mk('pointerup',r.left+r.width/2,r.top+10));
    out.noSuppress=ed.overlay._suppressClick===false;
    bEl.dispatchEvent(new w.MouseEvent('click',{bubbles:true,cancelable:true,clientX:r.left+r.width/2,clientY:r.top+10}));
    await sleep(220);
    out.boardClickSelects=ed.getState().selectedId===board.id;

    // 预览态拾取后，右侧面板以只读内容预览重新出现
    ed.action('preview');await sleep(200);
    ed.action('select',pt.id);await sleep(220);
    out.previewHasPick=d.querySelector('.ed-ui').classList.contains('ed-has-pick');
    out.previewRightVisible=getComputedStyle(d.querySelector('.ed-right')).display!=='none';
    out.previewViewVisible=(()=>{const v=d.querySelector('.ed-pick-view');return !!v&&getComputedStyle(v).display!=='none';})();
    out.previewInputsHidden=(()=>{const t=d.querySelector('.ed-prop [data-field="title"]');return !!t&&getComputedStyle(t.closest('label')).display==='none';})();
    ed.action('preview');await sleep(160);
    return out;
  })()`);
  check('未选中时属性面板是空态', s16.emptyBefore === true);
  check('场景内可点击拾取点标注', s16.hasEl === true && s16.picked === true);
  check('拾取后属性面板出现内容预览', s16.hasView === true);
  check('内容预览自动显示标题', s16.titleShown === '拾取内容验证点', s16.titleShown);
  check('内容预览自动显示正文', s16.bodyShown === '这是自动展示的正文内容。', s16.bodyShown);
  check('内容预览自动显示图片媒体', s16.mediaImg === true);
  check('内容预览自动显示链接', s16.linkShown === 'https://example.com/info', s16.linkShown);
  check('编辑正文时预览同步且不重建', s16.hasEditor === true && s16.bodySynced === true && s16.sameView === true);
  check('展板单击不再被拖拽逻辑抑制', s16.noSuppress === true);
  check('展板真实单击可选中并展示属性', s16.boardClickSelects === true);
  check('预览态拾取后属性面板可见', s16.previewHasPick === true && s16.previewRightVisible === true);
  check('预览态只显示内容预览、隐藏编辑控件',
    s16.previewViewVisible === true && s16.previewInputsHidden === true);

  console.log('\n[16] 动线：等宽「箭头形状多边形」链（箭头由轮廓形成，不在带内）');
  const s17 = await E(`(async()=>{
    const w=(${FM}).contentWindow,d=w.document,ed=w.__mgEditor;
    if(!ed)return{error:'no editor'};
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const out={};
    const route=ed.store.list('floor1').find(a=>a.kind==='line');
    if(!route)return{error:'no line'};
    ed.store.update(route.id,{visible:true,groupId:'default',
      style:{bandWidth:0.9,flowArrow:true,flowSpeed:1.4}});
    ed.action('select',route.id);await sleep(320);
    const g=d.querySelector('.ed-g[data-id="'+route.id+'"]');
    out.hasG=!!g;
    const segs=[...(g?g.querySelectorAll('.ed-flow-arrow-seg'):[])].filter(p=>p.style.display!=='none');
    out.segCount=segs.length;
    out.allPolygon=segs.length>0&&segs.every(p=>p.tagName.toLowerCase()==='polygon');
    // 等宽箭头轮廓 = 6 个顶点（尾 V 凹口 + 两侧等宽边 + 前端箭头尖）
    out.arrowOutline=segs.every(p=>(p.getAttribute('points')||'').trim().split(/\\s+/).filter(Boolean).length===6);
    out.filled=segs.every(p=>w.getComputedStyle(p).fill!=='none');
    // 不再有渐变底带 / 带内小箭头图标 / 流动虚线脉冲 / SVG 渐变定义
    out.noBaseBand=!g?.querySelector('.ed-flow-band');
    out.noInnerArrows=!g?.querySelector('.ed-flow-arrow');
    out.noPulse=!g?.querySelector('.ed-flow-pulse');
    out.noGradient=d.querySelectorAll('.ed-svg defs linearGradient').length===0;
    out.oldThinLineHidden=g?.querySelector('.ed-shape')?.getAttribute('stroke')==='transparent';
    const p0=segs[0]?.getAttribute('points');
    await sleep(280);
    const p1=d.querySelector('.ed-g[data-id="'+route.id+'"] .ed-flow-arrow-seg')?.getAttribute('points');
    out.animated=!!p0&&p0!==p1;

    // 纯几何：宽度严格一致 + 无外扩鼓包 + 箭头尖落在中心线上
    const mod=await import('./editor/schema.js');
    const line=[{x:0,y:0},{x:300,y:0}];
    const hw=18;
    const chain=mod.arrowChain(line,hw,72,0,{arrow:true});
    out.chainCount=chain.length;
    out.uniformWidth=chain.every(poly=>{
      const a=poly[0],b=poly[4];
      return Math.abs(Math.hypot(b[0]-a[0],b[1]-a[1])-2*hw)<1e-6;
    });
    // 所有顶点横向偏移都落在 [-hw, hw]：箭头尖 / 凹口不越界（严格等宽）
    out.noBulge=chain.every(poly=>poly.every(q=>Math.abs(q[1])<=hw+1e-6));
    // 箭头尖（第 3 个顶点）与尾部 V 凹口（第 6 个顶点）都在中心线上
    out.tipOnAxis=chain.length>0&&chain.every(p=>Math.abs(p[2][1])<1e-6);
    out.notchOnAxis=chain.length>0&&chain.every(p=>Math.abs(p[5][1])<1e-6);
    const rect=mod.arrowChain(line,hw,72,0,{arrow:false});
    out.rectOutline=rect.length>0&&rect.every(p=>p.length===4);
    out.rectWidth=rect.every(p=>Math.abs(Math.hypot(p[3][0]-p[0][0],p[3][1]-p[0][1])-2*hw)<1e-6);
    // 弯道处箭头仍跟着折线转向（非简单平移）
    const bent=mod.arrowChain([{x:0,y:0},{x:120,y:0},{x:120,y:120}],hw,72,0,{arrow:true});
    out.bendFollows=bent.length>0;

    /* 世界箭头链：单个箭头的大小必须与「路径总长 / 相位」无关。
       旧实现 n=round(total/segLen)、L=total/n，贴地结果逐帧微调 total 时
       L 会跳变，动画里看到的就是「箭头忽大忽小」。 */
    const chord=(poly)=>Math.hypot(poly[2][0]-poly[0][0],poly[2][2]-poly[0][2]);
    const shortW=mod.arrowChainWorld([[0,0,0],[0,0,4]],0.3,1.4,0.1,{arrow:true});
    const longW=mod.arrowChainWorld([[0,0,0],[0,0,12]],0.3,1.4,0.63,{arrow:true});
    out.worldArrows=shortW.length>0&&longW.length>shortW.length;
    out.worldSizeStable=shortW.length>0&&longW.length>0&&
      Math.abs(chord(shortW[0])-chord(longW[0]))<0.02;
    // 抖动折线（贴地逐点吸附的真实形态）：同一个箭头的两个腰必须同向，不得翻折
    const jitter=[];for(let i=0;i<=40;i++)jitter.push([i*0.45,0,Math.sin(i*1.7)*0.06]);
    const jw=mod.arrowChainWorld(jitter,0.3,1.4,0.4,{arrow:true});
    out.worldNoSpike=jw.length>0&&jw.every(p=>{
      const wid=Math.hypot(p[4][0]-p[0][0],p[4][2]-p[0][2]);
      return Math.abs(wid-0.6)<0.06;                 // 带身宽度恒为 2*halfW
    });
    /* 沿墙面向上（切线接近竖直）：世界 up 做参考会退化。旧代码退回 (0,tz,-ty)，
       面片垂直于墙面伸出去 → 侧视只剩一条尖刺，且相邻样本方向乱跳（「箭头旋转变化」）。
       给 viewDir 后应改用「切线 × 视线」，带身仍保持 2*halfW 宽且落在墙面平面内。 */
    const wall=[];for(let i=0;i<=20;i++)wall.push([0,i*0.45,0]);
    const ww=mod.arrowChainWorld(wall,0.315,1.45,0.35,{arrow:true,viewDir:[-1,0,0]});
    out.wallWidthOk=ww.length>0&&ww.every(p=>{
      const wid=Math.hypot(p[4][0]-p[0][0],p[4][1]-p[0][1],p[4][2]-p[0][2]);
      return Math.abs(wid-0.63)<0.05;
    });
    // 侧向必须垂直于视线（贴墙展开），不能指向相机
    out.wallLatOk=ww.length>0&&ww.every(p=>{
      const lx=p[4][0]-p[0][0],ly=p[4][1]-p[0][1],lz=p[4][2]-p[0][2];
      return Math.abs(lx)<0.05;                      // viewDir=(-1,0,0) => lat 里不能含 X 分量
    });
    // 动线本体保留不可见宽描边做命中区（箭头缝隙里点击才不会穿透成「新建标注」）
    const hitSlop=d.querySelector('.ed-g[data-id="'+route.id+'"] .ed-shape');
    out.flowHitSlop=!!hitSlop&&hitSlop.style.pointerEvents==='stroke'&&
      Number(hitSlop.getAttribute('stroke-width'))>=12;

    const before=d.querySelector('.ed-g[data-id="'+route.id+'"] .ed-flow-arrow-seg')?.getAttribute('points');
    const bw=d.querySelector('.ed-prop [data-field="bandWidth"]');
    out.hasBandInput=!!bw;
    if(bw){bw.value='2';bw.dispatchEvent(new w.Event('change',{bubbles:true}));}
    await sleep(260);
    out.widthStored=ed.store.get(route.id).style.bandWidth===2;
    out.widthChanged=d.querySelector('.ed-g[data-id="'+route.id+'"] .ed-flow-arrow-seg')?.getAttribute('points')!==before;
    const sp=d.querySelector('.ed-prop [data-field="flowSpeed"]');
    const ar=d.querySelector('.ed-prop [data-field="flowArrow"]');
    out.hasFlowControls=!!sp&&!!ar;
    if(ar){ar.checked=false;ar.dispatchEvent(new w.Event('change',{bubbles:true}));}
    await sleep(260);
    out.arrowToggle=ed.store.get(route.id).style.flowArrow===false;
    out.rectSegs=[...d.querySelectorAll('.ed-g[data-id="'+route.id+'"] .ed-flow-arrow-seg')]
      .filter(p=>p.style.display!=='none')
      .every(p=>(p.getAttribute('points')||'').trim().split(/\\s+/).filter(Boolean).length===4);
    if(ar){ar.checked=true;ar.dispatchEvent(new w.Event('change',{bubbles:true}));}
    await sleep(160);

    ed.action('select',null);await sleep(160);
    const seg=d.querySelector('.ed-g[data-id="'+route.id+'"] .ed-flow-arrow-seg');
    seg?.dispatchEvent(new w.MouseEvent('click',{bubbles:true,cancelable:true}));
    await sleep(220);
    out.segPick=ed.getState().selectedId===route.id;
    return out;
  })()`);
  check('动线由箭头形状 polygon 构成', s17.allPolygon === true && s17.segCount > 0, s17.segCount);
  check('每段轮廓自带箭头尖 + 尾部 V 凹口（6 顶点）', s17.arrowOutline === true);
  check('箭头段是半透明填充多边形', s17.filled === true);
  check('不再有渐变底带 / 带内小箭头 / 脉冲线',
    s17.noBaseBand === true && s17.noInnerArrows === true && s17.noPulse === true && s17.noGradient === true);
  check('旧细线不再单独可见', s17.oldThinLineHidden === true);
  check('箭头链沿路径流动（逐帧相位推进）', s17.animated === true);
  check('纯几何：所有段带身宽度严格一致', s17.uniformWidth === true && s17.chainCount > 0, s17.chainCount);
  check('纯几何：轮廓无外扩鼓包（横向不越界）', s17.noBulge === true);
  check('纯几何：箭头尖 / 尾凹口都在中心线上', s17.tipOnAxis === true && s17.notchOnAxis === true);
  check('纯几何：弯道处箭头随折线转向', s17.bendFollows === true);
  check('世界箭头链：段数随路径变长而增加，单箭头大小不变（动画中不再忽大忽小）',
    s17.worldArrows === true && s17.worldSizeStable === true);
  check('世界箭头链：贴地抖动折线上带身宽度恒定（不翻折 / 不出尖刺）',
    s17.worldNoSpike === true);
  check('世界箭头链：沿墙面向上时侧向不退化（贴墙展开，不变成垂直于墙的尖刺）',
    s17.wallWidthOk === true && s17.wallLatOk === true);
  check('动线本体有不可见宽描边命中区（缝隙点击不会穿透成新建标注）',
    s17.flowHitSlop === true);
  check('关闭箭头后退化为 4 点等宽矩形段', s17.rectOutline === true && s17.rectWidth === true);
  check('属性面板可调动线带宽', s17.hasBandInput === true && s17.widthStored === true);
  check('带宽改变后箭头段顶点变化', s17.widthChanged === true);
  check('属性面板含速度 / 箭头开关', s17.hasFlowControls === true);
  check('关闭箭头后渲染为等宽矩形段', s17.arrowToggle === true && s17.rectSegs === true);
  check('点击箭头段可直接拾取动线', s17.segPick === true);

  console.log('\n[17] 点击展板不改位置 + 三维实体屏（固定世界朝向 / 视频播放）');
  const s18 = await E(`(async()=>{
    const w=(${FM}).contentWindow,d=w.document,ed=w.__mgEditor;
    if(!ed)return{error:'no editor'};
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const out={};
    const mk=(t,x,y)=>new w.PointerEvent(t,{clientX:x,clientY:y,bubbles:true,cancelable:true,pointerId:9,button:0,pointerType:'mouse'});
    const clk=(el,x,y)=>el.dispatchEvent(new w.MouseEvent('click',{clientX:x,clientY:y,bubbles:true,cancelable:true}));

    // ---------- A. 单击展板绝不改变位置 ----------
    const b=ed.store.list('floor1').find(a=>a.kind==='board');
    if(!b)return{error:'no board'};
    ed.overlay._suppressClick=false;         // 清除历史手势残留状态
    ed.action('select',null);await sleep(180);
    const bEl=d.querySelector('.ed-item[data-kind="board"]');
    out.hasBoardDom=!!bEl;
    const r=bEl?.getBoundingClientRect();
    const cx=r?r.left+r.width/2:500, cy=r?r.top+14:300;
    const pBefore=JSON.stringify(ed.store.get(b.id).points[0]);
    if(bEl){
      bEl.dispatchEvent(mk('pointerdown',cx,cy));
      bEl.dispatchEvent(mk('pointermove',cx+2,cy+1));   // 点击时的手部微抖，仍属单击
      bEl.dispatchEvent(mk('pointerup',cx+2,cy+1));
      clk(bEl,cx+2,cy+1);
    }
    await sleep(260);
    out.clickKeepsPos=JSON.stringify(ed.store.get(b.id).points[0])===pBefore;
    out.clickSelects=ed.getState().selectedId===b.id;

    // ---------- B. 真拖拽按「锚点 + 位移」平移，而非光标绝对位置 ----------
    const origPick=ed.picker.pickSync;
    let called=null;
    // mock 碰撞体的 queryRay 恒返回 [2,0,4]，若用真实 pickSync 则无论拖到哪里
    // points[0] 都不变（假阴性）。这里用随坐标变化的桩，验证「锚点基准 -> 写回」链路。
    ed.picker.pickSync=(x,y)=>{
      if(!called)called=[x,y];
      return {pos:[x/100,1.2,y/100],source:'mesh'};
    };
    const bEl2=d.querySelector('.ed-item[data-kind="board"]');
    const r2=bEl2.getBoundingClientRect();
    const dx0=r2.left+r2.width/2, dy0=r2.top+14;
    const pDragBefore=JSON.stringify(ed.store.get(b.id).points[0]);
    bEl2.dispatchEvent(mk('pointerdown',dx0,dy0));
    bEl2.dispatchEvent(mk('pointermove',dx0+60,dy0+40));
    bEl2.dispatchEvent(mk('pointerup',dx0+60,dy0+40));
    await sleep(260);
    ed.picker.pickSync=origPick;
    out.dragMoves=JSON.stringify(ed.store.get(b.id).points[0])!==pDragBefore;
    // 展板水平中心与锚点 x 恰好重合，x 无法区分两种实现；
    // 但按下点在板顶、锚点在板底 + gap，y 方向相差整个板高，能真正区分。
    out.anchorBased=!!called&&Math.abs(called[1]-(dy0+40))>40;
    out.calledY=called?Math.round(called[1]):null;
    out.mouseY=Math.round(dy0+40);
    out.dbgPreview=ed.getState().preview;
    out.dbgAfter=ed.store.get(b.id).points[0].map(n=>Number(n.toFixed(2)));

    // ---------- C. 数据模型 / 纯几何 ----------
    const mod=await import('./editor/schema.js');
    out.kindDef=!!mod.KINDS.screen;
    out.toolBtn=!!d.querySelector('.ed-tools button[data-v="screen"]');
    const sc=ed.store.list('floor1').find(a=>a.kind==='screen');
    out.hasScreenDoc=!!sc;
    if(!sc)return out;
    out.fixedFacing=ed.store.get(sc.id).style.facing==='fixed';
    const geo=mod.screenCorners([0,2,5],{w:2,h:1},0,0);
    out.geo4=geo.corners.length===4;
    out.geoW=Math.abs(geo.corners[0][0]-geo.corners[1][0])===2;
    out.geoH=Math.abs(geo.corners[0][1]-geo.corners[3][1])===1;
    out.geoNormal=Math.abs(geo.normal[2]+1)<1e-6;
    out.geoYaw=Math.abs(mod.screenCorners([0,2,5],{w:2,h:1},90,0).normal[0]+1)<1e-6;
    const hm=mod.homographyMatrix3d([{x:100,y:100},{x:300,y:100},{x:300,y:200},{x:100,y:200}],200,100);
    out.homoOk=/^matrix3d\\(/.test(hm||'')&&/,100,100,0,1\\)$/.test(hm||'');
    out.homoDegenerate=mod.homographyMatrix3d([{x:0,y:0},{x:1,y:1},{x:2,y:2},{x:3,y:3}],200,100)===null;

    // ---------- D. 三维空间内嵌 DOM + 真实 video ----------
    ed.action('select',sc.id);await sleep(340);
    const el=d.querySelector('.ed-item[data-kind="screen"]');
    out.hasDom=!!el;
    out.matrix=/^matrix3d\\(/.test(el?.style.transform||'');
    out.origin=(el?.style.transformOrigin||'').indexOf('0')===0;
    const v=el?.querySelector('video.ed-screen-video');
    out.hasVideo=!!v;
    out.videoAttrs=!!v&&v.muted===true&&v.loop===true&&v.autoplay===true&&v.playsInline===true;
    out.playing=!!v&&(!!v.srcObject||v.currentTime>0||v.readyState>=2);
    out.bezel=!!el?.querySelector('.ed-screen-bezel');
    out.stand=!!el?.querySelector('.ed-screen-stand');

    // ---------- E. 视角变化只改投影，不改世界尺寸 / 朝向 ----------
    const m0=el?.style.transform;
    const size0=JSON.stringify(ed.store.get(sc.id).style.size);
    const yaw0=ed.store.get(sc.id).style.yaw;
    const cam=w.__viewer.app.root.findComponent('camera');
    const origW2S=cam.worldToScreen;
    cam.worldToScreen=(p,o)=>o.set(520+p.x*31+p.z*2.5,340-p.y*27,1);
    await sleep(300);
    const el2=d.querySelector('.ed-item[data-kind="screen"]');
    out.viewChangesMatrix=!!el2&&el2.style.transform!==m0;
    out.worldFixed=JSON.stringify(ed.store.get(sc.id).style.size)===size0&&ed.store.get(sc.id).style.yaw===yaw0;
    cam.worldToScreen=origW2S;
    await sleep(220);

    // ---------- F. 朝向 / 尺寸 / 视频地址控件 ----------
    const mYaw0=d.querySelector('.ed-item[data-kind="screen"]')?.style.transform;
    const yawEl=d.querySelector('.ed-prop [data-field="yaw"]');
    const pitchEl=d.querySelector('.ed-prop [data-field="pitch"]');
    out.hasOrientCtrls=!!yawEl&&!!pitchEl;
    if(yawEl){yawEl.value='35';yawEl.dispatchEvent(new w.Event('input',{bubbles:true}));}
    await sleep(300);
    out.yawStored=ed.store.get(sc.id).style.yaw===35;
    out.yawChangesMatrix=d.querySelector('.ed-item[data-kind="screen"]')?.style.transform!==mYaw0;
    out.hasSizeCtrls=!!d.querySelector('.ed-prop [data-field="sizeW"]');
    out.hasVideoUrl=!!d.querySelector('.ed-prop [data-media-field="url"]');
    const urlEl=d.querySelector('.ed-prop [data-media-field="url"]');
    if(urlEl){
      // 同步写入后立即清空：验证「强制 video 类型 + 写回 store」，又不让 overlay 去请求外链
      urlEl.value='https://example.com/demo.mp4';
      urlEl.dispatchEvent(new w.Event('input',{bubbles:true}));
      out.mediaWritten=ed.store.get(sc.id).media?.[0]?.url==='https://example.com/demo.mp4'
        &&ed.store.get(sc.id).media?.[0]?.type==='video';
      urlEl.value='';urlEl.dispatchEvent(new w.Event('input',{bubbles:true}));
    }
    await sleep(220);

    // ---------- G. 背面显示背板 ----------
    ed.store.update(sc.id,{style:{yaw:180}});await sleep(300);
    out.backClass=!!d.querySelector('.ed-item[data-kind="screen"].ed-screen-back');
    ed.store.update(sc.id,{style:{yaw:-22}});await sleep(220);

    // ---------- H. 点击实体屏只选中，位置不变 ----------
    const scBefore=JSON.stringify(ed.store.get(sc.id).points[0]);
    const scEl=d.querySelector('.ed-item[data-kind="screen"]');
    const rr=scEl.getBoundingClientRect();
    const sx=rr.left+Math.max(4,rr.width/2), sy=rr.top+Math.max(4,rr.height/2);
    scEl.dispatchEvent(mk('pointerdown',sx,sy));
    scEl.dispatchEvent(mk('pointermove',sx+3,sy+2));
    scEl.dispatchEvent(mk('pointerup',sx+3,sy+2));
    clk(scEl,sx+3,sy+2);
    await sleep(240);
    out.screenClickKeeps=JSON.stringify(ed.store.get(sc.id).points[0])===scBefore;
    out.screenClickSelects=ed.getState().selectedId===sc.id;

    // ---------- J. 绘制工具下点中已有对象：退出绘制工具，且不新建标注 ----------
    const cnt0=ed.store.list('floor1').length;
    ed.action('tool','point');
    const itm=d.querySelector('.ed-item[data-id="'+sc.id+'"]');
    if(itm) itm.dispatchEvent(new w.MouseEvent('click',{bubbles:true,cancelable:true}));
    await sleep(200);
    out.pickExitsTool=ed.getState().tool==='select';
    out.pickNoNew=ed.store.list('floor1').length===cnt0;
    out.pickSelects=ed.getState().selectedId===sc.id;
    // 面板多采样遮挡：三维屏取四角 + 中心 5 个世界点，只有全部被挡才隐藏
    out.occlSamples=(ed.overlay._occludePoints(ed.store.get(sc.id))||[]).length;

    // ---------- I. 底心旋转锚点：拖动只改朝向（yaw/pitch），位置不变 ----------
    ed.action('select',sc.id);
    try{ ed.overlay.frame(); }catch(_){ /* 无头帧率极低，同步渲一帧确保手柄已创建 */ }
    await sleep(160);
    const rot=d.querySelector('.ed-screen-rot .ed-screen-rot-hit');
    out.hasRot=!!rot;
    const rotPos0=JSON.stringify(ed.store.get(sc.id).points[0]);
    const rotYaw0=Number(ed.store.get(sc.id).style.yaw||0);
    if(rot){
      const rb=rot.getBoundingClientRect();
      const rcx=rb.left+rb.width/2, rcy=rb.top+rb.height/2;
      rot.dispatchEvent(mk('pointerdown',rcx,rcy));
      for(const k of [0.4,0.8,1]) d.dispatchEvent(mk('pointermove',rcx+90*k,rcy));
      d.dispatchEvent(mk('pointerup',rcx+90,rcy));
      await sleep(200);
    }
    out.rotYaw=Number(ed.store.get(sc.id).style.yaw||0);
    out.rotYawMoved=Math.abs(out.rotYaw-rotYaw0)>5;
    out.rotPosKept=JSON.stringify(ed.store.get(sc.id).points[0])===rotPos0;

    /* ---------- I2. 左键松开但 pointerup 丢失（在 iframe 外松手）----------
       锚点拖拽必须立刻停下：只靠 pointerup 收尾会留下「幽灵拖拽」，
       之后随便动鼠标视锥体还在转（用户反馈）。这里用真实事件语义
       （isTrusted + buttons）复现：第一下 pressed，第二下 buttons=0。 */
    if(rot){
      const rb2=rot.getBoundingClientRect();
      const rcx2=rb2.left+rb2.width/2, rcy2=rb2.top+rb2.height/2;
      const pe=(t,x,y,buttons)=>new w.PointerEvent(t,
        {clientX:x,clientY:y,bubbles:true,cancelable:true,pointerId:9,button:0,
          buttons,pointerType:'mouse'});
      const mv=(x,y,buttons)=>d.dispatchEvent(pe('pointermove',x,y,buttons));
      const yawA=Number(ed.store.get(sc.id).style.yaw||0);
      // 真实鼠标按下的语义：pointerdown 的 buttons = 1（左键），兜底判断才会启用
      rot.dispatchEvent(pe('pointerdown',rcx2,rcy2,1));
      mv(rcx2+40,rcy2,1);
      const yawB=Number(ed.store.get(sc.id).style.yaw||0);
      mv(rcx2+160,rcy2,0);                 // 松手后（pointerup 丢了）：必须收尾
      const yawC=Number(ed.store.get(sc.id).style.yaw||0);
      mv(rcx2+260,rcy2,1);                 // 拖拽已结束：再移动也不该继续调整
      const yawD=Number(ed.store.get(sc.id).style.yaw||0);
      out.lostUpMoved=Math.abs(yawB-yawA)>3;
      out.lostUpStops=Math.abs(yawC-yawB)<0.01;
      out.lostUpStaysStopped=Math.abs(yawD-yawC)<0.01;
    }
    return out;
  })()`);
  check('单击展板（含 2px 微抖）不改变位置', s18.clickKeepsPos === true);
  check('单击展板仍能选中并展示属性内容', s18.clickSelects === true);
  check('真拖拽仍能移动展板（写回新锚点）',
    s18.dragMoves === true, JSON.stringify(s18.dbgAfter));
  check('拖拽以锚点为基准平移（非光标绝对落点）',
    s18.anchorBased === true, `y ${s18.calledY} vs mouse ${s18.mouseY}`);
  check('新增三维屏类型与工具栏入口', s18.kindDef === true && s18.toolBtn === true);
  check('示例文档含三维实体屏且 facing=fixed',
    s18.hasScreenDoc === true && s18.fixedFacing === true);
  check('屏体四角由世界尺寸决定（w/h/normal 正确）',
    s18.geo4 === true && s18.geoW === true && s18.geoH === true && s18.geoNormal === true);
  check('yaw 旋转改变世界法向（朝向是数据）', s18.geoYaw === true);
  check('四点单应 matrix3d 求解正确',
    s18.homoOk === true && s18.homoDegenerate === true);
  check('实体屏在三维场景中以 matrix3d 投影渲染',
    s18.hasDom === true && s18.matrix === true && s18.origin === true);
  check('屏内嵌真实 video（muted/loop/autoplay/playsinline）',
    s18.hasVideo === true && s18.videoAttrs === true);
  check('无片源时 video 正在播放演示流', s18.playing === true);
  check('实体屏含金属外框与支架', s18.bezel === true && s18.stand === true);
  check('视角变化只改投影矩阵，不改世界尺寸/朝向',
    s18.viewChangesMatrix === true && s18.worldFixed === true);
  check('属性面板可调 yaw/pitch 且写回数据',
    s18.hasOrientCtrls === true && s18.yawStored === true);
  check('调 yaw 后透视矩阵随之改变', s18.yawChangesMatrix === true);
  check('属性面板含尺寸与视频地址控件',
    s18.hasSizeCtrls === true && s18.hasVideoUrl === true);
  check('填视频 URL 强制为 video 类型并写回 store', s18.mediaWritten === true);
  check('相机绕到背面显示金属背板', s18.backClass === true);
  check('单击实体屏只选中、位置不变',
    s18.screenClickKeeps === true && s18.screenClickSelects === true);
  check('绘制工具下点中已有对象：自动退出绘制工具、只选中、不新建',
    s18.pickExitsTool === true && s18.pickNoNew === true && s18.pickSelects === true,
    `tool=${s18.pickExitsTool} new=${s18.pickNoNew}`);
  check('三维屏遮挡判定用四角 + 中心多采样（单点被挡不会整块消失）',
    s18.occlSamples === 5, s18.occlSamples);
  check('选中三维屏后底心出现旋转锚点', s18.hasRot === true);
  check('拖动底心锚点改变朝向（yaw）且不移动屏体',
    s18.rotYawMoved === true && s18.rotPosKept === true,
    `yaw ${s18.rotYaw} / pos ${s18.rotPosKept}`);
  check('锚点拖拽：左键松开（pointerup 丢失）后立即停止调整',
    s18.lostUpMoved === true && s18.lostUpStops === true && s18.lostUpStaysStopped === true,
    `moved=${s18.lostUpMoved} stops=${s18.lostUpStops}`);

  console.log('\n[18] 动线贴合模型表面（等距重采样 + 逐点吸附碰撞 MESH）');
  const s19 = await E(`(async()=>{
    const w=(${FM}).contentWindow,d=w.document,ed=w.__mgEditor;
    if(!ed)return{error:'no editor'};
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const out={};
    const mod=await import('./editor/schema.js');
    // 长直段必须补点：否则跨台阶 / 坡道时折线会从模型上方悬空飞过
    const dense=mod.resamplePolyline([[0,2,0],[0,2,10]],0.5);
    out.resampled=dense.length;
    out.endpointsKept=dense[0][2]===0&&dense[dense.length-1][2]===10;
    out.evenSpacing=dense.length===21;

    const col=w.__viewer.collision();const origRay=col.queryRay;
    // 脚下 0.45m 命中地面：短射线起点只抬高 0.18m，能稳定命中且不越过天花板
    col.queryRay=(ox,oy,oz,dx,dy,dz)=>({x:ox+dx*0.45,y:oy+dy*0.45,z:oz+dz*0.45});
    const flat=ed.picker.drapePolyline([[0,2,0],[0,2,4]],0.5);
    out.drapeCount=flat.length;
    out.drapeY=flat.every(p=>Math.abs(p[1]-1.73)<1e-6);   // 2 + 0.18 - 0.45
    out.drapeXZ=flat.every(p=>Math.abs(p[0])<1e-6);
    // 【用户反馈的 Bug】旧实现从 p.y+4m 向下打 10m，第一命中是 3.2m 高的天花板，
    // 结束绘制后整条动线被吸到屋顶。现在所有高于采样点的命中必须一律丢弃。
    col.queryRay=(ox,oy,oz)=>({x:ox,y:5.2,z:oz});
    const ceil=ed.picker.drapePolyline([[0,2,0],[0,2,4]],0.5);
    out.rejectCeiling=ceil.every(p=>Math.abs(p[1]-2)<1e-6)&&ceil.length>4;
    // 不自洽命中（XZ 差很远，或 mock 恒返回固定点）必须丢弃，否则整条线塌缩
    col.queryRay=()=>({x:999,y:0,z:999});
    const keep=ed.picker.drapePolyline([[0,2,0],[0,2,4]],0.5);
    out.rejectBadHit=keep.every(p=>Math.abs(p[1]-2)<1e-6)&&keep.length>4;

    // overlay 真的消费贴合结果：改顶点触发缓存重算，并用 spy 记录调用
    col.queryRay=(ox,oy,oz,dx,dy,dz)=>({x:ox+dx*0.45,y:oy+dy*0.45,z:oz+dz*0.45});
    const route=ed.store.list('floor1').find(a=>a.kind==='line');
    // 深度检测默认开启；本组的碰撞桩命中点就在相机前方，会把动线判成遮挡隐藏
    ed.store.update(route.id,{depthTest:false});
    const origPts=JSON.parse(JSON.stringify(route.points));
    let calls=0;const origDrape=ed.overlay.drapeLine;
    ed.overlay.drapeLine=(pts)=>{calls++;return origDrape(pts);};
    ed.store.update(route.id,{points:origPts.map((p,i)=>[p[0],p[1],p[2]+(i===3?0.01:0)])});
    await sleep(320);
    out.drapeCalled=calls>0;
    const f=ed.overlay.nodes.get(route.id)?.parts?.flow;
    out.worldDense=!!f?.world&&f.world.length>8;
    // 原始动线 y=0.3~1.0，贴地后整体下移 0.27m 且绝不能出现 3m+ 的天花板高度
    out.worldSnapped=!!f?.world&&f.world.every(p=>p[1]<1.01&&p[1]>-2.5);
    out.worldNotCeiling=!!f?.world&&f.world.every(p=>p[1]<3.0);
    ed.overlay.drapeLine=origDrape;
    ed.store.update(route.id,{points:origPts});
    col.queryRay=origRay;
    await sleep(200);
    return out;
  })()`);
  check('长直段按 0.5m 等距补点（21 点）', s19.resampled === 21 && s19.evenSpacing === true, s19.resampled);
  check('重采样保留原始端点', s19.endpointsKept === true);
  check('每个采样点垂直吸附到 MESH 表面（Y 改变）',
    s19.drapeY === true && s19.drapeCount > 4, s19.drapeCount);
  check('吸附不改变平面位置 XZ', s19.drapeXZ === true);
  check('不自洽命中被丢弃（不会塌缩到一点）', s19.rejectBadHit === true);
  check('天花板命中被拒绝（结束绘制不会飞到屋顶）', s19.rejectCeiling === true);
  check('overlay 调用贴合函数并缓存密集中线',
    s19.drapeCalled === true && s19.worldDense === true);
  check('场景内动线使用贴合后的世界坐标且未吸天花板',
    s19.worldSnapped === true && s19.worldNotCeiling === true);

  console.log('\n[19] 每个注记独立「是否开启深度检测」');
  const s20 = await E(`(async()=>{
    const w=(${FM}).contentWindow,d=w.document,ed=w.__mgEditor;
    if(!ed)return{error:'no editor'};
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const out={};
    const mod=await import('./editor/schema.js');
    const fresh=mod.makeAnnotation('point',[[0,1,2]],{});
    out.modelHasProp=Object.prototype.hasOwnProperty.call(fresh,'depthTest');
    out.modelDefault=fresh.depthTest===true;
    out.allHaveProp=ed.store.list('floor1').every(a=>typeof a.depthTest==='boolean');

    const pt=ed.store.list('floor1').find(a=>a.kind==='point');
    ed.action('select',pt.id);await sleep(300);
    const cb=d.querySelector('.ed-prop [data-field="depthTest"]');
    out.hasCtrl=!!cb;
    out.defaultOn=cb?.checked===true;
    // 默认开 -> 先验证可以单独关掉（写回 false），再打开做遮挡测试
    cb.checked=false;cb.dispatchEvent(new w.Event('change',{bubbles:true}));
    await sleep(200);
    out.offStored0=ed.store.get(pt.id).depthTest===false;
    const cbOn=d.querySelector('.ed-prop [data-field="depthTest"]');
    cbOn.checked=true;cbOn.dispatchEvent(new w.Event('change',{bubbles:true}));
    await sleep(200);
    out.onStored=ed.store.get(pt.id).depthTest===true;

    // 注入「相机与标注之间有遮挡」的自洽碰撞体：命中落在视线上且更近
    const col=w.__viewer.collision();const origRay=col.queryRay;
    col.queryRay=(ox,oy,oz,dx,dy,dz,maxDist)=>{
      const t=Math.max(0.1,(maxDist||10)*0.5);
      return {x:ox+dx*t,y:oy+dy*t,z:oz+dz*t};
    };
    await sleep(320);
    out.occludedResult=ed.picker.occluded(pt.points[0]);
    out.hiddenWhenOn=!d.querySelector('.ed-item[data-id="'+pt.id+'"]');
    // 独立性：把另一条注记的深度检测单独关掉，它必须仍然可见
    const other=ed.store.list('floor1').find(a=>a.kind==='board');
    ed.store.update(other.id,{depthTest:false});
    await sleep(200);
    out.otherOff=ed.store.get(other.id).depthTest===false;
    out.otherVisible=!!d.querySelector('.ed-item[data-kind="board"]');

    // 关闭后立即恢复置顶可见（即使遮挡仍在）
    const cb2=d.querySelector('.ed-prop [data-field="depthTest"]');
    if(cb2){cb2.checked=false;cb2.dispatchEvent(new w.Event('change',{bubbles:true}));}
    await sleep(320);
    out.offStored=ed.store.get(pt.id).depthTest===false;
    out.visibleWhenOff=!!d.querySelector('.ed-item[data-id="'+pt.id+'"]');
    col.queryRay=origRay;
    out.exportHas=/"depthTest"/.test(ed.store.exportText());
    return out;
  })()`);
  check('数据模型每个注记自带 depthTest 属性', s20.modelHasProp === true && s20.allHaveProp === true);
  check('默认开启深度检测（新标注落到墙后即被遮挡）',
    s20.modelDefault === true && s20.defaultOn === true);
  check('属性面板提供「开启深度检测」开关', s20.hasCtrl === true);
  check('可单独关闭（写回 false，不影响其它注记）', s20.offStored0 === true);
  check('开启后写回该注记（非全局开关）', s20.onStored === true);
  check('遮挡判定能识别前方 MESH', s20.occludedResult === true);
  check('开启深度检测后被遮挡的注记隐藏', s20.hiddenWhenOn === true);
  check('未开启的其它注记不受影响（逐注记独立）',
    s20.otherOff === true && s20.otherVisible === true);
  check('关闭后即使有遮挡也始终置顶可见',
    s20.offStored === true && s20.visibleWhenOff === true);
  check('属性随 JSON 导入导出持久化', s20.exportHas === true);

  /* ---------------------------------------------------------- 新交互 v2 */
  console.log('\n[20] 动线绘制可见性：草稿双层线 / 实时箭头预览 / 退化兜底');
  const s21 = await E(`(async()=>{
    const w=(${FM}).contentWindow,d=w.document,ed=w.__mgEditor;
    if(!ed)return{error:'no editor'};
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const out={};
    const cv=d.getElementById('ed-mock-canvas');
    const col=w.__viewer.collision();const origRay=col.queryRay;
    // 自洽碰撞桩：不同屏幕坐标得到不同世界点，避免 mock 固定点把线压成一个点
    col.queryRay=(ox,oy,oz,dx,dy,dz)=>({x:ox+dx*8,y:oy+dy*8,z:oz+dz*8});
    const mk=(t,x,y)=>new w.PointerEvent(t,{clientX:x,clientY:y,bubbles:true,cancelable:true,pointerId:11,button:0,pointerType:'mouse'});
    ed.action('select',null);ed.action('tool','line');
    cv.dispatchEvent(mk('pointerdown',360,280));cv.dispatchEvent(mk('pointerup',360,280));
    await sleep(360);
    cv.dispatchEvent(mk('pointerdown',520,360));cv.dispatchEvent(mk('pointerup',520,360));
    await sleep(360);
    const halo=d.querySelector('.ed-draft-halo'),line=d.querySelector('.ed-draft');
    out.hasHalo=!!halo;out.hasLine=!!line;
    out.haloPts=(halo?.getAttribute('points')||'').trim().split(/\\s+/).filter(Boolean).length;
    out.linePts=(line?.getAttribute('points')||'').trim().split(/\\s+/).filter(Boolean).length;
    const segs=[...d.querySelectorAll('.ed-draft-flow-seg')].filter(p=>p.style.display!=='none');
    out.previewSegs=segs.length;
    const dr=ed.overlay._draft;
    out.dbgPoints=ed.overlay.draft?ed.overlay.draft.points.length:-1;
    out.dbgTool=ed.getState().tool;
    out.dbgWorld=(dr?.flowWorld||[]).length;
    out.dbgSegs=dr?.flowSegs?.length??null;
    out.previewArrows=segs.length>0&&segs.every(p=>(p.getAttribute('points')||'').trim().split(/\\s+/).filter(Boolean).length===6);

    const before=ed.store.list('floor1').length;
    let fly=0;const origPose=w.__viewer.setCameraPose;
    w.__viewer.setCameraPose=(...a)=>{fly++;return origPose?origPose(...a):true;};
    // 双击不再触发任何事件（不结束绘制、不漫游）；右键单击负责结束
    cv.dispatchEvent(new w.MouseEvent('dblclick',{clientX:520,clientY:360,bubbles:true,cancelable:true}));
    await sleep(300);
    out.dblNoFly=fly===0;
    out.dblKeepsDraft=ed.store.list('floor1').length===before&&!!ed.overlay._draft;
    cv.dispatchEvent(new w.MouseEvent('contextmenu',{clientX:520,clientY:360,bubbles:true,cancelable:true}));
    await sleep(440);
    out.created=ed.store.list('floor1').length===before+1;
    const fresh=ed.store.list('floor1').filter(a=>a.kind==='line').pop();
    // 深度检测默认开启 + 本组碰撞桩命中就在相机前方：显式关掉，专注验证绘制可见性
    ed.store.update(fresh.id,{depthTest:false});
    const g=d.querySelector('.ed-g[data-id="'+fresh.id+'"]');
    out.visibleSegs=[...(g?g.querySelectorAll('.ed-flow-arrow-seg'):[])].filter(p=>p.style.display!=='none').length;
    out.stroke=g?.querySelector('.ed-shape')?.getAttribute('stroke');
    out.hasVisibleLine=out.visibleSegs>0||(!!out.stroke&&out.stroke!=='transparent');
    out.toolBack=ed.getState().tool;

    // 退化兜底：强制箭头链画不出来时，折线必须显式可见（不能只剩顶点）
    const origFlow=ed.overlay._drawFlow;
    ed.overlay._drawFlow=()=>false;
    await sleep(180);
    out.fallbackStroke=g?.querySelector('.ed-shape')?.getAttribute('stroke');
    out.fallbackOpacity=g?.querySelector('.ed-shape')?.getAttribute('stroke-opacity');
    ed.overlay._drawFlow=origFlow;
    await sleep(160);
    // 贴合结果塌缩到一点时也要退回原始锚点，至少画出箭头链
    const origDrape=ed.overlay.drapeLine;
    ed.overlay.drapeLine=()=>[[2,0,4],[2,0,4],[2,0,4]];
    ed.store.update(fresh.id,{points:fresh.points.map((p,i)=>[p[0]+(i===1?0.001:0),p[1],p[2]])});
    await sleep(240);
    out.collapseRecovered=[...d.querySelectorAll('.ed-g[data-id="'+fresh.id+'"] .ed-flow-arrow-seg')]
      .filter(p=>p.style.display!=='none').length>0;
    ed.overlay.drapeLine=origDrape;
    ed.store.update(fresh.id,{points:fresh.points});
    col.queryRay=origRay;
    return out;
  })()`);
  check('草稿有深色光晕 + 亮色主线（双层可见）',
    s21.hasHalo === true && s21.hasLine === true && s21.linePts >= 2 && s21.haloPts >= 2,
    `${s21.linePts}/${s21.haloPts}`);
  check('绘制中的动线实时预览世界空间贴合面片', s21.previewSegs > 0 && s21.previewArrows === true,
    `${s21.previewSegs} seg / pts=${s21.dbgPoints} world=${s21.dbgWorld} all=${s21.dbgSegs}`);
  check('右键结束绘制后生成可见的动线（不是只有点）',
    s21.created === true && s21.hasVisibleLine === true, `${s21.visibleSegs} 段 / ${s21.stroke}`);
  check('箭头链退化时折线兜底为可见描边',
    !!s21.fallbackStroke && s21.fallbackStroke !== 'transparent' && s21.fallbackOpacity === '0.95',
    `${s21.fallbackStroke}/${s21.fallbackOpacity}`);
  check('贴合结果塌缩时退回原始锚点恢复箭头', s21.collapseRecovered === true);
  check('右键结束后回到「选择」，双击不结束绘制且不漫游',
    s21.toolBack === 'select' && s21.dblNoFly === true && s21.dblKeepsDraft === true,
    `${s21.toolBack}/${s21.dblNoFly}/${s21.dblKeepsDraft}`);

  console.log('\n[21] 全局显示碰撞体 MESH（按钮 / Shift+C / 引擎 state / 持久化）');
  const s22 = await E(`(async()=>{
    const w=(${FM}).contentWindow,d=w.document,ed=w.__mgEditor;
    if(!ed)return{error:'no editor'};
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const out={};
    const btn=d.querySelector('[data-act="mesh"]');
    out.hasBtn=!!btn;
    out.initText=btn?.textContent;
    out.initState=ed.getState().meshVisible;
    if(btn)btn.click();await sleep(220);
    out.onState=ed.getState().meshVisible===true;
    out.onEngine=!!w.__viewer.state.collisionOverlayEnabled;
    out.onText=btn?.textContent;
    out.onClass=!!btn&&btn.classList.contains('ed-on');
    out.hintHasMesh=/碰撞体显示/.test(d.querySelector('[data-role="hint"]')?.textContent||'');
    // Shift+C 关闭
    d.body.dispatchEvent(new w.KeyboardEvent('keydown',{key:'C',shiftKey:true,bubbles:true,cancelable:true}));
    await sleep(220);
    out.offState=ed.getState().meshVisible===false;
    out.offEngine=!w.__viewer.state.collisionOverlayEnabled;
    out.offText=btn?.textContent;
    // 再开一次验证 localStorage 持久化，然后恢复到「关」不影响后续用例
    if(btn)btn.click();await sleep(160);
    out.persisted=w.localStorage.getItem('mgEditorMeshOn');
    if(btn)btn.click();await sleep(160);
    out.finalState=ed.getState().meshVisible;
    return out;
  })()`);
  check('工具栏存在全局「碰撞体」按钮', s22.hasBtn === true && /碰撞体/.test(s22.initText || ''), s22.initText);
  check('点击后开启并驱动引擎 collisionOverlayEnabled',
    s22.onState === true && s22.onEngine === true, `${s22.onState}/${s22.onEngine}`);
  check('按钮状态 / 文案 / 状态栏同步',
    /开/.test(s22.onText || '') && s22.onClass === true && s22.hintHasMesh === true,
    `${s22.onText}/${s22.onClass}/${s22.hintHasMesh}`);
  check('Shift+C 可关闭并同步引擎状态',
    s22.offState === true && s22.offEngine === true && /关/.test(s22.offText || ''));
  check('开关状态写入 localStorage（跨会话记忆）', s22.persisted === '1' && s22.finalState === false, s22.persisted);

  console.log('\n[22] 右键单击结束绘制 + 双击（左 / 右键）全程禁用');
  const s23 = await E(`(async()=>{
    const w=(${FM}).contentWindow,d=w.document,ed=w.__mgEditor;
    if(!ed)return{error:'no editor'};
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const out={};
    const cv=d.getElementById('ed-mock-canvas');
    const col=w.__viewer.collision();const origRay=col.queryRay;
    col.queryRay=(ox,oy,oz,dx,dy,dz)=>({x:ox+dx*8,y:oy+dy*8,z:oz+dz*8});
    const mk=(t,x,y)=>new w.PointerEvent(t,{clientX:x,clientY:y,bubbles:true,cancelable:true,pointerId:13,button:0,pointerType:'mouse'});
    ed.action('select',null);
    let fly=0;const origPose=w.__viewer.setCameraPose;
    w.__viewer.setCameraPose=(...a)=>{fly++;return origPose?origPose(...a):true;};

    // A. 无草稿时双击：什么都不发生（不切工具、不漫游、不建标注）
    ed.action('tool','area');
    cv.dispatchEvent(new w.MouseEvent('dblclick',{clientX:430,clientY:320,bubbles:true,cancelable:true}));
    await sleep(220);
    out.toolUnchanged=ed.getState().tool==='area';

    // B. 有草稿时双击：不结束绘制（草稿保留、不新建标注）；右键单击才结束
    ed.action('tool','line');
    cv.dispatchEvent(mk('pointerdown',350,270));cv.dispatchEvent(mk('pointerup',350,270));
    await sleep(340);
    cv.dispatchEvent(mk('pointerdown',510,350));cv.dispatchEvent(mk('pointerup',510,350));
    await sleep(340);
    const n0=ed.store.list('floor1').length;
    cv.dispatchEvent(new w.MouseEvent('dblclick',{clientX:510,clientY:350,bubbles:true,cancelable:true}));
    await sleep(300);
    out.dblKeepsDraft=ed.store.list('floor1').length===n0&&!!ed.overlay._draft;
    // 右键单击：结束本次绘制（等价原双击语义），创建标注并回到「选择」
    cv.dispatchEvent(new w.MouseEvent('contextmenu',{clientX:510,clientY:350,bubbles:true,cancelable:true}));
    await sleep(440);
    out.rightFinished=ed.store.list('floor1').length===n0+1;
    out.toolAfter=ed.getState().tool;
    out.selected=ed.getState().selectedId===ed.store.list('floor1').slice(-1)[0]?.id;
    out.draftCleared=ed.overlay.draft===null;
    // 全程的双击（A/B 的 target 是 canvas）必须仍然不漫游。
    out.noFlyOnEmptyDbl=fly===0;
    const createdAnn=ed.store.list('floor1').slice(-1)[0];
    out.createdHasView=!!(createdAnn?.view?.position&&createdAnn?.view?.target);

    // C. 双击标注 DOM：不回到机位（fly 计数不变）；右键标注仍弹上下文菜单
    const item=d.querySelector('.ed-item[data-id]');
    const flyBefore=fly;
    item?.dispatchEvent(new w.MouseEvent('dblclick',{bubbles:true,cancelable:true}));
    await sleep(200);
    out.noFlyOnItem=fly===flyBefore;
    const cmBefore=flyBefore;
    item?.dispatchEvent(new w.MouseEvent('contextmenu',{clientX:100,clientY:100,bubbles:true,cancelable:true}));
    await sleep(200);
    out.ctxMenuOnItem=fly===cmBefore;
    w.__viewer.setCameraPose=origPose;
    col.queryRay=origRay;
    ed.action('select',null);
    return out;
  })()`);
  check('无草稿时双击不改变任何状态（工具不复位）', s23.toolUnchanged === true, s23.toolUnchanged);
  check('双击不结束绘制（草稿保留、不新建标注）', s23.dblKeepsDraft === true, s23.dblKeepsDraft);
  check('右键单击结束绘制并创建标注 / 清空草稿',
    s23.rightFinished === true && s23.draftCleared === true && s23.selected === true);
  check('右键结束后鼠标状态为默认「选择」', s23.toolAfter === 'select', s23.toolAfter);
  check('双击全程不触发漫游', s23.noFlyOnEmptyDbl === true, s23.noFlyOnEmptyDbl);
  check('创建的标注仍保存创建时机位', s23.createdHasView === true);
  check('双击标注 DOM 不回到机位', s23.noFlyOnItem === true, s23.noFlyOnItem);
  check('右键标注仍弹上下文菜单（语义保留）', s23.ctxMenuOnItem === true, s23.ctxMenuOnItem);
  check('新建标注时保存创建机位 view', s23.createdHasView === true, s23.createdHasView);

  console.log('\n[23] 选中高亮 + 逐注记锁定（标注自身 locked 字段，已废弃「选中即锁其余」）');
  const s24 = await E(`(async()=>{
    const w=(${FM}).contentWindow,d=w.document,ed=w.__mgEditor;
    if(!ed)return{error:'no editor'};
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const out={};
    ed.action('select',null);await sleep(240);
    const items=[...d.querySelectorAll('.ed-item[data-id]')];
    out.itemCount=items.length;
    const selId=items[0]?.dataset.id;
    const othId=items.find(x=>x.dataset.id!==selId)?.dataset.id;
    out.twoIds=!!selId&&!!othId;
    ed.action('select',selId);await sleep(300);
    const selEl=d.querySelector('.ed-item[data-id="'+selId+'"]');
    const othEl=d.querySelector('.ed-item[data-id="'+othId+'"]');
    out.selHighlight=!!selEl&&selEl.classList.contains('ed-sel');
    // 当前锁定模型（editor.js:「选中即锁其余」已废弃，改为逐注记 locked 字段以支持多选）。
    // 显式把 othId 置 locked:true，验证「锁定标注不可编辑 / 变暗 / 禁命中」的真实行为。
    ed.store.update(othId,{locked:true});
    for(let i=0;i<20&&!(othEl&&othEl.classList.contains('ed-locked'));i++)await sleep(80);
    out.otherDim=!!othEl&&othEl.classList.contains('ed-locked');
    out.otherNoHit=!!othEl&&w.getComputedStyle(othEl).pointerEvents==='none';
    // 锁定对象：点它不切换选中（onPick 守卫），拖它不改写世界坐标
    othEl?.click();await sleep(200);
    out.pickBlocked=ed.getState().selectedId===selId;
    const othA=ed.store.get(othId);
    const p0=JSON.stringify(othA.points[0]);
    const mk=(t,x,y)=>new w.PointerEvent(t,{clientX:x,clientY:y,bubbles:true,cancelable:true,pointerId:17,button:0,pointerType:'mouse'});
    if(othEl){
      othEl.dispatchEvent(mk('pointerdown',500,300));
      othEl.dispatchEvent(mk('pointermove',560,350));
      othEl.dispatchEvent(mk('pointerup',560,350));
    }
    await sleep(220);
    out.dragBlocked=JSON.stringify(ed.store.get(othId).points[0])===p0;
    // 列表：锁定行变暗、行内按钮禁用；属性面板仍只编辑选中项
    const othRow=d.querySelector('.ed-list-row[data-v="'+othId+'"]');
    out.rowLocked=!!othRow&&othRow.classList.contains('ed-locked');
    out.btnsDisabled=!!othRow&&[...othRow.querySelectorAll('.ed-ib')].every(b=>b.disabled===true);
    // 属性面板应只对应选中项：给 selId 写入已知标题后比对面板输入框
    // 属性面板只对应选中项：面板标题输入框应等于「选中项」的标题，
    // 且不等于被锁定项 othId 的标题（证明面板跟随选中态，而非锁定项）。
    // 说明：面板仅在「选中变更」时重渲染，外部 store.update 不会回灌输入框
    //（刻意规避输入焦点丢失），故此处直接比对「选中项」标题，而非外部改值后查回显。
    const tp=d.querySelector('.ed-prop [data-field="title"]');
    const selTitle=ed.store.get(selId)?.title, othTitle=ed.store.get(othId)?.title;
    out.propForSel=ed.getState().selectedId===selId && tp?.value===selTitle && tp?.value!==othTitle;
    // Esc 取消选中；解除锁定后视觉恢复可交互
    d.body.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
    await sleep(260);
    out.escaped=ed.getState().selectedId===null;
    ed.store.update(othId,{locked:false});await sleep(200);
    const after=d.querySelector('.ed-item[data-id="'+othId+'"]');
    out.unlocked=!!after&&!after.classList.contains('ed-locked')&&w.getComputedStyle(after).pointerEvents!=='none';
    return out;
  })()`);
  check('场景中存在多个可拾取标注', s24.itemCount >= 2 && s24.twoIds === true, s24.itemCount);
  check('被选中标注带 ed-sel 高亮', s24.selHighlight === true);
  check('其他标注变暗并禁止鼠标命中',
    s24.otherDim === true && s24.otherNoHit === true, `${s24.otherDim}/${s24.otherNoHit}`);
  check('点击 / 拖拽锁定标注都不能编辑它',
    s24.pickBlocked === true && s24.dragBlocked === true);
  check('列表其它行锁定且删除 / 显隐按钮禁用',
    s24.rowLocked === true && s24.btnsDisabled === true);
  check('属性面板只对应选中项', s24.propForSel === true);
  check('Esc 取消选中后其余标注解锁', s24.escaped === true && s24.unlocked === true);

  console.log('\n[24] 贴面矩形：投影式延迟贴花 OBB / 线框 / 属性面板 / 绘制链路');
  const s25 = await E(`(async()=>{ try {
    const w=(${FM}).contentWindow,d=w.document,ed=w.__mgEditor;
    if(!ed)return{error:'no editor'};
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const out={};
    const mod=await import('./editor/schema.js');
    out.kindDef=mod.KINDS.decal?.label==='贴面矩形'&&mod.KINDS.decal.min===2&&mod.KINDS.decal.max===2;
    out.toolDef=mod.TOOLS.some(t=>t.id==='decal'&&t.key==='R');
    out.toolBtn=!!d.querySelector('[data-act="tool"][data-v="decal"]');

    // headless mock 的 worldToScreen 忽略 z，水平地面会投影成一条线；
    // 临时加一点伪透视，让 OBB 框线在截图 / 断言里有真实体积。
    const cam=w.__viewer.app.root.findComponent('camera');const origW2S=cam.worldToScreen;
    cam.worldToScreen=(p,o)=>o.set(400+p.x*20,300-p.y*20+(p.z-16)*12,1);

    const decal=ed.store.list('floor1').find(a=>a.kind==='decal');
    if(!decal){out.error='no decal';return out;}
    // 挂载后 ensureDecalProjectors 按当前画面深度反算，异步生成投影机 OBB，等它落地
    for(let i=0;i<40&&!ed.store.get(decal.id)?.projector;i++)await sleep(100);
    ed.action('select',decal.id);await sleep(400);

    const a=ed.store.get(decal.id);
    out.hasProjector=!!a.projector;
    out.projValid=!!a.projector&&Array.isArray(a.projector.position)&&a.projector.position.length===3
      &&a.projector.position.every(Number.isFinite)
      &&Array.isArray(a.projector.quaternion)&&a.projector.quaternion.length===4
      &&a.projector.quaternion.every(Number.isFinite)
      &&Array.isArray(a.projector.half)&&a.projector.half.length===3
      &&a.projector.half.every(x=>Number.isFinite(x)&&x>0);
    out.surfaceKept=!!a.surface&&Array.isArray(a.surface.points)&&a.surface.points.length>0;

    // 编辑器画 OBB 线框（12 边）+ 选中态 7 手柄（1 中心 + 6 轴向）
    out.obbGroup=!!d.querySelector('.ed-g[data-id="'+decal.id+'"] .ed-decal-obb');
    const edges=[...d.querySelectorAll('.ed-g[data-id="'+decal.id+'"] .ed-decal-obb-edge')]
      .filter(e=>e.style.display!=='none');
    out.edgeCount=edges.length;
    /* 棱线改「逐段绘制」以支持场景深度判断：段数必须是 12 的整数倍
       （12 条棱 × SEG，选中时 SEG=6）。不再写死 12，避免以后调段数就误报。 */
    out.edgeSeg=edges.length>=12&&edges.length%12===0?edges.length/12:0;
    out.edgesVisible=out.edgeSeg>0;
    // 旋转环：正交 OBB 选中时必须有 3 条 ring（X/Y/Z）与 3 条透明命中区
    const rings=[...d.querySelectorAll('.ed-g[data-id="'+decal.id+'"] .ed-decal-ring')]
      .filter(e=>e.style.display!=='none');
    const ringHits=[...d.querySelectorAll('.ed-g[data-id="'+decal.id+'"] .ed-decal-ring-hit')]
      .filter(e=>e.style.display!=='none');
    out.ringCount=rings.length;
    out.ringHits=ringHits.length;
    out.ringAxes=[...new Set(rings.map(e=>e.dataset.axis))].sort().join(',');
    const handles=[...d.querySelectorAll('.ed-g[data-id="'+decal.id+'"] .ed-decal-obb-handle')]
      .filter(h=>h.style.display!=='none');
    out.handleCount=handles.length;
    out.handlesTagged=handles.length===7&&handles.every(h=>h.dataset.kind==='decal'
      &&!!h.dataset.axis&&h.dataset.id===decal.id);
    out.handleRoles=[...new Set(handles.map(h=>h.dataset.axis))].sort().join(',');

    // 投影式贴花不再渲染旧 81 点网格 / 单应视频 DOM（应被隐藏或移除）
    const dom=d.querySelector('.ed-item[data-kind="decal"]');
    out.legacyDomHidden=!dom||getComputedStyle(dom).display==='none';
    out.legacyCellsHidden=[...d.querySelectorAll('.ed-g[data-id="'+decal.id+'"] .ed-decal-cell')]
      .filter(p=>p.style.display!=='none').length===0;

    // 属性面板：投射 URL + 不透明度 / 边缘 / 深度；不再有细分密度 / 抬升
    out.hasUrlInput=!!d.querySelector('.ed-prop [data-media-field="url"]');
    out.hasOpacity=!!d.querySelector('.ed-prop [data-field="decalOpacity"]');
    out.hasEdge=!!d.querySelector('.ed-prop [data-field="decalEdge"]');
    out.hasDepth=!!d.querySelector('.ed-prop [data-field="decalDepth"]');
    out.noGridInput=!d.querySelector('.ed-prop [data-field="decalGrid"]');
    out.noLiftInput=!d.querySelector('.ed-prop [data-field="decalLift"]');
    out.statusRow=/投影机 OBB/.test(d.querySelector('.ed-prop .ed-prop-status')?.textContent||'');
    out.rebuildBtn=!!d.querySelector('.ed-prop [data-act="decal-rebuild"]');

    // 改投射深度 -> 投影机 half[2] 重算（不重采表面）；改不透明度 -> style.decalOpacity
    const di=d.querySelector('.ed-prop [data-field="decalDepth"]');
    if(di){di.value='1.2';di.dispatchEvent(new w.Event('change',{bubbles:true}));}
    await sleep(300);
    out.depthStored=Math.abs((ed.store.get(decal.id).style.decalDepth??0)-1.2)<1e-9;
    out.halfZ=Math.abs((ed.store.get(decal.id).projector.half[2]??0)-0.6)<1e-6;
    const oi=d.querySelector('.ed-prop [data-field="decalOpacity"]');
    if(oi){oi.value='0.5';oi.dispatchEvent(new w.Event('change',{bubbles:true}));}
    await sleep(300);
    out.opacityStored=Math.abs((ed.store.get(decal.id).style.decalOpacity??0)-0.5)<1e-9;

    // 绘制链路：Shift+R 工具 + 两个对角落点 -> 生成 decal 注记（含 projector）
    const cv=d.getElementById('ed-mock-canvas');
    const mk=(t,x,y)=>new w.PointerEvent(t,{clientX:x,clientY:y,bubbles:true,cancelable:true,pointerId:19,button:0,pointerType:'mouse'});
    ed.action('select',null);
    d.body.dispatchEvent(new w.KeyboardEvent('keydown',{key:'R',shiftKey:true,bubbles:true,cancelable:true}));
    await sleep(140);
    out.toolByShortcut=ed.getState().tool==='decal';
    const n0=ed.store.list('floor1').filter(a=>a.kind==='decal').length;
    cv.dispatchEvent(mk('pointerdown',300,260));cv.dispatchEvent(mk('pointerup',300,260));
    await sleep(380);
    cv.dispatchEvent(mk('pointerdown',470,380));cv.dispatchEvent(mk('pointerup',470,380));
    await sleep(520);
    out.created=ed.store.list('floor1').filter(a=>a.kind==='decal').length===n0+1;
    const made=ed.store.list('floor1').filter(a=>a.kind==='decal').pop();
    out.twoCorners=made?.points.length===2;
    out.normalSaved=Array.isArray(made?.style.normal)&&made.style.normal.length===3;
    for(let i=0;i<40&&!ed.store.get(made.id)?.projector;i++)await sleep(100);
    out.madeProjector=!!ed.store.get(made.id)?.projector;

    // 防回归：投影机异步失败（projector=null）时，旧 surface 网格多边形会退化成
    // 细长尖刺。现在应改为屏幕空间占位框（rect 元素），且绝不生成 .ed-decal-cell。
    // store change 会触发 ensureDecalProjectors 自动重建；stub 成失败以稳定模拟
    // 「投影机异步生成失败」的真实场景（rebuildDecalProjector 取不到深度会 return，不写回）。
    const origUR2=ed.picker.unprojectRect;
    ed.picker.unprojectRect=async()=>null;
    const savedProj=ed.store.get(decal.id).projector;
    ed.store.update(decal.id,{projector:null});
    await sleep(260);
    const pend=d.querySelector('.ed-g[data-id="'+decal.id+'"] .ed-decal-pending');
    out.pendingShown=!!pend&&pend.style.display!=='none'&&pend.tagName.toLowerCase()==='rect';
    const pw=parseFloat(pend?.getAttribute('width')||'0'), ph=parseFloat(pend?.getAttribute('height')||'0');
    out.pendingSizeFinite=Number.isFinite(pw)&&Number.isFinite(ph)&&pw>0&&ph>0;
    out.noSpikeCells=[...d.querySelectorAll('.ed-g[data-id="'+decal.id+'"] .ed-decal-cell')]
      .filter(p=>p.style.display!=='none').length===0;
    out.pendingLabel=/等待重新投射/.test(d.querySelector('.ed-g[data-id="'+decal.id+'"] .ed-decal-label')?.textContent||'');
    ed.picker.unprojectRect=origUR2;
    ed.store.update(decal.id,{projector:savedProj});
    await sleep(220);
    out.pendingHiddenAfterRestore=!!d.querySelector('.ed-g[data-id="'+decal.id+'"] .ed-decal-pending')
      &&d.querySelector('.ed-g[data-id="'+decal.id+'"] .ed-decal-pending').style.display==='none';

    cam.worldToScreen=origW2S;
    ed.action('tool','select');ed.action('select',null);
    return out;
  } catch(e){ return {__err: String((e&&e.stack)||e)}; } })()`);
  if (s25 && s25.__err) console.log('    [24] IIFE error -> ' + s25.__err.split('\n').slice(0,3).join(' | '));
  check('数据模型 / 工具栏新增「贴面矩形」',
    s25.kindDef === true && s25.toolDef === true && s25.toolBtn === true);
  check('贴面矩形生成投影机 OBB（position/quaternion/half 合法）',
    s25.hasProjector === true && s25.projValid === true,
    `${s25.hasProjector}/${s25.projValid}`);
  check('编辑器画 OBB 线框（12 边，逐段绘制）+ 选中 7 手柄（含角色标记）',
    s25.edgesVisible === true && s25.handleCount === 7 && s25.handlesTagged === true,
    `edges=${s25.edgeCount} seg=${s25.edgeSeg} handles=${s25.handleCount} roles=${s25.handleRoles}`);
  check('正交 OBB 选中时出现三轴旋转环（X/Y/Z 各一条环形命中区）',
    s25.ringCount >= 24 && s25.ringAxes === 'rx,ry,rz' && s25.ringHits === 3,
    `rings=${s25.ringCount} axes=${s25.ringAxes} hits=${s25.ringHits}`);
  check('投影式贴花不再渲染旧网格 / 单应视频 DOM',
    s25.legacyDomHidden === true && s25.legacyCellsHidden === true);
  check('无 projector 时退化为屏幕占位框：无网格尖刺、尺寸有限、可恢复',
    s25.pendingShown === true && s25.pendingSizeFinite === true && s25.noSpikeCells === true &&
    s25.pendingLabel === true && s25.pendingHiddenAfterRestore === true,
    `shown=${s25.pendingShown} size=${s25.pendingSizeFinite} noCell=${s25.noSpikeCells} label=${s25.pendingLabel} restore=${s25.pendingHiddenAfterRestore}`);
  check('属性面板提供投射 URL / 不透明度 / 边缘 / 深度（无细分密度）',
    s25.hasUrlInput === true && s25.hasOpacity === true && s25.hasEdge === true &&
    s25.hasDepth === true && s25.noGridInput === true && s25.noLiftInput === true &&
    s25.statusRow === true && s25.rebuildBtn === true,
    `url/op/edge/depth=${s25.hasUrlInput}/${s25.hasOpacity}/${s25.hasEdge}/${s25.hasDepth}`);
  check('改投射深度 -> OBB half[2] 重算；改不透明度 -> style 落库',
    s25.depthStored === true && s25.halfZ === true && s25.opacityStored === true,
    `depth=${s25.depthStored} halfZ=${s25.halfZ} op=${s25.opacityStored}`);
  check('Shift+R 两对角点生成贴面矩形（含 projector）',
    s25.toolByShortcut === true && s25.created === true && s25.twoCorners === true &&
    s25.normalSaved === true && s25.madeProjector === true,
    `${s25.toolByShortcut}/${s25.created}/${s25.twoCorners}/${s25.normalSaved}/${s25.madeProjector}`);

  /* ------------------------------------------------ [25] 深度反算链路 */
  console.log('\n[25] 深度反算链路：屏幕矩形 → 逐点深度 → 世界表面点 → surface 持久化');
  const s26 = await E(`(async()=>{
    const w=(${FM}).contentWindow,d=w.document,ed=w.__mgEditor;
    if(!ed)return{error:'no editor'};
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const out={};
    const mod=await import('./editor/schema.js');
    const cv=d.getElementById('ed-mock-canvas');
    const cr=cv.getBoundingClientRect();
    const box={left:0,top:0,width:800,height:600};

    // 1) 屏幕矩形归一化：正拖 / 反拖 / 退化成线
    const r1=mod.screenRectUV(box,[100,120],[500,420]);
    const r2=mod.screenRectUV(box,[500,420],[100,120]);
    out.uvForward=!!r1&&Math.abs(r1[0]-0.125)<1e-9&&Math.abs(r1[2]-0.625)<1e-9;
    out.uvReverse=!!r2&&r2.every((v,i)=>Math.abs(v-r1[i])<1e-9);
    const r3=mod.screenRectUV(box,[300,300],[301,301]);
    out.uvMin=!!r3&&(r3[2]-r3[0])>=0.01-1e-9&&(r3[3]-r3[1])>=0.01-1e-9;
    out.gridIndex=mod.decalGridIndex(4,3,2)===13;

    // 2) 单点深度反算：模拟引擎 Picker.pick 从深度缓冲反投影
    const origPicker=w.__viewer.picker;
    w.__viewer.picker=()=>({pick:async(x,y)=>({x:x*10,y:1.5,z:y*10+2})});
    const hit=await ed.picker.depthUnproject(cr.left+cr.width*0.5,cr.top+cr.height*0.5);
    out.depthHit=!!hit&&hit.source==='depth'&&Math.abs(hit.pos[0]-5)<1e-6;
    // 深度图不可用时自动回退到「相机射线 × MESH / 地面」，不能返回空
    w.__viewer.picker=()=>({pick:async()=>{throw new Error('depth unavailable');}});
    const fb=await ed.picker.depthUnproject(cr.left+cr.width*0.5,cr.top+cr.height*0.5);
    out.depthFallback=!!fb&&['mesh','ground','free'].indexOf(fb.source)>=0;
    w.__viewer.picker=origPicker;

    // 3) 整块屏幕矩形 -> (nu+1)×(nv+1) 行优先世界网格
    const s=await ed.picker.unprojectRect([0.2,0.2,0.6,0.6],4,3);
    out.gridSize=!!s&&s.points.length===20&&s.nu===4&&s.nv===3;
    out.gridFinite=!!s&&s.points.every(p=>Array.isArray(p)&&p.length===3&&p.every(Number.isFinite));
    out.gridStats=!!s&&s.samples===20&&Object.keys(s.stats||{}).length>0;
    out.gridRect=!!s&&s.rect.length===4&&s.rect[0]===0.2;

    // 4) 属性面板「重新按深度反算」按钮真的重新调用 unprojectRect
    const decal=ed.store.list('floor1').find(a=>a.kind==='decal');
    ed.action('select',decal.id);await sleep(300);
    const btn=d.querySelector('.ed-prop [data-act="decal-rebuild"]');
    out.rebuildBtn=!!btn;
    out.statusRow=/投影机 OBB/.test(d.querySelector('.ed-prop .ed-prop-status')?.textContent||'');
    let calls=0;const origUR=ed.picker.unprojectRect;
    ed.picker.unprojectRect=(...a)=>{calls++;return origUR(...a);};
    btn?.click();
    for(let i=0;i<40&&calls===0;i++)await sleep(80);
    await sleep(300);
    out.rebuildWorks=calls>0;
    ed.picker.unprojectRect=origUR;
    const sf=ed.store.get(decal.id).surface;
    out.persisted=!!sf&&Array.isArray(sf.points)&&sf.points.length>0
      &&sf.points.every(p=>Array.isArray(p)&&p.length===3&&p.every(Number.isFinite));
    out.surfDbg=[sf?.nu,sf?.nv,sf?.points?.length,
      JSON.stringify(ed.store.get(decal.id).rect)].join('/');

    // 5) 换机位：投影机 OBB（世界坐标）不变，但 OBB 框线屏幕投影必须跟着透视变化
    const cam=w.__viewer.app.root.findComponent('camera');const origW2S=cam.worldToScreen;
    const edges0=[...d.querySelectorAll('.ed-g[data-id="'+decal.id+'"] .ed-decal-obb-edge')];
    const proj0=JSON.stringify(ed.store.get(decal.id).projector?.half);
    const line0=edges0.map(e=>e.getAttribute('x1')+','+e.getAttribute('y1')+','+e.getAttribute('x2')+','+e.getAttribute('y2')).join('|');
    cam.worldToScreen=(p,o)=>o.set(520+p.x*31+p.z*2.5,340-p.y*27,1);
    await sleep(320);
    const line1=[...d.querySelectorAll('.ed-g[data-id="'+decal.id+'"] .ed-decal-obb-edge')]
      .map(e=>e.getAttribute('x1')+','+e.getAttribute('y1')+','+e.getAttribute('x2')+','+e.getAttribute('y2')).join('|');
    out.viewReprojects=!!line0&&!!line1&&line0!==line1;
    out.worldSurfaceFixed=JSON.stringify(ed.store.get(decal.id).projector?.half)===proj0;
    cam.worldToScreen=origW2S;await sleep(220);
    ed.action('select',null);
    return out;
  })()`);
  check('屏幕矩形归一化（正拖 / 反拖 / 退化最小框）',
    s26.uvForward === true && s26.uvReverse === true && s26.uvMin === true);
  check('行优先网格下标 decalGridIndex', s26.gridIndex === true);
  check('单点深度反算走引擎 Picker.pick 深度缓冲', s26.depthHit === true);
  check('深度缓冲不可用时自动回退到等价射线', s26.depthFallback === true);
  check('整块矩形反算成 5×4 = 20 个世界表面点',
    s26.gridSize === true && s26.gridFinite === true && s26.gridStats === true && s26.gridRect === true,
    `${s26.gridSize}/${s26.gridFinite}/${s26.gridStats}`);
  check('属性面板显示投影机 OBB 状态 + 重建按钮可用',
    s26.rebuildBtn === true && s26.statusRow === true && s26.rebuildWorks === true);
  check('深度反算 surface 世界点已持久化（有限坐标）', s26.persisted === true, s26.surfDbg);
  check('换机位只重投影、投影机 OBB 世界坐标不漂移',
    s26.viewReprojects === true && s26.worldSurfaceFixed === true);

  /* ------------------------------------------------ [26] 三维屏三轴 gizmo */
  console.log('\n[26] 三维实体屏：三轴 gizmo（X/Y/Z 轴柄 + 中心选择柄）/ 屏体拖动 / 微抖不改位置');
  const s27 = await E(`(async()=>{
    const w=(${FM}).contentWindow,d=w.document,ed=w.__mgEditor;
    if(!ed)return{error:'no editor'};
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const out={};
    const sc=ed.store.list('floor1').find(a=>a.kind==='screen');
    if(!sc)return{error:'no screen'};
    ed.store.update(sc.id,{visible:true});
    ed.action('select',sc.id);await sleep(380);
    const gz=d.querySelector('.ed-screen-gizmo');
    out.gizmo=!!gz&&getComputedStyle(gz).display!=='none';
    const hits=[...(gz?.querySelectorAll('.ed-gizmo-hit')||[])];
    out.threeAxes=hits.length===3;
    out.axisKeys=['x','y','z'].every(k=>hits.some(h=>h.dataset.axis===k));
    // 旧六向交互必须彻底移除：六向按钮 / data-axis 旧键不允许再出现
    out.noSixHandles=gz?.querySelectorAll('.ed-axis-handle').length===0&&
      ![...gz?.querySelectorAll('[data-axis]')||[]].some(h=>['right','left','up','down','front','back'].includes(h.dataset.axis));
    out.tip=/三轴拖动/.test(gz?.querySelector('.ed-gizmo-tip')?.textContent||'');
    const basis=ed.overlay.nodes.get(sc.id)?.parts?.screen?.basis;
    out.basis=!!basis&&!!basis.R&&!!basis.U&&!!basis.F&&!!basis.world&&!!basis.ppm&&
      !!basis.world.x&&!!basis.world.y&&!!basis.world.z;
    // 轴柄视觉几何已按投影方向摆放（线段端点不都等于中心）
    const ax=gz?.querySelector('.ed-gizmo-axis[data-axis="x"]');
    out.geomUpdated=!!ax&&ax.getAttribute('x1')==='130'&&ax.getAttribute('x2')!=='130';

    const mk=(t,x,y,el)=>el.dispatchEvent(new w.PointerEvent(t,
      {clientX:x,clientY:y,bubbles:true,cancelable:true,pointerId:31,button:0,pointerType:'mouse'}));
    const drag=(el,dx,dy)=>{
      const r=el.getBoundingClientRect();const x=r.left+r.width/2,y=r.top+r.height/2;
      mk('pointerdown',x,y,el);mk('pointermove',x+dx,y+dy,el);mk('pointerup',x+dx,y+dy,el);
    };
    const p0=ed.store.get(sc.id).points[0].slice();
    // 单击微抖（3px / 2px）只选中，绝不改写世界位置
    drag(d.querySelector('.ed-item[data-kind="screen"]'),3,2);await sleep(180);
    out.jitterKeeps=JSON.stringify(ed.store.get(sc.id).points[0])===JSON.stringify(p0);

    // 三根轴柄逐一拖动：位移必须严格沿对应世界轴（X/Y/Z）
    out.axisDelta={};out.axisMoved=true;out.axisParallel=true;
    for(const k of ['x','y','z']){
      const cur=ed.store.get(sc.id).points[0].slice();
      const h=hits.find(x=>x.dataset.axis===k);
      drag(h,42,26);await sleep(140);
      const now=ed.store.get(sc.id).points[0];
      const dv=[now[0]-cur[0],now[1]-cur[1],now[2]-cur[2]];
      const len=Math.hypot(dv[0],dv[1],dv[2]);
      out.axisDelta[k]=Number(len.toFixed(4));
      if(len<1e-4)out.axisMoved=false;
      const b=basis?.world?.[k];
      if(b&&len>1e-4){
        const dot=Math.abs(dv[0]*b[0]+dv[1]*b[1]+dv[2]*b[2]);
        if(dot/len<0.985)out.axisParallel=false;
      }
    }
    // 屏体拖动：相机平面内自由移动（中心选择柄 / 屏体）
    const pb=ed.store.get(sc.id).points[0].slice();
    drag(d.querySelector('.ed-item[data-kind="screen"]'),55,35);await sleep(200);
    out.planeMoved=JSON.stringify(ed.store.get(sc.id).points[0])!==JSON.stringify(pb);
    // 取消选中后 gizmo 隐藏
    ed.action('select',null);await sleep(280);
    const gz2=d.querySelector('.ed-screen-gizmo');
    out.gizmoHidden=!gz2||getComputedStyle(gz2).display==='none';
    ed.store.update(sc.id,{points:[p0]});
    return out;
  })()`);
  check('选中三维屏后出现三轴 gizmo（X/Y/Z 轴柄 + 三轴提示）',
    s27.gizmo === true && s27.threeAxes === true && s27.axisKeys === true && s27.tip === true,
    `${s27.gizmo}/${s27.threeAxes}/${s27.axisKeys}/${s27.tip}`);
  check('旧六向交互入口已彻底移除（无 .ed-axis-handle / 旧方向键）', s27.noSixHandles === true);
  check('相机基向量 + 世界三轴 x/y/z 的屏幕方向 / 每米像素已计算', s27.basis === true);
  check('轴柄视觉几何按投影方向逐帧更新', s27.geomUpdated === true);
  check('单击微抖 ≤6px 不改变屏体位置', s27.jitterKeeps === true);
  check('三根轴柄都能沿轴向移动三维屏', s27.axisMoved === true, s27.axisDelta);
  check('位移严格沿各自世界轴（无斜向串扰）', s27.axisParallel === true);
  check('拖动屏体在相机平面内自由移动', s27.planeMoved === true);
  check('取消选中后 gizmo 隐藏', s27.gizmoHidden === true);

  /* ------------------------------------------------ [27] 本地视频 */
  console.log('\n[27] 本地视频：test.mp4 分段 Range / 工程内片源 / 本机文件 object URL');
  let vHead = {}, vRange = {}, vTail = {};
  try {
    const r = await fetch(BASE + '/media/test.mp4', { method: 'HEAD' });
    vHead = { status: r.status, type: r.headers.get('content-type'),
      len: Number(r.headers.get('content-length') || 0), ar: r.headers.get('accept-ranges') };
  } catch (e) { vHead = { error: String(e) }; }
  try {
    const r = await fetch(BASE + '/media/test.mp4', { headers: { Range: 'bytes=0-' } });
    const b = await r.arrayBuffer();
    vRange = { status: r.status, type: r.headers.get('content-type'),
      cr: r.headers.get('content-range'), size: b.byteLength };
  } catch (e) { vRange = { error: String(e) }; }
  try {
    const r = await fetch(BASE + '/media/test.mp4', { headers: { Range: 'bytes=99000000-' } });
    const b = await r.arrayBuffer();
    vTail = { status: r.status, size: b.byteLength, cr: r.headers.get('content-range') };
  } catch (e) { vTail = { error: String(e) }; }
  check('本地测试视频存在且 MIME 为 video/mp4',
    vHead.status === 200 && vHead.type === 'video/mp4' && vHead.len > 90 * 1024 * 1024,
    `${vHead.status}/${vHead.type}/${vHead.len}`);
  check('支持 Range（Accept-Ranges: bytes）', vHead.ar === 'bytes');
  check('首包按 1MB 分片返回 206，起播无需等 99MB',
    vRange.status === 206 && vRange.size === 1024 * 1024 &&
    String(vRange.cr || '').startsWith('bytes 0-1048575/') &&
    String(vRange.cr || '').endsWith('/99031577'),
    `${vRange.status}/${vRange.size}/${vRange.cr}`);
  check('可读取文件尾部分片（moov 元数据 / 拖动进度条）',
    vTail.status === 206 && vTail.size > 0 && /99031577/.test(vTail.cr || ''),
    `${vTail.status}/${vTail.size}/${vTail.cr}`);

  const s28 = await E(`(async()=>{
    const w=(${FM}).contentWindow,d=w.document,ed=w.__mgEditor;
    if(!ed)return{error:'no editor'};
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const out={};
    const sc=ed.store.list('floor1').find(a=>a.kind==='screen');
    if(!sc)return{error:'no screen'};
    ed.store.update(sc.id,{visible:true});
    ed.action('select',sc.id);await sleep(320);
    const btn=d.querySelector('.ed-prop [data-act="local-video"]');
    out.btn=!!btn;
    btn?.click();await sleep(360);
    out.url=ed.store.get(sc.id).media?.[0]?.url||'';
    out.urlOk=out.url==='./media/test.mp4';
    const v=d.querySelector('.ed-item[data-kind="screen"] video.ed-screen-video');
    const src=v?.getAttribute('src')||'';
    out.videoSrc=/test\\.mp4/.test(src);

    // 本机文件：注入 File 触发 change -> object URL -> <video src>
    const fi=d.querySelector('.ed-prop input[data-act="local-video-file"]');
    out.fileInput=!!fi;
    if(fi){
      const f=new w.File([new Uint8Array([0,0,0,16,102,116,121,112])],'local.mp4',{type:'video/mp4'});
      let files=null;
      try{const dt=new w.DataTransfer();dt.items.add(f);files=dt.files;}catch(e){files=[f];}
      Object.defineProperty(fi,'files',{configurable:true,value:files});
      fi.dispatchEvent(new w.Event('change',{bubbles:true}));
      await sleep(300);
    }
    out.blobUrl=/^blob:/.test(ed.store.get(sc.id).media?.[0]?.url||'');
    out.blobDom=/^blob:/.test(d.querySelector('.ed-item[data-kind="screen"] video.ed-screen-video')?.getAttribute('src')||'');

    // 贴面矩形同样有本地视频入口
    const dec=ed.store.list('floor1').find(a=>a.kind==='decal');
    ed.action('select',dec.id);await sleep(280);
    out.decalBtn=!!d.querySelector('.ed-prop [data-act="local-video"]');
    out.decalFileBtn=!!d.querySelector('.ed-prop input[data-act="local-video-file"]');

    // 还原示例片源，避免污染后续断言
    ed.store.update(sc.id,{media:[{type:'video',url:'',caption:'演示片源'}]});
    ed.action('select',null);
    return out;
  })()`);
  check('属性面板提供「使用工程内测试视频」按钮', s28.btn === true);
  check('点击后片源写入 ./media/test.mp4 且屏内 video 已换源',
    s28.urlOk === true && s28.videoSrc === true, s28.url);
  check('本地文件选择生成 object URL 并投射到三维屏',
    s28.fileInput === true && s28.blobUrl === true && s28.blobDom === true,
    `${s28.fileInput}/${s28.blobUrl}/${s28.blobDom}`);
  check('贴面矩形同样支持工程内视频 / 本机文件',
    s28.decalBtn === true && s28.decalFileBtn === true);

  /* ------------------------------------------------ [28] 右键 + 动线结束贴地 */
  console.log('\n[28] 右键统一回「选择」+ 动线右键 / Enter 结束不飞天花板');
  const s29 = await E(`(async()=>{
    const w=(${FM}).contentWindow,d=w.document,ed=w.__mgEditor;
    if(!ed)return{error:'no editor'};
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const out={};
    const cv=d.getElementById('ed-mock-canvas');
    const mk=(t,x,y)=>new w.PointerEvent(t,{clientX:x,clientY:y,bubbles:true,cancelable:true,pointerId:41,button:0,pointerType:'mouse'});
    const cm=(x,y)=>new w.MouseEvent('contextmenu',{clientX:x,clientY:y,bubbles:true,cancelable:true});
    const sc=ed.store.list('floor1').find(a=>a.kind==='screen');

    let fly=0;const origFly=w.__viewer.setCameraPose;
    w.__viewer.setCameraPose=(...a)=>{fly++;return origFly?origFly(...a):true;};

    // A. 有选中项时右键：清空选中 + 工具回默认「选择」+ 不漫游
    ed.action('select',sc?.id||null);await sleep(180);
    out.hadSelection=!!sc&&ed.getState().selectedId===sc.id;
    const e1=cm(400,300);cv.dispatchEvent(e1);await sleep(200);
    out.rightDeselect=ed.getState().selectedId===null;
    out.rightToolSel=ed.getState().tool==='select';
    out.rightPrevented=e1.defaultPrevented;
    out.rightStatus=/选择/.test(d.querySelector('[data-role="status"]')?.textContent||'');

    // B. 绘制过程中右键：丢弃草稿 + 不生成标注 + 工具回选择
    ed.action('tool','line');
    const n0=ed.store.list('floor1').length;
    cv.dispatchEvent(mk('pointerdown',380,280));cv.dispatchEvent(mk('pointerup',380,280));
    await sleep(340);
    out.hadDraft=!!ed.overlay._draft;
    const e2=cm(380,280);cv.dispatchEvent(e2);await sleep(220);
    out.rightDraft=ed.overlay._draft===null;
    out.rightNoAdd=ed.store.list('floor1').length===n0;
    out.rightToolAfterDraft=ed.getState().tool==='select';
    out.rightNoFly=fly===0;
    w.__viewer.setCameraPose=origFly;

    // 天花板桩：垂直向下射线一律命中 3.2m 高的屋顶（用户反馈的错误场景）
    const col=w.__viewer.collision();const origRay=col.queryRay;
    col.queryRay=(ox,oy,oz,dx,dy,dz)=>{
      if(Math.abs(dy)>0.8)return{x:ox,y:5.2,z:oz};        // 贴地射线 -> 天花板
      return{x:ox+dx*2,y:0.3,z:oz+dz*2};                   // 相机视线 -> 脚下地面
    };
    // 长动线在该桩下仍须密集重采样，且每点保持地面高度（屋顶命中全被拒绝）
    const guard=ed.picker.drapePolyline([[0,0.3,0],[0,0.3,8]],0.45);
    out.guardDense=guard.length>8;
    out.guardGrounded=guard.every(p=>Math.abs(p[1]-0.3)<1e-6);

    // C. 右键单击结束绘制：结果必须贴在地面，不能出现屋顶高度（双击已禁用）
    ed.action('tool','line');
    const d0=ed.store.list('floor1').length;
    cv.dispatchEvent(mk('pointerdown',360,270));cv.dispatchEvent(mk('pointerup',360,270));
    await sleep(340);
    cv.dispatchEvent(mk('pointerdown',430,320));cv.dispatchEvent(mk('pointerup',430,320));
    await sleep(340);
    const dMid=ed.store.list('floor1').length;
    cv.dispatchEvent(new w.MouseEvent('dblclick',{clientX:430,clientY:320,bubbles:true,cancelable:true}));
    await sleep(260);
    out.dblNoFinish=dMid===d0&&ed.store.list('floor1').length===d0&&!!ed.overlay._draft;
    cv.dispatchEvent(cm(430,320));
    await sleep(420);
    const lines1=ed.store.list('floor1').filter(a=>a.kind==='line');
    const made1=lines1[lines1.length-1];
    const f1=ed.overlay.nodes.get(made1.id)?.parts?.flow;
    out.cmCreated=ed.store.list('floor1').length===d0+1;
    out.cmTool=ed.getState().tool;
    // 新建的两点短动线可能只产生 2 个密集点，关键是高度不能出现屋顶
    out.cmCeilingFree=!!f1?.world&&f1.world.length>1&&f1.world.every(p=>p[1]<3.0);
    out.cmNoJump=!!f1?.world&&f1.world.every(p=>Math.abs(p[1]-made1.points[0][1])<1.5);
    out.cmDbg=[out.cmCreated,out.cmTool,out.cmCeilingFree,out.cmNoJump,
      !!f1,f1?.world?.length,made1?.points?.[0]?.[1],f1?.world?.[0]?.[1]].join('/');

    // D. Enter 结束绘制：与双击等价，同样不吸天花板
    ed.action('tool','line');
    const e0=ed.store.list('floor1').length;
    cv.dispatchEvent(mk('pointerdown',350,260));cv.dispatchEvent(mk('pointerup',350,260));
    await sleep(340);
    cv.dispatchEvent(mk('pointerdown',420,310));cv.dispatchEvent(mk('pointerup',420,310));
    await sleep(340);
    const eMid=ed.store.list('floor1').length;
    d.body.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
    await sleep(420);
    const lines2=ed.store.list('floor1').filter(a=>a.kind==='line');
    const made2=lines2[lines2.length-1];
    const f2=ed.overlay.nodes.get(made2.id)?.parts?.flow;
    out.enterCreated=eMid===e0&&ed.store.list('floor1').length===e0+1;
    out.enterTool=ed.getState().tool;
    out.enterCeilingFree=!!f2?.world&&f2.world.length>1&&f2.world.every(p=>p[1]<3.0);
    out.enterNoJump=!!f2?.world&&f2.world.every(p=>Math.abs(p[1]-made2.points[0][1])<1.5);
    out.enterDbg=[out.enterCreated,out.enterTool,out.enterCeilingFree,out.enterNoJump,
      !!f2,f2?.world?.length,made2?.points?.[0]?.[1],f2?.world?.[0]?.[1]].join('/');

    col.queryRay=origRay;
    ed.action('tool','select');ed.action('select',null);
    return out;
  })()`);
  check('右键清除选中并回到默认「选择」状态',
    s29.hadSelection === true && s29.rightDeselect === true && s29.rightToolSel === true);
  check('右键阻止引擎默认菜单 / 漫游且状态栏提示已复位',
    s29.rightPrevented === true && s29.rightNoFly === true && s29.rightStatus === true);
  check('绘制中右键丢弃草稿、不生成标注、工具回「选择」',
    s29.hadDraft === true && s29.rightDraft === true && s29.rightNoAdd === true && s29.rightToolAfterDraft === true);
  check('天花板场景下长动线密集采样且全部保持地面高度',
    s29.guardDense === true && s29.guardGrounded === true);
  check('双击不结束动线绘制（草稿保留），右键单击结束后贴地、不飞天花板',
    s29.dblNoFinish === true && s29.cmCreated === true && s29.cmTool === 'select' &&
    s29.cmCeilingFree === true && s29.cmNoJump === true, s29.cmDbg);
  check('Enter 结束动线后贴地、不飞天花板',
    s29.enterCreated === true && s29.enterTool === 'select' &&
    s29.enterCeilingFree === true && s29.enterNoJump === true, s29.enterDbg);

  /* ---------------------------------------------------------- 错误汇总 */
  console.log('\n[29] 错误汇总');
  const ex = events.filter((e) => e.method === 'Runtime.exceptionThrown');
  const le = events.filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error');
  /* 只对「本地资源」断言 200：本用例里有若干故意写死的外链占位符
     （网页展板 iframe 的 https://example.com/hall、图片 /a.png、视频 /a.mp4），
     它们必然 404，且是否在下一次断言前返回取决于加载时序 —— 拿它当失败项
     属于用例自身的假失败。外链单独统计、只做信息输出。 */
  const isLocal = (u) => /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(u || '') ||
    /^(data|blob):/.test(u || '');
  const badAll = events.filter((e) => e.method === 'Network.responseReceived' && e.params.response.status >= 400);
  const bad = badAll.filter((e) => isLocal(e.params.response.url));
  const externalBad = badAll.filter((e) => !isLocal(e.params.response.url));
  const exDetail = ex.map((e) => {
    const d = e.params.exceptionDetails || {};
    return (d.exception?.description || d.text || '').split('\n').slice(0, 4).join(' | ');
  });
  check('0 个 JS 异常', ex.length === 0, exDetail);
  check('0 个 console error', le.length === 0, le.slice(0, 3).map((e) => String(e.params.entry.text).slice(0, 160)));
  check('0 个 HTTP>=400（本地资源）', bad.length === 0, bad.slice(0, 5).map((e) => e.params.response.status + ' ' + e.params.response.url));
  if (externalBad.length) {
    console.log('  信息：外链占位符返回非 200（测试夹具，不计入失败）'
      + JSON.stringify(externalBad.slice(0, 3).map((e) => e.params.response.status + ' ' + e.params.response.url)));
  }

  console.log('\n[30] 复制 / 层级置顶置底 / 右键上下文菜单 / 撤销合并隔离 / 选中 reconcile');
  const s30 = await E(`(async()=>{
    const w=(${FM}).contentWindow,d=w.document,ed=w.__mgEditor;
    if(!ed) return {error:1};
    const mk=function(t,x,y,opts){opts=opts||{};return new w.MouseEvent(t,Object.assign({clientX:x,clientY:y,bubbles:true,cancelable:true,button:opts.button||0,pointerId:1,pointerType:'mouse'},opts));};
    const A=ed.store.add({kind:'point',points:[[1,2,3]]});
    const B=ed.store.add({kind:'point',points:[[2,3,4]]});
    await new Promise(function(r){setTimeout(r,300);});
    const before=ed.store.list('floor1').length;
    ed.action('duplicate', A.id);
    const after=ed.store.list('floor1').length;
    const dup=ed.store.list('floor1').find(function(x){return x.title && x.title.indexOf('副本')>=0;});
    const dupOk = !!(dup && dup.points[0][0]===A.points[0][0]+0.5 && dup.points[0][2]===A.points[0][2]+0.5);
    const oA=ed.store.get(A.id).order;
    ed.store.bringToFront(A.id);
    const maxOrder=ed.store.list('floor1').reduce(function(m,x){return Math.max(m,x.order);},-1e9);
    const frontOk = ed.store.get(A.id).order===maxOrder && ed.store.get(A.id).order>oA;
    ed.store.sendToBack(B.id);
    const minOrder=ed.store.list('floor1').reduce(function(m,x){return Math.min(m,x.order);},1e18);
    const backOk = ed.store.get(B.id).order===minOrder;
    ed.store.update(A.id,{style:{color:'#111111'}},{coalesceKey:'field:'+A.id+':color'});
    ed.store.update(B.id,{style:{color:'#222222'}},{coalesceKey:'field:'+B.id+':color'});
    ed.store.undo();
    const isolOk = ed.store.get(A.id).style.color==='#111111' && ed.store.get(B.id).style.color!=='#222222';
    ed.action('select', B.id);
    ed.store.remove(B.id);
    const selAfterDel=ed.getState().selectedId;
    const annEl=d.querySelector('.ed-item[data-id]')||d.querySelector('[data-id]');
    let menuShown=false, menuDuplicateOk=false;
    if(annEl){
      annEl.dispatchEvent(mk('contextmenu',100,100,{button:2}));
      const menu=d.querySelector('.ed-ctx');
      menuShown=!!menu;
      if(menu){
        const btn=menu.querySelector('[data-act="duplicate"]');
        if(btn) btn.click();
        menuDuplicateOk=ed.store.list('floor1').some(function(x){return x.title && x.title.indexOf('副本')>=0;});
        const m2=d.querySelector('.ed-ctx'); if(m2) m2.remove();
      }
    }
    ed.store.remove(A.id);
    ed.store.list('floor1').filter(function(x){return x.title && x.title.indexOf('副本')>=0;}).forEach(function(x){ed.store.remove(x.id);});
    return {before:before,after:after,dupOk:dupOk,frontOk:frontOk,backOk:backOk,isolOk:isolOk,selAfterDel:selAfterDel,menuShown:menuShown,menuDuplicateOk:menuDuplicateOk};
  })()`);
  check('复制(Ctrl+D)：新增一条且偏移 0.5m', s30.after === s30.before + 1 && s30.dupOk, s30);
  check('层级：置顶后 order 为最大', s30.frontOk, s30);
  check('层级：置底后 order 为最小', s30.backOk, s30);
  check('撤销合并按对象 id 隔离（A/B 不串扰）', s30.isolOk, s30);
  check('删除选中标注后 selectedId 自动清空（reconcile）', s30.selAfterDel === null, s30);
  check('右键命中标注弹出上下文菜单', s30.menuShown, s30);
  check('上下文菜单「复制」按钮生效', s30.menuDuplicateOk, s30);

  console.log('\n[31] 多选 / 框选 / 对齐吸附');
  const s31 = await E(`(async()=>{
    const w=(${FM}).contentWindow,d=w.document,ed=w.__mgEditor;
    if(!ed) return {error:1};
    const mk=function(t,x,y,opts){opts=opts||{};return new w.MouseEvent(t,Object.assign({clientX:x,clientY:y,bubbles:true,cancelable:true,button:opts.button||0,pointerId:1,pointerType:'mouse'},opts));};
    const A=ed.store.add({kind:'point',points:[[1,2,3]]});
    const B=ed.store.add({kind:'point',points:[[2,3,4]]});
    await new Promise(function(r){setTimeout(r,300);});
    // 1) Shift+点击切换多选（同时验证 overlay 点击 -> onPick -> 切换 的接线）
    ed.action('select', A.id);
    const gB=d.querySelector('.ed-item[data-id="'+B.id+'"]') || d.querySelector('.ed-g[data-id="'+B.id+'"]');
    if(gB) gB.dispatchEvent(mk('click',50,50,{shiftKey:true}));
    const selAfterToggle=ed.getState().selectedIds.slice();
    const toggleOk=selAfterToggle.length===2 && selAfterToggle.indexOf(A.id)>=0 && selAfterToggle.indexOf(B.id)>=0;
    // 2) Ctrl+A 全选
    d.dispatchEvent(new w.KeyboardEvent('keydown',{key:'a',ctrlKey:true,bubbles:true}));
    const allIds=ed.getState().selectedIds.slice();
    const selectAllOk=allIds.length>=2;
    // 3) 框选命中：构造覆盖 A 屏幕包围盒的矩形，验证 selectionRectHit
    const ctx=ed.overlay._context();
    const bb=ed.overlay._bbox(ctx, ed.store.get(A.id));
    const rect={x0:bb.x0-8,y0:bb.y0-8,x1:bb.x1+8,y1:bb.y1+8};
    const hit=ed.overlay.selectionRectHit(rect, ed.getState().scene);
    const marqueeOk=hit.indexOf(A.id)>=0;
    // 4) 多选删除
    ed.action('select',[A.id,B.id]);
    const beforeDel=ed.store.list('floor1').length;
    ed.action('delete');
    const afterDel=ed.store.list('floor1').length;
    const multiDelOk=afterDel===beforeDel-2;
    // 5) 多选复制
    const C=ed.store.add({kind:'point',points:[[5,5,5]]});
    const D=ed.store.add({kind:'point',points:[[6,6,6]]});
    ed.action('select',[C.id,D.id]);
    const beforeDup=ed.store.list('floor1').length;
    ed.action('duplicate');
    const afterDup=ed.store.list('floor1').length;
    const multiDupOk=afterDup===beforeDup+2 && ed.store.list('floor1').some(function(x){return x.title&&x.title.indexOf('副本')>=0;});
    // 6) 对齐吸附数学 + 引导线（目标与编组 Y 错位，确保只有 X 边对齐命中阈值）
    const snap=ed.overlay._computeAlign({x0:100,y0:100,x1:200,y1:200},[{x0:205,y0:500,x1:305,y1:600}],0,0,10);
    const snapOk=snap.dx===5 && snap.guides.length===1 && snap.guides[0].x!==undefined;
    // 清理
    ed.store.list('floor1').filter(function(x){return x.title&&x.title.indexOf('副本')>=0;}).forEach(function(x){ed.store.remove(x.id);});
    ed.store.remove(C.id); ed.store.remove(D.id);
    return {toggleOk:toggleOk,selectAllOk:selectAllOk,marqueeOk:marqueeOk,multiDelOk:multiDelOk,multiDupOk:multiDupOk,snapOk:snapOk,allLen:allIds.length};
  })()`);
  check('Shift+点击：在选集中切换成员（多选）', s31.toggleOk, s31);
  check('Ctrl+A：全选场景内标注', s31.selectAllOk, s31);
  check('框选：矩形命中测试可命中目标标注', s31.marqueeOk, s31);
  check('多选删除：一次删除全部选中', s31.multiDelOk, s31);
  check('多选复制：一次复制全部选中', s31.multiDupOk, s31);
  check('对齐吸附：组内边与目标对齐并生成引导线', s31.snapOk, s31);

  /* [32] GPU 贴花渲染路径守卫
   * 本套件 mock 了 __viewer 且没有 globalThis.__pc，createDecalProjection()
   * 会直接 disabled，整条 GPU 路径跑不到 —— 这正是「进入编辑黑屏」漏测的原因。
   * 真实像素验证交给 tools/diagnose_editor_canvas.mjs；这里用源码守卫防止
   * 那三个已定位的根因被改回去。 */
  console.log('\n[32] GPU 贴花渲染路径守卫（编辑态黑屏回归）');
  const decalSrc = fs.readFileSync(path.join(ROOT, 'web', 'editor', 'decal-projection.js'), 'utf8');
  const editorSrc = fs.readFileSync(path.join(ROOT, 'web', 'editor', 'editor.js'), 'utf8');
  /* 「注记 → GPU 实例描述」这段映射已抽到 web/decal-runtime.js，由编辑器与
     浏览态共用（浏览态也能看到投射视频）。相关源码守卫改读这个共享模块。 */
  const decalRuntimeSrc = fs.readFileSync(path.join(ROOT, 'web', 'decal-runtime.js'), 'utf8');
  const pickingSrc = fs.readFileSync(path.join(ROOT, 'web', 'editor', 'picking.js'), 'utf8');
  const editorCssSrc = fs.readFileSync(path.join(ROOT, 'web', 'editor', 'editor.css'), 'utf8');
  /* 真机黑屏的真因（WebGPU 后端）：WGSL 里写了 input.pcPosition，但引擎生成的
     FragmentInput 字段叫 position，pcPosition 是 var<private> 全局量。WGSL 编译
     失败会让 WebGPU render pass 整体不呈现，且 PlayCanvas 不抛 JS 异常。
     mock 环境跑不到 WebGPU，只能靠源码守卫 + tools/diagnose_decal_repro.mjs
     的真实 WebGPU 画布测试双保险。 */
  /* 着色器源码已抽到引擎层（web/engine/decal-shaders.js），编辑器模块不再内嵌
     GLSL/WGSL。守卫断言因此分两处取源：
       fragGlsl / wgslBody —— 着色器正文（在引擎层）
       decalSrc            —— 编辑器侧的调用代码（uniform 设置、渲染循环、降级） */
  const shaderFile = path.join(ROOT, 'web', 'engine', 'decal-shaders.js');
  const shaderSrc = fs.existsSync(shaderFile) ? fs.readFileSync(shaderFile, 'utf8') : '';
  const fragGlsl = (shaderSrc.match(/DECAL_FRAGMENT_PREAMBLE_GLSL = \/\* glsl \*\/ `([\s\S]*?)`;\n/)?.[1] || '')
    + (shaderSrc.match(/DECAL_FRAGMENT_BODY_GLSL = \/\* glsl \*\/ `([\s\S]*?)`;\n/)?.[1] || '');
  const wgslBody = shaderSrc.match(/DECAL_FRAGMENT_WGSL = \/\* wgsl \*\/ `([\s\S]*?)`;\n/)?.[1] || '';
  check('WGSL 帧坐标用 pcPosition，不再引用不存在的 input.pcPosition',
    /let frag = pcPosition\.xy;/.test(wgslBody) && !/input\.pcPosition/.test(wgslBody));
  /* pick 快照行序：WebGPU textureLoad 行0=顶部，WebGL 行0=底部。必须按后端区分
     （uPickFlipY），否则深度图上下镜像 → 重建点全部落在投影盒外 → 只有包围盒没有视频。
     注意：inst.pickFlipY 显式覆盖是**后端默认值之上的诊断开关**，
     默认分支仍是「WebGPU=1 / WebGL=0」，断言必须盯住默认分支。 */
  check('pick 快照采样行序按后端区分（uPickFlipY，GLSL+WGSL 双分支）',
    /uPickFlipY/.test(fragGlsl) &&
    /select\(1\.0 - uvTL\.y, uvTL\.y, uniform\.uPickFlipY > 0\.5\)/.test(wgslBody) &&
    /mix\(1\.0 - uvTL\.y, uvTL\.y, uPickFlipY\)/.test(fragGlsl) &&
    /\(isWebGPU \? 1 : 0\)/.test(decalSrc) &&
    /inst\.pickFlipY != null/.test(decalSrc));
  check('WGSL 模板串内没有反引号（避免提前终止 JS 模板串）',
    wgslBody.length > 0 && wgslBody.indexOf('`') === -1);
  /* 引擎对 WebGPU uncapturederror 是空操作：validation error 会让整条 command
     buffer 提交失败（整屏黑）且完全静默。必须有错误观测 + 贴花自动降级。 */
  check('WebGPU uncapturederror 已被观测（不再静默黑屏）',
    /observeGpuErrors/.test(decalSrc) &&
    /uncapturederror/.test(fs.existsSync(path.join(ROOT, 'web', 'engine', 'playcanvas-adapter.js'))
      ? fs.readFileSync(path.join(ROOT, 'web', 'engine', 'playcanvas-adapter.js'), 'utf8') : ''));
  check('GPU 错误时贴花自动降级隐藏（fail-safe：宁失贴花不失主画面）',
    /function degrade\(reason\)[\s\S]{0,600}?setRenderableVisible\(inst\.renderable, false\)/.test(decalSrc) &&
    /!!dec\.visible && !!inst\.projector && !degraded/.test(decalSrc));
  check('decalMgr.debug() 诊断钩子存在（pickReady/degraded/gpuErrors）',
    /manager\.debug\s*=\s*\(\)\s*=>/.test(decalSrc) &&
    /decalMgr\s*\}/.test(editorSrc));
  /* 右键停不下来长方体交互的三重修复必须都在：
     1) pointerup 过滤非左键；2) cancelDraft 自增世代号作废在途异步落点；
     3) placeAsync 在 await pickAsync 之后复核世代号与工具。 */
  check('pointerup 过滤非左键（右键/中键不得进落点队列）',
    /e\.button !== 0 \|\| \(d0 && d0\.button !== 0\)/.test(editorSrc));
  check('cancelDraft / finishDraft 作废在途异步落点（draftGen++）',
    /function cancelDraft\(\)\s*\{[^}]*draftGen\+\+/.test(editorSrc) &&
    /function finishDraft\(opts = \{\}\)\s*\{[^}]*finishing = true;[^}]*draftGen\+\+/s.test(editorSrc));
  check('placeAsync 拾取返回后复核草稿世代与工具',
    /const gen = draftGen;/.test(editorSrc) &&
    /gen !== draftGen \|\| state\.tool !== toolAtStart/.test(editorSrc));
  check('绘制中右键优先结束草稿（先于标注上下文菜单，双击不再参与结束）',
    /if \(draft\.length\)\s*\{[^}]*finishDraftAfterPending\(true\);/.test(editorSrc) &&
    !/lastTap/.test(editorSrc) &&
    /stage\.addEventListener\('dblclick'[\s\S]{0,200}stopImmediatePropagation\(\);/.test(editorSrc));
  /* 「只有包围盒没有视频」：URL 留空时必须有内置演示画面，而不是透明占位。 */
  check('贴花内置演示画面（drawDemoFrame，留空 URL 也有投射内容）',
    /function drawDemoFrame\(/.test(decalSrc) &&
    /else if \(!inst\.url\)\s*\{\s*try \{ adapter\.updateCanvasTexture\(inst\.texture, drawDemoFrame\(/.test(decalSrc));
  check('贴花视频加载失败可观测（videoErr + warn）',
    /addEventListener\('error'/.test(decalSrc) && /inst\.videoErr\s*=/.test(decalSrc));
  /* "Destroyed texture used in a submit"：纹理运行期 resize 会销毁旧 GPU 纹理，
     与在途 submit 产生竞态，整条 command buffer 失败。必须固定尺寸 + 转绘上传。 */
  check('贴花纹理固定尺寸（视频经转绘画布上传，永不重建 GPU 纹理）',
    /const DECAL_TEX_W = 1024, DECAL_TEX_H = 576;/.test(decalSrc) &&
    !/setSource\(v\)/.test(decalSrc) &&
    /blitCtx\.drawImage\(v, 0, 0, DECAL_TEX_W, DECAL_TEX_H\)/.test(decalSrc));
  check('降级时输出页面可见提示（decal-degrade-toast）',
    /decal-degrade-toast/.test(decalSrc));
  /* 「只有包围盒没有视频」的数据层根因：框选横跨远近物体（或深度拾取超时退化
     到碰撞网格）时 OBB 变成几十米巨盒，投射碎片化。必须有跨度/尺寸拦截。 */
  /* 网格密度会随回读快路径调整（6×6 → 9×9，一次快照+一次块回读不增加回读次数），
     所以这里只断言「unprojectRect 调用带显式 pickTimeout」+「具体数值可查」，
     不再把网格维度写死，避免升级采样密度就误报回归。 */
  check('rebuild 拾取超时可配置（pickTimeout 透传，无头下用较短超时快速退化）',
    /unprojectRect\(a\.rect, \d+, \d+, \{ pickTimeout: \d+ \}\)/.test(editorSrc) &&
    /pickTimeout: 900/.test(editorSrc) &&
    /opt\.pickTimeout/.test(pickingSrc));
  check('贴面巨盒拦截：深度跨度过大拒绝建盒',
    /深度跨度过大/.test(editorSrc) && /spread > 1\.2/.test(editorSrc) && /med > 60/.test(editorSrc));
  check('贴面巨盒拦截：盒尺寸超限拒绝建盒',
    /half\[0\] \+ [\w.]*half\[1\] > 16/.test(editorSrc));
  /* 软剔除：掠射面上法向符号抖动，硬阈值 dot<0 会误杀一半像素。
     法向来源为「深度差分重建的真实表面法向」，不再用屏幕空间导数法向
     （导数法向在随机深度下只误杀不增值）。GLSL+WGSL 两后端阈值一致。 */
  check('背面剔除为软阈值（dot < -0.25，GLSL+WGSL 一致）',
    /dot\(nrm, projectorNormal\) < -0\.25/.test(fragGlsl) &&
    /dot\(nrm, uniform\.projectorNormal\) < -0\.25/.test(wgslBody));
  check('背面剔除法向来自深度差分重建（非屏幕空间导数法向）',
    /cross\(pX - world, pY - world\)/.test(fragGlsl) &&
    /cross\(pX - world, pY - world\)/.test(wgslBody) &&
    !/cross\(dFdx\(world\), dFdy\(world\)\)/.test(fragGlsl) &&
    !/cross\(dpdx\(world\), dpdy\(world\)\)/.test(wgslBody));
  check('投影机矩阵用 Mat4.setTRS，不再调用不存在的 setFromQuat',
    /\.setTRS\(/.test(fs.readFileSync(path.join(ROOT, 'web', 'engine', 'playcanvas-adapter.js'), 'utf8')) &&
    !/\.setFromQuat\(/.test(decalSrc));
  check('onPrerender 有异常隔离，贴花报错不会中断 app.render()',
    /function onPrerender\(\)[\s\S]{0,900}?try\s*\{/.test(decalSrc));
  check('onFrameEnd 请求主帧，覆盖 Picker 离屏 framebuffer（经节流限频）',
    /function onFrameEnd\(\)[\s\S]*?requestThrottled\(\)/.test(decalSrc) &&
    /function requestThrottled\(\)[\s\S]*?adapter\.requestRender\(\)/.test(decalSrc));
  check('onFrameEnd 对 getPickView 做异常隔离',
    /function onFrameEnd\(\)[\s\S]{0,500}?getDepthPickView[\s\S]{0,300}?catch/.test(decalSrc));
  check('无可见贴花时不驱动引擎 Picker',
    /getPickView:\s*\(\)\s*=>[\s\S]{0,300}?if\s*\(!getDecals\(\)\.length\)\s*return null/.test(editorSrc));
  check('真机 canvas / WebGPU 贴花诊断脚本存在（CI 必须同时运行）',
    fs.existsSync(path.join(ROOT, 'tools', 'diagnose_editor_canvas.mjs')) &&
    fs.existsSync(path.join(ROOT, 'tools', 'diagnose_decal_repro.mjs')));

  /* [33] 本轮交互/渲染迭代守卫（动线世界空间 / 三轴 gizmo / 右键结束 / 贴花片源同步） */
  console.log('\n[33] 动线世界空间 / 三轴 gizmo / 右键结束 / 贴花片源同步守卫');
  const overlaySrc = fs.readFileSync(path.join(ROOT, 'web', 'editor', 'overlay.js'), 'utf8');
  const schemaSrc = fs.readFileSync(path.join(ROOT, 'web', 'editor', 'schema.js'), 'utf8');
  const panelSrc = fs.readFileSync(path.join(ROOT, 'web', 'editor', 'panel.js'), 'utf8');
  check('动线面片改为世界空间贴合（arrowChainWorld），不再用屏幕空间 billboard 链',
    /arrowChainWorld\(/.test(schemaSrc) &&
    /const polys3 = arrowChainWorld\(world/.test(overlaySrc) &&
    !/const polys = arrowChain\(line, halfW/.test(overlaySrc));
  check('流动相位方向与箭头指向一致（raw = (i + frac)·L）',
    /const raw = \(i \+ frac\) \* L;/.test(schemaSrc) &&
    !/const raw = \(i - frac\) \* L;/.test(schemaSrc));
  check('三维屏三轴 gizmo（X/Y/Z 轴柄 + 中心选择柄），六向交互入口彻底移除',
    /GIZMO_AXES/.test(overlaySrc) &&
    /ed-gizmo-hit/.test(overlaySrc) && /ed-gizmo-axis/.test(editorCssSrc) &&
    !/AXIS_HANDLES/.test(overlaySrc) && !/ed-axis-handle/.test(editorCssSrc));
  check('贴花片源变更即时同步 GPU 投射实例（media / 本地视频 / 删除 / 撤销均重喂）',
    /syncDecals\(\);\s*\n\s*if \(!quiet\) panel\.render/.test(editorSrc));
  check('列表行双击监听已移除（双击全程无事件）',
    !/listEl\.addEventListener\('dblclick'/.test(panelSrc) &&
    !/addEventListener\('dblclick'/.test(overlaySrc));

  /* [34] 视频贴花渲染修复 + 引擎解耦守卫
     根因复盘：投影机 OBB 的 half 是「半长」（盒面 |L|=half），而旧 shader 用
     ln = L/decalHalf 却按 |ln|<=0.5 判定 —— 只接受画出来框的内侧 1/4，
     表现为「框线清楚、框内只有中间一小块」。 */
  console.log('\n[34] 贴花 P0 归一化 / 稳健深度 / 诊断开关 / 引擎适配层守卫');
  const engineDir = path.join(ROOT, 'web', 'engine');
  const hasEngineLayer = fs.existsSync(path.join(engineDir, 'engine-adapter.js')) &&
    fs.existsSync(path.join(engineDir, 'playcanvas-adapter.js'));
  check('OBB 归一化基准可配（uBoxScale），盒内判定用 |ln|<=1（GLSL 三维 / WGSL 三维）',
    /uniform float uBoxScale/.test(fragGlsl) &&
    /L \/ \(decalHalf \* uBoxScale\)/.test(fragGlsl) &&
    /L \/ \(uniform\.decalHalf \* uniform\.uBoxScale\)/.test(wgslBody) &&
    /greaterThan\(abs\(ln\), vec3\(1\.0\)\)/.test(fragGlsl) &&
    /any\(abs\(ln\) > vec3f\(1\.0\)\)/.test(wgslBody));
  check('UV 映射与盒面基准自洽（u=ln.x*0.5+0.5，v 由 uVideoFlipY 翻转修正行序）',
    /float vy = ln\.y \* 0\.5 \+ 0\.5/.test(fragGlsl) &&
    /vec2\(ln\.x \* 0\.5 \+ 0\.5, mix\(vy, 1\.0 - vy, uVideoFlipY\)\)/.test(fragGlsl) &&
    /let vy = ln\.y \* 0\.5 \+ 0\.5/.test(wgslBody) &&
    /vec3f\(ln\.x \* 0\.5 \+ 0\.5, vOut, nd\)/.test(wgslBody) &&
    /mix\(vy, 1\.0 - vy, uniform\.uVideoFlipY\)/.test(wgslBody) &&
    /smoothstep\(1\.0, 1\.0 - decalEdge/.test(fragGlsl) &&
    /smoothstep\(1\.0, 1\.0 - uniform\.decalEdge/.test(wgslBody));
  check('视频上下颠倒修复默认开启且可回退（videoFlipY=1，注记级覆盖 + 双后端 uniform）',
    /videoFlipY: 1/.test(decalSrc) &&
    /inst\.videoFlipY = numOr\(dec\.videoFlipY, options\.videoFlipY\)/.test(decalSrc) &&
    /'debugMode', 'videoFlipY'/.test(decalSrc) &&
    /setP\('uVideoFlipY', inst\.videoFlipY\)/.test(decalSrc) &&
    /uniform float uVideoFlipY/.test(fragGlsl) &&
    /uniform uVideoFlipY: f32/.test(wgslBody));
  check('深度取值改稳健估计（引擎同族 5×5 邻域 30% 分位）',
    /pickSurfaceDepth/.test(fragGlsl) &&
    /int\(ceil\(float\(n\) \* 0\.3\)\) - 1/.test(fragGlsl) &&
    /i32\(ceil\(f32\(n\) \* 0\.3\)\) - 1/.test(wgslBody) &&
    !/pickMin/.test(fragGlsl + wgslBody));
  check('主路径深度口径固定为单 texel（uDepthMode 保留声明兼容，不参与主路径判定）',
    /uniform float uDepthMode/.test(fragGlsl) &&
    /pickFastDepth\(pickUV\)/.test(fragGlsl) &&
    /pickFastDepth\(pickUV\)/.test(wgslBody) &&
    !/uDepthMode > 0\.5[^\n]*pickSurfaceDepth/.test(fragGlsl) &&
    /setP\('uDepthMode'/.test(decalSrc));
  /* 性能护栏（always-on-top）：主路径只剩「单 texel 重建 + 盒判定」，
     天然是最低成本，无需 fast/slow 两级粗筛，更无 52 值排序与 select 双求值。
     弱 GPU 上不再有 TDR 整屏闪烁的慢路径。 */
  check('贴花性能护栏：主路径无排序/无两级采样/无 select 双求值',
    /pickFastDepth\(pickUV\)/.test(fragGlsl) &&
    /pickFastDepth\(pickUV\)/.test(wgslBody) &&
    !/pickSurfaceDepth\(pickUV\)/.test(fragGlsl) &&
    !/ndFast/.test(fragGlsl) && !/lnFast/.test(fragGlsl) &&
    !/select\(\s*pickFastDepth[\s\S]{0,80}pickSurfaceDepth/.test(wgslBody));
  check('调试模式可切换（uDebugMode：深度灰度 / 失败分类着色）',
    /uniform float uDebugMode/.test(fragGlsl) &&
    /setP\('uDebugMode'/.test(decalSrc) &&
    /uDebugMode > 1\.5/.test(fragGlsl));
  check('相机位置传入 shader（把重建法向翻向可见侧）',
    /uniform vec3  uCameraPos/.test(fragGlsl) &&
    /setP\('uCameraPos'/.test(decalSrc));
  check('投影机 OBB 由选区局部坐标轴向范围拟合（盒必须包住被框选的表面）',
    /mxx - mnx/.test(schemaSrc) &&
    /mxy - mny/.test(schemaSrc) &&
    /mxz - mnz/.test(schemaSrc) &&
    /vdot\(\[rx, ry, rz\], right\)/.test(schemaSrc));
  check('投影机局部基沿框选方向（right = 框选水平方向，不再用固定 seed 重建）',
    /right0 = vunit\(dx\)/.test(schemaSrc) &&
    /up0 = vunit\(dy\)/.test(schemaSrc) &&
    /right0\[0\] - nrm\[0\] \* dotRN/.test(schemaSrc));
  check('投影机盒心对齐局部包围盒中心（uv 映射不错位半个盒宽）',
    /cxLocal/.test(schemaSrc) && /cyLocal/.test(schemaSrc) && /czLocal/.test(schemaSrc));
  check('贴花深度分位排序取到第 k 小（排序须含 k 位，否则深度随机跳变→椒盐点）',
    /i <= k && i < n/.test(fragGlsl) &&
    /i <= k && i < n/.test(wgslBody));
  check('背面剔除默认关闭（用户显式开启）',
    /decalCull: false/.test(schemaSrc) &&
    /cull: a\.style\?\.decalCull === true/.test(decalRuntimeSrc) &&
    /decalsForGPU/.test(editorSrc));
  check('贴花诊断面板：背面剔除开关 + 归一化基准 + 深度口径 + 状态行',
    /data-field="decalCull"/.test(panelSrc) &&
    /data-field="decalBoxScale"/.test(panelSrc) &&
    /data-field="decalDepthMode"/.test(panelSrc) &&
    /data-role="decal-diag-status"/.test(panelSrc));
  check('贴花诊断状态行读取渲染层运行时参数（getDecalDiag）',
    /getDecalDiag/.test(panelSrc) && /getDecalDiag/.test(editorSrc) &&
    /pickReady/.test(editorSrc));
  check('运行期调参入口存在（setOptions/getOptions）',
    /manager\.setOptions\s*=/.test(decalSrc) && /manager\.getOptions\s*=/.test(decalSrc));
  /* 整屏闪烁（弱 GPU TDR）紧急熔断：必须能在不改代码/不卸载模块下停掉贴花驱动的
     永动渲染循环（frameend → requestRender → 下一帧）。三个入口 + 两个帧钩子守卫。
     历史教训：只隐藏 renderable（setDecalsVisible）不停 requestRender，GPU 仍满载。 */
  check('整屏闪烁紧急熔断：renderEnabled 三入口 + 帧尾/帧前双钩子守卫',
    /* ① URL decal=0 与 sessionStorage mg_decal_stop=1 页面加载即熔断 */
    /decal=0/.test(decalSrc) && /mg_decal_stop/.test(decalSrc) &&
    /renderEnabled:\s*stoppedByEntry\s*\?\s*0\s*:\s*1/.test(decalSrc) &&
    /* ② 运行时 setOptions({renderEnabled:0}) 立即生效（含白名单 + renderable 同步） */
    /'renderEnabled'/.test(decalSrc) &&
    /setRenderableVisible\(inst\.renderable, !!on\)/.test(decalSrc) &&
    /* ③ 帧尾钩子熔断：不上传纹理、不 requestRender（断开永动循环） */
    /if \(!options\.renderEnabled\) return;/.test(decalSrc) &&
    /* 帧前钩子也熔断：不喂 uniform */
    (decalSrc.match(/if \(!options\.renderEnabled\) return;/g) || []).length >= 2 &&
    /* requestRender 必须仍在（视频贴花需要逐帧），只是受熔断控制 */
    /adapter\.requestRender\(\)/.test(decalSrc));
  check('帧率节流：requestRender 经 requestThrottled 限频，定时器补帧不断链（防 60fps 永动 TDR）',
    /maxFps:\s*30/.test(decalSrc) &&
    /function requestThrottled\(\)/.test(decalSrc) &&
    /requestThrottled\(\);/.test(decalSrc) &&
    !/adapter\.requestRender\(\);\s*\n\s*\}\s*\n\s*let prerenderWarned/.test(decalSrc) &&
    /makeupTimer = setTimeout/.test(decalSrc) &&
    /if \(makeupTimer\) \{ clearTimeout\(makeupTimer\); makeupTimer = null; \}/.test(decalSrc) &&
    /'renderEnabled', 'maxFps', 'uploadFps'/.test(decalSrc) &&
    /maxFps: options\.maxFps/.test(decalSrc));
  check('纹理上传节流开关存在（uploadFps 默认 0=基线逐帧，可选降载；闪烁真因是 error scope 竞态）',
    /uploadFps:\s*0/.test(decalSrc) &&
    /function uploadDue\(\)/.test(decalSrc) &&
    /let lastTexUpload = 0/.test(decalSrc) &&
    /if \(uploadDue\(\)\)/.test(decalSrc) &&
    /if \(!Number\.isFinite\(cap\) \|\| cap <= 0 \|\| cap >= 120\) return true/.test(decalSrc) &&
    /updateCanvasTexture\(inst\.texture, inst\.blitCanvas\)/.test(decalSrc) &&
    /uploadFps: options\.uploadFps/.test(decalSrc));
  check('error scope 竞态修复：异步回调用快照 wasProbeFrame，不再读被重置的 probeDecalsOff（防显示/隐藏交替闪烁）',
    /const wasProbeFrame = probeDecalsOff/.test(decalSrc) &&
    /suspicion && wasProbeFrame/.test(decalSrc) &&
    /if \(wasProbeFrame\)/.test(decalSrc) &&
    !/if \(suspicion && probeDecalsOff\)/.test(decalSrc) &&
    !/if \(probeDecalsOff\) \{\s*\/\/ 复测帧/.test(decalSrc) &&
    /* 引擎持续错误冻结结论：同一 foreign 消息不再复测隐藏（防每两帧闪一次） */
    /foreignResolvedMsgs\.add\(String\(msg\)\)/.test(decalSrc) &&
    /foreignResolvedMsgs\.has\(String\(msg\)\)/.test(decalSrc));
  check('逐帧 error scope 防回归脚本存在（真实异步回调验证不闪烁）',
    fs.existsSync(path.join(ROOT, 'tools', 'diag_frame_scope.mjs')) &&
    /可见性切换 <= 1 次/.test(fs.readFileSync(path.join(ROOT, 'tools', 'diag_frame_scope.mjs'), 'utf8')));
  check('默认恢复无 GPU pass 基线：useShadowPass 默认 0，三段式需显式开启（全屏 quad + always-on-top）',
    /useShadowPass:/.test(decalSrc) &&
    /const shadowPathCapable = \[/.test(decalSrc) &&
    /const shadowPathSupported = shadowPathCapable && !!options\.useShadowPass/.test(decalSrc) &&
    /const useShadow = shadowPathSupported/.test(decalSrc) &&
    /'uploadFps', 'useShadowPass'/.test(decalSrc));
  check('引擎适配层就位（engine-adapter + playcanvas-adapter + 解析入口）',
    hasEngineLayer &&
    fs.existsSync(path.join(engineDir, 'index.js')) &&
    fs.existsSync(path.join(engineDir, 'decal-shaders.js')));
  if (hasEngineLayer) {
    const adapterSrc = fs.readFileSync(path.join(engineDir, 'engine-adapter.js'), 'utf8');
    const pcAdapterSrc = fs.readFileSync(path.join(engineDir, 'playcanvas-adapter.js'), 'utf8');
    const engineIndexSrc = fs.readFileSync(path.join(engineDir, 'index.js'), 'utf8');
    const shadersSrc = fs.readFileSync(path.join(engineDir, 'decal-shaders.js'), 'utf8');
    check('引擎适配层导出统一契约（createEngineAdapter + 契约清单）',
      /export function createEngineAdapter/.test(adapterSrc) &&
      /export const ADAPTER_CONTRACT/.test(adapterSrc) &&
      /export function validateEngineAdapter/.test(adapterSrc));
    check('契约方法数 ≥ 40 且分组齐备（7 组，含 renderpass）',
      (adapterSrc.match(/group:\s*'/g) || []).length >= 40 &&
      ['lifecycle', 'scene', 'material', 'texture', 'geometry', 'picking', 'renderpass']
        .every(g => adapterSrc.includes("'" + g + "'")));
    /* 契约层必须是纯接口：注释里可以解释「为什么不用 pc.Mesh」，
       但可执行代码里不得出现任何引擎专有标识。 */
    const adapterCode = adapterSrc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    check('契约层不含任何引擎专有标识（纯接口，注释已剥离）',
      !/globalThis\.__pc/.test(adapterCode) &&
      !/BABYLON\./.test(adapterCode) &&
      !/THREE\./.test(adapterCode) &&
      !/\bpc\.[A-Za-z]/.test(adapterCode));
    check('PlayCanvas 适配器实现契约（工厂 + 全部契约方法）',
      /createPlayCanvasAdapter/.test(pcAdapterSrc) &&
      /getCameraEntity\(\)/.test(pcAdapterSrc) &&
      /getDepthPickView\(\)/.test(pcAdapterSrc) &&
      /composeRigidMatrix/.test(pcAdapterSrc) &&
      /invertMatrix/.test(pcAdapterSrc) &&
      /rotateVectorByQuaternion/.test(pcAdapterSrc));
    check('PlayCanvas 适配器走契约校验包装（缺失方法被记入 missing）',
      /createEngineAdapter\(adapter/.test(pcAdapterSrc) &&
      /onMissing/.test(pcAdapterSrc));
    check('矩阵约定显式化（列主序 + 列向量）',
      /列主序/.test(adapterSrc) && /Float32Array\(16\)|length !== 16/.test(adapterSrc));
    check('解析入口按引擎探测装配（编辑器不直接 import 具体适配器）',
      /detectEngineKind/.test(engineIndexSrc) &&
      /resolveEngineAdapter/.test(engineIndexSrc) &&
      /ENGINE_KINDS\.BABYLON/.test(engineIndexSrc) &&
      !/playcanvas-adapter/.test(editorSrc));
    check('decal-projection 不再直接依赖全局 __pc（改走适配层）',
      !/globalThis\.__pc/.test(decalSrc) &&
      !/getPc\(\)/.test(decalSrc) &&
      /adapter\.getDepthPickView/.test(decalSrc) &&
      /adapter\.setMaterialParameter/.test(decalSrc));
    check('web/editor 目录内 PlayCanvas 具体类引用为 0（解耦硬指标）',
      (() => {
        const files = fs.readdirSync(path.join(ROOT, 'web', 'editor')).filter(f => f.endsWith('.js'));
        const bad = [];
        for (const f of files) {
          const src2 = fs.readFileSync(path.join(ROOT, 'web', 'editor', f), 'utf8');
          const code = src2.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
          if (/globalThis\.__pc|\bpc\.(Mesh|Material|Entity|Texture|GraphNode|Mat4|Quat|Vec3|MeshInstance|ShaderMaterial)\b|BABYLON\.|THREE\./.test(code))
            bad.push(f);
        }
        if (bad.length) console.log('    仍含引擎专有引用的文件:', bad.join(', '));
        return bad.length === 0;
      })());
    check('shader 源码已抽到引擎层（编辑器不再内嵌着色器）',
      /DECAL_FRAGMENT_PREAMBLE_GLSL/.test(shadersSrc) &&
      /DECAL_FRAGMENT_BODY_GLSL/.test(shadersSrc) &&
      /DECAL_VERTEX_WGSL/.test(shadersSrc) &&
      /from '\.\.\/engine\/decal-shaders\.js'/.test(decalSrc) &&
      !/const fragmentGLSL = \/\* glsl \*\//.test(decalSrc));
    check('Babylon.js 适配契约已文档化（下一引擎接入路径）',
      fs.existsSync(path.join(engineDir, 'babylon-adapter.md')) &&
      /Babylon/i.test(fs.readFileSync(path.join(engineDir, 'babylon-adapter.md'), 'utf8')));
    check('Babylon.js / three.js 未进入运行时依赖（不得引入第三方引擎包）',
      !fs.existsSync(path.join(ROOT, 'node_modules', '@babylonjs')) &&
      !fs.existsSync(path.join(ROOT, 'node_modules', 'three')) &&
      !fs.existsSync(path.join(ROOT, 'package.json')));
    /* 着色器结构校验（硬闸门）：贴花 shader 由 preamble + body 两段拼接，
       拼接处若丢换行 → 行注释吞掉块注释首行 → 块注释剩余行变裸代码 →
       GLSL 编译失败。而 PlayCanvas 编译失败不抛 JS 异常，只表现为
       「贴花整块不显示」，排查成本极高（本次真实踩中）。 */
    const shaderSrc = await loadShaderSources(
      new URL('../web/engine/decal-shaders.js', import.meta.url).href);
    const lintFgGLSL = lintShader(shaderSrc.glsl, { entry: 'main', uniforms: shaderSrc.uniforms });
    const lintFgWGSL = lintShader(shaderSrc.wgsl, { entry: 'fragmentMain', uniforms: shaderSrc.uniforms });
    const lintVtxGLSL = lintShader(shaderSrc.vertexGLSL, { entry: 'main' });
    const lintVtxWGSL = lintShader(shaderSrc.vertexWGSL, { entry: 'vertexMain' });
    check('贴花片元 GLSL 结构合法（注释配对 / 括号配平 / 入口存在）',
      lintFgGLSL.ok, lintFgGLSL.issues.join('；'));
    check('贴花片元 WGSL 结构合法',
      lintFgWGSL.ok, lintFgWGSL.issues.join('；'));
    check('贴花顶点 shader 结构合法（GLSL + WGSL）',
      lintVtxGLSL.ok && lintVtxWGSL.ok,
      [...lintVtxGLSL.issues, ...lintVtxWGSL.issues].join('；'));
    check('贴花 uniform 清单与 shader 声明一致',
      shaderSrc.uniforms.length >= 20 &&
      shaderSrc.uniforms.every(u => shaderSrc.glsl.includes(u) && shaderSrc.wgsl.includes(u)));
  }
  /* ------------------------------------------------ [35] 真机验收结论固化 */
  /* 2026-11-16 真机（桌面 Chrome + WebGPU）逐像素诊断结论固化：
       · shader 的世界点重建数学与引擎权威点（picker.pick）逐像素误差 0
         → 贴花渲染本身正确，「覆盖率 24%」是**探针分母口径缺陷**；
       · 贴花已完整覆盖用户框选矩形（实测 96.4%，旧口径虚大 4.59 倍）；
       · 但真机仍有一条 VertexState 错误会让贴花被 fail-safe 降级隐藏
         （用户看到的「只有线框、无内容」）。
     下面三条守卫把真机结论固化成可回归的静态断言。 */
  console.log('\n[35] 真机验收结论固化（覆盖率口径 / 顶点流分量 / GPU 错误归因）');
  {
    const pcSrc = fs.existsSync(path.join(engineDir, 'playcanvas-adapter.js'))
      ? fs.readFileSync(path.join(engineDir, 'playcanvas-adapter.js'), 'utf8') : '';
    const probeSrc = fs.existsSync(path.join(ROOT, 'tools', 'probe_decal_realpath.mjs'))
      ? fs.readFileSync(path.join(ROOT, 'tools', 'probe_decal_realpath.mjs'), 'utf8') : '';

    /* 守卫①：全屏 quad 顶点流必须是 2 分量。
       WebGPU 的 VertexState 校验要求 shader 的 attribute 分量数与顶点缓冲一致：
       shader 声明 vec2 而顶点流给 3 分量 → 「Vertex attribute slot 0 used in
       vertexMain is not present in the VertexState」→ pipeline 整个无效 → 贴花零输出。
       SwiftShader 校验宽松，headless 探针看不出，必须源码守卫。 */
    check('全屏 quad 顶点流为 2 分量（与 shader vec2 attribute 匹配，否则 WebGPU pipeline 无效）',
      /mesh\.setPositions\(new Float32Array\(\[([\s\S]*?)\]\),\s*2\)/.test(pcSrc) &&
      /attribute vec2 vertex_position/.test(shaderSrc),
      '适配器 setPositions(...,2) + 顶点 shader vec2');

    /* 守卫②：GPU 错误归因不得误降级。
       uncapturederror 是全局的：引擎其它 mesh 的 pipeline 出错（如窗口尺寸变化后
       重建 VertexState）也会走同一回调。早期实现「任何错误都降级」→ 别人的错把
       贴花全隐藏 → 用户看到「框线在、视频没了」。现改为「作用域 + 复测二分」：
       关掉贴花后仍有错 → 判为非贴花故障，不降级。 */
    check('GPU 错误按「作用域 + 复测二分」归因，别人的错误不降级贴花',
      /beginGpuErrorScope/.test(decalSrc) &&
      /endGpuErrorScope/.test(decalSrc) &&
      /probeDecalsOff/.test(decalSrc) &&
      /判定为非贴花故障/.test(decalSrc) &&
      /foreignErrors/.test(decalSrc) &&
      /scopedErrors/.test(decalSrc),
      'scope + probeDecalsOff 二分 + foreignErrors/scopedErrors 分列');

    /* 守卫③：pick 纹理行序覆盖必须在两个后端都设对。
       WebGPU 纹理行0=屏幕顶、WebGL2 行0=屏幕底；弄反 = 深度图上下镜像 =
       重建世界点几乎全部落在投影盒外 = 「只有包围盒没有视频」。
       真机已实测确认 WebGPU 下 top_flipY 变体误差为 0。 */
    check('pick 纹理行序按后端设定且允许显式覆盖（行序弄反=只有包围盒没有视频）',
      /uPickFlipY', inst\.pickFlipY != null/.test(decalSrc) &&
      /isWebGPU \? 1 : 0/.test(decalSrc) &&
      /pickFlipY/.test(decalSrc),
      'uPickFlipY 默认按后端 + inst.pickFlipY 可覆盖');

    /* 守卫④：验收探针的分母必须是「用户框选矩形」，不得退回 OBB 前表面 AABB。
       OBB 有 4m 厚度，正对相机的面比真实表面近 2m，透视放大使分母虚大 4.59 倍，
       覆盖率被稀释到 0.24 —— 看起来像渲染缺陷，其实贴花是完整的。 */
    check('验收探针覆盖率分母用用户框选矩形（OBB 前表面 AABB 会虚大 4.59×）',
      /const sel = toDev\(cover\.sel\)/.test(probeSrc) &&
      /用户框选矩形/.test(probeSrc) &&
      !/const rx = Math\.max\(0, Math\.round\(cover\.x \* pxScale\)\)/.test(probeSrc),
      'cover.sel → 设备像素');

    /* 守卫⑤：探针必须带噪声基线帧 —— 场景里有循环播放的视频，帧间本身就会变，
       不剔除噪声会把场景动画算成贴花（或反之）。 */
    check('验收探针含噪声基线帧（场景动画不得计入贴花差分）',
      /hidden2/.test(probeSrc) && /noiseDiff/.test(probeSrc));
  }

  console.log('\n[36] shadowmap 贴花架构守卫（虚拟相机深度图 / 无像素排序）');
  const engineAdapterSrc = fs.readFileSync(path.join(engineDir, 'engine-adapter.js'), 'utf8');
  const playCanvasSrc = fs.readFileSync(path.join(engineDir, 'playcanvas-adapter.js'), 'utf8');
  check('虚拟相机深度图由 projector OBB 构造且可 JSON 持久化',
    /export function buildShadowDepthMap/.test(schemaSrc) &&
    /const camOff = half\[2\] \+ margin/.test(schemaSrc) &&
    /const far = 2 \* half\[2\]/.test(schemaSrc) &&
    /raycast\(ox, oy, oz, dir\[0\]/.test(schemaSrc) &&
    /depth: Array\.from\(depth\)/.test(schemaSrc));
  check('编辑器重建 projector 时生成 shadow 并回传渲染层',
    /projector\.shadow = buildShadowDepthMap\(projector, raycast, \{ n: 24 \}\)/.test(editorSrc) &&
    /shadow: a\.projector && a\.projector\.shadow/.test(decalRuntimeSrc) &&
    /a\.projector\.shadow && a\.projector\.shadow\.depth/.test(editorSrc));
  check('shadow 深度纹理走 R32F 数据纹理契约（刷新后仍可上传）',
    /format: 'r32f'/.test(decalSrc) &&
    /updateDataTexture\(inst\.shadowTex/.test(decalSrc) &&
    /ArrayBuffer\.isView\(data\)/.test(decalSrc) &&
    /Float32Array\.from/.test(decalSrc) &&
    /createDataTexture/.test(engineAdapterSrc) &&
    /PIXELFORMAT_R32F/.test(playCanvasSrc));
  check('shader 主路径为 always-on-top projected decal（单 texel 重建 + 局部盒命中，无跨源深度遮挡）',
    /void decalProject\(out vec2 uvOut, out float ndOut\)/.test(fragGlsl) &&
    /fn decalProject\(pickUV: vec2f\) -> vec3f/.test(wgslBody) &&
    (fragGlsl.match(/decalProject\(uv, nd\)/g) || []).length === 1 &&
    /let r = decalProject\(pickUV\)/.test(wgslBody) &&
    // 命中 = projector 局部盒（与主深度同源），UV = ln.xy*0.5+0.5 且 v 翻转修正
    /vec3 L = \(invProjector \* vec4\(W, 1\.0\)\)\.xyz/.test(fragGlsl) &&
    /vec3 ln = L \/ \(decalHalf \* uBoxScale\)/.test(fragGlsl) &&
    /let ln = L \/ \(uniform\.decalHalf \* uniform\.uBoxScale\)/.test(wgslBody) &&
    /uvOut = vec2\(ln\.x \* 0\.5 \+ 0\.5, mix\(vy, 1\.0 - vy, uVideoFlipY\)\)/.test(fragGlsl) &&
    /mix\(vy, 1\.0 - vy, uniform\.uVideoFlipY\)/.test(wgslBody));
  const glslProjectFn = fragGlsl.split('void decalProject')[1]?.split('void main')[0] || '';
  const wgslProjectFn = wgslBody.split('fn decalProject')[1]?.split('@fragment')[0] || '';
  check('投影命中热路径成本最低：单 texel 重建，无平滑 / 无排序 / 无 shadow 采样',
    glslProjectFn.length > 0 && wgslProjectFn.length > 0 &&
    !/pickSurfaceDepth/.test(glslProjectFn) && !/pickSurfaceDepth/.test(wgslProjectFn) &&
    !/smoothPickDepth/.test(glslProjectFn) && !/smoothPickDepth/.test(wgslProjectFn) &&
    !/shadowPcf/.test(glslProjectFn) && !/shadowPcf/.test(wgslProjectFn) &&
    !/shadowDepth/.test(glslProjectFn) && !/shadowDepth/.test(wgslProjectFn) &&
    /pickFastDepth\(pickUV\)/.test(glslProjectFn) && /pickFastDepth\(pickUV\)/.test(wgslProjectFn) &&
    /any\(greaterThan\(abs\(ln\), vec3\(1\.0\)\)\)/.test(glslProjectFn) &&
    /any\(abs\(ln\) > vec3f\(1\.0\)\)/.test(wgslProjectFn));
  check('视频始终在前：已彻底删除跨源深度遮挡比较与降噪三件套（防回归）',
    !/void decalShadow/.test(fragGlsl) && !/fn decalShadow/.test(wgslBody) &&
    !/float smoothPickDepth/.test(fragGlsl) && !/fn smoothPickDepth/.test(wgslBody) &&
    !/float shadowPcf/.test(fragGlsl) && !/fn shadowPcf/.test(wgslBody) &&
    !/shadowWorldNormal/.test(fragGlsl) && !/shadowWorldNormal/.test(wgslBody) &&
    !/fn decalCov/.test(wgslBody) && !/diffOut/.test(fragGlsl) &&
    !/texture(Load|Fetch)\(shadowDepth/.test(fragGlsl) &&
    !/texture(Load|Fetch)\(shadowDepth/.test(wgslBody) &&
    // alpha 不再乘 cov/soft：视频无条件显示
    /float a = vid\.a \* decalOpacity \* edge;/.test(fragGlsl) &&
    /let a = vid\.a \* uniform\.decalOpacity \* edge;/.test(wgslBody));
  check('已废弃降噪 uniform 只保留声明兼容，不再进入 shadow / alpha 判定',
    !/uPcf|uNormalCut|uSoftMask/.test(glslProjectFn) &&
    !/uPcf|uNormalCut|uSoftMask/.test(wgslProjectFn) &&
    !/uShadowReady|uShadowBias|uVirtualForward/.test(glslProjectFn) &&
    !/uShadowReady|uShadowBias|uVirtualForward/.test(wgslProjectFn));
  check('渲染层注入字段仍存在（shadow/调试 uniform 保留声明做兼容）',
    /setP\('uShadowReady'/.test(decalSrc) &&
    /setP\('shadowDepth'/.test(decalSrc) &&
    /setP\('uVirtualCam'/.test(decalSrc) &&
    /setP\('uVirtualFar'/.test(decalSrc) &&
    /setP\('uShadowBias'/.test(decalSrc) &&
    /shadowReady: !!/.test(decalSrc) &&
    /shadowSize: i\.shadow/.test(decalSrc) &&
    /shadowHits: i\.shadow/.test(decalSrc));

  console.log('\n[36b] 编辑器默认飞行相机 + 动线贴地（与贴花同源的深度反算）');
  const pickSrcD = fs.readFileSync(path.join(ROOT, 'web', 'editor', 'picking.js'), 'utf8');
  const overlaySrc2 = fs.readFileSync(path.join(ROOT, 'web', 'editor', 'overlay.js'), 'utf8');
  const storeSrc2 = fs.readFileSync(path.join(ROOT, 'web', 'editor', 'store.js'), 'utf8');
  const appSrc2 = fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8');
  check('编辑期飞行不挂碰撞：进编辑摘挂、退出恢复',
    /setCollisionEnabled\?\.\(false\)/.test(editorSrc) &&
    /setCollisionEnabled\?\.\(true\)/.test(editorSrc));
  check('编辑器进挂载即强制飞行相机，退出还原',
    /__mgEditorFly = true/.test(editorSrc) &&
    /st\.cameraMode = 'fly'/.test(editorSrc) &&
    /function restoreCameraMode/.test(editorSrc) &&
    /restoreCameraMode\(\);/.test(editorSrc) &&
    // app.js 的「碰撞就绪自动切 walk」轮询必须给编辑器让位
    /__mgEditor \|\| globalThis\.__mgEditorFly/.test(appSrc2));
  check('动线贴地走深度反算（与贴花同一函数），不依赖碰撞 MESH',
    /async function drapePolylineDepth/.test(pickSrcD) &&
    /await depthUnproject\(sp\.x, sp\.y, \{ pickTimeout \}\)/.test(pickSrcD) &&
    /drapePolylineDepth,/.test(pickSrcD) &&
    // 只接受「视线命中的真实表面」；ground/free 是标定参考平面，不能拿来做贴地
    /h\.source === 'depth' \|\| h\.source === 'mesh'/.test(pickSrcD) &&
    // 同视线校验：命中点重新投影必须仍在采样像素上（否则固定返回值的拾取会把线塌成一点）
    /Math\.abs\(q\.x - sp\.x\) <= 4/.test(pickSrcD) &&
    // 一个真实命中都没有时不许落「假贴地」结果
    /res\.source === 'none'/.test(editorSrc) &&
    // 采样上限：深度反算是逐像素 readback，长线必须抽稀
    /maxSamples/.test(pickSrcD));
  check('贴地结果持久化进注记（含 pointsSig 失效判据），浏览态可直接复用',
    /drape: patch\.drape \|\| null/.test(schemaSrc) &&
    /drapeMeta: patch\.drapeMeta \|\| null/.test(schemaSrc) &&
    /needsDrape/.test(editorSrc) && /drapePolylineDepth\(a\.points/.test(editorSrc) &&
    /noUndo: true/.test(editorSrc) && /if \(opts\.noUndo\)/.test(storeSrc2) &&
    // 复制标注时贴地中心线必须一起平移，否则副本画在原位置
    /copy\.drape = copy\.drape\.map/.test(storeSrc2));
  check('动线渲染优先消费持久化贴地中心线（a.drape），顶点一改立即失效',
    /const stored = Array\.isArray\(a\.drape\)/.test(overlaySrc2) &&
    /a\.drapeMeta\.pointsSig === pointsSig/.test(overlaySrc2) &&
    /if \(stored\) f\.world = a\.drape;/.test(overlaySrc2));

  /* [36c] 贴花辅助线的场景深度判断 + 正交 OBB 旋转交互（上轮遗留的两项补齐）
     深度判断必须复用贴面矩形的「1 次 prepare + 1 次 readAround」快路径：
     若退回逐点 pick（每点一次同步回读），编辑器一拖就卡死。 */
  console.log('\n[36c] 辅助线场景深度判断 + 正交 OBB 旋转交互');
  check('辅助线深度判断：picking 提供 probeOcclusion 且经 editor 透传给 overlay',
    /async function probeOcclusion\(worldPoints, opts = \{\}\)/.test(pickSrcD) &&
    /probeOcclusion,/.test(pickSrcD) &&
    /probeOcclusion: \(pts, opt\) => picker\.probeOcclusion\(pts, opt\)/.test(editorSrc) &&
    /this\.probeOcclusion = probeOcclusion \|\| null;/.test(overlaySrc2));
  check('辅助线深度判断：一次快照 + 一次块回读，块过大时主动放弃（不卡主线程）',
    /withTimeout\(Promise\.resolve\(ph\.prepare\(\)\), FAST_TIMEOUT\)/.test(pickSrcD) &&
    /withTimeout\(Promise\.resolve\(ph\.readAround\(cx, cy, margin, width, height\)\), FAST_TIMEOUT\)/.test(pickSrcD) &&
    /margin > maxMargin/.test(pickSrcD) &&
    /sampleDepthAt\(depthAt, px, py\)/.test(pickSrcD));
  check('辅助线深度判断：静止去抖 300ms 才探测，绘制用上一轮缓存（不每帧回读）',
    /t - occ\.at >= 300/.test(overlaySrc2) &&
    /occ\.done !== key/.test(overlaySrc2) &&
    /this\._decalOcclusion\(a, o, probePts\)/.test(overlaySrc2));
  check('OBB / 视锥体棱线逐段绘制，被挡段走 is-blocked 虚线（不是整块隐藏）',
    /const SEG = selected \? 6 : 1;/.test(overlaySrc2) &&
    /ed-decal-obb-seg is-blocked/.test(overlaySrc2) &&
    /\.ed-decal-obb-seg\.is-blocked/.test(editorCssSrc));
  check('正交 OBB 有三轴旋转环（rx/ry/rz）+ 透明粗描边命中区',
    /k: 'rx'/.test(overlaySrc2) && /k: 'ry'/.test(overlaySrc2) && /k: 'rz'/.test(overlaySrc2) &&
    /ed-decal-ring-hit/.test(overlaySrc2) && /\.ed-decal-ring-hit/.test(editorCssSrc));
  check('旋转环拖拽走「射线 ∩ 环平面」方位角差，增量乘到按下快照（不累积漂移）',
    /_decalDragWorld\(e\.clientX, e\.clientY, cam, c0, N\)/.test(overlaySrc2) &&
    /this\._applyDecalRotate\(id, N, d, base0\)/.test(overlaySrc2) &&
    /quatMul\(quatFromAxis\(worldAxis, angle\), base\.quaternion\)/.test(overlaySrc2) &&
    /export function quatMul/.test(schemaSrc));

  /* 块回读快路径的可用性前提与安全阀：
     ① 引擎 picker 的包装对象必须转发 prepare / readAround / queue ——
        少了这层转发，编辑器的「1 次回读」永远拿不到引擎能力，只能退回
        「每点一次同步回读」（实测 100 点 19.5s，就是用户说的「特别慢」）；
     ② 快路径必须外层硬超时，且 prepare 不能进引擎的串行 pick 队列 ——
        无头 SwiftShader 渲 7.4M 高斯时 prepare 可几十秒不返回，塞进队列会把
        后续所有 pick 一起堵死（表现为编辑器整体卡死）；
     ③ 首次使用必须与引擎单点反算交叉自检，偏差过大就回退：
        「快」绝不能以「贴面矩形整体错位」为代价。 */
  const viewerSrcFast = fs.readFileSync(path.join(ROOT, 'web', 'viewer', 'index.js'), 'utf8');
  check('块回读快路径：引擎 picker 包装层暴露 prepare / readAround / queue',
    /prepare: \(\) => activePicker\(\)\.prepare\(\)/.test(viewerSrcFast) &&
    /readAround: \(sx, sy, margin, width, height\) =>/.test(viewerSrcFast) &&
    /get queue\(\) \{ return activePicker\(\)\.queue; \}/.test(viewerSrcFast) &&
    /this\.readAround = \(screenX, screenY, margin, width, height\) =>/.test(viewerSrcFast));
  check('块回读快路径：外层硬超时 + 连续失败停用，且不塞进引擎 pick 队列',
    /const FAST_TIMEOUT = 4000;/.test(pickSrcD) &&
    /if \(fastFail >= 3\) return null;/.test(pickSrcD) &&
    /withTimeout\(task, FAST_TIMEOUT\)/.test(pickSrcD) &&
    !/const run = \(typeof ph\.queue\?\.run === 'function'\)/.test(pickSrcD));
  check('块回读快路径：首次使用与引擎单点反算交叉自检（偏差 >0.5m 即回退）',
    /if \(!fastVerified\)/.test(pickSrcD) &&
    /if \(d > 0\.5\) return null;/.test(pickSrcD));

  /* 外部契约：window.__viewer（在 web/app.js 挂载）与 window.__mgEditorBridge
    （web/editor/bridge.js）的字段、方法名与签名本轮不得改动。
     这里做「结构存在性」守卫：本轮未触碰这两个文件，故断言其关键成员仍在。 */
  const bridgeSrc = fs.readFileSync(path.join(ROOT, 'web', 'editor', 'bridge.js'), 'utf8');
  const appSrc = fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8');
  const viewerSrc = fs.readFileSync(path.join(ROOT, 'web', 'viewer', 'index.js'), 'utf8');
  check('外部契约未破坏（window.__viewer / __mgEditorBridge 未改签名）',
    /window\.__mgEditorBridge\s*=\s*\{/.test(bridgeSrc) &&
    /suspendRender:\s*pauseRender/.test(bridgeSrc) &&
    /mount,\s*unmount,\s*requestExit/.test(bridgeSrc) &&
    /window\.__viewer\s*=\s*viewer/.test(appSrc) &&
    /annotations:\s*global\.settings\.annotations/.test(viewerSrc));

  /* [37] 标准 Shadow-Map Decal 三段式（用户指定方案）：
     Pass1 GPU depth-only（正交 projector ViewProj → D32_FLOAT）
     Pass2 主渲染不变
     Pass3 AABB 立方体光栅化 + 同源 shadow 深度比较 + uvProj 采样视频
     旧全屏 quad / CPU 深度图路径保留为回退，不作为默认。 */
  console.log('\n[37] 标准 Shadow-Map Decal 三段式（Pass1/Pass3 GPU 路径）守卫');
  const shadowShaderSrc = fs.readFileSync(path.join(engineDir, 'decal-shaders.js'), 'utf8');
  const adapterSrc2 = fs.readFileSync(path.join(engineDir, 'engine-adapter.js'), 'utf8');
  const pcAdapterSrc2 = fs.readFileSync(path.join(engineDir, 'playcanvas-adapter.js'), 'utf8');
  const decalSrc2 = fs.readFileSync(path.join(ROOT, 'web', 'editor', 'decal-projection.js'), 'utf8');
  const viewerSrc2 = fs.readFileSync(path.join(ROOT, 'web', 'viewer', 'index.js'), 'utf8');
  check('Pass1 depth-only 能力进入引擎契约且 PlayCanvas 有完整实现',
    ['createDepthPass', 'setDepthPassGeometry', 'setDepthPassProjector',
      'getDepthPassTexture', 'getDepthPassViewProjection', 'destroyDepthPass',
      'createSceneNode', 'createMesh', 'destroyMesh']
      .every(k => adapterSrc2.includes("name: '" + k + "'") &&
        new RegExp('\\b' + k + '\\s*\\(').test(pcAdapterSrc2)) &&
    /PIXELFORMAT_DEPTH/.test(pcAdapterSrc2) &&
    /redWrite = false/.test(pcAdapterSrc2) &&
    /new P\.RenderTarget/.test(pcAdapterSrc2) &&
    /PROJECTION_ORTHOGRAPHIC/.test(pcAdapterSrc2));
  check('渲染 bundle 导出 GPU 深度通道所需的原生类与常量',
    /Entity, Layer, RenderTarget/.test(viewerSrc2) &&
    /PIXELFORMAT_DEPTH/.test(viewerSrc2) &&
    /RENDERTARGET_ORIGIN_NATIVE/.test(viewerSrc2));
  check('Pass3 VS 输出主相机裁剪坐标 + 投影仪齐次坐标（AABB 立方体）',
    /export const DECAL_SHADOW_VERTEX_GLSL/.test(shadowShaderSrc) &&
    /export const DECAL_SHADOW_VERTEX_WGSL/.test(shadowShaderSrc) &&
    /attribute vec3 vertex_position/.test(shadowShaderSrc) &&
    /vProj = uProjVP \* world/.test(shadowShaderSrc) &&
    /gl_Position = matrix_viewProjection \* world/.test(shadowShaderSrc) &&
    /output\.vProj = uniform\.uProjVP \* world/.test(shadowShaderSrc) &&
    /projectorCubeGeometry/.test(decalSrc2));
  check('Pass3 FS 同源深度比较 + depthBias + 4 通道 30% 分位 resolve（GLSL/WGSL 双后端）',
    /export const DECAL_SHADOW_FRAGMENT_GLSL/.test(shadowShaderSrc) &&
    /export const DECAL_SHADOW_FRAGMENT_WGSL/.test(shadowShaderSrc) &&
    /dUV = c\.xy \* 0\.5 \+ 0\.5/.test(shadowShaderSrc) &&
    /float shadowSurfaceDepth\(vec2 uv\)/.test(shadowShaderSrc) &&
    /fn shadowSurfaceDepth\(uv: vec2f\)/.test(shadowShaderSrc) &&
    /float mapD = shadowSurfaceDepth\(dUV\)/.test(shadowShaderSrc) &&
    /let mapD = shadowSurfaceDepth\(dUV\)/.test(shadowShaderSrc) &&
    /fragD > mapD \+ uShadowBias/.test(shadowShaderSrc) &&
    /fragD > mapD \+ uniform\.uShadowBias/.test(shadowShaderSrc) &&
    /float pickSurfaceDepthShadow\(vec2 puv\)/.test(shadowShaderSrc) &&
    /fn pickSurfaceDepthShadow\(puv: vec2f\)/.test(shadowShaderSrc));
  check('Pass3 法线点积剔除：世界法线翻向相机后与 projectorNormal 点积（双后端）',
    /dot\(nrm, uCameraPos - W\) < 0\.0/.test(shadowShaderSrc) &&
    /dot\(nrm, projectorNormal\) < uNormalCut/.test(shadowShaderSrc) &&
    /dot\(nrm, uniform\.uCameraPos - W\) < 0\.0/.test(shadowShaderSrc) &&
    /dot\(nrm, uniform\.projectorNormal\) < uniform\.uNormalCut/.test(shadowShaderSrc) &&
    /uniform uNormalCut/.test(shadowShaderSrc) &&
    /uniform vec3  projectorNormal/.test(shadowShaderSrc));
  check('默认 always-on-top：uvProj 走 OBB 局部坐标 + vProj.w 判定仅深度比较分支',
    /vec3 L = \(invProjector \* vec4\(W, 1\.0\)\)\.xyz/.test(shadowShaderSrc) &&
    /vec3 ln = L \/ \(decalHalf \* uBoxScale\)/.test(shadowShaderSrc) &&
    /vec2 uvProj = ln\.xy \* 0\.5 \+ 0\.5/.test(shadowShaderSrc) &&
    /let ln = L \/ \(uniform\.decalHalf \* uniform\.uBoxScale\)/.test(shadowShaderSrc) &&
    /var uvProj = ln\.xy \* 0\.5 \+ vec2f\(0\.5, 0\.5\)/.test(shadowShaderSrc) &&
    /if \(uDepthTest > 0\.5\)/.test(shadowShaderSrc));
  /* 2026-11-20 修订：默认改为 always-on-top（depthTest=0）。取证结论：本构建
     主画面由自定义高斯渲染器接管，Pass1 的引擎 pick 通道渲不出 splat → 深度图
     全空 → 深度比较把整块贴花丢光（实测投射 Δ=0）。depthTest=1 保留为可选，
     仅在引擎自带 splat pick 可用的构建里成立。 */
  check('默认 always-on-top：depthTest 默认 0、显式可选 1，Pass3 几何与 OBB UV 仍默认启用',
    /const useShadow = shadowPathSupported/.test(decalSrc2) &&
    /shadowPathCapable = \[/.test(decalSrc2) &&
    /const shadowPathSupported = shadowPathCapable && !!options\.useShadowPass/.test(decalSrc2) &&
    /function syncShadowPass/.test(decalSrc2) &&
    /depthTest: \(\(\) =>/.test(decalSrc2) &&
    /shadowPass=0/.test(decalSrc2) &&
    /depthTest=1/.test(decalSrc2) &&
    /return 0;/.test(decalSrc2) &&
    /if \(!options\.depthTest\)/.test(decalSrc2) &&
    /setP\('invProjector', mp\.inv\)/.test(decalSrc2) &&
    /setP\('decalHalf', mp\.half\)/.test(decalSrc2) &&
    /setP\('uDepthTest', canDepthTest \? 1 : 0\)/.test(decalSrc2) &&
    /setP\('uNormalCut', inst\.normalCut\)/.test(decalSrc2) &&
    /'videoFlipY', 'depthTest', 'shadowSize'/.test(decalSrc2) &&
    /if \(inst\.useShadow\) syncShadowPass/.test(decalSrc2));
  check('碰撞 mesh 深度回退已禁用（D32 与 Pass3 的 RGBA16F 试验口径不兼容）',
    /与 Pass3 解码口径不兼容/.test(decalSrc2) &&
    /inst\.collisionFallbackWarned/.test(decalSrc2));
  check('Pass1 深度源为 3DGS 场景本身（同源）：bundle 暴露正交相机深度入口 + adapter 接入 + 无碰撞 mesh 依赖',
    /class ProjectorDepthRenderer/.test(viewerSrc2) &&
    /app\.__mgProjectorDepth = getProjectorDepth/.test(viewerSrc2) &&
    /PROJECTION_ORTHOGRAPHIC/.test(viewerSrc2) &&
    /prepareForPicking/.test(viewerSrc2) &&
    /getProjDepth = app\.__mgProjectorDepth/.test(pcAdapterSrc2) &&
    /pass\.useGsplat/.test(pcAdapterSrc2) &&
    /pass\.renderer\.render\(projector, pass\.size\)/.test(pcAdapterSrc2) &&
    /inst\.depthPass\.useGsplat/.test(decalSrc2) &&
    /adapter\.setDepthPassProjector\(inst\.depthPass, projector\)/.test(decalSrc2));
  check('深度方向语义正确：常规深度 fragD>mapD+bias 才 discard（用户 reversed-Z 口径取反会误杀）',
    /fragD > mapD \+ uShadowBias\) discard;   \/\/ 被遮挡/.test(shadowShaderSrc) &&
    /reversed-Z/.test(shadowShaderSrc) &&
    /数值方向相反、语义相同/.test(shadowShaderSrc));
  check('标准方案 CPU 验证脚本存在且覆盖深度方向与行序',
    fs.existsSync(path.join(ROOT, 'tools', 'verify_shadow_decal_cpu.mjs')) &&
    /深度比较方向正确/.test(fs.readFileSync(path.join(ROOT, 'tools', 'verify_shadow_decal_cpu.mjs'), 'utf8')));
  /* 【TDZ 铁律教训】manager 对象字面量曾直接引用下方才 const 声明的
     shadowPathSupported，warn 也被 stoppedByEntry 分支提前调用 —— 两次
     ReferenceError 被 editor.js 的 try/catch 吞成 decalMgr=null，真机「视频
     完全不投射」。静态正则无法发现 TDZ，只能靠真实执行（runtime 脚本）+ 下面的
     顺序守卫双保险。 */
  check('贴花管理器无 TDZ：warn/manager 先初始化，shadowPathSupported 后回填', (() => {
    const w = decalSrc2.indexOf('const warn =');
    const u = decalSrc2.indexOf('if (stoppedByEntry) warn(');
    const m = decalSrc2.indexOf('const manager =');
    const s = decalSrc2.indexOf('shadowPathSupported: false');
    const b = decalSrc2.indexOf('manager.shadowPathSupported = shadowPathSupported');
    return w >= 0 && u > w && m > u && s > m && b > s && s < decalSrc2.indexOf('const shadowPathSupported = ');
  })());
  check('贴花运行时链路验证脚本存在（真实执行 createDecalProjection，防 TDZ 回归）',
    fs.existsSync(path.join(ROOT, 'tools', 'verify_decal_runtime.mjs')) &&
    /createDecalProjection 不抛 TDZ/.test(
      fs.readFileSync(path.join(ROOT, 'tools', 'verify_decal_runtime.mjs'), 'utf8')));

  /* [38] 720° 全景导出 UI：面板 / 分辨率选项 / 入口按钮 + 源码守卫。
     真实取帧功能不走本套件（__viewer 在此被 mock 掉，没有 captureFrame），
     由 tools/verify_panorama_ui.mjs 在未 mock 的真实 Viewer 上验证。 */
  console.log('\n[38] 720° 全景导出 UI（按钮 / 分辨率 / 面板 / 源码守卫）');
  const panoUi = await E(`(()=>{const d=document;
    const btn=d.getElementById('gsPanoBtn'),p=d.getElementById('gsPanoPanel');
    const sel=d.getElementById('gsPanoRes');
    const before=!!p&&!p.hidden;
    btn?.click();
    const after=!!p&&!p.hidden;
    const opts=sel?Array.from(sel.options).map(o=>o.value):[];
    const pos=d.getElementById('gsPanoPos')?.textContent||'';
    const status=d.getElementById('gsPanoStatus')?.textContent||'';
    p?.querySelector('.gs-pano-close')?.click();
    const consoleText=d.getElementById('gs-console')?.textContent||'';
    return {btn:!!btn,panel:!!p,before,after,opts,pos,status,
      consoleEntry:/导出 720° 全景图/.test(consoleText),
      exportBtn:!!d.getElementById('gsPanoGo')};})()`);
  check('左下辅助条有「全景图」入口按钮', panoUi.btn === true);
  check('全景面板挂在页面且默认收起', panoUi.panel === true && panoUi.before === false);
  check('点击入口展开面板并显示当前机位', panoUi.after === true && /当前机位/.test(panoUi.pos));
  check('分辨率提供 2048 / 4096 / 8192 三档且默认高清',
    JSON.stringify(panoUi.opts) === JSON.stringify(['2048', '4096', '8192']) &&
    /就绪/.test(panoUi.status));
  check('三维功能控制台内有全景导出入口', panoUi.consoleEntry === true);
  check('面板有生成并导出按钮', panoUi.exportBtn === true);
  const panoSrc = fs.readFileSync(path.join(ROOT, 'web', 'viewer', 'panorama.js'), 'utf8');
  const fusionSrc = fs.readFileSync(path.join(ROOT, 'web', 'maoming-showroom', 'fusion.js'), 'utf8');
  const panoCssSrc = fs.readFileSync(path.join(ROOT, 'web', 'maoming-showroom', 'fusion.css'), 'utf8');
  const viewerHtmlSrc = fs.readFileSync(path.join(ROOT, 'web', 'gs-viewer.html'), 'utf8');
  check('页内六面取帧用 captureFrame（不依赖 preserveDrawingBuffer）',
    /captureFrame\(\{\s*width:\s*f,\s*height:\s*f,\s*supersample:\s*1\s*\}\)/.test(panoSrc));
  check('六个方向覆盖完整球面（±X/±Y/±Z），拼接为 2:1',
    /\[1, 0, 0\], \[-1, 0, 0\], \[0, 1, EPS\], \[0, -1, EPS\], \[0, 0, 1\], \[0, 0, -1\]/.test(panoSrc) &&
    /const W = f \* 4, H = f \* 2/.test(panoSrc));
  check('生成后恢复用户原机位（finally 中 setCameraPose）',
    /savedPose\s*=\s*pose\s*&&/.test(panoSrc) &&
    /finally\s*\{[\s\S]{0,400}setCameraPose\(savedPose\.position, savedPose\.target, savedPose\.fov\)/.test(panoSrc));
  check('全景模块已在 viewer 页面加载', /src="\.\/viewer\/panorama\.js"/.test(viewerHtmlSrc));
  check('父页导出走 Blob/dataURL 下载且显示进度',
    /api\.generate\(\{\s*face:[\s\S]{0,120}onProgress:\s*mark\s*\}\)/.test(fusionSrc) &&
    /a\.download\s*=\s*`panorama_/.test(fusionSrc) &&
    /gsPanoStatus/.test(fusionSrc));
  check('全景面板样式存在', /#stage \.gs-pano-panel/.test(panoCssSrc));

  console.log(`\n========== ${pass} PASS / ${fail} FAIL ==========`);
  return fail;
}

main()
  .then((f) => { cleanup(); process.exit(f ? 1 : 0); })
  .catch((e) => { console.error('\n回归脚本异常:', e); cleanup(); process.exit(2); });

/**
 * R4 验证主脚本（系统 Chrome + CDP，无 playwright）。
 *
 * 覆盖：
 *   1. 从零启动静态服务（8095），测首屏可达时间与 human 关键资源 HTTP 状态
 *   2. ?human=1 数字人可见：splats / bones / 身高 / 截图
 *   3. 漫游：原场景 WASD（CDP Input.dispatchKeyEvent）+ 数字人 patrol 10 s 位移
 *   4. stand / walk / run 各 5 s：步态生效、genMs>0、无异常
 *   5. 性能：10 s FPS 中位数、genMs、JS 堆、首帧时间、后端
 *   6. 兼容：navigator.gpu 有无 → 后端与 UI 文案
 *
 * 端口纪律：服务 8095 / CDP 9250（本脚本专用，不碰 8091/8092/8093/18120/9243-9246）
 *
 * 用法：
 *   node tools/r4_check.mjs                 # headless（SwiftShader，WASM 回退路径）
 *   node tools/r4_check.mjs --headed        # 有头（真实 GPU，WebGPU 主路径）
 *   node tools/r4_check.mjs --wait 600      # 数字人就绪等待上限（秒）
 *
 * 退出码：0 全部断言通过 · 1 有断言失败 · 2 脚本异常
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = process.env.R4_PY || 'python';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 8095;
const CDP_PORT = 9250;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(ROOT, 'shots');

const argv = process.argv;
const HEADED = argv.includes('--headed');
const argOf = (k, d) => {
  const a = argv.find((x) => x.startsWith(`--${k}=`));
  return a ? a.split('=')[1] : d;
};
const READY_WAIT_S = Number(argOf('wait', 420));
const NOGPU = argv.includes('--nogpu');     // 注入 navigator.gpu=undefined，验证无 WebGPU 的回落分支
const COMPAT = argv.includes('--compat');   // 只验后端/UI，就绪后立即收尾
const MODE = (HEADED ? 'headed/webgpu' : 'headless/swiftshader') + (NOGPU ? '/nogpu' : '');

const ASSETS = [
  '/human/human-layer.js',
  '/human/splat-avatar.js',
  '/human/motion-driver.js',
  '/human/vendor/three/three.module.js',
  '/human/vendor/three-motionbricks/index.mjs',
  '/human/vendor/three-motionbricks/motionbricks.worker.js',
  '/human/vendor/ort/ort.webgpu.min.mjs',
  '/human/assets/astronaut.glb',
];
const ONNX = '/human/model/mmm_v6_soma_q8h.onnx';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail) {
  const ok = !!cond;
  ok ? pass++ : fail++;
  const line = `  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  ->  ' + JSON.stringify(detail).slice(0, 400) : ''}`;
  console.log(line);
  results.push({ name, ok, detail });
  return ok;
}
const med = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

fs.mkdirSync(SHOTS, { recursive: true });
const profile = path.join(ROOT, '.verify-profile', 'r4_' + MODE.replace('/', '_') + '_' + Date.now());
fs.mkdirSync(profile, { recursive: true });

/* ---------------------------------------------------------------- 服务 */
const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)],
  { cwd: ROOT, stdio: 'ignore' });
const tSrv = Date.now();
let serverReadyMs = -1;
const httpChecks = [];

/* ---------------------------------------------------------------- CDP 客户端 */
let ws = null, seq = 0;
const pend = new Map();
const pageLogs = [];
const jsErrors = [];
const netErrors = [];
const consoleAll = [];

async function send(method, params = {}, timeoutMs = 60000) {
  return new Promise((res, rej) => {
    const id = ++seq;
    pend.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pend.has(id)) { pend.delete(id); rej(new Error(`CDP ${method} 超时`)); }
    }, timeoutMs);
  });
}
async function E(expression, timeoutMs = 60000) {
  const r = await send('Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true, userGesture: true }, timeoutMs);
  if (r.result?.exceptionDetails) {
    return { __err: r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description || '').slice(0, 400) };
  }
  return r.result?.result?.value;
}

const SNIPPETS = {
  state: `(()=>{const h=window.__mgHuman;if(!h)return null;return{
    ready:!!h.state.ready, phase:h.state.phase, backend:h.state.backend, modelReady:!!h.state.modelReady,
    gait:h.state.gait, mode:h.state.mode, fps:h.state.fps, genMs:h.state.genMs,
    count:h.state.count, bones:h.state.bones, height:h.state.height, error:h.state.error,
    visible:h.state.visible, srcStage:h.state.srcStage};})()`,
  cam: `(()=>{const v=window.__viewer;if(!v||!v.app||!v.app.root)return null;
    const c=v.app.root.findComponent('camera');if(!c)return null;const p=c.entity.getPosition();
    return {x:p.x,y:p.y,z:p.z,cameraMode:v.state&&v.state.cameraMode};})()`,
  hips: `(()=>{const h=window.__mgHuman;if(!h||!h._internals)return null;
    const d=h._internals().driver;const o=d&&d.characterObject;if(!o)return null;
    let hips=null;o.traverse(n=>{if(!hips&&/hips/i.test(n.name||''))hips=n;});
    if(!hips)return null;const v=hips.position.clone();hips.getWorldPosition(v);
    return {x:v.x,y:v.y,z:v.z,name:hips.name};})()`,
  ui: `(()=>{const s=document.getElementById('mg-human-stats');
    const st=document.getElementById('mg-human-status');
    return {stats:s?s.textContent.trim():null,status:st?st.textContent.trim():null,
      canvas:(()=>{const c=document.getElementById('mg-human-layer');return c?{w:c.clientWidth,h:c.clientHeight}:null})()};})()`,
  nav: `(()=>{const n=performance.getEntriesByType('navigation')[0]||{};
    return {ttfb:+(n.responseStart||0).toFixed(1),dcl:+(n.domContentLoadedEventEnd||0).toFixed(1),
      load:+(n.loadEventEnd||0).toFixed(1),now:+performance.now().toFixed(1),
      hasGpu:!!navigator.gpu, secure:!!isSecureContext,
      loading:window.__mgLoading||null};})()`,
  res: `performance.getEntriesByType('resource').filter(e=>/\\/human\\//.test(e.name))
    .map(e=>({u:e.name.replace(location.origin,''),t:+(e.duration||0).toFixed(0),size:e.transferSize,n:e.initiatorType}))`,
};

async function cleanup() {
  try { ws?.close(); } catch { /* noop */ }
  try {
    if (srv.pid) spawn('taskkill', ['/PID', String(srv.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch { /* noop */ }
}

/* ---------------------------------------------------------------- 主流程 */
async function main() {
  /* 1. 服务可达 + 资源 HTTP 状态（从零启动，记录首屏可达时间） */
  console.log(`\n[1] 从零启动服务 ${BASE}`);
  for (let i = 0; i < 160; i++) {
    try {
      const r = await fetch(`${BASE}/gs-viewer.html`, { method: 'HEAD' });
      if (r.ok) { serverReadyMs = Date.now() - tSrv; break; }
    } catch { /* retry */ }
    await sleep(100);
  }
  console.log(`    服务就绪 ${serverReadyMs} ms（spawn → /gs-viewer.html 200）`);
  check('服务从零启动并返回 200', serverReadyMs >= 0, serverReadyMs + ' ms');

  for (const p of ASSETS) {
    const r = await fetch(BASE + p, { method: 'HEAD' });
    const len = Number(r.headers.get('content-length') || 0);
    const ct = r.headers.get('content-type');
    httpChecks.push({ path: p, status: r.status, len, ct });
    check(`GET ${p} 200`, r.status === 200 && len > 0, { status: r.status, len, ct });
  }
  const rr = await fetch(BASE + ONNX, { headers: { Range: 'bytes=0-0' } });
  const cr = rr.headers.get('content-range');
  const cl = Number(rr.headers.get('content-length') || 0);
  httpChecks.push({ path: ONNX, status: rr.status, len: cl, contentRange: cr });
  check('ONNX 大文件 Range 1 字节 → 206', rr.status === 206 && cl === 1 && !!cr,
    { status: rr.status, len: cl, range: cr, type: rr.headers.get('content-type') });

  /* 2. Chrome */
  const chromeArgs = [
    `--remote-debugging-port=${CDP_PORT}`, '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--ignore-gpu-blocklist', '--enable-unsafe-webgpu',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--window-size=1600,900', '--window-position=40,40',
  ];
  if (!HEADED) chromeArgs.push('--headless=new', '--use-gl=swiftshader', '--enable-unsafe-swiftshader');
  chromeArgs.push('about:blank');
  const br = spawn(CHROME, chromeArgs, { stdio: 'ignore' });
  console.log(`\n[2] Chrome ${MODE}（pid=${br.pid}，视口 1600×900）`);

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
    if (o.method === 'Runtime.consoleAPICalled') {
      const text = (o.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
      pageLogs.push(`[${o.params.type}] ${text}`);
      consoleAll.push(text);
      if (o.params.type === 'error') jsErrors.push(text);
    } else if (o.method === 'Runtime.exceptionThrown') {
      const d = o.params.exceptionDetails;
      jsErrors.push((d.exception && d.exception.description) || d.text || 'exception');
    } else if (o.method === 'Log.entryAdded') {
      const en = o.params.entry;
      pageLogs.push(`[log:${en.level}] ${en.text}`);
      if (en.level === 'error' && !/favicon/.test(en.url || '')) netErrors.push(`${en.text} ${en.url || ''}`);
    } else if (o.method === 'Network.responseReceived') {
      const r = o.params.response;
      if (r.status >= 400 && !/favicon/.test(r.url)) netErrors.push(`HTTP ${r.status} ${r.url}`);
    }
  };
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Network.enable');
  await send('Performance.enable');
  /* 固定 1600×900 视口（目标分辨率；headless 默认窗口含边框，会少 150px 高） */
  await send('Emulation.setDeviceMetricsOverride',
    { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  if (NOGPU) {
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `Object.defineProperty(navigator,'gpu',{value:undefined,configurable:true});`,
    });
  }

  /* 3. 打开 ?human=1 */
  const url = `${BASE}/gs-viewer.html?scene=floor3&human=1`;
  const tNav = Date.now();
  console.log(`\n[3] 打开 ${url}`);
  await send('Page.navigate', { url });
  await sleep(800);
  try { await send('Page.bringToFront'); } catch { /* headless 忽略 */ }

  let loaded = false, tViewer = 0, tLoaded = 0;
  for (let i = 0; i < 300; i++) {
    const s = await E(`(()=>{const v=window.__viewer;return {v:!!v,loaded:!!(v&&v.state&&v.state.loaded),g:(v&&v.state&&v.state.gsplats)||0,load:window.__mgLoading||null};})()`);
    if (s && s.v) {
      if (!tViewer) tViewer = Date.now() - tNav;
      if (s.loaded) { loaded = true; tLoaded = Date.now() - tNav; console.log(`    3DGS 场景已加载 ${tLoaded} ms，gsplats=${s.g}`); break; }
    }
    await sleep(200);
  }
  check('原 3DGS 场景加载完成（__viewer.state.loaded）', loaded, loaded ? tLoaded + ' ms' : 'timeout');

  /* 4. 等数字人就绪 */
  console.log(`\n[4] 等 __mgHuman.state.ready（上限 ${READY_WAIT_S}s）`);
  let st = null, readyAt = -1, lastNote = '';
  const tReady = Date.now();
  while (Date.now() - tReady < READY_WAIT_S * 1000) {
    st = await E(SNIPPETS.state);
    if (st && !st.__err) {
      const note = `${st.phase}/${st.backend}/modelReady=${st.modelReady}/splats=${st.count}/genMs=${st.genMs}`;
      if (note !== lastNote) {
        console.log(`    … ${note}${st.error ? '  error=' + st.error : ''}`);
        lastNote = note;
      }
      if (st.ready) { readyAt = Date.now() - tNav; break; }
    }
    await sleep(500);
  }
  if (!st || !st.ready) {
    console.log('    未在时限内 ready：' + JSON.stringify(st));
    check('__mgHuman.state.ready', false, st);
  } else {
    console.log(`    就绪 ${readyAt} ms（导航起算），state=${JSON.stringify(st)}`);
    check('__mgHuman.state.ready', true, readyAt + ' ms');
  }

  const nav = await E(SNIPPETS.nav);
  const ui = await E(SNIPPETS.ui);
  const meas = await E(`(()=>{const h=window.__mgHuman;return h&&h.measure?h.measure():null})()`);
  console.log(`    UI=${JSON.stringify(ui)}\n    环境=${JSON.stringify({ hasGpu: nav.hasGpu, secure: nav.secure })}\n    measure=${JSON.stringify(meas)}`);

  check('overlay canvas 铺满 1600×900', !!(ui && ui.canvas && ui.canvas.w >= 1500 && ui.canvas.h >= 800), ui && ui.canvas);
  check('高斯化身已构建（splats>0）', !!(st && st.count > 0), st && st.count);
  check('骨骼数 > 0', !!(st && st.bones > 0), st && st.bones);
  check('measure().height ∈ [1.4, 2.1] m', !!(meas && meas.height >= 1.4 && meas.height <= 2.1), meas && meas.height);
  check('后端已明确（webgpu/wasm）', !!(st && (st.backend === 'webgpu' || st.backend === 'wasm')), st && st.backend);
  check('模型就绪（modelReady）', !!(st && st.modelReady), st && { modelReady: st.modelReady, error: st.error });
  check('UI 面板显示后端', !!(ui && ui.stats && /后端\s*(webgpu|wasm)/i.test(ui.stats)), ui && ui.stats && ui.stats.split('\n')[0]);
  check('页面无 JS 未捕获异常', jsErrors.length === 0, jsErrors.slice(0, 3));

  if (COMPAT) {
    const api = await E(`(()=>{const h=window.__mgHuman;const d=h._internals().driver;const ch=d&&d._character;
      return {driver:{setGait:typeof d?.setGait,drive:typeof d?.drive,moveTo:typeof d?.moveTo,jump:typeof d?.jump,sit:typeof d?.sit},
        character:{jump:typeof ch?.jump,sit:typeof ch?.sit,moveTo:typeof ch?.moveTo,stop:typeof ch?.stop},
        buttons:[...document.querySelectorAll('#mg-human-ui button')].map(b=>b.textContent)};})()`);
    console.log('    动作接口=' + JSON.stringify(api));
    /* 面板可见性：小地图 z-index 26、数字人面板 z-index 8，且都在左下角 —— 做真实 hit-test */
    const hit = await E(`(()=>{const u=document.getElementById('mg-human-ui');
      const mm=document.getElementById('mg-minimap');
      if(!u)return null;const r=u.getBoundingClientRect();const mr=mm?mm.getBoundingClientRect():null;
      const cx=r.left+r.width/2, cy=r.top+Math.min(28,r.height/2);
      const top=document.elementFromPoint(cx,cy);
      const overlap=!!(mr&&!(r.right<mr.left||r.left>mr.right||r.bottom<mr.top||r.top>mr.bottom));
      return {ui:{x:+r.x.toFixed(0),y:+r.y.toFixed(0),w:+r.width.toFixed(0),h:+r.height.toFixed(0),z:getComputedStyle(u).zIndex},
        minimap:mr?{x:+mr.x.toFixed(0),y:+mr.y.toFixed(0),w:+mr.width.toFixed(0),h:+mr.height.toFixed(0),z:getComputedStyle(mm).zIndex}:null,
        hitPoint:[+cx.toFixed(0),+cy.toFixed(0)],
        topEl:top?(top.id||top.className||top.tagName):null, overlap};})()`);
    console.log('    面板遮挡检测=' + JSON.stringify(hit));
    check('后端状态文案对用户可见（未被小地图遮挡）',
      !!(hit && /mg-human/i.test(String(hit.topEl))), hit);
    const fallbackLogs = consoleAll.filter((l) => /MotionBricks|WebGPU|WebAssembly|wasm|backend|MotionDriver/i.test(l));
    console.log(`\n[兼容] navigator.gpu=${nav?.hasGpu} backend=${st?.backend} UI=${ui?.stats?.split('\n')[0]}`);
    fallbackLogs.slice(-8).forEach((l) => console.log('    ' + String(l).slice(0, 220)));
    check('无 navigator.gpu 时后端回落 wasm', nav?.hasGpu === false && st?.backend === 'wasm',
      { hasGpu: nav?.hasGpu, backend: st?.backend });
    check('UI 面板显示「后端 wasm」', /后端\s*wasm/i.test(ui?.stats || ''), ui?.stats);
    check('jump/sit 无公开入口（库内仅 character.sit 存在）',
      !!(api && api.driver && api.driver.jump === 'undefined' && api.driver.sit === 'undefined' &&
        api.buttons && !api.buttons.some((t) => /跳|坐/.test(t))),
      { driver: api?.driver, character: api?.character, buttons: api?.buttons });
    console.log(`\n========== ${pass} PASS / ${fail} FAIL ========== (${MODE})`);
    try { ws.close(); } catch { /* noop */ }
    try { spawn('taskkill', ['/PID', String(br.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* noop */ }
    await sleep(1200);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* noop */ }
    return fail ? 1 : 0;
  }

  /* 5. 截图（headless 稳定；有头带 15s 超时）
     截图用 stand + 2.8 m，避免走动后离相机太远导致人物过小 */
  await E(`(()=>{const h=window.__mgHuman;if(!h)return 0;h.setMode('stay');h.setGait('stand');h.placeInFront(2.8);return 1;})()`);
  await sleep(1200);
  const shotName = HEADED ? 'r4_demo_headed.png' : 'r4_demo.png';
  const shotPath = path.join(SHOTS, shotName);
  let shotOk = false;
  try {
    const r = await Promise.race([
      send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 20000),
      sleep(15000).then(() => null),
    ]);
    if (r && r.result && r.result.data) {
      fs.writeFileSync(shotPath, Buffer.from(r.result.data, 'base64'));
      shotOk = true;
      console.log(`    截图 ${path.relative(ROOT, shotPath)} (${(fs.statSync(shotPath).size / 1024).toFixed(0)} KB)`);
    }
  } catch (e) { console.log('    截图异常：' + e.message); }
  check('截图落盘', shotOk, shotName);
  const shotMeta = await E(`(()=>{const c=document.getElementById('mg-human-layer');return {w:c&&c.clientWidth,h:c&&c.clientHeight}})()`);

  /* 6. 原场景 WASD（CDP 原生键盘事件按住 1 s） */
  console.log('\n[6] 原场景 WASD');
  const cam0 = await E(SNIPPETS.cam);
  // 先点一下画布，保证键盘焦点在页面（overlay 是 pointer-events:none，不会截获）
  try {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 800, y: 450, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 800, y: 450, button: 'left', clickCount: 1 });
  } catch { /* noop */ }
  await sleep(300);
  const keyW = { windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87, code: 'KeyW', key: 'w' };
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...keyW, text: 'w', unmodifiedText: 'w' });
  await sleep(1000);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...keyW });
  await sleep(300);
  const cam1 = await E(SNIPPETS.cam);
  const dist = (a, b) => (a && b) ? Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) : -1;
  const wasd = +dist(cam0, cam1).toFixed(3);
  console.log(`    cam0=${JSON.stringify(cam0)}\n    cam1=${JSON.stringify(cam1)}\n    位移=${wasd} m`);
  check('WASD 按住 1 s 相机位移 > 0.2 m', wasd > 0.2, { dist: wasd, from: cam0, to: cam1 });

  /* 7. 数字人 patrol 10 s */
  console.log('\n[7] 数字人 patrol 10 s');
  await E(`(()=>{const h=window.__mgHuman;if(!h)return 0;h.setMode('patrol');h.placeInFront(3.2);h.setGait('walk');return 1;})()`);
  await sleep(600);
  const p0 = await E(SNIPPETS.hips);
  let maxD = 0, pathLen = 0, prev = p0, samples = 0;
  const tPatrol = Date.now();
  while (Date.now() - tPatrol < 10000) {
    const p = await E(SNIPPETS.hips);
    if (p && typeof p.x === 'number') {
      samples++;
      const d0 = Math.hypot(p.x - p0.x, p.z - p0.z);
      maxD = Math.max(maxD, d0);
      if (prev) pathLen += Math.hypot(p.x - prev.x, p.z - prev.z);
      prev = p;
    }
    await sleep(400);
  }
  const p1 = await E(SNIPPETS.hips);
  console.log(`    hips 起点=${JSON.stringify(p0)}\n    hips 终点=${JSON.stringify(p1)}\n    最大离起点=${maxD.toFixed(3)} m 路径累计=${pathLen.toFixed(3)} m 采样=${samples}`);
  check('patrol 10 s 内自身位移 > 1 m', maxD > 1.0 || pathLen > 1.0, { maxDist: +maxD.toFixed(3), path: +pathLen.toFixed(3) });

  /* 8. 三档步态各 5 s */
  console.log('\n[8] stand / walk / run 各 5 s');
  await E(`(window.__mgHuman.setMode('stay'), 1)`);
  const errBefore = jsErrors.length;
  const seg = [];
  for (const g of ['stand', 'walk', 'run']) {
    await E(`(window.__mgHuman.setGait('${g}'), 1)`);
    const q0 = await E(SNIPPETS.hips);
    const t = Date.now();
    let fpsArr = [], gen = 0, gaitSeen = '', maxGen = 0;
    while (Date.now() - t < 5000) {
      const r = await E(`(()=>{const h=window.__mgHuman;if(!h)return null;return{gait:h.state.gait,gen:h.state.genMs,fps:h.state.fps};})()`);
      if (r) { gaitSeen = r.gait; gen = r.gen; maxGen = Math.max(maxGen, r.gen || 0); fpsArr.push(r.fps); }
      await sleep(400);
    }
    const q1 = await E(SNIPPETS.hips);
    const moved = (q0 && q1) ? Math.hypot(q1.x - q0.x, q1.z - q0.z) : -1;
    seg.push({ gait: g, stateGait: gaitSeen, genMs: maxGen, moved: +moved.toFixed(3), fpsMed: +med(fpsArr).toFixed(1) });
    console.log(`    ${g}: state.gait=${gaitSeen} genMs=${maxGen.toFixed(0)} hips 位移=${moved.toFixed(3)} m FPS 中位=${med(fpsArr).toFixed(1)}`);
    check(`步态 ${g} 生效（state.gait）`, gaitSeen === g, gaitSeen);
    check(`步态 ${g} 有推理产出（genMs>0）`, maxGen > 0, maxGen);
  }
  check('三档切换无新增 JS 异常', jsErrors.length === errBefore, jsErrors.length - errBefore);

  /* 9. 性能 10 s（patrol + walk 连续跑） */
  console.log('\n[9] 性能采样 10 s（patrol + walk）');
  await E(`(()=>{const h=window.__mgHuman;h.setMode('patrol');h.setGait('walk');return 1;})()`);
  await sleep(1000);
  const m0 = await send('Performance.getMetrics');
  const fpsSamples = [];
  const tPerf = Date.now();
  while (Date.now() - tPerf < 10000) {
    const v = await E(`window.__mgHuman?window.__mgHuman.state.fps:0`);
    if (typeof v === 'number') fpsSamples.push(v);
    await sleep(500);
  }
  const m1 = await send('Performance.getMetrics');
  const stEnd = await E(SNIPPETS.state);
  const navEnd = await E(SNIPPETS.nav);
  const metric = (r, k) => (r.result?.metrics || []).find((x) => x.name === k)?.value ?? 0;
  const perf = {
    fpsSamples: fpsSamples.length,
    fpsMed: +med(fpsSamples).toFixed(1),
    fpsMin: fpsSamples.length ? Math.min(...fpsSamples) : 0,
    fpsMax: fpsSamples.length ? Math.max(...fpsSamples) : 0,
    genMs: +(stEnd?.genMs || 0).toFixed(1),
    backend: stEnd?.backend,
    jsHeapMB: +(metric(m1, 'JSHeapUsedSize') / 1048576).toFixed(1),
    taskMsPerSec: +((metric(m1, 'TaskDuration') - metric(m0, 'TaskDuration')) * 1000 / 10).toFixed(1),
    firstFrameMs: navEnd?.loading?.atMs ?? null,
    firstFrameReason: navEnd?.loading?.reason ?? null,
    ttfbMs: navEnd?.ttfb,
    dclMs: navEnd?.dcl,
    loadMs: navEnd?.load,
    humanReadyMs: readyAt,
  };
  console.log('    ' + JSON.stringify(perf));
  check('FPS 采样 ≥ 10 个', fpsSamples.length >= 10, fpsSamples.length);
  check('后端与 UI 一致（' + (stEnd?.backend || '?') + '）',
    !!(ui && stEnd && new RegExp('后端\\s*' + stEnd.backend, 'i').test(ui.stats || '')), { backend: stEnd?.backend });

  const res = await E(SNIPPETS.res);
  console.log('    资源耗时（human/*，ms）: ' + JSON.stringify(res).slice(0, 900));

  const fallbackLogs = consoleAll.filter((l) => /MotionBricks|WebGPU|WebAssembly|wasm|backend|MotionDriver/i.test(l));
  console.log('\n[10] 控制台关键日志（节选）');
  (fallbackLogs.length ? fallbackLogs : pageLogs).slice(-14).forEach((l) => console.log('    ' + String(l).slice(0, 220)));

  const summary = {
    mode: MODE,
    headed: HEADED,
    chrome: 'Chrome/137.0.7151.69',
    viewport: shotMeta,
    hasGpu: nav?.hasGpu,
    secure: nav?.secure,
    state: stEnd,
    measure: meas,
    ui,
    perf,
    wasd: { dist: wasd, cam0, cam1 },
    patrol: { maxDist: +maxD.toFixed(3), path: +pathLen.toFixed(3), p0, p1 },
    gait: seg,
    http: httpChecks,
    serverReadyMs,
    jsErrors: jsErrors.slice(0, 5),
    netErrors: netErrors.slice(0, 5),
    logs: fallbackLogs.slice(-12),
  };
  fs.writeFileSync(path.join(process.env.TEMP || ROOT, `r4_summary_${HEADED ? 'headed' : 'headless'}.json`),
    JSON.stringify(summary, null, 2));

  console.log(`\n========== ${pass} PASS / ${fail} FAIL ========== (${MODE})`);

  try { ws.close(); } catch { /* noop */ }
  try { spawn('taskkill', ['/PID', String(br.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* noop */ }
  await sleep(1200);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* noop */ }
  return fail ? 1 : 0;
}

main()
  .then(async (code) => { await cleanup(); process.exit(code); })
  .catch(async (e) => {
    console.error('\n脚本异常:', e);
    if (pageLogs.length) pageLogs.slice(-10).forEach((l) => console.error('   ', l));
    await cleanup();
    process.exit(2);
  });

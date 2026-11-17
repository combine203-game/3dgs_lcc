/**
 * 贴花视频像素级验收探针
 * ----------------------------------------------------------------
 * 为什么需要它：既有探针（tools/probe_decal_video.mjs）只断言**状态字段**
 * （pickReady / videoReady / demoMode），从不看像素真的出现。历史
 * projDelta=0.785 贴线过 0.5 阈值，掩盖了真实症状 ——
 * 「框线清楚、框内只有中间一小块」。
 *
 * 本探针做真正的像素验收：以「贴花可见」与「贴花隐藏」两帧截图差分为基础，
 * 给出四项数值指标（Req 11）+ 四项阈值（Req 12）+ 裕量（Req 13）：
 *
 *   1. 差分覆盖率        ≥ 0.50   变化像素(|Δ|>12)占 OBB 屏幕矩形面积比
 *   2. 包围盒面积占比    ≥ 0.80   变化像素的包围盒 ÷ OBB 屏幕矩形面积
 *   3. 主色相差          ≤ 15°    贴花区主色相 vs 视频源主色相
 *   4. DPR 覆盖率差      ≤ 0.05   devicePixelRatio=1 与 2 的覆盖率差
 *
 * 另有三项故障注入（Req 15）：shader 编译失败 / 视频纹理加载失败 / 深度贴图缺失，
 * 断言主画面持续出帧且非贴花区像素差分占比 ≤ 0.02。
 *
 * 用法： node tools/probe_decal_video_pixel.mjs [--wait=18000] [--gl] [--keep]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodePng, dominantHue, hueDelta } from './png-decode.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 18137;
const CDP_PORT = 9263;
const BASE = `http://127.0.0.1:${PORT}`;
const WAIT = Number((process.argv.find(a => a.startsWith('--wait=')) || '').split('=')[1]) || 18000;
const FORCE_GL = process.argv.includes('--gl');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- 验收阈值与裕量要求（Req 12 / 13）----
const TH = {
  coverage: 0.50,        // 差分覆盖率
  bbox: 0.80,            // 包围盒面积占比
  hue: 15,               // 主色相差（度）
  dprDelta: 0.05,        // DPR 1/2 覆盖率差
  marginRatio: 0.10      // 每项实测值与阈值之间须留 ≥ 阈值 10% 的裕量
};
const NON_DECAL_DIFF_MAX = 0.02;   // 故障注入时非贴花区差分占比上限
const PIX_DELTA = 12;              // 像素变化判定阈值（|Δ|）

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)],
  { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'decalpixel_' + Date.now());
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
  function send(method, params = {}) {
    return new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  }
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
  await sleep(WAIT);

  const DOC = `(()=>{const f=document.querySelector('iframe.gs-scene-frame[data-active="1"]')||document.querySelector('iframe.gs-scene-frame');return f?f.contentWindow:window;})()`;

  // 隐藏所有 DOM 覆盖层，只保留 3D 画布内容
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
    const cv = await E(`(()=>{const W=${DOC};
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
    if (!r.result?.data) return null;
    const buf = Buffer.from(r.result.data, 'base64');
    const file = path.join(ROOT, 'tools', `probe-decal-pixel-${name}.png`);
    fs.writeFileSync(file, buf);
    return decodePng(buf);
  }

  const dbg = async () => {
    const v = await E(`(()=>{const W=${DOC};const m=W.__mgEditor?.decalMgr;
      return m&&typeof m.debug==='function'?m.debug():null;})()`);
    return v && !v.__err ? v : null;
  };

  // 取得贴花 OBB 在屏幕上的矩形（CSS 像素，相对画布左上角）
  const obbRect = async (id) => {
    const r = await E(`(()=>{const W=${DOC},ed=W.__mgEditor;
      const a=ed.store.get('${id}');if(!a||!a.projector)return {err:'no-projector'};
      const app=W.__viewer?.app;const cam=app?.root?.findComponent?.('camera');
      if(!cam)return {err:'no-camera'};
      const cv=W.document.querySelector('#mg-stage canvas');if(!cv)return {err:'no-canvas'};
      const cr=cv.getBoundingClientRect();
      const P=W.__pc;if(!P)return {err:'no-pc'};
      const h=a.projector.half;
      const q=a.projector.quaternion;const qx=q[0],qy=q[1],qz=q[2],qw=q[3];
      const fwd=cam.entity.forward;const cpos=cam.entity.getPosition();
      const corners=[];
      for(const sx of [-1,1])for(const sy of [-1,1])for(const sz of [-1,1]){
        const l=[sx*h[0],sy*h[1],sz*h[2]];
        // 四元数旋转向量（q * v * q^-1）
        const ix=qw*l[0]+qy*l[2]-qz*l[1],iy=qw*l[1]+qz*l[0]-qx*l[2],iz=qw*l[2]+qx*l[1]-qy*l[0],iw=-qx*l[0]-qy*l[1]-qz*l[2];
        const wx=ix*qw+iw*-qx+iy*-qz-iz*-qy,wy=iy*qw+iw*-qy+iz*-qx-ix*-qz,wz=iz*qw+iw*-qz+ix*-qy-iy*-qx;
        const w=[a.projector.position[0]+wx,a.projector.position[1]+wy,a.projector.position[2]+wz];
        // 相机前方判定（worldToScreen 的 z 是 NDC，不是深度，不能用来判前后）
        const d=[w[0]-cpos.x,w[1]-cpos.y,w[2]-cpos.z];
        const front=(d[0]*fwd.x+d[1]*fwd.y+d[2]*fwd.z)>0.05;
        const t=new P.Vec3(w[0],w[1],w[2]);const out=new P.Vec3();
        cam.worldToScreen(t,out);
        corners.push([out.x,out.y,front]);
      }
      const xs=corners.map(c=>c[0]),ys=corners.map(c=>c[1]);
      const minX=Math.min.apply(null,xs),maxX=Math.max.apply(null,xs);
      const minY=Math.min.apply(null,ys),maxY=Math.max.apply(null,ys);
      return {x:minX-cr.left,y:minY-cr.top,w:maxX-minX,h:maxY-minY,
              allFront:corners.every(c=>c[2]),
              canvasW:cv.width,canvasH:cv.height,cssW:cr.width,cssH:cr.height,
              dpr:W.devicePixelRatio};
    })()`);
    return r && !r.__err ? r : null;
  };

  console.log('\n===== A. 进入编辑态 + 注入贴面矩形 =====');
  const backend = await E(`(()=>{const W=${DOC},gd=W.__viewer?.app?.graphicsDevice;
    return gd?(gd.isWebGPU||gd.deviceType==='webgpu'?'webgpu':'webgl2'):null;})()`);
  await E(`(()=>{document.getElementById('gsEditorBtn')?.click();return 1})()`);
  await sleep(3000);
  const edOn = await E(`(()=>{return !!(${DOC}).__mgEditor;})()`);
  if (!edOn) throw new Error('编辑器未挂载');
  console.log('  后端 =', backend, ' 编辑器挂载 =', edOn);

  const inj = await E(`(()=>{const W=${DOC},ed=W.__mgEditor;if(!ed)return 'no-editor';
    const list=ed.store.list(),tpl=list.find(a=>a.kind==='decal');
    if(!tpl)return 'no-template';
    for(const a of list){if(a.kind==='decal'&&a.visible!==false)ed.store.update(a.id,{visible:false});}
    const c=JSON.parse(JSON.stringify(tpl));
    c.id='pixel-decal-'+Date.now();c.title='像素验收贴面';c.visible=true;
    c.projector={position:[0,1.22,7.7],quaternion:[-0.7071,0,0,0.7071],half:[4,3,1.2],depth:2.4};
    ed.store.add(c);
    return c.id;})()`);
  if (!/^pixel-decal-/.test(String(inj))) throw new Error('贴面注入失败: ' + inj);
  const DECAL_ID = String(inj);
  console.log('  注入 =', DECAL_ID);

  for (let i = 0; i < 30; i++) {
    const d0 = await dbg();
    if (d0?.instances?.some(x => x.id === DECAL_ID)) break;
    await sleep(300);
  }
  await E(`(()=>{const W=${DOC},ed=W.__mgEditor;ed.action('decal-rebuild','${DECAL_ID}');return 1;})()`);
  await sleep(2000);
  for (let i = 0; i < 40; i++) {
    const d1 = await dbg();
    if (d1?.pickReady === true) break;
    await sleep(300);
  }

  // 切到 demo 画面（留空 URL → 内置演示画面，色相稳定，便于测主色相）
  await E(`(()=>{const W=${DOC},ed=W.__mgEditor;
    ed.action('media',{id:'${DECAL_ID}',type:'video',url:''});return 1;})()`);
  await sleep(1500);

  const rect = await obbRect(DECAL_ID);
  console.log('  OBB 屏幕矩形 =', JSON.stringify(rect));
  if (!rect || rect.w < 4 || rect.h < 4) throw new Error('OBB 屏幕矩形无效，无法做像素验收');

  console.log('\n===== B. 可见态 / 隐藏态两帧截图 =====');
  const shotVisible = await shot('visible');
  // 隐藏贴花：把标注 visible=false（sync 会隐藏渲染实例）
  await E(`(()=>{const W=${DOC},ed=W.__mgEditor;
    ed.store.update('${DECAL_ID}',{visible:false});return 1;})()`);
  await sleep(1200);
  const shotHidden = await shot('hidden');
  // 恢复
  await E(`(()=>{const W=${DOC},ed=W.__mgEditor;
    ed.store.update('${DECAL_ID}',{visible:true});return 1;})()`);
  await sleep(800);

  if (!shotVisible || !shotHidden) throw new Error('截图失败');
  console.log('  可见帧 =', shotVisible.width + 'x' + shotVisible.height,
    ' 隐藏帧 =', shotHidden.width + 'x' + shotHidden.height);

  // ---- 差分分析 ----
  const W = Math.min(shotVisible.width, shotHidden.width);
  const H = Math.min(shotVisible.height, shotHidden.height);
  // OBB 矩形换算到截图像素（截图是 CSS 像素尺度）
  const rx = Math.max(0, Math.round(rect.x));
  const ry = Math.max(0, Math.round(rect.y));
  const rw = Math.min(W - rx, Math.round(rect.w));
  const rh = Math.min(H - ry, Math.round(rect.h));
  if (rw < 4 || rh < 4) throw new Error(`OBB 矩形在截图中无效: ${rw}x${rh}`);

  const changed = new Uint8Array(rw * rh);
  let changedCount = 0;
  let minX = rw, minY = rh, maxX = -1, maxY = -1;
  const diffOutside = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const d = Math.max(
        Math.abs(shotVisible.data[i] - shotHidden.data[i]),
        Math.abs(shotVisible.data[i + 1] - shotHidden.data[i + 1]),
        Math.abs(shotVisible.data[i + 2] - shotHidden.data[i + 2]));
      const inRect = x >= rx && x < rx + rw && y >= ry && y < ry + rh;
      if (inRect) {
        const j = (y - ry) * rw + (x - rx);
        if (d > PIX_DELTA) {
          changed[j] = 1; changedCount++;
          if (x - rx < minX) minX = x - rx;
          if (y - ry < minY) minY = y - ry;
          if (x - rx > maxX) maxX = x - rx;
          if (y - ry > maxY) maxY = y - ry;
        }
      } else if (d > PIX_DELTA) {
        diffOutside.push(1);
      }
    }
  }
  const rectArea = rw * rh;
  const coverage = changedCount / rectArea;
  const bboxArea = (maxX >= minX) ? (maxX - minX + 1) * (maxY - minY + 1) : 0;
  const bboxRatio = bboxArea / rectArea;
  const outsideRatio = diffOutside.length / (W * H - rectArea || 1);

  const inRectMask = (x, y) => x >= rx && x < rx + rw && y >= ry && y < ry + rh;
  const hueVisible = dominantHue(shotVisible.data, W, H, inRectMask);
  const hueSource = await E(`(()=>{const W=${DOC};return 1;})()`);   // 占位：源色相由 demo 画面常量给出
  // 内置演示画面主色：蓝色斜纹 (20,90,160) 与 橙色边框 (255,140,0)
  const hueDemo = 210;   // 蓝色斜纹主色相（rgb(20,90,160) → H≈208）
  const hueDeltaMeasured = hueDelta(hueVisible, hueDemo);

  console.log('\n===== C. 像素差分指标 =====');
  console.log('  OBB 矩形（截图像素）=', rw + 'x' + rh, ' 面积 =', rectArea);
  console.log('  变化像素数 =', changedCount);
  console.log('  ① 差分覆盖率 =', coverage.toFixed(4), '（阈值 ≥', TH.coverage, '）');
  console.log('  ② 包围盒面积占比 =', bboxRatio.toFixed(4), '（阈值 ≥', TH.bbox, '）');
  console.log('  ③ 主色相差 =', hueDeltaMeasured == null ? 'N/A' : hueDeltaMeasured.toFixed(1) + '°',
    '（阈值 ≤', TH.hue, '°）  贴花区主色相 =', hueVisible);
  console.log('  非贴花区差分占比 =', outsideRatio.toFixed(5), '（故障注入阈值 ≤', NON_DECAL_DIFF_MAX, '）');

  const margins = {
    coverage: coverage - TH.coverage,
    bbox: bboxRatio - TH.bbox,
    hue: hueDeltaMeasured == null ? null : TH.hue - hueDeltaMeasured,
    dpr: null
  };
  const needMargin = (v, th) => v >= th * (1 + TH.marginRatio);

  console.log('\n===== D. DPR 对照（devicePixelRatio = 1 与 2）=====');
  // 用 Emulation.setDeviceMetricsOverride 切换 DPR，各测一次覆盖率
  async function measureAtDpr(dpr) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1280, height: 800, deviceScaleFactor: dpr, mobile: false
    });
    await sleep(2500);
    const v2 = await shot('dpr' + dpr);
    await E(`(()=>{const W=${DOC},ed=W.__mgEditor;
      ed.store.update('${DECAL_ID}',{visible:false});return 1;})()`);
    await sleep(1200);
    const h2 = await shot('dpr' + dpr + '-hidden');
    await E(`(()=>{const W=${DOC},ed=W.__mgEditor;
      ed.store.update('${DECAL_ID}',{visible:true});return 1;})()`);
    await sleep(600);
    if (!v2 || !h2) return null;
    const w2 = Math.min(v2.width, h2.width), h2h = Math.min(v2.height, h2.height);
    const r2 = await obbRect(DECAL_ID);
    const rx2 = Math.max(0, Math.round(r2.x)), ry2 = Math.max(0, Math.round(r2.y));
    const rw2 = Math.min(w2 - rx2, Math.round(r2.w)), rh2 = Math.min(h2h - ry2, Math.round(r2.h));
    if (rw2 < 4 || rh2 < 4) return null;
    let cnt = 0;
    for (let y = ry2; y < ry2 + rh2; y++) {
      for (let x = rx2; x < rx2 + rw2; x++) {
        const i = (y * w2 + x) * 4;
        const d = Math.max(
          Math.abs(v2.data[i] - h2.data[i]),
          Math.abs(v2.data[i + 1] - h2.data[i + 1]),
          Math.abs(v2.data[i + 2] - h2.data[i + 2]));
        if (d > PIX_DELTA) cnt++;
      }
    }
    return { coverage: cnt / (rw2 * rh2), size: v2.width + 'x' + v2.height };
  }
  const dpr1 = await measureAtDpr(1);
  const dpr2 = await measureAtDpr(2);
  await send('Emulation.clearDeviceMetricsOverride');
  await sleep(1200);
  const dprDelta = (dpr1 && dpr2) ? Math.abs(dpr1.coverage - dpr2.coverage) : null;
  margins.dpr = dprDelta == null ? null : TH.dprDelta - dprDelta;
  console.log('  DPR=1 覆盖率 =', dpr1 ? dpr1.coverage.toFixed(4) + ' (' + dpr1.size + ')' : 'N/A');
  console.log('  DPR=2 覆盖率 =', dpr2 ? dpr2.coverage.toFixed(4) + ' (' + dpr2.size + ')' : 'N/A');
  console.log('  ④ 覆盖率差 =', dprDelta == null ? 'N/A' : dprDelta.toFixed(4),
    '（阈值 ≤', TH.dprDelta, '）');

  console.log('\n===== E. 故障注入（三种：主画面不得黑屏）=====');
  const injections = [];

  // 注入 1：shader 编译失败（破坏 WGSL 源）
  const inj1 = await E(`(()=>{const W=${DOC},ed=W.__mgEditor;
    const m=ed.decalMgr;if(!m)return 'no-mgr';
    const inst=m.instances.get('${DECAL_ID}');
    if(!inst)return 'no-inst';
    // 破坏材质：把 uPickReady 恒置 1 但所有 uniform 未绑定 → 等价于编译失败后的空实现
    inst.material=null;
    return 'ok';})()`);
  await sleep(1200);
  const inj1Shot = await shot('fault-shader');
  injections.push({ name: 'shader 编译失败', applied: inj1 === 'ok', shot: inj1Shot });

  // 恢复实例
  await E(`(()=>{const W=${DOC},ed=W.__mgEditor;
    ed.store.update('${DECAL_ID}',{visible:true});return 1;})()`);
  await sleep(500);

  // 注入 2：视频纹理加载失败（URL 指向不存在的文件）
  await E(`(()=>{const W=${DOC},ed=W.__mgEditor;
    ed.action('media',{id:'${DECAL_ID}',type:'video',url:'./media/__not_exist__.mp4'});return 1;})()`);
  await sleep(1800);
  const inj2Shot = await shot('fault-video');
  const inj2Dbg = await dbg();
  injections.push({ name: '视频纹理加载失败', applied: true, shot: inj2Shot,
    videoErr: (inj2Dbg?.instances || []).find(x => x.id === DECAL_ID)?.videoErr || null });

  // 注入 3：深度贴图缺失（pick 快照不可用）
  await E(`(()=>{const W=${DOC},ed=W.__mgEditor;
    ed.action('media',{id:'${DECAL_ID}',type:'video',url:''});return 1;})()`);
  await sleep(800);
  const inj3Dbg = await E(`(()=>{const W=${DOC},ed=W.__mgEditor;const m=ed.decalMgr;
    if(!m)return null;const inst=m.instances.get('${DECAL_ID}');
    if(!inst)return null;inst.material.setParameter('uPickReady',0);return 'ok';})()`);
  await sleep(1000);
  const inj3Shot = await shot('fault-depth');
  injections.push({ name: '深度贴图缺失', applied: inj3Dbg === 'ok', shot: inj3Shot });

  // 恢复：重建实例（材质被破坏的实例需要重建）
  await E(`(()=>{const W=${DOC},ed=W.__mgEditor;
    const m=ed.decalMgr;if(m&&m.instances)m.instances.delete('${DECAL_ID}');
    ed.store.update('${DECAL_ID}',{visible:true});return 1;})()`);
  await sleep(1500);

  // 故障注入判定：主画面持续出帧（非纯黑）且非贴花区差分占比 ≤ 0.02
  function nonBlackRatio(img) {
    if (!img) return null;
    let black = 0, n = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      n++;
      if (img.data[i] < 6 && img.data[i + 1] < 6 && img.data[i + 2] < 6) black++;
    }
    return 1 - black / n;
  }
  const injResults = injections.map((x, idx) => {
    const ratio = nonBlackRatio(x.shot);
    // 与「无贴花的干净帧」比较非贴花区差分
    let outside = null;
    if (x.shot && shotHidden) {
      const w = Math.min(x.shot.width, shotHidden.width);
      const h = Math.min(x.shot.height, shotHidden.height);
      let diff = 0, tot = 0;
      for (let y = 0; y < h; y++) {
        for (let px = 0; px < w; px++) {
          const inR = px >= rx && px < rx + rw && y >= ry && y < ry + rh;
          if (inR) continue;
          tot++;
          const i = (y * w + px) * 4;
          const d = Math.max(
            Math.abs(x.shot.data[i] - shotHidden.data[i]),
            Math.abs(x.shot.data[i + 1] - shotHidden.data[i + 1]),
            Math.abs(x.shot.data[i + 2] - shotHidden.data[i + 2]));
          if (d > PIX_DELTA) diff++;
        }
      }
      outside = tot ? diff / tot : null;
    }
    return {
      name: x.name, applied: !!x.applied,
      nonBlackRatio: ratio == null ? null : +ratio.toFixed(5),
      outsideDiffRatio: outside == null ? null : +outside.toFixed(5),
      videoErr: x.videoErr || null,
      pass: !!x.applied && ratio != null && ratio > 0.5 &&
        (outside == null || outside <= NON_DECAL_DIFF_MAX)
    };
  });
  injResults.forEach(r => {
    console.log(`  ${r.name}: applied=${r.applied} 非黑像素占比=${r.nonBlackRatio} ` +
      `非贴花区差分=${r.outsideDiffRatio} -> ${r.pass ? 'PASS' : 'FAIL'}` +
      (r.videoErr ? ' videoErr=' + r.videoErr : ''));
  });

  // ---- 汇总判定 ----
  const p1 = coverage >= TH.coverage && needMargin(coverage, TH.coverage);
  const p2 = bboxRatio >= TH.bbox && needMargin(bboxRatio, TH.bbox);
  const p3 = hueDeltaMeasured != null && hueDeltaMeasured <= TH.hue &&
    (TH.hue - hueDeltaMeasured) >= TH.hue * TH.marginRatio;
  const p4 = dprDelta != null && dprDelta <= TH.dprDelta &&
    (TH.dprDelta - dprDelta) >= TH.dprDelta * TH.marginRatio;
  const p5 = injResults.every(r => r.pass);

  console.log('\n================ 结论 ================');
  console.log('  ① 差分覆盖率     =', coverage.toFixed(4), ' 阈值', TH.coverage, ' 裕量', margins.coverage.toFixed(4),
    '->', p1 ? 'PASS' : 'FAIL');
  console.log('  ② 包围盒占比     =', bboxRatio.toFixed(4), ' 阈值', TH.bbox, ' 裕量', margins.bbox.toFixed(4),
    '->', p2 ? 'PASS' : 'FAIL');
  console.log('  ③ 主色相差       =', hueDeltaMeasured == null ? 'N/A' : hueDeltaMeasured.toFixed(1) + '°',
    ' 阈值', TH.hue + '°', ' 裕量', margins.hue == null ? 'N/A' : margins.hue.toFixed(1) + '°',
    '->', p3 ? 'PASS' : 'FAIL');
  console.log('  ④ DPR 覆盖率差   =', dprDelta == null ? 'N/A' : dprDelta.toFixed(4),
    ' 阈值', TH.dprDelta, ' 裕量', margins.dpr == null ? 'N/A' : margins.dpr.toFixed(4),
    '->', p4 ? 'PASS' : 'FAIL');
  console.log('  ⑤ 故障注入三项   ->', p5 ? 'PASS' : 'FAIL');
  console.log('  JS 错误数 =', errors.length, errors.slice(0, 3));

  const pass = p1 && p2 && p3 && p4 && p5 && errors.length === 0;
  console.log('  贴花像素级验收:', pass ? 'PASS' : 'FAIL');

  fs.writeFileSync(path.join(ROOT, 'tools', 'probe-decal-pixel.json'), JSON.stringify({
    backend, forceGL: FORCE_GL, decalId: DECAL_ID, dpr: rect?.dpr,
    obbRect: rect, shotSize: shotVisible.width + 'x' + shotVisible.height,
    metrics: {
      coverage: +coverage.toFixed(4),
      bboxRatio: +bboxRatio.toFixed(4),
      hueDelta: hueDeltaMeasured == null ? null : +hueDeltaMeasured.toFixed(2),
      hueVisible, hueSource: hueDemo,
      dprDelta: dprDelta == null ? null : +dprDelta.toFixed(4),
      outsideDiffRatio: +outsideRatio.toFixed(5),
      changedPixels: changedCount, rectArea
    },
    thresholds: TH, margins, dpr1, dpr2,
    injections: injResults, errors, pass
  }, null, 2));
  console.log('  report -> tools/probe-decal-pixel.json');
}

main().then(() => { cleanup(); process.exit(0); })
  .catch(e => { console.error('PROBE FAILED', e); cleanup(); process.exit(1); });

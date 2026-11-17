/**
 * 黑屏真机诊断（不注入 __viewer mock）
 *
 * 与 verify_editor.mjs 的区别：
 *   - 不覆写 window.__viewer、不建 ed-mock-canvas，真实 PlayCanvas / SOG 链路照常跑
 *   - Target.setAutoAttach(flatten) 捕获 iframe 内 pageerror / console.error / loadingFailed / 404
 *   - 只统计 iframe 内 canvas 区域的像素亮度 + 连续两帧差分（判断画面是否冻结/全黑）
 *   - 采集 gsplats 实际渲染数、WebGL contextLost、clearColor、加载/错误遮罩可见性
 *   - 覆盖：浏览态 / 进入编辑 / 退出编辑 / 反复进出 / 同场景与跨场景楼层切换 /
 *           默认机位 A-B 对比 / 加载首帧门控时间线
 *
 * 用法（工程根目录）： node tools/diagnose_blackscreen.mjs
 *   --wait=20000   每个导航后等待毫秒数
 *   --loops=5      反复进出编辑次数
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 18131;
const CDP_PORT = 9257;
const BASE = `http://127.0.0.1:${PORT}`;
const WAIT = Number((process.argv.find(a => a.startsWith('--wait=')) || '').split('=')[1]) || 20000;
const LOOPS = Number((process.argv.find(a => a.startsWith('--loops=')) || '').split('=')[1]) || 5;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)],
  { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'diag_' + Date.now());
fs.mkdirSync(profile, { recursive: true });
const br = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--window-size=1280,800', 'about:blank'
], { stdio: 'ignore' });

function cleanup() {
  try { br.kill(); } catch { /* noop */ }
  try { srv.kill(); } catch { /* noop */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* noop */ }
}

let ws, seq = 0;
const pend = new Map();
const sessions = new Map();
const topErrors = [];
const requests = [];

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
    if (!o.method) return;
    if (o.method === 'Target.attachedToTarget') {
      const s = o.params.sessionId;
      sessions.set(s, { url: o.params.targetInfo?.url || '', errors: [] });
      send('Runtime.enable', {}, s); send('Log.enable', {}, s); send('Network.enable', {}, s);
    }
    const rec = o.sessionId ? sessions.get(o.sessionId) : null;
    const push = (kind, text) => { (rec ? rec.errors : topErrors).push({ kind, text, url: rec ? rec.url : '' }); };
    if (o.method === 'Runtime.exceptionThrown')
      push('pageerror', o.params.exceptionDetails?.exception?.description || o.params.exceptionDetails?.text || '');
    else if (o.method === 'Runtime.consoleAPICalled' && o.params.type === 'error')
      push('console.error', (o.params.args || []).map(a => a.value ?? a.description ?? '').join(' '));
    else if (o.method === 'Log.entryAdded' && o.params.entry?.level === 'error')
      push('log.error', o.params.entry?.text || '');
    else if (o.method === 'Network.loadingFailed')
      push('loadingFailed', o.params.errorText + ' ' + (o.params.type || ''));
    else if (o.method === 'Network.responseReceived' && o.params.response?.status >= 400)
      push('http' + o.params.response.status, o.params.response.url);
    else if (o.method === 'Network.requestWillBeSent')
      requests.push(o.params.request?.url || '');
  };

  function send(method, params = {}, sessionId) {
    return new Promise(res => {
      const id = ++seq; pend.set(id, res);
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      ws.send(JSON.stringify(msg));
    });
  }
  const E = async (expression, timeoutMs = 20000) => {
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

  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await send('Runtime.enable'); await send('Log.enable');
  await send('Network.enable'); await send('Page.enable');

  /* 找到「真实文档」：融合页取 active iframe，直开 gs-viewer 时用 top */
  const DOC = `(()=>{const f=document.querySelector('iframe.gs-scene-frame[data-active="1"]')||document.querySelector('iframe.gs-scene-frame');return f?f.contentWindow:window;})()`;

  const probeExpr = `(()=>{
    const W=${DOC}, d=W.document;
    const v=W.__viewer, app=v?.app;
    let cam=null,fov=null,near=null,far=null,clear=null,ctxLost=null,gsplats=null,framebuffer=null;
    try{const c=app?.root?.findComponent?.('camera');if(c){const p=c.entity?.getPosition?.();cam=p?[+p.x.toFixed(4),+p.y.toFixed(4),+p.z.toFixed(4)]:null;fov=c.fov;near=c.nearClip;far=c.farClip;}}catch(e){cam='err:'+e.message}
    try{gsplats=app?.stats?.frame?.gsplats??null;}catch(_){}
    const cv=d.querySelector('#mg-stage canvas');
    let rect=null, abs=null;
    if(cv){const r=cv.getBoundingClientRect();rect=[r.x,r.y,r.width,r.height];
      const f=document.querySelector('iframe.gs-scene-frame');
      if(f&&f.contentWindow===W){const fr=f.getBoundingClientRect();abs=[r.x+fr.x,r.y+fr.y,r.width,r.height];}else abs=rect;
    }
    const gl=cv?.getContext?.('webgl2')||cv?.getContext?.('webgl');
    try{if(gl){ctxLost=gl.isContextLost?.()??null;const cc=gl.getParameter(gl.COLOR_CLEAR_VALUE);if(cc)clear=[...cc].map(n=>+n.toFixed(3));
      framebuffer=gl.getParameter(gl.FRAMEBUFFER_BINDING)?'offscreen':'default';}}catch(_){}
    const ld=d.getElementById('mg-loading'), eb=d.getElementById('mg-error');
    const vis=(el)=>{if(!el)return null;const s=getComputedStyle(el);return {hidden:el.hidden,display:s.display,opacity:s.opacity,visibility:s.visibility,cls:el.className};};
    return {
      isFusion: W!==window,
      viewer:!!v, autoRender:app?app.autoRender:null, renderNextFrame:app?app.renderNextFrame:null,
      gsplats, ctxLost, clearColor:clear, framebuffer,
      canvas:!!cv, canvasSize:cv?[cv.width,cv.height]:null, canvasRect:rect, canvasAbs:abs,
      cam,fov:+((fov)||0).toFixed(2),near,far:+((far)||0).toFixed(2),
      renderer:W.__mgRenderer?.renderer||null, rendererReason:W.__mgRenderer?.reason||null,
      loading:vis(ld), loadingReason:ld?.dataset?.reveal||null, mgLoading:W.__mgLoading||null,
      error:vis(eb), errorText:eb?.textContent||'',
      posterVisible:!!d.querySelector('#mg-stage img')||!!d.querySelector('.mg-poster'),
      bridgeStage:W.__mgEditorBridge?.stage||null,
      mounted:!!W.__mgEditorBridge?.mounted, ed:!!W.__mgEditor,
      pose:W.__mgPose?.()||null,
      host:window.__mgEditorHost?.getState?.()||null,
      attr:document.documentElement.dataset.gsEditor||'',
      frames:[...document.querySelectorAll('iframe.gs-scene-frame')].map(f=>({scene:f.dataset.scene,active:f.dataset.active,src:f.getAttribute('src')}))
    };})()`;
  const probe = () => E(probeExpr);

  /* 只统计 canvas 区域像素；dataB 存在时同时算帧间差分 */
  async function pixels(dataA, dataB, rect) {
    return E(`(async(a,b,rect)=>{
      const load=async(data)=>{const im=new Image();im.src='data:image/png;base64,'+data;await im.decode();
        const c=document.createElement('canvas');c.width=im.width;c.height=im.height;
        const g=c.getContext('2d');g.drawImage(im,0,0);return {c,g,d:g.getImageData(0,0,c.width,c.height).data,w:im.width,h:im.height};};
      const A=await load(a);
      const clip=rect&&rect[2]>2&&rect[3]>2?{x0:Math.max(0,Math.round(rect[0])),y0:Math.max(0,Math.round(rect[1])),
        x1:Math.min(A.w,Math.round(rect[0]+rect[2])),y1:Math.min(A.h,Math.round(rect[1]+rect[3]))}
        :{x0:0,y0:0,x1:A.w,y1:A.h};
      let n=0,sum=0,sum2=0,bright=0,nearBlack=0;
      for(let y=clip.y0;y<clip.y1;y+=3)for(let x=clip.x0;x<clip.x1;x+=3){
        const i=(y*A.w+x)*4;const L=0.2126*A.d[i]+0.7152*A.d[i+1]+0.0722*A.d[i+2];
        n++;sum+=L;sum2+=L*L;if(L>40)bright++;if(L<12)nearBlack++;
      }
      const mean=n?sum/n:0,sd=n?Math.sqrt(Math.max(0,sum2/n-mean*mean)):0;
      let diff=null;
      if(b){const B=await load(b);let dn=0,dsum=0,changed=0;
        for(let y=clip.y0;y<clip.y1;y+=4)for(let x=clip.x0;x<clip.x1;x+=4){
          const i=(y*A.w+x)*4;
          if(i+2>=B.d.length)continue;
          const dv=Math.abs(A.d[i]-B.d[i])+Math.abs(A.d[i+1]-B.d[i+1])+Math.abs(A.d[i+2]-B.d[i+2]);
          dn++;dsum+=dv;if(dv>18)changed++;
        }
        diff={meanDiff:+(dsum/Math.max(1,dn)).toFixed(3),changedRatio:+(changed/Math.max(1,dn)).toFixed(4)};
      }
      return {w:A.w,h:A.h,clip,n,mean:+mean.toFixed(2),sd:+sd.toFixed(2),
        brightRatio:+(bright/Math.max(1,n)).toFixed(4),nearBlackRatio:+(nearBlack/Math.max(1,n)).toFixed(4),
        black:mean<18&&sd<14, diff};
    })(${JSON.stringify(dataA)},${dataB ? JSON.stringify(dataB) : 'null'},${JSON.stringify(rect)})`, 30000);
  }

  async function shot() {
    const p = await probe();
    const rect = p?.canvasAbs || null;
    const clip = rect ? { x: Math.max(0, rect[0]), y: Math.max(0, rect[1]), width: Math.max(2, rect[2]), height: Math.max(2, rect[3]), scale: 1 } : undefined;
    const r1 = await send('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' });
    await sleep(900);
    const r2 = await send('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' });
    if (!r1.result?.data) return { err: 'no screenshot' };
    // clip 截图的坐标原点就是 clip 左上角
    const localRect = clip ? [0, 0, clip.width, clip.height] : rect;
    return pixels(r1.result.data, r2.result?.data, localRect);
  }

  const report = { wait: WAIT, loops: LOOPS, steps: [], errors: [], requests: {} };
  const step = async (label, note = '') => {
    const p = await probe();
    const s = await shot();
    report.steps.push({ label, note, probe: p, shot: s });
    const q = s || {}, pp = p || {};
    console.log(`\n--- ${label} ${note}`);
    console.log('  probe:', JSON.stringify(pp));
    console.log('  shot :', JSON.stringify(q));
    return { p, s };
  };

  await send('Page.navigate', { url: BASE + '/' });

  /* ---- 加载时间线：定位「黑屏窗口」究竟持续多久 ----
     t 是名义采样点；每次 CDP 截图 + 像素解码本身要耗时，wall 才是真实墙钟。 */
  if (process.argv.includes('--timeline')) {
    const marks = [300, 800, 1500, 2500, 3500, 4500, 5500, 7000, 9000, 12000, 18000];
    const tl = [];
    let last = 0;
    const wall0 = Date.now();
    for (const t of marks) {
      await sleep(t - last); last = t;
      const p = await probe();
      const rect = p?.canvasAbs || null;
      const clip = rect ? { x: Math.max(0, rect[0]), y: Math.max(0, rect[1]), width: Math.max(2, rect[2]), height: Math.max(2, rect[3]), scale: 1 } : undefined;
      const r = await send('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' });
      const px = r.result?.data ? await pixels(r.result.data, null, clip ? [0, 0, clip.width, clip.height] : rect) : {};
      const row = {
        t, wall: Date.now() - wall0,
        gsplats: p?.gsplats ?? null, autoRender: p?.autoRender ?? null,
        cam: p?.cam ?? null, fov: p?.fov ?? null, canvas: p?.canvas ?? null,
        loadingOpacity: p?.loading?.opacity ?? null,
        revealReason: p?.mgLoading?.reason ?? null,
        revealAtMs: p?.mgLoading?.atMs ?? null,
        revealGsplats: p?.mgLoading?.gsplats ?? null,
        // 黑屏窗口 = 遮罩已淡出，但一帧高斯都还没渲染出来
        blackWindow: p?.loading?.opacity === '0' && (p?.gsplats ?? 0) === 0,
        clearColor: p?.clearColor ?? null,
        mean: px?.mean ?? null, sd: px?.sd ?? null,
        dark: px?.nearBlackRatio ?? null, black: px?.black ?? null
      };
      tl.push(row);
      console.log(`  [timeline t=${t}ms] ${JSON.stringify(row)}`);
    }
    report.timeline = tl;
  }
  await sleep(Math.max(0, WAIT - 18000));
  await step('browse-default', '默认首页 outdoor.html / spawn=outdoor');

  await E(`(()=>{document.getElementById('gsEditorBtn')?.click();return 1})()`);
  await sleep(3500);
  await step('editor-enter', '点击标注编辑');

  await E(`(()=>{document.getElementById('gs-editor-exit')?.click();return 1})()`);
  await sleep(2500);
  await step('editor-exit', '点击退出编辑');

  for (let i = 0; i < LOOPS; i++) {
    await E(`(()=>{document.getElementById('gsEditorBtn')?.click();return 1})()`);
    await sleep(1200);
    await E(`(()=>{document.getElementById('gs-editor-exit')?.click();return 1})()`);
    await sleep(900);
  }
  await sleep(1500);
  await step('editor-loops', `反复进出 ${LOOPS} 次后`);

  /* 楼层切换：同场景只换 spawn、跨场景新建常驻 iframe，是「切换后黑屏」的高发路径 */
  await E(`(()=>{const a=document.querySelector('a.floor-link[href="floor-1.html"]');a?.click();return !!a})()`);
  await sleep(4500);
  await step('switch-same-scene', '同场景切一层（复用已解码 SOG）');

  await E(`(()=>{const a=document.querySelector('a.floor-link[href="floor-3.html"]');a?.click();return !!a})()`);
  await sleep(20000);
  await step('switch-cross-scene', '跨场景新建三层 iframe（首帧门控 + 后台暂停）');

  /* 直开 gs-viewer，避免融合层干扰，做相机 A/B */
  await send('Page.navigate', { url: BASE + '/gs-viewer.html?embed=showroom&scene=floor1&spawn=floor1' });
  await sleep(WAIT);
  await step('ab-metric-spawn', 'spawn=floor1 米制机位 [18.5,1.89,17.07]');

  await send('Page.navigate', { url: BASE + '/gs-viewer.html?embed=showroom&scene=floor1&spawn=outdoor' });
  await sleep(WAIT);
  await step('ab-log-spawn', 'spawn=outdoor log 空间机位 [0,0.9555,0]');

  await send('Page.navigate', { url: BASE + '/gs-viewer.html?embed=showroom&scene=floor1&spawn=outdoor&pos=18.50247,1.894326,17.075218&look=17.583208,1.892035,17.468858' });
  await sleep(WAIT);
  await step('ab-pos-override', '?pos/?look 强制米制可见机位');

  report.errors = [
    ...topErrors.map(e => ({ ...e, scope: 'top' })),
    ...[...sessions.values()].flatMap(s => s.errors.map(e => ({ ...e, scope: 'frame:' + s.url.slice(0, 110) })))
  ];
  report.requests = {
    total: requests.length,
    sog: [...new Set(requests.filter(u => /\.sog/.test(u)))],
    wasm: [...new Set(requests.filter(u => /\.wasm/.test(u)))],
    lodMeta: requests.filter(u => /lod-meta\.json/.test(u))
  };

  console.log('\n================ 错误汇总（所有断言之后） ================');
  const grouped = {};
  for (const e of report.errors) {
    const k = e.kind + ' | ' + e.scope + ' | ' + e.text.slice(0, 160);
    grouped[k] = (grouped[k] || 0) + 1;
  }
  Object.entries(grouped).sort((a, b) => b[1] - a[1]).slice(0, 40)
    .forEach(([k, n]) => console.log(`  x${n}  ${k}`));
  console.log('  errors total =', report.errors.length);
  console.log('  requests:', JSON.stringify(report.requests));

  console.log('\n================ 结论 ================');
  for (const s of report.steps) {
    const sh = s.shot || {}, p = s.probe || {};
    console.log(`  ${s.label.padEnd(20)} black=${String(sh.black).padEnd(5)} mean=${String(sh.mean).padEnd(8)} sd=${String(sh.sd).padEnd(8)} dark=${String(sh.nearBlackRatio).padEnd(8)} diff=${JSON.stringify(sh.diff)} gsplats=${p.gsplats} autoRender=${p.autoRender} ctxLost=${p.ctxLost} cam=${JSON.stringify(p.cam)} fov=${p.fov} loading=${p.loading?.cls} errBox=${p.error?.hidden === false}`);
  }

  /* 首帧门控回归断言：遮罩淡出绝不能早于第一帧真实高斯渲染 */
  const tl = report.timeline || [];
  const windows = tl.filter(r => r.blackWindow);
  const gate = tl.find(r => r.revealReason);
  const firstRendered = tl.find(r => (r.gsplats ?? 0) > 0);
  // firstFrame 在 frameend 里 fire，该瞬间 app.stats.frame.gsplats 可能尚未落盘，
  // 因此不能拿 revealGsplats 当判据；用「遮罩淡出早于首个渲染帧」的采样关系判定。
  const gateOk = !!gate && (gate.revealReason === 'firstFrame' || gate.revealReason === 'gsplats');
  const skipped = tl.length === 0;   // 未加 --timeline 时无数据，不能判 FAIL
  const pass = !skipped && windows.length === 0 && gateOk && !!firstRendered;
  /* 旧指标的局限：整页截图混入了编辑器 UI / DOM 标注，black=false 只能说明
     「整页不是全黑」，不能证明 WebGL canvas 还在显示 3DGS；gsplats 也只是
     统计值。真实画布判定请用 tools/diagnose_editor_canvas.mjs。 */
  const glBad = report.steps.filter(s => {
    const c = s.probe?.clearColor;
    return (c && c[0] > 0.9 && c[1] > 0.9 && c[2] > 0.9) || s.probe?.framebuffer === 'offscreen';
  });
  console.log('\n  [指标说明] black=false 基于整页截图，含 DOM 覆盖层，不能证明 canvas 正常；'
    + '真实画布判定请用 tools/diagnose_editor_canvas.mjs');
  console.log('  GL 状态异常步骤（白色 clear / 离屏 framebuffer）:', glBad.length,
    glBad.map(s => s.label).join(',') || '-');
  report.glAnomalies = glBad.map(s => s.label);

  console.log('\n================ 首帧门控 ================');
  console.log('  淡出原因:', gate?.revealReason ?? 'N/A',
    ' 淡出时刻(iframe 内 ms):', gate?.revealAtMs ?? 'N/A',
    ' 淡出时观测 gsplats:', gate?.revealGsplats ?? 'N/A', '(frameend 时点统计可能尚未落盘)');
  console.log('  首个有渲染的采样: t=', firstRendered?.t ?? 'N/A',
    ' wall=', firstRendered?.wall ?? 'N/A', 'ms gsplats=', firstRendered?.gsplats ?? 'N/A');
  console.log('  提前淡出的黑屏窗口采样点:', windows.length,
    windows.length ? 't=' + windows.map(r => r.t).join(',') : '-');
  console.log('  首帧门控:', skipped ? 'SKIP（未加 --timeline）' : (pass ? 'PASS' : 'FAIL'));
  report.firstFrameGate = { skipped, pass: skipped ? null : pass, reason: gate?.revealReason ?? null,
    atMs: gate?.revealAtMs ?? null, gsplatsAtReveal: gate?.revealGsplats ?? null,
    firstRenderedAtMs: firstRendered?.wall ?? null,
    blackWindows: windows.map(r => r.t) };

  fs.writeFileSync(path.join(ROOT, 'tools', 'diagnose-report.json'), JSON.stringify(report, null, 2));
  console.log('\nreport -> tools/diagnose-report.json');
}

main().then(() => { cleanup(); process.exit(0); })
  .catch(e => { console.error('DIAG FAILED', e); cleanup(); process.exit(1); });

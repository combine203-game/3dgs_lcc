/**
 * 编辑态「canvas 消失」专项诊断 —— 修正 diagnose_blackscreen.mjs 的三个盲区：
 *
 *  1. 旧脚本对整页截图算亮度，编辑器 UI / DOM 标注把均值拉高，canvas 全黑也测不出。
 *     这里截图前临时隐藏所有 DOM 层，只留 WebGL canvas，并单独统计其像素。
 *  2. 旧脚本把 app.stats.frame.gsplats 当成「画面正常」的证据；那是统计值，
 *     不是 framebuffer 里的实际像素。这里同时读 gl.COLOR_CLEAR_VALUE 与
 *     gl.FRAMEBUFFER_BINDING，直接看 GL 状态有没有被引擎 Picker 的 pass 改写。
 *  3. 旧脚本每步只截两帧、只看 nearBlackRatio；这里进入编辑后连续多帧采样，
 *     并与进入前的 canvas 基线做差分。
 *
 * 用法： node tools/diagnose_editor_canvas.mjs
 *       --wait=20000   首帧等待毫秒
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 18133;
const CDP_PORT = 9259;
const BASE = `http://127.0.0.1:${PORT}`;
const WAIT = Number((process.argv.find(a => a.startsWith('--wait=')) || '').split('=')[1]) || 20000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)],
  { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'canvas_' + Date.now());
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
    if (o.method === 'Runtime.exceptionThrown')
      errors.push(o.params.exceptionDetails?.exception?.description || o.params.exceptionDetails?.text || '');
    else if (o.method === 'Runtime.consoleAPICalled' && o.params.type === 'error')
      errors.push((o.params.args || []).map(a => a.value ?? a.description ?? '').join(' '));
    else if (o.method === 'Runtime.consoleAPICalled' && o.params.type === 'warning')
      warns.push((o.params.args || []).map(a => a.value ?? a.description ?? '').join(' '));
  };
  function send(method, params = {}) {
    return new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  }
  const E = async (expression, timeoutMs = 25000) => {
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

  // 主帧是否真的在渲染：postrender 每触发一次就是一次完整的 app.render()。
  // 这比 gsplats / autoRender 统计值更能说明「画面有没有被重绘」。
  await E(`(()=>{const W=${DOC};const app=W.__viewer?.app;if(!app)return 0;
    W.__postCount=0;app.on('postrender',()=>{W.__postCount++;});return 1;})()`);

  // 自检：iframe 内的 console.warn 是否真能收到。若通道不通，
  // 「0 条贴花守卫告警」会是假阴性，必须让整次判定不可信。
  await E(`(()=>{const W=${DOC};W.console.warn('__diag_warn_probe__');return 1})()`);
  await sleep(300);
  const warnChannelOk = warns.some(w => w.includes('__diag_warn_probe__'));

  const probeExpr = `(()=>{
    const W=${DOC}, d=W.document, v=W.__viewer, app=v?.app;
    const cv=d.querySelector('#mg-stage canvas');
    let rect=null,abs=null,cc=null,fb=null,ctxLost=null;
    if(cv){const r=cv.getBoundingClientRect();rect=[r.x,r.y,r.width,r.height];
      const f=document.querySelector('iframe.gs-scene-frame');
      if(f&&f.contentWindow===W){const fr=f.getBoundingClientRect();abs=[r.x+fr.x,r.y+fr.y,r.width,r.height];}else abs=rect;}
    const gl=cv?.getContext?.('webgl2')||cv?.getContext?.('webgl');
    try{if(gl){ctxLost=gl.isContextLost?.()??null;
      const c=gl.getParameter(gl.COLOR_CLEAR_VALUE);if(c)cc=[...c].map(n=>+n.toFixed(3));
      fb=gl.getParameter(gl.FRAMEBUFFER_BINDING)?'offscreen':'default';}}catch(_){}
    let gsplats=null,autoRender=null,renderNextFrame=null;
    try{gsplats=app?.stats?.frame?.gsplats??null;autoRender=app?.autoRender??null;renderNextFrame=app?.renderNextFrame??null;}catch(_){}
    let picker=false,decals=null;
    try{picker=typeof v?.picker==='function'&&!!v.picker();}catch(_){}
    try{decals=W.__mgEditor?.store?.list?.().filter(a=>a.kind==='decal'&&a.visible!==false).length??null;}catch(_){}
    return {canvas:!!cv,rect,abs,cc,fb,ctxLost,gsplats,autoRender,renderNextFrame,picker,
      postCount:W.__postCount??null,decals,
      editorOn:!!W.__mgEditor,loading:d.getElementById('mg-loading')?.className||'',
      bridge:W.__mgEditorBridge?.stage||null};
  })()`;

  /* 只截 WebGL canvas：临时隐藏 iframe 内全部 DOM 层（编辑器 UI / SVG 标注 / 遮罩），
     截图后立刻恢复。这样像素统计不再被 DOM 覆盖层污染。 */
  const hideDom = `(()=>{
    const W=${DOC},d=W.document;
    const sel='.ed-layer,.ed-ui,.ed-guides,.ed-marquee,#mg-loading,#mg-error,#mg-bar,#mg-helpbox,#mg-toolsbox,.sse-controlsWrap,.sse-controlsHint,.sse-infoPanel,.sse-joystick,.sse-panel';
    W.__hidden=d.querySelectorAll(sel);
    W.__hidden.forEach(e=>{e.dataset.__oldVis=e.style.visibility;e.style.visibility='hidden';});
    /* 父页 HUD 也必须隐藏，且要从基线就隐藏：编辑模式会用
       html[data-gs-editor=on] #stage{display:none} 把父页 HUD 整块撤掉。
       若基线里还留着这层半透明 HUD，基线 mean 会被压低，编辑态一进去
       就像「画面变了 30%」，这是上一版测试的假阳性来源。 */
    const f=document.querySelector('iframe.gs-scene-frame[data-active="1"]')||document.querySelector('iframe.gs-scene-frame');
    const keep=new Set();let e=f;
    while(e&&e!==document.documentElement){keep.add(e);e=e.parentElement;}
    window.__topHidden=[];
    document.querySelectorAll('body *').forEach(x=>{
      if(keep.has(x))return;
      window.__topHidden.push([x,x.style.visibility]);
      x.style.visibility='hidden';
    });
    return W.__hidden.length+'|'+window.__topHidden.length;
  })()`;
  const showDom = `(()=>{
    const W=${DOC};
    W.__hidden?.forEach(e=>{e.style.visibility=e.dataset.__oldVis||'';delete e.dataset.__oldVis;});
    W.__hidden=null;
    window.__topHidden?.forEach(([x,v])=>{x.style.visibility=v;});
    window.__topHidden=null;
    return 1;
  })()`;

  async function pixels(data) {
    return E(`(async(data)=>{
      const im=new Image();im.src='data:image/png;base64,'+data;await im.decode();
      const c=document.createElement('canvas');c.width=im.width;c.height=im.height;
      const g=c.getContext('2d');g.drawImage(im,0,0);const a=g.getImageData(0,0,c.width,c.height).data;
      let n=0,sum=0,sum2=0,dark=0,bright=0;
      for(let y=0;y<c.height;y+=3)for(let x=0;x<c.width;x+=3){
        const i=(y*c.width+x)*4,L=0.2126*a[i]+0.7152*a[i+1]+0.0722*a[i+2];
        n++;sum+=L;sum2+=L*L;if(L<12)dark++;if(L>40)bright++;}
      const mean=n?sum/n:0;
      return {w:c.width,h:c.height,n,mean:+mean.toFixed(2),sd:+(n?Math.sqrt(Math.max(0,sum2/n-mean*mean)):0).toFixed(2),
        nearBlack:+(dark/Math.max(1,n)).toFixed(4),bright:+(bright/Math.max(1,n)).toFixed(4),
        blank:mean<18&&(n?Math.sqrt(Math.max(0,sum2/n-mean*mean)):0)<14};
    })(${JSON.stringify(data)})`, 30000);
  }

  async function sample(label) {
    const p = await E(probeExpr);
    const rect = p?.abs || null;
    const clip = rect && rect[2] > 2 && rect[3] > 2
      ? { x: Math.max(0, rect[0]), y: Math.max(0, rect[1]), width: Math.max(2, rect[2]), height: Math.max(2, rect[3]), scale: 1 }
      : undefined;
    const r1 = await send('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' });
    await E(hideDom);
    const r2 = await send('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' });
    await E(showDom);
    const dom = r1.result?.data ? await pixels(r1.result.data) : null;
    const pure = r2.result?.data ? await pixels(r2.result.data) : null;
    const row = { label, probe: p, dom, pure };
    console.log(`  [${label}] pure=${JSON.stringify(pure)} dom=${JSON.stringify(dom && { mean: dom.mean, nearBlack: dom.nearBlack })}`);
    console.log(`     gl=${JSON.stringify({ cc: p?.cc, fb: p?.fb, ctxLost: p?.ctxLost })} gsplats=${p?.gsplats} autoRender=${p?.autoRender} postrender=${p?.postCount} decals=${p?.decals} picker=${p?.picker} ed=${p?.editorOn} bridge=${p?.bridge}`);
    return row;
  }

  const rows = [];
  console.log('\n===== 浏览态基线（3 次）=====');
  for (let i = 0; i < 3; i++) { rows.push(await sample('browse-' + i)); await sleep(600); }

  console.log('\n===== 进入编辑态（连续采样）=====');
  await E(`(()=>{document.getElementById('gsEditorBtn')?.click();return 1})()`);
  for (const t of [500, 1200, 2500, 5000, 9000]) {
    await sleep(t - (rows._last || 0)); rows._last = t;
    rows.push(await sample('editor-' + t));
  }
  delete rows._last;

  /* A/B：把全部 decal 设为不可见 → decalMgr.instances 清空、全屏 quad 关闭。
     若画面回到浏览态基线，说明亮度差来自贴花 quad；若仍是异常值，说明主帧
     根本没被重绘（framebuffer 仍停在 pick pass 的输出上）。 */
  console.log('\n===== A/B：临时隐藏全部贴花 =====');
  const hidden = await E(`(()=>{const W=${DOC},ed=W.__mgEditor;if(!ed)return 0;
    let n=0;ed.store.list().filter(a=>a.kind==='decal'&&a.visible!==false).forEach(a=>{
      ed.store.update(a.id,{visible:false},{});n++;});return n;})()`);
  console.log('  隐藏贴花数量 =', hidden);
  await sleep(2000);
  rows.push(await sample('no-decals'));

  console.log('\n===== 退出编辑态 =====');
  await E(`(()=>{document.getElementById('gs-editor-exit')?.click();return 1})()`);
  await sleep(2500);
  rows.push(await sample('exit'));

  const base = rows.slice(0, 3).filter(r => r.pure).map(r => r.pure.mean);
  const baseMean = base.length ? base.reduce((a, b) => a + b, 0) / base.length : 0;
  const ed = rows.filter(r => r.label.startsWith('editor-') && r.pure);
  const worst = ed.length ? Math.min(...ed.map(r => r.pure.mean)) : 0;
  const whiteClear = ed.some(r => r.probe?.cc && r.probe.cc[0] > 0.9 && r.probe.cc[1] > 0.9 && r.probe.cc[2] > 0.9);
  const offscreen = ed.some(r => r.probe?.fb === 'offscreen');
  const dropped = baseMean > 0 && worst < baseMean * 0.55;
  const blank = ed.some(r => r.pure.blank);
  // 关键断言：编辑态 canvas 必须仍是「同一幅 3DGS 画面」。
  // 亮度升高同样是故障（离屏 pick pass 的白色输出被留在 backBuffer），
  // 旧测试只看 nearBlackRatio / 只看下降，所以两种异常都漏了。
  const drift = baseMean > 0
    ? Math.max(...ed.map(r => Math.abs(r.pure.mean - baseMean))) / baseMean : 1;
  const drifted = drift > 0.12;
  const jsErrors = errors.length;
  // onPrerender / onFrameEnd 内部已做异常隔离，出错只会 console.warn 一次；
  // 因此必须把这两条 warn 也当失败，否则「异常被 try/catch 吞掉」会被误判为正常。
  const realWarns = warns.filter(w => !w.includes('__diag_warn_probe__'));
  const guardWarns = realWarns.filter(w => /贴花 uniform 更新失败|pickView 获取失败|shader 编译\/构造失败/.test(w));

  console.log('\n================ 结论 ================');
  console.log('  浏览态 canvas 基线 mean =', baseMean.toFixed(2));
  console.log('  编辑态 canvas mean 区间 =', Math.min(...ed.map(r => r.pure.mean)).toFixed(2),
    '~', Math.max(...ed.map(r => r.pure.mean)).toFixed(2));
  console.log('  与基线最大相对偏差 =', (drift * 100).toFixed(1) + '%', ' 判为画面被替换 =', drifted);
  console.log('  纯色/空白帧 =', blank, ' 亮度骤降 =', dropped);
  console.log('  GL clearColor 变白(Picker pass) =', whiteClear, ' 离屏 framebuffer 未恢复 =', offscreen);
  console.log('  JS 异常 =', jsErrors, errors.slice(0, 2));
  console.log('  贴花/pick 守卫告警 =', guardWarns.length, guardWarns.slice(0, 2));
  console.log('  iframe console.warn 捕获通道 =', warnChannelOk ? 'OK' : '不可用（判定不可信）');
  const pass = !dropped && !blank && !whiteClear && !drifted &&
    jsErrors === 0 && guardWarns.length === 0 && warnChannelOk;
  console.log('  编辑态画布:', pass ? 'PASS' : 'FAIL');

  const report = { baseMean, worst, drift, drifted, dropped, blank, whiteClear, offscreen,
    jsErrors, guardWarns, warnChannelOk, warns: realWarns, pass, errors, rows };
  fs.writeFileSync(path.join(ROOT, 'tools', 'diagnose-editor-canvas.json'), JSON.stringify(report, null, 2));
  console.log('  report -> tools/diagnose-editor-canvas.json');
}

main().then(() => { cleanup(); process.exit(0); })
  .catch(e => { console.error('DIAG FAILED', e); cleanup(); process.exit(1); });

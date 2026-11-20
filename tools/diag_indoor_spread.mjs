/**
 * 室内墙面贴花「只有框线没视频」根因诊断
 * ----------------------------------------------------------------
 * 假设：editor.js:683 的 spread 拦截 (spread>1.2 / med>60) 在室内墙面
 * 被少数深度拾取失败点触发 → projector 未生成 → 只剩 Overlay 框线。
 *
 * 做法：直达一层室内机位 (?view=floor-1.html&edit=1)，进入编辑态后，
 * 对屏幕中央多个候选矩形直接调 picker.unprojectRect(6,6)，
 * 输出 49 点距离分布的 min/p10/med/p90/max、spread，以及按现有逻辑是否会被拦截。
 * 同时抓一张当前机位截图确认看到的是室内墙。
 *
 * 用法： node tools/diag_indoor_spread.mjs [--headed] [--wait=22000]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 18145, CDP_PORT = 9271;
const BASE = `http://127.0.0.1:${PORT}`;
const WAIT = Number((process.argv.find(a => a.startsWith('--wait=')) || '').split('=')[1]) || 22000;
const HEADED = process.argv.includes('--headed');
const LOG = path.join(ROOT, 'tools', 'diag-indoor-spread.log');
fs.writeFileSync(LOG, '');
const log = s => { console.log(s); fs.appendFileSync(LOG, s + '\n'); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'indoor_' + Date.now());
fs.mkdirSync(profile, { recursive: true });
const br = spawn(CHROME, [
  ...(HEADED ? [] : ['--headless=new']),
  `--remote-debugging-port=${CDP_PORT}`, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--autoplay-policy=no-user-gesture-required',
  ...(HEADED ? ['--enable-unsafe-webgpu'] : ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader']),
  '--window-size=1280,800', 'about:blank'
], { stdio: 'ignore' });
function cleanup() { try { br.kill(); } catch {} try { srv.kill(); } catch {} try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} }
process.on('exit', cleanup); process.on('SIGINT', () => { cleanup(); process.exit(130); });

let ws, seq = 0; const pend = new Map(); const errors = [];
function send(method, params = {}) { return new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); }); }

async function main() {
  for (let i = 0; i < 80; i++) { try { await fetch(BASE + '/'); break; } catch { await sleep(250); } }
  let page = null;
  for (let i = 0; i < 80; i++) {
    try { const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); page = list.find(t => t.type === 'page'); if (page) break; } catch {}
    await sleep(300);
  }
  if (!page) throw new Error('CDP 不可达');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = e => {
    const o = JSON.parse(e.data);
    if (o.id && pend.has(o.id)) { pend.get(o.id)(o); pend.delete(o.id); return; }
    if (o.method === 'Runtime.exceptionThrown') errors.push(o.params.exceptionDetails?.exception?.description || '');
    else if (o.method === 'Runtime.consoleAPICalled' && o.params.type === 'error') errors.push((o.params.args || []).map(a => a.value || '').join(' '));
  };
  const E = async (expression, timeoutMs = 45000) => {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
      sleep(timeoutMs).then(() => ({ timeout: true }))
    ]);
    if (r.timeout) return { __timeout: true };
    if (r.result?.exceptionDetails) return { __err: (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').slice(0, 500) };
    return r.result?.result?.value;
  };
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');

  const URL = BASE + '/?view=floor-1.html&edit=1&nocache=1';
  log('导航 = ' + URL);
  await send('Page.navigate', { url: URL });
  await sleep(WAIT + 5000);

  const DOC = `(()=>{const f=document.querySelector('iframe.gs-scene-frame[data-active="1"]')||document.querySelector('iframe.gs-scene-frame');return f?f.contentWindow:window;})()`;
  const mounted = await E(`(()=>!!(${DOC}).__mgEditor)()`);
  log('编辑器挂载 = ' + mounted);
  if (!mounted) { log('FAIL 编辑器未挂载'); log('JS错误=' + JSON.stringify(errors.slice(0,5))); return; }

  // 当前相机位姿 + 场景
  const cam = await E(`(()=>{const W=${DOC},c=W.__viewer?.app?.root?.findComponent?.('camera');if(!c)return null;const p=c.entity.getPosition();return {pos:[+p.x.toFixed(3),+p.y.toFixed(3),+p.z.toFixed(3)],scene:W.__viewer?.sceneName||W.__viewer?.scene||null};})()`);
  log('相机 = ' + JSON.stringify(cam));

  // 候选矩形：屏幕中央不同区域（室内墙面通常在中上部）
  const rects = [
    [0.3, 0.42, 0.72, 0.78],    // demo_decal 实际框选区（用户墙面试图）
    [0.30, 0.25, 0.70, 0.60],   // 中央大块
    [0.40, 0.20, 0.60, 0.45],   // 中上
    [0.20, 0.15, 0.45, 0.50],   // 左上
    [0.55, 0.20, 0.80, 0.55],   // 右上
    [0.35, 0.40, 0.65, 0.70],   // 中下
  ];
  log('\n===== 各候选矩形的 49 点深度跨度分析（相机静止）=====');
  for (const r of rects) {
    const res = await E(`(async()=>{const W=${DOC},p=W.__mgEditor?.picker;if(!p)return {err:'no-picker'};
      const g=await p.unprojectRect(${JSON.stringify(r)},6,6,{pickTimeout:4000});
      if(!g)return {err:'no-grid'};
      const pts=(g.points||[]).filter(Boolean);
      const c=W.__viewer?.app?.root?.findComponent?.('camera');const cp=c?c.entity.getPosition():{x:0,y:0,z:0};
      const d=pts.map(q=>Math.hypot(q[0]-cp.x,q[1]-cp.y,q[2]-cp.z)).sort((a,b)=>a-b);
      const q=function(f){ if(!d.length) return 0; var idx=Math.min(d.length-1,Math.floor(f*(d.length-1))); return d[idx]; };
      var med=q(0.5); var spread=med>0.5?((d[d.length-1]-d[0])/med):0;
      return {src:g.source,stats:g.stats,n:d.length,min:+q(0).toFixed(2),p10:+q(0.1).toFixed(2),med:+med.toFixed(2),p90:+q(0.9).toFixed(2),max:+q(1).toFixed(2),spread:+spread.toFixed(3),blocked:(med>60||spread>1.2)};
    })()`);
    log('rect=' + JSON.stringify(r) + ' -> ' + JSON.stringify(res));
  }

  log('\n===== 触发 demo_decal 重建，观察状态栏与 projector =====');
  await E(`(()=>{const W=${DOC},ed=W.__mgEditor;ed.action('decal-rebuild','demo_decal');return 1;})()`);
  await sleep(6000);
  const after = await E(`(()=>{const W=${DOC},ed=W.__mgEditor;const a=ed.store.get('demo_decal');
    const st=W.document.querySelector('[data-role="status"]')||W.document.querySelector('.ed-status');
    const m=ed.decalMgr;const dbg=m&&m.debug?m.debug():null;
    return {hasProj:!!a?.projector,half:a?.projector?.half,status:st?st.textContent:null,
      instances:dbg?.instances?.length,pickReady:dbg?.pickReady,gpuErrors:dbg?.gpuErrors,degraded:dbg?.degraded};})()`);
  log('重建后 = ' + JSON.stringify(after));
  // 隐藏 DOM overlay，抓一张纯画布截图确认视频是否真贴上去
  await E(`(()=>{const W=${DOC},d=W.document;const sel='.ed-layer,.ed-ui,.ed-guides,#mg-bar,#mg-helpbox,#mg-toolsbox,.sse-controlsWrap,.sse-infoPanel,.sse-joystick,.sse-panel';d.querySelectorAll(sel).forEach(e=>e.style.visibility='hidden');return 1;})()`);
  await sleep(600);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot.result?.data) {
    fs.writeFileSync(path.join(ROOT, 'tools', 'indoor-fixed.png'), Buffer.from(shot.result.data, 'base64'));
    log('室内修复截图 -> tools/indoor-fixed.png');
  }
  log('\nJS 错误数 = ' + errors.length + ' ' + JSON.stringify(errors.slice(0, 3)));
  ws.close();
}
main().catch(e => { log('FAIL ' + (e && e.stack || e)); process.exitCode = 1; });

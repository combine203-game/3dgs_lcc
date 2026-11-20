/**
 * 无头诊断：验证「框选矩形 <-> 世界点 <-> shader pickUV」三者映射是否自洽。
 * 1) 用 unprojectRect(rect) 取 49 点中心 W
 * 2) cam.worldToScreen(W) 投影回屏幕 UV，应 == rect 中心
 * 3) 反推 shader 的 gl_FragCoord -> pickUV -> worldFromPick 链路关键 uniform
 * 用法：node tools/diag_uv_mapping.mjs [--wait=22000]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 18167, CDP_PORT = 9287, BASE = `http://127.0.0.1:${PORT}`;
const WAIT = Number((process.argv.find(a => a.startsWith('--wait=')) || '').split('=')[1]) || 22000;
const LOG = path.join(ROOT, 'tools', 'diag-uv-mapping.log');
fs.writeFileSync(LOG, '');
const log = s => { console.log(s); fs.appendFileSync(LOG, s + '\n'); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'uvm_' + Date.now());
fs.mkdirSync(profile, { recursive: true });
const br = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`,
  '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader',
  '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });
function cleanup() { try { br.kill(); } catch {} try { srv.kill(); } catch {} try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} }
process.on('exit', cleanup); process.on('SIGINT', () => { cleanup(); process.exit(130); });
let ws, seq = 0; const pend = new Map();
function send(method, params = {}) { return new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); }); }
async function main() {
  for (let i = 0; i < 80; i++) { try { await fetch(BASE + '/'); break; } catch { await sleep(250); } }
  let page = null;
  for (let i = 0; i < 80; i++) { try { const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); page = l.find(t => t.type === 'page'); if (page) break; } catch {} await sleep(300); }
  if (!page) throw new Error('CDP 不可达');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = e => { const o = JSON.parse(e.data); if (o.id && pend.has(o.id)) { pend.get(o.id)(o); pend.delete(o.id); return; } };
  const E = async (expression, timeoutMs = 120000) => { const r = await Promise.race([send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }), sleep(timeoutMs).then(() => ({ timeout: true }))]); if (r.timeout) return { __timeout: true }; if (r.result?.exceptionDetails) return { __err: (r.result.exceptionDetails.exception?.description || '').slice(0, 700) }; return r.result?.result?.value; };
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Page.navigate', { url: BASE + '/?view=floor-1.html&edit=1&nocache=1' });
  await sleep(WAIT);
  const DOC = `(()=>{const f=document.querySelector('iframe.gs-scene-frame[data-active="1"]')||document.querySelector('iframe.gs-scene-frame');return f?f.contentWindow:window;})()`;
  log('编辑器挂载 = ' + await E(`(()=>!!(${DOC}).__mgEditor)()`));

  const res = await E(`(async()=>{
    const W=${DOC},ed=W.__mgEditor,pk=ed.picker;
    const P=W.__pc, cam=W.__viewer.app.root.findComponent('camera');
    const cv=W.document.querySelector('#mg-stage canvas'), cr=cv.getBoundingClientRect();
    const R=[0.55,0.3,0.72,0.45];
    const g=await pk.unprojectRect(R,6,6,{pickTimeout:800});
    if(!g)return {err:'no-grid'};
    const pts=(g.points||[]).filter(Boolean);
    const c=[0,0,0];for(const p of pts){c[0]+=p[0];c[1]+=p[1];c[2]+=p[2];}c[0]/=pts.length;c[1]/=pts.length;c[2]/=pts.length;
    // 投影中心点回屏幕
    const proj=(v)=>{const t=new P.Vec3(v[0],v[1],v[2]);const out=new P.Vec3();cam.worldToScreen(t,out);return {x:out.x,y:out.y};};
    const sc=proj(c);
    const rectCenterUV=[(R[0]+R[2])/2,(R[1]+R[3])/2];
    const rectCenterPx=[rectCenterUV[0]*cr.width, rectCenterUV[1]*cr.height];
    // 相机矩阵 / uniform 口径
    const camM=cam.entity.getPosition();
    const gd=W.__viewer.app.graphicsDevice;
    return {
      canvas:[cv.width,cv.height], rectPx:[cr.width,cr.height],
      worldCenter:c.map(x=>+x.toFixed(3)),
      projectedScreenPx:{x:+sc.x.toFixed(1),y:+sc.y.toFixed(1)},
      rectCenterUV:rectCenterUV.map(x=>+x.toFixed(3)),
      rectCenterPx:rectCenterPx.map(x=>+x.toFixed(1)),
      deltaPx:{x:+(sc.x-rectCenterPx[0]).toFixed(1),y:+(sc.y-rectCenterPx[1]).toFixed(1)},
      backend: gd.isWebGPU?'webgpu':'webgl2',
      nearFar:[cam.nearClip,cam.farClip]
    };
  })()`);
  log('\n结果:\n' + JSON.stringify(res, null, 1));
  ws.close();
}
main().then(() => { setTimeout(() => process.exit(0), 300); }).catch(e => { log('脚本失败: ' + (e?.stack || e)); setTimeout(() => process.exit(1), 300); });

/**
 * 为 shadowmap 验证生成一个「法向正确、正对相机」的墙面 projector。
 * 在室内机位对屏幕中央小矩形 unprojectRect → buildProjector（用页面内 picker），
 * 检查法向是否朝向相机（dot(nrm, toCam)>0），然后同样做深度口径对比。
 * 用法：node tools/diag_shadow_pick.mjs [--headed] [--wait=22000]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 18151, CDP_PORT = 9277, BASE = `http://127.0.0.1:${PORT}`;
const WAIT = Number((process.argv.find(a => a.startsWith('--wait=')) || '').split('=')[1]) || 22000;
const HEADED = process.argv.includes('--headed');
const LOG = path.join(ROOT, 'tools', 'diag-shadow-pick.log');
fs.writeFileSync(LOG, '');
const log = s => { console.log(s); fs.appendFileSync(LOG, s + '\n'); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'shadowpick_' + Date.now());
fs.mkdirSync(profile, { recursive: true });
const br = spawn(CHROME, [...(HEADED ? [] : ['--headless=new']), `--remote-debugging-port=${CDP_PORT}`,
  '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--autoplay-policy=no-user-gesture-required',
  ...(HEADED ? ['--enable-unsafe-webgpu'] : ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader']),
  '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });
function cleanup() { try { br.kill(); } catch {} try { srv.kill(); } catch {} try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} }
process.on('exit', cleanup); process.on('SIGINT', () => { cleanup(); process.exit(130); });
let ws, seq = 0; const pend = new Map(); const errors = [];
function send(method, params = {}) { return new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); }); }
async function main() {
  for (let i = 0; i < 80; i++) { try { await fetch(BASE + '/'); break; } catch { await sleep(250); } }
  let page = null;
  for (let i = 0; i < 80; i++) { try { const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); page = l.find(t => t.type === 'page'); if (page) break; } catch {} await sleep(300); }
  if (!page) throw new Error('CDP 不可达');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = e => { const o = JSON.parse(e.data); if (o.id && pend.has(o.id)) { pend.get(o.id)(o); pend.delete(o.id); return; } if (o.method === 'Runtime.exceptionThrown') errors.push(o.params.exceptionDetails?.exception?.description || ''); };
  const E = async (expression, timeoutMs = 60000) => { const r = await Promise.race([send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }), sleep(timeoutMs).then(() => ({ timeout: true }))]); if (r.timeout) return { __timeout: true }; if (r.result?.exceptionDetails) return { __err: (r.result.exceptionDetails.exception?.description || '').slice(0, 700) }; return r.result?.result?.value; };
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Page.navigate', { url: BASE + '/?view=floor-1.html&edit=1&nocache=1' });
  await sleep(WAIT + 5000);
  const DOC = `(()=>{const f=document.querySelector('iframe.gs-scene-frame[data-active="1"]')||document.querySelector('iframe.gs-scene-frame');return f?f.contentWindow:window;})()`;
  const mounted = await E(`(()=>!!(${DOC}).__mgEditor)()`);
  log('编辑器挂载 = ' + mounted);

  // 对多个候选矩形：unprojectRect -> 用简化 OBB 拟合（复用编辑器 action 的方式）-> 检查法向
  const res = await E(`(async()=>{
    const W=${DOC}, ed=W.__mgEditor, picker=ed.picker, col=W.__viewer.collision();
    const cam=W.__viewer.app.root.findComponent('camera');const cp=cam.entity.getPosition();const camPos=[cp.x,cp.y,cp.z];
    const rot=(v,qq)=>{const [x,y,z]=v,[qx,qy,qz,qw]=qq;const tx=2*(qy*z-qz*y),ty=2*(qz*x-qx*z),tz=2*(qx*y-qy*x);return [x+qw*tx+(qy*tz-qz*ty),y+qw*ty+(qz*tx-qx*tz),z+qw*tz+(qx*ty-qy*tx)];};
    const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
    const out=[];
    const rects=[[0.42,0.3,0.58,0.5],[0.35,0.35,0.65,0.6],[0.45,0.4,0.55,0.55],[0.3,0.42,0.72,0.78]];
    for (const rect of rects) {
      const g=await picker.unprojectRect(rect,6,6,{pickTimeout:4000});
      if(!g){out.push({rect,err:'no-grid'});continue;}
      const pts=(g.points||[]).filter(Boolean);
      // 质心 + PCA 近似法向：用行/列中点叉积（同 buildDecalProjector）
      const nx=g.nu,nv=g.nv,at=(i,j)=>pts[j*(nx+1)+i];
      const colMid=i=>{let s=[0,0,0],c=0;for(let j=0;j<=nv;j++){const p=at(i,j);if(p){s[0]+=p[0];s[1]+=p[1];s[2]+=p[2];c++;}}return c?s.map(x=>x/c):null;};
      const rowMid=j=>{let s=[0,0,0],c=0;for(let i=0;i<=nx;i++){const p=at(i,j);if(p){s[0]+=p[0];s[1]+=p[1];s[2]+=p[2];c++;}}return c?s.map(x=>x/c):null;};
      const R=colMid(nx),L=colMid(0),T=rowMid(nv),B=rowMid(0);
      if(!R||!L||!T||!B){out.push({rect,err:'no-mid'});continue;}
      const dx=[R[0]-L[0],R[1]-L[1],R[2]-L[2]],dy=[T[0]-B[0],T[1]-B[1],T[2]-B[2]];
      const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
      let nrm=cross(dx,dy);const nl=Math.hypot(...nrm)||1;nrm=nrm.map(x=>x/nl);
      const center=[0,1,2].map(k=>pts.reduce((s,p)=>s+p[k],0)/pts.length);
      const toCam=[camPos[0]-center[0],camPos[1]-center[1],camPos[2]-center[2]];
      if(dot(nrm,toCam)<0)nrm=nrm.map(x=>-x);
      const hx=Math.hypot(...dx)/2+0.05,hy=Math.hypot(...dy)/2+0.05;
      // 深度沿法向跨度
      let mnZ=Infinity,mxZ=-Infinity;for(const p of pts){const lz=dot([p[0]-center[0],p[1]-center[1],p[2]-center[2]],nrm);if(lz<mnZ)mnZ=lz;if(lz>mxZ)mxZ=lz;}
      out.push({rect,src:g.source,n:pts.length,nrm:nrm.map(x=>+x.toFixed(2)),faceCam:+dot(nrm,toCam).toFixed(2),hx:+hx.toFixed(2),hy:+hy.toFixed(2),zSpan:+(mxZ-mnZ).toFixed(2)});
    }
    return out;
  })()`);
  log('\n===== 候选矩形法向分析 =====');
  log(JSON.stringify(res, null, 2));
  log('\n错误=' + JSON.stringify(errors.slice(0,5)));
}
main().catch(e => log('FATAL ' + (e && e.stack || e))).finally(() => { try { ws && ws.close(); } catch {} setTimeout(() => process.exit(0), 300); });

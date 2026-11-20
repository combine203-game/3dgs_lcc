/**
 * shadowmap 深度口径验证 v2：用正对相机的纯墙面矩形。
 * 分离两个问题：
 *  (a) 同口径：W 用虚拟相机深度图反投影出的点 → 比较必然自洽（验证算法/UV 逻辑）
 *  (b) 跨源：W 用主相机射线打碰撞 mesh 的世界点 → 比较看是否落在 bias 内
 *  (c) 3DGS：W 用 picker 深度反投影 → 看跨 stochastic 源的偏差
 * 用法：node tools/diag_shadow_verify2.mjs [--headed] [--wait=22000]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 18153, CDP_PORT = 9279, BASE = `http://127.0.0.1:${PORT}`;
const WAIT = Number((process.argv.find(a => a.startsWith('--wait=')) || '').split('=')[1]) || 22000;
const HEADED = process.argv.includes('--headed');
const LOG = path.join(ROOT, 'tools', 'diag-shadow-verify2.log');
fs.writeFileSync(LOG, '');
const log = s => { console.log(s); fs.appendFileSync(LOG, s + '\n'); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'shadowverify2_' + Date.now()); fs.mkdirSync(profile, { recursive: true });
const br = spawn(CHROME, [...(HEADED ? [] : ['--headless=new']), `--remote-debugging-port=${CDP_PORT}`, '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--autoplay-policy=no-user-gesture-required', ...(HEADED ? ['--enable-unsafe-webgpu'] : ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader']), '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });
function cleanup() { try { br.kill(); } catch {} try { srv.kill(); } catch {} try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} }
process.on('exit', cleanup); process.on('SIGINT', () => { cleanup(); process.exit(130); });
let ws, seq = 0; const pend = new Map(); const errors = [];
function send(method, params = {}) { return new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); }); }
async function main() {
  for (let i = 0; i < 80; i++) { try { await fetch(BASE + '/'); break; } catch { await sleep(250); } }
  let page = null; for (let i = 0; i < 80; i++) { try { const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); page = l.find(t => t.type === 'page'); if (page) break; } catch {} await sleep(300); }
  if (!page) throw new Error('CDP 不可达');
  ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = e => { const o = JSON.parse(e.data); if (o.id && pend.has(o.id)) { pend.get(o.id)(o); pend.delete(o.id); return; } if (o.method === 'Runtime.exceptionThrown') errors.push(o.params.exceptionDetails?.exception?.description || ''); };
  const E = async (expression, timeoutMs = 60000) => { const r = await Promise.race([send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }), sleep(timeoutMs).then(() => ({ timeout: true }))]); if (r.timeout) return { __timeout: true }; if (r.result?.exceptionDetails) return { __err: (r.result.exceptionDetails.exception?.description || '').slice(0, 700) }; return r.result?.result?.value; };
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Page.navigate', { url: BASE + '/?view=floor-1.html&edit=1&nocache=1' }); await sleep(WAIT + 5000);
  const DOC = `(()=>{const f=document.querySelector('iframe.gs-scene-frame[data-active="1"]')||document.querySelector('iframe.gs-scene-frame');return f?f.contentWindow:window;})()`;
  const mounted = await E(`(()=>!!(${DOC}).__mgEditor)()`); log('编辑器挂载 = ' + mounted);

  const out = await E(`(async()=>{
    const W=${DOC}, ed=W.__mgEditor, picker=ed.picker, col=W.__viewer.collision();
    const cam=W.__viewer.app.root.findComponent('camera');const cp=cam.entity.getPosition();const camPos=[cp.x,cp.y,cp.z];
    const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
    const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
    const rect=[0.45,0.4,0.55,0.55];
    const g=await picker.unprojectRect(rect,6,6,{pickTimeout:4000});
    if(!g)return {err:'no-grid'};
    const pts=(g.points||[]).filter(Boolean), nx=g.nu,nv=g.nv,at=(i,j)=>pts[j*(nx+1)+i];
    const colMid=i=>{let s=[0,0,0],c=0;for(let j=0;j<=nv;j++){const p=at(i,j);if(p){s[0]+=p[0];s[1]+=p[1];s[2]+=p[2];c++;}}return s.map(x=>x/c);};
    const rowMid=j=>{let s=[0,0,0],c=0;for(let i=0;i<=nx;i++){const p=at(i,j);if(p){s[0]+=p[0];s[1]+=p[1];s[2]+=p[2];c++;}}return s.map(x=>x/c);};
    const dx=[],dy=[];const R=colMid(nx),L=colMid(0),T=rowMid(nv),B=rowMid(0);
    for(let k=0;k<3;k++){dx[k]=R[k]-L[k];dy[k]=T[k]-B[k];}
    let nrm=cross(dx,dy);const nl=Math.hypot(...nrm)||1;nrm=nrm.map(x=>x/nl);
    const center=[0,1,2].map(k=>pts.reduce((s,p)=>s+p[k],0)/pts.length);
    const toCam=[camPos[0]-center[0],camPos[1]-center[1],camPos[2]-center[2]];
    if(dot(nrm,toCam)<0)nrm=nrm.map(x=>-x);
    // 用 dx 单位化作 right，up = nrm × right
    const dl=Math.hypot(...dx)||1; const right=dx.map(x=>x/dl);
    const up=cross(nrm,right);
    let mnz=Infinity,mxz=-Infinity;for(const p of pts){const lz=dot([p[0]-center[0],p[1]-center[1],p[2]-center[2]],nrm);if(lz<mnz)mnz=lz;if(lz>mxz)mxz=lz;}
    const hx=Math.hypot(...dx)/2+0.1, hy=Math.hypot(...dy)/2+0.1;
    const camOff=Math.max(1.0, mxz-mnz)+0.5;
    const vcam=[center[0]+nrm[0]*camOff, center[1]+nrm[1]*camOff, center[2]+nrm[2]*camOff];
    const dir=[-nrm[0],-nrm[1],-nrm[2]];
    const far=camOff+(mxz-mnz)+2;

    // 虚拟相机深度图（碰撞 mesh）
    const N=24, dmap=new Float32Array(N*N).fill(1.0);
    for(let j=0;j<N;j++)for(let i=0;i<N;i++){
      const u=(i+0.5)/N*2-1,v=(j+0.5)/N*2-1;
      const ox=vcam[0]+right[0]*u*hx+up[0]*v*hy, oy=vcam[1]+right[1]*u*hx+up[1]*v*hy, oz=vcam[2]+right[2]*u*hx+up[2]*v*hy;
      const h=col.queryRay(ox,oy,oz,dir[0],dir[1],dir[2],far+2);
      if(h){dmap[j*N+i]=Math.min(1,Math.hypot(h.x-ox,h.y-oy,h.z-oz)/far);}
    }
    const sample=(u,v)=>{const di=Math.min(N-1,Math.max(0,Math.floor((u*0.5+0.5)*N))),dj=Math.min(N-1,Math.max(0,Math.floor((v*0.5+0.5)*N)));return dmap[dj*N+di];};

    // 对三个 W 源比较
    function compare(label, worldPts){
      const cmp=[];
      for(const p of worldPts){
        const dw=[p[0]-vcam[0],p[1]-vcam[1],p[2]-vcam[2]];
        const lx=dot(dw,right),ly=dot(dw,up),lz=dot(dw,dir);
        const u=lx/hx, v=ly/hy;
        if(Math.abs(u)>1||Math.abs(v)>1){cmp.push({out:1});continue;}
        const dm=sample(u,v), dW=Math.min(1,lz/far);
        cmp.push({diff:Math.abs(dW-dm)});
      }
      const inside=cmp.filter(c=>!c.out).map(c=>c.diff).sort((a,b)=>a-b);
      const qf=f=>inside.length?inside[Math.min(inside.length-1,Math.floor(f*(inside.length-1)))]:null;
      return {label,n:worldPts.length,inside:inside.length,diffMed:qf(0.5),diffP90:qf(0.9),diffMax:qf(1)};
    }
    // 源 a：同口径——用虚拟相机深度图反投影（synthetic，验证算法）
    const synth=[];
    for(let j=2;j<N-2;j+=4)for(let i=2;i<N-2;i+=4){
      const u=(i+0.5)/N*2-1,v=(j+0.5)/N*2-1, d=dmap[j*N+i];
      if(d>=1)continue;
      const dist=d*far;
      synth.push([vcam[0]+right[0]*u*hx*1+dir[0]*dist, vcam[1]+up[1]*v*hy+dir[1]*dist, vcam[2]+right[2]*u*hx+up[2]*v*hy+dir[2]*dist]);
    }
    const cmpSynth=compare('synthetic-same-source',synth);
    const cmpMesh=compare('main-mesh-points',pts);
    return {
      geom:{rect,nrm:nrm.map(x=>+x.toFixed(2)),center:center.map(x=>+x.toFixed(2)),hx:+hx.toFixed(2),hy:+hy.toFixed(2),zSpan:+(mxz-mnz).toFixed(2),camOff:+camOff.toFixed(2),far:+far.toFixed(2),src:g.source},
      depthMap:{N,hit:dmap.filter(x=>x<1).length,total:N*N},
      cmpSynth, cmpMesh
    };
  })()`);
  log('\n===== shadowmap v2 验证 ====='); log(JSON.stringify(out, null, 2));
  log('\n错误=' + JSON.stringify(errors.slice(0,5)));
}
main().catch(e => log('FATAL ' + (e && e.stack || e))).finally(() => { try { ws && ws.close(); } catch {} setTimeout(() => process.exit(0), 300); });

/**
 * 无头诊断：采样多个候选框选矩形，评估 unprojectRect 的 49 点共面性，
 * 找一个在无头 mesh 模式下落在单一平面（墙面/地面）的矩形，用于贴花验收。
 * 用法：node tools/diag_pick_coplanar.mjs [--wait=22000]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 18165, CDP_PORT = 9285, BASE = `http://127.0.0.1:${PORT}`;
const WAIT = Number((process.argv.find(a => a.startsWith('--wait=')) || '').split('=')[1]) || 22000;
const LOG = path.join(ROOT, 'tools', 'diag-pick-coplanar.log');
fs.writeFileSync(LOG, '');
const log = s => { console.log(s); fs.appendFileSync(LOG, s + '\n'); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'coplanar_' + Date.now());
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

  const RECTS = [
    [0.45, 0.4, 0.55, 0.55],
    [0.30, 0.30, 0.45, 0.45],
    [0.55, 0.30, 0.72, 0.45],
    [0.70, 0.35, 0.88, 0.52],
    [0.20, 0.45, 0.38, 0.62],
    [0.40, 0.55, 0.60, 0.70],
    [0.10, 0.55, 0.30, 0.72]
  ];
  const res = await E(`(async()=>{
    const W=${DOC},ed=W.__mgEditor,pk=ed.picker;
    const out=[];
    const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
    const sub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
    const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
    const norm=v=>{const l=Math.hypot(...v)||1;return [v[0]/l,v[1]/l,v[2]/l];};
    const rects=${JSON.stringify(RECTS)};
    for(const rect of rects){
      const g=await pk.unprojectRect(rect,6,6,{pickTimeout:800});
      if(!g){out.push({rect,err:'no-grid'});continue;}
      const pts=(g.points||[]).filter(Boolean);
      if(pts.length<10){out.push({rect,err:'few-pts:'+pts.length,source:g.source});continue;}
      // 拟合平面：PCA 最小特征向量近似（用中心差分法：对所有点均值中心的协方差，取最小方向）
      const c=[0,0,0];for(const p of pts){c[0]+=p[0];c[1]+=p[1];c[2]+=p[2];}c[0]/=pts.length;c[1]/=pts.length;c[2]/=pts.length;
      let sxx=0,syy=0,szz=0,sxy=0,sxz=0,syz=0;
      for(const p of pts){const d=sub(p,c);sxx+=d[0]*d[0];syy+=d[1]*d[1];szz+=d[2]*d[2];sxy+=d[0]*d[1];sxz+=d[0]*d[2];syz+=d[1]*d[2];}
      // 用梯度下降/幂迭代近似最小特征向量：对 M 求 (M - maxEig*I) 的最小方向，简化用相邻法向一致性
      // 简化共面性指标：把点按行(7)和列(7)求局部法向，看彼此夹角一致性
      const U=6,V=6,grid=g.points;
      const at=(i,j)=>grid[j*7+i];
      const normals=[];
      for(let j=0;j<V;j+=2)for(let i=0;i<U;i+=2){
        const p=at(i,j), px=at(i+1,j), py=at(i,j+1);
        if(!p||!px||!py)continue;
        const nn=norm(cross(sub(px,p),sub(py,p)));
        if(nn.every(Number.isFinite))normals.push(nn);
      }
      let avg=[0,0,0];for(const n of normals){avg[0]+=n[0];avg[1]+=n[1];avg[2]+=n[2];}
      avg=norm(avg);
      let cosMin=1,cosSum=0;
      for(const n of normals){const d=dot(n,avg);cosSum+=d;if(d<cosMin)cosMin=d;}
      const dist=pts.map(p=>Math.hypot(p[0]-c[0],p[1]-c[1],p[2]-c[2])).sort((a,b)=>a-b);
      out.push({rect,source:g.source,nPts:pts.length,nNormals:normals.length,
        avgNormal:avg.map(x=>+x.toFixed(3)),cosMean:+(cosSum/(normals.length||1)).toFixed(3),cosMin:+cosMin.toFixed(3),
        span:+(dist[dist.length-1]-dist[0]).toFixed(2),
        center:c.map(x=>+x.toFixed(2))});
    }
    return out;
  })()`);
  log('\n结果:\n' + JSON.stringify(res, null, 1));
  ws.close();
}
main().then(() => { setTimeout(() => process.exit(0), 300); }).catch(e => { log('脚本失败: ' + (e?.stack || e)); setTimeout(() => process.exit(1), 300); });

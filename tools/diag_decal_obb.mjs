/**
 * 诊断：OBB 拟合质量 —— 深度反算的网格点投影到 OBB 局部坐标后落点分布
 * ----------------------------------------------------------------
 * 贴花的 GPU 判定是：把「从 pick 深度重建的世界点」投到 OBB 局部坐标，
 * 落在 |ln.x|,|ln.y|,|ln.z| ≤ 1 才着色。实测覆盖率只有 ~0.24，说明大量
 * 重建点落在盒外。本脚本把 buildDecalProjector 拟合出的 OBB 与深度反算
 * 网格点放在一起算：
 *   · 每个网格点的局部坐标（应全部落在 [-1,1]）
 *   · 局部坐标的分布直方图
 *   · OBB 各半尺寸与网格实际跨度
 * 如果网格点本身就大量出界 → OBB 拟合有错（局部基/半尺寸算错）；
 * 如果网格点全在界内 → 问题在 GPU 重建世界点那一步（invProjector 或
 * 深度重建），与 OBB 无关。
 *
 * 用法： node tools/diag_decal_obb.mjs [--headed] [--wait=20000]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 18153;
const CDP_PORT = 9279;
const BASE = `http://127.0.0.1:${PORT}`;
const WAIT = Number((process.argv.find(a => a.startsWith('--wait=')) || '').split('=')[1]) || 20000;
const HEADED = process.argv.includes('--headed');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)],
  { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'diagobb_' + Date.now());
fs.mkdirSync(profile, { recursive: true });
const br = spawn(CHROME, [
  ...(HEADED ? [] : ['--headless=new']),
  `--remote-debugging-port=${CDP_PORT}`, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--autoplay-policy=no-user-gesture-required',
  ...(HEADED ? ['--enable-unsafe-webgpu'] : ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader']),
  '--window-size=1280,800', 'about:blank'
], { stdio: 'ignore' });

function cleanup() {
  try { br.kill(); } catch { /* noop */ }
  try { srv.kill(); } catch { /* noop */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* noop */ }
}
process.on('exit', cleanup);

let ws, seq = 0;
const pend = new Map();

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
    if (o.id && pend.has(o.id)) { pend.get(o.id)(o); pend.delete(o.id); }
  };
  function send(method, params = {}) {
    return new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  }
  const E = async (expression, timeoutMs = 60000) => {
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

  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(WAIT);
  const DOC = `(()=>{const f=document.querySelector('iframe.gs-scene-frame[data-active="1"]')||document.querySelector('iframe.gs-scene-frame');return f?f.contentWindow:window;})()`;
  await E(`(()=>{document.getElementById('gsEditorBtn')?.click();return 1})()`);
  await sleep(3000);

  const inj = await E(`(()=>{const W=${DOC},ed=W.__mgEditor;
    const list=ed.store.list();
    for(const a of list){if(a.kind==='decal'&&a.visible!==false)ed.store.update(a.id,{visible:false});}
    const tpl=list.find(a=>a.kind==='decal');if(!tpl)return 'no-template';
    const c=JSON.parse(JSON.stringify(tpl));
    c.id='obb-decal-'+Date.now();c.visible=false;
    c.rect=[0.34,0.52,0.56,0.72];c.projector=null;c.surface=null;
    c.media=[{type:'video',url:'',caption:'演示'}];
    ed.store.add(c);return c.id;})()`);
  const ID = String(inj);
  await E(`(()=>{const W=${DOC},ed=W.__mgEditor;ed.action('decal-rebuild','${ID}');return 1;})()`);
  await sleep(8000);

  console.log('\n===== OBB 拟合质量分析 =====');
  const r = await E(`(()=>{const W=${DOC},ed=W.__mgEditor;
    const a=ed.store.get('${ID}');
    if(!a||!a.projector||!a.surface)return {err:'no-proj',hasProj:!!(a&&a.projector)};
    const pr=a.projector, pts=(a.surface.points||[]).filter(Boolean);
    const q=pr.quaternion,h=pr.half,c=pr.position;
    const qx=q[0],qy=q[1],qz=q[2],qw=q[3];
    const rot=(v)=>{const ix=qw*v[0]+qy*v[2]-qz*v[1],iy=qw*v[1]+qz*v[0]-qx*v[2],iz=qw*v[2]+qx*v[1]-qy*v[0],iw=-qx*v[0]-qy*v[1]-qz*v[2];
      const wx=ix*qw+iw*-qx+iy*-qz-iz*-qy,wy=iy*qw+iw*-qy+iz*-qx-ix*-qz,wz=iz*qw+iw*-qz+ix*-qy-iy*-qx;
      return [wx,wy,wz];};
    const lx=rot([1,0,0]),ly=rot([0,1,0]),lz=rot([0,0,1]);
    const loc=pts.map(p=>{
      const d=[p[0]-c[0],p[1]-c[1],p[2]-c[2]];
      return [d[0]*lx[0]+d[1]*lx[1]+d[2]*lx[2],
              d[0]*ly[0]+d[1]*ly[1]+d[2]*ly[2],
              d[0]*lz[0]+d[1]*lz[1]+d[2]*lz[2]];
    });
    const norm=loc.map(l=>[l[0]/h[0],l[1]/h[1],l[2]/h[2]]);
    let inAll=0,inXY=0,inXZ=0,inYZ=0;
    const bx=[],by=[],bz=[];
    for(const n of norm){
      bx.push(n[0]);by.push(n[1]);bz.push(n[2]);
      if(Math.abs(n[0])<=1&&Math.abs(n[1])<=1&&Math.abs(n[2])<=1)inAll++;
      if(Math.abs(n[0])<=1&&Math.abs(n[1])<=1)inXY++;
      if(Math.abs(n[0])<=1&&Math.abs(n[2])<=1)inXZ++;
      if(Math.abs(n[1])<=1&&Math.abs(n[2])<=1)inYZ++;
    }
    const rng=(arr)=>[Math.min.apply(null,arr).toFixed(3),Math.max.apply(null,arr).toFixed(3)];
    return {
      点数:pts.length,
      投影机:{position:c.map(v=>+v.toFixed(3)),half:h.map(v=>+v.toFixed(3)),depth:+pr.depth.toFixed(3)},
      局部基:{x:lx.map(v=>+v.toFixed(3)),y:ly.map(v=>+v.toFixed(3)),z:lz.map(v=>+v.toFixed(3))},
      归一化局部坐标范围:{x:rng(bx),y:rng(by),z:rng(bz)},
      命中:{三维全中:inAll,XY中:inXY,XZ中:inXZ,YZ中:inYZ},
      命中率:{
        三维全中:+(inAll/pts.length).toFixed(3),
        XY:+(inXY/pts.length).toFixed(3),
        XZ:+(inXZ/pts.length).toFixed(3),
        YZ:+(inYZ/pts.length).toFixed(3)
      }
    };})()`);
  console.log(JSON.stringify(r, null, 2));
}

main().then(() => { cleanup(); process.exit(0); })
  .catch(e => { console.error('诊断失败:', e.message || e); cleanup(); process.exit(2); });

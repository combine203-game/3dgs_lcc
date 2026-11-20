/**
 * 可行性诊断：对比「3DGS 深度拾取」与「碰撞 mesh 射线」在同一框选区的 49 点。
 *
 * 目的：验证换深度源方案（用户选的 E）是否可行 —— 碰撞 mesh（XGrids LCC 重建，
 * 含台阶几何、不含细栏杆）能否给出栏杆后面的台阶表面。
 *
 * 不改产品代码，只读两种拾取结果并输出空间分布，判断是否连续台阶面。
 *
 * 用法： node tools/diag_collision_depth.mjs [--headed] [--wait=22000]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w):/, '$1:')), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 18141, CDP_PORT = 9267, BASE = `http://127.0.0.1:${PORT}`;
const HEADED = process.argv.includes('--headed');
const WAIT = Number((process.argv.find(a => a.startsWith('--wait=')) || '').split('=')[1]) || 22000;
const SEL = [0.34, 0.52, 0.56, 0.72];
const sleep = ms => new Promise(r => setTimeout(r, ms));

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'coldiag_' + Date.now());
fs.mkdirSync(profile, { recursive: true });
const chromeArgs = [
  ...(HEADED ? [] : ['--headless=new']),
  `--remote-debugging-port=${CDP_PORT}`, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--autoplay-policy=no-user-gesture-required',
  ...(HEADED ? ['--enable-unsafe-webgpu'] : ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader']),
  '--window-size=1280,800', 'about:blank'
];
const br = spawn(CHROME, chromeArgs, { stdio: 'ignore' });
function cleanup() {
  try { br.kill(); } catch {}
  try { srv.kill(); } catch {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

let ws, seq = 0; const pend = new Map();
function send(method, params = {}) {
  return new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
}
const E = async (expression, timeoutMs = 40000) => {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
    sleep(timeoutMs).then(() => ({ timeout: true }))
  ]);
  if (r.timeout) return { __timeout: true };
  if (r.result?.exceptionDetails) return { __err: (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').slice(0, 400) };
  return r.result?.result?.value;
};

async function main() {
  for (let i = 0; i < 80; i++) { try { await fetch(BASE + '/'); break; } catch { await sleep(250); } }
  let page = null;
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      page = list.find(t => t.type === 'page'); if (page) break;
    } catch {}
    await sleep(300);
  }
  if (!page) throw new Error('CDP 不可达');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => { const o = JSON.parse(e.data); if (o.id && pend.has(o.id)) { pend.get(o.id)(o); pend.delete(o.id); } };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(WAIT);
  // 打开编辑器（让 picker 预热碰撞 mesh）
  await E(`(()=>{document.getElementById('gsEditorBtn')?.click();return 1})()`);
  await sleep(3500);
  const DOC = `(()=>{const f=document.querySelector('iframe.gs-scene-frame[data-active="1"]')||document.querySelector('iframe.gs-scene-frame');return f?f.contentWindow:window;})()`;

  const env = await E(`(()=>{const W=${DOC};
    const v=W.__viewer,ed=W.__mgEditor;
    return {hasViewer:!!v,hasEditor:!!ed,hasPicker:!!(ed&&ed.picker),
      hasCollision:!!(v&&typeof v.collision==='function'),
      colTris:(()=>{try{const c=v.collision();return c&&c.triangles?c.triangles.count:null}catch(e){return 'err:'+e.message}})()};
  })()`);
  console.log('环境 =', JSON.stringify(env));

  // 对框选区 7x7 网格：分别取 3DGS pick 与碰撞 mesh 射线命中
  const result = await E(`(async()=>{const W=${DOC},v=W.__viewer,ed=W.__mgEditor;
    const cam=v.app.root.findComponent('camera');
    const cv=v.app.graphicsDevice.canvas;const cr=cv.getBoundingClientRect();
    const col=v.collision();
    const SEL=${JSON.stringify(SEL)};
    const nu=6,nv=6;
    const depthPts=[],meshPts=[];
    const picker=ed&&ed.picker;
    for(let j=0;j<=nv;j++)for(let i=0;i<=nu;i++){
      const u=SEL[0]+(SEL[2]-SEL[0])*i/nu, vv=SEL[1]+(SEL[3]-SEL[1])*j/nv;
      const cx=cr.left+u*cr.width, cy=cr.top+vv*cr.height;
      // 3DGS 深度拾取（depthUnproject 优先走 picker.pick 深度源）
      try{const p=await picker.depthUnproject(cx,cy,{pickTimeout:4000});
        const arr=p&&p.pos;
        if(arr&&arr.every(Number.isFinite))depthPts.push([+arr[0].toFixed(3),+arr[1].toFixed(3),+arr[2].toFixed(3)]);
        else depthPts.push(null);
      }catch(e){depthPts.push(null);}
      // 碰撞 mesh 射线：近/远两点生成方向
      try{
        const ndc=(z)=>cam.camera.screenToWorld(cx-cr.left,cy-cr.top,z,cr.width,cr.height);
        const pn=ndc(cam.camera.nearClip+0.01), pf=ndc(Math.min(cam.camera.farClip,60));
        const dx=pf.x-pn.x,dy=pf.y-pn.y,dz=pf.z-pn.z;
        const hit=col.queryRay(pn.x,pn.y,pn.z,dx,dy,dz,60);
        if(hit&&hit.point)meshPts.push([+hit.point.x.toFixed(3),+hit.point.y.toFixed(3),+hit.point.z.toFixed(3)]);
        else if(hit&&hit.x!==undefined)meshPts.push([+hit.x.toFixed(3),+hit.y.toFixed(3),+hit.z.toFixed(3)]);
        else meshPts.push(null);
      }catch(e){meshPts.push('err:'+e.message);}
    }
    // 把每种拾取的世界点投影回屏幕 CSS 坐标，便于离线在截图上标注
    const P=W.__pc;
    const proj=(arr)=>arr.map(p=>{
      if(!Array.isArray(p))return p;
      try{
        const wp=new P.Vec3(p[0],p[1],p[2]);const out=new P.Vec3();
        cam.worldToScreen(wp,out);
        return [+(out.x-cr.left).toFixed(1),+(out.y-cr.top).toFixed(1)];
      }catch(e){return 'projErr:'+e.message;}
    });
    return {depthPts,meshPts,depthScreen:proj(depthPts),meshScreen:proj(meshPts),
      near:cam.camera.nearClip,far:cam.camera.farClip,
      canvasWH:[cv.width,cv.height],cssWH:[cr.width,cr.height]};
  })()`, 90000);
  console.log('\n相机 near/far =', result?.near, result?.far);
  const fmt = (name, pts) => {
    const valid = (pts || []).filter(p => Array.isArray(p));
    console.log(`\n=== ${name}: ${valid.length}/${(pts||[]).length} 有效 ===`);
    if (!valid.length) return;
    const xs = valid.map(p => p[0]), ys = valid.map(p => p[1]), zs = valid.map(p => p[2]);
    console.log(`X ${Math.min(...xs).toFixed(2)}~${Math.max(...xs).toFixed(2)}  Y ${Math.min(...ys).toFixed(2)}~${Math.max(...ys).toFixed(2)}  Z ${Math.min(...zs).toFixed(2)}~${Math.max(...zs).toFixed(2)}`);
    // X 离散列数（0.2m bin）
    const bins = new Set(valid.map(p => Math.round(p[0] * 5) / 5));
    console.log(`离散 X 列数 = ${bins.size}  (少且竖线=栏杆; 连续分布=台阶面)`);
    console.log('前12点 =', JSON.stringify(valid.slice(0, 12)));
  };
  fmt('3DGS 深度拾取', result?.depthPts);
  fmt('碰撞 mesh 射线', result?.meshPts);
  fs.writeFileSync(path.join(ROOT, 'tools', 'diag-collision-depth.json'), JSON.stringify(result, null, 2));
  console.log('\n已写入 tools/diag-collision-depth.json');
  ws.close();
}
main().then(() => { cleanup(); process.exit(0); }).catch(e => { console.error('诊断失败:', e); cleanup(); process.exit(1); });

/**
 * 决定性验证：shadowmap 贴花方案的深度口径是否自洽（纯计算，不改产品代码）。
 *
 * 步骤：
 *  1. 室内编辑态，取 demo_decal 的 projector（position/quaternion/half）。
 *  2. 由 projector 构造正交虚拟相机（视锥=OBB，相机在 +normal 侧看向 -normal）。
 *  3. 对碰撞 mesh 投射一张虚拟相机深度图（沿 -normal 射线，记录到表面的距离）。
 *  4. 用 picker.unprojectRect(6,6) 拿主相机 3DGS 反投影的 49 个世界点 W。
 *  5. 把每个 W 变换到虚拟相机空间，比较它的深度 vs 深度图同 uv 处的值。
 *     若偏差在厘米~分米级 → shadowmap 深度比较成立 → 方案可行。
 *
 * 用法：node tools/diag_shadow_verify.mjs [--headed] [--wait=22000]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 18149, CDP_PORT = 9275;
const BASE = `http://127.0.0.1:${PORT}`;
const WAIT = Number((process.argv.find(a => a.startsWith('--wait=')) || '').split('=')[1]) || 22000;
const HEADED = process.argv.includes('--headed');
const LOG = path.join(ROOT, 'tools', 'diag-shadow-verify.log');
fs.writeFileSync(LOG, '');
const log = s => { console.log(s); fs.appendFileSync(LOG, s + '\n'); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'shadowverify_' + Date.now());
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
  const E = async (expression, timeoutMs = 60000) => {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
      sleep(timeoutMs).then(() => ({ timeout: true }))
    ]);
    if (r.timeout) return { __timeout: true };
    if (r.result?.exceptionDetails) return { __err: (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').slice(0, 700) };
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
  if (!mounted) { log('FAIL 编辑器未挂载'); return; }

  // 触发 demo_decal 重建，确保有 projector
  await E(`(()=>{const W=${DOC},ed=W.__mgEditor;if(ed.store.get('demo_decal')){ed.action('decal-rebuild','demo_decal');}return 1;})()`);
  await sleep(5000);

  const result = await E(`(async()=>{
    const W = ${DOC}, ed = W.__mgEditor, col = W.__viewer.collision();
    const a = ed.store.get('demo_decal');
    if (!a || !a.projector) return {err:'no-projector', state: a ? {visible:a.visible} : null};
    const pr = a.projector;
    const pos = pr.position, q = pr.quaternion, half = pr.half;

    // 四元数旋转向量的纯 JS 实现
    function rot(v, qq) {
      const [x,y,z]=v, [qx,qy,qz,qw]=qq;
      const tx=2*(qy*z-qz*y), ty=2*(qz*x-qx*z), tz=2*(qx*y-qy*x);
      return [x+qw*tx+(qy*tz-qz*ty), y+qw*ty+(qz*tx-qx*tz), z+qw*tz+(qx*ty-qy*tx)];
    }
    const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
    const right = rot([1,0,0], q), up = rot([0,1,0], q), nrm = rot([0,0,1], q);
    const camPos = [pos[0]+nrm[0]*(half[2]+0.5), pos[1]+nrm[1]*(half[2]+0.5), pos[2]+nrm[2]*(half[2]+0.5)];
    const far = half[2]*2 + 2;

    // 虚拟相机深度图：沿 -nrm 打碰撞 mesh
    const N = 16;
    const depthMap = new Float32Array(N*N).fill(1.0);
    let hitCount = 0;
    const ds = [-nrm[0], -nrm[1], -nrm[2]];
    for (let j=0;j<N;j++) for (let i=0;i<N;i++) {
      const u = (i+0.5)/N*2-1, v = (j+0.5)/N*2-1;
      const ox = camPos[0]+right[0]*u*half[0]+up[0]*v*half[1];
      const oy = camPos[1]+right[1]*u*half[0]+up[1]*v*half[1];
      const oz = camPos[2]+right[2]*u*half[0]+up[2]*v*half[1];
      const h = col.queryRay(ox,oy,oz, ds[0],ds[1],ds[2], far+2);
      if (h) {
        const d = Math.hypot(h.x-ox, h.y-oy, h.z-oz);
        depthMap[j*N+i] = Math.min(1, d/far);
        hitCount++;
      }
    }

    // 取 49 个主相机 3DGS 世界点
    const g = await ed.picker.unprojectRect(a.rect, 6, 6, {pickTimeout:4000});
    if (!g) return {err:'no-grid'};
    const pts = (g.points||[]).filter(Boolean);
    const cam = W.__viewer.app.root.findComponent('camera');
    const cp = cam.entity.getPosition();
    const camArr = [cp.x, cp.y, cp.z];

    // 对每个 W：变换到虚拟相机空间，采样深度图，比较
    const cmp = [];
    for (const p of pts) {
      const dw = [p[0]-camPos[0], p[1]-camPos[1], p[2]-camPos[2]];
      const lx = dot(dw, right), ly = dot(dw, up), lz = dot(dw, [-nrm[0],-nrm[1],-nrm[2]]);
      const u = lx/half[0], v = ly/half[1]; // -1..1
      if (Math.abs(u)>1 || Math.abs(v)>1) { cmp.push({out:1}); continue; }
      const di = Math.min(N-1, Math.max(0, Math.floor((u*0.5+0.5)*N)));
      const dj = Math.min(N-1, Math.max(0, Math.floor((v*0.5+0.5)*N)));
      const dmap = depthMap[dj*N+di];
      const dW = Math.min(1, lz/far);
      cmp.push({u:+u.toFixed(2), v:+v.toFixed(2), dW:+dW.toFixed(4), dMap:+dmap.toFixed(4), diff:+Math.abs(dW-dmap).toFixed(4)});
    }
    const inside = cmp.filter(c=>!c.out);
    const diffs = inside.map(c=>c.diff).sort((a,b)=>a-b);
    const qf=f=>diffs.length?diffs[Math.min(diffs.length-1,Math.floor(f*(diffs.length-1)))]:null;
    return {
      projector:{pos:pos.map(x=>+x.toFixed(2)), half:half.map(x=>+x.toFixed(2)), rect:a.rect},
      virtualCam:{camPos:camPos.map(x=>+x.toFixed(2)), far:+far.toFixed(2), nrm:nrm.map(x=>+x.toFixed(2))},
      depthMap:{N, hitCount, total:N*N, min:Math.min(...depthMap), max:Math.max(...depthMap)},
      compare:{total:pts.length, inside:inside.length, outside:cmp.length-inside.length,
        diffMin:qf(0), diffMed:qf(0.5), diffP90:qf(0.9), diffMax:qf(1)},
      samples: inside.slice(0,8)
    };
  })()`);
  log('\n===== shadowmap 深度口径验证 =====');
  log(JSON.stringify(result, null, 2));
  log('\n===== JS 错误 =====');
  log(JSON.stringify(errors.slice(0, 5), null, 2));
}
main().catch(e => log('FATAL ' + (e && e.stack || e))).finally(() => { try { ws && ws.close(); } catch {} setTimeout(() => process.exit(0), 300); });

/**
 * 诊断：在 CPU 上复刻 shader 的世界点重建，与 OBB 比对
 * ----------------------------------------------------------------
 * 贴花的 GPU 判定链是：
 *   pick 深度纹理 → (5×5 邻域 30% 分位) → 归一化线性深度 nd
 *   → ndcDepth → NDC → invViewProj → 世界点 → OBB 局部坐标 → 盒内判定
 * 覆盖率低说明「GPU 重建的世界点」与「CPU 深度反算得到的 OBB」不匹配。
 *
 * 本脚本把 pick 纹理读回 CPU，用与 shader 完全一致的数学复算一遍，
 * 对每个像素算：重建世界点 → OBB 局部坐标 → 是否在盒内。
 * 于是能分别判断：
 *   · 深度分位口径错没错（nd 是否合理）
 *   · invViewProj 数学错没错（重建点是否落在 OBB 附近）
 *   · 还是 OBB 本身错（前面已验证 OBB 对 49 个 CPU 采样点是完美的）
 *
 * 用法： node tools/diag_decal_reconstruct.mjs [--headed] [--wait=25000]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 18157;
const CDP_PORT = 9283;
const BASE = `http://127.0.0.1:${PORT}`;
const WAIT = Number((process.argv.find(a => a.startsWith('--wait=')) || '').split('=')[1]) || 20000;
const HEADED = process.argv.includes('--headed');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)],
  { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'diagrecon_' + Date.now());
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
  const E = async (expression, timeoutMs = 120000) => {
    try {
      const r = await Promise.race([
        send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
        sleep(timeoutMs).then(() => ({ timeout: true }))
      ]);
      if (r.timeout) return { __timeout: true };
      if (r.result?.exceptionDetails)
        return { __err: (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').slice(0, 500) };
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
    c.id='recon-decal-'+Date.now();c.visible=false;
    c.rect=[0.34,0.52,0.56,0.72];c.projector=null;c.surface=null;
    c.media=[{type:'video',url:'',caption:'演示'}];
    ed.store.add(c);return c.id;})()`);
  const ID = String(inj);
  await E(`(()=>{const W=${DOC},ed=W.__mgEditor;ed.action('decal-rebuild','${ID}');return 1;})()`);
  await sleep(8000);

  console.log('\n===== CPU 复刻 shader 的世界点重建 =====');
  const r = await E(`(async()=>{const W=${DOC},ed=W.__mgEditor;
    const a=ed.store.get('${ID}');
    if(!a||!a.projector)return {err:'no-proj'};
    const pr=a.projector;
    const v=W.__viewer; const P=W.__pc;
    const app=v.app; const dev=app.graphicsDevice;
    const cam=app.root.findComponent('camera');

    // 读回 pick 纹理（与 GPU 同一份数据）
    const picker=(typeof v.picker==='function')?v.picker():v.picker;
    if(!picker)return {err:'no-picker'};
    const pv=picker.renderView();
    if(!pv||!pv.texture)return {err:'no-pickview'};
    const tex=pv.texture;
    const W_=tex.width,H_=tex.height;

    // 读整张 RGBA16F（引擎 texture.read 需要 renderTarget 参数，这里用 pick 的 rt）
    let px=null;
    try{
      px=await tex.read(0,0,W_,H_);
    }catch(e){ return {err:'read-fail:'+(e&&e.message||e), w:W_, h:H_}; }
    if(!px)return {err:'read-null'};

    // 半精度 -> float
    const h2f=(h)=>{
      const s=(h&0x8000)?-1:1, e=(h>>10)&0x1f, m=h&0x3ff;
      if(e===0) return s*Math.pow(2,-14)*(m/1024);
      if(e===31) return m?NaN:s*Infinity;
      return s*Math.pow(2,e-15)*(1+m/1024);
    };

    // invViewProj（与 shader 同一矩阵）
    const inv=(new P.Mat4()).mul2(cam.projectionMatrix,cam.viewMatrix).invert();
    const M=inv.data;
    const near=cam.nearClip, far=cam.farClip;
    // 局部基（由四元数）
    const q=pr.quaternion, qx=q[0],qy=q[1],qz=q[2],qw=q[3];
    const rot=(vec)=>{const ix=qw*vec[0]+qy*vec[2]-qz*vec[1],iy=qw*vec[1]+qz*vec[0]-qx*vec[2],iz=qw*vec[2]+qx*vec[1]-qy*vec[0],iw=-qx*vec[0]-qy*vec[1]-qz*vec[2];
      const wx=ix*qw+iw*-qx+iy*-qz-iz*-qy,wy=iy*qw+iw*-qy+iz*-qx-ix*-qz,wz=iz*qw+iw*-qz+ix*-qy-iy*-qx;
      return [wx,wy,wz];};
    const lx=rot([1,0,0]),ly=rot([0,1,0]),lz=rot([0,0,1]);
    const c=pr.position, hf=pr.half;

    // 在 OBB 投影到屏幕的包围盒内采样
    const corners=[];
    for(const sx of [-1,1])for(const sy of [-1,1])for(const sz of [-1,1]){
      const wv=[c[0]+lx[0]*hf[0]*sx+ly[0]*hf[1]*sy+lz[0]*hf[2]*sz,
               c[1]+lx[1]*hf[0]*sx+ly[1]*hf[1]*sy+lz[1]*hf[2]*sz,
               c[2]+lx[2]*hf[0]*sx+ly[2]*hf[1]*sy+lz[2]*hf[2]*sz];
      const t=new P.Vec3(wv[0],wv[1],wv[2]);const o=new P.Vec3();
      cam.worldToScreen(t,o);
      corners.push([o.x,o.y]);
    }
    const xs=corners.map(k=>k[0]),ys=corners.map(k=>k[1]);
    const minX=Math.max(0,Math.floor(Math.min.apply(null,xs))), maxX=Math.min(W_-1,Math.ceil(Math.max.apply(null,xs)));
    const minY=Math.max(0,Math.floor(Math.min.apply(null,ys))), maxY=Math.min(H_-1,Math.ceil(Math.max.apply(null,ys)));

    let inBox=0,total=0,noDepth=0,ndSum=0;
    const samples=[];
    for(let y=minY;y<=maxY;y+=2){
      for(let x=minX;x<=maxX;x+=2){
        // 5×5 邻域 30% 分位（与 shader 同）
        const s=[];
        for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){
          if(dx*dx+dy*dy>4)continue;
          const qx2=Math.min(W_-1,Math.max(0,x+dx)), qy2=Math.min(H_-1,Math.max(0,y+dy));
          const i=(qy2*W_+qx2)*4;
          s.push(h2f(px[i]),h2f(px[i+1]),h2f(px[i+2]),h2f(px[i+3]));
        }
        s.sort((a,b)=>a-b);
        const k=Math.max(0,Math.ceil(s.length*0.3)-1);
        const nd=s[k];
        total++;
        if(!(nd<1)){noDepth++;continue;}
        ndSum+=nd;
        const ndcZ=(far*nd)/(nd*(far-near)+near);
        // pick 纹理行序：WebGPU 行0=顶部；屏幕 y 向下
        const ndcX=(x/W_)*2-1, ndcY=(1-(y/H_))*2-1;
        const clip=[ndcX,ndcY,ndcZ*2-1,1];
        // 列主序 mat4 * vec4
        const wv=[
          M[0]*clip[0]+M[4]*clip[1]+M[8]*clip[2]+M[12]*clip[3],
          M[1]*clip[0]+M[5]*clip[1]+M[9]*clip[2]+M[13]*clip[3],
          M[2]*clip[0]+M[6]*clip[1]+M[10]*clip[2]+M[14]*clip[3],
          M[3]*clip[0]+M[7]*clip[1]+M[11]*clip[2]+M[15]*clip[3]];
        if(Math.abs(wv[3])<1e-8)continue;
        const wp=[wv[0]/wv[3],wv[1]/wv[3],wv[2]/wv[3]];
        const d=[wp[0]-c[0],wp[1]-c[1],wp[2]-c[2]];
        const L=[d[0]*lx[0]+d[1]*lx[1]+d[2]*lx[2],
                 d[0]*ly[0]+d[1]*ly[1]+d[2]*ly[2],
                 d[0]*lz[0]+d[1]*lz[1]+d[2]*lz[2]];
        const ln=[L[0]/hf[0],L[1]/hf[1],L[2]/hf[2]];
        const ok=Math.abs(ln[0])<=1&&Math.abs(ln[1])<=1&&Math.abs(ln[2])<=1;
        if(ok)inBox++;
        if(samples.length<8)samples.push({x,y,nd:+nd.toFixed(4),ln:ln.map(v=>+v.toFixed(3)),wp:wp.map(v=>+v.toFixed(2))});
      }
    }
    return {
      pick尺寸:[W_,H_], 采样区:[minX,minY,maxX,maxY],
      总采样:total, 盒内:inBox, 盒内率:+(inBox/(total||1)).toFixed(3),
      无深度:noDepth, 平均nd:+(ndSum/(total-noDepth||1)).toFixed(4),
      OBB:{position:c.map(v=>+v.toFixed(2)),half:hf.map(v=>+v.toFixed(2))},
      样例:samples
    };})()`);
  console.log(JSON.stringify(r, null, 2));
}

main().then(() => { cleanup(); process.exit(0); })
  .catch(e => { console.error('诊断失败:', e.message || e); cleanup(); process.exit(2); });

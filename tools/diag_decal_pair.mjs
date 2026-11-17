/**
 * 诊断（决定性 · v2）：把「重建与 OBB 不匹配」拆成两个独立可判定的维度
 * ----------------------------------------------------------------
 * 已知（上一轮）：
 *   · OBB 对**引擎自己的** 49 个采样点 100% 命中（diag_decal_obb）→ OBB 正确
 *   · 引擎权威点（picker.pick()）的 OBB 局部坐标全部落在 ±1 内（lnEng）
 *   · CPU 复刻 shader 数学 → 盒内率 0.263（与 GPU 实测 0.2387 吻合）
 *
 * v1 的失败：tex.read() 拿到全零数据 → 所有行序变体都退化成同一个点，
 * 误差完全相同（6.754m），无法区分。v2 修掉读回并把变量显式化。
 *
 * 维度一：深度提取对不对？
 *   引擎权威点 eng → 反推引擎的 nd_eng = (-viewZ - near) / (far - near)
 *   与我们从 pick 纹理算出的 nd 比较 → |nd - ndEng| 小则深度口径正确。
 *   （5×5 邻域对称，与行序无关，所以这一步独立于行序。）
 *
 * 维度二：行序 / NDC 口径对不对？
 *   引擎的 readAround 对 WebGL2 翻转 Y、对 WebGPU 不翻转
 *   （viewer/index.js:87840-87851）→ pick 纹理的「行0」在两个后端含义不同。
 *   我们枚举 {行映射 top/bottom} × {ndcY 翻转/不翻转} × {ndcX 翻转/不翻转}，
 *   各自算出世界点与 eng 比距离，误差最小者即正解。
 *
 * 用法： node tools/diag_decal_pair.mjs [--headed] [--wait=25000]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 18161;
const CDP_PORT = 9287;
const BASE = `http://127.0.0.1:${PORT}`;
const WAIT = Number((process.argv.find(a => a.startsWith('--wait=')) || '').split('=')[1]) || 20000;
const HEADED = process.argv.includes('--headed');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)],
  { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'diagpair2_' + Date.now());
fs.mkdirSync(profile, { recursive: true });
const br = spawn(CHROME, [
  ...(HEADED ? [] : ['--headless=new']),
  `--remote-debugging-port=${CDP_PORT}`, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--autoplay-policy=no-user-gesture-required',
  '--enable-unsafe-webgpu',
  ...(HEADED ? [] : ['--use-webgpu-adapter=swiftshader']),
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
  const E = async (expression, timeoutMs = 240000) => {
    try {
      const r = await Promise.race([
        send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
        sleep(timeoutMs).then(() => ({ timeout: true }))
      ]);
      if (r.timeout) return { __timeout: true };
      if (r.result?.exceptionDetails)
        return { __err: (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').slice(0, 800) };
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
    c.id='pair2-decal-'+Date.now();c.visible=false;
    c.rect=[0.34,0.52,0.56,0.72];c.projector=null;c.surface=null;
    c.media=[{type:'video',url:'',caption:'演示'}];
    ed.store.add(c);return c.id;})()`);
  const ID = String(inj);
  await E(`(()=>{const W=${DOC},ed=W.__mgEditor;ed.action('decal-rebuild','${ID}');return 1;})()`);
  await sleep(9000);

  console.log('\n===== 引擎权威点 vs shader 口径重建点（v2） =====');
  const r = await E(`(async()=>{
    const W=${DOC},ed=W.__mgEditor;
    const a=ed.store.get('${ID}');
    if(!a||!a.projector)return {err:'no-proj'};
    const pr=a.projector;
    const v=W.__viewer, P=W.__pc;
    const app=v.app, dev=app.graphicsDevice;
    const cam=app.root.findComponent('camera');
    const picker=(typeof v.picker==='function')?v.picker():v.picker;
    if(!picker)return {err:'no-picker'};

    const backend={
      isWebGPU: !!dev.isWebGPU,
      isWebGL2: !!dev.isWebGL2,
      deviceType: dev.deviceType || null,
      deviceWH:[dev.width,dev.height],
      canvasCSS:[app.graphicsDevice.canvas.clientWidth,app.graphicsDevice.canvas.clientHeight],
      maxPixelRatio: dev.maxPixelRatio
    };

    const pv=picker.renderView();
    if(!pv||!pv.texture)return {err:'no-pickview'};
    const tex=pv.texture;
    const W_=tex.width,H_=tex.height;

    // 读回：先试 immediate:true（引擎 readAround 也用 immediate:true），
    // 若仍是全零再退回默认路径。用非零计数判断成功与否。
    const h2f=(h)=>{
      const s=(h&0x8000)?-1:1, e=(h>>10)&0x1f, m=h&0x3ff;
      if(e===0) return s*Math.pow(2,-14)*(m/1024);
      if(e===31) return m?NaN:s*Infinity;
      return s*Math.pow(2,e-15)*(1+m/1024);
    };
    const stats=(buf)=>{
      if(!buf||!buf.length)return {len:0};
      const nz=[];let mn=Infinity,mx=-Infinity,zero=0;
      const n=Math.min(buf.length,20000);
      for(let i=0;i<n;i++){const x=buf[i];if(x===0)zero++;else nz.push(x);}
      for(const x of nz){const f=h2f(x);if(f<mn)mn=f;if(f>mx)mx=f;}
      return {len:buf.length, 抽样:n, 全零:zero, 最小值:Number.isFinite(mn)?+mn.toFixed(5):null,
              最大值:Number.isFinite(mx)?+mx.toFixed(5):null, 类型:buf.constructor.name};
    };
    let px=null,readMode='immediate';
    try{ px=await tex.read(0,0,W_,H_,{immediate:true}); }catch(e){}
    let st=stats(px);
    if(st.全零===st.抽样){
      readMode='default';
      try{ px=await tex.read(0,0,W_,H_); }catch(e){}
      st=stats(px);
    }
    if(!px||!px.length)return {err:'read-fail',backend};

    const inv=(new P.Mat4()).mul2(cam.projectionMatrix,cam.viewMatrix).invert();
    const M=inv.data;
    const near=cam.nearClip, far=cam.farClip;
    const VM=cam.viewMatrix.data;
    const mulM=(mm,cl)=>[
      mm[0]*cl[0]+mm[4]*cl[1]+mm[8]*cl[2]+mm[12]*cl[3],
      mm[1]*cl[0]+mm[5]*cl[1]+mm[9]*cl[2]+mm[13]*cl[3],
      mm[2]*cl[0]+mm[6]*cl[1]+mm[10]*cl[2]+mm[14]*cl[3],
      mm[3]*cl[0]+mm[7]*cl[1]+mm[11]*cl[2]+mm[15]*cl[3]];

    const q=pr.quaternion,qx=q[0],qy=q[1],qz=q[2],qw=q[3];
    const rot=(vec)=>{const ix=qw*vec[0]+qy*vec[2]-qz*vec[1],iy=qw*vec[1]+qz*vec[0]-qx*vec[2],iz=qw*vec[2]+qx*vec[1]-qy*vec[0],iw=-qx*vec[0]-qy*vec[1]-qz*vec[2];
      const wx=ix*qw+iw*-qx+iy*-qz-iz*-qy,wy=iy*qw+iw*-qy+iz*-qx-ix*-qz,wz=iz*qw+iw*-qz+ix*-qy-iy*-qx;
      return [wx,wy,wz];};
    const lx=rot([1,0,0]),ly=rot([0,1,0]),lz=rot([0,0,1]);
    const c=pr.position,hf=pr.half;
    const localOf=(wp)=>{
      const d=[wp[0]-c[0],wp[1]-c[1],wp[2]-c[2]];
      return [ (d[0]*lx[0]+d[1]*lx[1]+d[2]*lx[2])/hf[0],
               (d[0]*ly[0]+d[1]*ly[1]+d[2]*ly[2])/hf[1],
               (d[0]*lz[0]+d[1]*lz[1]+d[2]*lz[2])/hf[2] ];
    };

    // 5×5 圆盘 30% 分位（与引擎 surfaceDepth 同口径；邻域对称 → 与行序无关）
    const depthAtRow=(row,col)=>{
      const s=[];
      for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){
        if(dx*dx+dy*dy>4)continue;
        const qx2=Math.min(W_-1,Math.max(0,col+dx)),qy2=Math.min(H_-1,Math.max(0,row+dy));
        const i=(qy2*W_+qx2)*4;
        s.push(h2f(px[i]),h2f(px[i+1]),h2f(px[i+2]),h2f(px[i+3]));
      }
      s.sort((p,q)=>p-q);
      return s[Math.max(0,Math.ceil(s.length*0.3)-1)];
    };

    // 引擎屏幕坐标约定：screenY 从上往下（0=顶）。
    // 纹理行映射：WebGPU 纹理行0=顶（直接用）；WebGL2 纹理行0=底（要翻）。
    const variants=[
      {id:'top_flipY',    rowMap:'top',    flipY:true },
      {id:'top_noFlipY',  rowMap:'top',    flipY:false},
      {id:'bot_flipY',    rowMap:'bottom', flipY:true },
      {id:'bot_noFlipY',  rowMap:'bottom', flipY:false}
    ];
    const acc={};
    for(const vr of variants) acc[vr.id]={err:0,n:0,max:0,inBox:0};

    const rect=a.rect;
    const samples=[];
    let depthPairs=0,depthSum=0,depthMax=0;
    for(let j=0;j<=6;j++){
      for(let i=0;i<=6;i++){
        const u=rect[0]+(rect[2]-rect[0])*i/6;
        const vv=rect[1]+(rect[3]-rect[1])*j/6;
        let eng=null;
        try{ const e=await picker.pick(u,vv); if(e) eng=[e.x,e.y,e.z]; }catch(_){}
        if(!eng) continue;
        const sc=Math.min(W_-1,Math.max(0,Math.floor(u*W_)));
        const sr=Math.min(H_-1,Math.max(0,Math.floor(vv*H_)));   // 屏幕行（顶=0）
        // 引擎权威点反推 nd
        const vz=mulM(VM,[eng[0],eng[1],eng[2],1])[2];
        const ndEng=((-vz)-near)/(far-near);
        for(const vr of variants){
          const row = vr.rowMap==='top' ? sr : (H_-1-sr);
          const nd = depthAtRow(row,sc);
          if(Number.isFinite(nd)&&Number.isFinite(ndEng)){
            const df=Math.abs(nd-ndEng);
            if(vr.id==='top_flipY'){ depthPairs++; depthSum+=df; if(df>depthMax)depthMax=df; }
          }
          const ndcZ=(far*nd)/(nd*(far-near)+near);
          let ndcX=(sc/W_)*2-1;
          let ndcY;
          if(vr.rowMap==='top') ndcY = vr.flipY ? ((1-(row/H_))*2-1) : ((row/H_)*2-1);
          else ndcY = vr.flipY ? ((1-(row/H_))*2-1) : ((row/H_)*2-1);
          // 注意：rowMap=bottom 时纹理行与屏幕行相反，NDC 必须按**屏幕行**算，
          // 所以这里统一用 sr 推导 NDC，rowMap 只影响「取哪一行的深度」。
          ndcY = vr.flipY ? ((1-(sr/H_))*2-1) : ((sr/H_)*2-1);
          const wv=mulM(M,[ndcX,ndcY,ndcZ*2-1,1]);
          if(Math.abs(wv[3])<1e-8)continue;
          const wp=[wv[0]/wv[3],wv[1]/wv[3],wv[2]/wv[3]];
          const d=Math.hypot(wp[0]-eng[0],wp[1]-eng[1],wp[2]-eng[2]);
          const A=acc[vr.id];A.n++;A.err+=d;if(d>A.max)A.max=d;
          const ln=localOf(wp);
          if(Math.abs(ln[0])<=1&&Math.abs(ln[1])<=1&&Math.abs(ln[2])<=1)A.inBox++;
          if(samples.length<6&&vr.id==='top_flipY'){
            samples.push({i,j,u:+u.toFixed(4),v:+vv.toFixed(4),screen:[sc,sr],
              nd:+nd.toFixed(5),ndEng:+ndEng.toFixed(5),
              eng:eng.map(x=>+x.toFixed(2)),wp:wp.map(x=>+x.toFixed(2)),
              误差:+d.toFixed(3),
              lnEng:localOf(eng).map(x=>+x.toFixed(3)),ln:ln.map(x=>+x.toFixed(3))});
          }
        }
      }
    }
    const summary={};
    for(const vr of variants){const A=acc[vr.id];
      summary[vr.id]={平均误差:+(A.err/(A.n||1)).toFixed(3),最大误差:+A.max.toFixed(2),盒内:A.inBox+'/'+A.n};}
    return {
      backend, pick尺寸:[W_,H_], 读回:{方式:readMode,...st},
      相机:{near:+near.toFixed(4),far:+far.toFixed(3)},
      OBB:{position:c.map(x=>+x.toFixed(2)),half:hf.map(x=>+x.toFixed(2))},
      深度对比:{样本:depthPairs,平均绝对差:+(depthSum/(depthPairs||1)).toFixed(6),最大差:+depthMax.toFixed(6)},
      变体:summary, 样例:samples
    };})()`);
  console.log(JSON.stringify(r, null, 2));
}

main().then(() => { cleanup(); process.exit(0); })
  .catch(e => { console.error('诊断失败:', e.message || e); cleanup(); process.exit(2); });

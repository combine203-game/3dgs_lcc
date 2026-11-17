/**
 * v2 单引擎「对象在、像素不在」诊断。
 * 打开 ?human=1，dump 材质 uniform / 纹理内容 / meshInstance 状态 /
 * 手算第一个 splat 的 clip 坐标 / 全部 console（含 shader 编译错误）。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 8500 + (process.pid % 200);
const CDP_PORT = PORT + 1000;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HEADED = process.argv.includes('--headed');

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'diagv2_' + Date.now());
fs.mkdirSync(profile, { recursive: true });
const br = spawn(CHROME, [
  ...(HEADED ? [] : ['--headless=new', '--use-gl=swiftshader', '--enable-unsafe-swiftshader']),
  `--remote-debugging-port=${CDP_PORT}`, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--ignore-gpu-blocklist', '--window-size=1200,800', 'about:blank'
], { stdio: 'ignore' });
const cleanup = () => {
  try { br.kill(); } catch {}
  try { srv.kill(); } catch {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
};

let ws, seq = 0;
const pend = new Map();
const consoleAll = [];

async function main() {
  for (let i = 0; i < 100; i++) { try { await fetch(BASE + '/'); break; } catch { await sleep(250); } }
  let page = null;
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      page = list.find((t) => t.type === 'page');
      if (page) break;
    } catch {}
    await sleep(300);
  }
  if (!page) throw new Error('CDP 不可达');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => {
    const o = JSON.parse(e.data);
    if (o.id && pend.has(o.id)) { pend.get(o.id)(o); pend.delete(o.id); return; }
    if (o.method === 'Runtime.consoleAPICalled') {
      const s = (o.params.args || []).map((x) => x.value ?? x.description ?? '').join(' ');
      consoleAll.push(`[${o.params.type}] ${String(s).slice(0, 700)}`);
    }
    if (o.method === 'Runtime.exceptionThrown') {
      consoleAll.push('[EXCEPTION] ' + String(o.params.exceptionDetails?.exception?.description || o.params.exceptionDetails?.text).slice(0, 700));
    }
    if (o.method === 'Log.entryAdded') {
      consoleAll.push('[LOG] ' + String(o.params.entry?.text || '').slice(0, 500));
    }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params }));
  });
  const E = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description || '').slice(0, 600) };
    return r.result?.result?.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Log.enable');
  await send('Page.navigate', { url: `${BASE}/gs-viewer.html?scene=floor3&human=1` });
  await sleep(1200);

  let ready = false;
  for (let i = 0; i < 480; i++) {
    const v = await E(`!!(window.__mgHuman && window.__mgHuman.state && window.__mgHuman.state.ready)`);
    if (v) { ready = true; break; }
    await sleep(500);
  }
  console.log('human ready = ' + ready);
  if (!ready) { console.log(consoleAll.slice(-30).join('\n')); return; }
  await sleep(3000);

  const info = await E(`(()=>{
    const h=window.__mgHuman, it=h._internals(), av=it.avatar;
    if(!av) return {noAvatar:true, state:h.state};
    const m=av.material, inst=av.meshInstance, d=it.device;
    const dump=(k)=>{ try{const v=m.getParameter(k); if(v==null)return null;
      if(typeof v==='number'||typeof v==='boolean')return v;
      if(v.length)return {len:v.length,ctor:v.constructor.name,head:Array.from(v.slice(0,16))};
      return {ctor:v.constructor.name, keys:Object.keys(v).slice(0,8)};}catch(e){return 'ERR '+e.message} };
    const mul=(a,b)=>{const o=new Array(16);for(let c=0;c<4;c++)for(let r=0;r<4;r++){
      let s=0;for(let k=0;k<4;k++)s+=a[k*4+r]*b[c*4+k];o[c*4+r]=s;}return o;};
    const mv=(M,v)=>[M[0]*v[0]+M[4]*v[1]+M[8]*v[2]+M[12]*v[3],
                     M[1]*v[0]+M[5]*v[1]+M[9]*v[2]+M[13]*v[3],
                     M[2]*v[0]+M[6]*v[1]+M[10]*v[2]+M[14]*v[3],
                     M[3]*v[0]+M[7]*v[1]+M[11]*v[2]+M[15]*v[3]];
    const um=dump('uModel'), uv=dump('uView'), up=dump('uProj');
    let clip=null;
    try{
      const st=av._splatTex.lock();
      const p=[st[0],st[1],st[2],1];
      const w=mv(um.head,p), vp=mv(uv.head,w); clip=mv(up.head,vp);
    }catch(e){clip='ERR '+e.message}
    const ot=av._orderTex.lock();
    return {
      deviceType:d.deviceType, isWebGPU:!!d.isWebGPU,
      state:h.state,
      material:{name:m.name,blendType:m.blendType,depthTest:m.depthTest,depthWrite:m.depthWrite,cull:m.cull,
                shaderDescKeys:Object.keys(m.shaderDesc||{})},
      uniforms:{uModel:um,uView:uv,uProj:up,uViewport:dump('uViewport'),uOpacity:dump('uOpacity'),
                splatTex:dump('splatTex'),boneTex:dump('boneTex'),orderTex:dump('orderTex')},
      inst:{visible:inst.visible,instancingCount:inst.instancingCount,cull:inst.cull,
            materialSame:inst.material===m,node:inst.node&&inst.node.name},
      meshPrim:av.meshPc&&av.meshPc.primitive[0]&&{type:av.meshPc.primitive[0].type,count:av.meshPc.primitive[0].count},
      splatTexHead:Array.from(av._splatTex.lock().slice(0,16)),
      boneTexHead:Array.from(av._boneData.slice(0,8)),
      orderHead:Array.from(ot.slice(0,12)),
      orderTail:Array.from(ot.slice((av._n-2)*4,(av._n)*4)),
      stats:av.stats,
      clipOfFirstSplat:clip,
      glErr:d.gl?d.gl.getError():null
    };
  })()`);
  console.log('\n=== v2 运行时诊断 ===');
  console.log(JSON.stringify(info, null, 2));

  console.log('\n=== 全部 console（最后 40 条）===');
  console.log(consoleAll.slice(-40).join('\n'));
}

main().then(() => console.log('\nDONE')).catch((e) => console.error('DIAG ERROR', e)).finally(() => { try { ws && ws.close(); } catch {} cleanup(); });

/**
 * v2 决定性对照诊断：把「已验证可显示」的 PlayCanvas 材质换到数字人 MeshInstance 上。
 *
 * 背景：?diagSimple=1 的极简 shader 仍无像素，而 tools/probe_pc_splat.mjs 在
 *       ?scene=floor3 页面能画出 8x8 彩色点阵。本脚本在**同一个 human=1 页面**里：
 *  [0] dump 人 MeshInstance / node / 材质 / 纹理 / 矩阵的真实状态；
 *  [1] 注入「probe_pc_splat 同款」探针（64 点） → 截图，验证该页面绘制链路是否通；
 *  [2] 隐藏落地阴影 → 截图，排除 shadow 材质污染 layer；
 *  [3] 把人的 material 换成探针同款无纹理 shader → 截图，区分「材质」与「MeshInstance」；
 *  [4] 给人的 MeshInstance 设一个大 customAabb → 截图，排除退化 aabb 被剔除；
 *  [5] dump drawCalls / glError / shader 编译日志。
 *
 * 用法：node tools/diag_v2_decisive.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 8700 + (process.pid % 200);
const CDP_PORT = PORT + 1000;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'diagdec_' + Date.now());
fs.mkdirSync(profile, { recursive: true });
const br = spawn(CHROME, [
  '--headless=new', '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
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
      consoleAll.push(`[${o.params.type}] ${String(s).slice(0, 600)}`);
    }
    if (o.method === 'Runtime.exceptionThrown') {
      consoleAll.push('[EXCEPTION] ' + String(o.params.exceptionDetails?.exception?.description || o.params.exceptionDetails?.text || '').slice(0, 600));
    }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params }));
  });
  const E = async (expression) => {
    for (let k = 0; k < 3; k++) {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description || '').slice(0, 600) };
      if (r.result?.result !== undefined) return r.result.result.value;
      await sleep(200);
    }
    return null;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (r.result?.data) {
      const buf = Buffer.from(r.result.data, 'base64');
      const p = path.join(ROOT, 'shots', name);
      fs.writeFileSync(p, buf);
      console.log(`  -> ${p}  bytes=${buf.length} md5=${crypto.createHash('md5').update(buf).digest('hex').slice(0, 12)}`);
      return buf;
    }
    return null;
  };

  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: `${BASE}/gs-viewer.html?scene=floor3&human=1` });
  await sleep(1200);
  let ready = false;
  for (let i = 0; i < 480; i++) {
    ready = !!(await E(`!!(window.__mgHuman && window.__mgHuman.state && window.__mgHuman.state.ready && window.__mgHuman._internals().avatar)`));
    if (ready) break;
    await sleep(500);
  }
  console.log('human ready = ' + ready);
  if (!ready) { console.log('console 尾部:\n' + consoleAll.slice(-15).join('\n')); return; }
  await E(`(()=>{const h=window.__mgHuman;h.setGait('stand');h.placeInFront(2.8);return 1})()`);
  await sleep(2000);

  /* ---------- [0] 真实状态 ---------- */
  const st = await E(`(()=>{
    const H=window.__mgHuman, I=H._internals(), av=I.avatar, inst=av.meshInstance,
          app=I.app, L=app.scene.defaultDrawLayer, P=globalThis.__pc, d=I.device;
    const wt=inst.node.getWorldTransform().data;
    const a=inst.aabb;
    const cam=I.camComp;
    const st=av._splatTex.lock(); const ot=av._orderTex.lock();
    const out={
      engine:H.state.engine, deviceType:d.deviceType, count:av.stats.splats,
      frameCalls:av.stats.frameCalls, sortMs:av.stats.sortMs,
      nodeWT:Array.from(wt).map(v=>+v.toFixed(5)),
      nodeLocalScale:(()=>{const s=inst.node.getLocalScale();return [s.x,s.y,s.z]})(),
      nodeParent:!!inst.node.parent,
      meshAabb:(()=>{const b=av.meshPc.aabb;return b?{c:[b.center.x,b.center.y,b.center.z],h:[b.halfExtents.x,b.halfExtents.y,b.halfExtents.z]}:null})(),
      instAabb:a?{c:[+a.center.x.toFixed(4),+a.center.y.toFixed(4),+a.center.z.toFixed(4)],h:[+a.halfExtents.x.toFixed(6),+a.halfExtents.y.toFixed(6),+a.halfExtents.z.toFixed(6)]}:null,
      inst:{visible:inst.visible,cull:inst.cull,instancingCount:inst.instancingCount,drawBucket:inst.drawBucket,key:inst.key,layer:!!inst.layer,pick:inst.pick,material:inst.material.name},
      primCount:av.meshPc.primitive[0].count,
      mat:{blend:av.material.blendType,depthTest:av.material.depthTest,depthWrite:av.material.depthWrite,
           unique:av.material.shaderDesc&&av.material.shaderDesc.uniqueName,
           params:Object.keys(av.material.parameters||{})},
      layer:{total:L.meshInstances.length,opaque:L.opaqueMeshInstances?L.opaqueMeshInstances.length:null,
             transparent:L.transparentMeshInstances?L.transparentMeshInstances.length:null,
             idxHuman:L.meshInstances.indexOf(inst)},
      firstSplat:[st[0],st[1],st[2],st[3]], firstOrder:[ot[0],ot[4],ot[8]],
      cam:{view:cam&&cam.viewMatrix?Array.from(cam.viewMatrix.data).map(v=>+v.toFixed(4)):null,
           proj:cam&&cam.projectionMatrix?Array.from(cam.projectionMatrix.data).map(v=>+v.toFixed(4)):null},
      glErr:d.gl?d.gl.getError():null,
      drawCalls:app.stats&&app.stats.drawCalls?{total:app.stats.drawCalls.total,forward:app.stats.drawCalls.forward}:null
    };
    return out;
  })()`);
  console.log('\n=== [0] 真实状态 ===\n' + JSON.stringify(st, null, 2));
  await shot('dv2_dec_0_base.png');

  /* ---------- [1] 注入已验证探针（同页面） ---------- */
  const probe = await E(`(()=>{
    const P=globalThis.__pc, app=window.__viewer.app, d=app.graphicsDevice;
    try{
      const RGBA32F=14,W=8,H=8,N=W*H,data=new Float32Array(N*4);
      for(let i=0;i<N;i++){
        const x=(i%W-3.5)*0.12,y=(Math.floor(i/W)-3.5)*0.12;
        data[i*4]=x;data[i*4+1]=y+1.2;data[i*4+2]=0;data[i*4+3]=1;
      }
      const tex=new P.Texture(d,{name:'dec-probe-tex',width:W,height:H,format:RGBA32F,mipmaps:false,
        minFilter:P.FILTER_NEAREST,magFilter:P.FILTER_NEAREST,addressU:P.ADDRESS_CLAMP_TO_EDGE,addressV:P.ADDRESS_CLAMP_TO_EDGE});
      const lk=tex.lock();lk.set(data);tex.unlock();
      const m=new P.ShaderMaterial();
      m.cull=P.CULLFACE_NONE;m.blendType=P.BLEND_NORMAL;m.depthTest=false;m.depthWrite=false;
      m.shaderDesc={uniqueName:'DecProbeDots',
        vertexGLSL:[
          'attribute vec3 vertex_position;','uniform mat4 matrix_model;','uniform mat4 matrix_viewProjection;',
          'uniform sampler2D splatTex;','varying vec3 vColor;','void main(){',
          '  int id=gl_InstanceID;','  vec4 rec=texelFetch(splatTex, ivec2(id%8,id/8),0);',
          '  vec3 world=rec.xyz+vec3(vertex_position.xy*0.035,0.0);',
          '  gl_Position=matrix_viewProjection*matrix_model*vec4(world,1.0);',
          '  vColor=vec3(float(id%8)/7.0,float(id/8)/7.0,0.6);','}'
        ].join('\\n'),
        fragmentGLSL:['precision highp float;','varying vec3 vColor;','void main(){gl_FragColor=vec4(vColor,0.9);}'].join('\\n'),
        attributes:{vertex_position:P.SEMANTIC_POSITION}};
      m.update();m.setParameter('splatTex',tex);
      const mesh=new P.Mesh(d);
      mesh.setPositions([-1,-1,0,1,-1,0,1,1,0,-1,1,0]);
      mesh.setIndices([0,1,2,0,2,3]);mesh.update(P.PRIMITIVE_TRIANGLES);
      const node=new P.GraphNode('DecProbeNode');
      const cam=app.root.findComponent('camera'),cp=cam.entity.getPosition(),fw=cam.entity.forward;
      node.setPosition(cp.x+fw.x*2.5,cp.y+fw.y*2.5,cp.z+fw.z*2.5);node.getWorldTransform();
      const inst=new P.MeshInstance(mesh,m,node);
      inst.setInstancing(true,true);inst.instancingCount=N;inst.cull=false;inst.visible=true;
      app.scene.defaultDrawLayer.addMeshInstances([inst],true);
      window.__decProbe={inst,material:m,mesh:mesh,tex:tex};
      return {ok:true,N,idx:app.scene.defaultDrawLayer.meshInstances.indexOf(inst)};
    }catch(e){return {ok:false,why:String(e&&e.stack||e).slice(0,500)}}
  })()`);
  console.log('\n[1] 探针注入 = ' + JSON.stringify(probe));
  await sleep(1800);
  await shot('dv2_dec_1_probe.png');

  /* ---------- [2] 隐藏阴影 ---------- */
  const sh = await E(`(()=>{const I=window.__mgHuman._internals();I.shadow.visible=false;return {shadowHidden:!I.shadow.visible}})()`);
  console.log('[2] ' + JSON.stringify(sh));
  await sleep(1200);
  await shot('dv2_dec_2_noshadow.png');

  /* ---------- [3] 人的 material 换成探针同款无纹理 shader ---------- */
  const swap = await E(`(()=>{
    const I=window.__mgHuman._internals(),av=I.avatar,P=globalThis.__pc,d=I.device;
    try{
      window.__decOrigMat=av.material;
      const m=new P.ShaderMaterial();
      m.name='DecSwapMat';
      m.cull=P.CULLFACE_NONE;m.blendType=P.BLEND_NORMAL;m.depthTest=false;m.depthWrite=false;
      m.shaderDesc={uniqueName:'DecSwapShader',
        vertexGLSL:['attribute vec3 vertex_position;','uniform mat4 matrix_model;','uniform mat4 matrix_viewProjection;',
          'void main(void){','  vec3 p=vec3(vertex_position.xy*0.25,0.0);',
          '  gl_Position=matrix_viewProjection*matrix_model*vec4(p,1.0);','}'].join('\\n'),
        fragmentGLSL:'precision highp float; void main(void){gl_FragColor=vec4(1.0,0.0,1.0,0.95);}',
        attributes:{vertex_position:P.SEMANTIC_POSITION}};
      m.update();
      av.meshInstance.material=m;
      av.material=m;
      return {ok:true,mat:m.name,layerIdx:I.app.scene.defaultDrawLayer.meshInstances.indexOf(av.meshInstance)};
    }catch(e){return {ok:false,why:String(e&&e.stack||e).slice(0,500)}}
  })()`);
  console.log('[3] 材质替换 = ' + JSON.stringify(swap));
  await sleep(1800);
  await shot('dv2_dec_3_swapmat.png');

  /* ---------- [4] 大 customAabb ---------- */
  const aabb = await E(`(()=>{
    const I=window.__mgHuman._internals(),av=I.avatar,P=globalThis.__pc;
    try{
      if(typeof av.meshInstance.setCustomAabb==='function'){
        const B=P.BoundingBox||null;
        if(!B) return {ok:false,why:'no BoundingBox exported'};
        const b=new B();b.center.set(0,1,3);b.halfExtents.set(5,5,5);
        av.meshInstance.setCustomAabb(b);
        return {ok:true,has:true,hr:av.meshInstance.aabb.halfExtents.length()};
      }
      return {ok:true,has:false};
    }catch(e){return {ok:false,why:String(e&&e.stack||e).slice(0,500)}}
  })()`);
  console.log('[4] customAabb = ' + JSON.stringify(aabb));
  await sleep(1200);
  await shot('dv2_dec_4_aabb.png');

  /* ---------- [5] 终态 ---------- */
  const fin = await E(`(()=>{
    const I=window.__mgHuman._internals(),av=I.avatar,d=I.device,app=I.app;
    return {glErr:d.gl?d.gl.getError():null,
      drawCalls:app.stats&&app.stats.drawCalls?{total:app.stats.drawCalls.total,forward:app.stats.drawCalls.forward}:null,
      instVisible:av.meshInstance.visible,probeVisible:window.__decProbe?window.__decProbe.inst.visible:null,
      layerTotal:app.scene.defaultDrawLayer.meshInstances.length,
      frameCalls:av.stats.frameCalls};
  })()`);
  console.log('\n=== [5] 终态 ===\n' + JSON.stringify(fin, null, 2));
  console.log('\n=== console（shader/错误） ===');
  const bad = consoleAll.filter((s) => /shader|compil|ERROR|EXCEPTION|warn|fail|glsl/i.test(s));
  console.log(bad.length ? bad.slice(-25).join('\n') : '(无)');
}

main().then(() => console.log('\nDONE')).catch((e) => console.error('DIAG ERROR', e)).finally(() => { try { ws && ws.close(); } catch {} cleanup(); });

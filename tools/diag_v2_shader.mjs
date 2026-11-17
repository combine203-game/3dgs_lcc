/**
 * v2 shader 二分诊断：在真实页面上依次替换数字人材质，每个版本出一张截图。
 *   A simple : 不用任何纹理，固定世界坐标 + 小 quad，纯洋红
 *   B center : 读 splatTex 中心 + orderTex，不做 LBS / EWA
 *   C orig   : 恢复原始 LBS + EWA shader
 * 用途：定位「对象在、像素不在」到底出在绘制链路还是 shader 逻辑。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 8600 + (process.pid % 200);
const CDP_PORT = PORT + 1000;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'diagsh_' + Date.now());
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

const SIMPLE_VS = `
attribute vec3 vertex_position;
uniform mat4 uModel; uniform mat4 uView; uniform mat4 uProj;
void main(void){
  vec4 clip = uProj * uView * uModel * vec4(0.0, 0.9, 3.0, 1.0);
  clip.xy += vertex_position.xy * 0.12 * clip.w;
  gl_Position = clip;
}`;
const CENTER_VS = `
attribute vec3 vertex_position;
uniform mat4 uModel; uniform mat4 uView; uniform mat4 uProj;
uniform sampler2D splatTex; uniform sampler2D orderTex;
void main(void){
  int ordinal = gl_InstanceID;
  int sid = int(texelFetch(orderTex, ivec2(ordinal % 1024, ordinal / 1024), 0).r + 0.5);
  int t = sid * 8;
  vec4 s0 = texelFetch(splatTex, ivec2(t % 1024, t / 1024), 0);
  vec4 clip = uProj * uView * uModel * vec4(s0.xyz, 1.0);
  clip.xy += vertex_position.xy * 0.006 * clip.w;
  gl_Position = clip;
}`;
const FRAG = `precision highp float; void main(void){ gl_FragColor = vec4(1.0, 0.0, 0.9, 0.85); }`;

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
      consoleAll.push(`[${o.params.type}] ${String(s).slice(0, 500)}`);
    }
    if (o.method === 'Runtime.exceptionThrown') consoleAll.push('[EXCEPTION] ' + String(o.params.exceptionDetails?.exception?.description || '').slice(0, 500));
  };
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params }));
  });
  const E = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description || '').slice(0, 500) };
    return r.result?.result?.value;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (r.result?.data) {
      const p = path.join(ROOT, 'shots', name);
      fs.writeFileSync(p, Buffer.from(r.result.data, 'base64'));
      console.log('  -> ' + p);
    }
  };

  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: `${BASE}/gs-viewer.html?scene=floor3&human=1` });
  await sleep(1200);
  for (let i = 0; i < 480; i++) {
    const v = await E(`!!(window.__mgHuman && window.__mgHuman.state && window.__mgHuman.state.ready && window.__mgHuman._internals().avatar)`);
    if (v) break;
    await sleep(500);
  }
  console.log('human ready = ' + !!(await E(`!!(window.__mgHuman && window.__mgHuman.state && window.__mgHuman.state.ready)`)));
  await sleep(2500);

  /* 把人放回相机正前方、站立，排除「走出视锥」干扰 */
  await E(`(()=>{const h=window.__mgHuman;h.setGait('stand');h.placeInFront(2.8);return 1})()`);
  await sleep(1500);
  console.log('C orig（原始 LBS+EWA）');
  await shot('diag_shader_C_orig.png');

  /* 额外挂一个「probe_pc_splat 同款、已验证可显示」的 MeshInstance 作对照组 */
  const probe = await E(`(()=>{
    const P=globalThis.__pc, app=window.__viewer.app, d=app.graphicsDevice;
    try {
      const m=new P.ShaderMaterial();
      m.cull=P.CULLFACE_NONE; m.blendType=P.BLEND_NORMAL;
      m.depthTest=false; m.depthWrite=false;
      m.shaderDesc={ uniqueName:'CompareProbeDots',
        vertexGLSL:'attribute vec3 vertex_position; uniform mat4 matrix_model; uniform mat4 matrix_viewProjection; void main(void){ gl_Position=matrix_viewProjection*matrix_model*vec4(vertex_position.xy*0.25,0.0,1.0); }',
        fragmentGLSL:'precision highp float; void main(void){ gl_FragColor=vec4(1.0,0.0,1.0,0.95); }',
        attributes:{ vertex_position:P.SEMANTIC_POSITION } };
      m.update();
      const mesh=new P.Mesh(d);
      mesh.setPositions([-1,-1,0, 1,-1,0, 1,1,0, -1,1,0]);
      mesh.setIndices([0,1,2, 0,2,3]); mesh.update(P.PRIMITIVE_TRIANGLES);
      const node=new P.GraphNode('CompareProbeNode');
      const cam=app.root.findComponent('camera');
      const cp=cam.entity.getPosition(), fw=cam.entity.forward;
      node.setPosition(cp.x+fw.x*2.5, cp.y+fw.y*2.5, cp.z+fw.z*2.5);
      node.getWorldTransform();
      const inst=new P.MeshInstance(mesh,m,node);
      inst.cull=false; inst.visible=true;
      app.scene.defaultDrawLayer.addMeshInstances([inst],true);
      window.__probeInst=inst;
      return {ok:true};
    } catch(e){ return {ok:false,why:String(e&&e.stack||e).slice(0,400)} }
  })()`);
  console.log('P 探针 inst = ' + JSON.stringify(probe));
  await sleep(1800);
  await shot('diag_shader_P_probe.png');

  const layerInfo = await E(`(()=>{
    const app=window.__viewer.app, L=app.scene.defaultDrawLayer;
    const av=window.__mgHuman._internals().avatar;
    return { total:L.meshInstances.length,
      hasHuman:L.meshInstances.indexOf(av.meshInstance),
      hasProbe:window.__probeInst?L.meshInstances.indexOf(window.__probeInst):-1,
      humanVisible:av.meshInstance.visible, humanHasLayer:!!av.meshInstance.layer,
      probeHasLayer:window.__probeInst?!!window.__probeInst.layer:null,
      humanMat:av.meshInstance.material.name,
      humanKey:av.meshInstance.key, probeKey:window.__probeInst?window.__probeInst.key:null,
      humanInstancing:av.meshInstance.instancingCount,
      humanDrawBucket:av.meshInstance.drawBucket,
      probeDrawBucket:window.__probeInst?window.__probeInst.drawBucket:null,
      humanAabb: (()=>{const a=av.meshInstance.aabb;return a?{cx:a.center.x,cy:a.center.y,cz:a.center.z,hr:a.halfExtents.x}:null})()
    };
  })()`);
  console.log('=== layer / inst 对比 ===\n' + JSON.stringify(layerInfo, null, 2));

  const save = await E(`(()=>{const m=window.__mgHuman._internals().avatar.material;
    window.__origDesc = Object.assign({}, m.shaderDesc); return Object.keys(window.__origDesc)})()`);
  console.log('原 shaderDesc keys = ' + JSON.stringify(save));

  const setShader = (vs) => E(`(()=>{
    const m=window.__mgHuman._internals().avatar.material, P=globalThis.__pc;
    m.shaderDesc = {
      uniqueName:'DiagShader' + Math.random().toString(36).slice(2,8),
      vertexGLSL: ${JSON.stringify(vs)},
      fragmentGLSL: ${JSON.stringify(FRAG)},
      attributes:{ vertex_position: P.SEMANTIC_POSITION }
    };
    m.update();
    return m.shaderDesc.uniqueName;
  })()`);

  console.log('A simple（固定世界点，不读纹理）');
  console.log('  ' + JSON.stringify(await setShader(SIMPLE_VS)));
  await sleep(1800);
  await shot('diag_shader_A_simple.png');

  console.log('B center（读 splatTex 中心，不 LBS/EWA）');
  console.log('  ' + JSON.stringify(await setShader(CENTER_VS)));
  await sleep(1800);
  await shot('diag_shader_B_center.png');

  const diag = await E(`(()=>{
    const av=window.__mgHuman._internals().avatar, m=av.material, d=window.__viewer.app.graphicsDevice;
    return { glErr:d.gl?d.gl.getError():null, frameCalls:av.stats.frameCalls,
             frameMs:av.stats.frameMs, instCount:av.meshInstance.instancingCount,
             viewport: (()=>{const v=m.getParameter('uViewport');return v&&v.data?Array.from(v.data):null})(),
             blendType:m.blendType, depthTest:m.depthTest, visible:av.meshInstance.visible };
  })()`);
  console.log('\n=== 状态 ===\n' + JSON.stringify(diag, null, 2));
  console.log('\n=== console 尾部 ===\n' + consoleAll.slice(-12).join('\n'));
}

main().then(() => console.log('\nDONE')).catch((e) => console.error('DIAG ERROR', e)).finally(() => { try { ws && ws.close(); } catch {} cleanup(); });

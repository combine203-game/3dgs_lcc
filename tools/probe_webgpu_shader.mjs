/**
 * WebGPU 后端下自定义 ShaderMaterial 可行性实测（有头 Chrome）。
 *
 * 背景：v2 单引擎在 WebGL2 已出像素；但有头 Chrome 默认走 WebGPU，
 * 宿主 createGraphicsDevice 未传 glslangUrl/twgslUrl，GLSL 可能无法转译。
 * 本探针在同一页面里分别挂：
 *   A) 最小 GLSL ShaderMaterial（洋红方块）
 *   B) 最小 WGSL ShaderMaterial（青色方块，含 instanceIndex + textureLoad）
 * 各出一张截图 + dump device 状态，决定 v2 在 WebGPU 下该走哪条路。
 *
 * 用法：node tools/probe_webgpu_shader.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 8800 + (process.pid % 200);
const CDP_PORT = PORT + 1000;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'probewgsl_' + Date.now());
fs.mkdirSync(profile, { recursive: true });
const br = spawn(CHROME, [
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
    const r = await Promise.race([
      send('Page.captureScreenshot', { format: 'png' }),
      sleep(15000).then(() => null)
    ]);
    if (r && r.result?.data) {
      const buf = Buffer.from(r.result.data, 'base64');
      const p = path.join(ROOT, 'shots', name);
      fs.writeFileSync(p, buf);
      console.log(`  -> ${p} bytes=${buf.length} md5=${crypto.createHash('md5').update(buf).digest('hex').slice(0, 12)}`);
    } else console.log('  -> 截图超时');
  };

  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: `${BASE}/gs-viewer.html?scene=floor3&renderer=webgpu` });
  await sleep(1500);
  let ready = false;
  for (let i = 0; i < 240; i++) {
    ready = !!(await E(`!!(window.__viewer && window.__viewer.app && window.__viewer.app.graphicsDevice)`));
    if (ready) break;
    await sleep(500);
  }
  const dev = await E(`(()=>{
    const d=window.__viewer&&window.__viewer.app&&window.__viewer.app.graphicsDevice;
    if(!d) return {ok:false};
    return {ok:true,deviceType:d.deviceType,isWebGPU:!!d.isWebGPU,hasTranspilers:!!d.hasTranspilers,
      glslang:!!d.glslang,twgsl:!!d.twgsl,
      rendererBadge:(document.querySelector('#mg-renderer-badge')||{}).textContent||null};
  })()`);
  console.log('=== device ===\n' + JSON.stringify(dev, null, 2));
  console.log('viewer ready = ' + ready);
  if (!ready || !dev || !dev.ok) { console.log(consoleAll.slice(-12).join('\n')); return; }

  /* 让宿主按需渲染也持续出帧，否则截图冻结 */
  await E(`(()=>{window.__probeTick=setInterval(()=>{try{window.__viewer.app.renderNextFrame=true}catch(e){}},33);return 1})()`);

  /* A) 最小 GLSL 材质 */
  const a = await E(`(()=>{
    const P=globalThis.__pc,app=window.__viewer.app,d=app.graphicsDevice;
    try{
      const m=new P.ShaderMaterial();
      m.cull=P.CULLFACE_NONE;m.blendType=P.BLEND_NORMAL;m.depthTest=false;m.depthWrite=false;
      m.shaderDesc={uniqueName:'WgslProbeGLSL',
        vertexGLSL:'attribute vec3 vertex_position; uniform mat4 matrix_model; uniform mat4 matrix_viewProjection; void main(void){ gl_Position=matrix_viewProjection*matrix_model*vec4(vertex_position.xy*0.35,0.0,1.0); }',
        fragmentGLSL:'precision highp float; void main(void){ gl_FragColor=vec4(1.0,0.0,0.85,0.95); }',
        attributes:{vertex_position:P.SEMANTIC_POSITION}};
      m.update();
      const mesh=new P.Mesh(d);
      mesh.setPositions([-1,-1,0,1,-1,0,1,1,0,-1,1,0]);
      mesh.setIndices([0,1,2,0,2,3]);mesh.update(P.PRIMITIVE_TRIANGLES);
      const node=new P.GraphNode('WgslProbeGLSLNode');
      const cam=app.root.findComponent('camera'),cp=cam.entity.getPosition(),fw=cam.entity.forward;
      node.setPosition(cp.x+fw.x*2.5,cp.y+fw.y*2.5,cp.z+fw.z*2.5);node.getWorldTransform();
      const inst=new P.MeshInstance(mesh,m,node);
      inst.cull=false;inst.visible=true;
      app.scene.defaultDrawLayer.addMeshInstances([inst],true);
      window.__glslInst=inst;
      return {ok:true};
    }catch(e){return {ok:false,why:String(e&&e.stack||e).slice(0,500)}}
  })()`);
  console.log('[A] GLSL 材质 = ' + JSON.stringify(a));
  await sleep(2500);
  await shot('wgsl_probe_A_glsl.png');

  /* B) 最小 WGSL 材质（含 instanceIndex + textureLoad） */
  const b = await E(`(()=>{
    const P=globalThis.__pc,app=window.__viewer.app,d=app.graphicsDevice;
    try{
      const RGBA32F=14,W=4,H=4,data=new Float32Array(W*H*4);
      for(let i=0;i<W*H;i++){data[i*4]=(i%W-1.5)*0.18;data[i*4+1]=(Math.floor(i/W)-1.5)*0.18;data[i*4+2]=0;data[i*4+3]=1;}
      const tex=new P.Texture(d,{name:'wgsl-probe-tex',width:W,height:H,format:RGBA32F,mipmaps:false,
        minFilter:P.FILTER_NEAREST,magFilter:P.FILTER_NEAREST,addressU:P.ADDRESS_CLAMP_TO_EDGE,addressV:P.ADDRESS_CLAMP_TO_EDGE});
      const lk=tex.lock();lk.set(data);tex.unlock();
      const m=new P.ShaderMaterial();
      m.cull=P.CULLFACE_NONE;m.blendType=P.BLEND_NORMAL;m.depthTest=false;m.depthWrite=false;
      m.shaderDesc={uniqueName:'WgslProbeWGSL',
        vertexGLSL:'attribute vec3 vertex_position; uniform mat4 matrix_model; uniform mat4 matrix_viewProjection; void main(void){ gl_Position=matrix_viewProjection*matrix_model*vec4(vertex_position.xy*0.35,0.0,1.0); }',
        fragmentGLSL:'precision highp float; void main(void){ gl_FragColor=vec4(0.0,1.0,1.0,0.95); }',
        vertexWGSL:[
          'attribute vertex_position: vec3f;',
          'uniform matrix_model: mat4x4f;',
          'uniform matrix_viewProjection: mat4x4f;',
          'var probeTex: texture_2d<f32>;',
          'varying vTint: vec3f;',
          '@vertex',
          'fn vertexMain(input: VertexInput) -> VertexOutput {',
          '  var output: VertexOutput;',
          '  let id: u32 = input.instanceIndex;',
          '  let rec: vec4f = textureLoad(probeTex, vec2i(i32(id % 4u), i32(id / 4u)), 0);',
          '  let world = vec4f(rec.xy + input.vertex_position.xy * 0.06 + vec2f(0.0, 1.0), 0.0, 1.0);',
          '  output.position = uniform.matrix_viewProjection * uniform.matrix_model * world;',
          '  output.vTint = vec3f(0.0, 1.0, 1.0);',
          '  return output;',
          '}'
        ].join('\\n'),
        fragmentWGSL:[
          'varying vTint: vec3f;',
          '@fragment',
          'fn fragmentMain(input: FragmentInput) -> FragmentOutput {',
          '  var output: FragmentOutput;',
          '  output.color = vec4f(input.vTint, 0.95);',
          '  return output;',
          '}'
        ].join('\\n'),
        attributes:{vertex_position:P.SEMANTIC_POSITION}};
      m.update();m.setParameter('probeTex',tex);
      const mesh=new P.Mesh(d);
      mesh.setPositions([-1,-1,0,1,-1,0,1,1,0,-1,1,0]);
      mesh.setIndices([0,1,2,0,2,3]);mesh.update(P.PRIMITIVE_TRIANGLES);
      const node=new P.GraphNode('WgslProbeWGSLNode');
      const cam=app.root.findComponent('camera'),cp=cam.entity.getPosition(),fw=cam.entity.forward;
      node.setPosition(cp.x+fw.x*2.5,cp.y+fw.y*2.5,cp.z+fw.z*2.5);node.getWorldTransform();
      const inst=new P.MeshInstance(mesh,m,node);
      inst.setInstancing(true,true);inst.instancingCount=16;
      inst.cull=false;inst.visible=true;
      app.scene.defaultDrawLayer.addMeshInstances([inst],true);
      window.__wgslInst=inst;
      return {ok:true};
    }catch(e){return {ok:false,why:String(e&&e.stack||e).slice(0,500)}}
  })()`);
  console.log('[B] WGSL 材质 = ' + JSON.stringify(b));
  await sleep(2500);
  await shot('wgsl_probe_B_wgsl.png');

  const fin = await E(`(()=>{
    const d=window.__viewer.app.graphicsDevice,app=window.__viewer.app;
    return {deviceType:d.deviceType,glslVisible:window.__glslInst?window.__glslInst.visible:null,
      wgslVisible:window.__wgslInst?window.__wgslInst.visible:null,
      wgslInstancing:window.__wgslInst?window.__wgslInst.instancingCount:null,
      layerTotal:app.scene.defaultDrawLayer.meshInstances.length,
      drawCalls:app.stats&&app.stats.drawCalls?app.stats.drawCalls.total:null};
  })()`);
  console.log('\n=== 终态 ===\n' + JSON.stringify(fin, null, 2));
  console.log('\n=== console（错误/shader） ===');
  const bad = consoleAll.filter((s) => /shader|compil|ERROR|EXCEPTION|warn|fail|glsl|wgsl|transpil/i.test(s));
  console.log(bad.length ? bad.slice(-30).join('\n') : '(无)');
}

main().then(() => console.log('\nDONE')).catch((e) => console.error('PROBE ERROR', e)).finally(() => { try { ws && ws.close(); } catch {} cleanup(); });

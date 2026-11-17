/**
 * 单引擎改造可行性探针（系统 Chrome + CDP，无 playwright）
 *
 * 目的：在真实运行的 viewer 页面里确认 PlayCanvas 原生渲染 API 的实际形态，
 * 不靠读压缩 bundle 猜接口。输出作为 docs/ITERATION_V2.md 的实证依据。
 *
 * 用法：node tools/probe_single_engine.mjs [--headed]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 8300 + (process.pid % 200);
const CDP_PORT = PORT + 1000;
const BASE = `http://127.0.0.1:${PORT}`;
const HEADED = process.argv.includes('--headed');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'probe_' + Date.now());
fs.mkdirSync(profile, { recursive: true });
const br = spawn(CHROME, [
  ...(HEADED ? [] : ['--headless=new', '--use-gl=swiftshader', '--enable-unsafe-swiftshader']),
  `--remote-debugging-port=${CDP_PORT}`, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--ignore-gpu-blocklist', '--window-size=1600,900', 'about:blank'
], { stdio: 'ignore' });

function cleanup() {
  try { br.kill(); } catch { /* noop */ }
  try { srv.kill(); } catch { /* noop */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* noop */ }
}

let ws, seq = 0;
const pend = new Map();

async function main() {
  for (let i = 0; i < 100; i++) { try { await fetch(BASE + '/'); break; } catch { await sleep(250); } }
  let page = null;
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      page = list.find((t) => t.type === 'page');
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
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params }));
  });
  const E = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description || '').slice(0, 300) };
    return r.result?.result?.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: `${BASE}/gs-viewer.html?scene=floor3` });
  await sleep(1500);

  let ready = false;
  for (let i = 0; i < 120; i++) {
    const v = await E(`!!(window.__viewer && window.__viewer.app && window.__viewer.app.graphicsDevice)`);
    if (v) { ready = true; break; }
    await sleep(500);
  }
  console.log('viewer ready = ' + ready);
  if (!ready) return;

  const info = await E(`(()=>{
    const v=window.__viewer, app=v.app, d=app.graphicsDevice, P=globalThis.__pc;
    const dl=app.scene && app.scene.defaultDrawLayer;
    const camComp = app.root.findComponent('camera');
    const own = (o)=> o ? Object.getOwnPropertyNames(o).slice(0,60) : [];
    return {
      deviceType: d && d.deviceType,
      isWebGPU: d && d.isWebGPU,
      webgl2: !!(d && d.gl && typeof WebGL2RenderingContext !== 'undefined' && d.gl instanceof WebGL2RenderingContext),
      maxTextureSize: d && d.maxTextureSize,
      pcKeys: P ? Object.keys(P) : null,
      defaultDrawLayer: !!dl,
      addMeshInstances: dl && typeof dl.addMeshInstances,
      transparentSortMode: dl && dl.transparentSortMode,
      layers: app.scene.layers ? app.scene.layers.layerList.map(l=>l.name) : null,
      cameraEntity: !!(camComp && camComp.entity),
      cameraFov: camComp && camComp.fov,
      cameraPos: camComp && camComp.entity && (()=>{const p=camComp.entity.getPosition();return [p.x,p.y,p.z]})(),
      meshProto: P && own(P.Mesh.prototype),
      shaderMatProto: P && own(P.ShaderMaterial.prototype),
      textureProto: P && own(P.Texture.prototype),
      meshInstanceProto: P && own(P.MeshInstance.prototype),
      canvasCount: document.querySelectorAll('canvas').length,
      canvasIds: [...document.querySelectorAll('canvas')].map(c=>c.id||'(anon)')
    };
  })()`);
  console.log('\n=== 运行时 API 探针 ===');
  console.log(JSON.stringify(info, null, 2));

  /* 真正建一个 ShaderMaterial + MeshInstance，跑一帧，确认 shader 能编译 */
  const trial = await E(`(async()=>{
    const P=globalThis.__pc, app=window.__viewer.app, d=app.graphicsDevice;
    if(!P||!P.ShaderMaterial) return {ok:false,why:'no __pc'};
    try{
      const m=new P.ShaderMaterial();
      m.cull=P.CULLFACE_NONE; m.blendType=P.BLEND_NORMAL;
      m.depthTest=true; m.depthWrite=false;
      m.shaderDesc={
        uniqueName:'ProbeSingleEngineTri',
        vertexGLSL:'attribute vec3 vertex_position; uniform mat4 matrix_model; uniform mat4 matrix_viewProjection; void main(){ gl_Position = matrix_viewProjection * matrix_model * vec4(vertex_position,1.0); }',
        fragmentGLSL:'precision highp float; void main(){ gl_FragColor = vec4(1.0,0.0,1.0,0.5); }',
        vertexWGSL:'attribute vertex_position: vec3f; uniform matrix_model: mat4x4f; uniform matrix_viewProjection: mat4x4f; @vertex fn vertexMain(input: VertexInput) -> VertexOutput { var output: VertexOutput; output.position = uniform.matrix_viewProjection * uniform.matrix_model * vec4f(input.vertex_position,1.0); return output; }',
        fragmentWGSL:'@fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput { var output: FragmentOutput; output.color = vec4f(1.0,0.0,1.0,0.5); return output; }',
        attributes:{ vertex_position: P.SEMANTIC_POSITION }
      };
      m.update();
      const mesh=new P.Mesh(d);
      mesh.setPositions([0,0,0, 1,0,0, 0,1,0]);
      mesh.update(P.PRIMITIVE_TRIANGLES);
      const node=new P.GraphNode('ProbeTri');
      const inst=new P.MeshInstance(mesh,m,node);
      inst.cull=false; inst.visible=true;
      app.scene.defaultDrawLayer.addMeshInstances([inst],true);
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      const shaderOk = !!(m.shader || (m.variants && Object.keys(m.variants).length));
      const out={ok:true,shaderOk,meshPrim:mesh.primitive[0]&&mesh.primitive[0].type,
                 meshCount:mesh.primitive[0]&&mesh.primitive[0].count,
                 materialName:m.name, layerHas:true};
      app.scene.defaultDrawLayer.removeMeshInstances([inst],true);
      mesh.destroy(); m.destroy();
      return out;
    }catch(e){ return {ok:false,why:String(e&&e.stack||e).slice(0,500)} }
  })()`);
  console.log('\n=== ShaderMaterial 最小样例 ===');
  console.log(JSON.stringify(trial, null, 2));
}

main().then(() => { console.log('\nDONE'); }).catch((e) => console.error('PROBE ERROR', e)).finally(() => { try { ws && ws.close(); } catch {} cleanup(); });

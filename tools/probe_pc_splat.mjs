/**
 * 单引擎高斯渲染最小样例（PlayCanvas 原生 MeshInstance + ShaderMaterial）
 *
 * 验证四件地基，任一不成立则 v2 方案必须改道：
 *   1. `setInstancing(true,true)` + `gl_InstanceID` 能画出 N 个实例；
 *   2. `matrix_viewProjection` / `matrix_model` 由引擎自动注入；
 *   3. RGBA32F 纹理 `setData()` 上传后能在 vertex shader 里 texelFetch；
 *   4. 引擎 shader 编译无 console 错误（PlayCanvas 编译失败是静默的）。
 *
 * 用法：node tools/probe_pc_splat.mjs [--headed]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 8400 + (process.pid % 200);
const CDP_PORT = PORT + 1000;
const BASE = `http://127.0.0.1:${PORT}`;
const HEADED = process.argv.includes('--headed');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'probesplat_' + Date.now());
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
const consoleLogs = [];

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
      consoleLogs.push(`[${o.params.type}] ${String(s).slice(0, 400)}`);
    }
    if (o.method === 'Runtime.exceptionThrown') {
      consoleLogs.push('[EXCEPTION] ' + String(o.params.exceptionDetails?.exception?.description || o.params.exceptionDetails?.text).slice(0, 400));
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
  await send('Page.navigate', { url: `${BASE}/gs-viewer.html?scene=floor3` });
  await sleep(1200);
  let viewerReady = false;
  for (let i = 0; i < 360; i++) {
    const v = await E(`!!(window.__viewer && window.__viewer.app && window.__viewer.app.graphicsDevice)`);
    if (v) { viewerReady = true; break; }
    await sleep(500);
  }
  console.log('viewer ready = ' + viewerReady);
  if (!viewerReady) return;

  /* 在相机正前方 2.5 m 处画 64 个高斯点（8x8），颜色/位置全部来自 RGBA32F 纹理 */
  const result = await E(`(async()=>{
    const P=globalThis.__pc, app=window.__viewer.app, d=app.graphicsDevice;
    if(!P) return {ok:false,why:'no __pc'};
    const RGBA32F = 14;   // bundle: PIXELFORMAT_RGBA32F = 14
    try {
      const W=8,H=8,N=W*H;
      const data = new Float32Array(N*4);
      for(let i=0;i<N;i++){
        const x=(i%W-3.5)*0.12, y=(Math.floor(i/W)-3.5)*0.12;
        data[i*4+0]=x; data[i*4+1]=y+1.2; data[i*4+2]=0; data[i*4+3]=1;
      }
      const tex = new P.Texture(d,{name:'probe-splat-tex',width:W,height:H,
        format:RGBA32F,mipmaps:false,minFilter:P.FILTER_NEAREST,magFilter:P.FILTER_NEAREST,
        addressU:P.ADDRESS_CLAMP_TO_EDGE,addressV:P.ADDRESS_CLAMP_TO_EDGE});
      const locked = tex.lock();          // Float32Array（RGBA32F）
      locked.set(data);
      tex.unlock();                       // 触发 upload()
      const setOk = locked.length === data.length;

      const m = new P.ShaderMaterial();
      m.cull=P.CULLFACE_NONE; m.blendType=P.BLEND_NORMAL;
      m.depthTest=false; m.depthWrite=false;
      m.shaderDesc = {
        uniqueName:'ProbePcSplatDots',
        vertexGLSL: [
          'attribute vec3 vertex_position;',
          'uniform mat4 matrix_model;',
          'uniform mat4 matrix_viewProjection;',
          'uniform sampler2D splatTex;',
          'uniform float uCount;',
          'varying vec3 vColor;',
          'void main(){',
          '  int id = gl_InstanceID;',
          '  vec4 rec = texelFetch(splatTex, ivec2(id % 8, id / 8), 0);',
          '  vec3 world = rec.xyz + vec3(vertex_position.xy * 0.035, 0.0);',
          '  gl_Position = matrix_viewProjection * matrix_model * vec4(world,1.0);',
          '  vColor = vec3(float(id % 8)/7.0, float(id / 8)/7.0, 0.6);',
          '}'
        ].join('\\n'),
        fragmentGLSL: [
          'precision highp float;',
          'varying vec3 vColor;',
          'void main(){ gl_FragColor = vec4(vColor, 0.9); }'
        ].join('\\n'),
        attributes: { vertex_position: P.SEMANTIC_POSITION }
      };
      m.update();
      m.setParameter('splatTex', tex);
      m.setParameter('uCount', N);

      const mesh = new P.Mesh(d);
      mesh.setPositions([-1,-1,0, 1,-1,0, 1,1,0, -1,1,0]);
      mesh.setIndices([0,1,2, 0,2,3]);
      mesh.update(P.PRIMITIVE_TRIANGLES);

      const node = new P.GraphNode('ProbeSplatNode');
      const cam = app.root.findComponent('camera');
      const cp = cam.entity.getPosition();
      const fwd = cam.entity.forward;
      node.setPosition(cp.x+fwd.x*2.5, cp.y+fwd.y*2.5, cp.z+fwd.z*2.5);
      node.getWorldTransform();

      const inst = new P.MeshInstance(mesh, m, node);
      inst.setInstancing(true, true);
      inst.instancingCount = N;
      inst.cull = false;
      inst.visible = true;
      app.scene.defaultDrawLayer.addMeshInstances([inst], true);
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      const out = {ok:true, setOk, storageType:locked.constructor.name, storageLen:locked.length,
                   instancingCount:inst.instancingCount, primCount:mesh.primitive[0].count,
                   deviceType:d.deviceType, glErr:d.gl?d.gl.getError():null};
      window.__probeSplatTeardown = ()=>{
        app.scene.defaultDrawLayer.removeMeshInstances([inst],true);
        mesh.destroy(); m.destroy(); tex.destroy();
      };
      return out;
    } catch(e){ return {ok:false, why:String(e&&e.stack||e).slice(0,700)}; }
  })()`);
  console.log('=== 最小高斯样例 ===');
  console.log(JSON.stringify(result, null, 2));

  /* 截图：有 64 个彩色点即证明整条链路通 */
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot.result?.data) {
    const out = path.join(ROOT, 'shots', 'probe_pc_splat.png');
    fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
    console.log('截图 -> ' + out);
  }

  const shaderErrors = consoleLogs.filter((s) => /shader|compile|ERROR|glsl|EXCEPTION/i.test(s));
  console.log('\n=== shader / 异常日志 ===');
  console.log(shaderErrors.length ? shaderErrors.join('\n') : '(无)');

  await E(`(()=>{window.__probeSplatTeardown&&window.__probeSplatTeardown();return 1})()`);
}

main().then(() => console.log('\nDONE')).catch((e) => console.error('PROBE ERROR', e)).finally(() => { try { ws && ws.close(); } catch {} cleanup(); });

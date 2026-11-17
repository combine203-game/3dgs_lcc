/**
 * 诊断：贴花材质的 vertex layout 到底哪里对不上
 * ----------------------------------------------------------------
 * 真机（真实 GPU）报错：
 *   "Vertex attribute slot 0 used in ([ShaderModule], [EntryPoint "vertexMain"])
 *    is not present in the VertexState."
 *
 * 这条错误说明 **VertexState 里没有 location 0**。VertexState 由两处决定：
 *   A. mesh 的 vertex format elements  → semanticToLocation[element.name]
 *   B. shader 的 attributes map         → semanticToLocation[semantic]
 * 两边必须把**同一个 attribute 名**映射到同一个 location，且 mesh 必须真的
 * 带那个 semantic 的顶点流。本脚本把两边的实际内容都 dump 出来。
 *
 * 用法： node tools/diag_decal_vertexlayout.mjs [--headed] [--wait=20000]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 18143;
const CDP_PORT = 9269;
const BASE = `http://127.0.0.1:${PORT}`;
const WAIT = Number((process.argv.find(a => a.startsWith('--wait=')) || '').split('=')[1]) || 20000;
const HEADED = process.argv.includes('--headed');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)],
  { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'diagvtx_' + Date.now());
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
  const E = async (expression, timeoutMs = 60000) => {
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
  await sleep(4000);

  console.log('\n===== mesh 的 vertex format =====');
  const mf = await E(`(()=>{const W=${DOC},ed=W.__mgEditor;
    const m=ed&&ed.decalMgr;if(!m)return {err:'no-mgr'};
    // 找到任一贴花实例的 renderable -> mesh
    let inst=null;for(const i of m.instances.values()){inst=i;break;}
    if(!inst)return {err:'no-instance'};
    const mi=inst.renderable;if(!mi)return {err:'no-renderable'};
    const mesh=mi.mesh||mi._mesh;
    if(!mesh)return {err:'no-mesh',keys:Object.keys(mi)};
    const vb=mesh.vertexBuffer;
    const fmt=vb?vb.format:null;
    return {
      meshKeys:Object.keys(mesh).slice(0,20),
      hasVertexBuffer:!!vb,
      numVertices:vb?vb.numVertices:null,
      elements:fmt?fmt.elements.map(e=>({name:e.name,components:e.numComponents,dataType:e.dataType,normalize:e.normalize})):null,
      renderingHashString:fmt?fmt.renderingHashString:null
    };})()`);
  console.log('  ', JSON.stringify(mf, null, 2));

  console.log('\n===== shader 的 attributes / 已处理源码 =====');
  const sh = await E(`(()=>{const W=${DOC},ed=W.__mgEditor;
    const m=ed&&ed.decalMgr;if(!m)return {err:'no-mgr'};
    let inst=null;for(const i of m.instances.values()){inst=i;break;}
    const mat=inst&&inst.material;if(!mat)return {err:'no-material'};
    const sd=mat.shaderDesc||{};
    const sh2=mat._shader||mat.shader;
    return {
      descAttributes:sd.attributes,
      descKeys:Object.keys(sd),
      matKeys:Object.keys(mat).slice(0,30),
      shaderImpl:!!sh2,
      shaderKeys:sh2?Object.keys(sh2).slice(0,30):null
    };})()`);
  console.log('  ', JSON.stringify(sh, null, 2));

  console.log('\n===== 处理后的 WGSL 源码（看 @location 是否生成）=====');
  const src = await E(`(()=>{const W=${DOC},ed=W.__mgEditor;
    const m=ed&&ed.decalMgr;
    let inst=null;for(const i of m.instances.values()){inst=i;break;}
    const mat=inst&&inst.material;if(!mat)return {err:'no-material'};
    // ShaderMaterial 的 shader 在 variant 里，通过 device 的 program library 找
    const dev=W.__viewer?.app?.graphicsDevice;
    if(!dev)return {err:'no-device'};
    const lib=dev.programLib;
    return {err:'manual', hasLib:!!lib};})()`);
  console.log('  ', JSON.stringify(src));

  console.log('\n===== 直接复现：手工造一个 Mesh + 我们的顶点流，看 format =====');
  const manual = await E(`(()=>{const W=${DOC};
    const P=W.__pc;if(!P)return {err:'no-pc'};
    const dev=W.__viewer?.app?.graphicsDevice;
    const mesh=new P.Mesh(dev);
    mesh.setPositions(new Float32Array([-0.5,-0.5, 0.5,-0.5, -0.5,0.5, 0.5,0.5]), 2);
    mesh.update(P.PRIMITIVE_TRISTRIP);
    const fmt=mesh.vertexBuffer?mesh.vertexBuffer.format:null;
    const out={
      numVertices:mesh.vertexBuffer?mesh.vertexBuffer.numVertices:null,
      elements:fmt?fmt.elements.map(e=>({name:e.name,numComponents:e.numComponents})):null
    };
    // 再试 3 分量版本
    const m3=new P.Mesh(dev);
    m3.setPositions(new Float32Array([-0.5,-0.5,0, 0.5,-0.5,0, -0.5,0.5,0, 0.5,0.5,0]), 3);
    m3.update(P.PRIMITIVE_TRISTRIP);
    const f3=m3.vertexBuffer?m3.vertexBuffer.format:null;
    out.elements3=f3?f3.elements.map(e=>({name:e.name,numComponents:e.numComponents})):null;
    return out;})()`);
  console.log('  ', JSON.stringify(manual, null, 2));
}

main().then(() => { cleanup(); process.exit(0); })
  .catch(e => { console.error('诊断失败:', e.message || e); cleanup(); process.exit(2); });

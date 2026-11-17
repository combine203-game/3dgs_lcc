/**
 * 诊断：捕获真实 GPU 的 createRenderPipeline desc，定位 VertexState 缺 slot 0
 * ----------------------------------------------------------------
 * 在页面里 monkey-patch `device.wgpu.createRenderPipeline`，把每次 pipeline 的
 * vertex.buffers 布局与对应 shader 的 attributes 打出来，就能直接看到
 * 「VertexState 里为什么没有 location 0」。
 *
 * 只在贴花实例存在期间记录，并按 pipeline 数量去重（贴花只应产生 1 个 pipeline）。
 *
 * 用法： node tools/diag_decal_pipeline.mjs [--headed] [--wait=20000]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 18149;
const CDP_PORT = 9275;
const BASE = `http://127.0.0.1:${PORT}`;
const WAIT = Number((process.argv.find(a => a.startsWith('--wait=')) || '').split('=')[1]) || 20000;
const HEADED = process.argv.includes('--headed');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)],
  { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'diagpipe_' + Date.now());
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
        return { __err: (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').slice(0, 400) };
      return r.result?.result?.value;
    } catch (err) { return { __err: String(err) }; }
  };

  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(WAIT);
  const DOC = `(()=>{const f=document.querySelector('iframe.gs-scene-frame[data-active="1"]')||document.querySelector('iframe.gs-scene-frame');return f?f.contentWindow:window;})()`;

  console.log('\n===== 打补丁：捕获 createRenderPipeline + uncapturederror =====');
  const patched = await E(`(()=>{const W=${DOC};
    const dev=W.__viewer?.app?.graphicsDevice;
    const wgpu=dev&&dev.wgpu;
    if(!wgpu)return {err:'no-wgpu'};
    wgpu.__errLog=[];
    wgpu.addEventListener('uncapturederror',(ev)=>{
      const e=ev&&ev.error;
      wgpu.__errLog.push({
        msg:String((e&&e.message)||e).replace(/\\s+/g,' ').slice(0,220),
        pipeCount:(wgpu.__pipeLog||[]).length,
        lastPipes:(wgpu.__pipeLog||[]).slice(-3)
      });
    });
    return {ok:true};})()`);
  console.log('  补丁 =', JSON.stringify(patched));

  const patched2 = await E(`(()=>{const W=${DOC};
    const dev=W.__viewer?.app?.graphicsDevice;
    const wgpu=dev&&dev.wgpu;
    if(!wgpu)return {err:'no-wgpu'};
    if(wgpu.__patched)return {already:true};
    wgpu.__pipeLog=[];
    const orig=wgpu.createRenderPipeline.bind(wgpu);
    wgpu.createRenderPipeline=function(desc){
      try{
        const v=desc&&desc.vertex;
        const attrs=(v&&v.buffers)||[];
        const flat=[];
        for(const b of attrs){for(const a of (b.attributes||[]))flat.push(a.shaderLocation);}
        /* 关键诊断：shader 里用了 location 0，但 VertexState 里没有 location 0 →
           Dawn 会报 "Vertex attribute slot 0 ... is not present in the VertexState"。
           这里把 shader 的入口点与 VertexState 的 location 列表一起记下来。 */
        const mod=v&&v.module;
        wgpu.__pipeLog.push({
          entryPoint:v&&v.entryPoint,
          bufferCount:attrs.length,
          locations:flat,
          formats:attrs.map(b=>(b.attributes||[]).map(a=>a.format+':L'+a.shaderLocation).join(',')),
          stepModes:attrs.map(b=>b.stepMode),
          strides:attrs.map(b=>b.arrayStride),
          hasLocation0:flat.indexOf(0)>=0,
          shaderLabel:mod&&mod.label||null,
          shaderKeys:mod?Object.keys(mod):null
        });
      }catch(e){ wgpu.__pipeLog.push({err:String(e)}); }
      return orig(desc);
    };
    wgpu.__patched=true;
    return {ok:true};})()`);
  console.log('  pipeline 补丁 =', JSON.stringify(patched2));

  await E(`(()=>{document.getElementById('gsEditorBtn')?.click();return 1})()`);
  await sleep(3000);

  console.log('\n===== 编辑器挂载后的 pipeline =====');
  const p0 = await E(`(()=>{const W=${DOC};return W.__viewer?.app?.graphicsDevice?.wgpu?.__pipeLog||[];})()`);
  console.log('  数量 =', p0.length);
  p0.slice(-4).forEach((p, i) => console.log('   ', i, JSON.stringify(p)));

  console.log('\n===== 注入真实路径贴花（visible=true，模拟探针路径）=====');
  const inj = await E(`(()=>{const W=${DOC},ed=W.__mgEditor;
    const list=ed.store.list();
    for(const a of list){if(a.kind==='decal'&&a.visible!==false)ed.store.update(a.id,{visible:false});}
    const tpl=list.find(a=>a.kind==='decal');if(!tpl)return 'no-template';
    const c=JSON.parse(JSON.stringify(tpl));
    c.id='pipe-decal-'+Date.now();c.visible=true;
    c.rect=[0.34,0.52,0.56,0.72];c.projector=null;c.surface=null;
    c.media=[{type:'video',url:'',caption:'投射演示画面'}];
    ed.store.add(c);return c.id;})()`);
  const ID = String(inj);
  console.log('  注入 =', ID);
  await E(`(()=>{const W=${DOC},ed=W.__mgEditor;ed.action('decal-rebuild','${ID}');return 1;})()`);
  await sleep(12000);

  const p1 = await E(`(()=>{const W=${DOC};return W.__viewer?.app?.graphicsDevice?.wgpu?.__pipeLog||[];})()`);
  console.log('  总数 =', p1.length, '（新增 ' + (p1.length - p0.length) + '）');
  p1.slice(p0.length).forEach((p, i) => console.log('   新增', i, JSON.stringify(p)));

  console.log('\n===== GPU 错误及其当时的 pipeline 上下文 =====');
  const errs = await E(`(()=>{const W=${DOC};return W.__viewer?.app?.graphicsDevice?.wgpu?.__errLog||[];})()`);
  console.log('  错误数 =', errs.length);
  errs.forEach((e, i) => {
    console.log('   [' + i + '] ' + e.msg);
    console.log('       当时 pipeline 数 =', e.pipeCount);
    (e.lastPipes || []).forEach((p, j) => console.log('         last[' + j + '] ' + JSON.stringify(p)));
  });

  console.log('\n===== 贴花 mesh 的 vertex format（对照）=====');
  const mf = await E(`(()=>{const W=${DOC},m=W.__mgEditor?.decalMgr;
    let inst=null;for(const i of m.instances.values()){inst=i;break;}
    if(!inst)return {err:'no-instance'};
    const mesh=inst.renderable.mesh||inst.renderable._mesh;
    const vb=mesh&&mesh.vertexBuffer;
    const fmt=vb&&vb.format;
    return {
      elements:fmt?fmt.elements.map(e=>({name:e.name,numComponents:e.numComponents,offset:e.offset})):null,
      interleaved:fmt?fmt.interleaved:null,
      renderingHashString:fmt?fmt.renderingHashString:null,
      vertexHash:vb?vb.format.renderingHash:null
    };})()`);
  console.log('  ', JSON.stringify(mf, null, 2));
}

main().then(() => { cleanup(); process.exit(0); })
  .catch(e => { console.error('诊断失败:', e.message || e); cleanup(); process.exit(2); });

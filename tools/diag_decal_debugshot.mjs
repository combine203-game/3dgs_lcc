/**
 * 诊断：真实路径下贴花到底有没有进渲染管线
 * ----------------------------------------------------------------
 * 报错发生在「投影机生成后」= 贴花第一次真正参与绘制时。需要在真机上分别抓：
 *   1. uDebugMode=2（失败分类着色）：红=盒外XY，绿=盒外Z，蓝=背面剔除，其余=正常
 *   2. uDebugMode=1（深度灰度）
 *   3. normal
 * 如果三张图完全一样且看不到贴花，说明 quad 根本没被画 —— 问题在 pipeline/顶点；
 * 如果能看到分类着色，说明 pipeline 正常，问题在盒内判定。
 *
 * 用法： node tools/diag_decal_debugshot.mjs [--headed] [--wait=20000]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 18147;
const CDP_PORT = 9273;
const BASE = `http://127.0.0.1:${PORT}`;
const WAIT = Number((process.argv.find(a => a.startsWith('--wait=')) || '').split('=')[1]) || 20000;
const HEADED = process.argv.includes('--headed');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)],
  { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'diagdbg_' + Date.now());
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
  await E(`(()=>{document.getElementById('gsEditorBtn')?.click();return 1})()`);
  await sleep(3000);

  // 注入真实路径贴花
  const inj = await E(`(()=>{const W=${DOC},ed=W.__mgEditor;
    const list=ed.store.list();
    for(const a of list){if(a.kind==='decal'&&a.visible!==false)ed.store.update(a.id,{visible:false});}
    const tpl=list.find(a=>a.kind==='decal');if(!tpl)return 'no-template';
    const c=JSON.parse(JSON.stringify(tpl));
    c.id='dbg-decal-'+Date.now();c.visible=true;
    c.rect=[0.34,0.52,0.56,0.72];c.projector=null;c.surface=null;
    c.media=[{type:'video',url:'',caption:'演示'}];
    ed.store.add(c);return c.id;})()`);
  const ID = String(inj);
  console.log('  注入 =', ID);
  await E(`(()=>{const W=${DOC},ed=W.__mgEditor;ed.action('decal-rebuild','${ID}');return 1;})()`);
  await sleep(6000);

  const dbg0 = await E(`(()=>{const W=${DOC},m=W.__mgEditor?.decalMgr;
    return m&&m.debug?m.debug():null;})()`);
  console.log('  诊断 =', JSON.stringify({
    degraded: dbg0?.degraded, gpuErrors: dbg0?.gpuErrors,
    instanceCount: dbg0?.instances?.length,
    inst: (dbg0?.instances || []).map(i => ({
      id: i.id, visible: i.visible, demoMode: i.demoMode, videoReady: i.videoReady,
      half: i.half, debugMode: i.debugMode, depthMode: i.depthMode
    }))
  }));

  async function shot(name) {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (!r.result?.data) return null;
    const buf = Buffer.from(r.result.data, 'base64');
    fs.writeFileSync(path.join(ROOT, 'tools', `diag-decal-${name}.png`), buf);
    return buf.length;
  }

  for (const mode of [0, 1, 2]) {
    await E(`(()=>{const W=${DOC},m=W.__mgEditor?.decalMgr;
      for(const i of m.instances.values()){i.debugMode=${mode};}
      return 1;})()`);
    await sleep(1500);
    const sz = await shot('mode' + mode);
    const d = await E(`(()=>{const W=${DOC},m=W.__mgEditor?.decalMgr;
      return {degraded:m.debug().degraded,gpuErrors:m.debug().gpuErrors};})()`);
    console.log('  debugMode=' + mode, ' 截图字节 =', sz, ' 诊断 =', JSON.stringify(d));
  }

  // 直接问引擎：这个 renderable 的 mesh vertex format 到底是什么
  console.log('\n===== renderable / mesh 详情 =====');
  const mi = await E(`(()=>{const W=${DOC},m=W.__mgEditor?.decalMgr;
    let inst=null;for(const i of m.instances.values()){inst=i;break;}
    if(!inst)return {err:'no-instance'};
    const r=inst.renderable;
    const mesh=r.mesh||r._mesh;
    const vb=mesh&&mesh.vertexBuffer;
    const fmt=vb&&vb.format;
    return {
      renderableKeys:Object.keys(r).slice(0,25),
      meshFound:!!mesh,
      numVertices:vb?vb.numVertices:null,
      elements:fmt?fmt.elements.map(e=>({name:e.name,numComponents:e.numComponents})):null,
      primitive:mesh&&mesh.primitive?mesh.primitive.map(p=>({type:p.type,count:p.count,indexed:p.indexed})):null,
      visible:r.visible,
      layer:r.layer?r.layer.name:null
    };})()`);
  console.log('  ', JSON.stringify(mi, null, 2));
}

main().then(() => { cleanup(); process.exit(0); })
  .catch(e => { console.error('诊断失败:', e.message || e); cleanup(); process.exit(2); });

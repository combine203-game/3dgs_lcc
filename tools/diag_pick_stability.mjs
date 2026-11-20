/**
 * 逐帧内部状态探针：贴花可见 + debugMode=1(纯深度灰度)时，
 * 到底哪个量在逐帧变化 → pick 纹理内容 / renders 计数 / 相机矩阵 / invViewProj。
 *
 * 每个采样点读：
 *   - pv.renders            : picker snapshot 重绘计数
 *   - pickHash / sampleVals : pick 深度纹理固定块的像素校验和(半精度原值)
 *   - projHash / viewHash   : 相机 projection/view 矩阵
 *   - invHash               : invViewProj
 *   - camPos                : 相机位置
 * 相机全程静止。若 pickHash 变 → 深度纹理在抖；若矩阵变 → 相机在抖。
 *
 * 用法： node tools/diag_pick_stability.mjs [--wait=20000] [--n=8] [--headed]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 18143, CDP_PORT = 9269;
const BASE = `http://127.0.0.1:${PORT}`;
const WAIT = Number((process.argv.find(a => a.startsWith('--wait=')) || '').split('=')[1]) || 20000;
const N = Number((process.argv.find(a => a.startsWith('--n=')) || '').split('=')[1]) || 8;
const HEADED = process.argv.includes('--headed');
const SEL_RECT = [0.34, 0.52, 0.56, 0.72];
const LOG = path.join(ROOT, 'tools', 'diag-pick-stability.log');
fs.writeFileSync(LOG, '');
const log = s => { console.log(s); fs.appendFileSync(LOG, s + '\n'); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'pickstab_' + Date.now());
fs.mkdirSync(profile, { recursive: true });
const br = spawn(CHROME, [
  ...(HEADED ? [] : ['--headless=new']),
  `--remote-debugging-port=${CDP_PORT}`, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--autoplay-policy=no-user-gesture-required',
  ...(HEADED ? ['--enable-unsafe-webgpu'] : ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader']),
  '--window-size=1280,800', 'about:blank'
], { stdio: 'ignore' });
function cleanup() { try { br.kill(); } catch {} try { srv.kill(); } catch {} try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} }
process.on('exit', cleanup); process.on('SIGINT', () => { cleanup(); process.exit(130); });

let ws, seq = 0; const pend = new Map(); const errors = [];
function send(method, params = {}) { return new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); }); }

async function main() {
  for (let i = 0; i < 80; i++) { try { await fetch(BASE + '/'); break; } catch { await sleep(250); } }
  let page = null;
  for (let i = 0; i < 80; i++) {
    try { const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); page = list.find(t => t.type === 'page'); if (page) break; } catch {}
    await sleep(300);
  }
  if (!page) throw new Error('CDP 不可达');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = e => {
    const o = JSON.parse(e.data);
    if (o.id && pend.has(o.id)) { pend.get(o.id)(o); pend.delete(o.id); return; }
    const txt = (o.params?.args || []).map(a => a.value ?? a.description ?? '').join(' ');
    if (o.method === 'Runtime.exceptionThrown') errors.push(o.params.exceptionDetails?.exception?.description || o.params.exceptionDetails?.text || '');
    else if (o.method === 'Runtime.consoleAPICalled' && o.params.type === 'error') errors.push(txt);
  };
  const E = async (expression, timeoutMs = 40000) => {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
      sleep(timeoutMs).then(() => ({ timeout: true }))
    ]);
    if (r.timeout) return { __timeout: true };
    if (r.result?.exceptionDetails) return { __err: (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').slice(0, 400) };
    return r.result?.result?.value;
  };
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(WAIT);

  const DOC = `(()=>{const f=document.querySelector('iframe.gs-scene-frame[data-active="1"]')||document.querySelector('iframe.gs-scene-frame');return f?f.contentWindow:window;})()`;
  log('后端 = ' + await E(`(()=>{const W=${DOC},gd=W.__viewer?.app?.graphicsDevice;return gd?(gd.isWebGPU||gd.deviceType==='webgpu'?'webgpu':'webgl2'):null;})()`));

  await E(`(()=>{document.getElementById('gsEditorBtn')?.click();return 1})()`);
  await sleep(3500);
  if (!await E(`(()=>!!(${DOC}).__mgEditor)()`)) throw new Error('编辑器未挂载');

  // 注入贴花并重建
  const id = await E(`(()=>{const W=${DOC},ed=W.__mgEditor;const list=ed.store.list();let tpl=list.find(a=>a.kind==='decal');
    if(!tpl)return 'no-template';
    const c=JSON.parse(JSON.stringify(tpl));c.id='stab-decal-'+Date.now();c.visible=false;
    c.rect=${JSON.stringify(SEL_RECT)};c.projector=null;c.surface=null;c.media=[{type:'video',url:'',caption:'demo'}];
    ed.store.add(c);return c.id;})()`);
  if (!/^stab-decal-/.test(String(id))) throw new Error('注入失败: ' + id);
  await E(`(()=>{const W=${DOC},ed=W.__mgEditor;ed.action('decal-rebuild','${id}');return 1;})()`);
  let proj = null;
  for (let i = 0; i < 50; i++) { const p = await E(`(()=>{const W=${DOC},ed=W.__mgEditor;const a=ed.store.get('${id}');return a&&a.projector?1:0;})()`); if (p) { proj = 1; break; } await sleep(400); }
  log('投影机生成 = ' + !!proj);
  await E(`(()=>{const W=${DOC},ed=W.__mgEditor;ed.store.update('${id}',{visible:true});return 1;})()`);
  await sleep(2500);
  await E(`(()=>{const W=${DOC},m=W.__mgEditor?.decalMgr;m.setOptions({debugMode:1});return 1;})()`);
  await sleep(800);

  // 先探查 picker 入口结构（一次性）
  const STRUCT = `(()=>{const W=${DOC},v=W.__viewer;
    const p=(typeof v.picker==='function')?v.picker():v.picker;
    const keys=(o)=>o?Object.getOwnPropertyNames(o).slice(0,40):null;
    const proto=(o)=>o?Object.getOwnPropertyNames(Object.getPrototypeOf(o)||{}).slice(0,40):null;
    return {
      viewerPickerType: typeof v.picker,
      pickerKeys: keys(p), pickerProto: proto(p),
      hasEnginePicker: !!(p&&p.enginePicker), enginePickerType: typeof (p&&p.enginePicker),
      engineKeys: (p&&p.enginePicker)?keys(p.enginePicker()):null,
      engineProto: (p&&p.enginePicker)?proto(p.enginePicker()):null,
      viewerKeys: keys(v).filter(k=>/pick|depth|picker/i.test(k)),
      hasMgEditor: !!W.__mgEditor,
      adapterKeys: W.__mgEditor?.decalMgr ? Object.keys(W.__mgEditor.decalMgr) : null
    };})()`;
  log('STRUCT = ' + JSON.stringify(await E(STRUCT)));

  const SAMPLE = `(async ()=>{
    const W = ${DOC};
    const v = W.__viewer, app = v.app;
    const picker = (typeof v.picker==='function') ? v.picker() : v.picker;
    let ep = null;
    if (picker && typeof picker.enginePicker==='function') ep = picker.enginePicker();
    if (!ep && picker && typeof picker.renderView==='function') ep = picker;
    if (!ep) return {err:'no-ep'};
    const pv = ep.renderView();
    if (!pv || !pv.texture) return {err:'no-pv'};
    const tex = pv.texture, Wt=tex.width, Ht=tex.height;
    const h2 = (arr)=>{ let h=2166136261>>>0; for(let i=0;i<arr.length;i++){ h^=(arr[i]|0); h=Math.imul(h,16777619)>>>0; } return h>>>0; };
    let pickHash=null, sampleVals=null, readErr=null;
    try {
      const x=Math.max(0,Math.min(Wt-4,Math.floor(0.45*Wt)));
      const y=Math.max(0,Math.min(Ht-4,Math.floor(0.60*Ht)));
      let buf=null;
      try { buf=await tex.read(x,y,4,4,{immediate:true}); }catch(e){}
      if(!buf||!buf.length){ try{ buf=await tex.read(x,y,4,4); }catch(e){ readErr=String(e&&e.message||e); } }
      if(buf&&buf.length){ pickHash=h2(buf); sampleVals=Array.from(buf.slice(0,8)); }
    } catch(e){ readErr=String(e&&e.message||e); }
    const cam=app.root.findComponent('camera');
    const proj=cam.projectionMatrix.data, view=cam.viewMatrix.data;
    let invHash=null;
    try { const P=new W.__pc.Mat4().mul2(cam.projectionMatrix,cam.viewMatrix).invert(); invHash=h2(P.data); }catch(e){}
    const p=cam.entity.getPosition();
    return {
      renders: pv.renders,
      pickSize:[Wt,Ht], pickHash, sampleVals, readErr,
      projHash:h2(proj), viewHash:h2(view), invHash,
      projE:[proj[0],proj[5],proj[8],proj[9],proj[10],proj[14]].map(x=>+x.toFixed(6)),
      camPos:[+p.x.toFixed(5),+p.y.toFixed(5),+p.z.toFixed(5)]
    };
  })()`;

  log('\n===== 连续 ' + N + ' 次采样（相机全程静止，贴花可见，debugMode=1）=====');
  const samples = [];
  for (let i = 0; i < N; i++) {
    const s = await E(SAMPLE);
    samples.push(s);
    log(`#${i} ` + JSON.stringify(s));
    await sleep(220);
  }

  const uniq = k => [...new Set(samples.map(s => s[k]))].length;
  log('\n===== 变化统计（唯一值个数，>1 即在变）=====');
  log(JSON.stringify({
    renders: uniq('renders'),
    pickHash: uniq('pickHash'),
    sampleVals: uniq('sampleVals' in samples[0] ? 'sampleVals' : 'pickHash'),
    projHash: uniq('projHash'),
    viewHash: uniq('viewHash'),
    invHash: uniq('invHash'),
    camPos: uniq('camPos')
  }, null, 2));
  log('renders 序列 = ' + samples.map(s => s.renders).join(','));
  log('pickHash 序列 = ' + samples.map(s => s.pickHash).join(','));
  log('invHash 序列 = ' + samples.map(s => s.invHash).join(','));
  log('\nJS 错误数 = ' + errors.length + ' ' + JSON.stringify(errors.slice(0, 3)));
  ws.close();
}
main().catch(e => { log('FAIL ' + (e && e.stack || e)); process.exitCode = 1; });

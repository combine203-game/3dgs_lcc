/**
 * 诊断：贴花覆盖率对关键参数（Y 翻转 / 深度口径 / 盒基准）的敏感性
 * ----------------------------------------------------------------
 * 现象：真实路径贴花覆盖率只有 ~0.24，debugMode=2 显示绝大多数像素被判为
 * 「盒外XY」—— 说明 GPU 侧重建的世界点与 CPU 深度反算得到的 OBB 不匹配。
 * OBB 本身已验证正确（49/49 采样点全在盒内），所以问题在重建这一步。
 *
 * 本脚本在真机上逐个切换可疑参数，每档都做一次「可见/隐藏」像素差分，
 * 直接对比覆盖率：
 *   flipY   = 0 / 1        pick 纹理的 Y 行序
 *   depthMode = 0 / 1      单 texel 中位 / 引擎同族 5×5 分位
 *   boxScale = 1.0 / 0.5   整框命中 / 仅内侧 1/4
 *
 * 用法： node tools/diag_decal_sweep.mjs [--headed] [--wait=25000]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { decodePng } from './png-decode.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 18155;
const CDP_PORT = 9281;
const BASE = `http://127.0.0.1:${PORT}`;
const WAIT = Number((process.argv.find(a => a.startsWith('--wait=')) || '').split('=')[1]) || 20000;
const HEADED = process.argv.includes('--headed');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)],
  { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'diagsweep_' + Date.now());
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

  const inj = await E(`(()=>{const W=${DOC},ed=W.__mgEditor;
    const list=ed.store.list();
    for(const a of list){if(a.kind==='decal'&&a.visible!==false)ed.store.update(a.id,{visible:false});}
    const tpl=list.find(a=>a.kind==='decal');if(!tpl)return 'no-template';
    const c=JSON.parse(JSON.stringify(tpl));
    c.id='sweep-decal-'+Date.now();c.visible=false;
    c.rect=[0.34,0.52,0.56,0.72];c.projector=null;c.surface=null;
    c.media=[{type:'video',url:'',caption:'演示'}];
    ed.store.add(c);return c.id;})()`);
  const ID = String(inj);
  await E(`(()=>{const W=${DOC},ed=W.__mgEditor;ed.action('decal-rebuild','${ID}');return 1;})()`);
  await sleep(8000);
  await E(`(()=>{const W=${DOC},ed=W.__mgEditor;ed.store.update('${ID}',{visible:true});return 1;})()`);
  await sleep(3000);

  /* 全画布区域做差分：不用 OBB 矩形当分母 —— 先看「整幅画面里有多少像素
     因贴花而改变」，这个数字与参数口径无关，最能说明问题。 */
  async function measure(label) {
    const v = await E(`(()=>{const W=${DOC};
      const cv=W.document.querySelector('#mg-stage canvas');
      const r=cv.getBoundingClientRect();
      return {x:r.x,y:r.y,w:r.width,h:r.height,vw:window.innerWidth};})()`);
    const a = await send('Page.captureScreenshot', { format: 'png' });
    await E(`(()=>{const W=${DOC},ed=W.__mgEditor;ed.store.update('${ID}',{visible:false});return 1;})()`);
    await sleep(1500);
    const b = await send('Page.captureScreenshot', { format: 'png' });
    await E(`(()=>{const W=${DOC},ed=W.__mgEditor;ed.store.update('${ID}',{visible:true});return 1;})()`);
    await sleep(1200);
    if (!a.result?.data || !b.result?.data) return null;
    const A = decodePng(Buffer.from(a.result.data, 'base64'));
    const B = decodePng(Buffer.from(b.result.data, 'base64'));
    const W = Math.min(A.width, B.width), H = Math.min(A.height, B.height);
    let changed = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const d = Math.max(
          Math.abs(A.data[i] - B.data[i]),
          Math.abs(A.data[i + 1] - B.data[i + 1]),
          Math.abs(A.data[i + 2] - B.data[i + 2]));
        if (d > 12) changed++;
      }
    }
    return { changed, total: W * H, ratio: changed / (W * H), size: W + 'x' + H };
  }

  async function setParams(o) {
    return E(`(()=>{const W=${DOC},m=W.__mgEditor?.decalMgr;
      for(const i of m.instances.values()){
        ${o.flipY !== undefined ? `i.pickFlipY=${o.flipY};` : ''}
        ${o.depthMode !== undefined ? `i.depthMode=${o.depthMode};` : ''}
        ${o.boxScale !== undefined ? `i.boxScale=${o.boxScale};` : ''}
        ${o.debugMode !== undefined ? `i.debugMode=${o.debugMode};` : ''}
      }
      return 1;})()`);
  }

  console.log('\n===== 参数敏感性扫描（全画面变化像素占比）=====');
  const rows = [];
  const cases = [
    { label: '基线 flipY=1 depth=1 box=1.0', flipY: 1, depthMode: 1, boxScale: 1.0 },
    { label: 'flipY=0 depth=1 box=1.0', flipY: 0, depthMode: 1, boxScale: 1.0 },
    { label: 'flipY=1 depth=0 box=1.0', flipY: 1, depthMode: 0, boxScale: 1.0 },
    { label: 'flipY=0 depth=0 box=1.0', flipY: 0, depthMode: 0, boxScale: 1.0 },
    { label: 'flipY=1 depth=1 box=0.5', flipY: 1, depthMode: 1, boxScale: 0.5 }
  ];
  for (const c of cases) {
    await setParams(c);
    await sleep(2500);
    const m = await measure(c.label);
    if (!m) { console.log('  ' + c.label + ' → 截图失败'); continue; }
    console.log('  ' + c.label.padEnd(30) + ' 变化像素 =', String(m.changed).padStart(8),
      ' 占全画面 =', (m.ratio * 100).toFixed(2) + '%');
    rows.push({ ...c, ...m });
  }
  console.log('\n  最佳档位 =', rows.slice().sort((a, b) => b.changed - a.changed)[0].label);
}

main().then(() => { cleanup(); process.exit(0); })
  .catch(e => { console.error('诊断失败:', e.message || e); cleanup(); process.exit(2); });

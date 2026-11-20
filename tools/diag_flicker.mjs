/**
 * 整屏闪烁定位诊断（相机静止）
 * ----------------------------------------------------------------
 * 用户现象：框选一楼室内墙面后，相机基本静止，整个画面（不止贴花）疯狂闪烁。
 *
 * 本探针用同一相机、同一场景，连续抓多帧画布，量「帧间整屏像素差」：
 *   A. 无贴花（基线）：应为 0（静态 stochastic + TAA 会收敛）
 *   B. 贴花可见
 *   C. 贴花藏起来但 decalMgr 仍在跑帧钩子（requestRender 无限循环）
 *   D. 销毁 decalMgr（移除全部帧钩子）后
 * 若 B/C 高而 A/D 低 → 闪烁由 decalMgr 的每帧循环/pick pass 造成。
 *
 * 用法： node tools/diag_flicker.mjs [--frames=6] [--wait=20000] [--headed]
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
const PORT = 18141, CDP_PORT = 9267;
const BASE = `http://127.0.0.1:${PORT}`;
const WAIT = Number((process.argv.find(a => a.startsWith('--wait=')) || '').split('=')[1]) || 20000;
const FRAMES = Number((process.argv.find(a => a.startsWith('--frames=')) || '').split('=')[1]) || 6;
const HEADED = process.argv.includes('--headed');
const SEL_RECT = [0.34, 0.52, 0.56, 0.72];
const sleep = ms => new Promise(r => setTimeout(r, ms));

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'flicker_' + Date.now());
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
  const backend = await E(`(()=>{const W=${DOC},gd=W.__viewer?.app?.graphicsDevice;return gd?(gd.isWebGPU||gd.deviceType==='webgpu'?'webgpu':'webgl2'):null;})()`);
  console.log('后端 =', backend);

  // 进入编辑态
  await E(`(()=>{document.getElementById('gsEditorBtn')?.click();return 1})()`);
  await sleep(3500);
  if (!await E(`(()=>!!(${DOC}).__mgEditor)()`)) throw new Error('编辑器未挂载');

  // 隐藏 overlay，避免 DOM 动画干扰像素差
  const hideDom = `(()=>{const W=${DOC},d=W.document;const sel='.ed-layer,.ed-ui,.ed-guides,.ed-marquee,#mg-loading,#mg-error,#mg-bar,#mg-helpbox,#mg-toolsbox,.sse-controlsWrap,.sse-controlsHint,.sse-infoPanel,.sse-joystick,.sse-panel';W.__hidden=d.querySelectorAll(sel);W.__hidden.forEach(e=>{e.dataset.__oldVis=e.style.visibility;e.style.visibility='hidden';});return 1;})()`;
  await E(hideDom);

  // 画布矩形
  const cv = await E(`(()=>{const W=${DOC};const cv=W.document.querySelector('#mg-stage canvas');if(!cv)return null;const r=cv.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,vw:window.innerWidth};})()`);
  if (!cv) throw new Error('无画布');
  const scale = cv.vw ? 1280 / cv.vw : 1;

  async function grab() {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (!r.result?.data) return null;
    const img = decodePng(Buffer.from(r.result.data, 'base64'));
    // 裁到画布内部一个稳定中心区（避开边缘），减少无关变化
    const x = Math.round(cv.x * scale), y = Math.round(cv.y * scale);
    const w = Math.round(cv.w * scale), h = Math.round(cv.h * scale);
    let out = Buffer.alloc(0); let ow = 0, oh = 0;
    const X = Math.max(0, Math.min(img.width - 2, x)), Y = Math.max(0, Math.min(img.height - 2, y));
    const W = Math.max(1, Math.min(img.width - X, w)), H = Math.max(1, Math.min(img.height - Y, h));
    ow = W; oh = H; out = Buffer.alloc(W * H * 4);
    for (let rr = 0; rr < H; rr++) img.data.copy(out, rr * W * 4, ((Y + rr) * img.width + X) * 4, ((Y + rr) * img.width + X + W) * 4);
    return { data: out, w: ow, h: oh };
  }
  function frameDiff(a, b) {
    if (!a || !b || a.w !== b.w || a.h !== b.h) return null;
    let sum = 0, changed = 0, n = a.w * a.h;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const d = Math.abs(a.data[o] - b.data[o]) + Math.abs(a.data[o + 1] - b.data[o + 1]) + Math.abs(a.data[o + 2] - b.data[o + 2]);
      sum += d; if (d > 24) changed++;
    }
    return { mad: sum / n, changedPct: changed / n * 100 };
  }
  let savePair = false;
  async function burst(label) {
    const shots = [];
    for (let i = 0; i < FRAMES; i++) { shots.push(await grab()); await sleep(180); }
    if (savePair && shots[0] && shots[1]) {
      fs.writeFileSync(path.join(ROOT, 'tools', `flicker-${label}-f0.png`), encodePng(shots[0].data, shots[0].w, shots[0].h));
      fs.writeFileSync(path.join(ROOT, 'tools', `flicker-${label}-f1.png`), encodePng(shots[1].data, shots[1].w, shots[1].h));
    }
    const diffs = [];
    for (let i = 1; i < shots.length; i++) diffs.push(frameDiff(shots[i - 1], shots[i]));
    const ds = diffs.filter(Boolean);
    const avgMad = ds.reduce((s, d) => s + d.mad, 0) / (ds.length || 1);
    const avgChanged = ds.reduce((s, d) => s + d.changedPct, 0) / (ds.length || 1);
    console.log(`  [${label}] 帧间差: MAD=${avgMad.toFixed(2)} 变化像素=${avgChanged.toFixed(2)}%  (每对: ${ds.map(d => d.mad.toFixed(1)).join(', ')})`);
    if (shots[0]) fs.writeFileSync(path.join(ROOT, 'tools', `flicker-${label}.png`), (() => {
      // 保存首帧（简单重编码）
      const { data, w, h } = shots[0]; return encodePng(data, w, h);
    })());
    return { avgMad, avgChanged };
  }

  const crcTable = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; } return t; })();
  const crc32 = buf => { let c = -1; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return c ^ -1; };
  function encodePng(rgba, width, height) {
    const raw = Buffer.alloc(height * (width * 4 + 1));
    for (let y = 0; y < height; y++) { raw[y * (width * 4 + 1)] = 0; rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4); }
    const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const out = Buffer.alloc(4); out.writeUInt32BE(crc32(td) >>> 0); return Buffer.concat([len, td, out]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  }

  console.log('\n===== A. 无贴花基线（相机静止）=====');
  await sleep(1200);
  const base = await burst('base');

  console.log('\n===== B. 注入贴花并重建投影机 =====');
  const id = await E(`(()=>{const W=${DOC},ed=W.__mgEditor;const list=ed.store.list();let tpl=list.find(a=>a.kind==='decal');
    if(!tpl)return 'no-template';
    const c=JSON.parse(JSON.stringify(tpl));c.id='flicker-decal-'+Date.now();c.visible=false;
    c.rect=${JSON.stringify(SEL_RECT)};c.projector=null;c.surface=null;c.media=[{type:'video',url:'',caption:'demo'}];
    ed.store.add(c);return c.id;})()`);
  if (!/^flicker-decal-/.test(String(id))) throw new Error('注入失败: ' + id);
  await E(`(()=>{const W=${DOC},ed=W.__mgEditor;ed.action('decal-rebuild','${id}');return 1;})()`);
  let proj = null;
  for (let i = 0; i < 50; i++) { const p = await E(`(()=>{const W=${DOC},ed=W.__mgEditor;const a=ed.store.get('${id}');return a&&a.projector?1:0;})()`); if (p) { proj = 1; break; } await sleep(400); }
  console.log('  投影机生成 =', !!proj);
  if (!proj) {
    const st = await E(`(()=>{const W=${DOC},el=W.document.querySelector('[data-role="status"]');return el?el.textContent:'(无状态栏)';})()`);
    console.log('  状态栏 =', st);
  }
  await E(`(()=>{const W=${DOC},ed=W.__mgEditor;ed.store.update('${id}',{visible:true});return 1;})()`);
  await sleep(2500);
  let dbg = await E(`(()=>{const W=${DOC},m=W.__mgEditor?.decalMgr;return m&&m.debug?m.debug():null;})()`);
  console.log('  decalMgr.debug =', JSON.stringify({ degraded: dbg?.degraded, gpuErrors: dbg?.gpuErrors, scopedErrors: dbg?.scopedErrors, pickReady: dbg?.pickReady, pickSize: dbg?.pickSize, instances: dbg?.instances?.length }));
  savePair = true;
  const active = await burst('active');

  console.log('\n===== B2. debugMode=1（直接改 inst，真正生效；shader 只输出深度灰度）=====');
  await E(`(()=>{const W=${DOC},m=W.__mgEditor?.decalMgr;m.instances.forEach(i=>i.debugMode=1);return 1;})()`);
  await sleep(800);
  const depthOnly = await burst('depthonly');
  savePair = false;

  console.log('\n===== B3. 冻结视频内容（debugMode=0，但把 drawDemoFrame 时间钉死）=====');
  await E(`(()=>{const W=${DOC},m=W.__mgEditor?.decalMgr;m.instances.forEach(i=>i.debugMode=0);W.__frozenNow=performance.now();const _p=performance.now.bind(performance);performance.now=()=>W.__frozenNow;return 1;})()`);
  await sleep(800);
  const frozenVideo = await burst('frozenvideo');
  await E(`(()=>{const W=${DOC};if(W.__origNow)performance.now=W.__origNow;return 1;})()`);
  await sleep(300);
  console.log('  （注：performance.now 冻结不可回滚时以 debugMode 恢复为准）');

  console.log('\n===== C. 贴花藏起来（管理器仍在跑帧钩子）=====');
  await E(`(()=>{const W=${DOC},ed=W.__mgEditor;ed.store.update('${id}',{visible:false});return 1;})()`);
  await sleep(1200);
  const hidden = await burst('hidden');

  console.log('\n===== D. 销毁 decalMgr（移除全部帧钩子）=====');
  await E(`(()=>{const W=${DOC},m=W.__mgEditor?.decalMgr;if(m&&m.destroy)m.destroy();return 1;})()`);
  await sleep(1500);
  const destroyed = await burst('destroyed');

  console.log('\n===== 结论数据 =====');
  console.log(JSON.stringify({ base, active, depthOnly, frozenVideo, hidden, destroyed }, null, 2));
  console.log('\nJS 错误数 =', errors.length, errors.slice(0, 3));
  ws.close();
}
main().catch(e => { console.error('FAIL', e); process.exitCode = 1; });

/**
 * 快探针：确认顶层 ?content= 是否透传进了场景 iframe。
 *
 * 背景：app.js 读的是 iframe 自己的 location.search，而 iframe 地址原本只带
 * scene/spawn。不透传时「换资产」会静默失效 —— 两份截图完全相同，误以为是
 * 渲染没差别。这个脚本 5 秒内给出答案，不必等 SOG 加载完。
 *
 * 用法：node tools/probe_iframe_src.mjs [--content=./sog/xxx.sog]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 18202, CDP_PORT = 9283, BASE = `http://127.0.0.1:${PORT}`;
const hit = process.argv.find(a => a.startsWith('--content='));
const CONTENT = hit ? hit.slice('--content='.length) : './sog/mm_floor1.sog';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)],
  { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'probe_' + Date.now());
fs.mkdirSync(profile, { recursive: true });
const br = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`,
  '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
  '--window-size=1200,800', 'about:blank'], { stdio: 'ignore' });

let ws, seq = 0; const pend = new Map();
const send = (method, params = {}) => new Promise(res => {
  const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params }));
});
const E = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value ?? r.result?.exceptionDetails?.text ?? null;
};

try {
  for (let i = 0; i < 60; i++) { try { await fetch(BASE + '/'); break; } catch { await sleep(200); } }
  let page = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      page = list.find(t => t.type === 'page'); if (page) break;
    } catch { /* retry */ }
    await sleep(250);
  }
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => {
    const o = JSON.parse(e.data);
    if (o.id && pend.has(o.id)) { pend.get(o.id)(o); pend.delete(o.id); }
  };
  await send('Runtime.enable'); await send('Page.enable');
  const url = `${BASE}/?scene=floor1&content=${encodeURIComponent(CONTENT)}`;
  await send('Page.navigate', { url });
  await sleep(4000);
  const info = await E(`(()=>{const f=document.querySelector('iframe.gs-scene-frame');
    return {top:location.search, frameSrc:f?f.src:null};})()`);
  console.log('顶层       :', decodeURIComponent(info?.top || ''));
  console.log('iframe.src :', info?.frameSrc ? decodeURIComponent(info.frameSrc) : '(未创建)');
  const ok = !!(info?.frameSrc && decodeURIComponent(info.frameSrc).includes(CONTENT));
  console.log(ok ? 'PASS  content 已透传进 iframe' : 'FAIL  content 未透传（换资产会静默失效）');
  if (!ok) process.exitCode = 1;
} finally {
  try { br.kill(); } catch { /* noop */ }
  try { srv.kill(); } catch { /* noop */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* noop */ }
  try { ws?.close(); } catch { /* noop */ }
}

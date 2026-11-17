/**
 * R4 预检 2：真实页面下探测 WebGPU（含 SystemInfo 特性状态）。
 * 用法：node tools/r4_probe2.mjs [--headless-sw] [--headed]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP = 9250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HEADLESS_SW = process.argv.includes('--headless-sw');
const profile = path.join(ROOT, '.verify-profile', 'r4probe2_' + Date.now());
fs.mkdirSync(profile, { recursive: true });

const args = [`--remote-debugging-port=${CDP}`, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--ignore-gpu-blocklist', '--enable-unsafe-webgpu',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  '--window-size=1600,900'];
if (HEADLESS_SW) args.push('--headless=new', '--use-webgpu-adapter=swiftshader');
args.push('http://127.0.0.1:8095/gs-viewer.html');

const br = spawn(CHROME, args, { stdio: 'ignore' });
console.log('pid=', br.pid, 'headless-sw=', HEADLESS_SW);

try {
  let page = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
      page = list.find((t) => t.type === 'page' && /127\.0\.0\.1/.test(t.url || '')) || list.find((t) => t.type === 'page');
      if (page) break;
    } catch { /* retry */ }
    await sleep(300);
  }
  if (!page) throw new Error('CDP 不可达');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pend = new Map();
  ws.onmessage = (e) => { const o = JSON.parse(e.data); if (o.id && pend.has(o.id)) { pend.get(o.id)(o); pend.delete(o.id); } };
  const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  await sleep(2500);
  const r = await send('Runtime.evaluate', {
    expression: `(async()=>{const out={loc:location.href,secure:isSecureContext,hasGpu:!!navigator.gpu};
      try{const gl=document.createElement('canvas').getContext('webgl2');const ext=gl&&gl.getExtension('WEBGL_debug_renderer_info');out.gl=gl?gl.getParameter(ext?ext.UNMASKED_RENDERER_WEBGL:gl.RENDERER):null;}catch(e){out.gl='ERR '+e.message}
      if(navigator.gpu){try{const a=await navigator.gpu.requestAdapter();out.adapter=a?a.info:{}}catch(e){out.err=String(e)}}
      return out;})()`, returnByValue: true, awaitPromise: true,
  });
  console.log(JSON.stringify(r.result?.result?.value, null, 2));
  ws.close();

  const ver = await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json();
  console.log('browser:', ver.Browser);
} catch (e) {
  console.error('probe2 failed:', e.message);
} finally {
  try { br.kill(); } catch { /* noop */ }
  await sleep(800);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* noop */ }
}

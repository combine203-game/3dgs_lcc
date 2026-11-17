/**
 * R4 预检：确认系统 Chrome 有头模式能起 CDP、WebGPU 是否可用。
 * 只读探测，不改业务代码。端口固定 9250。
 *
 * 用法：node tools/r4_probe.mjs [--headless]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP = 9250;
const HEADLESS = process.argv.includes('--headless');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = path.join(ROOT, '.verify-profile', 'r4probe_' + Date.now());
fs.mkdirSync(profile, { recursive: true });
const args = [
  `--remote-debugging-port=${CDP}`, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--ignore-gpu-blocklist', '--enable-unsafe-webgpu',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  '--window-size=1600,900',
];
if (HEADLESS) args.push('--headless=new', '--use-gl=swiftshader', '--enable-unsafe-swiftshader');
args.push('about:blank');

const br = spawn(CHROME, args, { stdio: 'ignore' });
console.log('chrome pid =', br.pid, 'mode =', HEADLESS ? 'headless' : 'headed');

let ws;
try {
  let page = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
      page = list.find((t) => t.type === 'page');
      if (page) break;
    } catch { /* retry */ }
    await sleep(300);
  }
  if (!page) throw new Error('CDP 不可达');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const pend = new Map();
  ws.onmessage = (e) => {
    const o = JSON.parse(e.data);
    if (o.id && pend.has(o.id)) { pend.get(o.id)(o); pend.delete(o.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params }));
  });
  const r = await send('Runtime.evaluate', {
    expression: `(async()=>{
      const out={ua:navigator.userAgent, hasGpu:!!navigator.gpu, adapter:null, err:null, gl:null};
      try{const gl=document.createElement('canvas').getContext('webgl2');out.gl=gl?gl.getParameter(gl.RENDERER):null;}catch(e){out.gl='ERR '+e.message}
      if(navigator.gpu){try{const a=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});out.adapter=a?{vendor:a.info?.vendor,arch:a.info?.architecture,desc:a.info?.description,fallback:a.info?.isFallbackAdapter}:null;}catch(e){out.err=String(e)}}
      return out;})()`,
    returnByValue: true, awaitPromise: true,
  });
  console.log(JSON.stringify(r.result?.result?.value, null, 2));
} catch (e) {
  console.error('probe failed:', e.message);
} finally {
  try { ws?.close(); } catch { /* noop */ }
  try { br.kill(); } catch { /* noop */ }
  await sleep(800);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* noop */ }
}

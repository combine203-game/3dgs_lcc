/**
 * 资产 A/B 截图对比：在同一机位、同一后端下渲染两份 SOG，产出 PNG 供像素统计。
 *
 * 用途：验证不同资产处理策略的观感差异（例如 sog_clamp_scales.py 的码表钳制
 * 与原始 LOD0 谁更接近原貌）。注意：仓库只随包附带原始 SOG
 * （./sog/mm_floor1.sog / ./sog/mm_floor3.sog），*_clean.sog 与 *_clamp.sog
 * 需自行生成后再对比，因此本脚本必须用 --targets 显式给出两份资产。
 *
 * 机位取 scene-meta.json 的 spawnPoints.floor1（用户标定的「蓝色大屏 / 接待台」）。
 *
 * 用法：
 *   node tools/compare_sog_assets.mjs --targets=orig:./sog/mm_floor1.sog,clamp:./sog/mm_floor1_clamp.sog
 *   可选：--settle=15000  --headed
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 18201;
const CDP_PORT = 9282;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(ROOT, 'tools', 'shots');
const arg = (k, d) => {
  const hit = process.argv.find(a => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : d;
};
const SETTLE = Number(arg('settle', '15000'));
const HEADED = process.argv.includes('--headed');
const TARGETS_ARG = arg('targets', '');
if (!TARGETS_ARG) {
  console.error('缺少 --targets：仓库只附带原始 SOG，请显式指定两份待对比资产，\n'
    + '例如 --targets=orig:./sog/mm_floor1.sog,clamp:./sog/mm_floor1_clamp.sog');
  process.exit(2);
}
const TARGETS = TARGETS_ARG
  .split(',').map(s => {
    const i = s.indexOf(':');
    return { name: s.slice(0, i), url: s.slice(i + 1) };
  });

const POSE = 'scene=floor1';
// 用户标定的「波浪墙 / 蓝色大屏 / RECEPTION」机位（world 坐标）
const POSE_POS = [18.502470, 1.894326, 17.075218];
const POSE_LOOK = [17.583208, 1.892035, 17.468858];
const POSE_FOV = 75;
/* 3DGS 场景跑在 iframe 里：__viewer / __mgEmbed 都挂在 iframe 的 window 上，
   在顶层 window 上探测永远是 undefined（会把"已就绪"误判成"没起来"）。 */
const DOC = `(()=>{const f=document.querySelector('iframe.gs-scene-frame[data-active="1"]')
  ||document.querySelector('iframe.gs-scene-frame');return f?f.contentWindow:window;})()`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)],
  { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'ab_' + Date.now());
fs.mkdirSync(profile, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const br = spawn(CHROME, [
  ...(HEADED ? [] : ['--headless=new']),
  `--remote-debugging-port=${CDP_PORT}`, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader',
  '--window-size=1280,800', 'about:blank'
], { stdio: 'ignore' });

function cleanup() {
  try { br.kill(); } catch { /* noop */ }
  try { srv.kill(); } catch { /* noop */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* noop */ }
}

let ws, seq = 0;
const pend = new Map();
const errors = [];

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
    if (o.id && pend.has(o.id)) { pend.get(o.id)(o); pend.delete(o.id); return; }
    if (o.method === 'Runtime.exceptionThrown')
      errors.push(o.params.exceptionDetails?.exception?.description || o.params.exceptionDetails?.text || '');
  };
  const send = (method, params = {}) => new Promise(res => {
    const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params }));
  });
  const E = async (expression, timeoutMs = 30000) => {
    try {
      const r = await Promise.race([
        send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
        sleep(timeoutMs).then(() => ({ timeout: true }))
      ]);
      if (r.timeout) return { __timeout: true };
      if (r.result?.exceptionDetails)
        return { __err: (r.result.exceptionDetails.exception?.description || '').slice(0, 300) };
      return r.result?.result?.value;
    } catch (err) { return { __err: String(err) }; }
  };

  await send('Runtime.enable'); await send('Page.enable');

  const rows = [];
  for (const t of TARGETS) {
    const url = `${BASE}/?${POSE}&content=${encodeURIComponent(t.url)}`;
    console.log(`\n===== ${t.name} =====\n  ${url}`);
    await send('Page.navigate', { url });
    await sleep(2500);

    // 等资产真正上屏：loading 隐藏 + graphicsDevice 就绪 + 已渲染出高斯
    let ready = null;
    for (let i = 0; i < 150; i++) {
      ready = await E(`(()=>{const W=${DOC};const l=document.getElementById('mg-loading');
        const v=W.__viewer, gd=v&&v.app&&v.app.graphicsDevice;
        const n=v&&v.app&&v.app.stats&&v.app.stats.frame&&v.app.stats.frame.gsplats;
        return {hidden:!!(l&&l.hidden),dev:!!gd,gsplats:n||0,
          url:(v&&v.contentUrl)||'', badge:(document.getElementById('mg-gpu')||{}).textContent||''};})()`);
      if (ready && ready.hidden && ready.dev && ready.gsplats > 0) break;
      await sleep(2000);
    }
    console.log('  就绪 =', JSON.stringify(ready));
    // 显式落到用户标定的机位（?pos=/?look= 在场景 iframe 里不生效）
    if (ready && ready.dev) {
      const posed = await E(`(()=>{const W=${DOC};
        try{ W.__mgEmbed?.setCameraPose?.(${JSON.stringify(POSE_POS)},${JSON.stringify(POSE_LOOK)},${POSE_FOV});
          return 'ok'; }catch(e){ return String(e&&e.message||e); } })()`);
      console.log('  机位 =', JSON.stringify(posed));
    }
    await sleep(SETTLE);                        // 让排序 / LOD / 首帧稳定下来

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const b64 = shot?.result?.data;
    const file = path.join(OUT, t.name + '.png');
    if (!b64) { console.log('  截图失败'); rows.push({ name: t.name, ok: false }); continue; }
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    console.log('  截图 ->', file, Math.round(fs.statSync(file).size / 1024) + ' KB');
    rows.push({ name: t.name, ok: true, file, gsplats: ready?.gsplats || 0, badge: ready?.badge || '' });
  }

  fs.writeFileSync(path.join(OUT, 'index.json'),
    JSON.stringify({ pose: POSE, targets: rows, errors: errors.slice(0, 5) }, null, 2));
  console.log('\n完成，共 ' + rows.filter(r => r.ok).length + ' 张；索引 tools/shots/index.json');
}

main()
  .catch(e => { console.error('对比失败:', e?.stack || e); process.exitCode = 1; })
  .finally(async () => { await sleep(400); cleanup(); try { ws?.close(); } catch { /* noop */ } });

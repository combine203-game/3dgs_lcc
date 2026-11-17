#!/usr/bin/env node
/**
 * MotionBricks 动作驱动自检（系统 Chrome + CDP，无 playwright）
 *
 * 覆盖 docs/CONTRACT.md §3 / §6 + DECISIONS D3（SOMA 单 .onnx）：
 *   1. __test.ready === true
 *   2. stats.backend 为 'webgpu'（有头）或 'wasm'（headless），并记录是哪一种
 *   3. stats.modelReady === true（模型真加载）
 *   4. 切 walk 后 8 s 内 stats.genMs > 0，且 hips 世界位移 > 0.05 m
 *   5. walk → run → stand 各 2 s：无异常、骨骼不回 T-pose（记录 hips 高度波动）
 *   6. 截图 shots/motion_soma.png
 *
 * 用法（工程根目录）：
 *   node tools/check_motion.mjs --headed          # 有头：验 WebGPU 主路径
 *   node tools/check_motion.mjs                   # headless：只能验 wasm 回退
 *   node tools/check_motion.mjs --backend wasm    # 强制 wasm
 *   node tools/check_motion.mjs --model ./model/mmm_v6_soma_fp16.onnx
 *   node tools/check_motion.mjs --wait 600 --keep # 加载等待上限 / 保留 profile
 *
 * 退出码：0 通过 · 1 断言失败 · 2 脚本异常 · 3 模型未就绪
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 8092;
const CDP_PORT = 9244;
const BASE = `http://127.0.0.1:${PORT}`;
const PAGE = '/human/_test-motion.html';
const SHOTS = path.join(ROOT, 'shots');

const argv = process.argv;
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const HEADED = flag('--headed');
const KEEP = flag('--keep');
const WAIT_S = Number(opt('--wait', '300')) || 300;
const BACKEND = opt('--backend', 'auto');
const MODEL = opt('--model', './model/mmm_v6_soma_q8h.onnx');
const RIG = opt('--rig', 'soma');
const SHOT = path.join(SHOTS, 'motion_soma.png');
const MODE = HEADED ? 'headed(WebGPU 主路径)' : 'headless(WASM 回退路径)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, cond, detail) {
  const ok = !!cond;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  ->  ' + JSON.stringify(detail) : ''}`);
  return ok;
}

fs.mkdirSync(SHOTS, { recursive: true });
const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)],
  { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'motion_' + Date.now());
fs.mkdirSync(profile, { recursive: true });

// 有头模式必须让 Chrome 用真实 GPU（swiftshader 会让 WebGPU 拿不到 adapter）；
// headless 只有 swiftshader 可用，用来验 wasm 回退。
const chromeArgs = [`--remote-debugging-port=${CDP_PORT}`, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  '--window-size=1280,800'];
if (HEADED) {
  chromeArgs.push('--ignore-gpu-blocklist', '--enable-unsafe-webgpu', 'about:blank');
} else {
  chromeArgs.push('--headless=new', '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
    '--enable-unsafe-webgpu', 'about:blank');
}
const br = spawn(CHROME, chromeArgs, { stdio: 'ignore' });

let ws = null;
async function cleanup() {
  try { ws?.close(); } catch { /* noop */ }
  try { br.kill(); } catch { /* noop */ }
  try { srv.kill(); } catch { /* noop */ }
  if (KEEP) return;
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* retry */ }
    if (!fs.existsSync(profile)) return;
    await sleep(400);
  }
}

let seq = 0;
const pend = new Map();
const pageLogs = [];
const jsErrors = [];
const netErrors = [];

async function main() {
  const url = `${BASE}${PAGE}?model=${encodeURIComponent(MODEL)}&rig=${RIG}&backend=${BACKEND}`;
  for (let i = 0; i < 80; i++) {
    try { await fetch(BASE + PAGE); break; } catch { await sleep(250); }
  }

  let page = null;
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      page = list.find((t) => t.type === 'page');
      if (page) break;
    } catch { /* retry */ }
    await sleep(300);
  }
  if (!page) throw new Error('CDP 不可达（Chrome 未起来？）');

  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => {
    const o = JSON.parse(e.data);
    if (o.id && pend.has(o.id)) { pend.get(o.id)(o); pend.delete(o.id); return; }
    if (o.method === 'Runtime.consoleAPICalled') {
      const text = (o.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
      pageLogs.push(`[${o.params.type}] ${text}`);
      if (o.params.type === 'error') jsErrors.push(text);
    } else if (o.method === 'Runtime.exceptionThrown') {
      const d = o.params.exceptionDetails;
      jsErrors.push(d.exception?.description || d.text || 'exception');
    } else if (o.method === 'Log.entryAdded') {
      const en = o.params.entry;
      pageLogs.push(`[log:${en.level}] ${en.text} ${en.url || ''}`);
      if (en.level === 'error') netErrors.push(`${en.text} ${en.url || ''}`);
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq;
    pend.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pend.has(id)) { pend.delete(id); rej(new Error(`CDP ${method} 超时`)); } }, 90000);
  });
  const E = async (expression) => {
    for (let i = 0; i < 3; i++) {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.result?.exceptionDetails) {
        return { __err: r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description || '').slice(0, 400) };
      }
      const v = r.result?.result?.value;
      if (v !== undefined) return v;
    }
    return undefined;
  };
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');

  console.log(`\n[0] 模式：${MODE}`);
  console.log(`    ${url}`);
  await send('Page.navigate', { url });

  console.log(`\n[1] 等待 __test.ready（最多 ${WAIT_S}s）`);
  const deadline = Date.now() + WAIT_S * 1000;
  let ready = false;
  let lastNote = '';
  while (Date.now() < deadline) {
    const s = await E(`(()=>{const t=window.__test;if(!t)return null;const s=t.stats;return{
      ready:t.ready, error:t.error, backend:s.backend, modelReady:s.modelReady, stage:s.stage,
      genMs:s.genMs, frames:s.frames, log:(t.log||[]).slice(-1)[0]||''};})()`);
    if (s && typeof s === 'object' && !s.__err) {
      const note = `${s.stage}/${s.backend}/modelReady=${s.modelReady}/frames=${s.frames}`;
      if (note !== lastNote) {
        console.log(`    … ${note}${s.error ? '  error=' + s.error : ''}`);
        lastNote = note;
      }
      if (s.ready) { ready = true; break; }
    }
    await sleep(1000);
  }

  const snap = await E(`(()=>{const t=window.__test;if(!t)return null;const s=t.stats;return{
    ready:t.ready, bound:t.bound, error:t.error, backend:s.backend, modelReady:s.modelReady,
    stage:s.stage, genMs:s.genMs, hipsMoved:t.hipsMoved, gait:t.gait, armAngle:t.armAngle,
    tpose:t.tpose, hipsY:t.hipsY, rig:t.rig, log:(t.log||[]).slice(-8)};})()`);

  if (!ready || !snap) {
    console.log('  FAIL  页面 __test.ready 未在时限内变 true');
    fail++;
    await shot(send);
    dumpLogs();
    return 4;
  }

  console.log('\n[2] 基础断言');
  check('__test.ready === true', snap.ready === true, snap.ready);
  const wantBackend = HEADED && BACKEND !== 'wasm' ? 'webgpu' : 'wasm';
  check(`stats.backend === '${wantBackend}'（${MODE}）`, snap.backend === wantBackend, snap.backend);
  check('stats.modelReady === true（模型真加载）', snap.modelReady === true, snap.modelReady);
  check('页面无 JS 未捕获异常', jsErrors.length === 0, jsErrors.slice(0, 3));

  if (!snap.modelReady) {
    console.log('\n[!] 模型未就绪 —— 验证「失败路径」：不挂死 + 状态可见');
    check("stats.error === '模型未就绪'", snap.error === '模型未就绪', snap.error);
    check('角色仍以绑定姿态渲染（bound=true）', snap.bound === true, snap.bound);
    await shot(send);
    console.log('\n模型目录：');
    for (const f of fs.readdirSync(path.join(ROOT, 'web', 'human', 'model'))) {
      const st = fs.statSync(path.join(ROOT, 'web', 'human', 'model', f));
      console.log(`    ${f}  ${(st.size / 1048576).toFixed(1)} MiB`);
    }
    console.log(`\n【结论】模型未就绪（stage=${snap.stage}）`);
    return 3;
  }

  /* ---- 4. walk：推理 + 根位移 ---- */
  console.log('\n[3] 切 walk：8 s 内 genMs>0 且 hips 位移 > 0.05 m');
  // 表达式必须带返回值：E() 对 undefined 会重试 3 次，导致 setGait 被重复触发
  await E(`(window.__test.setGait('walk'), 1)`);
  let genMs = 0;
  const tGen = Date.now();
  while (Date.now() - tGen < 8000) {
    const g = await E(`window.__test.stats.genMs`);
    if (typeof g === 'number' && g > 0) { genMs = g; break; }
    await sleep(250);
  }
  check('8 s 内 stats.genMs > 0（推理真的跑了）', genMs > 0, +genMs.toFixed(1) + ' ms');

  let hips = 0;
  let hipsPos = null;
  const tMove = Date.now();
  while (Date.now() - tMove < 20000) {
    const m = await E(`(()=>{const t=window.__test;return{hips:t.hipsMoved,pos:t.hipsPos};})()`);
    if (m && typeof m.hips === 'number') {
      hips = Math.max(hips, m.hips);
      hipsPos = m.pos || hipsPos;
      if (hips > 0.05) break;
    }
    await sleep(300);
  }
  check('hips 世界位移 > 0.05 m（根真实移动）', hips > 0.05, { moved: +hips.toFixed(3), pos: hipsPos });

  /* ---- 5. walk → run → stand 各 2 s ---- */
  console.log('\n[4] walk → run → stand 各 2 s，检查异常 / T-pose / hips 高度');
  const errBefore = jsErrors.length;
  const seg = [];
  for (const g of ['walk', 'run', 'stand']) {
    await E(`(window.__test.setGait('${g}'), 1)`);
    let armMax = 0, yMin = Infinity, yMax = -Infinity, gen = 0, frames = 0, tp = 0, samples = 0;
    let downMin = [9, 9];
    let devMin = 999;
    // 后 1 s 视为该步态的稳态（前 1 s 混有上一段的过渡/收尾）
    let sMin = Infinity, sMax = -Infinity;
    const t = Date.now();
    while (Date.now() - t < 2000) {
      const steady = Date.now() - t >= 1000;
      const r = await E(`(()=>{const t=window.__test;const s=t.stats;return{
        arm:t.armAngle, tp:t.tpose, down:t.armDown, dev:t.bindDev, y:t.hipsPos?t.hipsPos.y:null,
        gen:s.genMs, f:s.frames, gait:t.gait};})()`);
      if (r && typeof r.arm === 'number') {
        samples++;
        armMax = Math.max(armMax, r.arm);
        if (r.tp) tp++;
        if (Array.isArray(r.down)) downMin = [Math.min(downMin[0], r.down[0]), Math.min(downMin[1], r.down[1])];
        if (typeof r.dev === 'number') devMin = Math.min(devMin, r.dev);
        // 每段内采样当前 hips 高度（不用页面全局累计值，避免被首帧绑定姿态污染）
        if (typeof r.y === 'number') {
          yMin = Math.min(yMin, r.y); yMax = Math.max(yMax, r.y);
          if (steady) { sMin = Math.min(sMin, r.y); sMax = Math.max(sMax, r.y); }
        }
        gen = Math.max(gen, r.gen || 0);
        frames = Math.max(frames, r.f || 0);
      }
      await sleep(200);
    }
    seg.push({
      gait: g, armMax: +armMax.toFixed(1), tp, samples, gen: +gen.toFixed(0), downMin: downMin.map((v) => +v.toFixed(2)), devMin: +devMin.toFixed(1),
      yMin: +yMin.toFixed(3), yMax: +yMax.toFixed(3),
      sMin: +sMin.toFixed(3), sMax: +sMax.toFixed(3), frames,
    });
    console.log(`    ${g}: armAngleMax=${armMax.toFixed(1)}° T-pose样本=${tp}/${samples} armDownMin=[${downMin.map((v) => v.toFixed(2)).join(", ")}] 绑定姿态偏差Min=${devMin.toFixed(1)}° genMs=${gen.toFixed(0)} hipsY 全程=[${yMin.toFixed(3)}, ${yMax.toFixed(3)}] 稳态=[${sMin.toFixed(3)}, ${sMax.toFixed(3)}]`);
  }
  const newErrs = jsErrors.length - errBefore;
  const tpTotal = seg.reduce((n, s) => n + s.tp, 0);
  check('连续切换无 JS 异常', newErrs === 0, newErrs);
  check('骨骼未回到 T-pose（与绑定姿态偏差 <5° 的采样数 = 0）', tpTotal === 0, seg.map((s) => `${s.gait}:${s.tp}/${s.samples}`).join(' '));
  // 每段稳态（后 1 s）的 hips 高度；跨段比较只看稳态，避免把「切换过渡帧」算成异常
  const steadyY = seg.flatMap((s) => [s.sMin, s.sMax]).filter(Number.isFinite);
  const yRange = steadyY.length ? Math.max(...steadyY) - Math.min(...steadyY) : 0;
  // 生成动作允许有起跳/急停的抬升，此处只兜底「掉地/传送」这类异常；实际波动值如实打印
  check('hips 高度波动无异常（稳态 < 0.60 m 兜底）', yRange < 0.60,
    { range: +yRange.toFixed(3), yMin: +Math.min(...steadyY).toFixed(3), yMax: +Math.max(...steadyY).toFixed(3) });
  check('切换过程中仍有推理产出（genMs > 0）', seg.some((s) => s.gen > 0), seg.map((s) => s.gen));

  const after = await E(`(()=>{const t=window.__test;const s=t.stats;return{
    backend:s.backend, genMs:s.genMs, modelReady:s.modelReady, gait:t.gait,
    hipsMoved:t.hipsMoved, armAngle:t.armAngle, tpose:t.tpose, hipsY:t.hipsY, frames:s.frames};})()`);
  console.log('    最终状态：', JSON.stringify(after));

  console.log('\n[5] 截图');
  const bbox = await E(`(()=>{const b=window.__test.bbox;return b?JSON.stringify(b):null;})()`);
  const measure = await E(`(()=>{const m=window.__test.measure();return m?JSON.stringify(m):null;})()`);
  console.log(`    角色包围盒（米）：${bbox || 'n/a'}`);
  console.log(`    骨骼身高（米）：${measure || 'n/a'}`);
  await E(`(window.__test.frameCharacter(), 1)`);
  await sleep(600);
  await shot(send);
  dumpLogs();

  console.log(`\n【结论】${MODE} · backend=${after?.backend} · genMs=${Math.round(after?.genMs || 0)} ms · hips 位移=${(after?.hipsMoved || 0).toFixed(3)} m`);
  return fail ? 1 : 0;
}

async function shot(send) {
  try {
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const b64 = r.result?.data;
    if (!b64) { console.log('  FAIL  截图失败（无 data）'); fail++; return; }
    fs.writeFileSync(SHOT, Buffer.from(b64, 'base64'));
    const kb = (fs.statSync(SHOT).size / 1024).toFixed(0);
    console.log(`    已保存 ${path.relative(ROOT, SHOT)} (${kb} KB)`);
  } catch (e) {
    console.log('  FAIL  截图异常：' + e.message);
    fail++;
  }
}

function dumpLogs() {
  console.log('\n控制台（最后 14 条）：');
  pageLogs.slice(-14).forEach((l) => console.log('   ', l));
  if (jsErrors.length) {
    console.log('JS 异常：');
    jsErrors.slice(-8).forEach((l) => console.log('   ', l));
  }
  const unexpected = netErrors.filter((l) => !/favicon\.ico/.test(l));
  if (unexpected.length) {
    console.log('资源错误：');
    unexpected.slice(-8).forEach((l) => console.log('   ', l));
  }
}

const started = Date.now();
main()
  .then(async (code) => {
    console.log(`\n========== ${pass} PASS / ${fail} FAIL ==========  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    if (code === 3) console.log('退出码 3：模型未就绪');
    await cleanup();
    process.exit(code);
  })
  .catch(async (e) => {
    console.error('\n自检脚本异常:', e);
    dumpLogs();
    await cleanup();
    process.exit(2);
  });

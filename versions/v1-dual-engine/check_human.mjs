/**
 * 数字人集成自检（系统 Chrome + CDP，无 playwright）
 *
 * 验证 /gs-viewer.html?human=1 上：
 *   1. 现有 3DGS 场景仍正常加载（viewer.state.loaded）
 *   2. human-layer 挂载：overlay canvas 存在、__mgHuman.state.ready
 *   3. 高斯化身构建成功（splats > 0）、骨骼数 > 0
 *   4. 动作驱动状态可见（backend / modelReady / error 三选一必须明确）
 *   5. 截图落盘
 *
 * 用法：node tools/check_human.mjs [--scene=floor3] [--wait=180]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 8093;
const CDP_PORT = 9243;
const BASE = `http://127.0.0.1:${PORT}`;
const argOf = (k, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${k}=`));
  return a ? a.split('=')[1] : d;
};
const SCENE = argOf('scene', 'floor3');
const WAIT = Number(argOf('wait', 180));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  const ok = !!cond;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  ->  ' + JSON.stringify(detail).slice(0, 300) : ''}`);
  return ok;
};

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'human_' + Date.now());
fs.mkdirSync(profile, { recursive: true });
const HEADED = process.argv.includes('--headed');
const br = spawn(CHROME, [
  ...(HEADED ? [] : ['--headless=new', '--use-gl=swiftshader', '--enable-unsafe-swiftshader']),
  `--remote-debugging-port=${CDP_PORT}`, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--ignore-gpu-blocklist', '--window-size=1600,900', 'about:blank'
], { stdio: 'ignore' });

function cleanup() {
  try { br.kill(); } catch { /* noop */ }
  try { srv.kill(); } catch { /* noop */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* noop */ }
  try { fs.unlinkSync(path.join(ROOT, 'serve.log')); } catch { /* noop */ }
}

let ws, seq = 0;
const pend = new Map();
const logs = [];

async function main() {
  for (let i = 0; i < 100; i++) { try { await fetch(BASE + '/'); break; } catch { await sleep(250); } }
  let page = null;
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      page = list.find((t) => t.type === 'page');
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
    if (o.method === 'Runtime.consoleAPICalled') {
      const s = (o.params.args || []).map((x) => x.value ?? x.description ?? '').join(' ');
      if (/human|motionbricks|模型|ORT|WebGPU/i.test(s)) logs.push(`[console.${o.params.type}] ${String(s).slice(0, 240)}`);
    } else if (o.method === 'Runtime.exceptionThrown') {
      const d = o.params.exceptionDetails;
      logs.push('[EXCEPTION] ' + String((d.exception && d.exception.description) || d.text || '').slice(0, 300));
    }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params }));
  });
  const E = async (expression) => {
    for (let i = 0; i < 3; i++) {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.result?.exceptionDetails) {
        return { __err: r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description || '').slice(0, 400) };
      }
      const v = r.result?.result?.value;
      if (v !== undefined) return v;
      await sleep(120);
    }
    return {};
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Log.enable');

  const url = `${BASE}/gs-viewer.html?scene=${SCENE}&human=1`;
  console.log('[1] 打开 ' + url);
  await send('Page.navigate', { url });
  await sleep(1500);

  console.log('[2] 等 3DGS 场景加载');
  let loaded = false;
  for (let i = 0; i < 200; i++) {
    const s = await E(`(()=>{const v=window.__viewer;return {has:!!v,loaded:!!(v&&v.state&&v.state.loaded),gs:(v&&v.state&&v.state.gsplats)||0}})()`);
    if (s && s.loaded) { loaded = true; console.log('    loaded=true gsplats=' + s.gs); break; }
    await sleep(500);
  }
  check('原 3DGS 场景加载完成', loaded);

  console.log('[3] 等数字人就绪（最多 ' + WAIT + 's）');
  let st = null;
  for (let i = 0; i < WAIT * 2; i++) {
    st = await E(`(()=>{const h=window.__mgHuman;return h?{ok:true,state:{...h.state}}:{ok:false,has:!!h}})()`);
    if (st && st.ok && st.state.ready) break;
    await sleep(500);
  }
  console.log('    state=' + JSON.stringify(st));
  check('human-layer 暴露 __mgHuman', !!(st && st.ok));
  check('state.ready', !!(st && st.state && st.state.ready), st && st.state && st.state.phase);

  const dom = await E(`(()=>{const c=document.getElementById('mg-human-layer');const u=document.getElementById('mg-human-ui');
    return {canvas:!!c, w:c&&c.clientWidth, h:c&&c.clientHeight, ui:!!u, err:!!document.getElementById('mg-error')&&!document.getElementById('mg-error').hidden}})()`);
  console.log('    dom=' + JSON.stringify(dom));
  check('overlay canvas 存在且铺满', dom && dom.canvas && dom.w > 800 && dom.h > 400, dom);
  check('控制 UI 注入', dom && dom.ui);

  /* 面板可见性：中心点命中自己 + 与小地图矩形不相交（R4-D5 回归项） */
  const occl = await E(`(()=>{
    const u=document.getElementById('mg-human-ui');
    if(!u) return {ok:false,reason:'no ui'};
    const r=u.getBoundingClientRect();
    const cx=r.left+r.width/2, cy=r.top+r.height/2;
    const hit=document.elementFromPoint(cx,cy);
    const inUi=!!(hit&&u.contains(hit));
    const mm=document.getElementById('mg-minimap');
    const mr=mm?mm.getBoundingClientRect():null;
    const overlap=mr?!(r.right<mr.left||r.left>mr.right||r.bottom<mr.top||r.top>mr.bottom):false;
    const R=(b)=>({x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)});
    return {ok:inUi&&!overlap,inUi,overlap,rect:R(r),hit:hit?(hit.id||hit.className||hit.tagName):null,mm:mr?R(mr):null};
  })()`);
  console.log('    panel=' + JSON.stringify(occl));
  check('控制面板完整可见（未被小地图遮挡）', occl && occl.ok, occl);

  if (st && st.state) {
    check('高斯化身已构建（splats>0）', st.state.count > 0, st.state.count);
    check('骨骼数 > 0', st.state.bones > 0, st.state.bones);
    check('身高归一在 1.65~1.85m', st.state.height > 1.65 && st.state.height < 1.85, st.state.height);
    check('推理状态明确（backend 或 error 有值）', !!st.state.backend || !!st.state.error,
      { backend: st.state.backend, error: st.state.error });
    check('无页面级致命错误', dom && !dom.err);
  }

  /* 动作切换（即使模型未就绪，也应能切换状态不报错） */
  console.log('[4] 动作切换');
  const gait = await E(`(async()=>{const h=window.__mgHuman;if(!h)return {__err:'no __mgHuman'};
    const out=[];for(const g of ['walk','run','stand']){h.setGait(g);await new Promise(r=>setTimeout(r,700));out.push(h.state.gait);}
    return {gait:out, err:h.state.error};})()`);
  console.log('    ' + JSON.stringify(gait));
  check('三种步态均可切换', gait && Array.isArray(gait.gait) && gait.gait.join(',') === 'walk,run,stand', gait && gait.gait);

  await sleep(1200);
  /* 演示取景：放到相机前方 3.2 m（1.75 m 人体在 75° 垂直视场下约占屏高 1/3，头脚都在框内），
     切 walk 让动作真的跑起来。 */
  await E(`(async()=>{const h=window.__mgHuman;if(!h)return 0;h.placeInFront(3.2);h.setGait('walk');return 1;})()`);
  await sleep(6000);
  const st2 = await E(`(()=>{const h=window.__mgHuman;return h?{...h.state}:null})()`);
  console.log('[4b] walk 后 state=' + JSON.stringify(st2));
  const meas = await E(`(()=>{const h=window.__mgHuman;return h&&h.measure?h.measure():null})()`);
  console.log('[4c] 世界量测=' + JSON.stringify(meas));
  check('walk 后仍有推理产出或模型未就绪明确', !!(st2 && (st2.genMs > 0 || st2.error)), st2 && { genMs: st2.genMs, error: st2.error });
  check('世界包围盒身高在 1.4~2.1m（比例正确）', !!(meas && meas.height > 1.4 && meas.height < 2.1), meas && meas.height);

  /* 性能采样：5 s 内统计页面 FPS、推理耗时、JS 堆 */
  await send('Performance.enable');
  const m0 = await send('Performance.getMetrics');
  const t0 = Date.now();
  await sleep(5000);
  const m1 = await send('Performance.getMetrics');
  const st3 = await E(`(()=>{const h=window.__mgHuman;return h?{...h.state}:null})()`);
  const mm = (r, k) => (r.result?.metrics || []).find((x) => x.name === k)?.value ?? 0;
  const perfOut = {
    fps: st3 && st3.fps, genMs: st3 && st3.genMs, backend: st3 && st3.backend,
    jsHeapMB: +(mm(m1, 'JSHeapUsedSize') / 1048576).toFixed(1),
    taskMsPerSec: +(((mm(m1, 'TaskDuration') - mm(m0, 'TaskDuration')) * 1000) / ((Date.now() - t0) / 1000)).toFixed(1)
  };
  console.log('[4d] 性能=' + JSON.stringify(perfOut));

  let shot = null;
  try { shot = await Promise.race([send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }), sleep(15000).then(() => null)]); }
  catch (e) { console.log('    截图失败（有头窗口可能被遮挡）：' + e.message); }
  const out = path.join(ROOT, 'shots', 'human_walk.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (shot && shot.result?.data) { fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64')); console.log('    行走截图 ' + out); }

  /* 再取一张「站立面向镜头」的交付截图。
     顺序很重要：先 setGait('stand') 再 placeInFront —— 反过来时若主循环还在按「行走」跑，
     外层偏航会被 ×0.85 衰减，截出来是侧身/背影（本轮踩过的坑）。 */
  await E(`(async()=>{const h=window.__mgHuman;if(!h)return 0;h.setGait('stand');h.placeInFront(2.8);return 1;})()`);
  await sleep(3500);
  const poseSt = await E(`(()=>{const h=window.__mgHuman;return {gait:h.state.gait,yaw:+(h.getYaw()).toFixed(2),d:h.diag()};})()`);
  console.log('    站立截图前 pose=' + JSON.stringify(poseSt));
  let shot2 = null;
  try { shot2 = await Promise.race([send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }), sleep(15000).then(() => null)]); }
  catch { /* ignore */ }
  const out2 = path.join(ROOT, 'shots', 'human_demo.png');
  if (shot2 && shot2.result?.data) { fs.writeFileSync(out2, Buffer.from(shot2.result.data, 'base64')); console.log('    站立截图 ' + out2); }
  else console.log('    未取得站立截图');

  if (logs.length) {
    console.log('[5] 页面日志（节选）');
    logs.slice(-25).forEach((l) => console.log('    ' + l));
  }

  console.log(`\n========== ${pass} PASS / ${fail} FAIL ==========`);
  const state = st && st.state;
  if (state && !state.modelReady) {
    console.log('注意：模型未就绪（' + (state.error || '-') + '），本条不能算「动作已跑通」。');
  }
}

main()
  .then(() => { cleanup(); process.exit(fail ? 1 : 0); })
  .catch((e) => { console.error('FAILED', e); cleanup(); process.exit(2); });

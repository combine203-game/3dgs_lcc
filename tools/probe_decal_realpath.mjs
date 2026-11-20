/**
 * 贴花真实路径像素级验收探针
 * ----------------------------------------------------------------
 * 与 tools/probe_decal_video_pixel.mjs 的区别：后者注入**合成投影机**
 * （position/quaternion/half 写死，法向朝上的悬空水平板），分母用 OBB 八角点
 * 的轴对齐外接矩形 —— 但只有恰好穿过该板的表面会被着色，分母天然偏大，
 * 覆盖率指标失真。
 *
 * 本探针走**真实用户路径**：
 *   1. 在场景表面上按屏幕坐标框选一个矩形（写入 a.rect 的 UV）
 *   2. 调用 editor 的 rebuildDecalProjector → picker.unprojectRect 深度反算
 *      → schema.buildDecalProjector 拟合 OBB
 *   3. 贴花渲染（内置演示画面，色相稳定）
 *   4. 可见/隐藏两帧差分
 *
 * 【分母口径（2026-11-16 修正）】
 *   旧口径用「OBB 正对相机面的屏幕投影 AABB」当应覆盖区域 —— **错的**：
 *   OBB 有 4m 厚度（half[2]≈1.99），正对相机的那个面比真实表面近约 2m，
 *   透视放大后它的屏幕投影远大于实际贴合面（实测虚大 4.59 倍），
 *   覆盖率被稀释到 0.24，看起来像「渲染不完整」，其实贴花是完整的。
 *   现改为**用户框选矩形**（SEL_RECT）：用户框的就是屏幕上一块矩形，
 *   深度反算的 49 个采样点正落在这块矩形里，其屏幕投影等于框选矩形本身，
 *   这才是「应当被贴花覆盖」的唯一忠实口径。
 *   OBB 前表面 AABB 仍计算并保留，但只作为「贴花外溢上界」的参考量。
 *
 * 指标：
 *   ① 选中区覆盖率 = 显著变化像素 ∩ 选中区 ÷ 选中区面积   ≥ 0.80
 *   ② 选中区填充比 = 变化像素包围盒 ÷ 选中区面积           ≥ 0.70
 *   ③ 主色相差     = 贴花区主色相 vs 演示画面主色相       ≤ 15°
 *   ④ 孤立点率     = 8 邻域无变化的变化像素占比           ≤ 2%（椒盐点回归守卫）
 *   ⑤ OBB 外溢出率 = 变化像素落在投影机盒外的比例         ≤ 1%（正确性硬约束）
 *
 * 噪声处理：场景里有循环播放的视频，帧与帧之间本身就会变。
 *   故额外再截一帧「贴花仍隐藏」的帧，用 hidden vs hidden2 估计**动画噪声基线**，
 *   显著变化 = (visible vs hidden) 且 非噪声，避免把场景动画算成贴花。
 *
 * 用法： node tools/probe_decal_realpath.mjs [--wait=20000] [--headed] [--keep]
 *
 * --headed：不起 --headless=new，用桌面 Chrome 的**真实 GPU**（不加 swiftshader）。
 *   必须用真实 GPU：引擎 picker 的 CPU 回读（pickBuffer.read immediate）在
 *   SwiftShader 软渲染下会挂死，深度反算只能退化成 mesh，OBB 就拟合不出来。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { decodePng, dominantHue, hueDelta } from './png-decode.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 18139;
const CDP_PORT = 9265;
const BASE = `http://127.0.0.1:${PORT}`;
const WAIT = Number((process.argv.find(a => a.startsWith('--wait=')) || '').split('=')[1]) || 20000;
const HEADED = process.argv.includes('--headed');
/* --view=floor-1.html 直达目标楼层；--rect=x0,y0,x1,y1 指定用户框选区域。
   默认保持历史行为（首页 outdoor + 序厅地面矩形），不影响既有验收口径。 */
const VIEW = (process.argv.find(a => a.startsWith('--view=')) || '').split('=')[1] || '';
/* --renderer=webgl：强制 PlayCanvas 走 WebGL2。无头 SwiftShader 下 WebGPU
   （Dawn）在 toDataURL/截图后会报 "Vertex attribute slot 0 ... not present in
   the VertexState" 并让后续整帧变空白，visible/hidden 差分全部失真。
   WebGL2 后端无此问题，且贴花 shader 有等价 GLSL 实现。 */
const RENDERER = (process.argv.find(a => a.startsWith('--renderer=')) || '').split('=')[1] || '';
const RECT_ARG = (process.argv.find(a => a.startsWith('--rect=')) || '').split('=')[1] || '';
/* 隐藏模式：'top' = 连顶层展厅页面一起隐藏（历史行为，会连带隐藏展厅的
   canvas/video → 尺寸归零 → 那些 mesh 的 pipeline 失效 → Dawn 报 VertexState 错）；
   'iframe' = 只隐藏 iframe 内的 overlay（保留顶层，避开上述副作用）。 */
const HIDE_MODE = process.argv.includes('--hide-iframe') ? 'iframe' : 'top';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const TH = { coverage: 0.80, fill: 0.70, hue: 15, isolated: 0.02, spill: 0.01 };
const PIX_DELTA = 12;
const HUE_DEMO = 210;             // 内置演示画面蓝色斜纹主色相

/** 把已解码的 PNG 裁剪成指定区域并重新编码为 PNG（供全屏截图后裁剪用） */
function cropPng(srcBuf, x, y, w, h) {
  const img = decodePng(srcBuf);
  const X = Math.max(0, Math.min(img.width - 1, Math.round(x)));
  const Y = Math.max(0, Math.min(img.height - 1, Math.round(y)));
  const W = Math.max(1, Math.min(img.width - X, Math.round(w)));
  const H = Math.max(1, Math.min(img.height - Y, Math.round(h)));
  const out = Buffer.alloc(W * H * 4);
  for (let r = 0; r < H; r++) {
    img.data.copy(out, r * W * 4, ((Y + r) * img.width + X) * 4, ((Y + r) * img.width + X + W) * 4);
  }
  return encodePng(out, W, H);
}

/** 最小 PNG 编码器（RGBA8，非隔行） */
function encodePng(rgba, width, height) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;                       // filter type 0 (None)
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

const srv = spawn(PY, ['serve.py', '--no-browser', '--local-only', '--port', String(PORT)],
  { cwd: ROOT, stdio: 'ignore' });
const profile = path.join(ROOT, '.verify-profile', 'decalreal_' + Date.now());
fs.mkdirSync(profile, { recursive: true });

const chromeArgs = [
  ...(HEADED ? [] : ['--headless=new']),
  `--remote-debugging-port=${CDP_PORT}`, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--autoplay-policy=no-user-gesture-required',
  ...(HEADED ? ['--enable-unsafe-webgpu'] : ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader']),
  '--window-size=1280,800', 'about:blank'
];
const br = spawn(CHROME, chromeArgs, { stdio: 'ignore' });

function cleanup() {
  try { br.kill(); } catch { /* noop */ }
  try { srv.kill(); } catch { /* noop */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* noop */ }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

let ws, seq = 0;
const pend = new Map();
const errors = [];
/* 必须早于 ws.onmessage 注册：WebGL2 首帧就可能输出 console.error，
   若此时 errStages 仍在 TDZ，会在事件回调里抛 ReferenceError 直接中断探针。 */
const stageMark = { name: 'init' };
const errStages = [];

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
    const txt = (o.params?.args || []).map(a => a.value ?? a.description ?? '').join(' ');
    if (o.method === 'Runtime.exceptionThrown')
      errors.push(o.params.exceptionDetails?.exception?.description || o.params.exceptionDetails?.text || '');
    else if (o.method === 'Runtime.consoleAPICalled' && o.params.type === 'error') {
      errors.push(txt);
      errStages.push(stageMark.name);
    }
  };
  function send(method, params = {}) {
    return new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  }
  const E = async (expression, timeoutMs = 40000) => {
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

  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  if (RENDERER === 'webgl') {
    /* ?renderer=webgl 只作用于顶层文档；楼层页在 iframe 内，app.js 读的是
       iframe 自己的 URL，拿不到这个参数。用同源 sessionStorage 回退标记
       在新文档启动前注入，iframe 的 pickRenderer() 就会返回 'webgl'。 */
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: "try{sessionStorage.setItem('mg_fallback','1')}catch(e){}"
    });
    console.log('  已注入 sessionStorage.mg_fallback=1（强制 iframe 走 WebGL2）');
  }
  let NAV_URL = BASE + '/' + (VIEW ? '?view=' + encodeURIComponent(VIEW) + '&edit=1&nocache=1' : '');
  if (RENDERER) NAV_URL += (NAV_URL.includes('?') ? '&' : '?') + 'renderer=' + encodeURIComponent(RENDERER);
  console.log('导航 = ' + NAV_URL);
  await send('Page.navigate', { url: NAV_URL });
  await sleep(WAIT);

  /* 阶段标记：记录每条 console.error 出现在哪个阶段，
     用于把「VertexState 错误」精确定位到是注入贴花、深度反算还是重建触发的。 */
  const DOC_MARK = `(()=>{const f=document.querySelector('iframe.gs-scene-frame[data-active="1"]')||document.querySelector('iframe.gs-scene-frame');return f?f.contentWindow:window;})()`;
  const setStage = async (n) => {
    stageMark.name = n;
    await E(`(()=>{window.__decalStage=${JSON.stringify(n)};return 1})()`);
    console.log('  · 阶段 →', n);
  };

  const DOC = `(()=>{const f=document.querySelector('iframe.gs-scene-frame[data-active="1"]')||document.querySelector('iframe.gs-scene-frame');return f?f.contentWindow:window;})()`;

  const hideDom = `(()=>{const W=${DOC},d=W.document;
    const sel='.ed-layer,.ed-ui,.ed-guides,.ed-marquee,#mg-loading,#mg-error,#mg-bar,#mg-helpbox,#mg-toolsbox,.sse-controlsWrap,.sse-controlsHint,.sse-infoPanel,.sse-joystick,.sse-panel';
    W.__hidden=d.querySelectorAll(sel);
    W.__hidden.forEach(e=>{e.dataset.__oldVis=e.style.visibility;e.style.visibility='hidden';});
    const f=document.querySelector('iframe.gs-scene-frame');
    const keep=new Set();let e=f;
    while(e&&e!==document.documentElement){keep.add(e);e=e.parentElement;}
    window.__topHidden=[];
    document.querySelectorAll('body *').forEach(x=>{
      if(keep.has(x))return;
      window.__topHidden.push([x,x.style.visibility]);x.style.visibility='hidden';
    });
    return 1;})()`;
  /* 只隐藏 iframe 内的 overlay（不动顶层文档）：顶层展厅页面若有 canvas/video，
     隐藏它们会让尺寸归零 → 那些 mesh 的 pipeline 失效 → Dawn 报
     "Vertex attribute slot 0 ... is not present in the VertexState"。
     贴花的全局 uncapturederror 钩子会把这个「别人的」错误误判成自己的故障，
     把贴花全隐藏 —— 这正是「覆盖率 0 且 degraded=true」的成因。 */
  const hideDomIframeOnly = `(()=>{const W=${DOC},d=W.document;
    const sel='.ed-layer,.ed-ui,.ed-guides,.ed-marquee,#mg-loading,#mg-error,#mg-bar,#mg-helpbox,#mg-toolsbox,.sse-controlsWrap,.sse-controlsHint,.sse-infoPanel,.sse-joystick,.sse-panel';
    W.__hidden=d.querySelectorAll(sel);
    W.__hidden.forEach(e=>{e.dataset.__oldVis=e.style.visibility;e.style.visibility='hidden';});
    return 1;})()`;
  const showDomIframeOnly = `(()=>{const W=${DOC};
    W.__hidden?.forEach(e=>{e.style.visibility=e.dataset.__oldVis||'';delete e.dataset.__oldVis;});W.__hidden=null;
    return 1;})()`;
  const showDom = `(()=>{const W=${DOC};
    W.__hidden?.forEach(e=>{e.style.visibility=e.dataset.__oldVis||'';delete e.dataset.__oldVis;});W.__hidden=null;
    window.__topHidden?.forEach(([x,v])=>{x.style.visibility=v;});window.__topHidden=null;return 1;})()`;

  async function shot(name) {
    /* --use-dataurl：页面内 canvas.toDataURL 读帧，避开 CDP Page.captureScreenshot
       触发的引擎 VertexState pipeline 失效（那条错误会让贴花及其它 mesh 一起
       提交失败、覆盖率恒为 0，且被贴花的全局错误钩子记录）。toDataURL 读的是
       canvas 后备缓冲，不走合成器，无头下稳定。返回图已是设备像素，
       _scale = 设备像素/CSS 像素，供 cover.sel 换算。 */
    if (process.argv.includes('--use-dataurl')) {
      /* 必须在渲染帧内读：WebGL2 默认 preserveDrawingBuffer=false，帧外
         toDataURL 拿到的是已清空的缓冲（实测 1258x650 全白 PNG 仅 16KB）。
         挂一次性 postrender 回调，在引擎刚画完这一帧时取后备缓冲。 */
      const hooked = await E(`(()=>{const W=${DOC},app=W.__viewer?.app;
        if(!app)return 'no-app';
        W.__probeShot=null;
        app.once('postrender',()=>{
          const cv=W.document.querySelector('#mg-stage canvas');
          if(!cv)return;
          const cr=cv.getBoundingClientRect();
          W.__probeShot={url:cv.toDataURL('image/png'),
            bw:cv.width,bh:cv.height,cssW:cr.width,cssH:cr.height};
        });
        return 1;})()`);
      let r = null;
      for (let i = 0; i < 20 && !r; i++) {
        r = await E(`(()=>{const W=${DOC};return W.__probeShot||null;})()`);
        if (!r) await sleep(150);
      }
      if (hooked !== 1) console.log('    [shot ' + name + '] postrender 挂载失败 =', JSON.stringify(hooked));
      if (!r || !r.url || !r.url.startsWith('data:image/png;base64,')) {
        console.log('    [shot ' + name + '] toDataURL 失败 =', JSON.stringify(r && {
          bw: r.bw, bh: r.bh,
          urlType: typeof (r && r.url),
          urlLen: (r && r.url) ? String(r.url).length : -1,
          urlHead: (r && r.url) ? String(r.url).slice(0, 48) : '(none)',
          err: r && r.__err, timeout: r && r.__timeout
        }));
        return null;
      }
      const buf = Buffer.from(r.url.split(',')[1], 'base64');
      fs.writeFileSync(path.join(ROOT, 'tools', `probe-real-${name}.png`), buf);
      const out = decodePng(buf);
      const scale = r.cssW > 0 ? r.bw / r.cssW : 1;
      console.log('    [shot ' + name + '] toDataURL canvas=' + out.width + 'x' + out.height +
        ' CSS=' + Math.round(r.cssW) + 'x' + Math.round(r.cssH) + '  DPR换算=' + scale.toFixed(3));
      out._scale = scale;
      return out;
    }
    const cv = await E(`(()=>{const W=${DOC};
      const cv=W.document.querySelector('#mg-stage canvas');
      if(!cv)return null;const r=cv.getBoundingClientRect();
      const f=document.querySelector('iframe.gs-scene-frame');
      const off=(f&&f.contentWindow===W)?[r.x+f.getBoundingClientRect().x,r.y+f.getBoundingClientRect().y]:[r.x,r.y];
      return {x:off[0],y:off[1],w:r.width,h:r.height,
              vw:window.innerWidth,vh:window.innerHeight};})()`);
    console.log('    [shot ' + name + '] 画布矩形(CSS) =', JSON.stringify(cv && {
      x: Math.round(cv.x), y: Math.round(cv.y), w: Math.round(cv.w), h: Math.round(cv.h)
    }));
    const NO_HIDE = process.argv.includes('--no-hide');
    await E(NO_HIDE ? '1' : (HIDE_MODE === 'iframe' ? hideDomIframeOnly : hideDom));
    /* 全屏截图 + 事后裁剪：clip 截图会临时改视口，触发 canvas resize →
       引擎内部某些 mesh 的 pipeline 在 resize 后失效，报 VertexState 错。
       那条错本身与贴花无关，但贴花的全局 GPU 错误钩子会误判成自己的故障并
       把贴花全隐藏（见 diag_decal_attrib 的三组对照）。这里避开视口变更，
       保证差分测量只反映贴花本身。 */
    const r = await send('Page.captureScreenshot', {
      format: 'png',
      ...(process.argv.includes('--no-from-surface') ? { fromSurface: false } : {})
    });
    await E(NO_HIDE ? '1' : (HIDE_MODE === 'iframe' ? showDomIframeOnly : showDom));
    const cv2 = await E(`(()=>{const W=${DOC};
      const cv=W.document.querySelector('#mg-stage canvas');
      if(!cv)return null;
      const f=document.querySelector('iframe.gs-scene-frame');
      return {bw:cv.width,bh:cv.height,
              iframeW:f?f.getBoundingClientRect().width:null,
              iframeH:f?f.getBoundingClientRect().height:null};})()`);
    if (!r.result?.data) return null;
    /* 截图是设备像素，画布矩形是 CSS 像素：必须按 DPR 换算，否则裁错区域
       （裁到与贴花无关的角落，覆盖率恒为 0）。 */
    const full = decodePng(Buffer.from(r.result.data, 'base64'));
    const scale = cv && cv.vw ? full.width / cv.vw : 1;
    let buf = Buffer.from(r.result.data, 'base64');
    if (cv && cv.w > 2 && cv.h > 2) {
      buf = cropPng(buf, cv.x * scale, cv.y * scale, cv.w * scale, cv.h * scale);
    }
    fs.writeFileSync(path.join(ROOT, 'tools', `probe-real-${name}.png`), buf);
    const out = decodePng(buf);
    console.log('    [shot ' + name + '] 全屏 =', full.width + 'x' + full.height,
      ' DPR换算 =', scale.toFixed(3), ' 裁剪后 =', out.width + 'x' + out.height);
    out._scale = scale;
    return out;
  }

  const dbg = async () => {
    const v = await E(`(()=>{const W=${DOC},m=W.__mgEditor?.decalMgr;
      return m&&typeof m.debug==='function'?m.debug():null;})()`);
    return v && !v.__err ? v : null;
  };

  console.log('\n===== A. 进入编辑态 =====');
  const backend = await E(`(()=>{const W=${DOC},gd=W.__viewer?.app?.graphicsDevice;
    return gd?(gd.isWebGPU||gd.deviceType==='webgpu'?'webgpu':'webgl2'):null;})()`);
  /* ?view=...&edit=1 已在导航时进入编辑态；此时再点按钮会退出，必须先检查。 */
  if (!await E(`(()=>!!(${DOC}).__mgEditor)()`)) {
    await E(`(()=>{document.getElementById('gsEditorBtn')?.click();return 1})()`);
    await sleep(3000);
  }
  if (!await E(`(()=>!!(${DOC}).__mgEditor)()`)) throw new Error('编辑器未挂载');
  console.log('  后端 =', backend);
  await setStage('A-编辑器已挂载');

  console.log('\n===== B. 走真实路径：在场景表面框选 → 深度反算 → OBB 拟合 =====');
  /* 框选区域：取画布中央偏左的一块（序厅地面区域），UV 直接给 editor 的 rect。
     真实用户是用鼠标拖框，这里等价地写入同一条数据通路（a.rect → rebuildDecalProjector）。 */
  const SEL_RECT = RECT_ARG ? RECT_ARG.split(',').map(Number) : [0.34, 0.52, 0.56, 0.72];
  if (SEL_RECT.length !== 4 || SEL_RECT.some(v => !Number.isFinite(v))) throw new Error('--rect 格式应为 x0,y0,x1,y1');
  const setup = await E(`(()=>{const W=${DOC},ed=W.__mgEditor;
    const list=ed.store.list();
    for(const a of list){if(a.kind==='decal'&&a.visible!==false)ed.store.update(a.id,{visible:false});}
    let tpl=list.find(a=>a.kind==='decal');
    if(!tpl)return 'no-template';
    const c=JSON.parse(JSON.stringify(tpl));
    c.id='real-decal-'+Date.now();c.title='真实路径验收贴面';
    /* 先以 visible=false 注入，rebuild 成功后再置 true —— 与 diag_decal_attrib
       的三组对照保持一致，避免「注入即绘制」这条路径上的干扰变量。 */
    c.visible=false;
    c.rect=${JSON.stringify(SEL_RECT)};
    c.projector=null;c.surface=null;
    c.media=[{type:'video',url:'',caption:'投射演示画面'}];
    ed.store.add(c);
    return c.id;})()`);
  if (!/^real-decal-/.test(String(setup))) throw new Error('注入失败: ' + setup);
  const DECAL_ID = String(setup);
  console.log('  注入 =', DECAL_ID, ' 框选 UV =', JSON.stringify(SEL_RECT));
  await setStage('B1-已注入标注（未重建）');
  await sleep(1500);
  const dbgPre = await dbg();
  console.log('  注入后诊断 =', JSON.stringify({
    degraded: dbgPre?.degraded, gpuErrors: dbgPre?.gpuErrors,
    instanceCount: dbgPre?.instances?.length
  }));

  // 真实重建：走 editor 内部 rebuildDecalProjector
  const rebuilt = await E(`(()=>{const W=${DOC},ed=W.__mgEditor;
    ed.action('decal-rebuild','${DECAL_ID}');return 1;})()`);
  if (!rebuilt || rebuilt.__err) throw new Error('decal-rebuild 调用失败: ' + JSON.stringify(rebuilt));
  await setStage('B2-已触发 decal-rebuild（深度反算进行中）');
  // 等待投影机生成（深度反算是异步的）
  let proj = null;
  for (let i = 0; i < 60; i++) {
    const p = await E(`(()=>{const W=${DOC},ed=W.__mgEditor;const a=ed.store.get('${DECAL_ID}');
      return a&&a.projector?JSON.parse(JSON.stringify(a.projector)):null;})()`);
    if (p && !p.__err && p) { proj = p; break; }
    await sleep(500);
  }
  if (!proj) {
    const st = await E(`(()=>{const W=${DOC};const el=W.document.querySelector('[data-role="status"]');
      return el?el.textContent:'(无状态栏)';})()`);    const raw = await E(`(()=>{const W=${DOC},ed=W.__mgEditor;
      const a=ed.store.get('${DECAL_ID}');
      return {rect:a&&a.rect,surface:a&&a.surface,projector:a&&a.projector};})()`);
    console.log('  状态栏 =', st);
    console.log('  标注数据 =', JSON.stringify(raw));
    // 直接手动跑一次深度反算，看 picker 是否能取到表面
    const manual = await E(`(()=>{const W=${DOC},ed=W.__mgEditor;
      const pk=ed.picker;if(!pk)return 'no-picker';
      return pk.unprojectRect(${JSON.stringify(SEL_RECT)},6,6,{pickTimeout:800}).then(g=>
        g?{source:g.source,samples:g.samples,stats:g.stats,
             pts:(g.points||[]).filter(Boolean).length}:null).catch(e=>'err:'+e);})()`);
    console.log('  手动 unprojectRect =', JSON.stringify(manual));
    throw new Error('投影机未生成（深度反算失败或超限被拦截）');
  }
  console.log('  投影机 =', JSON.stringify(proj));
  await setStage('B3-投影机已生成');
  await sleep(2000);
  /* --debug-mode=N：把贴花 shader 切成调试输出（1=深度灰度,2=失败分类着色），
     这样可见帧里贴花命中区会显示纯色而非视频，差分能直接证明 shader 是否在
     框选区产出片元，排除「视频 alpha / 截图归因」等干扰。 */
  const DEBUG_MODE = Number((process.argv.find(a => a.startsWith('--debug-mode=')) || '').split('=')[1]);
  // 打开显示：贴花开始真正参与绘制
  await E(`(()=>{const W=${DOC},ed=W.__mgEditor;ed.store.update('${DECAL_ID}',{visible:true});return 1;})()`);
  /* A/B 开关：强制关掉 shadow 分支，走旧 OBB 回退路径。用于判定 GPU 错误
     是「新 shader 分支」引起，还是「新建 ShaderMaterial/纹理」本身引起。 */
  if (process.argv.includes('--force-legacy')) {
    await E(`(()=>{const W=${DOC},m=W.__mgEditor.decalMgr;m.instances.forEach(i=>{i.shadow=null;});return 1;})()`);
    await setStage('B4a-强制 shadow=0 回退旧OBB');
  }
  await setStage('B4-已置 visible=true');
  await sleep(3000);
  if (Number.isFinite(DEBUG_MODE)) {
    /* 等实例稳定后再写：store.update(visible) 触发的 syncDecals 可能异步
       重建实例，提前写入会被重置为 options 默认 0。setOptions 不触发已有
       实例 sync，必须直接写 inst.debugMode 并轮询确认。 */
    for (let k = 0; k < 6; k++) {
      await E(`(()=>{const W=${DOC},m=W.__mgEditor?.decalMgr;
        if(m&&m.instances&&m.instances.forEach)m.instances.forEach(i=>{i.debugMode=${DEBUG_MODE};});
        return 1;})()`);
      await sleep(500);
      const d = await dbg();
      if (d?.instances?.[0]?.debugMode === DEBUG_MODE) break;
    }
    console.log('  shader debugMode =', (await dbg())?.instances?.[0]?.debugMode);
  }
  const dbgPost = await dbg();
  console.log('  重建后诊断 =', JSON.stringify({
    degraded: dbgPost?.degraded, gpuErrors: dbgPost?.gpuErrors,
    scopedErrors: dbgPost?.scopedErrors, foreignErrors: dbgPost?.foreignErrors,
    lastGpuError: dbgPost?.lastGpuError,
    pickReady: dbgPost?.pickReady, pickSize: dbgPost?.pickSize,
    instanceCount: dbgPost?.instances?.length,
    instances: dbgPost?.instances
  }));
  // 立即裸截一张（不隐藏 DOM、不裁剪）：用来判断错误是不是由 hideDom/截图触发
  if (process.argv.includes('--probe-rawshot')) {
    const raw = await send('Page.captureScreenshot', { format: 'png' });
    console.log('  裸截图字节 =', raw.result?.data ? Buffer.from(raw.result.data, 'base64').length : 0);
    await sleep(1500);
    const d2 = await dbg();
    console.log('  裸截图后诊断 =', JSON.stringify({
      degraded: d2?.degraded, gpuErrors: d2?.gpuErrors
    }));
  }

  const surface = await E(`(()=>{const W=${DOC},ed=W.__mgEditor;const a=ed.store.get('${DECAL_ID}');
    const s=a&&a.surface;if(!s)return null;
    return {source:s.source,samples:s.samples,stats:s.stats,
            pts:(s.points||[]).filter(Boolean)};})()`);
  console.log('  深度反算 =', JSON.stringify(surface));

  for (let i = 0; i < 40; i++) {
    const d1 = await dbg();
    if (d1?.pickReady === true) break;
    await sleep(300);
  }

  console.log('\n===== C. 计算「应覆盖区域」（用户框选矩形）+ OBB 参考框 =====');
  const SKIP_C = process.argv.includes('--skip-c');
  if (SKIP_C) console.log('  （--skip-c：跳过 C 段，用于隔离错误来源）');
  await setStage('C0-开始计算应覆盖区域');
  /* 应覆盖区域 = 用户框选矩形（SEL_RECT，画布 UV）。
     理由：深度反算就是在这块矩形内逐点取深度，49 个采样点的屏幕位置
     恰好落回这块矩形 —— 所以矩形就是「用户要贴花的表面区域」。
     同时计算 OBB 8 个角点的屏幕投影 AABB（obbAll）与正对相机面的 AABB（obbFront），
     仅作**溢出参考框**（贴花绝不该画到 OBB 之外），不再当覆盖率分母。 */
  const cover = await E(`(()=>{const W=${DOC},ed=W.__mgEditor;
    const a=ed.store.get('${DECAL_ID}');if(!a||!a.projector)return {err:'no-proj'};
    const app=W.__viewer?.app;const cam=app?.root?.findComponent?.('camera');
    if(!cam)return {err:'no-camera'};
    const P=W.__pc;if(!P)return {err:'no-pc'};
    const cv=W.document.querySelector('#mg-stage canvas');if(!cv)return {err:'no-canvas'};
    const cr=cv.getBoundingClientRect();
    const h=a.projector.half,q=a.projector.quaternion;
    const qx=q[0],qy=q[1],qz=q[2],qw=q[3];
    const cpos=cam.entity.getPosition();
    const rot=(v)=>{const ix=qw*v[0]+qy*v[2]-qz*v[1],iy=qw*v[1]+qz*v[0]-qx*v[2],iz=qw*v[2]+qx*v[1]-qy*v[0],iw=-qx*v[0]-qy*v[1]-qz*v[2];
      const wx=ix*qw+iw*-qx+iy*-qz-iz*-qy,wy=iy*qw+iw*-qy+iz*-qx-ix*-qz,wz=iz*qw+iw*-qz+ix*-qy-iy*-qx;
      return [wx,wy,wz];};
    const lx=rot([1,0,0]),ly=rot([0,1,0]),lz=rot([0,0,1]);
    const c=a.projector.position;
    const toCam=[cpos.x-c[0],cpos.y-c[1],cpos.z-c[2]];
    const s=(lz[0]*toCam[0]+lz[1]*toCam[1]+lz[2]*toCam[2])>=0?1:-1;
    const proj=(v)=>{const t=new P.Vec3(v[0],v[1],v[2]);const out=new P.Vec3();
      cam.worldToScreen(t,out);return {x:out.x,y:out.y};};
    const mk=(sx,sy,sz)=>[c[0]+lx[0]*h[0]*sx+ly[0]*h[1]*sy+lz[0]*h[2]*sz,
                           c[1]+lx[1]*h[0]*sx+ly[1]*h[1]*sy+lz[1]*h[2]*sz,
                           c[2]+lx[2]*h[0]*sx+ly[2]*h[1]*sy+lz[2]*h[2]*sz];
    const aabb=(pts)=>{const xs=pts.map(p=>p.x),ys=pts.map(p=>p.y);
      return {x:Math.min.apply(null,xs)-cr.left,y:Math.min.apply(null,ys)-cr.top,
              w:Math.max.apply(null,xs)-Math.min.apply(null,xs),
              h:Math.max.apply(null,ys)-Math.min.apply(null,ys)};};
    const all=[];for(const sx of [-1,1])for(const sy of [-1,1])for(const sz of [-1,1]) all.push(proj(mk(sx,sy,sz)));
    const frontPts=[];for(const sx of [-1,1])for(const sy of [-1,1]) frontPts.push(proj(mk(sx,sy,s)));
    const R=${JSON.stringify(SEL_RECT)};
    const sel={x:R[0]*cr.width,y:R[1]*cr.height,
               w:(R[2]-R[0])*cr.width,h:(R[3]-R[1])*cr.height};
    return {sel, obbAll:aabb(all), obbFront:aabb(frontPts),
            canvasW:cv.width,canvasH:cv.height, cssW:cr.width,cssH:cr.height};
  })()`);
  console.log('  用户框选矩形(CSS) =', JSON.stringify(cover.sel));
  console.log('  OBB 全部角点 AABB(CSS) =', JSON.stringify(cover.obbAll));
  console.log('  OBB 正对面 AABB(CSS)  =', JSON.stringify(cover.obbFront), '（旧口径分母，仅对照）');
  await setStage('C1-应覆盖区域已算出');
  if (SKIP_C) {
    const d = await dbg();
    console.log('  （跳过 C 段）诊断 =', JSON.stringify({
      degraded: d?.degraded, gpuErrors: d?.gpuErrors, instanceCount: d?.instances?.length
    }));
  } else if (!cover || cover.err || !cover.sel || cover.sel.w < 4 || cover.sel.h < 4) {
    throw new Error('应覆盖区域无效: ' + JSON.stringify(cover));
  }

  /* 可选：切换深度口径 / 盒基准 / 调试着色，再各测一次覆盖率。
     用来区分「OBB 判定问题」与「深度重建问题」：
       depthMode=0 单 texel 中位 vs 1 引擎同族 5×5 分位
       boxScale=1.0 整框命中 vs 0.5 仅内侧 1/4
       debugMode=2 失败分类着色（红=盒外XY 绿=盒外Z 蓝=背面剔除）
     注：process.argv 是数组，不能用 .match() —— 用 find 正则取参。 */
  const variantArg = (process.argv.find(a => a.startsWith('--variant=')) || '').split('=')[1] || null;
  const VARIANTS = variantArg;
  if (VARIANTS) console.log('  变体 =', VARIANTS);
  console.log('\n===== D. 可见/隐藏两帧差分 =====');
  await setStage('D0-准备截图');
  if (process.argv.includes('--no-shot')) {
    // 只跑流程不截图：用于判定 GPU 错误到底是不是截图触发的
    await sleep(8000);
    const d = await dbg();
    console.log('  （--no-shot）诊断 =', JSON.stringify({
      degraded: d?.degraded, gpuErrors: d?.gpuErrors, instanceCount: d?.instances?.length
    }));
    const errs2 = await E(`(()=>{const W=${DOC};return 1})()`);
    console.log('  截图前错误条数 =', errors.length);
    errors.forEach((e, i) => console.log('   * ' + String(e).replace(/\s+/g, ' ').slice(0, 140)));
    cleanup();
    process.exit(0);
  }
  const shotVisible = await shot('visible');
  await setStage('D1-可见帧已截');
  await E(`(()=>{const W=${DOC},ed=W.__mgEditor;ed.store.update('${DECAL_ID}',{visible:false});return 1;})()`);
  await sleep(1200);
  const shotHidden = await shot('hidden');
  await setStage('D2-隐藏帧已截');
  /* 噪声基线帧：贴花仍隐藏，再截一张。场景里循环播放的视频会让帧间本身
     就变化，hidden vs hidden2 的差异就是「与贴花无关的动画噪声」。
     显著变化 = (visible vs hidden) 且 (hidden vs hidden2 不显著)。 */
  await sleep(1200);
  const shotHidden2 = await shot('hidden2');
  await E(`(()=>{const W=${DOC},ed=W.__mgEditor;ed.store.update('${DECAL_ID}',{visible:true});return 1;})()`);
  await sleep(800);
  if (!shotVisible || !shotHidden) throw new Error('截图失败');

  const W = Math.min(shotVisible.width, shotHidden.width);
  const H = Math.min(shotVisible.height, shotHidden.height);
  /* 屏幕矩形是 CSS 像素，裁剪后的 PNG 是设备像素：按 DPR 换算 */
  const pxScale = shotVisible._scale || 1;
  const toDev = (r) => ({
    x: Math.max(0, Math.round(r.x * pxScale)), y: Math.max(0, Math.round(r.y * pxScale)),
    w: Math.min(W - Math.max(0, Math.round(r.x * pxScale)), Math.round(r.w * pxScale)),
    h: Math.min(H - Math.max(0, Math.round(r.y * pxScale)), Math.round(r.h * pxScale))
  });
  const sel = toDev(cover.sel);            // 应覆盖区域 = 用户框选矩形
  const obbAll = toDev(cover.obbAll);      // OBB 完整投影 → 溢出上界
  const obbFront = toDev(cover.obbFront);  // 旧口径分母 → 仅对照
  const sw = sel.w, sh = sel.h;
  if (sw < 4 || sh < 4) throw new Error(`选中区在截图中无效: ${sw}x${sh}`);

  const diff3 = (a, b) => {
    const out = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) {
      const j = i * 4;
      const d = Math.max(
        Math.abs(a.data[j] - b.data[j]),
        Math.abs(a.data[j + 1] - b.data[j + 1]),
        Math.abs(a.data[j + 2] - b.data[j + 2]));
      out[i] = d > PIX_DELTA ? 1 : 0;
    }
    return out;
  };
  const decalDiff = diff3(shotVisible, shotHidden);
  const noiseDiff = shotHidden2 ? diff3(shotHidden, shotHidden2) : null;

  const mask = new Uint8Array(sw * sh);
  let changed = 0, minX = sw, minY = sh, maxX = -1, maxY = -1;
  let outsideSel = 0, outsideObb = 0, noiseOnly = 0, changedAll = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!decalDiff[i]) continue;
      changedAll++;
      // 噪声帧也变化的像素 → 判为场景动画，不计入贴花
      if (noiseDiff && noiseDiff[i]) { noiseOnly++; continue; }
      const inSel = x >= sel.x && x < sel.x + sw && y >= sel.y && y < sel.y + sh;
      if (inSel) {
        mask[(y - sel.y) * sw + (x - sel.x)] = 1; changed++;
        if (x - sel.x < minX) minX = x - sel.x;
        if (y - sel.y < minY) minY = y - sel.y;
        if (x - sel.x > maxX) maxX = x - sel.x;
        if (y - sel.y > maxY) maxY = y - sel.y;
      } else {
        outsideSel++;
        const inObb = x >= obbAll.x && x < obbAll.x + obbAll.w &&
                      y >= obbAll.y && y < obbAll.y + obbAll.h;
        if (!inObb) outsideObb++;
      }
    }
  }
  const area = sw * sh;
  const coverage = changed / area;                       // 选中区覆盖率
  const bboxArea = (maxX >= minX) ? (maxX - minX + 1) * (maxY - minY + 1) : 0;
  const bboxRatio = bboxArea / area;                     // 选中区填充比
  const outsideRatio = outsideSel / (changedAll - noiseOnly || 1);   // 溢出到选中区外的比例
  const spillRatio = outsideObb / (changedAll - noiseOnly || 1);     // 溢出到 OBB 之外（正确性硬约束）

  // 孤立点：8 邻域全 0
  let isolated = 0;
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    if (!mask[y * sw + x]) continue;
    let nb = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= sw || ny >= sh) continue;
      if (mask[ny * sw + nx]) nb++;
    }
    if (nb === 0) isolated++;
  }
  const isoRate = isolated / (changed || 1);

  const inMask = (x, y) => x >= sel.x && x < sel.x + sw && y >= sel.y && y < sel.y + sh;
  const hueVisible = dominantHue(shotVisible.data, W, H, inMask);
  const hueD = hueDelta(hueVisible, HUE_DEMO);
  // 旧口径对照：OBB 正对面 AABB 作分母时的覆盖率（说明虚大多少倍）
  const legacyArea = Math.max(1, obbFront.w * obbFront.h);
  const legacyCoverage = changedAll / legacyArea;

  console.log('\n===== E. 指标 =====');
  console.log('  选中区（用户框选，设备px）=', sw + 'x' + sh, ' 面积 =', area);
  console.log('  显著变化像素 =', changed, '  噪声剔除 =', noiseOnly, '  原始差分 =', changedAll);
  console.log('  ① 选中区覆盖率   =', coverage.toFixed(4), '（阈值 ≥', TH.coverage, '）');
  console.log('  ② 选中区填充比   =', bboxRatio.toFixed(4), '（阈值 ≥', TH.fill, '）');
  console.log('  ③ 主色相差       =', hueD == null ? 'N/A' : hueD.toFixed(1) + '°',
    '（阈值 ≤', TH.hue, '°）  贴花区主色相 =', hueVisible);
  console.log('  ④ 孤立点率       =', (isoRate * 100).toFixed(2) + '%',
    '（阈值 ≤', (TH.isolated * 100).toFixed(0) + '%，椒盐点守卫）');
  console.log('  ⑤ OBB 外溢出率   =', spillRatio.toFixed(5),
    '（阈值 ≤', TH.spill, '，贴花绝不该画到投影盒外）');
  console.log('  溢出到选中区外   =', outsideRatio.toFixed(5), '（参考量）');
  console.log('  [对照] 旧口径（OBB正对面AABB作分母）覆盖率 =', legacyCoverage.toFixed(4),
    ' 分母虚大倍数 =', (legacyArea / area).toFixed(2) + '×');

  const results = [
    ['① 选中区覆盖率', coverage, TH.coverage, coverage >= TH.coverage],
    ['② 选中区填充比', bboxRatio, TH.fill, bboxRatio >= TH.fill],
    ['③ 主色相差', hueD, TH.hue, hueD != null && hueD <= TH.hue],
    ['④ 孤立点率', isoRate, TH.isolated, isoRate <= TH.isolated],
    ['⑤ OBB 外溢出率', spillRatio, TH.spill, spillRatio <= TH.spill]
  ];
  console.log('\n===== F. 判定 =====');
  let pass = true;
  for (const [n, v, th, ok] of results) {
    console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + n + ' = ' +
      (v == null ? 'N/A' : v.toFixed(4)) + '  阈值 ' + th);
    if (!ok) pass = false;
  }
  const dbgInfo = await dbg();
  console.log('  渲染诊断 =', JSON.stringify({
    degraded: dbgInfo?.degraded, gpuErrors: dbgInfo?.gpuErrors,
    scopedErrors: dbgInfo?.scopedErrors, foreignErrors: dbgInfo?.foreignErrors,
    pickReady: dbgInfo?.pickReady, pickSize: dbgInfo?.pickSize,
    demoMode: dbgInfo?.demoMode, instances: dbgInfo?.instances
  }));
  /* GPU 侧 uniform 快照：JS 侧 debug() 的 pickReady=true 只说明 CPU 标记，
     不等于 shader uniform 真的被 onPrerender 注入。WebGL2 下若 uPickReady
     仍为初值 0，shader 首行 discard 会让 quad 完全不产出片元。 */
  const uni = await E(`(()=>{const W=${DOC},m=W.__mgEditor?.decalMgr;
    const it=m&&m.instances&&m.instances.values().next().value;
    if(!it||!it.material)return null;
    const p=it.material.parameters;
    const get=k=>{let v=p instanceof Map?p.get(k):p?.[k];
      if(!v)return null;
      const d=v.data!==undefined?v.data:(v.value!==undefined?v.value:null);
      return ArrayBuffer.isView(d)?Array.from(d):d;};
    return {pickReady:get('uPickReady'),uResolution:get('uResolution'),
      uDebugMode:get('uDebugMode'),uShadowReady:get('uShadowReady'),
      uPickSize:get('uPickSize'),uUVSignY:get('uUVSignY'),
      paramCount:p instanceof Map?p.size:Object.keys(p||{}).length};})()`);
  console.log('  GPU uniform 快照 =', JSON.stringify(uni));
  if (errors.length) {
    console.log('\n  页面错误（按阶段）：');
    errors.slice(0, 8).forEach((e, i) => {
      console.log('   - [' + (errStages[i] || '?') + '] ' + String(e).replace(/\s+/g, ' ').slice(0, 160));
    });
  }

  const report = {
    decalId: DECAL_ID, selRect: SEL_RECT, projector: proj, surface,
    cover: { sel, obbAll, obbFront },
    area, changed, changedAll, noiseOnly,
    coverage, bboxRatio, hueVisible, hueDelta: hueD, isoRate: isoRate,
    outsideRatio, spillRatio, legacyCoverage,
    thresholds: TH, pass, errors: errors.slice(0, 10)
  };
  fs.writeFileSync(path.join(ROOT, 'tools', 'probe-real-report.json'),
    JSON.stringify(report, null, 2));
  console.log('\n结果已写入 tools/probe-real-report.json');
  console.log(pass ? '\n★ 全部 PASS' : '\n✗ 存在未达标项');
  return pass;
}

main().then(p => { cleanup(); process.exit(p ? 0 : 1); })
  .catch(e => { console.error('探针失败:', e.message || e); cleanup(); process.exit(2); });

/**
 * iframe 内「标注编辑器」生命周期桥。
 *
 * 浏览态：本文件常驻但只有 2 KB，不 import 编辑器主体，零渲染开销。
 * 编辑态：父页 index.html 的融合层点「标注编辑」后发 postMessage，
 *         这里才动态 import('./editor.js') 并挂载编辑器 UI。
 *
 * 为什么不把编辑器放父页：编辑器必须和 PlayCanvas 相机、碰撞 MESH、
 * #mg-stage 画布同处一个文档，才能直接读世界坐标并做 worldToScreen 投影；
 * 跨 iframe 传屏幕坐标会带来 DPR / zoom / 缩放舞台三重误差。
 */
let api = null;
let mounted = false;
let pending = false;
let token = 0;
let stage = 'idle';      // 挂载阶段标记，便于现场排障 / 自动化回归
// 耗时打点：进入编辑的延迟主要来自「模块求值要等主线程空窗」，
// 3DGS 渲染循环越重延迟越大。留一组时间戳方便在真机/远端定位。
const marks = { preloadStart: 0, preloadDone: 0, enterAt: 0, imported: 0, mountedAt: 0, mountMs: 0 };

function post(type, extra = {}) {
  try { parent.postMessage({ type, ...extra }, '*'); } catch (_) { /* 跨域兜底 */ }
}

/** 编辑态开合的文档内广播。
 *  浏览态标注层（browse-annotations.js）复用编辑器 Overlay 渲染，产出同前缀
 *  `.ed-item` / `.ed-g` DOM；而编辑器的回归断言假设这些节点只由编辑器产生，
 *  所以必须在「类名切换的同一任务内」同步销毁 / 重建浏览层，不能等下一帧。 */
function dispatchMode(on) {
  try {
    document.dispatchEvent(new CustomEvent(on ? 'mg-editor-on' : 'mg-editor-off'));
  } catch (_) { /* 老浏览器无 CustomEvent 构造器时忽略 */ }
}

// 用 import.meta.url 明确解析模块路径；editor.js 不再反向 import 本模块，
// 因此模块图无环，动态导入不会在「模块求值中」时序下挂起。
const EDITOR_URL = new URL('./editor.js', import.meta.url).href;

/* ---------------------------------------------------------------------------
 * 主线程让路机制
 *
 * 3DGS 渲染循环（PlayCanvas app.tick）会长时间占满主线程，而 ES 模块的
 * **求值**（执行模块顶层代码）必须排进主线程的任务队列。实测在渲染重的
 * 场景里，editor.js 的求值会被推迟 6~8 秒：
 *     渲染开着   -> import 耗时 6416 ms
 *     暂停渲染   -> import 耗时    0 ms
 * 网络和编译都不是瓶颈（服务端响应 12 ms，modulepreload 后 9 个文件
 * 在解析期 3~9 ms 就下载完）。
 *
 * 所以：进入编辑模式时把 autoRender 短暂关掉，给模块求值让出主线程，
 * 求值完成后立刻恢复渲染。停掉的只是「绘制」，WebGL/WebGPU 上下文、
 * 已解码的高斯数据、相机状态全部保留，用户感知不到黑屏或重载。
 * -------------------------------------------------------------------------- */
let renderPaused = false;
let autoRenderBefore = null;

function getApp() {
  try {
    const v = window.__viewer;
    const app = v?.app || v?.app?.app;
    return app && typeof app === 'object' ? app : null;
  } catch (_) { return null; }
}

function pauseRender() {
  if (renderPaused) return;
  const app = getApp();
  if (!app || typeof app.autoRender !== 'boolean') return;
  autoRenderBefore = app.autoRender;
  app.autoRender = false;
  renderPaused = true;
}

function resumeRender() {
  if (!renderPaused) return;
  const app = getApp();
  if (app && typeof app.autoRender === 'boolean' && autoRenderBefore !== null) {
    app.autoRender = autoRenderBefore;
  }
  renderPaused = false;
  autoRenderBefore = null;
}
async function mount(msg = {}) {
  if (mounted || pending) return;
  const my = ++token;
  pending = true;
  stage = 'start';
  marks.enterAt = performance.now();
  document.documentElement.classList.add('mg-editor-on');
  dispatchMode(true);                      // 同步撤掉浏览态标注层，避免 DOM 撞车
  // 让出主线程：模块求值 + 编辑器 UI 构建期间暂缓绘制
  pauseRender();
  try {
    stage = 'import';
    const mod = await import(EDITOR_URL);
    stage = 'imported';
    marks.imported = performance.now();
    if (my !== token) return;                 // 导入期间已收到退出指令
    api = await mod.mount({ scene: msg.scene, page: msg.page });
    stage = 'mounted';
    marks.mountedAt = performance.now();
    marks.mountMs = Math.round(marks.mountedAt - marks.enterAt);
    if (my !== token) { try { api?.unmount?.(); } catch (_) {} api = null; return; }
    mounted = true;
    // 求值与 UI 构建完成，恢复渲染
    resumeRender();
    // 下一帧立即重绘，避免停渲染期间积累的移动没有体现
    try {
      const app = getApp();
      if (app) app.renderNextFrame = true;
    } catch (_) { /* noop */ }
    post('mg-editor-mounted', { ok: true, ms: marks.mountMs });
  } catch (err) {
    if (my !== token) return;
    resumeRender();
    stage = 'error: ' + String(err?.message ?? err);
    document.documentElement.classList.remove('mg-editor-on');
    dispatchMode(false);                   // 挂载失败也要把浏览态标注层还回去
    console.error('[editor-bridge] 挂载失败', err);
    post('mg-editor-mounted', { ok: false, error: String(err?.message ?? err) });
  } finally {
    if (my === token) pending = false;
  }
}

function unmount() {
  // 即使 mount 的动态导入仍在挂起，也要把状态清干净，允许下次重新进入
  token += 1;
  pending = false;
  stage = 'unmounted';
  resumeRender();                            // 异常路径也必须把渲染还回去
  try { api?.unmount?.(); } catch (err) { console.warn('[editor-bridge] 卸载异常', err); }
  api = null;
  mounted = false;
  document.documentElement.classList.remove('mg-editor-on');
  dispatchMode(false);                     // 重读 localStorage，把刚编辑的标注显示出来
  post('mg-editor-unmounted');
}

window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || typeof d !== 'object') return;
  if (d.type === 'mg-editor-enter') mount(d);
  else if (d.type === 'mg-editor-exit') unmount();
});

/** 编辑器 UI 的「退出编辑」按钮调用，请求父页切回浏览态 */
export function requestExit() {
  post('mg-editor-exit-request');
}

window.__mgEditorBridge = {
  get mounted() { return mounted; },
  get pending() { return pending; },
  get stage() { return stage; },
  get marks() { return { ...marks }; },
  get editorUrl() { return EDITOR_URL; },
  get api() { return api; },
  // 父页可跨 iframe 同步调用（不经 postMessage 队列），用于在发出
  // 'mg-editor-enter' 之前先给 iframe 的主线程让路。
  suspendRender: pauseRender,
  resumeRender,
  mount, unmount, requestExit
};

// 浏览态空闲时预编译编辑器模块（只 import，不 mount、不建 UI、不取示例数据）。
// 首次动态 import 约 1~1.5s，预载后点「标注编辑」几乎瞬时出现编辑 UI。
// 预编译 + 预求值编辑器模块（只 import，不 mount、不建 UI、不取示例数据）。
//
// 为什么必须提前「求值」而不只是预下载：
// modulepreload 只负责下载+编译，模块的首次求值仍要占用主线程；
// 3DGS 渲染循环会长时间占满主线程（实测大场景单帧可达数百毫秒），
// 模块求值任务只能排队等渲染空窗，用户点「标注编辑」后要等上好几秒。
// 这里在桥接脚本加载后立刻 import 一次，让模块在用户空闲时完成求值并进模块缓存，
// 之后用户点击时 import() 直接命中缓存，几乎瞬时进入编辑态。
// editor/ 目录全部 9 个文件合计约 70 KB，求值耗时可忽略。
const preload = () => {
  if (marks.preloadStart) return;             // 只触发一次
  marks.preloadStart = performance.now();
  import(EDITOR_URL).then(() => { marks.preloadDone = performance.now(); }).catch(() => {});
};
if (typeof window.requestIdleCallback === 'function') {
  // 立刻求值；idle 只是给一次补跑机会（若首帧异常被中断）
  preload();
  window.requestIdleCallback(preload, { timeout: 6000 });
} else {
  preload();
  setTimeout(preload, 2500);
}

// 告诉父页「本 iframe 已就绪」：父页若已处于编辑模式，会补发 enter 指令，
// 覆盖「iframe 比按钮点击更晚加载完」的时序。
post('mg-editor-ready');

// 独立调试入口：直接打开 gs-viewer.html?edit=1 也能进编辑态
if (new URLSearchParams(location.search).get('edit') === '1') {
  setTimeout(() => mount({}), 300);
}

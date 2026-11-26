import { createViewer } from './viewer/index.js';
import './lcc2-collision.js';
import { initWalkControls } from './walk-controls.js';
import { initCollisionDebug } from './collision-debug.js';
import { initRouteRecorder } from './route-recorder.js';
import { initMiniMap } from './mini-map.js';
import { initDepthView } from './depth-view.js';
import {
  IS_LCC2, SOURCE_MODE, STREAM_HUD, LOG_SPACE, IS_METRIC, MASK_CHUNKS,
  resolveLcc2Content, startStreamProbe, markLoaded, mountStreamHud
} from './lcc2-stream.js';

// 碰撞网格修复后渲染世界是米制（1 单位 = 1 m），漫游物理常量同步用米制。
// 旧值是给 log 压缩空间标定的（眼高 ln(2.6)=0.956、重力 3.6），在米制世界
// 里会把相机顶到半空、胶囊半径也偏小。保持原版「高 - 半径 = 眼高」比例。
globalThis.__MG_WALK = {
  capsuleHeight: 1.8,
  capsuleRadius: 0.30,
  eyeHeight: 1.6,
  gravity: 9.8,
  jumpSpeed: 4.0,
  moveGroundSpeed: 4.0,
  moveAirSpeed: 1.2,
  moveSpeed: 3.0,
  lodBaseDistance: 8.0
};

const params = new URLSearchParams(location.search);
const videoMode = params.get('video') === '1';
// 嵌入展览馆首页时，楼层切换由首页统一驱动，本页不再显示重复的场景按钮
const embedMode = params.get('embed') === '1';
/* ---------- 场景资产：默认加载原始（未清理）SOG ----------
   mm_floor*.sog 是 splat-transform 从 XGrids .lcc2 的 LOD0 直接转出的原始资产，
   未做任何过滤或尺度钳制。
   早前由 sog_clean.py 生成的 *_clean.sog（删掉 15.9% 的低 alpha / 大尺度高斯）
   不再作为默认：实测同机位对比，删除低 alpha 点会让墙面 alpha 累积不足、透出
   深色背景而"发黑"（暗部占比 8.0% → 10.8%，高频能量 3.62 → 4.27）。
   需要对照其它版本时用 ?content=./sog/xxx.sog 显式指定。 */
const SCENE_ASSETS = {
  floor1: './sog/mm_floor1.sog',
  floor3: './sog/mm_floor3.sog'
};
const SCENE_INFO = {
  floor1: '8.87M 点 · 原始未清理（LCC LOD0）',
  floor3: '2.38M 点 · 原始未清理（LCC LOD0）'
};
/* ---------- 流式 LCC 数据（合并自 viewer_stream） ----------
   同一份 XGrids 工程的另一条链路：不导出整包 SOG，而是把原始 .lcc2 八叉树
   翻译成引擎可消费的 lod-meta.json，运行时按相机视锥 / LOD 距离按需请求
   data/3dgs/*.sog 分块。默认仍是单文件 SOG，`?source=lcc2` 切到流式：
     · data/3dgs/*.sog   官方 LOD 分块（**原样**，即 lcc2-sog-result/data/3dgs）
     · lod-meta.json     引擎索引（米制 tree.bound；_log/ 是旧 log 域缺陷复现用）
     · meta.lcc2         权威八叉树索引，运行时与之逐项校验
   `?stream=1` 额外挂流式观测 HUD，`?budget=N` 覆盖渲染预算（百万）。
   `?space=log` 回到旧错位坐标域做 A/B（仅诊断，不建议）。
   `?mask=1` 才切到 <scene>_masked/ 的「超大高斯透明化」对照版 —— 默认不用，
   那一版远景会发暗（室内机位均值 83 → 69），只是 A/B 素材。 */
const LOD_DIR = (sc) => './sog/' + sc + (LOG_SPACE ? '_log' : (MASK_CHUNKS ? '_masked' : ''));
const LOD_META = (sc) => LOD_DIR(sc) + '/lod-meta.json';
// 权威索引固定在原始分块目录（与官方导出目录同名，_masked / _log 只是变体）
const LCC2_META = (sc) => './sog/' + sc + '/meta.lcc2';
// 两个完整 LOD0 单文件 SOG；三楼是 exe 默认场景。
// 一楼既有室外广场 / 柱廊，也有室内接待台大厅（后者见 spawnPoints.floor1）。
// 出生点改为全局三选一，位姿统一在 ./sog/<scene>/scene-meta.json 维护。
// 2026-11-07 修订：z≈0.5m 连续高层地坪是室外建筑侧铺装，不再当作「室内」。
const SCENES = {
  floor1: {
    name: '1 层',
    detail: '8.87M 高斯 · 完整 LOD0 单文件 · 112.9 MB · 原始未清理',
    content: SCENE_ASSETS.floor1,
    lcc2: LCC2_META('floor1'),
    lodMeta: LOD_META('floor1'),
    settings: './viewer/settings-floor1.json',
    collision: './sog/floor1/collision-manifest.json',
    poster: './sog/floor1/info/thumb.jpg'
  },
  floor3: {
    name: '3 层',
    detail: '2.38M 高斯 · 完整 LOD0 单文件 · 33.1 MB · 原始未清理',
    content: SCENE_ASSETS.floor3,
    lcc2: LCC2_META('floor3'),
    lodMeta: LOD_META('floor3'),
    settings: './viewer/settings-floor3.json',
    collision: './sog/floor3/collision-manifest.json',
    poster: './sog/floor3/info/thumb.jpg'
  }
};
/* ---------- 顶栏三个按钮 = 三个全局出生点 ----------
   outdoor -> 1层室外，lcc2 官方室外出生点
   floor1  -> 1层室内，用户 2026-11-09 标定的 1 层接待台机位
   floor3  -> 三层室内，3 层官方出生点
   按钮同时带 data-scene / data-spawn，点一次直达对应机位；具体位姿统一由
   ./sog/<scene>/scene-meta.json 的 spawnPoints[key] 提供，便于现场标定。 */
const SPAWN_META = {
  outdoor: { scene: 'floor1', label: '1层室外' },
  floor1: { scene: 'floor1', label: '1层室内' },
  floor3: { scene: 'floor3', label: '三层室内' }
};
const spawnParam = params.get('spawn');
const sceneParam = params.get('scene');
const spawnScene = SPAWN_META[spawnParam]?.scene ||
  (spawnParam === 'indoor' ? 'floor1' : null);
const scene = SCENES[sceneParam] ? sceneParam : (spawnScene || 'floor3');
const cfg = SCENES[scene];
// ?spawn=indoor 是旧版「房间内」别名，现映射到 1 楼出生点
const spawnKey = SPAWN_META[spawnParam] ? spawnParam
  : (spawnParam === 'indoor' ? 'floor1'
     : (scene === 'floor1' ? 'floor1' : 'floor3'));

/* ---------- 流式渲染预算（单位：百万 splats，?budget=N 可覆盖） ----------
   引擎默认 4M 是硬上限：低于 LOD0 全树点数时，GSplatBudgetBalancer 只能按距离
   把预算分给近处少数节点，中远节点被钉在最粗档甚至根本不请求对应分块 ——
   表现是「站定不动四周大片空洞，走近才慢慢冒出来」。viewer_stream 实测
   （STREAM_TEST.md 第 13 节）：一层 4M→7/32 分块有空洞、9M 以上 18/32 分块
   画面完整；三层 LOD0 只 2.38M，默认 4M 已够，不动它。
   1.1 倍余量用来覆盖环境球等固定层。 */
const SCENE_FINEST_M = { floor1: 8.862771, floor3: 2.379502 };
const budgetParam = Number(params.get('budget'));
const STREAM_BUDGET = Number.isFinite(budgetParam) && budgetParam > 0
  ? Math.min(64, budgetParam)
  : (IS_LCC2 && !LOG_SPACE && SCENE_FINEST_M[scene] > 4
    ? Math.ceil(SCENE_FINEST_M[scene] * 1.1) : null);
globalThis.__MG_BUDGET = IS_LCC2 ? STREAM_BUDGET : null;
globalThis.__MG_SOURCE = SOURCE_MODE;

// 观测器必须在模块顶层启动：PerformanceObserver(buffered) 才能抓到页面加载
// 以来已经完成的分块请求，首帧时间也才是相对页面导航的绝对值。
startStreamProbe();
if (STREAM_HUD) mountStreamHud();
if (IS_LCC2 && params.get('content')) {
  console.warn('[viewer] ?content= 只在单文件 SOG 模式生效，需要时加 ?source=sog');
}

/* ---------- 嵌入模式：首页楼层导航是唯一的场景 / 机位入口 ----------
   同一场景（室外 ↔ 一层）只切换出生点，不重新加载 90+ MB 的 SOG；
   跨场景由首页改 iframe src 重载。viewer 尚未就绪时先排队，
   等高斯场景加载完成再应用，避免首页在加载期间切楼层丢消息。 */
let sceneMeta = null;
let embedViewer = null;
let embedPendingSpawn = null;
window.__mgEmbed = {
  scene,
  spawn: spawnKey,
  paused: false,
  /* SPA 融合层把非活动楼层的 Viewer 退到后台时，关掉 PlayCanvas 的
     autoRender：WebGL/WebGPU 上下文与已解码的高斯数据全部保留，但不再
     占用 GPU 绘制。切回前台时再打开，实现跨楼层零重载、零重复解码。 */
  setPaused(on) {
    window.__mgEmbed.paused = !!on;
    if (!embedViewer) return false;   // 未就绪时由 createViewer 完成后应用
    try { embedViewer.app.autoRender = !on; return true; }
    catch (_) { return false; }
  },
  setSpawn(key) {
    const meta = SPAWN_META[key];
    if (!meta || meta.scene !== scene) return false;
    if (!embedViewer) {
      // 场景还在加载：记录目标机位，viewer 就绪后自动应用
      embedPendingSpawn = key;
      window.__mgEmbed.spawn = key;
      return true;
    }
    const sp = sceneMeta?.spawnPoints?.[key];
    if (!sp?.worldPosition || !sp?.worldTarget) return false;
    embedViewer.setCameraPose?.(sp.worldPosition.slice(), sp.worldTarget.slice(), sp.fov || 72);
    window.__mgEmbed.spawn = key;
    const el = document.getElementById('mg-tools-scene');
    if (el && meta.label) el.textContent = meta.label;
    return true;
  },
  /* 内容卡片「飞到此厅」：不重载 SOG，只把常驻 Viewer 的相机移到
     exhibits.json 标定过的可达机位。 */
  setCameraPose(pos, target, fov) {
    if (!embedViewer || !pos?.length || !target?.length) return false;
    try {
      embedViewer.setCameraPose?.(pos.slice(), target.slice(), fov || 75);
      return true;
    } catch (_) { return false; }
  }
};
window.addEventListener('message', (e) => {
  if (e.source !== window.parent || e.data?.type !== 'mg-set-spawn') return;
  window.__mgEmbed.setSpawn(e.data.spawn);
});

// 两种数据源落在**同一个米制世界**（相机 / 碰撞网格 / 出生点 / 漫游路径复用），
// 但 SOG 内部存储的轴向不同，所以旋转不能共用：
//  · 单文件 mm_floor*.sog 由 splat-transform 导出，存储值已转过一次，需 Rx(180)；
//  · .lcc2 分块是 XGrids 原始米制 Z-up，Rx(-90) 得 world = (x, z, -y)，
//    与碰撞网格 world=(x,z,-y) 的轴变换一致。
const SPLAT_ROTATION = IS_LCC2 ? [-90, 0, 0] : [180, 0, 0];

const SPAWN_KEY = 'mgSpawn_';
// 碰撞检测默认开启：碰撞网格已改为米制轴变换，与 3DGS / 出生点同处一个
// 世界，胶囊贴地、墙体阻挡均正常。?collision=0 可切回自由飞行；碰撞数据
// 始终完整加载，工具栏「碰撞体」的可视化与诊断照样可用。
const collisionDefaultOn = params.get('collision') !== '0';

const $ = (id) => document.getElementById(id);

// 局域网 http://<IP> 不是安全上下文，navigator.clipboard 不可用；统一回退到
// execCommand，保证「复制位姿 / 播放链接 / 局域网地址」在局域网下也能用。
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { /* noop */ }
    ta.remove();
    return ok;
  }
}
window.__mgCopyText = copyText;
const stage = $('mg-stage');
const loading = $('mg-loading');
const badge = $('mg-gpu');

/* ---------- 顶栏：三个按钮各自直达对应出生点 ---------- */
document.querySelectorAll('.mg-scene').forEach((btn) => {
  const key = btn.dataset.spawn;
  const dst = SPAWN_META[key];
  if (!dst) return;
  btn.classList.toggle('mg-on', key === spawnKey);
  btn.title = SCENES[dst.scene].detail;
  btn.addEventListener('click', () => {
    const q = new URLSearchParams(params);
    q.set('scene', dst.scene);
    q.set('spawn', key);
    q.delete('pos'); q.delete('look'); q.delete('path');
    location.href = '?' + q.toString();
  });
});
$('mg-loadsub').textContent = '正在载入「' + (SPAWN_META[spawnKey]?.label || cfg.name) + '」· ' +
  (IS_LCC2
    ? '原始 .lcc2 八叉树分块流式加载（按视野 LOD 按需请求）'
    : '完整 LOD0 单文件 · 原始未清理') + '，首次加载需稍等';

/* ---------- 顶栏：全屏 / 帮助 ---------- */
$('mg-full').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
});
const helpbox = $('mg-helpbox');
$('mg-help').addEventListener('click', () => { helpbox.hidden = !helpbox.hidden; });
$('mg-helpclose').addEventListener('click', () => { helpbox.hidden = true; });

/* ---------- 资产信息：默认已是原始数据，清理切换已整体移除 ----------
   站点只携带原始 SOG（或 ?source=lcc2 的官方原始 LOD 分块），`?clean=1` 的
   历史链接也不再能切到清理版；顶栏清理按钮与 G 键一并移除，避免留下点了
   没反应的死控件；工具面板「清理」标签页只保留当前资产说明。 */
const cleanInfoEl = $('mg-clean-info');
if (cleanInfoEl) {
  cleanInfoEl.textContent = IS_LCC2
    ? '原始 .lcc2 分块 · ' + (SCENES[scene].detail || '')
    : SCENE_INFO[scene];
}

/* ---------- 出生点标定工具 ---------- */
// createViewer 完成后赋值；面板由用户触发，取到的始终是最新相机。
let activeViewer = null;
const toolsbox = $('mg-toolsbox');
$('mg-tools-scene').textContent = SPAWN_META[spawnKey].label;

function currentPose() {
  const cam = activeViewer?.app?.root?.findComponent('camera');
  if (!cam?.entity) return null;
  const e = cam.entity.getPosition();
  const f = cam.entity.forward || { x: 0, y: 0, z: -1 };
  return {
    position: [e.x, e.y, e.z],
    target: [e.x + f.x, e.y + f.y, e.z + f.z],
    fov: cam.fov ?? 75
  };
}

const fmtVec = (v) => v.map((x) => (+x).toFixed(6)).join(',');

// 三个按钮各存一份标定机位，避免 1层室外 / 1层室内 共用同一场景 key 互相覆盖。
function savedSpawn() {
  try { return JSON.parse(localStorage.getItem(SPAWN_KEY + spawnKey) || 'null'); }
  catch (_) { return null; }
}

function setToolMsg(text) {
  const el = $('mg-tool-msg');
  if (!el) return;
  el.textContent = text;
  clearTimeout(setToolMsg._t);
  setToolMsg._t = setTimeout(() => { el.textContent = ''; }, 4000);
}

function refreshSpawnInfo() {
  const box = $('mg-spawn-info');
  if (!box) return;
  const p = currentPose(), s = savedSpawn();
  box.textContent =
    (p ? '当前相机\n  pos  = ' + fmtVec(p.position) + '\n  look = ' + fmtVec(p.target) + '\n'
       : '相机尚未就绪\n') +
    ((s?.position && s?.target)
      ? '已存出生点\n  pos  = ' + fmtVec(s.position) + '\n  look = ' + fmtVec(s.target)
      : '出生点：内置默认（未在本机标定）');
}

function spawnUrl(p) {
  const q = new URLSearchParams(params);
  q.set('scene', scene);
  q.set('pos', fmtVec(p.position));
  q.set('look', fmtVec(p.target));
  q.delete('spawn');
  return location.origin + location.pathname + '?' + q.toString();
}

function refreshActiveTab() {
  const tab = document.querySelector('.mg-tooltab.mg-on')?.dataset.tab;
  if (tab === 'spawn') refreshSpawnInfo();
  else if (tab === 'collision') window.__mgCollisionDebug?.refresh();
  else window.__mgRoute?.refresh();
}
$('mg-tools').addEventListener('click', () => {
  toolsbox.hidden = !toolsbox.hidden;
  if (!toolsbox.hidden) refreshActiveTab();
});
$('mg-toolsclose').addEventListener('click', () => { toolsbox.hidden = true; });

/* ---------- 局域网访问地址 ---------- */
const lanBox = $('mg-lanbox');
$('mg-lan').addEventListener('click', async () => {
  lanBox.hidden = !lanBox.hidden;
  if (lanBox.hidden) return;
  let doc = null;
  try { doc = await fetch('./__server_info.json').then((r) => r.json()); }
  catch (_) { /* 静态预览服务没有该端点 */ }
  const share = doc?.lanUrl || doc?.localUrl || location.origin + '/';
  $('mg-lan-info').textContent = doc
    ? '绑定   ' + (doc.lan ? '0.0.0.0（允许局域网）' : '127.0.0.1（仅本机）') +
      '\n端口   ' + doc.port +
      '\n本机   ' + doc.localUrl +
      '\n局域网 ' + (doc.lanUrl || '（未检测到 IP，请用本机网卡 IP）') +
      '\n\n可分享：' + share
    : '当前地址 ' + location.origin + '/\n（静态预览服务不提供局域网信息）\n\n可分享：' + share;
  lanBox.dataset.url = share;
  $('mg-lan-msg').textContent = doc?.lan ? '' :
    '当前服务仅本机可访问，重启时去掉 --local-only';
});
$('mg-lanclose').addEventListener('click', () => { lanBox.hidden = true; });
$('mg-lan-copy').addEventListener('click', async () => {
  const u = lanBox.dataset.url || location.origin + '/';
  $('mg-lan-msg').textContent = (await copyText(u)) ? '地址已复制' : '复制失败，请手动选中上方地址';
});

document.querySelectorAll('.mg-tooltab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mg-tooltab').forEach((b) =>
      b.classList.toggle('mg-on', b === btn));
    document.querySelectorAll('.mg-toolsection').forEach((s) => {
      s.hidden = s.dataset.section !== btn.dataset.tab;
    });
    refreshActiveTab();
  });
});
$('mg-save-spawn').addEventListener('click', () => {
  const p = currentPose();
  if (!p) { setToolMsg('相机尚未就绪'); return; }
  try { localStorage.setItem(SPAWN_KEY + spawnKey, JSON.stringify(p)); } catch (_) { /* 隐私模式 */ }
  refreshSpawnInfo();
  setToolMsg('已设为「' + SPAWN_META[spawnKey].label + '」机位，下次点该按钮自动生效');
});
$('mg-copy-spawn').addEventListener('click', async () => {
  const p = currentPose();
  if (!p) { setToolMsg('相机尚未就绪'); return; }
  const url = spawnUrl(p);
  if (await copyText(url)) setToolMsg('位姿 URL 已复制到剪贴板');
  else {
    $('mg-spawn-info').textContent = url;
    setToolMsg('位姿 URL 已显示在下方');
  }
});
$('mg-reset-spawn').addEventListener('click', () => {
  try { localStorage.removeItem(SPAWN_KEY + spawnKey); } catch (_) { /* 隐私模式 */ }
  refreshSpawnInfo();
  setToolMsg('已恢复内置出生点');
});
// CDP / 控制台可直接读取当前机位，供现场标定与回归测试
window.__mgPose = currentPose;

/* ---------- 渲染器选择：WebGPU 优先，失败自动回退 WebGL2 ----------
   WebGPU 只在安全上下文可用：http://127.0.0.1 / localhost / https 才算。
   用局域网 IP（http://172.16.x.x）打开时 navigator.gpu 会被浏览器隐藏，
   即使显卡与浏览器都支持 WebGPU，也只能走 WebGL2。这里把具体原因显示在
   顶栏徽标上，并允许清除回退标记重试，避免「一次失败后同一标签页永远
   WebGL2」；同时不再把 renderer=webgl 写进地址栏污染链接。 */
let renderer = 'webgl';
let rendererReason = '';
const gpuDiag = {
  secure: isSecureContext, hasGpu: !!navigator.gpu,
  host: location.host, adapter: null, error: null
};

async function pickRenderer() {
  const forced = params.get('renderer');
  if (forced === 'webgpu') {
    sessionStorage.removeItem('mg_fallback');
    rendererReason = 'URL 指定';
    return forced;
  }
  if (forced === 'webgl') { rendererReason = 'URL 指定'; return forced; }
  if (!isSecureContext) { rendererReason = '非安全上下文'; return 'webgl'; }
  if (sessionStorage.getItem('mg_fallback')) {
    rendererReason = '上次回退，点此重试';
    return 'webgl';
  }
  if (!navigator.gpu) { rendererReason = '浏览器未启用 WebGPU'; return 'webgl'; }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) { rendererReason = '无可用 GPU 适配器'; return 'webgl'; }
    const info = adapter.info || {};
    gpuDiag.adapter = {
      vendor: info.vendor || '', architecture: info.architecture || '',
      fallback: !!adapter.isFallbackAdapter
    };
    rendererReason = gpuDiag.adapter.fallback ? '软件适配器' : '硬件加速';
    return 'webgpu';
  } catch (e) {
    rendererReason = '适配器创建失败';
    gpuDiag.error = String(e?.message ?? e);
    return 'webgl';
  }
}

function fallbackToWebGL(reason) {
  if (renderer !== 'webgpu' || sessionStorage.getItem('mg_fallback')) return;
  sessionStorage.setItem('mg_fallback', reason || 'WebGPU 初始化失败');
  const q = new URLSearchParams(params);
  q.delete('renderer');
  const qs = q.toString();
  location.replace(location.pathname + (qs ? '?' + qs : ''));
}

/* ---------- 启动遮罩：等真实首帧再淡出 ----------
   旧逻辑在 canvas DOM 出现（或 600ms）后就淡出遮罩，但 90MB SOG 的解码 /
   GPU 上传要数秒：这段时间画布只有深蓝黑 clearColor，用户看到的就是
   「黑屏」。真机时间线实测 1.5s / 3s 时 gsplats=0 而遮罩 opacity 已是 0，
   5s 才有首帧。这里统一由 revealLoading 收口，只有首帧（frameend 之后，
   gsplats>0）或加载失败 / 超时才淡出，避免任何路径永久卡在遮罩上。 */
let loadingRevealed = false;
function revealLoading(reason) {
  if (loadingRevealed) return;
  loadingRevealed = true;
  loading.classList.add('mg-hide');
  loading.dataset.reveal = reason || 'unknown';
  let gsplats = null;
  try { gsplats = window.__viewer?.app?.stats?.frame?.gsplats ?? null; } catch (_) { /* noop */ }
  // 供真机诊断 / 回归断言读取：淡出原因与当时的渲染点数。
  // firstFrame 在 frameend 里 fire，此刻 stats 可能尚未落盘，故下方会补采一次。
  window.__mgLoading = {
    revealed: true, reason: reason || 'unknown',
    atMs: Math.round(performance.now()), gsplats
  };
}
function showError(msg) {
  const box = $('mg-error');
  box.hidden = false;
  box.textContent = '场景载入失败：' + msg + '。请确认使用 Chrome / Edge 并开启硬件加速后重试。';
  revealLoading('error');
}

/* 首帧门控： Viewer 在 events 上 fire('firstFrame') 时第一帧已经 frameend；
   同时轮询实际渲染的 gsplats，覆盖「事件早于订阅 / 事件通道异常」的情况；
   30s 超时兜底，慢网络或后端异常也不会让遮罩永久挡住页面。 */
function installFirstFrameGate(viewer) {
  let done = false;
  const finish = (reason) => {
    if (done) return;
    done = true;
    revealLoading(reason);
    // firstFrame 在 frameend 回调里 fire，此刻 app.stats.frame.gsplats 可能仍
    // 是 0；补采一次，让诊断能自证「淡出后确实有高斯被渲染」。
    setTimeout(() => {
      try {
        const n = viewer?.app?.stats?.frame?.gsplats ?? 0;
        const info = window.__mgLoading;
        if (info && n > 0 && !info.gsplats) {
          info.gsplats = n;
          info.gsplatsConfirmedAtMs = Math.round(performance.now());
        }
      } catch (_) { /* noop */ }
    }, 250);
  };
  try {
    viewer?.events?.once?.('firstFrame', () => finish('firstFrame'));
  } catch (_) { /* noop */ }
  let tries = 0;
  const poll = () => {
    if (done) return;
    let n = 0;
    try { n = viewer?.app?.stats?.frame?.gsplats ?? 0; } catch (_) { /* noop */ }
    if (n > 0) { finish('gsplats'); return; }
    if (++tries < 150) setTimeout(poll, 200);
  };
  poll();
  setTimeout(() => {
    if (done) return;
    console.warn('[mg-loading] 30s 内未等到首帧，兜底淡出遮罩');
    finish('timeout');
  }, 30000);
}

/* ---------- 启动 Viewer ---------- */
(async () => {
  renderer = await pickRenderer();
  const webgpu = renderer === 'webgpu';
  badge.textContent = (webgpu ? 'WebGPU · ' : 'WebGL2 · ') + rendererReason;
  badge.className = 'mg-badge ' + (webgpu ? 'mg-ok' : 'mg-warn');
  badge.title = [
    '当前后端：' + (webgpu ? 'WebGPU' : 'WebGL2'),
    '判定原因：' + rendererReason,
    '安全上下文：' + gpuDiag.secure + '（' + gpuDiag.host + '）',
    'navigator.gpu：' + gpuDiag.hasGpu,
    gpuDiag.adapter
      ? 'GPU：' + gpuDiag.adapter.vendor + ' / ' + gpuDiag.adapter.architecture
      : '',
    gpuDiag.error ? '错误：' + gpuDiag.error : '',
    webgpu ? '' : '点此清除回退标记并重试 WebGPU（需 127.0.0.1 / localhost / HTTPS）'
  ].filter(Boolean).join('\n');
  window.__mgRenderer = { renderer, reason: rendererReason, ...gpuDiag };
  if (!webgpu && gpuDiag.secure && rendererReason !== 'URL 指定') {
    badge.style.cursor = 'pointer';
    badge.addEventListener('click', () => {
      sessionStorage.removeItem('mg_fallback');
      const q = new URLSearchParams(params);
      q.set('renderer', 'webgpu');
      location.href = '?' + q.toString();
    });
  }

  /* 数据源二选一：
     · sog（默认）—— params.get('content') 或原始单文件 SOG；
     · lcc2（?source=lcc2）—— 先解析原始 meta.lcc2 作权威索引并与
       lod-meta.json 逐项校验，再把 lod-meta.json 交给引擎；引擎按
       basename 选 GSplatOctreeParser，按视野 / LOD 距离按需请求分块 SOG。
     tools/compare_stream_vs_sog.mjs 会把同一机位的两条链路截图 + 像素统计。 */
  let contentUrl;
  if (IS_LCC2) {
    const lcc2 = await resolveLcc2Content(
      { content: cfg.lcc2, lodMeta: cfg.lodMeta }, scene);
    contentUrl = lcc2.contentUrl;
    console.info('[viewer] 流式入口', cfg.lodMeta,
      '· .lcc2 解析 ' + lcc2.parseMs + 'ms');
  } else {
    contentUrl = params.get('content') || SCENE_ASSETS[scene];
  }
  // 允许用 URL 覆盖出生点，便于现场标定 / 第三方微调：
  //   ?pos=x,y,z   相机世界坐标    ?look=x,y,z   视线目标点
  const settings = Promise.all([
    fetch(cfg.settings).then((r) => r.json()),
    // scene-meta.json 是一楼双出生点的唯一数据源；settings-floor1.json 已内置同样的
    // 官方室外默认值，因此这里读取失败也不影响默认出生点（只影响切到房间内）。
    fetch('./sog/' + scene + '/scene-meta.json').then((r) => r.json()).catch(() => null)
  ]).then(([s, meta]) => {
    sceneMeta = meta;
    const sp = meta?.spawnPoints?.[spawnKey];
    if (sp?.worldPosition && sp?.worldTarget) {
      const init = (s.cameras[0] || (s.cameras[0] = {})).initial ||
        (s.cameras[0].initial = { fov: 75 });
      init.position = sp.worldPosition.slice();
      init.target = sp.worldTarget.slice();
      if (sp.fov) init.fov = sp.fov;
    }
    // 本机「设为出生点」工具按当前按钮（spawnKey）保存的机位；三个按钮
    // 各存一份，互不覆盖。优先级仍低于下面的 ?pos / ?look。
    const saved = savedSpawn();
    if (saved?.position && saved?.target) {
      const init = (s.cameras[0] || (s.cameras[0] = {})).initial ||
        (s.cameras[0].initial = { fov: 75 });
      init.position = saved.position.slice();
      init.target = saved.target.slice();
      if (saved.fov) init.fov = saved.fov;
    }
    // 允许用 URL 覆盖出生点，便于现场标定 / 第三方微调，优先级最高：
    //   ?pos=x,y,z   相机世界坐标    ?look=x,y,z   视线目标点
    const vec = (key) => {
      const raw = params.get(key);
      if (!raw) return null;
      const v = raw.split(',').map(Number);
      return v.length === 3 && v.every(Number.isFinite) ? v : null;
    };
    const p = vec('pos'), t = vec('look');
    if (p || t) {
      const init = (s.cameras[0] || (s.cameras[0] = {})).initial ||
        (s.cameras[0].initial = { fov: 75 });
      if (p) init.position = p;
      if (t) init.target = t;
    }
    return s;
  });
  const options = {
    contentUrl,
    settings,
    // 单文件 SOG 由 engine 直接按 contentUrl 拉取，不做 octree 分块 prefetch
    contents: undefined,
    // 视频模式不挂载运行时碰撞：路径已由官方 PLY+btree 包围盒算好并逐帧校验，
    // 若再让 FlyController 的 SphereMover 推离相机，实际位姿会偏离可达路径。
    collisionUrl: videoMode ? undefined : cfg.collision,
    posterUrl: cfg.poster,
    splatRotation: SPLAT_ROTATION,
    ui: !videoMode,
    renderer,
    noanim: true,
    // 分块流式的渲染预算（百万点）；默认 undefined = 引擎默认档。
    budget: IS_LCC2 && STREAM_BUDGET ? STREAM_BUDGET : undefined,
    // ?fullload=1 跳过「首帧先钳制到最粗 LOD」的快速揭幕，供截图 / 画质优先场景
    fullload: params.get('fullload') === '1',
    exposeGlobals: false
  };
  // 与官方 standalone 页面保持一致，便于 Viewer 内部调试钩子读取
  window.sse = { options, settings };

  try {
    const viewer = await createViewer({ container: stage, ...options });
    // 调试/标定句柄：可在控制台读取 app、相机与场景包围盒
    window.__viewer = viewer;

    /* 流式 LOD：关掉引擎默认的人为包围盒收缩与「相机背后」距离惩罚。
       默认 lodDistanceShrink=0.75 会按「节点半尺寸超出全树中位数」收缩 AABB，
       而 XGrids 八叉树里存在父子包围盒完全相同 / 百米级巨型节点，收缩后相机
       走进节点内部时距离反而变大 —— 就是「本来正常加载的块，靠近了反而被裁剪
       不渲染」。lodBehindPenalty=1.5 会进一步放大误判。
       STREAM_TEST.md 第 12 节同机位实测：shrink=0 后 lap_var 572.6 → 619.2。 */
    const applyLodFix = () => {
      if (!IS_LCC2 || !IS_METRIC) return;
      const sg = viewer.app?.scene?.gsplat;
      if (!sg) return;
      sg.lodDistanceShrink = 0;
      sg.lodBehindPenalty = 1;
    };
    applyLodFix();
    // reveal 阶段引擎还会再 applySettings() 一次，兜底重设并给观测器打点
    const streamT0 = Date.now();
    const streamPoll = setInterval(() => {
      if (viewer.state?.loaded) {
        applyLodFix(); markLoaded(); clearInterval(streamPoll);
      } else if (Date.now() - streamT0 > 60000) clearInterval(streamPoll);
    }, 200);
    setTimeout(applyLodFix, 3500);

    activeViewer = viewer;
    embedViewer = viewer;
    if (window.__mgEmbed.paused) {
      try { viewer.app.autoRender = false; } catch (_) { /* noop */ }
    }
    if (embedPendingSpawn && embedPendingSpawn !== spawnKey) {
      window.__mgEmbed.setSpawn(embedPendingSpawn);
    }
    embedPendingSpawn = null;
    if (!toolsbox.hidden) refreshSpawnInfo();
    // 顶栏「碰撞开关 / 移动速度」控件（视频模式隐藏自有 UI，不初始化）
    if (!videoMode) initWalkControls(viewer, collisionDefaultOn);
    // ?collision=0 显式关闭时，碰撞体仍加载（供可视化调试），等 attachCollision
    // 完成后再从各控制器摘掉，避免与异步加载产生竞态。
    if (!collisionDefaultOn && !videoMode) {
      const t0 = Date.now();
      const offPoll = setInterval(() => {
        if (viewer.state?.hasCollisionOverlay) {
          clearInterval(offPoll);
          viewer.setCollisionEnabled?.(false);
        } else if (Date.now() - t0 > 30000) clearInterval(offPoll);
      }, 200);
    }
    // 工具栏「碰撞体调试」：网格线框 + 分块 AABB + 坐标系诊断
    initCollisionDebug(viewer, cfg.collision);
    // 工具栏「漫游录制」：采样相机 → 本机保存 → 回放 / JSON / WebM
    initRouteRecorder(viewer, { scene, params });
    // 每个场景一份三维导航小地图：碰撞网格简化的房间 / 墙 / 可达通道，
    // 并逐帧绘制当前相机位置与朝向。数据就是普通网页文件 ./sog/<scene>/nav-map.json。
    // 漫游视频模式也挂载小地图，让导出的视频自带实时三维导航小地图。
    initMiniMap({ scene, getPose: currentPose,
      label: SPAWN_META[spawnKey]?.label || cfg.name });
    // 实时深度图：两个独立视口，默认都关闭，可同时开并排对比 ——
    //   · 3DGS（N / 顶栏「深度」）：引擎 Picker 的 RGBA16F 深度视图（与贴花同源）；
    //   · 碰撞 Mesh（顶栏「Mesh深度」）：主相机视角把碰撞三角网格的线性深度写进
    //     离屏颜色目标，用来核对碰撞体与 splat 表面是否贴合。
    initDepthView({ getViewer: () => activeViewer });

    if (videoMode) {
      window.__mgMiniMap?.setFollow(false);   // 显示整层 + 相机标记，而非跟随放大
    }

    // 顶栏「小地图」开关按钮：默认开启（小地图默认可见）。状态与 M 键保持同步。
    const mapBtn = document.getElementById('mg-map');
    const mapState = document.getElementById('mg-map-state');
    const syncMapBtn = () => {
      const on = !document.getElementById('mg-minimap')?.classList.contains('mg-mm-hide');
      mapBtn?.classList.toggle('mg-on', on);
      if (mapState) mapState.textContent = on ? '开' : '关';
    };
    mapBtn?.addEventListener('click', () => {
      window.__mgMiniMap?.toggle();
      syncMapBtn();
    });

    /* 顶栏「深度」按钮：实时深度图独立视口（只用 Picker 深度视图 + GPU 采样，
       画布上单独一块矩形，不改主画面）。状态文本由 depth-view.js 自己同步。 */
    const depthBtn = document.getElementById('mg-depth');
    depthBtn?.addEventListener('click', () => {
      window.__mgDepth?.toggle();
      depthBtn.classList.toggle('mg-on', !!window.__mgDepth?.isOpen);
    });

    /* 顶栏「Mesh深度」按钮：碰撞网格深度视口。打开时若 3DGS 视口没开就顺手一起
       打开 —— 这个视口存在的意义就是并排对比，单开一个没参考。 */
    const meshBtn = document.getElementById('mg-mesh');
    meshBtn?.addEventListener('click', () => {
      const api = window.__mgMeshDepth;
      if (!api) return;
      const on = api.toggle();
      if (on && !window.__mgDepth?.isOpen) window.__mgDepth?.open();
      meshBtn.classList.toggle('mg-on', !!api.isOpen);
    });

    // ---- 逐帧漫游视频模式：加载可达性路径，按帧设定相机 ----
    if (videoMode) {
      document.body.classList.add('mg-video');
      window.__mgVideo = { ready: false, frames: 0, fps: 24, current: -1, error: null };
      (async () => {
        const api = window.__mgVideo;
        try {
          // 一楼路径变体：walk_path.json 从「1层室内」出生点出发闭环导览（默认）；
          // walk_path_gate.json / walk_path_indoor.json 是「室外出生点 → 门洞 →
          // 碰撞墙围合房间」的穿门入室动线；walk_path_outdoor.json 是纯室外导览。
          const variant = params.get('path');
          const pathFile = (scene === 'floor1' && /^(gate|indoor|outdoor)$/.test(variant || ''))
            ? 'walk_path_' + variant + '.json' : 'walk_path.json';
          api.pathFile = pathFile;
          const doc = await fetch('./sog/' + scene + '/' + pathFile).then((r) => {
            if (!r.ok) throw new Error('walk_path.json HTTP ' + r.status);
            return r.json();
          });
          const poses = doc.poses || [];
          api.frames = poses.length;
          api.fps = doc.fps || 24;
          api.path = doc.path || null;
          api.reachability = doc.reachability || null;
          api.seek = (i) => {
            const k = Math.max(0, Math.min(poses.length - 1, Math.round(i)));
            const p = poses[k];
            if (!p) return false;
            const ok = viewer.setCameraPose?.(p.world, p.target, 72);
            api.current = k;
            return ok === true;
          };
          api.status = () => {
            const C = viewer.app.root.findComponent('camera');
            const e = C.entity.getPosition();
            const p = poses[Math.max(0, api.current)];
            return {
              ready: api.ready, current: api.current, frames: poses.length,
              loaded: viewer.state.loaded, mode: viewer.state.cameraMode,
              far: +C.farClip.toFixed(3),
              actual: [e.x, e.y, e.z], expected: p ? p.world : null,
              poseError: p ? Math.hypot(e.x - p.world[0], e.y - p.world[1],
                                        e.z - p.world[2]) : null,
              error: api.error
            };
          };
          const t0 = Date.now();
          while (!viewer.state.loaded && Date.now() - t0 < 60000) {
            await new Promise((r) => setTimeout(r, 300));
          }
          api.seek(0);
          api.ready = true;
          // ?play=1：在 exe / 网页里自动循环播放这条可达路径（CDP 逐帧捕获时不启用）
          if (params.get('play') === '1' && poses.length > 1) {
            let last = performance.now();
            const tick = (now) => {
              if (now - last >= 1000 / api.fps) {
                last = now;
                api.seek((api.current + 1) % poses.length);
              }
              requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          }
        } catch (err) {
          api.error = String(err?.message ?? err);
        }
      })();
    }

    // 官方碰撞数据是异步加载的：等它就绪后切到 walk，让 mesh 碰撞真正接管漫游。
    // ?mode=fly 保留自由飞行用于多视点/裁剪回归测试（不自动切 walk）。
    const forceFly = videoMode || params.get('mode') === 'fly' || !collisionDefaultOn;
    if (!forceFly) {
      const walkPoll = setInterval(() => {
        // 用户主动关掉碰撞后不要再把相机切回 walk（此时 walkAllowed 也已置 false，
        // 这里再加一道显式判断，避免异步时序竞态把开关“弹回去”）。
        if (window.__mgControls?.collisionUserOff) { clearInterval(walkPoll); return; }
        // 排版 / 绘制标注时需要自由飞行（贴墙画贴花、升到高处俯视布点），
        // walk 的「离地 1.6m 胶囊」姿态很碍事：编辑器一开就停止自动切 walk。
        if (window.__mgEditor || globalThis.__mgEditorFly) { clearInterval(walkPoll); return; }
        const st = viewer.state;
        if (st?.loaded && st?.hasCollision && st?.walkAllowed) {
          clearInterval(walkPoll);
          if (st.cameraMode !== 'walk') viewer.toggleWalk?.();
        }
      }, 500);
      setTimeout(() => clearInterval(walkPoll), 30000);
    }

    // 键盘快捷键（Viewer 未暴露这些接口时静默忽略）
    // 注意：编辑器打开时（.mg-editor-on）整套宿主快捷键必须让位，
    // 否则在右侧「说明」框里敲 b / m 会误触发碰撞线框、切小地图。
    document.addEventListener('keydown', (e) => {
      if (document.documentElement.classList.contains('mg-editor-on')) return;
      const tag = e.target?.tagName || '';
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || e.target?.isContentEditable) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const spawnHotkey = {
        '1': 'outdoor', '2': 'floor1', '3': 'floor3',
        '4': 'outdoor', '5': 'floor3'
      }[e.key];
      if (spawnHotkey) {
        document.querySelector('.mg-scene[data-spawn="' + spawnHotkey + '"]')?.click();
      } else if (e.key === 'b' || e.key === 'B') {
        window.__mgCollisionDebug?.setBoxes(
          !window.__mgCollisionDebug.getState().boxes);
        if (toolsbox.hidden) $('mg-tools')?.click();
      } else if (e.key === 'p' || e.key === 'P') {
        window.__mgRoute?.play(false);
      } else if (e.key === 'l' || e.key === 'L') {
        window.__mgRoute?.startRecord();
      } else if (e.key === 't' || e.key === 'T') {
        $('mg-tools')?.click();
      } else if (e.key === 'm' || e.key === 'M') {
        window.__mgMiniMap?.toggle();
        syncMapBtn();
      // ★ 深度视口用 N，不能用 D：D 是 WASD 的「右移」，漫游时按 D 会把视口开关掉
      } else if (e.key === 'n' || e.key === 'N') {
        window.__mgDepth?.toggle();
        depthBtn?.classList.toggle('mg-on', !!window.__mgDepth?.isOpen);
      } else if (e.key === 'f' || e.key === 'F') {
        viewer?.frameScene?.();
      } else if (e.key === 'r' || e.key === 'R') {
        viewer?.resetCamera?.();
      }
    });

    // 启动遮罩淡出的唯一入口：等真实首帧，加载失败 / 超时由门控兜底
    installFirstFrameGate(viewer);

    // 官方 Viewer 默认展开快捷键提示浮层；这里默认收起，底部控制按钮仍可再次打开
    setTimeout(() => {
      const hintBtn = stage.querySelector('.sse-controlsButton');
      if (hintBtn && hintBtn.classList.contains('sse-active')) hintBtn.click();
    }, 900);
  } catch (err) {
    const msg = String(err?.message ?? err);
    // 收紧匹配：泛化的 gpu/device 关键字会把无关的加载错误误判成 WebGPU 失败，
    // 一旦误判就会在同一标签页里一直强制 WebGL2。
    if (renderer === 'webgpu' &&
        /webgpu|requestAdapter|createDevice|GPUAdapter|GPUDevice|graphics device/i.test(msg)) {
      fallbackToWebGL(msg);
    } else showError(msg);
  }
})();

// 异步阶段（如 adapter 创建失败）也能回退
window.addEventListener('unhandledrejection', (ev) => {
  const msg = String(ev.reason?.message ?? ev.reason ?? '');
  if (renderer === 'webgpu' &&
      /webgpu|requestAdapter|createDevice|GPUAdapter|GPUDevice|graphics device/i.test(msg)) {
    fallbackToWebGL(msg);
  }
});

/* ---------- 三维场景整体亮度 ----------------------------------------
   展厅页（fusion.js）通过 postMessage / __mgBrightness 调整。用 CSS
   filter 只作用于 PlayCanvas 的 WebGL canvas：三维画面整体提亮/压暗，
   而 Viewer 工具条、三维锚定标签、帮助浮层等 DOM 层保持原亮度。
   亮度值写入 localStorage，跨楼层切换 iframe 时保持一致。            */
(function initBrightness() {
  const KEY = 'gsBrightness';
  const clamp = (v) => Math.min(1.8, Math.max(0.4, Number(v) || 1));
  let value = 1;
  try { value = clamp(parseFloat(localStorage.getItem(KEY)) || 1); } catch (_) { /* noop */ }
  function apply() {
    const f = Math.abs(value - 1) < 0.005 ? '' : `brightness(${value})`;
    document.querySelectorAll('#mg-stage canvas').forEach((c) => { c.style.filter = f; });
  }
  window.__mgBrightness = {
    get: () => value,
    set(v) {
      value = Math.round(clamp(v) * 100) / 100;
      try { localStorage.setItem(KEY, String(value)); } catch (_) { /* noop */ }
      apply();
      return value;
    }
  };
  // canvas 由 PlayCanvas 异步插入；新出现时补上当前亮度（只观察 childList，
  // 修改 style 不会再次触发，避免自激循环）
  const stage = document.getElementById('mg-stage');
  if (stage && window.MutationObserver) {
    new MutationObserver(apply).observe(stage, { childList: true, subtree: true });
  }
  window.addEventListener('message', (e) => {
    if (e.data?.type === 'mg-set-brightness') window.__mgBrightness.set(e.data.value);
  });
  apply();
})();

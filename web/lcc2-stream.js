/**
 * viewer_stream / .lcc2 流式加载适配层
 * ---------------------------------------------------------------------------
 * 本模块只做三件事，不改 SuperSplat Viewer 引擎：
 *
 *  1. 以原始 XGrids `meta.lcc2` 作为场景的权威数据源：运行时 fetch 并解析
 *     八叉树、LOD 层级、分块清单、高斯总数、切片 name/start/count 映射。
 *  2. 把解析结果与磁盘上的 `lod-meta.json`（SuperSplat GSplatOctree 索引）
 *     做一致性校验，再把 `lod-meta.json` 的 URL 交给引擎。引擎按 basename
 *     识别 octree parser，并按相机视锥 / 距离**按需请求分块 SOG**，
 *     这就是本版要测的「流式加载」。
 *  3. 观测：用 PerformanceObserver 记录每个分块请求的时间、体积、状态，
 *     暴露 window.__mgStream 供 CDP 脚本读取，并可选渲染一个 HUD 面板。
 *
 * 为什么 contentUrl 仍是 lod-meta.json 而不是直接给 .lcc2：
 *   - 引擎只认 basename === "lod-meta.json" 的 octree parser；
 *   - GSplatOctree 用索引 URL 的目录解析 filenames 里 data/3dgs/*.sog
 *     的相对路径。若把索引做成 blob:/data: URL，分块路径会解析错；
 *   - 因此 .lcc2 负责「数据源 + 校验 + 测试元数据」，lod-meta.json 负责
 *     「引擎可消费的 LOD 调度索引」。二者同源，校验不通过会明确报错。
 *
 * 坐标系（2026-11-11 修正，见 STREAM_TEST.md 第 12 节）：
 *   XGrids 的米制坐标以 s = sign(v)*ln(1+|v|) 编码进 SOG v2 的 means.mins/maxs，
 *   引擎解码时执行 center = sign(s)*(exp(|s|)-1) 还原成米制。所以渲染几何、
 *   lod-meta.json 的 tree.bound、相机、物理常量必须**全部在米制**。
 *   旧版把 tree.bound 也压缩成 log 域（±5），并把相机/出生点留在 log 域，
 *   导致 LOD 距离场与 GPU 包围球视锥裁剪和真实几何相差一个 exp ——
 *   表现为整块误剔除、相机靠近反而消失、远处粗层大高斯糊屏。
 *   ?space=log 可一键切回旧的错误坐标域做 A/B。
 */

const params = new URLSearchParams(location.search);

/** 数据源模式：lcc2（默认，.lcc2 八叉树分块流式） / sog（整包单文件 LOD0，A/B 用）。
 *  默认走流式：首屏只拉视野内的分块，省掉整包 113 MB 的一次性下载；
 *  需要单文件基线（对照 / 离线）时用 `?source=sog`。 */
export const SOURCE_MODE = params.get('source') === 'sog' ? 'sog' : 'lcc2';
export const IS_LCC2 = SOURCE_MODE === 'lcc2';
/** 是否显示流式 HUD；CDP 验证脚本会带 stream=1 */
export const STREAM_HUD = params.get('stream') === '1';
/**
 * 坐标空间：metric（默认，正确）/ log（旧版缺陷复现，?space=log）。
 * 默认使用米制 tree.bound + 米制相机 + 米制物理常量；log 只用于 A/B 对照。
 */
export const SPACE_MODE = params.get('space') === 'log' ? 'log' : 'metric';
export const LOG_SPACE = SPACE_MODE === 'log' && IS_LCC2;
export const IS_METRIC = !LOG_SPACE;
/**
 * 大高斯遮罩（2026-11-11 修复，默认开启）。
 * 原始 XGrids .lcc2 分块未经 sog_clean.py 的尺度过滤，实测 0_0.sog 最大
 * 线性半径 16.0（21% 点 >0.15）、env.sog 中位数 11.9 最大 252.6；这些
 * 巨型半透明高斯就是整片失焦彩色斑。tools/sog_mask_clean.py 把超标点的
 * opacity 码本索引改成「全透明索引」，不删点、不动切片偏移，产物放在
 * ./sog/<scene>_masked/。?mask=0 可切回未清理的原始分块复现缺陷 / A/B。
 * 注：2026-11-11 二次诊断确认，糊块的**主因**是 tree.bound / 相机坐标域错配
 * （见第 12 节）；遮罩是次要的画质优化。坐标修正后同机位 A/B：
 * 开遮罩 lap_var 619 / 关遮罩 431，仍有价值，故保留默认开启。
 * 与 lod 预算无关，提高 budget 只会加载更多分块（已实测证伪）。
 */
/* 大高斯遮罩默认**关闭**：默认加载官方 .lcc2 导出的原始分块（data/3dgs 原样）。
   遮罩版是把超过阈值的巨高斯透明化（sog_mask_clean.py 生成），远景会整体变暗、
   室内机位中心亮度实测掉 14 点，属于"清理过的替代品"，只作对照：
   ?mask=1 才切到 <scene>_masked/。 */
export const MASK_CHUNKS = IS_LCC2 && params.get('mask') === '1';
globalThis.__MG_MASK = MASK_CHUNKS;

const now = () => performance.now();
const fmtBytes = (n) => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i ? 1 : 0) + ' ' + u[i];
};

/* -------------------------------------------------------------------------
 * 1. .lcc2 解析
 * ---------------------------------------------------------------------- */

/**
 * 遍历 .lcc2 的八叉树 root.child（键为 "0","1",... 的字典，不是数组）。
 *
 * XGrids 的规则与 tools/lcc2_build_scene.py::build_tree 一致：
 *   · data.3dgs = {name, start, count}，name 是 root.splatFiles 的**下标**；
 *   · LOD 级 li = totalLevels - 节点深度（粗档切片挂在祖先节点上，
 *     被同一子树下的多个叶子共享，统计时要按 (name,start,count) 去重）。
 *
 * 返回节点/叶子/深度统计、每级切片数、每级高斯数、分块文件引用次数。
 */
function walkOctree(root, totalLevels, splatFiles) {
  let nodes = 0, leaves = 0, maxDepth = 0, slices = 0;
  const depthHist = Object.create(null);
  const fileRefs = Object.create(null);
  const sliceByLod = Object.create(null);
  const splatsByLod = Object.create(null);
  const seenSlices = new Set();

  const rec = (node, depth) => {
    nodes++;
    maxDepth = Math.max(maxDepth, depth);
    depthHist[depth] = (depthHist[depth] || 0) + 1;
    const kids = Object.values(node.child || {});
    if (!kids.length) leaves++;

    const g = node.data?.['3dgs'];
    if (g) {
      slices++;
      const li = totalLevels - depth;
      const idx = Number(g.name);
      const file = splatFiles[idx] || ('#' + idx);
      fileRefs[file] = (fileRefs[file] || 0) + 1;
      if (li >= 0 && li < totalLevels) {
        sliceByLod[li] = (sliceByLod[li] || 0) + 1;
        // 同一粗档切片被多个叶子引用时只计一次高斯数
        const key = `${g.name}|${g.start}|${g.count}`;
        if (!seenSlices.has(key)) {
          seenSlices.add(key);
          splatsByLod[li] = (splatsByLod[li] || 0) + Number(g.count || 0);
        }
      }
    }
    for (const k of kids) rec(k, depth + 1);
  };
  rec(root, 0);
  return { nodes, leaves, maxDepth, slices, depthHist, fileRefs, sliceByLod, splatsByLod };
}

/** 把 meta.lcc2 解析成测试所需的紧凑索引（不含逐节点几何） */
export function parseLcc2(meta) {
  const root = meta.root || {};
  const splatFiles = (root.splatFiles || []).map((p) => String(p).replace(/\\/g, '/'));
  const tree = walkOctree(root, meta.totalLevels, splatFiles);
  return {
    version: meta.version,
    name: meta.name,
    dataType: meta.dataType,
    splatType: meta.splatType,
    guid: meta.guid,
    totalSplats: meta.totalSplats,
    lodSplats: (meta.lodSplats || []).slice(),
    totalLevels: meta.totalLevels,
    virtualLoD: meta.virtualLoD || null,
    env: meta.env || null,
    splatFiles,
    meshFiles: (root.meshFiles || []).length,
    bvhFiles: (root.bvhFiles || []).length,
    tree,
    // .lcc2 boundingBox 是米制 Z-up；仅作报告展示，不参与渲染
    metricBound: root.boundingBox || null
  };
}

/**
 * 校验 .lcc2 与 lod-meta.json 是否同源。
 * 只做「必须一致」的项，返回字符串数组；空数组表示通过。
 */
export function validateLodMeta(index, lm) {
  const issues = [];
  if (lm.version !== 1) issues.push('lod-meta.version != 1');
  if (lm.lodLevels !== index.totalLevels) {
    issues.push(`lodLevels 不一致: ${lm.lodLevels} vs .lcc2 ${index.totalLevels}`);
  }
  if (lm.count !== index.totalSplats) {
    issues.push(`count 不一致: ${lm.count} vs .lcc2 ${index.totalSplats}`);
  }
  const a = JSON.stringify(lm.counts || []);
  const b = JSON.stringify(index.lodSplats);
  if (a !== b) issues.push(`每级高斯数不一致: ${a} vs .lcc2 ${b}`);

  // ?space=log 的索引放在 <scene>_log/ 子目录，filenames 会带
  // ../<scene>_masked/ 前缀；分块文件本身没变，必须按 basename 比较，
  // 否则会把「同一批分块换个目录」误报成索引不一致。
  const base = (p) => String(p).replace(/\\/g, '/').split('/').pop();
  const lmRaw = (lm.filenames || []).map((p) => String(p).replace(/\\/g, '/'));
  const lmFiles = lmRaw.map(base);
  const lccRaw = index.splatFiles.map((p) => String(p).replace(/\\/g, '/'));
  const lccFiles = lccRaw.map(base);
  const missing = lccRaw.filter((f, i) => !lmFiles.includes(lccFiles[i]));
  if (missing.length) issues.push(`lod-meta 缺失 .lcc2 分块: ${missing.slice(0, 6).join(', ')}`);
  const lmExtra = lmRaw.filter((f, i) => !lccFiles.includes(lmFiles[i]));
  // env.sog 是官方环境球，允许作为额外项出现
  const realExtra = lmExtra.filter((f) => base(f) !== base(lm.environment));
  if (realExtra.length) issues.push(`lod-meta 存在非 .lcc2 分块: ${realExtra.slice(0, 6).join(', ')}`);

  // 按八叉树深度重建的每级高斯总数，应与 .lcc2 的 lodSplats 逐项相等
  // （验证 LOD 层级映射没有错位，这是流式调度正确性的前提）
  const rebuilt = [];
  for (let i = 0; i < index.totalLevels; i++) {
    rebuilt.push(index.tree.splatsByLod[i] || 0);
  }
  if (JSON.stringify(rebuilt) !== b) {
    issues.push(`按节点深度重建的每级高斯数不一致: ${JSON.stringify(rebuilt)} vs .lcc2 ${b}`);
  }
  return issues;
}

/* -------------------------------------------------------------------------
 * 2. 流式观测
 * ---------------------------------------------------------------------- */

const requests = [];
const seen = new Map();
let firstFrameAt = null;
let loadedAt = null;
// 统一以 performance.timeOrigin（页面导航开始）为时间零点，与
// PerformanceResourceTiming.startTime 同基准。不要用 probe 启动时刻做零点，
// 否则首帧会被算成 0.x ms（viewer 创建完 canvas 已存在）。
let startedAt = 0;
let lcc2Index = null;
let lodMetaSummary = null;
let validationIssues = [];
let sourceInfo = null;

function record(entry) {
  const name = entry.name;
  const isChunk = /\/data\/3dgs\//.test(name) || /\.sog(\?|$)/.test(name);
  const isIndex = /lod-meta\.json|\.lcc2(\?|$)/.test(name);
  if (!isChunk && !isIndex) return;
  const key = name + '#' + (entry.startTime ?? 0).toFixed(1);
  if (seen.has(key)) return;
  seen.set(key, true);
  requests.push({
    name: name.split('/').pop(),
    url: name,
    kind: /\.lcc2(\?|$)/.test(name) ? 'lcc2'
      : /lod-meta\.json/.test(name) ? 'lod-meta' : 'chunk',
    startMs: +(entry.startTime ?? 0).toFixed(1),
    durationMs: +(entry.duration ?? 0).toFixed(1),
    bytes: entry.transferSize || entry.encodedBodySize || 0,
    decodedBytes: entry.decodedBodySize || 0,
    status: entry.responseStatus ?? null
  });
}

/** 启动 PerformanceObserver；buffered 能拿到 observer 注册前已完成的请求 */
export function startStreamProbe(meta = {}) {
  startedAt = 0;
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) record(e);
    });
    po.observe({ type: 'resource', buffered: true });
  } catch (_) { /* 老浏览器不支持 buffered，退化为定时快照 */ }

  // 兜底：定时把 performance resource 全量扫一遍，防止 observer 漏项
  const sweep = () => {
    for (const e of performance.getEntriesByType('resource')) record(e);
  };
  sweep();
  const timer = setInterval(sweep, 1000);

  // 首帧 = #mg-stage 内出现 canvas
  const markCanvas = () => {
    if (firstFrameAt === null && document.querySelector('#mg-stage canvas')) {
      firstFrameAt = now();
    }
  };
  const mo = new MutationObserver(markCanvas);
  const stage = document.getElementById('mg-stage');
  if (stage) mo.observe(stage, { childList: true, subtree: true });
  markCanvas();

  Object.assign(window.__mgStream, meta);
  return () => { clearInterval(timer); mo.disconnect(); };
}

/** 由 app.js 在 viewer.state.loaded 变 true 时调用 */
export function markLoaded() {
  if (loadedAt === null) loadedAt = now();
}

export function snapshot() {
  const chunks = requests.filter((r) => r.kind === 'chunk');
  const bytes = chunks.reduce((s, r) => s + r.bytes, 0);
  const uniq = new Set(chunks.map((r) => r.name));
  return {
    source: SOURCE_MODE,
    scene: sourceInfo?.scene || null,
    // 坐标空间是决定 LOD 调度 / 视锥裁剪是否正确的第一要素，必须随快照走。
    space: SPACE_MODE,
    // 数据版本（超大高斯遮罩开关）必须随观测快照走，否则同一组数字
    // 可能对应「清理版」和「原始糊块版」两种完全不同的画面。
    mask: MASK_CHUNKS,
    lcc2Url: sourceInfo?.lcc2Url || null,
    lodMetaUrl: sourceInfo?.lodMetaUrl || null,
    elapsedMs: +(now() - startedAt).toFixed(1),
    firstFrameMs: firstFrameAt === null ? null : +(firstFrameAt - startedAt).toFixed(1),
    loadedMs: loadedAt === null ? null : +(loadedAt - startedAt).toFixed(1),
    chunkTotal: sourceInfo?.chunkTotal ?? null,
    chunkRequested: uniq.size,
    chunkRequests: chunks.length,
    chunkBytes: bytes,
    chunkBytesText: fmtBytes(bytes),
    indexRequests: requests.filter((r) => r.kind !== 'chunk').length,
    indexBytes: requests.filter((r) => r.kind !== 'chunk')
      .reduce((s, r) => s + r.bytes, 0),
    lastRequests: requests.slice(-12),
    requests: requests.slice(),
    lcc2: lcc2Index ? {
      version: lcc2Index.version,
      totalSplats: lcc2Index.totalSplats,
      lodLevels: lcc2Index.totalLevels,
      lodSplats: lcc2Index.lodSplats,
      splatFiles: lcc2Index.splatFiles.length,
      nodes: lcc2Index.tree.nodes,
      leaves: lcc2Index.tree.leaves,
      maxDepth: lcc2Index.tree.maxDepth,
      slices: lcc2Index.tree.slices,
      sliceByLod: lcc2Index.tree.sliceByLod,
      splatsByLod: lcc2Index.tree.splatsByLod
    } : null,
    lodMeta: lodMetaSummary,
    validationIssues: validationIssues.slice(),
    // 机位随快照一起带走：CDP 报告 / 「复制 JSON 报告」都包含当前位姿
    camera: readCameraPose()
  };
}

/** 全局调试接口：CDP 脚本 / 控制台直接读 */
window.__mgStream = {
  version: 1,
  source: SOURCE_MODE,
  state: snapshot,
  report: () => JSON.stringify(snapshot(), null, 2),
  markLoaded,
  requests
};

/* -------------------------------------------------------------------------
 * 3. 以 .lcc2 为入口解析场景
 * ---------------------------------------------------------------------- */

/**
 * @param {object} cfg  SCENES[scene]，需含 content(.lcc2) 与 lodMeta
 * @param {string} scene
 * @returns {Promise<{contentUrl:string, index:object, issues:string[]}>}
 */
export async function resolveLcc2Content(cfg, scene) {
  const t0 = now();
  const res = await fetch(cfg.content);
  if (!res.ok) throw new Error(`${cfg.content} HTTP ${res.status}`);
  const meta = await res.json();
  lcc2Index = parseLcc2(meta);

  const lmRes = await fetch(cfg.lodMeta);
  if (!lmRes.ok) throw new Error(`${cfg.lodMeta} HTTP ${lmRes.status}`);
  const lm = await lmRes.json();
  lodMetaSummary = {
    version: lm.version,
    count: lm.count,
    counts: lm.counts,
    lodLevels: lm.lodLevels,
    filenames: (lm.filenames || []).length,
    environment: lm.environment || null
  };
  validationIssues = validateLodMeta(lcc2Index, lm);
  sourceInfo = {
    scene,
    lcc2Url: cfg.content,
    lodMetaUrl: cfg.lodMeta,
    chunkTotal: (lm.filenames || []).length
  };
  Object.assign(window.__mgStream, { sourceInfo, lcc2Index, lodMetaSummary, validationIssues });

  const parseMs = +(now() - t0).toFixed(1);
  // 校验失败只警告，不阻断加载：便于测试「索引错配」时观察引擎行为
  if (validationIssues.length) {
    console.warn('[viewer_stream] .lcc2 / lod-meta.json 一致性告警:', validationIssues);
  }
  console.info('[viewer_stream] .lcc2 索引已加载', {
    scene, parseMs, totalSplats: lcc2Index.totalSplats,
    lodLevels: lcc2Index.totalLevels, chunks: lcc2Index.splatFiles.length,
    nodes: lcc2Index.tree.nodes, leaves: lcc2Index.tree.leaves,
    issues: validationIssues
  });
  return { contentUrl: cfg.lodMeta, index: lcc2Index, issues: validationIssues, parseMs };
}

/* -------------------------------------------------------------------------
 * 4. 可选 HUD
 * ---------------------------------------------------------------------- */

/* -------------------------------------------------------------------------
 * 3.5 相机机位记录 / 一键复现
 *   渲染缺陷（尤其是大高斯糊块）高度依赖相机位姿，必须能把「问题发生时」
 *   的机位原样带走，下次直接打开同一画面：
 *     - HUD 实时显示 position / forward / euler / FOV / 渲染后端
 *     - 「复制复现链接」生成带 ?pos=&look= 的 URL（app.js 中优先级最高）
 *     - 「复制机位 JSON」附带后端、预算、分块状态、索引校验等完整快照
 *     - 位姿变化时自动写 localStorage 历史（最近 40 条），关浏览器也不丢
 *   控制台 / CDP 可用：window.__mgCamera.pose() / .url() / .json() /
 *                      .history() / .clearHistory()
 * ---------------------------------------------------------------------- */

const POSE_HISTORY_KEY = 'mg_stream_pose_history';
let poseHistory = [];
try {
  poseHistory = JSON.parse(localStorage.getItem(POSE_HISTORY_KEY) || '[]');
} catch (_) { poseHistory = []; }
let lastPoseKey = '';

const r3 = (v) => +Number(v).toFixed(3);
const r6 = (v) => +Number(v).toFixed(6);
const vec3 = (o) => (o ? [o.x, o.y, o.z] : null);

/** 读取当前相机完整位姿；viewer 尚未就绪时返回 null */
function readCameraPose() {
  const app = window.app || window.__viewer?.app;
  const cam = app?.root?.findComponent?.('camera');
  const e = cam?.entity;
  if (!e) return null;
  const p = vec3(e.getPosition?.());
  const f = vec3(e.forward) || [0, 0, -1];
  const u = vec3(e.up) || [0, 1, 0];
  const eu = vec3(e.getEulerAngles?.());
  const q = e.getRotation?.();
  return {
    position: p,
    // app.js 的 ?look 是「目标点」而非方向向量；用 pos + forward 即可精确还原朝向
    target: p ? [p[0] + f[0], p[1] + f[1], p[2] + f[2]] : null,
    forward: f,
    up: u,
    euler: eu,                        // PlayCanvas: [pitch, yaw, roll]，单位度
    quaternion: q ? [q.x, q.y, q.z, q.w] : null,
    fov: cam.fov ?? 75,
    near: cam.nearClip ?? null,
    far: cam.farClip ?? null
  };
}

/** 当前生效的运行参数；复现链接要原样带上，否则打开后不是同一个场景 */
function reproParams() {
  const q = new URLSearchParams(location.search);
  return {
    scene: q.get('scene') || 'floor1',
    spawn: q.get('spawn'),
    source: SOURCE_MODE,
    space: SPACE_MODE,
    budget: globalThis.__MG_BUDGET ?? q.get('budget') ?? null,
    renderer: window.__mgRenderer?.renderer ?? q.get('renderer') ?? null,
    mask: SOURCE_MODE === 'lcc2' ? (MASK_CHUNKS ? 1 : 0) : null
  };
}

/** 生成可直接粘贴到地址栏打开的复现 URL */
function buildReproUrl() {
  const pose = readCameraPose();
  const u = new URL(location.href);
  const q = u.searchParams;
  // 这些参数会覆盖机位或改变渲染路径，先清掉再按当前状态重建
  ['pos', 'look', 'path', 'video', 'embed'].forEach((k) => q.delete(k));
  const rp = reproParams();
  q.set('scene', rp.scene);
  if (rp.spawn) q.set('spawn', rp.spawn);
  q.set('source', rp.source);
  // 坐标空间必须随链接带上：不带 space 时默认是米制，旧 log 域机位会错位
  if (rp.space === 'log') q.set('space', 'log');
  else q.delete('space');
  if (rp.budget) q.set('budget', String(rp.budget));
  if (rp.renderer) q.set('renderer', rp.renderer);
  // 遮罩开关必须随复现链接带上，否则下次打开的可能是另一种数据版本
  if (rp.mask !== null) q.set('mask', String(rp.mask));
  else q.delete('mask');
  q.set('stream', '1');
  if (pose?.position && pose?.target) {
    q.set('pos', pose.position.map(r6).join(','));
    q.set('look', pose.target.map(r6).join(','));
  }
  return u.toString();
}

/** 完整诊断快照：机位 + 后端 + 流式状态 + 复现链接 */
function buildCameraReport() {
  const s = snapshot();
  // 引擎在 exposeGlobals:false 时不一定挂 window.app，统一走 __viewer.app 兜底
  const app = window.app || window.__viewer?.app;
  return {
    at: new Date().toISOString(),
    pageUrl: location.href,
    reproUrl: buildReproUrl(),
    camera: readCameraPose(),
    renderer: window.__mgRenderer ?? null,
    params: reproParams(),
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    scene: {
      source: s.source,
      scene: s.scene,
      space: s.space,
      mask: s.mask,
      lodDistanceShrink: app?.scene?.gsplat?.lodDistanceShrink ?? null,
      lodBehindPenalty: app?.scene?.gsplat?.lodBehindPenalty ?? null,
      lodBaseDistance: app?.root?.findComponent?.('gsplat')?.lodBaseDistance ?? null,
      budget: app?.scene?.gsplat?.splatBudget ?? null,
      drawnSplats: app?.stats?.frame?.gsplats ?? null,
      totalSplats: s.lcc2?.totalSplats ?? null,
      chunkRequested: s.chunkRequested,
      chunkTotal: s.chunkTotal,
      chunkBytes: s.chunkBytesText,
      validationIssues: s.validationIssues,
      elapsedMs: s.elapsedMs
    },
    poseHistoryCount: poseHistory.length
  };
}

/** 位姿变化时记一条历史（静止时不重复写），localStorage 持久化 */
function recordPose() {
  const pose = readCameraPose();
  const app = window.app || window.__viewer?.app;
  if (!pose?.position) return pose;
  const key = pose.position.map(r3).join(',') + '|' + pose.forward.map(r3).join(',');
  if (key !== lastPoseKey) {
    lastPoseKey = key;
    poseHistory.push({
      t: new Date().toISOString(),
      pose,
      pageUrl: location.href,
      renderer: window.__mgRenderer?.renderer ?? null,
      budget: app?.scene?.gsplat?.splatBudget ?? null,
      reproUrl: buildReproUrl()
    });
    if (poseHistory.length > 40) poseHistory.shift();
    try {
      localStorage.setItem(POSE_HISTORY_KEY, JSON.stringify(poseHistory));
    } catch (_) { /* 隐私模式 / 配额满：面板仍可实时复制 */ }
  }
  return pose;
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { /* noop */ }
    ta.remove();
    return ok;
  }
}

/** 控制台 / CDP 接口 */
window.__mgCamera = {
  pose: readCameraPose,
  url: buildReproUrl,
  report: buildCameraReport,
  json: () => JSON.stringify(buildCameraReport(), null, 2),
  history: () => poseHistory.slice(),
  clearHistory: () => {
    poseHistory = [];
    lastPoseKey = '';
    try { localStorage.removeItem(POSE_HISTORY_KEY); } catch (_) { /* noop */ }
  }
};

const HUD_CSS = `
#mg-stream-hud{position:fixed;left:16px;top:96px;z-index:9999;width:310px;
  font:12px/1.55 ui-monospace,Consolas,"Microsoft YaHei",monospace;
  color:#e8f0ff;background:rgba(12,18,30,.88);border:1px solid rgba(120,180,255,.35);
  border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.35);backdrop-filter:blur(6px);
  padding:12px 14px;pointer-events:auto}
#mg-stream-hud h4{margin:0 0 8px;font-size:13px;color:#7fd0ff;letter-spacing:.5px}
#mg-stream-hud .row{display:flex;justify-content:space-between;gap:8px}
#mg-stream-hud .k{color:#91a4c0}
#mg-stream-hud .v{color:#e8f0ff;text-align:right;word-break:break-all}
#mg-stream-hud .bar{height:5px;background:#243247;border-radius:3px;margin:8px 0;overflow:hidden}
#mg-stream-hud .bar>i{display:block;height:100%;background:linear-gradient(90deg,#38bdf8,#818cf8)}
#mg-stream-hud pre{margin:8px 0 0;max-height:150px;overflow:auto;color:#9fb6d4;
  font-size:11px;white-space:pre-wrap;background:rgba(0,0,0,.25);padding:6px;border-radius:6px}
#mg-stream-hud .warn{color:#ffc46b}
#mg-stream-hud .ok{color:#71e2a8}
#mg-stream-hud .btns{display:flex;gap:6px;flex-wrap:wrap;margin-top:9px}
#mg-stream-hud button{margin:0;background:#1e3a5f;color:#dbeafe;border:1px solid #3b6ea5;
  border-radius:5px;padding:3px 9px;cursor:pointer;font-size:11px}
#mg-stream-hud button.primary{background:#155e75;border-color:#22d3ee;color:#e0fbff}
#mg-stream-hud .pose{margin-top:8px;border-top:1px solid rgba(120,180,255,.2);padding-top:7px}
#mg-stream-hud .pose .row{line-height:1.45}
#mg-stream-hud .tag{color:#7fd0ff}
`;

export function mountStreamHud() {
  if (!STREAM_HUD || document.getElementById('mg-stream-hud')) return;
  const style = document.createElement('style');
  style.textContent = HUD_CSS;
  document.head.appendChild(style);

  const el = document.createElement('div');
  el.id = 'mg-stream-hud';
  document.body.appendChild(el);

  let flash = null;   // { id, until }：按钮「已复制」提示能跨 500ms 重绘保留

  const render = () => {
    const s = snapshot();
    const pct = s.chunkTotal ? Math.min(100, 100 * s.chunkRequested / s.chunkTotal) : 0;
    const pose = recordPose();
    const fmtV = (v) => (v ? v.map(r3).join(', ') : '-');
    const reproMode = new URLSearchParams(location.search).has('pos');
    // 运行时预算 / 在屏点数保留作观测指标，但 2026-11-11 二次诊断已证明：
    // 它们不是糊块主因（12M 预算下糊块反而更严重），不要再拿预算解释糊块。
    const app = window.app || window.__viewer?.app;
    const budget = app?.scene?.gsplat?.splatBudget ?? null;
    const drawn = app?.stats?.frame?.gsplats ?? null;
    const budgetM = budget ? (budget / 1e6).toFixed(1) + ' M'
      : (globalThis.__MG_BUDGET ? globalThis.__MG_BUDGET + ' M (配置)' : '-');
    const shrink = app?.scene?.gsplat?.lodDistanceShrink ?? null;
    const rows = [
      ['数据源', s.source === 'lcc2' ? '.lcc2 八叉树' : '整包单文件 SOG'],
      // 坐标空间错了，LOD 距离场 / 包围球视锥裁剪会与真实几何相差一个 exp，
      // 是「靠近反而被裁剪」和糊块的首要判据，放在 HUD 最上面。
      ['坐标空间', s.space === 'log'
        ? 'log 域（旧版缺陷）' : '米制 · bound/相机同域'],
      ['场景', s.scene || '-'],
      ['包围盒收缩', shrink === null ? '-' : (shrink === 0 ? '关（不裁剪）' : shrink.toFixed(2))],
      ['大高斯遮罩', s.source !== 'lcc2' ? '不适用'
        : (MASK_CHUNKS ? '开 · _masked 分块' : '关 · 原始分块')],
      ['LOD 级数', s.lcc2 ? s.lcc2.lodLevels : (s.lodMeta?.lodLevels ?? '-')],
      ['高斯总数', s.lcc2 ? s.lcc2.totalSplats.toLocaleString() : (s.lodMeta?.count ?? '-')],
      ['渲染预算', budgetM],
      ['在屏高斯', drawn === null ? '-' : drawn.toLocaleString()],
      ['分块请求', `${s.chunkRequested} / ${s.chunkTotal ?? '?'} (${s.chunkRequests} 次)`],
      ['已传字节', s.chunkBytesText],
      ['首帧', s.firstFrameMs === null ? '等待中' : s.firstFrameMs + ' ms'],
      ['loaded', s.loadedMs === null ? '等待中' : s.loadedMs + ' ms'],
      ['页面运行', s.elapsedMs + ' ms']
    ];
    const issue = s.validationIssues.length
      ? `<div class="warn">索引校验告警 ${s.validationIssues.length} 项：${s.validationIssues.join(' / ')}</div>`
      : (s.lcc2 ? '<div class="ok">.lcc2 ↔ lod-meta.json 校验通过</div>' : '');
    // 2026-11-11 三次诊断（最终）：糊块与「靠近反而被裁剪」的主因是
    // tree.bound / 相机留在 log 域，而引擎把 SOG v2 解码成米制（相差一个 exp）。
    // 米制 + shrink=0 后同机位 lap_var 81.8 -> 619.2；大高斯遮罩是次要优化。
    const splatHint = s.source !== 'lcc2' ? ''
      : (s.space === 'log'
        ? '<div class="warn">log 域旧版：tree.bound 与米制渲染几何错配，' +
          '会出现整块误剔除 / 糊块。去掉 <code>?space=log</code> 即修复。</div>'
        : (MASK_CHUNKS
          ? '<div class="ok">米制包围盒 + 不收缩裁剪 · 超大高斯已透明化</div>'
          : '<div class="ok">米制包围盒 + 不收缩裁剪' +
            '<span class="tag"> · ?mask=0 原始分块</span></div>'));
    const poseRows = [
      ['相机位置', fmtV(pose?.position)],
      ['朝向 fwd', fmtV(pose?.forward)],
      ['欧拉角 °', fmtV(pose?.euler)],
      ['FOV / 后端', `${pose?.fov ?? '-'} / ${window.__mgRenderer?.renderer ?? '-'}`]
    ];
    const rowHtml = (list) => list.map(([k, v]) =>
      `<div class="row"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');
    const label = (id, def) =>
      (flash && flash.id === id && Date.now() < flash.until) ? '已复制 ✓' : def;
    el.innerHTML = '<h4>viewer_stream · 流式加载观测</h4>' +
      rowHtml(rows) +
      `<div class="bar"><i style="width:${pct}%"></i></div>` + issue + splatHint +
      '<pre>' + s.lastRequests.slice(-6).map((r) =>
        `${String(Math.round(r.startMs)).padStart(6)}ms  ${r.kind.padEnd(8)} ${fmtBytes(r.bytes).padStart(9)}  ${r.name}`
      ).join('\n') + '</pre>' +
      '<div class="pose">' +
        `<div class="row"><span class="k">机位${reproMode ? ' <span class="tag">复现中</span>' : ''}</span>` +
        `<span class="v">历史 ${poseHistory.length} 条</span></div>` +
        rowHtml(poseRows) +
      '</div>' +
      '<div class="btns">' +
        `<button class="primary" id="mg-cam-url">${label('mg-cam-url', '复制复现链接')}</button>` +
        `<button id="mg-cam-json">${label('mg-cam-json', '复制机位 JSON')}</button>` +
        `<button id="mg-stream-copy">${label('mg-stream-copy', '复制 JSON 报告')}</button>` +
      '</div>';
    // 每次重绘都要重新绑定；flash 让「已复制」提示能跨 500ms 重绘保留
    const bind = (id, getter) => {
      const b = el.querySelector('#' + id);
      if (!b) return;
      b.onclick = async () => {
        const ok = await copyText(getter());
        flash = ok ? { id, until: Date.now() + 1600 } : null;
        render();
      };
    };
    bind('mg-cam-url', buildReproUrl);
    bind('mg-cam-json', () => window.__mgCamera.json());
    bind('mg-stream-copy', () => window.__mgStream.report());
  };
  render();
  setInterval(render, 500);
}

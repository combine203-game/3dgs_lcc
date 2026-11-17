/**
 * 3DGS 场景标注 · 数据模型（schema v1）
 *
 * 坐标系与 viewer 完全一致：米制 Y-up，1 单位 = 1 m，不做任何轴变换。
 * 所有几何统一存 points: [[x,y,z], ...]；不同类型只是点数、闭合性与呈现不同。
 * 文档可整体导出为 JSON，供浏览态只读加载 / 版本管理 / 后台审核。
 */

export const SCHEMA_VERSION = 1;

/** 标注类型：min/max 为顶点数约束，closed 决定是否闭合填充 */
export const KINDS = {
  point:   { label: '点标注',   icon: '●', min: 1, max: 1,       closed: false },
  line:    { label: '线 / 动线', icon: '╱', min: 2, max: Infinity, closed: false },
  area:    { label: '面 / 展区', icon: '▱', min: 3, max: Infinity, closed: true  },
  board:   { label: '展板',     icon: '▤', min: 1, max: 1,       closed: false },
  // 三维实体屏：世界空间固定位置 / 尺寸 / 朝向的矩形平面，用四点透视单应贴到场景里。
  // 与 board（始终正对相机、按距离人为缩放的 HUD 面板）是完全不同的两类对象。
  screen:  { label: '三维屏',   icon: '▣', min: 1, max: 1,       closed: false },
  // 贴面矩形：屏幕上框一个矩形，逐点用「深度反算」把 (x,y,depth) 还原成
  // 世界表面点，得到贴合真实可见几何的网格，像纹理/decal 一样贴住模型。
  // 两个 world 点只是兼容字段（拾取 / 定位），真正几何来自 surface。
  decal:   { label: '贴面矩形', icon: '▦', min: 2, max: 2,       closed: true  },
  measure: { label: '测量',     icon: '↔', min: 2, max: 2,       closed: false },
};

export const TOOLS = [
  { id: 'select',  label: '选择',   key: 'V', icon: '➤' },
  { id: 'point',   label: '点',     key: 'P', icon: '●' },
  { id: 'line',    label: '线',     key: 'L', icon: '╱' },
  { id: 'area',    label: '面',     key: 'E', icon: '▱' },
  { id: 'board',   label: '展板',   key: 'B', icon: '▤' },
  // 快捷键刻意避开 W/A/S/D（漫游键）：用 N 表示 eNtity screen
  { id: 'screen',  label: '三维屏', key: 'N', icon: '▣' },
  { id: 'decal',   label: '贴面矩形', key: 'R', icon: '▦' },
  { id: 'measure', label: '测量',   key: 'M', icon: '↔' },
];

/** 展板内容形态：纯文字 / 图片 / 网页 / 视频 */
export const MEDIA_TYPES = [
  { id: 'none',    label: '无（纯文字）' },
  { id: 'image',   label: '图片' },
  { id: 'webpage', label: '网页' },
  { id: 'video',   label: '视频' },
];

export const LAYER_PALETTE = ['#22d3ee', '#f59e0b', '#a78bfa', '#34d399', '#f472b6', '#60a5fa'];

/** 分组：业务归类 / 批量管理，与「图层」（渲染层级 + 颜色）互不干扰。
 *  默认组不可删除；删除自定义组时组内标注移回默认组，绝不连带删标注。 */
export const DEFAULT_GROUP_ID = 'default';
export const GROUP_PALETTE = ['#22d3ee', '#a78bfa', '#f59e0b', '#34d399', '#f472b6', '#60a5fa'];

export function defaultGroups() {
  return [{ id: DEFAULT_GROUP_ID, name: '默认分组', color: '#22d3ee',
    visible: true, collapsed: false, order: 0 }];
}

/** 展板基准像素：1 世界米在 zoom=1 时渲染的屏幕像素。
 *  展板宽度 = size.w * BOARD_BASE_PX * zoom（screen px）。
 *  拖拽缩放时 px->世界 反算也用同一个常数，保证尺寸换算一致。
 *  取 200 是为了让默认 1.8×1.35 m 的展板在常规观看距离仍有 ≥280×210 px，
 *  能真正放下标题 / 正文 / 内嵌网页与视频，而不是缩成一条看不清的细框。 */
export const BOARD_BASE_PX = 200;

/** 落点模式：depth=高斯深度图, ground=地面平面, wall=垂直墙面, free=相机前固定距离 */
export const PLACE_MODES = [
  { id: 'depth',  label: '贴合表面' },
  { id: 'ground', label: '地面' },
  { id: 'wall',   label: '墙面' },
  { id: 'free',   label: '悬浮' },
];

export function defaultStyle(kind) {
  return {
    color: '#22d3ee',
    opacity: 0.9,
    strokeWidth: 2,
    fontSize: 14,
    icon: KINDS[kind].icon,
    showLabel: true,
    labelAlways: false,   // false = 靠近才显示正文；true = 始终显示
    billboard: kind === 'board',
    // 三维实体屏朝向在世界空间里固定（camera | fixed）：不随视角自动转正。
    facing: kind === 'screen' ? 'fixed' : 'camera',
    // 展板世界尺寸（米）：以锚点为底心，向上悬浮；四角手柄据此渲染与拖拽缩放
    // 三维屏同样是**世界尺寸**，但它以锚点为中心、按 yaw/pitch 固定朝向贴地立在场景里。
    size: kind === 'board' ? { w: 1.8, h: 1.35 }
      : kind === 'screen' ? { w: 2.4, h: 1.35 } : null,
    // 三维屏朝向（度）：yaw 绕世界 Y 轴，pitch 绕屏面右向量。
    // 二者是数据而非相机相关量，因此「不随视角变化而改变大小和朝向」。
    yaw: 0,
    pitch: 0,
    // 三维屏播放参数
    muted: true,
    loop: true,
    // 展板引线锚点（世界坐标）：null = 落在面板脚下（默认 14px 导引线）；
    // 编辑态拖拽导引线末端圆点后记录一个独立世界点，导引线自动拉长 / 转向。
    // 拖动的落点由 picker.snapToMesh 吸附到最近的碰撞 MESH 表面。
    leadTo: null,
    // 动线（line）：带宽基准（米，映射为屏幕半宽像素）、箭头流动速度、是否显示箭头指向
    // 世界坐标的贴合由 picker.drapePolyline 完成，宽度不再用世界法向偏移
    bandWidth: 0.7,
    flowSpeed: 1.4,
    flowArrow: true,
    // 贴面矩形（decal）：投影式延迟贴花（屏幕空间 decal）。
    // 朝向兜底法向（无深度时）、投射视频不透明度、投影机沿法向盒厚（米，防穿透）、边缘软过渡占比。
    // 不再用「细分密度 + 法向抬升」——贴花由 GPU 逐像素按实时表面深度重建，零几何生成、像素级贴合。
    normal: kind === 'decal' ? [0, 1, 0] : null,
    decalOpacity: kind === 'decal' ? 0.9 : 1,
    decalDepth: kind === 'decal' ? 0.5 : 0,
    decalEdge: kind === 'decal' ? 0.12 : 0,
    // 背面剔除（默认关）：深度差分重建的法向在掠射角仍有噪声，开启会打出斑驳空洞
    decalCull: false,
    // OBB 归一化基准：1 = 盒面 |ln|=1（整框命中）；0.5 = 旧行为（仅内侧 1/4），留作回退
    decalBoxScale: 1,
    // 深度采样口径：1 = 引擎同族（5×5 邻域 30% 分位）；0 = 单 texel 中位（性能兜底）
    decalDepthMode: 1,
  };
}

let seq = 0;
export function newId() {
  return 'a_' + Date.now().toString(36) + '_' + (++seq).toString(36) + Math.random().toString(36).slice(2, 5);
}

export function makeAnnotation(kind, points, patch = {}) {
  const def = KINDS[kind];
  if (!def) throw new Error('unknown annotation kind: ' + kind);
  return {
    id: patch.id || newId(),
    kind,
    scene: patch.scene || 'floor1',          // 与 ?scene= 对应
    floor: patch.floor ?? 1,
    layerId: patch.layerId || 'default',
    groupId: patch.groupId || DEFAULT_GROUP_ID,
    points: points.map(p => [Number(p[0]), Number(p[1]), Number(p[2])]),
    title: patch.title || def.label,
    body: patch.body || '',
    media: patch.media || [],                 // [{type:'image'|'video'|'webpage'|'text', url, caption}]
    link: patch.link || '',
    style: { ...defaultStyle(kind), ...(patch.style || {}) },
    view: patch.view || null,                // 点击飞入机位 {position:[..], target:[..], fov}
    // 贴面矩形（decal）：屏幕框选矩形（归一化 0..1，[u0,v0,u1,v1]）与
    // 「投影式延迟贴花」的投影机 OBB {position, quaternion, half, depth}——
    // 由屏幕矩形反算出的世界表面网格（surface，旧文档兼容 / 兜底）构造而来。
    // 投影机是数据而非相机相关量，GPU 每帧按实时表面深度重建世界点做盒内判定，
    // 因此贴花像素级贴合模型表面、不随视角变化而漂移。
    rect: patch.rect || null,
    surface: patch.surface || null,
    projector: patch.projector || null,
    order: patch.order ?? Date.now(),
    visible: patch.visible ?? true,
    locked: patch.locked ?? false,
    // 逐注记「深度检测」：true = 被前方模型遮挡时隐藏（真实三维遮挡语义）；
    // false = 始终置顶可见（DOM 叠加层默认行为）。与工具栏那个全局
    // 「深度落点」开关互不相干：后者只管绘制时落点贴合 MESH 还是锁定平面。
    depthTest: patch.depthTest ?? false,
    author: patch.author || 'local',
    createdAt: patch.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function validate(a) {
  const def = KINDS[a?.kind];
  if (!def) return '未知类型 ' + a?.kind;
  if (!Array.isArray(a.points) || a.points.length < def.min || a.points.length > def.max) {
    return `顶点数应为 ${def.min}~${def.max}，实际 ${a.points?.length}`;
  }
  if (a.points.some(p => !Array.isArray(p) || p.length < 3 || p.some(n => !Number.isFinite(Number(n))))) {
    return '存在非法世界坐标';
  }
  return null;
}

/** 两点欧氏距离（米）；calibration.scale 用于把场景单位校准到真实米 */
export function distance(a, b, scale = 1) {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz) * scale;
}

/** 折线总长 / 多边形面积（投影到 XZ 平面，shoelace） */
export function pathLength(points, scale = 1) {
  let s = 0;
  for (let i = 1; i < points.length; i++) s += distance(points[i - 1], points[i], scale);
  return s;
}
export function polygonArea(points, scale = 1) {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    s += a[0] * b[2] - b[0] * a[2];
  }
  return Math.abs(s) / 2 * scale * scale;
}

/** 世界折线等距重采样：每段按 step（米）线性插值，段终点即原顶点。
 *  动线要贴合模型起伏，不能只在用户落的那几个点上求表面 —— 中间必须补点，
 *  否则长直段跨过台阶 / 坡道时就会从模型上方「悬空」飞过去。 */
export function resamplePolyline(points, step = 0.45) {
  const out = [];
  if (!Array.isArray(points) || !points.length) return out;
  const s = Math.max(0.05, Number(step) || 0.45);
  out.push(points[0].slice(0, 3).map(Number));
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = Math.hypot(d[0], d[1], d[2]);
    if (len < 1e-6) continue;
    const n = Math.max(1, Math.round(len / s));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      out.push([a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t]);
    }
  }
  return out;
}

/**
 * 等宽「箭头链」几何：动线本身就是一串首尾相接、由多边形轮廓形成箭头的段。
 *
 * 与旧实现的区别（用户明确要求）：
 *   · 不再是「一条渐变底带 + 带子内部塞几个小箭头图标」；
 *      每个箭头段自身就是一个 filled polygon，箭头尖是轮廓的一部分。
 *   · 带宽在**屏幕空间恒定**（halfW 像素），全段一致，不随远近忽宽忽窄；
 *      中心线则由贴合模型后的世界点投影而来，因此仍随地形起伏、随视角收敛。
 *
 * 局部坐标：u 沿前进方向，v 横向。**整段宽度恒为 2×halfW，没有任何外扩**：
 *   (0,-hw) → (headStart,-hw) → (tip,0) → (headStart,hw) → (0,hw) → (notch,0)
 * 即「前端一个三角箭头尖 + 后端一个 V 形凹口」，指向完全由多边形轮廓给出；
 * 相邻段的尖与凹口形状互补，串起来就是一条不断向前推进的等宽箭头带。
 * flowArrow=false 时退化为 4 点等宽矩形段。
 *
 * @param {{x:number,y:number}[]} pts  屏幕折线（已投影的贴合表面中心线）
 * @param {number} halfW  带身半宽（屏幕 px，全段统一）
 * @param {number} segLen 期望段长（屏幕 px），实际会均分成整数段铺满路径
 * @param {number} phase  流动相位 0..1，整串箭头沿路径向前推进
 * @param {{arrow?:boolean, gap?:number, headRatio?:number, notchRatio?:number}} [opts]
 * @returns {number[][][]} 每项是一个多边形的 [[x,y], ...] 顶点数组
 */
export function arrowChain(pts, halfW, segLen, phase = 0, opts = {}) {
  if (!Array.isArray(pts) || pts.length < 2 || !(halfW > 0) || !(segLen > 0)) return [];
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  const total = cum[cum.length - 1];
  // 阈值放到 0.5px：短动线（两点离得很近 / 远景）也必须至少出 1 段，
  // 否则「只画得出顶点、看不到线」。段长自适应后仍由 n 限制上限。
  if (total < 0.5) return [];
  const n = Math.max(1, Math.min(64, Math.round(total / Math.max(8, segLen))));
  const L = total / n;                       // 整数段均分，避免尾部半截箭头
  const arrow = opts.arrow !== false;
  const gap = Math.max(0, Math.min(0.3, opts.gap ?? 0.1));
  const headRatio = Math.max(0.2, Math.min(0.6, opts.headRatio ?? 0.44));
  const notchRatio = Math.max(0.2, Math.min(0.6, opts.notchRatio ?? 0.44));
  const tip = L * (1 - gap);
  const headStart = tip - L * headRatio;
  const notch = L * notchRatio;

  /** 按弧长取中心点与单位切线 / 法向；弯道处箭头会跟着折线一起转弯 */
  const at = (d) => {
    const dd = Math.max(0, Math.min(total, d));
    let i = 1;
    while (i < cum.length - 1 && cum[i] < dd) i++;
    const a = pts[i - 1], b = pts[i];
    const l = (cum[i] - cum[i - 1]) || 1;
    const t = (dd - cum[i - 1]) / l;
    const tx = (b.x - a.x) / l, ty = (b.y - a.y) / l;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
      nx: -ty, ny: tx };
  };

  const polys = [];
  const frac = ((phase % 1) + 1) % 1;
  /* 相位方向：箭头尖在 u=avail（指向路径前进方向 +s）。段位置若随相位
     「递减」（raw = (i - frac)·L），整串箭头会向路径起点倒退，与箭头指向
     相反 —— 这就是「动画方向和箭头方向反了」的根因。改为 (i + frac)·L
     后段位置随相位向 +s 推进，动画前进方向与箭头指向一致。 */
  for (let i = -1; i <= n; i++) {
    const raw = (i + frac) * L;
    if (raw >= total) continue;
    // 端点处的段要按「可用弧长」整体等比缩短，而不是把超出的顶点夹到
    // 路径端点 —— 后者会让好几个顶点塌成一点，拉出细长的三角尖刺。
    const start = Math.max(0, raw);
    const end = Math.min(total, raw + tip);
    const avail = end - start;
    if (avail < tip * 0.35) continue;              // 太短的残段直接不画
    const k = avail / tip;
    const hs = headStart * k, nt = notch * k;
    const outline = arrow
      ? [[0, -halfW], [hs, -halfW], [avail, 0],
         [hs, halfW], [0, halfW], [nt, 0]]
      : [[0, -halfW], [avail, -halfW], [avail, halfW], [0, halfW]];
    const poly = outline.map(([u, v]) => {
      const q = at(start + u);
      return [q.x + q.nx * v, q.y + q.ny * v];
    });
    polys.push(poly);
  }
  return polys;
}

/**
 * arrowChain 的**世界空间**版本：直接在贴合碰撞 mesh 的三维中心线上生成
 * 等宽箭头面片顶点（世界坐标），供 overlay 投影成真实随透视变形的四边形。
 * 与屏幕空间 arrowChain（billboard 性质，永远面向摄像机）的本质区别：
 * 面片在 s-t 参数面上构造 —— t 方向取「切线 × 世界 up」的水平侧向，
 * 因此面片水平铺在底面表面上，任意视角下都贴着模型，不朝向摄像机。
 *
 * @param {number[][]} pts  世界坐标中心线（已贴合碰撞 mesh 表面）
 * @param {number} halfW  带身半宽（**世界米**，全段统一）
 * @param {number} segLen 期望段长（世界米），实际均分成整数段铺满路径
 * @param {number} phase  流动相位 0..1，段位置随相位向 +s（箭头指向）推进
 * @param {{arrow?:boolean, gap?:number, headRatio?:number, notchRatio?:number}} [opts]
 * @returns {number[][][]} 每项是一个多边形的世界坐标顶点数组 [[x,y,z], ...]
 */
export function arrowChainWorld(pts, halfW, segLen, phase = 0, opts = {}) {
  if (!Array.isArray(pts) || pts.length < 2 || !(halfW > 0) || !(segLen > 0)) return [];
  const norm3 = (v) => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }
  const total = cum[cum.length - 1];
  if (!(total > 1e-4)) return [];
  const n = Math.max(1, Math.min(96, Math.round(total / Math.max(0.05, segLen))));
  const L = total / n;
  const arrow = opts.arrow !== false;
  const gap = Math.max(0, Math.min(0.3, opts.gap ?? 0.1));
  const headRatio = Math.max(0.2, Math.min(0.6, opts.headRatio ?? 0.44));
  const notchRatio = Math.max(0.2, Math.min(0.6, opts.notchRatio ?? 0.44));
  const tip = L * (1 - gap);
  const headStart = tip - L * headRatio;
  const notch = L * notchRatio;

  /** 按弧长取中心点与水平侧向单位向量（lateral = tangent × worldUp） */
  const at = (d) => {
    const dd = Math.max(0, Math.min(total, d));
    let i = 1;
    while (i < cum.length - 1 && cum[i] < dd) i++;
    const a = pts[i - 1], b = pts[i];
    const l = (cum[i] - cum[i - 1]) || 1e-6;
    const t = (dd - cum[i - 1]) / l;
    const c = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    const tx = (b[0] - a[0]) / l, ty = (b[1] - a[1]) / l, tz = (b[2] - a[2]) / l;
    // cross(tangent, [0,1,0]) = (-tz, 0, tx)：水平侧向，面片保持水平贴合地面
    let lat = [-tz, 0, tx];
    if (Math.hypot(lat[0], lat[1], lat[2]) < 1e-4) {
      // 切线接近竖直（沿墙面向上 / 竖管）：退回 cross(tangent, [1,0,0]) = (0, tz, -ty)
      lat = [0, tz, -ty];
      if (Math.hypot(lat[0], lat[1], lat[2]) < 1e-4) lat = [0, 0, 1];
    }
    return { c, lat: norm3(lat) };
  };

  const polys = [];
  const frac = ((phase % 1) + 1) % 1;
  for (let i = -1; i <= n; i++) {
    const raw = (i + frac) * L;                  // 与屏幕版一致：随相位向 +s 推进
    if (raw >= total) continue;
    // 端点残段整体等比缩短（同屏幕版），避免多个顶点塌成一点拉出尖刺
    const start = Math.max(0, raw);
    const end = Math.min(total, raw + tip);
    const avail = end - start;
    if (avail < tip * 0.35) continue;
    const k = avail / tip;
    const hs = headStart * k, nt = notch * k;
    const outline = arrow
      ? [[0, -halfW], [hs, -halfW], [avail, 0],
         [hs, halfW], [0, halfW], [nt, 0]]
      : [[0, -halfW], [avail, -halfW], [avail, halfW], [0, halfW]];
    const poly = outline.map(([u, v]) => {
      const q = at(start + u);
      return [q.c[0] + q.lat[0] * v, q.c[1] + q.lat[1] * v, q.c[2] + q.lat[2] * v];
    });
    polys.push(poly);
  }
  return polys;
}

/**
 * 把「两次点击的屏幕 CSS 像素」换算成归一化矩形 [u0, v0, u1, v1]。
 * 归一化后导出 JSON 到任何分辨率都能还原用户当初框选的同一块画面区域。
 * 旧实现把两个落点转成世界坐标再取切平面，结果既不在鼠标画的位置、
 * 又会被上方天花板抢先命中 —— 这是「贴面矩形完全没法用」的根因。
 */
export function screenRectUV(canvasRect, p0, p1) {
  const w = Number(canvasRect?.width) || 1;
  const h = Number(canvasRect?.height) || 1;
  const l = Number(canvasRect?.left) || 0;
  const t = Number(canvasRect?.top) || 0;
  const u = (x) => Math.max(0, Math.min(1, (Number(x) - l) / w));
  const v = (y) => Math.max(0, Math.min(1, (Number(y) - t) / h));
  let u0 = u(p0?.[0]), v0 = v(p0?.[1]), u1 = u(p1?.[0]), v1 = v(p1?.[1]);
  if (![u0, v0, u1, v1].every(Number.isFinite)) return null;
  if (u1 < u0) [u0, u1] = [u1, u0];
  if (v1 < v0) [v0, v1] = [v1, v0];
  // 太小 / 退化成线时给一个最小可视框，深度反算才不会得到零面积网格
  if (u1 - u0 < 0.01) u1 = Math.min(1, u0 + 0.01);
  if (v1 - v0 < 0.01) v1 = Math.min(1, v0 + 0.01);
  return [u0, v0, u1, v1];
}

/** 深度反算网格的行优先下标：第 j 行第 i 列 */
export function decalGridIndex(nu, i, j) { return j * (nu + 1) + i; }

/* ---------------------------------------------------------------- 贴面矩形（旧切平面几何，仅作兼容兜底）
 * 两个对角落点 + 落点处 MESH 法向 -> 切平面里的轴对齐矩形（四点）+ 世界网格。
 *
 * 为什么不用「两点连线当一条边」：只有两个点无法唯一确定矩形的另一条边，
 * 用落点差向量做右向量会让高度恒为 0（退化成一条线）。因此以 MESH 法向
 * 先定切平面，再把世界 +X（法向接近 ±X 时改用 +Z）投影到切平面作为 u 轴，
 * v 轴 = n × u；两点差在 u/v 上的投影就是矩形的宽 / 高。
 * 这样地面（n=+Y）得到 XZ 轴对齐矩形，墙面得到竖直矩形，结果稳定可复现。
 */

/** 归一化 / 叉乘 / 点乘，纯数组运算，不依赖 PlayCanvas Vec3 */
function vunit(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
function vcross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function vdot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

/**
 * @param {number[][]} points [p0, p1] 两个对角落点（世界坐标）
 * @param {number[]} [normal] 落点处 MESH 表面法向
 * @returns {{corners:number[][], right:number[], up:number[], normal:number[],
 *            center:number[], w:number, h:number}}
 *   corners 顺序 = 纹理 (0,0)(W,0)(W,H)(0,H)：左上 / 右上 / 右下 / 左下
 */
export function decalFrame(points, normal = [0, 1, 0]) {
  const p0 = (points?.[0] || [0, 0, 0]).slice(0, 3).map(Number);
  const p1 = (points?.[1] || [1, 0, 1]).slice(0, 3).map(Number);
  const n = vunit((Array.isArray(normal) && normal.length >= 3 ? normal : [0, 1, 0]).slice(0, 3).map(Number));
  // 世界 +X 在切平面上的投影；法向接近 ±X 时退化，改用 +Z
  let seed = Math.abs(n[0]) > 0.9 ? [0, 0, 1] : [1, 0, 0];
  let right = vunit([seed[0] - n[0] * vdot(seed, n), seed[1] - n[1] * vdot(seed, n), seed[2] - n[2] * vdot(seed, n)]);
  if (!Number.isFinite(right[0])) right = [1, 0, 0];
  const up = vunit(vcross(n, right));                 // right × up = n，保证纹理不镜像
  const d = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
  const w0 = vdot(d, right), h0 = vdot(d, up);
  // 退化保护：两点几乎共线时给一个最小尺寸，避免矩形塌成线
  const w = Math.sign(w0 || 1) * Math.max(0.25, Math.abs(w0));
  const h = Math.sign(h0 || 1) * Math.max(0.25, Math.abs(h0));
  const at = (u, vv) => [
    p0[0] + right[0] * w * u + up[0] * h * vv,
    p0[1] + right[1] * w * u + up[1] * h * vv,
    p0[2] + right[2] * w * u + up[2] * h * vv,
  ];
  return {
    corners: [at(0, 0), at(1, 0), at(1, 1), at(0, 1)],
    right, up, normal: n, w, h,
    center: at(0.5, 0.5),
  };
}

/** 把矩形按 nu×nv 细分成世界点阵（行优先），供逐点吸附 MESH 表面。
 *  返回 {points:number[][], nu, nv, idx(u,v)} —— 每个点都在切平面上，
 *  picker.drapeQuad 会把它们沿法向打到真实三角网上，形成贴合纹理的网格。 */
export function decalGridPoints(frame, nu = 8, nv = 8) {
  const U = Math.max(1, Math.min(24, Math.round(nu)));
  const V = Math.max(1, Math.min(24, Math.round(nv)));
  const [c0, c1, , c3] = frame.corners;
  const du = [c1[0] - c0[0], c1[1] - c0[1], c1[2] - c0[2]];
  const dv = [c3[0] - c0[0], c3[1] - c0[1], c3[2] - c0[2]];
  const pts = [];
  for (let j = 0; j <= V; j++) {
    for (let i = 0; i <= U; i++) {
      const u = i / U, v = j / V;
      pts.push([c0[0] + du[0] * u + dv[0] * v,
        c0[1] + du[1] * u + dv[1] * v,
        c0[2] + du[2] * u + dv[2] * v]);
    }
  }
  return { points: pts, nu: U, nv: V, idx: (i, j) => j * (U + 1) + i };
}

/* ---------------------------------------------------------------- 投影式延迟贴花（decal）的投影机 OBB
 * 由「屏幕矩形反算出的世界表面网格」构造一个定向包围盒 OBB：
 *   position  = 网格中心（世界）
 *   quaternion= 由表面切平面基 (right, up, normal) 构造的旋转
 *   half      = [宽/2, 高/2, 盒厚/2]（米）
 * GPU 每帧把每个像素重建出的世界点变换进该 OBB 局部空间做盒内判定，
 * 因此贴花像素级贴合真实表面，无需为表面重建任何网格。
 */

/** 四元数（列主序旋转矩阵 right/up/normal）-> [x,y,z,w]，标准 trace 法 */
export function quatFromBasis(right, up, normal) {
  const m00 = right[0], m01 = up[0], m02 = normal[0];
  const m10 = right[1], m11 = up[1], m12 = normal[1];
  const m20 = right[2], m21 = up[2], m22 = normal[2];
  const tr = m00 + m11 + m22;
  let qx, qy, qz, qw;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    qw = 0.25 / s; qx = (m21 - m12) * s; qy = (m02 - m20) * s; qz = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    qw = (m21 - m12) / s; qx = 0.25 * s; qy = (m01 + m10) / s; qz = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    qw = (m02 - m20) / s; qx = (m01 + m10) / s; qy = 0.25 * s; qz = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    qw = (m10 - m01) / s; qx = (m02 + m20) / s; qy = (m12 + m21) / s; qz = 0.25 * s;
  }
  const n = Math.hypot(qx, qy, qz, qw) || 1;
  return [qx / n, qy / n, qz / n, qw / n];
}

/** 把局部向量按四元数旋转到世界 */
export function rotateByQuat(v, q) {
  const [x, y, z] = v, [qx, qy, qz, qw] = q;
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [
    x + qw * tx + (qy * tz - qz * ty),
    y + qw * ty + (qz * tx - qx * tz),
    z + qw * tz + (qx * ty - qy * tx)
  ];
}

/**
 * 由屏幕矩形反算得到的世界表面网格 {points, nu, nv} 构造投影机 OBB。
 * @param {object} grid  { points:number[][], nu, nv } 行优先 (nu+1)×(nv+1)
 * @param {object} [opts] { depth?:number, toward?:number[] }  toward=相机位置，用于把法向翻到朝向相机一侧
 * @returns {{position:number[], quaternion:number[], half:number[], depth:number}|null}
 */
export function buildDecalProjector(grid, opts = {}) {
  const pts = grid && grid.points;
  if (!Array.isArray(pts) || pts.length < 4) return null;
  const nu = grid.nu != null ? grid.nu : Math.round(Math.sqrt(pts.length) - 1);
  const nv = grid.nv != null ? grid.nv : nu;
  if (nu < 1 || nv < 1) return null;
  // 中心
  let cx = 0, cy = 0, cz = 0;
  for (const p of pts) { cx += p[0]; cy += p[1]; cz += p[2]; }
  const n = pts.length;
  const center = [cx / n, cy / n, cz / n];
  // 边缘中点 -> 两个切向 -> 法向（right × up）
  const colMid = (i) => { let x = 0, y = 0, z = 0, c = 0; for (let j = 0; j <= nv; j++) { const p = pts[j * (nu + 1) + i]; x += p[0]; y += p[1]; z += p[2]; c++; } return [x / c, y / c, z / c]; };
  const rowMid = (j) => { let x = 0, y = 0, z = 0, c = 0; for (let i = 0; i <= nu; i++) { const p = pts[j * (nu + 1) + i]; x += p[0]; y += p[1]; z += p[2]; c++; } return [x / c, y / c, z / c]; };
  const rMid = colMid(nu), lMid = colMid(0), tMid = rowMid(nv), bMid = rowMid(0);
  const dx = [rMid[0] - lMid[0], rMid[1] - lMid[1], rMid[2] - lMid[2]];
  const dy = [tMid[0] - bMid[0], tMid[1] - bMid[1], tMid[2] - bMid[2]];
  /* 投影机局部基：X 轴 = 框选区域的水平方向（rMid→lMid 反向取 right），
     Y 轴 = 竖直方向，法向 = right × up。
     旧实现把 right 换成了从固定 seed（[1,0,0] 或 [0,0,1]）投影出来的任意切向 ——
     与用户框选的水平方向完全无关，于是 OBB 的局部 X 轴与表面实际延展不重合：
     · 盒的 X/Y 半尺寸按 3D 直线距离算，落到局部坐标里就偏大/偏小；
     · shader 里 uv = ln.xy*0.5+0.5 把视频贴到盒面上，盒与表面错位 →
       视频被拉到表面的错误位置，命中零散、其余像素被判「XY 出盒」丢弃。
     这里改为：先由框选方向定基，再把全部采样点投到该基下取真实轴向范围。 */
  let right0 = vunit(dx);
  let up0 = vunit(dy);
  let nrm = vunit(vcross(right0, up0));
  if (!Number.isFinite(nrm[0]) || (nrm[0] === 0 && nrm[1] === 0 && nrm[2] === 0)) {
    nrm = [0, 1, 0]; right0 = [1, 0, 0]; up0 = [0, 1, 0];
  }
  // 法向先翻到朝向相机一侧（若有 toward）：投影机盒的 +Z 指向观察者，
  // 贴花盒面法线才与视线同侧（背面剔除依赖这个符号）。
  if (Array.isArray(opts.toward)) {
    const toCam = [opts.toward[0] - center[0], opts.toward[1] - center[1], opts.toward[2] - center[2]];
    if (vdot(nrm, toCam) < 0) nrm = [-nrm[0], -nrm[1], -nrm[2]];
  }
  // 正交化：right 保留水平方向（去掉法向分量），up = nrm × right（右手系）
  const dotRN = vdot(right0, nrm);
  right0 = [right0[0] - nrm[0] * dotRN, right0[1] - nrm[1] * dotRN, right0[2] - nrm[2] * dotRN];
  let right = vunit(right0);
  if (!Number.isFinite(right[0])) right = [1, 0, 0];
  const up = vunit(vcross(nrm, right));
  /* 采样点投到局部基下求真实轴向范围：盒必须包住被框选的那块表面，
     否则 shader 里 |ln.x|>1 / |ln.y|>1 的像素会被整片丢掉（表现为「只有零星几块」）。 */
  let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
  let mnz = Infinity, mxz = -Infinity;
  for (const p of pts) {
    const rx = p[0] - center[0], ry = p[1] - center[1], rz = p[2] - center[2];
    const lx = vdot([rx, ry, rz], right);
    const ly = vdot([rx, ry, rz], up);
    const lz = vdot([rx, ry, rz], nrm);
    if (lx < mnx) mnx = lx; if (lx > mxx) mxx = lx;
    if (ly < mny) mny = ly; if (ly > mxy) mxy = ly;
    if (lz < mnz) mnz = lz; if (lz > mxz) mxz = lz;
  }
  if (!Number.isFinite(mnx)) return null;
  const margin = 0.05;
  const halfX = Math.max(0.1, (mxx - mnx) / 2 + margin);
  const halfY = Math.max(0.1, (mxy - mny) / 2 + margin);
  // Z 厚度：沿法向的起伏跨度 + 余量，保证表面整体落在盒内
  const halfZ = Math.max(0.1, (mxz - mnz) / 2 + margin);
  /* 盒心挪到局部包围盒中心：uv = ln.xy*0.5+0.5 的映射才与框选区域对齐，
     视频不会整体偏移半个盒宽。 */
  const cxLocal = (mxx + mnx) / 2;
  const cyLocal = (mxy + mny) / 2;
  const czLocal = (mxz + mnz) / 2;
  const pos = [
    center[0] + right[0] * cxLocal + up[0] * cyLocal + nrm[0] * czLocal,
    center[1] + right[1] * cxLocal + up[1] * cyLocal + nrm[1] * czLocal,
    center[2] + right[2] * cxLocal + up[2] * cyLocal + nrm[2] * czLocal
  ];
  const wantDepth = Number(opts.depth);
  const depth = Math.max(0.2, Number.isFinite(wantDepth) ? wantDepth : 0, halfZ * 2);
  return {
    position: pos,
    quaternion: quatFromBasis(right, up, nrm),
    half: [halfX, halfY, Math.max(halfZ, depth / 2)],
    depth
  };
}

/** 投影机 OBB 的 8 个世界角点（用于编辑器线框 / 手柄） */
export function projectorOBBCorners(projector) {
  if (!projector || !Array.isArray(projector.half) || !Array.isArray(projector.quaternion) || !Array.isArray(projector.position)) return null;
  const { position, quaternion, half } = projector;
  const out = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const r = rotateByQuat([sx * half[0], sy * half[1], sz * half[2]], quaternion);
    out.push([r[0] + position[0], r[1] + position[1], r[2] + position[2]]);
  }
  return out; // 顺序：x,y,z 各 ±，索引 = ((sx+1)/2)*4 + ((sy+1)/2)*2 + ((sz+1)/2)
}

/** 三维实体屏的世界空间四角 + 局部坐标系。
 *
 *  这是「不随视角变化而改变大小和朝向」的核心：矩形完全由世界坐标 point、
 *  世界尺寸 size（米）与固定 yaw/pitch 决定，与相机无关。相机转动时只是
 *  把这 4 个世界点重新投影，于是自然出现近大远小 / 侧面收窄 / 背面遮挡，
 *  和场景里一块真实显示屏模型的行为一致。
 *
 *  @returns {{corners:number[][], right:number[], up:number[],
 *             normal:number[], center:number[]}}
 *  corners 顺序对应源纹理 (0,0)(W,0)(W,H)(0,H)：左上 / 右上 / 右下 / 左下
 */
export function screenCorners(point, size = { w: 2.4, h: 1.35 }, yawDeg = 0, pitchDeg = 0) {
  const y = (Number(yawDeg) || 0) * Math.PI / 180;
  const p = (Number(pitchDeg) || 0) * Math.PI / 180;
  const w = Math.max(0.05, Number(size?.w) || 2.4) / 2;
  const h = Math.max(0.05, Number(size?.h) || 1.35) / 2;
  // yaw=0 时屏面朝 -Z（即默认相机所在的一侧）：right=-X、up=+Y、normal=-Z。
  // 这样新建的屏一落地就是正面可见；绕到屏背后才显示金属背板。
  // right × up = normal，保证纹理不会被镜像。
  const right = [-Math.cos(y), 0, Math.sin(y)];
  const nrm0 = [-Math.sin(y), 0, -Math.cos(y)];
  const cp = Math.cos(p), sp = Math.sin(p);
  const up = [nrm0[0] * sp, cp, nrm0[2] * sp];        // up0*cos p + nrm0*sin p
  const normal = [nrm0[0] * cp, -sp, nrm0[2] * cp];   // nrm0*cos p - up0*sin p
  const P = [Number(point?.[0]) || 0, Number(point?.[1]) || 0, Number(point?.[2]) || 0];
  const at = (sx, sy) => [
    P[0] + right[0] * w * sx + up[0] * h * sy,
    P[1] + right[1] * w * sx + up[1] * h * sy,
    P[2] + right[2] * w * sx + up[2] * h * sy,
  ];
  return { corners: [at(-1, 1), at(1, 1), at(1, -1), at(-1, -1)], right, up, normal, center: P };
}

/** 把单位矩形 (0,0)(W,0)(W,H)(0,H) 映射到任意投影四边形的 CSS matrix3d。
 *
 *  四点单应（homography）求解：先用仿射部分表达三个角，再由第四个角的偏差
 *  反推透视项 g/h。平行四边形会自然退化成 g=h=0（纯仿射）。
 *  元素需设 transform-origin:0 0、left:0、top:0、width:W、height:H。
 *  @returns {string|null} 'matrix3d(...)'；退化 / 非法输入返回 null
 */
export function homographyMatrix3d(q, W, H) {
  if (!Array.isArray(q) || q.length !== 4 || !(W > 0) || !(H > 0)) return null;
  const P = q.map(p => Array.isArray(p) ? { x: p[0], y: p[1] } : { x: p?.x, y: p?.y });
  if (P.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;
  const [p0, p1, p2, p3] = P;
  const dx1 = p1.x - p2.x, dy1 = p1.y - p2.y;
  const dx2 = p3.x - p2.x, dy2 = p3.y - p2.y;
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;
  let g = 0, h = 0;
  if (Math.abs(sx) > 1e-9 || Math.abs(sy) > 1e-9) {
    const den = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(den) < 1e-9) return null;           // 四点共线，透视退化
    g = (sx * dy2 - dx2 * sy) / den;
    h = (dx1 * sy - sx * dy1) / den;
  }
  const m = [
    (p1.x - p0.x + g * p1.x) / W, (p1.y - p0.y + g * p1.y) / W, 0, g / W,
    (p3.x - p0.x + h * p3.x) / H, (p3.y - p0.y + h * p3.y) / H, 0, h / H,
    0, 0, 1, 0,
    p0.x, p0.y, 0, 1,
  ];
  if (m.some(v => !Number.isFinite(v))) return null;
  return 'matrix3d(' + m.map(v => Number(v.toFixed(6))).join(',') + ')';
}

export function blankDoc() {
  return {
    version: SCHEMA_VERSION,
    title: '茂名展示馆 · 场景标注',
    annotations: [],
    groups: defaultGroups(),
    layers: [{ id: 'default', name: '默认图层', color: '#22d3ee', visible: true }],
    tours: [],                  // [{id,name,stops:[{annotationId,view,dwell,title,body}]}]
    calibration: { scale: 1, unit: 'm', groundY: -0.644, north: 0 },
    updatedAt: new Date().toISOString(),
  };
}

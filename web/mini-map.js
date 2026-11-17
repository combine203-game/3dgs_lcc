/**
 * 每个场景的「三维导航小地图」——户型图驱动的连续墙体版本。
 *
 * 两段式技术路线：
 *   ① 二维户型图  ./sog/<scene>/floor-plan.json（当前由
 *      tools/build_slice_plan.py 生成；tools/build_floor_plan.py 是旧的
 *      全高度投影栅格路线，两者输出同一 schema）
 *      官方碰撞 PLY → 在 Z=1.6 m 附近水平切片 → 按三角形高度 + 法线
 *      二值化成 墙 / 地面 / 天花板（天花板直接丢弃，顶部开放）
 *      → 求三角形与切平面的精确交线，沿 -Z 俯视投影到 (X,Z)
 *      → 密集短交线拼成连续折线 → 0.15 m 二值墙图 → cv2 轮廓提取
 *      → 得到每个墙连通域的**闭合连续边界环**（outer + holes）。
 *   ② 三维简化模型  本文件把每条闭合环沿整条折线拉升：
 *      相邻段共享顶点（quad strip），顶面是一整片按绕向填充的墙带，
 *      因此墙是连续的一整片曲面，绝不会出现离散的小长方体。
 *
 * ./sog/<scene>/nav-map.json 仍提供房间名称 / 可达域 / 不穿墙 BFS 通道 /
 * 出生点等拓扑信息；只有存在全程不穿墙最短路径的房间之间才连通道线。
 * floor-plan.json 缺失时自动回退到旧的 wallVectors 逐段拉升渲染。
 *
 * 渲染：Canvas 2D 轴测投影，顶部开放（无天花板）、半透明玻璃蓝立面 +
 * 连续顶面高光 + 墙面分格；俯视时自动退化成纯二维户型图。可拖动旋转、
 * 滚轮缩放，不新建 WebGL/WebGPU 上下文，不与主场景渲染器争抢资源。
 *
 *   initMiniMap({ scene, getPose, label })
 *   window.__mgMiniMap.getState() 供 CDP / 控制台回归测试读取
 */

const DEFAULT_YAW = -0.55;
const PITCH_3D = 0.78;
const PITCH_TOP = Math.PI / 2;
const WALL_THICKNESS_FALLBACK = 0.34;   // 老 nav-map.json 没有 thickness 时用
const WALL_VIS_GAIN = 1.35;             // 示意图里墙厚略放大，顶面才看得清

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function initMiniMap({ scene, getPose, label = '', base = './sog/' } = {}) {
  const box = document.getElementById('mg-minimap');
  const canvas = document.getElementById('mg-mm-canvas');
  if (!box || !canvas) return null;
  const ctx = canvas.getContext('2d');
  const $ = (id) => document.getElementById(id);
  const sceneEl = $('mg-mm-scene');
  const posEl = $('mg-mm-pos');
  const zoneEl = $('mg-mm-zone');
  const modeBtn = $('mg-mm-mode');
  const followBtn = $('mg-mm-follow');
  if (sceneEl) sceneEl.textContent = label || scene;

  let doc = null;
  let plan = null;                // 二维户型图（新路线）；null 时回退旧墙矢量线
  let exhibitDoc = null;          // ./sog/exhibits.json：三维实景识别到的展厅锚点
  let exhibits = [];              // 当前场景的展厅列表
  let activeExhibit = null;       // 漫游中识别到的展厅 id
  let labelHits = [];             // 本帧标签命中框（canvas 点击 → 内容卡片）
  let onExhibitSelect = null;     // 外部注入的点击回调
  let focus = null;
  let yaw = DEFAULT_YAW;
  let pitch = PITCH_3D;
  let zoom = 1;
  let userScale = 1;
  let follow = true;              // 默认开启跟随模式（相机跟随并放大）
  let hidden = false;
  let wallStyle = 'glass';        // 'glass' = 拉升玻璃墙；'flat' = 旧的零厚度立面
  let W = 1, H = 1, dpr = 1;
  let cx = 0, cz = 0;
  let lastDraw = 0;
  const state = {
    ready: false, scene, visible: true, error: null, rooms: 0, links: 0,
    components: 0, room: null, component: null, camera: null,
    headingDeg: 0, yaw: 0, zoom: 1, mode: '3d', follow: false,
    walls: 0, wallVectors: 0, wallHeight: 0, ceilingTriangles: 0,
    ceilingRemoved: false, wallStyle: 'glass',
    floorPlan: false, planRegions: 0, planRings: 0, planVertices: 0,
    planRooms: 0, wallSource: 'legacy',
    exhibits: 0, activeExhibit: null, exhibitLabels: [], exhibitSource: null
  };

  function resize() {
    // HUD 整体由 #stage 的 zoom 等比缩放：clientWidth 是未缩放的逻辑尺寸，
    // 实际渲染宽度还要乘 zoom。backing store 必须把这个倍数算进去，
    // 否则 4K / 16:10 大屏上小地图会被拉伸放大而发虚。
    const stage = document.getElementById('stage');
    const zoom = stage ? (parseFloat(getComputedStyle(stage).zoom) || 1) : 1;
    dpr = Math.min((window.devicePixelRatio || 1) * zoom, 3);
    W = Math.max(1, canvas.clientWidth);
    H = Math.max(1, canvas.clientHeight);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // 全量栅格覆盖整块地形（含空旷室外），直接用它取景会把建筑挤成一小团。
  // 默认改以「房间 + 墙体 + 通道端点」的包围盒取景，让房间拓扑看得分明。
  function computeFocus() {
    const pts = [];
    if (plan?.wallRings?.length) {
      // 户型图的连续墙环就是建筑主体，取景最贴合真实平面
      for (const ring of plan.wallRings) {
        for (const p of ring.pts) pts.push(p);
      }
    } else {
      for (const room of doc.rooms) {
        for (const r of room.rects) {
          pts.push([r[0], r[1]], [r[2], r[3]]);
        }
      }
      for (const w of doc.walls) pts.push([w[0], w[1]], [w[2], w[3]]);
    }
    if (!pts.length) return doc.bounds;
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const [x, z] of pts) {
      a = Math.min(a, x); b = Math.min(b, z);
      c = Math.max(c, x); d = Math.max(d, z);
    }
    // 少量离群墙段（远处室外残墙）会把取景拉到整块地形，建筑主体被
    // 压成中间一小团。改用 3%~97% 分位数取紧凑视野，离群段由画布裁剪。
    const xs = pts.map(p => p[0]).sort((p, q) => p - q);
    const zs = pts.map(p => p[1]).sort((p, q) => p - q);
    const qt = (arr, f) => arr[Math.min(arr.length - 1, Math.floor(arr.length * f))];
    a = qt(xs, 0.03); c = qt(xs, 0.97);
    b = qt(zs, 0.03); d = qt(zs, 0.97);
    const spanX = Math.max(c - a, 22), spanZ = Math.max(d - b, 22);
    const mx = Math.max(3, spanX * 0.10), mz = Math.max(3, spanZ * 0.10);
    return { minX: a - mx, minZ: b - mz, maxX: c + mx, maxZ: d + mz };
  }

  function reset() {
    yaw = DEFAULT_YAW;
    userScale = 1;
    follow = false;
    state.follow = false;
    state.yaw = +yaw.toFixed(3);
    state.zoom = 1;
    if (doc) {
      const b = focus || doc.bounds;
      cx = (b.minX + b.maxX) / 2;
      cz = (b.minZ + b.maxZ) / 2;
    }
    syncButtons();
  }

  function syncButtons() {
    if (modeBtn) {
      modeBtn.textContent = pitch === PITCH_TOP ? '俯视' : '3D';
      modeBtn.classList.toggle('mg-on', pitch !== PITCH_TOP);
      modeBtn.title = pitch === PITCH_TOP ? '切回三维轴测视图' : '切到正俯视二维图';
    }
    if (followBtn) {
      followBtn.classList.toggle('mg-on', follow);
      followBtn.title = follow ? '关闭相机跟随（回到全景）' : '跟随相机并放大';
    }
    const wallBtn = $('mg-mm-wall');
    if (wallBtn) {
      wallBtn.textContent = wallStyle === 'glass' ? '玻璃' : '线框';
      wallBtn.classList.toggle('mg-on', wallStyle === 'glass');
      wallBtn.title = wallStyle === 'glass'
        ? (plan
            ? '当前：二维户型图的连续墙环拉升成整片玻璃蓝墙体（无天花板），点此切到线段对照'
            : '当前：碰撞体投影拉升的玻璃蓝墙体（户型图数据缺失，旧路线）')
        : '当前：零厚度线段立面（旧路线对照），点此切到连续墙体';
    }
  }

  function fitScale() {
    if (!doc) return 1;
    const b = focus || doc.bounds;
    const corners = [[b.minX, b.minZ], [b.minX, b.maxZ],
                     [b.maxX, b.minZ], [b.maxX, b.maxZ]];
    const c = Math.cos(yaw), s = Math.sin(yaw), sp = Math.sin(pitch);
    let mx = 1e-6, my = 1e-6;
    for (const [x, z] of corners) {
      const dx = x - cx, dz = z - cz;
      mx = Math.max(mx, Math.abs(dx * c - dz * s));
      my = Math.max(my, Math.abs((dx * s + dz * c) * sp) + doc.wallHeight * 0.35);
    }
    return Math.min(W / (2 * mx), H / (2 * my)) * 0.95;
  }

  // 世界 (x,y,z) → 屏幕；返回值第三项是画家算法用的深度
  function project(x, y, z, scale) {
    const dx = x - cx, dz = z - cz;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const rx = dx * c - dz * s;
    const rz = dx * s + dz * c;
    const sp = Math.sin(pitch), cp = Math.cos(pitch);
    return [W / 2 + rx * scale, H / 2 + rz * scale * sp - y * scale * cp,
            rz * cp + y * sp];
  }

  function poly(points, fill, stroke, width = 1) {
    if (!points.length) return;
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = width; ctx.stroke(); }
  }

  function rectPrism(r, h, top, side, edge, scale) {
    const [x0, z0, x1, z1] = r;
    const a = project(x0, h, z0, scale), b = project(x1, h, z0, scale);
    const c = project(x1, h, z1, scale), d = project(x0, h, z1, scale);
    if (h > 0.001) {
      const b0 = project(x1, 0, z0, scale);
      const c0 = project(x1, 0, z1, scale);
      const d0 = project(x0, 0, z1, scale);
      poly([b, c, c0, b0], side, null);
      poly([d, c, c0, d0], side, null);
    }
    poly([a, b, c, d], top, edge, edge ? 0.8 : 0);
  }

  function pointInRect(x, z, r) {
    return x >= r[0] && x <= r[2] && z >= r[1] && z <= r[3];
  }

  function locate(x, z) {
    for (const room of doc.rooms) {
      for (const r of room.rects) {
        if (pointInRect(x, z, r)) return room;
      }
    }
    // 房间矩形是「墙膨胀后剩下的内部」，相机站在门洞或贴墙时可能刚好落在
    // 矩形外；用房间包围盒外扩 1 m 再判一次，避免把室内机位误报成室外。
    let best = null, bestD = Infinity;
    for (const room of doc.rooms) {
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const r of room.rects) {
        x0 = Math.min(x0, r[0]); z0 = Math.min(z0, r[1]);
        x1 = Math.max(x1, r[2]); z1 = Math.max(z1, r[3]);
      }
      const d = Math.hypot(Math.max(x0 - x, 0, x - x1),
                           Math.max(z0 - z, 0, z - z1));
      if (d <= 1 && d < bestD) { best = room; bestD = d; }
    }
    return best;
  }

  /* 三维实景识别结果按世界坐标覆盖 nav-map.json 的旧房间名。
     优先用锚点坐标 (X,Z) 与房间质心做最近匹配（<2.5 m），找不到再按
     名称 / 历史旧名兜底。返回 null 时标签仍用 nav-map 原名。 */
  function exhibitForRoom(room) {
    if (!exhibits.length || !room?.centroid) return null;
    let best = null, bd = Infinity;
    for (const ex of exhibits) {
      if (!ex.map) continue;
      const d = Math.hypot(ex.map[0] - room.centroid[0],
                           ex.map[1] - room.centroid[1]);
      if (d < bd) { bd = d; best = ex; }
    }
    if (best && bd <= 2.5) return best;
    return exhibits.find((e) => e.name === room.name ||
      (e.previousNames || []).includes(room.name)) || null;
  }
  function applyExhibits() {
    exhibits = (exhibitDoc?.scenes?.[state.scene] || []).slice();
    state.exhibits = exhibits.length;
    state.exhibitSource = exhibitDoc ? 'exhibits.json' : null;
  }

  // ---- 地面网格 + 十字星点（等距导航图的深色底） ----
  let stars = null;
  function drawGrid(scale) {
    const b = doc.bounds;
    const step = 5;
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(105,148,198,.085)';
    ctx.beginPath();
    for (let x = Math.ceil(b.minX / step) * step; x <= b.maxX; x += step) {
      const p = project(x, 0, b.minZ, scale), q = project(x, 0, b.maxZ, scale);
      ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]);
    }
    for (let z = Math.ceil(b.minZ / step) * step; z <= b.maxZ; z += step) {
      const p = project(b.minX, 0, z, scale), q = project(b.maxX, 0, z, scale);
      ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(120,168,220,.16)';
    ctx.beginPath();
    for (let x = Math.ceil(b.minX / 20) * 20; x <= b.maxX; x += 20) {
      const p = project(x, 0, b.minZ, scale), q = project(x, 0, b.maxZ, scale);
      ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]);
    }
    for (let z = Math.ceil(b.minZ / 20) * 20; z <= b.maxZ; z += 20) {
      const p = project(b.minX, 0, z, scale), q = project(b.maxX, 0, z, scale);
      ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]);
    }
    ctx.stroke();
    if (!stars) {
      stars = [];
      for (let x = Math.ceil(b.minX / 10) * 10; x <= b.maxX; x += 10)
        for (let z = Math.ceil(b.minZ / 10) * 10; z <= b.maxZ; z += 10)
          stars.push([x, z]);
    }
    ctx.strokeStyle = 'rgba(160,200,240,.34)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (const [x, z] of stars) {
      const p = project(x, 0, z, scale);
      if (p[0] < -4 || p[0] > W + 4 || p[1] < -4 || p[1] > H + 4) continue;
      ctx.moveTo(p[0] - 2.4, p[1]); ctx.lineTo(p[0] + 2.4, p[1]);
      ctx.moveTo(p[0], p[1] - 2.4); ctx.lineTo(p[0], p[1] + 2.4);
    }
    ctx.stroke();
  }

  function lerpP(a, b, u) {
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
  }

  function stroke3(a, b, color, width = 0.7) {
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
  }

  // 房间 / 可达域只画「地面」，绝不画顶板：顶部开放才能看见室内
  function groundQuad(r, fill, scale, stroke) {
    const [x0, z0, x1, z1] = r;
    const a = project(x0, 0.02, z0, scale), b = project(x1, 0.02, z0, scale);
    const c = project(x1, 0.02, z1, scale), d = project(x0, 0.02, z1, scale);
    poly([a, b, c, d], fill, stroke, stroke ? 0.8 : 0);
  }

  /**
   * 把二维墙矢量线拉升成顶部开放的三维墙体。
   * 每条 [x0,z0,x1,z1,t] 沿法线扩成宽 t 的矩形，四个立面 + 一个顶面，
   * 所有面片按投影深度统一排序（画家算法），因此玻璃墙能正确前后遮挡。
   */
  function glassGeometry(scale) {
    const src = (doc.wallVectors && doc.wallVectors.length)
      ? doc.wallVectors : (doc.walls || []);
    const h = doc.wallHeight || 2.8;
    const baseT = doc.wallThickness || WALL_THICKNESS_FALLBACK;
    const faces = [], footprints = [];
    for (const s of src) {
      const [ax, az, bx, bz] = s;
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.6) continue;
      const nx = -(bz - az) / len, nz = (bx - ax) / len;
      const half = ((s[4] || baseT) * WALL_VIS_GAIN) / 2;
      const foot = [
        [ax + nx * half, az + nz * half],
        [bx + nx * half, bz + nz * half],
        [bx - nx * half, bz - nz * half],
        [ax - nx * half, az - nz * half],
      ];
      const bot = foot.map(([x, z]) => project(x, 0, z, scale));
      const top = foot.map(([x, z]) => project(x, h, z, scale));
      footprints.push(bot);
      // 背面剔除：只画朝向观察者近侧的两个立面。四个立面都画时
      // 半透明会叠 4 层，墙会过曝成一团白块，玻璃感也没了。
      const mx0 = (ax + bx) / 2, mz0 = (az + bz) / 2;
      const vx = Math.sin(yaw), vz = Math.cos(yaw);
      for (let i = 0; i < 4; i++) {
        const j = (i + 1) % 4;
        const mx = (foot[i][0] + foot[j][0]) / 2;
        const mz = (foot[i][1] + foot[j][1]) / 2;
        if ((mx - mx0) * vx + (mz - mz0) * vz <= 0) continue;
        faces.push({
          kind: 'side', quad: [bot[i], bot[j], top[j], top[i]],
          depth: project(mx, h / 2, mz, scale)[2],
        });
      }
      faces.push({
        kind: 'top', quad: [top[0], top[1], top[2], top[3]],
        depth: project((ax + bx) / 2, h, (az + bz) / 2, scale)[2] + 0.001,
      });
    }
    faces.sort((a, b) => a.depth - b.depth);
    return { faces, footprints };
  }

  function drawGlassWalls(scale) {
    const { faces, footprints } = glassGeometry(scale);
    // 墙脚投影阴影，让玻璃墙「落地」而不是浮在网格上
    for (const f of footprints) poly(f, 'rgba(3,9,18,.28)', null);
    for (const f of faces) {
      const q = f.quad;
      if (f.kind === 'top') {
        // 封顶：实心高不透明度顶盖，墙体读起来是封顶的实心立面
        poly(q, 'rgba(118,166,230,.62)', 'rgba(212,238,255,.80)', 1.2);
      } else {
        // 立面：统一竖向玻璃蓝渐变，去掉竖向玻璃缝与腰线 → 薄墙合并为单一立面
        const g = ctx.createLinearGradient(q[0][0], q[0][1], q[3][0], q[3][1]);
        g.addColorStop(0, 'rgba(40,72,128,.34)');
        g.addColorStop(0.55, 'rgba(70,120,188,.42)');
        g.addColorStop(1, 'rgba(126,178,238,.50)');
        poly(q, g, 'rgba(96,146,208,.34)', 0.6);
      }
    }
  }

  // ---------- 新路线：二维矢量户型图 -> 一整片连续三维墙体 ----------

  function pathRing(pts, y, scale) {
    for (let i = 0; i < pts.length; i++) {
      const p = project(pts[i][0], y, pts[i][1], scale);
      if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
    }
    ctx.closePath();
  }

  // 一个墙区域 = 外环 + 若干房间洞；even-odd 填充得到整片连续墙带
  function pathRegion(reg, y, scale) {
    ctx.beginPath();
    pathRing(reg.outer, y, scale);
    for (const h of reg.holes || []) pathRing(h, y, scale);
  }

  function groundPoly(pts, fill, scale, stroke) {
    if (!pts || pts.length < 3) return;
    poly(pts.map(([x, z]) => project(x, 0.02, z, scale)),
         fill, stroke, stroke ? 0.8 : 0);
  }

  /**
   * 沿每条闭合墙环生成共享顶点的连续 quad strip：
   *   · 每段 Pi->Pi+1 复用同一个端点投影，相邻段之间不留缝隙；
   *   · 顶面用 even-odd 一次画完，是一整片墙带而非若干独立小顶盖；
   *   · 环首尾相接，所以一整片墙是连通曲面，绝不会散成小长方体。
   * 俯视（pitch = PI/2）时高度投影为 0，自动退化成纯二维户型图。
   */
  function drawFloorPlanWalls(scale) {
    const h = plan.wallHeight || 2.8;
    const regions = plan.wallRegions || [];
    const rings = plan.wallRings || [];
    if (!regions.length || !rings.length) return;

    // 1) 墙脚阴影：户型图贴地投影，让墙「落地」
    for (const reg of regions) {
      pathRegion(reg, 0.02, scale);
      ctx.fillStyle = 'rgba(2,8,16,.40)';
      ctx.fill('evenodd');
    }

    // 2) 连续侧壁：每条环的每个线段一张 quad，按深度做画家算法。
    //    薄墙合并成单一立面：去掉每段竖向玻璃缝与腰线，改用统一的竖向玻璃渐变，
    //    相邻薄墙段之间不再有分割线，整体读作一整片连续的墙面（而非一片片玻璃板）。
    const faces = [];
    for (const ring of rings) {
      const pts = ring.pts;
      const bot = pts.map(([x, z]) => project(x, 0, z, scale));
      const top = pts.map(([x, z]) => project(x, h, z, scale));
      for (let i = 0; i < pts.length; i++) {
        const j = (i + 1) % pts.length;
        faces.push({
          quad: [bot[i], bot[j], top[j], top[i]],
          depth: project((pts[i][0] + pts[j][0]) / 2, h / 2,
                         (pts[i][1] + pts[j][1]) / 2, scale)[2],
        });
      }
    }
    faces.sort((a, b) => a.depth - b.depth);
    for (const f of faces) {
      const q = f.quad;
      // 统一竖向玻璃蓝渐变（底深顶亮），不随分段变化 → 薄墙段无缝合并成单一立面
      const g = ctx.createLinearGradient(q[0][0], q[0][1], q[3][0], q[3][1]);
      g.addColorStop(0, 'rgba(40,72,128,.34)');
      g.addColorStop(0.55, 'rgba(70,120,188,.42)');
      g.addColorStop(1, 'rgba(126,178,238,.50)');
      // 同色极淡描边只用于吃掉相邻 quad 的抗锯齿缝，不引入可见分割线
      poly(q, g, 'rgba(96,146,208,.34)', 0.6);
    }

    // 3) 一整片连续墙顶 —— 实心封闭顶：更高的不透明度让墙体读起来是「封顶的
    //    实心立面」，不再像开放玻璃盒子；保留沿整条环一笔完成的白色高光边。
    for (const reg of regions) {
      pathRegion(reg, h, scale);
      ctx.fillStyle = 'rgba(118,166,230,.62)';
      // 按绕向填充：cv2 的 outer / hole 绕向相反，洞自动镂空；
      // 比 even-odd 更抗「墙带来回折线」的自交抵消
      ctx.fill('nonzero');
      ctx.strokeStyle = 'rgba(212,238,255,.80)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
    for (const ring of rings) {
      ctx.beginPath();
      pathRing(ring.pts, h, scale);
      ctx.strokeStyle = 'rgba(226,244,255,.58)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
  }

  // 旧的零厚度立面，仅作为对照 / 低性能回退
  function drawFlatWalls(scale) {
    const wallItems = doc.walls.map((w) => ({
      w, depth: project(w[0], doc.wallHeight / 2, w[1], scale)[2],
    }));
    wallItems.sort((a, b) => a.depth - b.depth);
    for (const it of wallItems) {
      const [ax, az, bx, bz] = it.w;
      const p0 = project(ax, 0, az, scale), p1 = project(bx, 0, bz, scale);
      const q1 = project(bx, doc.wallHeight, bz, scale);
      const q0 = project(ax, doc.wallHeight, az, scale);
      const horiz = Math.abs(bx - ax) > Math.abs(bz - az);
      poly([p0, p1, q1, q0],
           horiz ? 'rgba(104,132,170,.52)' : 'rgba(76,100,136,.52)',
           'rgba(150,185,225,.42)', 0.7);
    }
  }

  function drawCompass(scale) {
    const ox = 24, oy = 24, r = 12;
    ctx.beginPath();
    ctx.arc(ox, oy, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(10,17,27,.72)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(140,170,210,.45)';
    ctx.lineWidth = 1;
    ctx.stroke();
    const o = project(0, 0, 0, scale), n = project(0, 0, -1, scale);
    let vx = n[0] - o[0], vy = n[1] - o[1];
    const len = Math.hypot(vx, vy) || 1;
    vx /= len; vy /= len;
    ctx.beginPath();
    ctx.moveTo(ox + vx * (r - 3), oy + vy * (r - 3));
    ctx.lineTo(ox - vx * 5 - vy * 4, oy - vy * 5 + vx * 4);
    ctx.lineTo(ox - vx * 5 + vy * 4, oy - vy * 5 - vx * 4);
    ctx.closePath();
    ctx.fillStyle = '#63e2ff';
    ctx.fill();
    ctx.fillStyle = '#a9d8e8';
    ctx.font = '9px Consolas, monospace';
    ctx.fillText('N', ox - 3, oy - r - 3);
  }

  function drawCamera(pose, scale) {
    if (!pose || !pose.position) return;
    const [x, y, z] = pose.position;
    const t = pose.target || [x, y, z - 1];
    let fx = t[0] - x, fz = t[2] - z;
    const fl = Math.hypot(fx, fz) || 1;
    fx /= fl; fz /= fl;
    const h = clamp(y - doc.groundY, 0.15, doc.wallHeight + 3);

    // 地面视锥：以相机为顶点、朝向为轴的扇形，直观表达「看哪儿」
    const half = 0.52, reach = 7;
    const fan = [project(x, 0.04, z, scale)];
    for (let i = 0; i <= 14; i++) {
      const a = Math.atan2(fx, fz) - half + (2 * half * i / 14);
      fan.push(project(x + Math.sin(a) * reach, 0.04,
                       z + Math.cos(a) * reach, scale));
    }
    poly(fan, 'rgba(99,226,255,.15)', 'rgba(99,226,255,.45)', 1);

    // 相机立柱 + 朝向箭头（真正的 3D 线段，随视角倾斜）
    const p0 = project(x, 0, z, scale);
    const p1 = project(x, h, z, scale);
    ctx.beginPath();
    ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]);
    ctx.strokeStyle = 'rgba(99,226,255,.85)'; ctx.lineWidth = 2; ctx.stroke();
    const tip = project(x + fx * 2.4, h, z + fz * 2.4, scale);
    const side = 0.62;
    const l = project(x + fx * 1.4 - fz * side, h, z + fz * 1.4 + fx * side, scale);
    const r = project(x + fx * 1.4 + fz * side, h, z + fz * 1.4 - fx * side, scale);
    ctx.beginPath();
    ctx.moveTo(p1[0], p1[1]); ctx.lineTo(tip[0], tip[1]);
    ctx.strokeStyle = '#63e2ff'; ctx.lineWidth = 2.4; ctx.stroke();
    poly([tip, l, r], '#63e2ff', null);

    ctx.beginPath();
    ctx.arc(p1[0], p1[1], 7, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(99,226,255,.25)'; ctx.fill();
    ctx.beginPath();
    ctx.arc(p1[0], p1[1], 3.4, 0, Math.PI * 2);
    ctx.fillStyle = '#c9f3ff'; ctx.fill();
  }

  function render(pose) {
    if (!doc) return;
    const scale = fitScale() * (follow ? 2.0 : 1) * userScale;
    ctx.clearRect(0, 0, W, H);
    const bg = ctx.createRadialGradient(W * 0.5, H * 0.42, 8,
                                        W * 0.5, H * 0.5, Math.max(W, H) * 0.8);
    bg.addColorStop(0, '#111d2e');
    bg.addColorStop(0.6, '#0b1522');
    bg.addColorStop(1, '#060c15');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // 地面蓝色导航网格底（drawGrid）按需求不再绘制；青色可达通道亦按需求不再绘制。
    // （地面可达栅格贴图 doc.floor 此前也已去掉）

    // （导航地图只保留房间地面着色 + 玻璃墙体）
    // 房间 → 只给地面着色 + 轮廓线，不抬高、不加盖板（顶部开放）
    for (const room of doc.rooms) {
      for (const r of room.rects) groundQuad(r, hexA(room.color, 0.11), scale);
    }
    if (plan?.rooms?.length) {
      // 户型图房间多边形：一圈连续边界，比矩形拼块更像真实房型
      for (const room of plan.rooms) {
        groundPoly(room.polygon, hexA(room.color, 0.10), scale,
                   hexA(room.color, 0.42));
      }
    } else {
      for (const room of doc.rooms) {
        for (const r of room.rects) groundQuad(r, null, scale, hexA(room.color, 0.38));
      }
    }
    // （需求：青色可达通道不再绘制，导航地图仅保留房间地面着色与墙体）
    // 二维户型图的连续墙环 → 拉升成顶部开放的整片三维玻璃蓝墙体
    if (wallStyle === 'glass') {
      if (plan?.wallRings?.length) drawFloorPlanWalls(scale);
      else drawGlassWalls(scale);          // 户型图缺失时回退旧矢量线段
    } else drawFlatWalls(scale);
    // 房间标签：重叠时按「原位 → 上下 → 左右 → 斜向」找邻近空位，
    // 而不是直接丢弃标签（小房间密集 / 全景缩放小时会漏掉多个展厅名）。
    // 偏移过的标签用一条细引导线连回房间中心，避免看起来张冠李戴。
    ctx.font = '10px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    const labels = [];
    labelHits = [];
    const LABEL_OFFSETS = [
      [0, 0], [0, -16], [0, 16], [-52, 0], [52, 0],
      [-52, -16], [52, -16], [-52, 16], [52, 16],
      [0, -32], [0, 32], [-88, -8], [88, -8]
    ];
    for (const room of doc.rooms) {
      const ex = exhibitForRoom(room);
      // 三维实景识别到的名称按坐标覆盖 nav-map 里的旧标签
      const text = ex?.name || room.name;
      const isActive = !!(ex && ex.id === activeExhibit);
      const replaced = !!(ex && ex.name !== room.name);
      const p = project(room.centroid[0], 0.25, room.centroid[1], scale);
      // 跟随模式会放大取景，远处房间的中心可能落在画布外：把标签基准点
      // 收进画布内（仍画引导线指明方向），避免该展厅的名字整个消失。
      const anchorX = clamp(p[0], 40, Math.max(40, W - 40));
      const anchorY = clamp(p[1], 20, Math.max(20, H - 20));
      const tw = ctx.measureText(text).width;
      let hit = null;
      for (const [dx, dy] of LABEL_OFFSETS) {
        const cx = anchorX + dx, cy = anchorY + dy;
        const bx = cx - tw / 2 - 4, by = cy - 11, bw = tw + 8, bh = 14;
        if (bx < 1 || by < 1 || bx + bw > W - 1 || by + bh > H - 1) continue;
        if (labels.some(o => bx < o.x + o.w && bx + bw > o.x &&
                             by < o.y + o.h && by + bh > o.y)) continue;
        hit = { x: bx, y: by, w: bw, h: bh, cx, cy };
        break;
      }
      if (!hit) continue;
      labels.push(hit);
      labelHits.push({ x: hit.x, y: hit.y, w: hit.w, h: hit.h,
                       id: ex?.id || null, name: text, room: room.name });
      ctx.fillStyle = isActive ? 'rgba(9,42,45,.94)' : 'rgba(8,14,22,.82)';
      ctx.fillRect(hit.x, hit.y, hit.w, hit.h);
      if (isActive || replaced) {
        ctx.strokeStyle = isActive ? '#7dffd0' : hexA(room.color, 0.85);
        ctx.lineWidth = isActive ? 1.4 : 0.8;
        ctx.strokeRect(hit.x + .5, hit.y + .5, hit.w - 1, hit.h - 1);
      }
      ctx.fillStyle = isActive ? '#a9ffdc' : (ex ? '#c6ecff' : room.color);
      ctx.fillText(text, hit.cx, hit.cy);
      if (hit.cx !== p[0] || hit.cy !== p[1]) {
        ctx.strokeStyle = hexA(room.color, 0.45);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(p[0], p[1]);
        ctx.lineTo(hit.cx, hit.cy > p[1] ? hit.y - 1 : hit.y + hit.h + 1);
        ctx.stroke();
      }
      if (isActive) {                 // 当前识别到的展厅：锚点脉冲圆环
        ctx.beginPath();
        ctx.arc(p[0], p[1], 5 + 2 * Math.sin(performance.now() / 260), 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(125,255,208,.85)';
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
    }
    // 没有落在任何 nav-map 房间里的实景锚点，仍按 exhibits.json 的
    // 世界坐标直接打标签（例如现场后续新增的展厅标注）。
    for (const ex of exhibits) {
      if (!ex.map || labelHits.some((h) => h.id === ex.id)) continue;
      const p = project(ex.map[0], 0.25, ex.map[1], scale);
      if (p[0] < -20 || p[0] > W + 20 || p[1] < -20 || p[1] > H + 20) continue;
      const ax = clamp(p[0], 40, Math.max(40, W - 40));
      const ay = clamp(p[1], 20, Math.max(20, H - 20));
      const tw = ctx.measureText(ex.name).width;
      let hit = null;
      for (const [dx, dy] of LABEL_OFFSETS) {
        const cx = ax + dx, cy = ay + dy;
        const bx = cx - tw / 2 - 4, by = cy - 11, bw = tw + 8, bh = 14;
        if (bx < 1 || by < 1 || bx + bw > W - 1 || by + bh > H - 1) continue;
        if (labels.some(o => bx < o.x + o.w && bx + bw > o.x &&
                             by < o.y + o.h && by + bh > o.y)) continue;
        hit = { x: bx, y: by, w: bw, h: bh, cx, cy };
        break;
      }
      if (!hit) continue;
      labels.push(hit);
      labelHits.push({ x: hit.x, y: hit.y, w: hit.w, h: hit.h,
                       id: ex.id, name: ex.name, room: null });
      ctx.fillStyle = 'rgba(8,14,22,.86)';
      ctx.fillRect(hit.x, hit.y, hit.w, hit.h);
      ctx.strokeStyle = 'rgba(99,226,255,.75)';
      ctx.lineWidth = .8;
      ctx.strokeRect(hit.x + .5, hit.y + .5, hit.w - 1, hit.h - 1);
      ctx.fillStyle = '#c6ecff';
      ctx.fillText(ex.name, hit.cx, hit.cy);
    }
    state.exhibitLabels = labelHits.map((h) => h.name);
    ctx.textAlign = 'left';

    drawCamera(pose, scale);
    drawCompass(scale);

    // 状态栏：坐标 / 朝向 / 当前房间与可达域
    if (pose?.position) {
      const [x, y, z] = pose.position;
      const t = pose.target || [x, y, z - 1];
      const deg = (Math.atan2(t[0] - x, -(t[2] - z)) * 180 / Math.PI + 360) % 360;
      state.headingDeg = +deg.toFixed(1);
      state.camera = [+x.toFixed(2), +y.toFixed(2), +z.toFixed(2)];
      const room = locate(x, z);
      const exRoom = room ? exhibitForRoom(room) : null;
      const activeEx = exhibits.find((e) => e.id === activeExhibit) || null;
      state.room = activeEx?.name || exRoom?.name || (room ? room.name : '室外 / 公共区');
      state.component = room ? room.component : null;
      if (posEl) posEl.textContent = `${x.toFixed(1)}, ${z.toFixed(1)} · ${deg.toFixed(0)}°`;
      if (zoneEl) {
        zoneEl.textContent = activeEx
          ? `已识别 · ${activeEx.name}`
          : (exRoom
              ? `${exRoom.name} · 可达域 ${room.component}`
              : (room ? `${room.name} · 可达域 ${room.component}` : '室外 / 公共区'));
        zoneEl.style.color = activeEx ? '#7dffd0' : (room ? room.color : '');
      }
    }
    state.yaw = +yaw.toFixed(3);
    state.zoom = +userScale.toFixed(2);
  }

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  function tick(now) {
    requestAnimationFrame(tick);
    if (hidden || !doc || now - lastDraw < 70) return;
    lastDraw = now;
    let pose = null;
    try { pose = getPose?.(); } catch (_) { /* viewer 尚未就绪 */ }
    if (follow && pose?.position) {
      cx += (pose.position[0] - cx) * 0.25;
      cz += (pose.position[2] - cz) * 0.25;
    }
    render(pose);
  }

  // ---- 交互 ----
  let dragging = false, lastX = 0;
  canvas.addEventListener('pointerdown', (e) => {
    dragging = true; lastX = e.clientX;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    yaw += (e.clientX - lastX) * 0.008;
    lastX = e.clientX;
  });
  canvas.addEventListener('pointerup', () => { dragging = false; });
  canvas.addEventListener('pointercancel', () => { dragging = false; });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    userScale = clamp(userScale * (e.deltaY > 0 ? 0.9 : 1.1), 0.4, 8);
  }, { passive: false });
  // 点击小地图上的展厅标签 → 打开三维实景内容卡片。
  // #stage 有 zoom，getBoundingClientRect() 是缩放后的物理尺寸，必须换算回
  // Canvas 的逻辑坐标系 W/H，否则 4K / 150% 缩放时点击会整体偏移。
  canvas.addEventListener('click', (e) => {
    if (e.detail > 1) return;                 // 双击是复位视角，不弹卡片
    const r = canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) * (W / (r.width || W));
    const y = (e.clientY - r.top) * (H / (r.height || H));
    const hit = labelHits.find((h) =>
      x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h);
    if (!hit?.id) return;
    if (typeof onExhibitSelect === 'function') onExhibitSelect(hit.id);
    else if (window.parent !== window) {
      try { window.parent.postMessage({ type: 'mg-exhibit-select', id: hit.id }, '*'); }
      catch (_) { /* noop */ }
    }
  });
  canvas.addEventListener('dblclick', reset);

  modeBtn?.addEventListener('click', () => {
    pitch = pitch === PITCH_TOP ? PITCH_3D : PITCH_TOP;
    state.mode = pitch === PITCH_TOP ? 'top' : '3d';
    syncButtons();
  });
  followBtn?.addEventListener('click', () => {
    follow = !follow;
    state.follow = follow;
    syncButtons();
  });
  $('mg-mm-wall')?.addEventListener('click', () => {
    wallStyle = wallStyle === 'glass' ? 'flat' : 'glass';
    state.wallStyle = wallStyle;
    syncButtons();
  });
  $('mg-mm-reset')?.addEventListener('click', reset);
  $('mg-mm-min')?.addEventListener('click', () => {
    box.classList.toggle('mg-mm-fold');
    if (!box.classList.contains('mg-mm-fold')) requestAnimationFrame(resize);
  });

  const api = {
    getState: () => ({ ...state }),
    reset,
    setMode: (m) => {
      pitch = m === 'top' ? PITCH_TOP : PITCH_3D;
      state.mode = m === 'top' ? 'top' : '3d';
      syncButtons();
    },
    setFollow: (on) => { follow = !!on; state.follow = follow; syncButtons(); },
    setZoom: (z) => { userScale = clamp(z, 0.4, 8); state.zoom = +userScale.toFixed(2); return userScale; },
    // 用外部给定的包围盒 {minX,minZ,maxX,maxZ} 重新取景（重算中心 + 适配），
    // 例如按房间多边形取紧凑视场，排除离群墙段导致的过大留白。
    setFrame: (bbox) => {
      if (bbox && Number.isFinite(bbox.minX)) { focus = bbox; reset(); return true; }
      return false;
    },
    setWallStyle: (s) => {
      wallStyle = s === 'flat' ? 'flat' : 'glass';
      state.wallStyle = wallStyle;
      syncButtons();
      return wallStyle;
    },
    toggle: () => {
      hidden = !hidden;
      state.visible = !hidden;
      box.classList.toggle('mg-mm-hide', hidden);
      return !hidden;
    },
    /* SPA 单例：楼层切换时只换户型图 / 拓扑数据，不重建 Canvas、
       事件监听与 rAF 循环；loadToken 防止快速连点时旧请求覆盖新场景。 */
    setScene: (s, lbl) => {
      if (!s || (s === state.scene && state.ready)) return false;
      loadScene(s, lbl || s, base);
      return true;
    },
    /* ---- 三维实景识别 → 小地图标签 ---- */
    onSelect: (fn) => { onExhibitSelect = typeof fn === 'function' ? fn : null; return true; },
    setActiveExhibit: (id) => {
      activeExhibit = id || null;
      state.activeExhibit = activeExhibit;
      return activeExhibit;
    },
    /* 漫游中识别到新的展厅名：立即替换小地图上对应坐标的标签文字。
       同时写回 exhibitDoc，切楼层再回来不会丢。 */
    setExhibitName: (id, name) => {
      if (!id || !name) return false;
      const ex = exhibits.find((e) => e.id === id);
      if (!ex) return false;
      ex.name = name;
      const src = exhibitDoc?.scenes?.[state.scene]?.find((e) => e.id === id);
      if (src) src.name = name;
      return true;
    },
    setExhibits: (list) => {
      if (!Array.isArray(list)) return false;
      exhibitDoc = exhibitDoc || { scenes: {} };
      exhibitDoc.scenes = exhibitDoc.scenes || {};
      exhibitDoc.scenes[state.scene] = list;
      applyExhibits();
      return exhibits.length;
    },
    get exhibits() { return exhibits.map((e) => ({ ...e })); },
    get labelHits() { return labelHits.map((h) => ({ ...h })); },
    get data() { return doc; },
    get plan() { return plan; }
  };
  window.__mgMiniMap = api;

  syncButtons();
  resize();
  if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas);
  // 窗口变化时 #stage 的 zoom 会重算，但 canvas 的逻辑尺寸可能不变，
  // ResizeObserver 不会触发；这里补一次监听保证 backing store 跟上缩放。
  window.addEventListener('resize', resize);
  requestAnimationFrame(tick);

  // 二维户型图与拓扑数据并行加载；前者缺失（旧部署包）时自动回退。
  // 抽成函数后，setScene() 可在不重建实例的前提下切换到另一层的数据。
  let loadToken = 0;
  function loadScene(nextScene, nextLabel, nextBase) {
    const token = ++loadToken;
    const s = nextScene || scene;
    const b = nextBase || base;
    doc = null;
    plan = null;
    focus = null;
    state.ready = false;
    state.error = null;
    state.scene = s;
    if (sceneEl) sceneEl.textContent = nextLabel || s;
    if (zoneEl) zoneEl.textContent = '载入导航图…';

    const planPromise = fetch(`${b}${s}/floor-plan.json`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);

    fetch(`${b}${s}/nav-map.json`)
      .then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(async (d) => {
        if (token !== loadToken) return;
        doc = d;
        plan = await planPromise;
        if (token !== loadToken) return;
        state.ready = true;
        state.rooms = d.rooms.length;
        state.links = d.links.length;
        state.components = d.components.length;
        state.walls = d.walls?.length || 0;
        state.wallVectors = d.wallVectors?.length || 0;
        state.wallHeight = (plan || d).wallHeight || 0;
        state.ceilingTriangles = (plan?.ceilingFilter || d.ceilingFilter)?.ceilingTriangles || 0;
        state.ceilingRemoved = !!(plan?.ceilingFilter || d.ceilingFilter)?.topOpen;
        state.floorPlan = !!plan;
        state.planRegions = plan?.wallRegions?.length || 0;
        state.planRings = plan?.wallRings?.length || 0;
        state.planVertices = plan?.stats?.ringVertices || 0;
        state.planRooms = plan?.rooms?.length || 0;
        state.wallSource = plan?.wallRings?.length ? 'floor-plan' : 'nav-map-wallVectors';
        applyExhibits();            // 换楼层后按新场景重算实景识别标签
        syncButtons();
        focus = computeFocus();
        reset();
        follow = true; state.follow = true; syncButtons();   // 默认开启跟随模式
      })
      .catch((e) => {
        if (token !== loadToken) return;
        state.error = String(e?.message ?? e);
        if (zoneEl) zoneEl.textContent = '小地图数据缺失';
      });
  }

  loadScene(scene, label, base);
  return api;
}

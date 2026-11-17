/**
 * 顶栏「碰撞开关」+「WASD / 摇杆速度」控制。
 *
 * 碰撞开关调用 bundle 暴露的 viewer.setCollisionEnabled(on)：摘挂的是官方原始
 * PLY+btree 构造的 MeshCollision 本体，不重建、不替换任何几何；关闭时相机进入
 * fly 模式（可穿墙飞行），开启时回到 walk 碰撞漫游。
 *
 * 速度倍率写回 globalThis.__MG_WALK 的 moveSpeed / moveGroundSpeed / moveAirSpeed。
 * bundle 里这三个字段已改成实时读取 global 的 getter，因此运行时改值立即生效，
 * 同时覆盖键盘 WASD、触摸摇杆和手柄三条输入路径。
 */

const SPEED_KEY = 'mgSpeedScale';
const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
const STEP = 0.25;

const clamp = (v) => Math.min(MAX_SCALE, Math.max(MIN_SCALE,
  Math.round((Number.isFinite(v) ? v : 1) / STEP) * STEP));

export function initWalkControls(viewer, defaultOn = true) {
  const $ = (id) => document.getElementById(id);
  const btn = $('mg-collision');
  const btnState = $('mg-collision-state');
  const range = $('mg-speed');
  const val = $('mg-speed-val');
  const down = $('mg-speed-down');
  const up = $('mg-speed-up');
  if (!btn || !range || !viewer) return null;

  const W = globalThis.__MG_WALK || (globalThis.__MG_WALK = {});
  // 基准值来自 app.js 为米制世界标定的物理常量，倍率只在基准上缩放。
  const base = {
    moveSpeed: Number.isFinite(W.moveSpeed) ? W.moveSpeed : 3.0,
    moveGroundSpeed: Number.isFinite(W.moveGroundSpeed) ? W.moveGroundSpeed : 4.0,
    moveAirSpeed: Number.isFinite(W.moveAirSpeed) ? W.moveAirSpeed : 1.2
  };

  let stored = 1;
  try { stored = Number(localStorage.getItem(SPEED_KEY)) || 1; } catch (_) { /* 隐私模式 */ }
  let scale = clamp(stored);
  let collisionOn = !!defaultOn;
  let userOff = !defaultOn;   // 显式关闭也算「主动关」：阻止 walkPoll 把相机切回 walk
  // 官方碰撞体「是否已加载过」与「当前是否开启」是两件事：关闭碰撞时
  // state.hasCollision 会被置 false，不能拿它当加载标志，否则按钮会变回
  // 「载入中」并禁用，用户就再也点不开了。
  let bodyReady = !!viewer.state?.hasCollision;

  function applyScale(s) {
    W.moveSpeed = +(base.moveSpeed * s).toFixed(4);
    W.moveGroundSpeed = +(base.moveGroundSpeed * s).toFixed(4);
    W.moveAirSpeed = +(base.moveAirSpeed * s).toFixed(4);
    range.value = String(s);
    if (val) val.textContent = s.toFixed(2) + '×';
    try { localStorage.setItem(SPEED_KEY, String(s)); } catch (_) { /* 隐私模式 */ }
  }

  function refresh() {
    const ready = bodyReady;
    btn.disabled = !ready;
    btn.classList.toggle('mg-on', collisionOn && ready);
    btn.classList.toggle('mg-off', !collisionOn || !ready);
    if (btnState) btnState.textContent = !ready ? '载入中' : (collisionOn ? '开' : '关');
    btn.title = !ready ? '官方碰撞网格正在加载'
      : (collisionOn ? '碰撞已开启：墙体阻挡、贴地漫游（快捷键 C）'
                     : '碰撞已关闭：自由飞行、可穿墙（快捷键 C）');
  }

  function setCollision(on) {
    const ok = viewer.setCollisionEnabled?.(!!on);
    if (ok !== true) return false;            // 碰撞体尚未就绪或接口缺失
    collisionOn = !!on;
    userOff = !on;
    const st = viewer.state;
    if (st) {
      if (on && st.walkAllowed && st.cameraMode !== 'walk') st.cameraMode = 'walk';
      if (!on && st.cameraMode === 'walk') st.cameraMode = 'fly';
    }
    refresh();
    return true;
  }

  function setScale(v) {
    scale = clamp(v);
    applyScale(scale);
    return scale;
  }

  btn.addEventListener('click', () => setCollision(!collisionOn));
  range.addEventListener('input', () => setScale(Number(range.value)));
  down?.addEventListener('click', () => setScale(scale - STEP));
  up?.addEventListener('click', () => setScale(scale + STEP));

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const t = e.target;
    if (t instanceof HTMLInputElement && t.type !== 'range') return;
    if (e.key === 'c' || e.key === 'C') { e.preventDefault(); setCollision(!collisionOn); }
    else if (e.key === '[') { e.preventDefault(); setScale(scale - STEP); }
    else if (e.key === ']') { e.preventDefault(); setScale(scale + STEP); }
  });

  // 官方 PLY+btree 碰撞是异步加载的，就绪前按钮保持「载入中」并禁用。
  // 用 hasCollisionOverlay 作为「已加载过」标志：关闭碰撞时
  // setCollisionEnabled(false) 会把 hasCollision 置 false，不能再用它判断。
  const readyPoll = setInterval(() => {
    if (viewer.state?.hasCollisionOverlay) {
      bodyReady = true;
      clearInterval(readyPoll);
      refresh();
    }
  }, 400);
  setTimeout(() => clearInterval(readyPoll), 30000);

  applyScale(scale);
  refresh();

  const api = {
    // 供 app.js 的自动切 walk 轮询读取：用户主动关碰撞后不要再切回去
    get collisionUserOff() { return userOff; },
    getState: () => ({
      collisionOn, scale,
      cameraMode: viewer.state?.cameraMode,
      hasCollision: viewer.state?.hasCollision,
      walkAllowed: viewer.state?.walkAllowed,
      speeds: {
        moveSpeed: W.moveSpeed,
        moveGroundSpeed: W.moveGroundSpeed,
        moveAirSpeed: W.moveAirSpeed
      }
    }),
    setCollision, setScale, refresh
  };
  window.__mgControls = api;   // 也便于 CDP 回归测试读取状态
  return api;
}

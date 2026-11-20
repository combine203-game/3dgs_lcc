/**
 * 贴花投射运行时（Touch / Browse 共用装配层）
 * ----------------------------------------------------------------
 * 贴花的画面不是 DOM 元素，而是 GPU 后处理：由 `editor/decal-projection.js`
 * 每帧把视频纹理按「投影机体积 + 实时表面深度」逐像素投射到三维场景上。
 *
 * 编辑器里这套链路随 editor.js 一起挂载；但**浏览模式**（展厅大屏、只读页面）
 * 从来没有实例化过它 —— 于是同一个贴花在编辑态能看到视频、退出编辑就只剩
 * 一圈线框（甚至什么都没有）。本模块把「注记 → GPU 实例」这一段装配抽出来，
 * 让浏览态也能直接驱动同一套投射链，而不需要挂载整个编辑器。
 *
 * 分工（勿混淆）：
 *   · 视频 / 投射画面 = 本模块驱动（GPU，世界坐标，跟着相机透视）
 *   · 线框 / 手柄 / 占位框 = editor/overlay.js（编辑辅助，浏览态由
 *     `showDecalGuides:()=>false` 关掉，见 browse-annotations.js）
 */
import { createDecalProjection } from './editor/decal-projection.js';
import { resolveEngineAdapter } from './engine/index.js';

/** 注记 → GPU 投射实例描述。
 *  编辑器与浏览态共用同一口径，避免「填了视频 URL 但只有编辑态能播」这类漂移。 */
export function decalsForGPU(list) {
  return (list || [])
    .filter(a => a && a.kind === 'decal' && a.visible !== false && a.projector)
    .map(a => ({
      id: a.id,
      projector: a.projector,
      shadow: a.projector && a.projector.shadow,
      videoUrl: a.media && a.media[0] && a.media[0].type === 'video' ? a.media[0].url : null,
      visible: a.visible !== false,
      opacity: Number(a.style?.decalOpacity ?? 0.9),
      edge: Number(a.style?.decalEdge ?? 0.12),
      // 背面剔除默认关闭：深度差分重建的法向在掠射角仍有噪声，开启会把
      // 贴花打出斑驳空洞。默认「能显示」，把是否剔除交给用户显式选择。
      cull: a.style?.decalCull === true,
      // 运行期可覆盖：归一化基准（1=整框）与深度采样口径（1=引擎同族）
      boxScale: Number.isFinite(Number(a.style?.decalBoxScale)) ? Number(a.style.decalBoxScale) : undefined,
      depthMode: Number.isFinite(Number(a.style?.decalDepthMode)) ? Number(a.style.decalDepthMode) : undefined
    }));
}

/** 取引擎 Picker（viewer 里是对象，旧引擎是函数或事件带来的 wrapper） */
function enginePickerOf(viewer) {
  if (!viewer) return null;
  try {
    const p = typeof viewer.picker === 'function' ? viewer.picker() : viewer.picker;
    return p && typeof p.renderView === 'function' ? p : null;
  } catch (_) { return null; }
}

/**
 * 创建一个贴花投射运行时。
 *
 * @param {object}   opts
 * @param {() => object|null} opts.getViewer  取 window.__viewer
 * @param {() => Array}       opts.listDecals 当前场景的注记列表（已合成浏览态显隐）
 * @param {() => object|null} [opts.getPickView] 自定义深度快照来源（编辑器用）
 * @returns {{manager:object|null, enabled:boolean, sync:Function, destroy:Function, stats:Function}}
 */
export function createDecalRuntime({ getViewer, listDecals, getPickView } = {}) {
  let manager = null;
  let adapter = null;
  let failed = false;      // 适配器 / shader 不可用：不再重试（避免每帧刷异常）

  const getDecals = () => decalsForGPU(typeof listDecals === 'function' ? listDecals() : []);

  /** 主相机实时深度快照（Picker 的 RGBA16F 4 通道试验纹理） */
  function pickView() {
    if (typeof getPickView === 'function') return getPickView();
    // 没有可见贴花时绝不驱动引擎 Picker：renderView() 会跑一次离屏 pick pass
    if (!getDecals().length) return null;
    const p = enginePickerOf(getViewer && getViewer());
    if (!p) return null;
    const pv = p.renderView();
    return pv && pv.texture ? pv : null;
  }

  function create() {
    if (manager || failed) return manager;
    const v = getViewer && getViewer();
    if (!v || !v.app) return null;          // 引擎尚未启动：调用方下一帧再试
    try {
      adapter = resolveEngineAdapter({
        getApp: () => (getViewer && getViewer())?.app || null,
        getCameraEntity: () => {
          const cam = (getViewer && getViewer())?.app?.root?.findComponent?.('camera');
          return cam?.entity || null;
        },
        getPickView: pickView
      });
      manager = createDecalProjection({ adapter, getDecals });
      if (!manager || !manager.enabled) failed = true;
    } catch (err) {
      failed = true;
      manager = null;
      console.warn('[decal-runtime] 贴花投射器初始化失败，已降级：', err);
    }
    return manager;
  }

  return {
    get manager() { return manager; },
    get enabled() { return !!(manager && manager.enabled); },
    /** 按当前注记列表重建 / 更新 GPU 实例；返回是否已接管（引擎未就绪时 false） */
    sync() {
      const m = create();
      if (!m || !m.enabled) return false;
      m.sync(getDecals());
      return true;
    },
    destroy() {
      try { manager?.destroy(); } catch (_) { /* noop */ }
      manager = null;
      adapter = null;
    },
    /** 只读诊断：headless 回归确认「浏览态确实建起了投射实例」 */
    stats() {
      const dbg = manager && typeof manager.debug === 'function' ? manager.debug() : null;
      return {
        enabled: !!(manager && manager.enabled),
        failed,
        instances: Array.isArray(dbg?.instances) ? dbg.instances.length : 0,
        pickReady: !!dbg?.pickReady,
        degraded: !!dbg?.degraded,
        gpuErrors: Number(dbg?.gpuErrors) || 0
      };
    }
  };
}

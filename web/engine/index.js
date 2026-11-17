/**
 * 引擎解析入口（Engine Resolution）
 * ----------------------------------------------------------------
 * 编辑器通过本模块取得「当前正在运行的引擎适配器」，而不是直接 import
 * 某个具体引擎的适配器。这样 web/editor/ 目录与具体引擎完全解耦：
 * 接入 Babylon.js / three.js 时，只需在本文件加一段探测与装配逻辑，
 * 编辑器代码零改动。
 *
 * 探测顺序（先到先得）：
 *   1. globalThis.__pc 存在 → PlayCanvas（v2 主引擎）
 *   2. globalThis.BABYLON 存在 → Babylon.js
 *   3. globalThis.THREE 存在 → three.js
 * 全部不存在 → 返回 null（headless / mock 环境，编辑器降级为只读）。
 */
import { ENGINE_KINDS } from './engine-adapter.js';
import { createPlayCanvasAdapter } from './playcanvas-adapter.js';

/** 探测当前运行环境的引擎类型（不装配适配器） */
export function detectEngineKind() {
  const g = globalThis;
  if (g && g.__pc) return ENGINE_KINDS.PLAYCANVAS;
  if (g && g.BABYLON) return ENGINE_KINDS.BABYLON;
  if (g && g.THREE) return ENGINE_KINDS.THREE;
  return null;
}

/**
 * 装配当前引擎的适配器。
 * @param {object} opts { getApp, getCameraEntity, getPickView }
 * @returns {object|null} 引擎适配器（契约接口）；无可用引擎时返回 null
 */
export function resolveEngineAdapter(opts = {}) {
  const kind = detectEngineKind();
  if (kind === ENGINE_KINDS.PLAYCANVAS) {
    return createPlayCanvasAdapter(opts);
  }
  // Babylon.js / three.js 适配器尚未实现（下一阶段交付）。
  // 这里明确返回 null 而不是抛错：编辑器会走「无引擎」降级路径，
  // 主画面与标注功能不受影响，贴花等 GPU 叠加特性暂不可用。
  if (kind) {
    console.warn('[engine] 引擎 ' + kind + ' 已检测到，但适配器尚未实现（当前仅实现 PlayCanvas）');
  }
  return null;
}

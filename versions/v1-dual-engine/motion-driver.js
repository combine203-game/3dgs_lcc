/**
 * motion-driver.js — MotionBricks 动作驱动封装（R3-motion）
 *
 * 契约见 docs/CONTRACT.md §3 + docs/DECISIONS.md D3（2026-11-13 替代方案）。
 * 本模块只做三件事：
 *   1. 把社区 WebGPU 移植 three-motionbricks 的 MotionBricksCharacter 封成稳定的 create/生命周期；
 *   2. 用 MotionBricksCharacter.setCharacter(astronaut, CHARACTER_RIGS.mixamo) 把生成动作重定向到化身骨架
 *      （rig='soma' 走 SOMA 人形模型，rig='g1' 走 G1 机器人模型）；
 *   3. 每帧 update 后同步骨骼世界矩阵，供上层（SplatAvatar）直接取 bone.matrixWorld。
 *
 * 关键约束（不得违反）：
 *   · 不重置根位移 —— MotionBricks 的位移落在角色内部 root/pelvis 骨骼上，本模块只读不写；
 *   · 切换步态不重置骨架到绑定姿态 —— 全部交给上游 controller（它保留当前 context 帧）；
 *   · 模型未就绪 → stats.error='模型未就绪'，角色保持绑定姿态显示，30 s 内返回不挂死；
 *   · WebGPU 不可用 → 由 three-motionbricks 内部回落 wasm，stats.backend 如实上报。
 */
import { Vector3 } from 'three';
import {
  MotionBricksCharacter,
  RetargetedCharacter,
  CHARACTER_RIGS,
  MOTIONBRICKS_DEFAULTS,
} from './vendor/three-motionbricks/index.mjs';

/** 契约 §6 规定的错误文案，所有初始化失败对外统一给这个字符串（原始错误进 console） */
const MODEL_NOT_READY = '模型未就绪';

const clampGait = (g) => (g === 'run' ? 'run' : g === 'walk' ? 'walk' : 'stand');

/** 浏览器是否暴露 WebGPU（真正能不能用由 three-motionbricks 的 warmup 决定） */
function hasWebGpu() {
  return typeof navigator !== 'undefined' && !!navigator.gpu;
}

export class MotionDriver {
  constructor(o = {}) {
    const ds = MOTIONBRICKS_DEFAULTS || {};
    /** 'soma' = SOMA 人形模型（默认，单 .onnx 文件）；'g1' = G1 机器人（pack 目录或 .onnx） */
    this.rig = o.rig === 'g1' ? 'g1' : 'soma';
    /** 单个 .onnx 文件 URL 或 pack 目录（末尾带 /），库两者都支持，原样传给 model */
    this.modelUrl = o.modelUrl || (this.rig === 'soma' ? './model/mmm_v6_soma_q8h.onnx' : './model/');
    this.liteModelUrl = o.liteModelUrl || null;
    this.ortUrl = o.ortUrl || './vendor/ort/ort.webgpu.min.mjs';
    this.backendPreference = o.backend || 'auto';
    /**
     * backend='auto' 时库的判定阈值：首帧 warmup 超过它就从 WebGPU 回落 wasm。
     * 库默认 300 ms，但 WebGPU 第一帧要编译 shader（本机实测 ~8 s），之后稳定在 150–220 ms。
     * 放大到 9 s 只放过冷启动；库会在阈值内二次计时，真慢仍会回落。
     */
    this.gpuLimitMs = o.gpuLimitMs || 9000;
    this.onProgress = typeof o.onProgress === 'function' ? o.onProgress : null;
    /** 模型就绪自检上限（契约要求 30 s 内给出结论，这里留 5 s 余量） */
    this.modelCheckMs = o.modelCheckMs || 25000;
    /** 模型真正加载（243 MB onnx + session 创建 + warmup）的上限，防止无限等待 */
    this.loadTimeoutMs = o.loadTimeoutMs || 300000;
    /**
     * 是否让库把化身腿长缩放到动作源（SOMA/G1）的腿长：true 时脚步不滑，但模型比例会被拉大
     * （astronaut.glb 是 Q 版比例，实测被拉到 ~3.6 m）。false 保持模型原始身高，代价是脚步滑动。
     */
    this.matchSize = o.matchSize !== false;

    /** MotionBricksCharacter 无参构造即可用（模型加载是异步的），先建实例便于提前 bindCharacter */
    this._character = null;
    this._scene = null;
    this._gait = 'stand';
    this._dir = null;
    this._stage = 'init';
    this._error = null;
    this._modelReady = false;
    this._loadedAt = 0;

    this._stats = {
      backend: this.backendPreference === 'wasm' ? 'wasm' : hasWebGpu() ? 'webgpu' : 'wasm',
      modelReady: false,
      genMs: 0,
      error: null,
      stage: 'init',
    };
    this._defaults = ds;
  }

  /**
   * 创建驱动。模型未就绪时**不抛异常**：返回实例并在 stats.error 上写明，UI 据此禁用动作按钮。
   * @param {Object} o 见 docs/CONTRACT.md §3
   * @returns {Promise<MotionDriver>}
   */
  static async create(o = {}) {
    const d = new MotionDriver(o);
    await d._init();
    return d;
  }

  /* ------------------------------------------------------------------ 初始化 */

  async _init() {
    this._character = new MotionBricksCharacter(this._characterOptions());
    this._character.onError = (e) => {
      console.error('[MotionDriver] 动作生成失败', e);
      this._error = MODEL_NOT_READY;
      this._syncStats();
    };

    this._stage = 'model-check';
    this._syncStats();
    // 先探真实能力：navigator.gpu 存在不代表拿得到 adapter（headless / 无独显常见），
    // 加载完成前 stats.backend 也不能凭「有 navigator.gpu」就报 webgpu。
    this._stats.backend = await this._probeBackend();
    this._syncStats();
    const complete = await this._modelComplete();
    if (!complete) {
      // 只读探测，不启动下载（下载由 tools/download_model.mjs 负责）
      this._error = MODEL_NOT_READY;
      this._modelReady = false;
      this._stage = 'model-missing';
      this._syncStats();
      console.warn('[MotionDriver] 模型包不完整，跳过加载：', this.modelUrl);
      return;
    }
    this._modelReady = true;
    this._stage = 'runtime';
    this._syncStats();

    // ORT 预载：loadOrt 内部是 `import(同一 URL)`，模块实例共享，所以这里设置的 wasmPaths 会生效。
    // 目的：把 wasmPaths 从默认（可能指向 CDN）改成本地 vendor/ort/，确保离线可跑。
    await this._prepareOrt();

    this._stage = 'loading';
    this._syncStats();
    try {
      await this._withTimeout(this._character.load((stage, loaded, total) => {
        this._stage = stage === 'warmup' ? 'warmup' : stage;
        this._syncStats();
        if (this.onProgress) {
          try { this.onProgress(stage, loaded, total); } catch { /* 上层回调异常不影响加载 */ }
        }
      }), this.loadTimeoutMs, '动作模型加载超时');
      this._loadedAt = performance.now();
      this._stage = 'ready';
      console.info(`[MotionDriver] 就绪 rig=${this.rig} model=${this.modelUrl} backend=${this._character.backend}`);
    } catch (e) {
      // 契约 §6：初始化失败统一给「模型未就绪」，原始错误必须出现在控制台（不得静默）
      console.error('[MotionDriver] three-motionbricks / ORT 初始化失败', e);
      this._error = MODEL_NOT_READY;
      this._stage = 'load-failed';
    }
    this._syncStats();
  }

  _characterOptions() {
    const o = {
      // 显式给全，避免落到 MOTIONBRICKS_DEFAULTS 的 NVIDIA/CDN 默认地址
      model: this.modelUrl,
      ort: this.ortUrl,
      backend: this.backendPreference,
      worker: true,
      cache: false,
      // 'soma' → MotionBricksSOMA + SOMA 人形权重；'g1' → MotionBricksG1
      rig: this.rig,
      shadows: false,
      gpuLimitMs: this.gpuLimitMs,
    };
    if (this.liteModelUrl) o.liteModel = this.liteModelUrl;
    return o;
  }

  /** 实际拿一次 adapter 判断 WebGPU 是否可用（拿不到就老实报 wasm） */
  async _probeBackend() {
    if (this.backendPreference === 'wasm' || !hasWebGpu()) return 'wasm';
    try {
      const adapter = await navigator.gpu.requestAdapter();
      return adapter ? 'webgpu' : 'wasm';
    } catch {
      return 'wasm';
    }
  }

  /**
   * 模型就绪探测（只读，不触发下载）：
   *   · modelUrl 以 / 结尾 → pack 目录，读 pack.json 逐 shard HEAD 比对 shardBytes；
   *   · 否则 → 单个 .onnx 文件，HEAD 拿 content-length（下载中的文件是 .part，不会命中本名）。
   */
  async _modelComplete() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.modelCheckMs);
    try {
      if (!this.modelUrl.endsWith('/')) {
        const h = await fetch(this.modelUrl, { method: 'HEAD', signal: ctrl.signal, cache: 'no-store' });
        if (!h.ok) return false;
        const len = Number(h.headers.get('content-length') || 0);
        // 1 MB 以下基本可以断定不是权重文件（正常 q8h 243 MB / fp16 380 MB）
        if (len < 1024 * 1024) return false;
        this._modelBytes = len;
        return true;
      }
      const base = this.modelUrl;
      const res = await fetch(base + 'pack.json', { signal: ctrl.signal, cache: 'no-store' });
      if (!res.ok) return false;
      const pack = await res.json();
      const shards = Array.isArray(pack.shards) ? pack.shards : [];
      if (!shards.length) return false;
      const expect = Number(pack.shardBytes) || 0;
      const sizes = await Promise.all(shards.map(async (name) => {
        try {
          const h = await fetch(base + name, { method: 'HEAD', signal: ctrl.signal, cache: 'no-store' });
          if (!h.ok) return -1;
          return Number(h.headers.get('content-length') || 0);
        } catch { return -1; }
      }));
      // 任一缺失或长度不足即视为未就绪（下载中的 shard 是 .tmp，不会命中这些文件名）
      return sizes.every((n) => n > 0 && (!expect || n >= expect));
    } catch (e) {
      console.warn('[MotionDriver] 模型探测失败', e?.message || e);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async _prepareOrt() {
    try {
      const url = new URL(this.ortUrl, location.href).href;
      const ort = await import(/* @vite-ignore */ url);
      const dir = url.slice(0, url.lastIndexOf('/') + 1);
      if (ort?.env?.wasm) {
        ort.env.wasm.wasmPaths = dir;
        ort.env.logLevel = 'error';
      }
      this._ort = ort;
    } catch (e) {
      // 预载失败不致命：loadOrt 会再试一次，失败信息由 load 统一上报
      console.warn('[MotionDriver] ORT 预载失败（继续走 loadOrt 默认路径）', e);
      this._ort = null;
    }
  }

  _withTimeout(promise, ms, message) {
    if (!ms || ms <= 0) return promise;
    let t = 0;
    return Promise.race([
      promise,
      new Promise((_, reject) => { t = setTimeout(() => reject(new Error(message)), ms); }),
    ]).finally(() => clearTimeout(t));
  }

  /* ------------------------------------------------------------------ 角色绑定 */

  /**
   * 绑定角色。走库的官方入口 `MotionBricksCharacter.setCharacter(scene, CHARACTER_RIGS.mixamo)`：
   * 它内部 `new RetargetedCharacter(root, rig, { source })`，source 由构造时的 `options.rig` 决定
   * （'soma' → SOMA 人形动作，'g1' → G1 机器人动作），并把结果挂到 `character.object`。
   * 模型未就绪时同样会绑定，只是停在库给的静止/绑定姿态（化身可见）。
   * @param {THREE.Object3D} gltfScene astronaut.glb 的 scene
   * @returns {THREE.Object3D|null} character.object
   */
  bindCharacter(gltfScene) {
    if (!this._character || !gltfScene) return null;
    if (this._scene === gltfScene) return this._characterObject || null;
    this._scene = gltfScene;
    // G1 分支同样是这条路径（setCharacter 内部仍是 new RetargetedCharacter(..., {source:'g1'})），行为与原实现一致
    this._retargeted = this._character.setCharacter(gltfScene, CHARACTER_RIGS.mixamo, {
      matchSize: this.matchSize,
    });
    this._characterObject = this._character.object;
    this._characterObject.name = 'MotionDriver';
    // 立即刷一次世界矩阵，供 SplatAvatar 在首帧就能取到骨骼
    this._characterObject.updateMatrixWorld(true);
    return this._characterObject;
  }

  /** @returns {THREE.Object3D|null} 供 SplatAvatar 取骨骼 */
  get characterObject() {
    return this._characterObject || null;
  }

  /* ------------------------------------------------------------------ 动作控制 */

  /** @param {'stand'|'walk'|'run'} g */
  setGait(g) {
    const gait = clampGait(g);
    this._gait = gait;
    const ch = this._character;
    if (!ch) return;
    if (gait === 'stand') {
      this._dir = null;
      ch.stop();
      return;
    }
    // 默认步态只允许 walk/run（stand 不是驱动步态）
    ch.gait = gait;
    // 正在驱动中换步态：立刻按新步态重新生成，但保留当前帧（不重置骨架）
    if (this._dir) ch.drive(this._dir, gait);
  }

  /** 世界方向（xz 平面）持续驱动；null=停 */
  drive(dir, gait) {
    const ch = this._character;
    const valid = !!dir && ((dir.x || 0) !== 0 || (dir.z || 0) !== 0);
    if (gait) this._gait = clampGait(gait);
    const use = this._gait === 'run' ? 'run' : 'walk';
    // 必须是真正的 Vector3：上游 drive() 内部会 worldToLocal / copy，普通对象没有这些方法
    this._dir = valid ? new Vector3(dir.x || 0, 0, dir.z || 0).normalize() : null;
    if (!ch) return;
    if (!valid) {
      ch.drive(null);
      if (this._gait === 'stand') ch.stop();
      return;
    }
    ch.drive(this._dir, use);
  }

  /** 走到世界点（自主漫游），到达后自动停下 */
  moveTo(v3, gait) {
    const ch = this._character;
    if (gait) this._gait = clampGait(gait);
    if (this._gait === 'stand') this._gait = 'walk';
    this._dir = null;
    if (!ch || !v3) return;
    ch.moveTo(v3, this._gait === 'run' ? 'run' : 'walk');
  }

  /**
   * 瞬移到世界点（重新放置用）。
   *
   * 为什么不能只改外层 group 的位置：MotionBricks 把「地面位姿」存在 controller.pose 里，
   * 每帧从它推出骨骼；改 group 只是加了个常数偏移，下一次位姿推进就把它抵消掉。
   * 这里直接把 pose 重置到目标点（用上游自己的 `rig.place(rest,x,y,angle)`），
   * 之后 controller 从该点继续。
   * @param {THREE.Vector3} p 世界坐标（地面点）
   * @param {number} [yaw] 朝向（弧度，0 = G1 空间的 +X）
   * @returns {boolean} 是否成功
   */
  teleport(p, yaw = 0) {
    const ch = this._character;
    const c = ch && ch.controller;
    if (!c || !p || !c.rig || !c.bricks) return false;
    try {
      const g = ch._toG1(p);                 // 世界 → 角色本地 G1 地面坐标
      c.stop();
      c.pose = c.rig.place(c.bricks.rest, g[0], g[1], yaw)[0];
      c.goal = null;
      c._segment = null;
      c._pending = null;
      c._request = null;
      this._dir = null;
      this._gait = 'stand';
      return true;
    } catch (e) {
      console.warn('[MotionDriver] teleport 失败：', e && e.message);
      return false;
    }
  }

  /**
   * 每帧调用。内部 character.update + 同步根节点世界矩阵（上层取骨骼矩阵用）。
   * 注意：**不清零根位移** —— 真实位移落在角色内部 root 骨骼上，由 MotionBricks 自己推进。
   */
  update(dt) {
    const ch = this._character;
    if (!ch) return;
    const d = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0;
    if (d > 0) ch.update(d);
    // 骨骼矩阵刷新：SplatAvatar 在下一帧直接读 bone.matrixWorld
    const obj = this._characterObject || ch.object;
    if (obj) obj.updateMatrixWorld(true);
    this._genMs = ch.stats?.lastInferenceMs ?? this._genMs ?? 0;
  }

  /* ------------------------------------------------------------------ 状态 */

  get stats() {
    return this._syncStats();
  }

  _syncStats() {
    const ch = this._character;
    const backend = ch?.backend || this._stats.backend;
    const last = ch?.stats?.lastInferenceMs;
    if (Number.isFinite(last) && last > 0) this._genMs = last;
    this._stats.backend = backend === 'webgpu' ? 'webgpu' : 'wasm';
    // 载入完成后以 character.ready 为准（controller 已建立才可真驱动）
    this._stats.modelReady = !!ch?.ready;
    this._stats.genMs = this._genMs || 0;
    this._stats.error = this._error;
    this._stats.stage = this._stage;
    return this._stats;
  }

  /** 当前步态（'stand'|'walk'|'run'），便于 UI 回读 */
  get gait() {
    return this._gait;
  }

  /** 是否已能响应动作（模型加载完成） */
  get ready() {
    return !!this._character?.ready;
  }

  dispose() {
    try { this._character?.dispose?.(); } catch { /* noop */ }
    this._character = null;
    this._characterObject = null;
  }
}

export default MotionDriver;

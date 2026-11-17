# CONTRACT.md — 接口契约（S1 冻结 v1.0，2026-11-13）

> **唯一事实源**。模块接口、数据格式、坐标系、单位、资源路径以此为准。
> 任何子任务不得私自改动；变更由 Lead 发布并广播（版本号 +1）。

## 0. 全局约定

| 项 | 值 |
|---|---|
| 坐标系 | 与 PlayCanvas 场景**同一世界**：Y-up、右手系、`-Z` 为相机前方（three.js 与 PlayCanvas 一致，无需换轴） |
| 单位 | **米**。人物身高 1.75±0.1 m，脚底 y=0（相对 `root`） |
| 模块形态 | 原生 ESM，**无构建**，相对路径导入；three 走 importmap 裸名 `'three'` |
| 资源根 | 站点根 `web/`，所有 URL 以 `/human/...` 或 `./...` 相对本模块 |
| 时间 | 秒（`dt`），内部分帧按 30 Hz 语义（MotionBricks 输出 30 fps） |
| 错误 | 不抛到 rAF；初始化失败 → `state.error` 字符串 + UI 提示，不静默 |

## 1. 目录与文件归属

```
web/human/
  index.html                 # 独立 demo 页（Lead）
  human-layer.js             # 场景内集成层（Lead）
  overlay-ui.js              # 控制条 / 状态（Lead）
  splat-avatar.js            # 3DGS 化身：采样 + 蒙皮 + EWA 渲染（R3-splat）
  motion-driver.js           # MotionBricks 封装（R3-motion）
  vendor/three/three.module.js
  vendor/ort/{ort.webgpu.min.mjs, ort-wasm-simd-threaded.jsep.wasm, .jsep.mjs}
  vendor/three-motionbricks/{index.mjs, motionbricks.worker.js}
  assets/astronaut.glb
  model/{pack.json, weights.q8.000..012}
```

## 2. `splat-avatar.js`（R3-splat）

```js
export class SplatAvatar {
  /**
   * @param {Object} o
   * @param {THREE.SkinnedMesh} o.mesh   已加载并完成 bind 的蒙皮网格（astronaut.glb 的 mesh）
   * @param {number} [o.count=120000]    目标高斯数（面积加权采样）
   * @param {number} [o.size=auto]       基础高斯半径（米）。缺省/传 null 时按采样间距自适应
   *                                     `1.2·sqrt(A/count)`（见 DECISIONS D8）；也可用 `?splatsize=` 或
   *                                     `setSplatSize()` 运行期覆盖
   * @param {number} [o.opacity=0.85]
   * @returns {Promise<SplatAvatar>}
   */
  static async create(o)

  /** @type {THREE.Group} 直接 add 到 three 场景；root 原点=脚底 */
  object

  /** 运行期改高斯半径（只重写 aScale，不重采样）。 */
  setSplatSize(size)

  /** 每帧调用（在 skeleton.update / 骨骼世界矩阵刷新之后）。内部：骨骼矩阵→DataTexture→uniform */
  updateBones()

  /** 每帧调用（相机变化后）。内部：按视图深度桶排序，重写 instanceOrder */
  updateSort(camera)

  /** @type {{count:number, buildMs:number, splats:number}} */
  stats

  /** 显示/隐藏（不销毁） */
  setVisible(v)
  /** 透明度倍率 0..1，用于遮挡淡出 */
  setOpacityScale(s)
  dispose()
}
```

**渲染约定（必须遵守，验收会查）**
1. 每次 draw 的排序为**由远到近**（alpha 混合正确），排序键 = `Σ wᵢ · depth(boneᵢ)` 量化后桶排序，禁止每帧 `Array.sort` 全量（>160k 会掉帧）。
2. 高斯椭球朝向由法向构造（局部 `+Z` 对齐法向），尺度各向异性比 ≤ 3。
3. 顶点着色器完成 LBS：`p' = Σ wᵢ · (M_worldᵢ · Bᵢ⁻¹ · p)`；法向用同一混合矩阵的 3×3 部分。
4. 深度测试开、深度写关；`blending: NormalBlending`。
5. 材质需 `transparent:true`，并按 1 px 最小裁剪（`alpha<1/255` discard）。

## 3. `motion-driver.js`（R3-motion）

```js
export class MotionDriver {
  /**
   * @param {Object} o
   * @param {'soma'|'g1'} [o.rig='soma']  soma=SOMA 人形模型（默认，单 .onnx）；g1=机器人
   * @param {string} o.modelUrl     单个 .onnx 文件路径，或 pack 目录（末尾带 /）
   *                                 默认 './model/mmm_v6_soma_q8h.onnx'
   * @param {string} [o.liteModelUrl] 可选 lite pack
   * @param {string} o.ortUrl        './vendor/ort/ort.webgpu.min.mjs'
   * @param {'auto'|'webgpu'|'wasm'} [o.backend='auto']
   * @param {boolean} [o.matchSize=false] 是否按源骨架腿长放大人体（astronaut 开了会到 3.4 m）
   * @param {number} [o.gpuLimitMs=9000] 首帧 WebGPU 编译容忍阈值（库默认 300 太严）
   * @param {(stage:string, loaded:number, total:number)=>void} [o.onProgress]
   */
  static async create(o)

  /** @param {THREE.Object3D} gltfScene  astronaut.glb 的 scene */
  bindCharacter(gltfScene)   // 内部 character.setCharacter(scene, CHARACTER_RIGS.mixamo)
  get characterObject()      // THREE.Object3D（含骨架），供 SplatAvatar 取骨骼

  /** 'stand' | 'walk' | 'run' */
  setGait(g)
  /** 世界方向（THREE.Vector3，xz 平面）持续驱动；null=停 */
  drive(dir, gait)
  /** 走到世界点（自主漫游用） */
  moveTo(v3, gait)
  /**
   * 【实验性，默认不启用】把「地面位姿」瞬移到世界点。返回是否成功。
   * 动机：MotionBricks 的地面位置存在 controller.pose 里，只改 group 的 position 会被下一次
   * 位姿推进抵消一部分，导致「走过一段路再按重新放置」落点偏 1–2 m。
   * 实测：位置能改，但 (a) pose 的 angle 会被控制器下一次生成覆盖，(b) group 有旋转时落点
   * 会跟着旋转漂移，两次迭代仍未收敛 —— 因此本层没有调用它，仅保留供后续研究。
   */
  teleport(v3, yaw)
  update(dt)                 // 每帧；内部 character.update + 同步 root 变换

  /** @type {{backend:'webgpu'|'wasm', modelReady:boolean, genMs:number, error:string|null, stage:string}} */
  stats
}
```

**动作语义**
- `stand`：`character.stop()`，播放生成式落地/待机。
- `walk`/`run`：`character.drive(worldDir, gait)`，根骨骼真实位移（非原地动画）。
- 切换必须**连续**：不得重置骨架到绑定姿态；切换时保留当前 context 帧（上游 controller 已保证，禁止绕过）。

## 4. `human-layer.js`（Lead）

```js
export async function initHumanLayer(opts) // opts: {viewer, modelUrl, autoStart}
// 返回
{
  state,            // {ready, backend, gait, mode, fps, genMs, error, count}
  setGait(g),
  placeInFront(meters = 2.6),
  setMode('stay'|'patrol'),
  toggle(v)
}
```
- 相机同步：每帧读 `viewer.app.root.findComponent('camera')` 的 `entity.getPosition()/getRotation()` 与 `cameraComponent.fov`，写入 three 相机（`fov` 为**垂直**视场角，与 PlayCanvas 一致）。
- 全局调试句柄：`window.__mgHuman = <上述返回对象>`（R4 断言用）。

## 5. 性能预算（RTX 3070 / 1600×900 / Chrome）

| 指标 | 预算 | 超限处置 |
|---|---|---|
| 高斯数 | 80k–160k | 降采样 `count` |
| 化身渲染 | ≤ 4 ms/帧 | 降 count / 关阴影 |
| 排序 | ≤ 3 ms/帧 | 桶数下调 / 隔帧排序 |
| 推理（WebGPU） | ≤ 300 ms/次（约每 0.6–1.9 s 一次） | 降级 `lite` pack 或 wasm |
| 端到端 | ≥ 55 FPS（含原场景） | 见 README 降级开关 |

## 6. 降级路径（必须实现，不得静默）

| 故障 | 行为 |
|---|---|
| 无 `navigator.gpu` | ORT 走 wasm；UI 标 `WASM`（慢但可用） |
| 模型文件缺失/未下完 | `state.error='模型未就绪'`，化身以**绑定姿态**显示，动作按钮禁用 |
| three-motionbricks 加载失败 | 同上，并在控制台给出原始错误 |
| 高斯渲染初始化失败 | 回退显示原始蒙皮网格（`mesh.visible=true`），UI 标 `MESH 回退` |

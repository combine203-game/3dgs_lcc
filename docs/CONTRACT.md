# CONTRACT.md — 接口契约（v2.0，2026-11-14；S1 初版 v1.0 冻结于 2026-11-13）

> **唯一事实源**。模块接口、数据格式、坐标系、单位、资源路径以此为准。
> 任何子任务不得私自改动；变更由 Lead 发布并广播（版本号 +1）。
>
> **v2.0 变更（单引擎迭代）**：数字人渲染器由 `SplatAvatar`（three.js / 第二渲染上下文）
> 换成 `PcSplatAvatar`（PlayCanvas 原生 / 同一 graphicsDevice）；`human-layer.js` 不再做
> 「每帧同步相机到 three」，改为「每帧请求宿主按需渲染」；shader 同时提供 GLSL 与 WGSL。
> v1 契约与实现完整保存在 `versions/v1-dual-engine/`。详见 `docs/ITERATION_V2.md`、`DECISIONS.md` D10/D11。

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
  pc-splat-avatar.js         # 【v2 现行】PlayCanvas 原生 3DGS 化身：采样 + LBS + EWA + 双后端 shader
  splat-avatar.js            # 【v1 归档】three.js 化身，仅 versions/v1-dual-engine/ 回滚时使用
  human-layer-v1.js          # 【v1 归档备份】去掉自启 IIFE 的双引擎集成层，当前不引用
  motion-driver.js           # MotionBricks 封装（R3-motion，v1/v2 共用）
  vendor/three/three.module.js
  vendor/ort/{ort.webgpu.min.mjs, ort-wasm-simd-threaded.jsep.wasm, .jsep.mjs}
  vendor/three-motionbricks/{index.mjs, motionbricks.worker.js}
  assets/astronaut.glb
  model/{pack.json, weights.q8.000..012}
```

## 2. `pc-splat-avatar.js`（v2 现行；R3-splat）

```js
export class PcSplatAvatar {
  /**
   * @param {Object} o
   * @param {THREE.SkinnedMesh} o.mesh   已加载并完成 bind 的蒙皮网格（astronaut.glb 的 mesh）
   * @param {number} [o.count=120000]    目标高斯数（面积加权采样）
   * @param {number} [o.size=auto]       高斯半径（米）。缺省/传 null 时按采样间距自适应
   *                                     `clamp(1.2·sqrt(A/count), 0.0015, 0.02)`（D8）
   * @param {number} [o.opacity=0.85]
   * @param {pc.AppBase} o.app           宿主 PlayCanvas app（必需）
   * @param {Object} o.P                 globalThis.__pc（必需）
   * @returns {Promise<PcSplatAvatar>}
   */
  static async create(o)

  /** @type {pc.GraphNode} 承载 mesh.matrixWorld 的世界变换；MeshInstance 已挂 defaultDrawLayer */
  object
  /** @type {pc.MeshInstance} setInstancing(true,true)，instancingCount = count */
  meshInstance
  /** @type {pc.ShaderMaterial} shaderDesc 同时含 GLSL 与 WGSL，引擎按 device 自动选 */
  material

  /** 运行期改高斯半径（只重写 splatTex 的 scale 通道，不重采样）。 */
  setSplatSize(size)

  /** 每帧：three 骨骼世界矩阵 → boneTex（RGBA32F，lock()/unlock()）。 */
  updateBones()
  /** 每帧：@param {pc.CameraComponent} cameraComp；8192 桶排序 → orderTex。 */
  updateSort(cameraComp)
  /** 每帧：同步 three 根变换到 pc.GraphNode（引擎据此注入 matrix_model）；幂等。 */
  updateFrame(cameraComp)

  /** @type {{count,buildMs,splats,bones,spacing,size,texMB,sortMs,boneMs,frameMs,
   *          frameCalls,shaderLanguage:'glsl'|'wgsl',error}} */
  stats

  setVisible(v)
  setOpacityScale(s)     // 写 uOpacity
  dispose()              // removeMeshInstances + destroy mesh/material/textures
}
```

**GPU 数据契约（v2 新增，验收会查）**

| 纹理 | 格式 / 尺寸 | 内容 | 更新频率 |
|---|---|---|---|
| `splatTex` | RGBA32F `1024 × ceil(n·8/1024)` | 每 splat 8 texel：center+scale / normal+alpha / color+quat.x / quat.yzw / boneIdx4 / boneW4 / 2 预留 | 静态，仅 `setSplatSize` 改 scale |
| `boneTex` | RGBA32F `(bones·4) × 1` | 每骨骼 1 个 LBS mat4 | 每帧 |
| `orderTex` | RGBA32F `1024 × ceil(n/1024)` | 每绘制序 1 个 splat id（`.r`） | 每帧 |
| 几何 | `pc.Mesh` 4 顶点 quad + 6 索引 | `setInstancing(true,true)`，`gl_InstanceID`/`input.instanceIndex` 即绘制序 | 静态 |

**渲染约定（必须遵守，验收会查）**
1. 每次 draw 的排序为**由远到近**（alpha 混合正确），排序键 = `Σwᵢ·depth(boneᵢ) + rZL·(p_rest − Σwᵢ·bone_restᵢ)`，8192 桶 counting sort；禁止每帧 `Array.sort` 全量。
2. 高斯椭球朝向由法向构造（局部 `+Z` 对齐法向），尺度各向异性比 ≤ 3。
3. 顶点着色器完成 LBS：`p' = Σ wᵢ · (M_worldᵢ · Bᵢ⁻¹ · p)`；法向用同一混合矩阵的 3×3 部分。
4. `blendType = BLEND_NORMAL`、`cull = CULLFACE_NONE`、`depthTest = false`、`depthWrite = false`（SOG 不写深度，`depthTest=true` 会被其它 pass 误杀）。
5. `alpha<1/255` discard；`clip.w<0.05` 时把该实例推到裁剪空间外。
6. **矩阵一律走引擎内置 uniform**：`matrix_model / matrix_view / matrix_projection / matrix_viewProjection / viewport_size`；自定义 mat4 uniform 在本引擎里 `getParameter` 有值但 shader 收不到。
7. **双后端**：`shaderDesc` 必须同时提供 `vertexGLSL/fragmentGLSL`（WebGL2）与 `vertexWGSL/fragmentWGSL`（WebGPU）。宿主未加载 glslang/twgsl，WebGPU 下只给 GLSL 会因转译失败静默不出像素。

> v1 的 `SplatAvatar`（three.js `InstancedBufferGeometry` + `DataTexture` 骨骼矩阵）契约仍适用于
> `versions/v1-dual-engine/` 归档实现，不再作为现行接口。

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
export async function initHumanLayer(opts) // opts: {viewer, modelUrl, count, distance, size}
// 返回
{
  state,            // {ready, backend, gait, mode, fps, genMs, error, count,
                    //  engine:'playcanvas-single', deviceType, shaderLanguage, splatSize, spacing}
  setGait(g), setMode('stay'|'patrol'), toggle(v),
  placeInFront(meters = 2.6), setYaw(r), getYaw(), setGroundY(y), setSplatSize(s),
  measure(), diag(), _internals()
}
```
- **单引擎**：不创建第二个 canvas / WebGLRenderer。three 的 `Scene / PerspectiveCamera` 只是数学容器，`camera` 为「影子相机」，仅供 `placeInFront / measure / diag` 做向量运算；渲染完全由 PlayCanvas 完成。
- **主循环**：只挂 `app.on('update')`（动作 + 骨骼 + 排序 + `requestFrame()`）与 `app.on('prerender')`（幂等再刷一次矩阵）。不再有第二个 rAF。
- **按需渲染（强制）**：宿主在场景 revealed 后 `app.autoRender=false`。`update` 末尾必须
  `viewer.events.fire('frame:request')` + `app.renderNextFrame = true`，否则画面冻结在加载帧
  （`drawCalls.total=0`，但对象挂载与自检全绿 —— 见 `ITERATION_V2.md §6.1`）。
- **后端**：`device.isWebGPU` → WGSL，否则 GLSL；不再对 WebGPU 回退 v1 双引擎。
- 全局调试句柄：`window.__mgHuman = <上述返回对象>`（R4 / v2 自检断言用）。

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
| WebGPU 主后端 | `shaderDesc` 走 WGSL；**不得**回退双引擎（会破坏「同一套引擎」交付）。`state.shaderLanguage='wgsl'` 可查 |
| `frame:request` / rAF 被浏览器节流 | `drawCalls.total` 归 0；自检脚本必须断言「确实出帧」。有头 CDP 需加防节流 flag（仅测试浏览器） |

# Babylon.js 适配器接入契约（下一阶段）

> 状态：**本轮未实现**（按约定本轮只交付抽象层 + PlayCanvas 适配器）。
> 本文件是 Babylon.js 适配器的**可执行规格**：照此实现即可接入，编辑器代码零改动。

## 1. 为什么是 Babylon.js 优先

| 维度 | Babylon.js | three.js |
| --- | --- | --- |
| 内置拾取 | `scene.pick(x, y)` + `PickingInfo` 自带多射线求交 | 需自行实现 `Raycaster` 封装 |
| 深度重建 | `scene.enableDepthRenderer()` 直接给出深度图 | 需自行渲染一张深度 RT |
| 着色器接入 | `ShaderMaterial` 接受 GLSL 源码（WebGL2） | `RawShaderMaterial` 需自行处理版本前缀 |
| 内置全屏层 | `Layer` / `PostProcess` 直接做全屏叠加 | 需自建正交相机 + 平面 |
| 矩阵约定 | **行主序 + 行向量**（`v' = v · M`），与本契约相反 | 列主序 + 列向量（与本契约一致） |

关键差异：**Babylon 的矩阵是行主序 + 行向量约定**，而本契约（`web/engine/engine-adapter.js`）
统一规定为「列主序 + 列向量约定（v' = M · v）」，与 GLSL / WGSL / PlayCanvas / three.js 一致。
因此 Babylon 适配器在返回矩阵时**必须转置**。这是接入时最容易出错、也最难通过肉眼发现的一点。

## 2. 必须实现的契约方法（31 个，全量）

契约定义见 `web/engine/engine-adapter.js` 的 `ADAPTER_CONTRACT`。逐条对应关系：

### A. lifecycle（8）

| 契约方法 | Babylon.js 实现要点 |
| --- | --- |
| `getEngineKind()` | 返回 `'babylon'` |
| `isReady()` | `engine.isDisposed === false && scene.isReady()` |
| `getRenderSize()` | `engine.getRenderWidth()` / `engine.getRenderHeight()`（物理像素） |
| `getPixelRatio()` | `engine.getHardwareScalingLevel() > 0 ? 1 / level : devicePixelRatio` |
| `requestRender()` | `scene.render()` 或 `engine.beginFrame()` + `scene.render()`（按需渲染模式） |
| `getBackendType()` | `engine.webGLVersion >= 2 ? 'webgl2' : 'webgl2'`；Babylon 当前无 WebGPU 后端，返回 `'webgl2'` |
| `addRenderHook(phase, cb)` | `BEFORE_RENDER` → `scene.onBeforeRenderObservable.add(cb)`；`AFTER_RENDER` → `scene.onAfterRenderObservable.add(cb)` |
| `removeRenderHook(phase, cb)` | 对应 `Observable.remove(cb)` |
| `observeGpuErrors(cb)` | `engine.onContextLostObservable` / `onContextRestoredObservable`；无 WebGPU 时可返回 null |

### B. scene（5）

| 契约方法 | Babylon.js 实现要点 |
| --- | --- |
| `getScene()` | 返回 `scene` |
| `getCameraEntity()` | 返回 `scene.activeCamera`（**注意语义差异**：Babylon 的相机本身就是节点，PlayCanvas 是 Entity+component） |
| `getCameraPosition()` | `camera.globalPosition` → `[x, y, z]` |
| `getCameraInverseViewProjection()` | `Matrix.Invert(scene.getTransformMatrix())` → **必须转置**为列主序后返回 `Float32Array(16)` |
| `getCameraNearFar()` | `camera.minZ` / `camera.maxZ` |

### C. material（4）

| 契约方法 | Babylon.js 实现要点 |
| --- | --- |
| `createShaderMaterial(spec)` | `new BABYLON.ShaderMaterial(name, scene, { vertexSource, fragmentSource }, { attributes: ['position'], uniforms: [...] })`；`spec.vertexGLSL` / `spec.fragmentGLSL` 直接使用 |
| `setMaterialParameter(m, name, value)` | `m.setFloat` / `setVector3` / `setMatrix` / `setTexture`，按值类型分派；**矩阵需转置** |
| `destroyMaterial(m)` | `m.dispose()` |
| `setMaterialBlendState(m, state)` | `m.alphaMode = BABYLON.Engine.ALPHA_COMBINE`；`m.needDepthPrePass`；`m.backFaceCulling = false` |

### D. texture（4）

| 契约方法 | Babylon.js 实现要点 |
| --- | --- |
| `createCanvasTexture(options)` | `new BABYLON.RawTexture(data, w, h, BABYLON.Engine.TEXTUREFORMAT_RGBA, scene, false, false, BABYLON.Texture.NEAREST_SAMPLINGMODE)` 或 `DynamicTexture` |
| `updateCanvasTexture(tex, source)` | `DynamicTexture`：`tex.getContext().drawImage(source,0,0); tex.update(false)`。**RawTexture 需自己 `update()`** |
| `getTextureSize(tex)` | `[tex.getSize().width, tex.getSize().height]` |
| `getTextureFormat(tex)` | 返回 `'rgba8'` / `'rgba32f'` 等引擎无关标识 |

### E. geometry（5）

| 契约方法 | Babylon.js 实现要点 |
| --- | --- |
| `createFullscreenQuad()` | 推荐 `new BABYLON.Layer` 或 `BABYLON.PostProcess`；若沿用「全屏 quad + 自定义 shader」路线，用 `MeshBuilder.CreatePlane` + `scene.onBeforeRender` 定位相机正前方 |
| `createRenderable(mesh, mat, node)` | Babylon 无「MeshInstance」概念：把 material 赋给 mesh 即可，返回 `{ mesh, material }` 句柄 |
| `addRenderable(r)` | `r.mesh.isVisible = true`；或加入 `mesh.renderingGroupId = 0` 的默认层 |
| `removeRenderable(r)` | `r.mesh.dispose()` |
| `setRenderableVisible(r, v)` | `r.mesh.isVisible = v` |

### F. picking（6）

| 契约方法 | Babylon.js 实现要点 |
| --- | --- |
| `getDepthPickView()` | `scene.enableDepthRenderer(camera, false, false)` → `depthRenderer.getDepthMap()`；**注意**：Babylon 深度图是 R 分量单通道，非归一化线性深度，与 PlayCanvas 的 RGBA16F 语义不同 —— 贴花 shader 需在引擎层做深度归一化转换 |
| `getPickingBackend()` | `'babylon-depth-renderer'` |
| `setRenderableFlags(r, flags)` | `r.mesh.receiveShadows`、`r.mesh.isPickable` 等 |
| `composeRigidMatrix(pos, quat)` | `BABYLON.Matrix.Compose(BABYLON.Vector3.One(), quat, pos)` → **必须转置** |
| `invertMatrix(m)` | `BABYLON.Matrix.Invert(BABYLON.Matrix.FromArray(...))` → **必须转置** |
| `rotateVectorByQuaternion(v, q)` | `v.rotateByQuaternionToRef(q, out)` → `[x,y,z]` |

## 3. 深度语义差异（最大的技术风险）

PlayCanvas Picker 的深度纹理语义：

- RGBA16F，**4 个通道 = 4 次随机生存试验**，每通道是「最近存活的归一化线性深度」，1.0 = 空。
- 引擎 `surfaceDepth()` 取 5×5 邻域圆盘（13 texel）× 4 试验的 **30% 分位数**。

Babylon 深度渲染器语义：

- 单通道 R32F（`TEXTURETYPE_FLOAT`），是**确定性**的深度值，需按 `minZ/maxZ` 反投影为归一化线性深度。

因此 Babylon 适配器**不能**直接把深度图交给现有 shader。两条可选路线：

1. **路线 A（推荐，改动小）**：Babylon 适配器在 `getDepthPickView()` 里把深度图重采样成与 PlayCanvas 同语义的单通道归一化线性深度，shader 侧改用 `uDepthMode = 0`（单 texel 中位）分支。这条路线需要 Babylon 适配器额外维护一张 1×1×N 的「4 通道重复单值」纹理 —— 但当前 shader 的 `channelMedian` 在 4 通道同值时恰好退化为该值，**可以零改动复用**。
2. **路线 B（彻底）**：把 shader 的深度采样抽成后端无关的 `sampleDepth()` 契约方法，由适配器各自实现语义转换。

路线 A 之所以能零改动复用，是因为 `channelMedian(t)` 对 4 通道同值输入返回的就是该值本身 —— 这也是当初把「单 texel min」改成「单 texel 中位」带来的额外好处：它同时成了跨引擎深度的兼容点。

## 4. 接入步骤（照做即可）

1. 新建 `web/engine/babylon-adapter.js`，`export function createBabylonAdapter(opts)`。
2. 实现契约的 31 个方法，矩阵一律**转置**后再返回。
3. 在 `web/engine/index.js` 的 `resolveEngineAdapter()` 中加入 `ENGINE_KINDS.BABYLON` 分支。
4. 在 `web/engine/decal-shaders.js` 中确认 Babylon 使用的 GLSL 分支可用
   （`DECAL_FRAGMENT_PREAMBLE_GLSL + DECAL_FRAGMENT_BODY_GLSL` 即完整片元着色器，
   与 PlayCanvas WebGL2 路径共用，无需改动）。
5. 跑 `node tools/verify_editor.mjs` —— 适配层契约断言应保持全绿。

## 5. 验收要求（与本轮贴花像素验收同口径）

- 差分覆盖率 ≥ 0.50，包围盒面积占比 ≥ 0.80，主色相差 ≤ 15°，DPR 1/2 覆盖率差 ≤ 0.05。
- 每项实测值与阈值之间保留 ≥ 该阈值 10% 的裕量。
- 贴花异常不得拖垮主画面：shader 编译失败 / 纹理加载失败 / 深度图缺失三种注入下，
  主画面持续出帧且非贴花区差分占比 ≤ 0.02。

# 版本迭代 v2 · 统一到同一套渲染引擎

> 触发需求（2026-11-14）：「本地做版本迭代，改为使用同一套渲染引擎实现」。
> v1 交付于 2026-11-13（见 `versions/v1-dual-engine/` 与 `DELIVERY.md`）。
> 本文是 v2 的方案裁决、实证依据、改动边界与验收记录。**唯一事实源仍是 `CONTRACT.md`。**

---

## 0. 结论先行

| | v1（双引擎） | v2（单引擎） |
|---|---|---|
| 渲染引擎 | PlayCanvas 2.23.3（SOG 场景） + three.js 0.168（数字人） | **PlayCanvas 2.23.3 一套** |
| WebGL 上下文 | 2 个（主 canvas + `#mg-human-layer` 透明 overlay） | **1 个** |
| 渲染循环 | PlayCanvas rAF + three `setAnimationLoop` 各自跑 | **只挂 PlayCanvas `app.on('update')` / `app.on('prerender')`** |
| 相机 | 每帧从 `window.__viewer` 读位姿写入 three 相机（有一帧同步延迟风险） | **同一台 CameraComponent**，无跨上下文同步 |
| 数字人绘制 | `THREE.InstancedBufferGeometry` + `THREE.ShaderMaterial` | `pc.Mesh` + `pc.MeshInstance` + `pc.ShaderMaterial`，挂 `app.scene.defaultDrawLayer` |
| 骨骼/排序数据 | GPU 顶点属性 buffer | **RGBA32F 浮点纹理**（splat / bone / order），vertex shader `texelFetch` |
| three.js 角色 | 渲染引擎 | **纯数据/骨架层**：GLB 解析、Mixamo 骨架、上游 motionbricks 所需 Object3D；零 renderer、零 canvas、零 GPU 资源 |
| 深度缓冲 | 两个上下文各一份，不共享 | **共享一份**（但 SOG 自身 `depthWrite=false`，见 §7） |
| 核心文件改动 | `gs-viewer.html` 2 处 | **不变，仍是同样 2 处**（注释即回滚） |

---

## 1. 为什么是「统一到 PlayCanvas」而不是反过来

| 方案 | 判断 |
|---|---|
| **A. 数字人搬进 PlayCanvas（采用）** | 宿主场景是 PlayCanvas 单文件 bundle，且 bundle 已在 `globalThis.__pc` 暴露 `Mesh / MeshInstance / ShaderMaterial / Texture / GraphNode / BlendState` 与像素格式、图元、语义常量（原本供编辑器贴花用）。改 `web/human/**` 即可，不动 `app.js` / `viewer/index.js`。 |
| B. SOG 场景搬到 three.js | 需要重写 `viewer/index.js`（3.9 MB bundle、gsplat/SOG 解码、相机控制、碰撞、标注、小地图、路线录制），风险与工作量都不可接受，且违反「不改核心文件」。 |
| C. 保留两个 canvas，只统一坐标系 | 不解决用户要的「同一套引擎」，否决。 |

**three.js 不能彻底移除**：`repalash/three-motionbricks` 的 `MotionBricksCharacter.setCharacter(scene, CHARACTER_RIGS.mixamo)` 只接受 three 的 Object3D/Skeleton，GLB 也由 `GLTFLoader` 解析。v2 里 three 的 `Scene / Group / PerspectiveCamera` 全部是**数学容器**（`camera` 是「影子相机」，只给 `placeInFront / measure / diag` 做向量运算），不创建任何 `WebGLRenderer`、不占 GPU 资源。渲染引擎只有 PlayCanvas 一套。

---

## 2. 实证依据（不靠猜 bundle）

### 2.1 运行时 API 探针 `tools/probe_single_engine.mjs`

在真实页面上读 `window.__viewer.app`：

```
deviceType  = "webgl2"（headless） / "webgpu"（有头 Chrome 137）
maxTextureSize = 8192
__pc keys  = Vec2 Vec3 Mat4 Quat GraphNode Mesh MeshInstance ShaderMaterial
             StandardMaterial Material Texture BlendState + 常量
defaultDrawLayer.addMeshInstances = function
transparentSortMode = 3 (BACK2FRONT)
cameraEntity = true, fov = 75
Mesh.prototype = [setVertexStream setPositions setIndices update destroy ...]
Texture.prototype = [lock unlock upload setSource markForUpload ...]
canvasCount = 2  → "(anon)"(PlayCanvas 主画布) + "mg-mm-canvas"(小地图)
```

### 2.2 最小高斯样例 `tools/probe_pc_splat.mjs`

在真实页面注入一个 8×8 彩色点阵，数据全部来自 RGBA32F 纹理：

```
{ "ok": true, "setOk": true, "storageType": "Float32Array",
  "instancingCount": 64, "primCount": 6, "deviceType": "webgl2", "glErr": 0 }
截图 shots/probe_pc_splat2.png → 8×8 点阵确实画在 3DGS 场景之上
```

四条地基同时成立：
1. `setInstancing(true,true)` + `gl_InstanceID` 能画出 N 个实例；
2. `matrix_model` / `matrix_viewProjection` 由引擎自动注入；
3. `Texture.lock()` 返回 `Float32Array`，`unlock()` 触发上传，vertex shader 可 `texelFetch`；
4. 自定义 GLSL 编译无 console 错误。

### 2.3 引擎内部事实（bundle 逐行核对）

| 事实 | 位置 |
|---|---|
| `globalThis.__pc = {...}` 集中暴露原生渲染类 | `web/viewer/index.js` 尾部 |
| `GSplatQuadRenderer.configureMaterial()`：`blendType=BLEND_PREMULTIPLIED`、`depthWrite=false` | `:62342` |
| 引擎自带 gsplat 就是「4 顶点 quad + `setInstancing(true,true)` + `gl_InstanceID * instanceSize + vertex_position.z`」 | `:37086` / `:62509` / `:67224` |
| `PIXELFORMAT_RGBA32F = 14`（未在 `__pc` 导出，v2 以常量+注释引用） | bundle 常量表 |
| `ShaderMaterial` 只在**同时提供** `vertexWGSL && fragmentWGSL` 时才切 WGSL；只给 GLSL 时 WebGPU 后端走 GLSL→WGSL 转译 | `:33488` |
| **宿主编排层没有提供转译器**：`createGraphicsDevice(canvas, { deviceTypes: useWebGPU ? ['webgpu'] : [], antialias, depth, stencil, xrCompatible, powerPreference })` 未传 `glslangUrl` / `twgslUrl` → `device.hasTranspilers === false` | `web/viewer/index.js`（`initWebGpu(glslangUrl, twgslUrl)`） |
| 场景 revealed 后 `app.autoRender = false`，之后仅靠 `frame:request` / 相机变化触发 `app.renderNextFrame = true` | `web/viewer/index.js`（"switch to on-demand rendering"） |
| `CameraComponent.viewMatrix / projectionMatrix` 返回 `Mat4`，`.data` 为 `Float32Array(16)` | `:56222` / `:56287` / `:2235` |

---

## 3. 数据通道设计

```
three SkinnedMesh (astronaut.glb, 65 bones)
   │ 面积加权采样 120k 点 → pos/normal/color/alpha/scale/quat/boneIdx4/boneW4
   ▼
splatTex  RGBA32F 1024×938   每 splat 8 texel，静态（只在 setSplatSize 时更新）
boneTex   RGBA32F 260×1      每骨骼 1 个 mat4，每帧 updateBones() 写入
orderTex  RGBA32F 1024×118   每绘制序 1 个 splat id，每帧 8192 桶排序写入
   ▼
pc.Mesh 4 顶点 quad + 6 索引；setInstancing(true,true)，instancingCount=120000
   │  gl_InstanceID = 绘制序 → texelFetch(orderTex) → sid
   ▼
pc.ShaderMaterial（同一份 shaderDesc 同时给 GLSL 与 WGSL，引擎按 device 自动选）
   LBS: 4×boneTex 行加权 → M, A
   EWA: view/proj 雅可比 → 2×2 协方差 → 特征分解 → 3σ 四边形展开
   fragment: 高斯衰减 + alpha<1/255 discard
   ▼
app.scene.defaultDrawLayer  ← 与 SOG 场景同一个 graphicsDevice / 同一帧缓冲
   ▲
human-layer 每帧 app.on('update') 末尾 requestFrame()  →  frame:request / renderNextFrame
```

**排序键与 v1 逐字一致**：`Σwᵢ·depth(boneᵢ) + rZL·(p_rest − Σwᵢ·bone_restᵢ)`，8192 桶、由远到近，禁止全量 `Array.sort`。只是把 v1 的「重写 index buffer」换成「重写 orderTex 的 `.r` 通道」。

**采样算法、LBS 矩阵推导（`bindInv·(boneWorld·boneInverse)·bind`）、EWA 投影、高斯半径自适应 `1.2·sqrt(A/count)` 全部保留**，所以外观/身高/性能可与 v1 直接对比。

---

## 4. 改动清单（逐文件，可回滚）

| 文件 | 动作 | 说明 |
|---|---|---|
| `web/human/pc-splat-avatar.js` | **新增** | v2 渲染器：采样 → 3 张浮点纹理 → instanced quad → PlayCanvas MeshInstance；shaderDesc 同时给 GLSL/WGSL 两套 |
| `web/human/human-layer.js` | **重写渲染部分** | 删除 canvas / WebGLRenderer / three 灯光 / three 阴影；改挂 `app.on('update')`；**每帧 `requestFrame()`**；移除 WebGPU 回退 v1；UI / placeInFront / patrol / measure / diag 保留 |
| `web/human/human-layer-v1.js` | **新增（现已不引用）** | v1 双引擎降级副本，早期用于 WebGPU 兜底；WGSL 落地后不再动态加载，保留作人工回滚参考 |
| `web/human/splat-avatar.js` | 保留但**不再被 v2 引用** | 供 `versions/v1-dual-engine/` 回滚使用 |
| `web/gs-viewer.html` | **未改动** | 仍是 importmap（three 作为数据层）+ module script 两处 |
| `tools/check_human.mjs` | 断言更新 | 「overlay canvas 存在」→「无第二个 renderer + MeshInstance 挂进 layer」；新增按需渲染 / shader 语言 / 无转译错误 3 项守卫；支持 `--renderer=`；有头防 rAF 节流 flag |
| `tools/shoot_human.mjs` | 参数扩展 | 新增 `--renderer=` / `--winsize=` / 截图重试，用于出 WebGPU 交付图 |
| `tools/probe_single_engine.mjs` / `probe_pc_splat.mjs` / `probe_webgpu_shader.mjs` / `diag_v2.mjs` / `diag_v2_shader.mjs` / `diag_v2_decisive.mjs` | **新增** | 可行性探针与排障工具链 |
| `versions/v1-dual-engine/` | **新增** | v1 完整备份（3 个 js + html + 2 个工具 + 4 份文档） |

**回滚**：把 `versions/v1-dual-engine/` 的 3 个 js 拷回 `web/human/`，并恢复 `gs-viewer.html`，即回到 v1。

---

## 5. 后端矩阵（实测结论）

| 主渲染后端 | 判定 | shader | v2 行为 |
|---|---|---|---|
| WebGL2（headless / 无 GPU adapter / `?renderer=webgl`） | `device.deviceType === 'webgl2'` | **GLSL** | 单引擎主路径，`shaderDesc.vertexGLSL/fragmentGLSL` 直跑 |
| WebGPU（有头 Chrome，`?renderer=webgpu` 或默认自动选择） | `device.isWebGPU === true` | **WGSL** | 同一套单引擎，`shaderDesc.vertexWGSL/fragmentWGSL` 生效 |

`ShaderGenerator.createShaderDefinition()` 的判定是 `device.isWebGPU && !!desc.vertexWGSL && !!desc.fragmentWGSL && useWGSL`。因此**只要把两套 shader 同时塞进同一个 `shaderDesc`，引擎按当前 device 自动选择，业务层零分支**。`state.shaderLanguage` / `avatar.stats.shaderLanguage` 暴露实际生效语言用于自检。

**为什么不能只给 GLSL**：`tools/probe_webgpu_shader.mjs` 有头实测 `hasTranspilers=false / glslang=false / twgsl=false`；挂一个最小 GLSL `ShaderMaterial` 会报
`Cannot transpile shader ... glslang/twgsl are not available` 并静默不出像素；
同一页面挂最小 WGSL 材质（含 `input.instanceIndex` + `textureLoad(RGBA32F)`）则正常画出 4×4 青色点阵（`shots/wgsl_probe_B_wgsl.png`）。
宿主没有传 `glslangUrl/twgslUrl`，且「不改核心文件」是 S0 边界，所以正解是**补 WGSL**，不是给宿主打补丁，也不是回退双引擎。

WGSL 版与 GLSL 版数学逐项对齐：LBS 累加改为显式 4 次循环（WGSL 无 `inout`）、三元表达式改 `select()`、`gl_InstanceID` 改 `input.instanceIndex`、`texelFetch` 改 `textureLoad`、矩阵/纹理统一走 `uniform.*` 与 `var x: texture_2d<f32>`。落地阴影材质同样补了 WGSL（`textureSample` + `xSampler`）。

---

## 6. 两个决定性根因（排障复盘）

### 6.1 「对象在、像素不在」= 宿主是按需渲染

连续多轮改 uniform / viewport / depthTest / shader 二分都无效，直到 `tools/diag_v2_decisive.mjs` 同时发现：

```
app.stats.drawCalls.total = 0
5 张不同实验的截图 md5 完全相同
```

宿主在场景 revealed 后执行 `app.autoRender = false`，`app.tick()` 虽然每帧触发 `update`，但只有 `app.autoRender || app.renderNextFrame` 为真才调 `render()`。于是数字人的骨骼/排序数据一直在更新，**画面却永远冻结在场景加载完的那一帧** —— 表现为「自检 15 PASS / 0 FAIL、MeshInstance 确实在 layer 里、截图就是没有人」。

修复（`human-layer.js` 主循环末尾）：

```js
const requestFrame = () => {
  try { viewer.events?.fire?.('frame:request'); } catch (_) {}
  app.renderNextFrame = true;      // 与 web/editor/editor.js:165 同一手法
};
app.on('update', () => { /* ... 动作/骨骼/排序 ... */ requestFrame(); });
```

`check_human.mjs` 新增守卫：「连续采样 `drawCalls>0`」「`frameCalls` 增长」「shader 语言与后端匹配」「无 shader 转译/编译错误」，杜绝同类假阳性。

### 6.2 有头 CDP 自动化的 rAF 节流

`--headed` 自检曾出现 `fps=0 / genMs=0 / state.loaded=false`，但截图里控制面板显示 36 FPS。原因是被遮挡/后台窗口的 `requestAnimationFrame` 被 Chrome 完全停掉。仅影响测试浏览器，加 4 个 flag 后恢复正常：

```
--disable-background-timer-throttling
--disable-renderer-backgrounding
--disable-backgrounding-occluded-windows
--disable-features=CalculateNativeWinOcclusion
```

---

## 7. 验证记录（2026-11-14 终验）

| 命令 | 环境 | 结果 |
|---|---|---|
| `node tools/check_human.mjs --wait=240` | headless · WebGL2 · swiftshader | **19 PASS / 0 FAIL**，`deviceType=webgl2`、`shaderLanguage=glsl`、`drawCalls>0`、`frameCalls` 增长 |
| `node tools/check_human.mjs --wait=240 --headed --renderer=webgpu` | 有头 Chrome · WebGPU · RTX 3070 | **19 PASS / 0 FAIL**，`deviceType=webgpu`、`shaderLanguage=wgsl`、56–57 FPS、推理 148–246 ms / `backend=webgpu`、无 shader 转译错误 |
| `node tools/verify_editor.mjs` | headless | 见 `TEST_REPORT.md` 终验行（编辑器原功能回归） |
| `node tools/probe_webgpu_shader.mjs` | 有头 Chrome · WebGPU | GLSL 失败（转译器缺失）/ WGSL 成功出 4×4 点阵 |
| `node tools/shoot_human.mjs --headed --renderer=webgpu --dist=4.2 --winsize=1200,800` | 有头 Chrome · WebGPU | `shots/v2_deliver_webgpu_stand.png`，全身入镜 |

**截图证据**

| 文件 | 内容 |
|---|---|
| `shots/v2_deliver_webgpu_stand.png` | **单引擎 · WebGPU · WGSL** 站立交付图：紫头盔 / 橙色面罩 / 黄色宇航服 / 红靴，全身入镜 |
| `shots/v2_webgl_final.png` | 单引擎 · WebGL2 · GLSL 站立图（headless） |
| `shots/check_webgpu_walk_fresh.png` | 单引擎 · WebGPU 行走态 |
| `shots/wgsl_probe_B_wgsl.png` | WebGPU 最小 WGSL 材质 + `instanceIndex` + `textureLoad` 实证 |
| `shots/probe_pc_splat2.png` | WebGL2 最小高斯点阵实证 |
| `shots/deliver_stand.png` | v1 双引擎交付图，用于外观对照（面部颗粒为 12 万高斯采样固有色感，v1/v2 一致） |

**与 v1 对比**：外观、身高 1.75 m、120k splats / 65 bones、`1.2·sqrt(A/count)` 自适应半径全部保持一致；有头 WebGPU 帧率 56–57 FPS（v1 同环境 56 FPS）。差异是**架构**：WebGL 上下文 2→1、渲染循环 2→1、相机同步延迟消除。

---

## 8. 已知限制（不掩饰）

1. **遮挡仍不自动解决**：`GSplatQuadRenderer` 的 `depthWrite=false`，3DGS 点云本身不写深度。同引擎后虽然共享帧缓冲，人站到墙后仍不会被墙遮住。要真遮挡需对 `lcc2-collision.js` 的碰撞三角网做一次深度预通道，再在数字人 fragment 里比较 —— 列为 **v2.1**，不算进本次收益。
2. **透明绘制顺序**：数字人 MeshInstance 与 SOG 同在 `defaultDrawLayer`（BACK2FRONT），混合先后依赖引擎的 sortDistance。两个后端的实测截图都确认人清晰可见、没有被 SOG 覆盖；若后续场景变化出现覆盖，可用独立 Layer 固定顺序。
3. **浮点纹理显存**：120k splats × 8 texel × 16 B ≈ 15.4 MB，加上 bone/order 共约 16.5 MB（v1 的顶点属性约 12 MB）。
4. **每帧上传**：orderTex 每帧 `lock()/unlock()` 全量上传约 1.9 MB；v1 是每帧重写 2.9 MB index buffer，量级相当。
5. **持续渲染**：宿主原本按需渲染以省电；数字人是逐帧动画，v2 每帧请求渲染，`stand` 态也保持满帧。后续可按步态/可见性降到 30 FPS，列为优化项。
6. **三处沿用 v1 的既有局限**：走动后再「重新放置」落点偏 1–2 m（`controller.pose` 未被 teleport 收敛）、近距离 <1.5 m 仍见点状纹理、Q 版角色约 10% 滑步。
7. **有头截图链路**：`Page.captureScreenshot` 在长时间有头会话里偶发超时（第二次截图更明显）。`check_human.mjs` / `shoot_human.mjs` 已加重试；独立交付图建议用 `shoot_human.mjs` 单次截图。

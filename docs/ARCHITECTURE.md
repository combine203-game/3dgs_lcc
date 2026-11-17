# ARCHITECTURE.md — 3DGS 数字人集成方案

> **当前生效架构为下方 §0（v2 · 单引擎，2026-11-14）。** §1–§8 是 v1（双引擎）S1 冻结稿，已由 `DECISIONS.md` D10 取代，仅作历史基线保留。
> 决策依据：`docs/DECISIONS.md`（D1–D11，其中 **D10/D11 为现行裁决**）。接口契约：`docs/CONTRACT.md` **v2.0（唯一事实源）**。完整方案、实证与排障复盘见 `docs/ITERATION_V2.md`。

---

## 0. 现行架构：v2 单引擎（2026-11-14 生效）

### 0.1 一句话架构

**只保留 PlayCanvas 2.23.3 一套渲染引擎**：SOG 展厅与 MotionBricks 驱动的 3DGS 数字人共用同一个 `graphicsDevice`、同一张画布、同一个渲染循环、同一台 `CameraComponent`；数字人以 `pc.Mesh` + `pc.MeshInstance` + `pc.ShaderMaterial` 挂进 `app.scene.defaultDrawLayer`。three.js 退化为纯数据/骨架层（GLB 解析、Mixamo 骨架、上游库所需 Object3D），**零 renderer、零 canvas、零 GPU 资源**。

```
┌────────────────────── 同一个页面 / 同一个 PlayCanvas app ──────────────────────┐
│                                                                               │
│  graphicsDevice: WebGL2 → GLSL  |  WebGPU → WGSL（同一份 shaderDesc 双源码）  │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ app.scene.defaultDrawLayer（唯一渲染循环 app.on('update')）           │  │
│  │   ├─ SOG / gsplat 展厅（宿主原有）                                   │  │
│  │   └─ PcSplatAvatar: 120k instanced quad + LBS + EWA + 8192 桶排序    │  │
│  │        ▲ 3× RGBA32F: splatTex / boneTex / orderTex                    │  │
│  │        ▲ GLSL: texelFetch + gl_InstanceID                            │  │
│  │        ▲ WGSL: textureLoad + input.instanceIndex                      │  │
│  │   同一台 CameraComponent（无跨上下文同步、无第二 renderer）           │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│        ▲ 每帧 requestFrame() → frame:request + app.renderNextFrame = true    │
│        │（宿主 revealed 后 autoRender=false，是按需渲染）                    │
│  ┌─────┴───────────────┐        ┌──────────────────────────────────────┐  │
│  │ walk-controls / 碰撞 │        │ three.js（数学容器，不占 GPU）：      │  │
│  │ 小地图 / 标注编辑器  │        │  GLB → SkinnedMesh / 65 bones        │  │
│  └──────────────────────┘        │  MotionBricksCharacter (rig='soma')  │  │
│                                  └──────────────▲───────────────────────┘  │
│                                                 │ 30 Hz 姿态（Worker）     │
│                                  ┌──────────────┴───────────────────────┐  │
│                                  │ onnxruntime-web WebGPU EP → WASM 回退│  │
│                                  │ mmm_v6_soma_q8h.onnx (243 MB)        │  │
│                                  └──────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────┘
```

### 0.2 为什么统一到 PlayCanvas（D10）

| 方案 | 判断 |
|---|---|
| **A. 数字人搬进 PlayCanvas（采用）** | 宿主 bundle 已在 `globalThis.__pc` 暴露 `Mesh / MeshInstance / ShaderMaterial / Texture / GraphNode / BlendState` 与像素格式、图元、语义常量；只改 `web/human/**`，**不动 `app.js` / `viewer/index.js`**。 |
| B. SOG 场景搬到 three.js | 需重写 3.9 MB bundle 的 SOG 解码、分块、排序、相机控制、碰撞、标注、小地图、路线录制；违反「不改核心文件」。 |
| C. 保留两个 canvas，只统一坐标系 | 不解决「同一套渲染引擎」，否决。 |

three.js 不能彻底移除：`repalash/three-motionbricks` 的 `setCharacter(scene, CHARACTER_RIGS.mixamo)` 只接受 three 的 Object3D / Skeleton，GLB 由 `GLTFLoader` 解析。v2 中 `Scene / Group / PerspectiveCamera` 全是数学容器（"影子相机"仅用于 `placeInFront / measure / diag` 的向量运算）。

### 0.3 一帧的时序

```
PlayCanvas rAF → app.on('update')                       ← 唯一主循环
 ├─① driver.update(dt)         播放已生成帧 / 触发下一段推理（Worker 异步，~0.3–1 ms）
 ├─② avatar.updateBones()      65 骨骼矩阵 → boneTex (RGBA32F, lock/unlock)
 ├─③ avatar.updateSort(cam)    8192 桶 counting sort → orderTex 的 .r 通道（由远到近）
 ├─④ avatar.updateFrame(cam)   视深/视口参数刷新
 └─⑤ requestFrame()            viewer.events.fire('frame:request') + app.renderNextFrame = true
        ↓
   app.tick() → render() → defaultDrawLayer 一次性绘制 SOG + 120k 高斯（单 draw call）
```

**关键**：宿主的 `app.tick()` 只有在 `app.autoRender || app.renderNextFrame` 为真时才调 `render()`。场景 revealed 后 `autoRender=false`，数字人是逐帧动画，必须由 ⑤ 每帧请求出帧；否则数据一直在更新而画面冻结（v2 排障第一根因，见 `ITERATION_V2.md §6.1`）。

**推理不在这一帧内**：ONNX 在 Web Worker，主线程只在需要新片段时取结果；WebGPU 单次 148–325 ms，覆盖 0.6–1.9 s 动作，不阻塞渲染。

### 0.4 数据契约（与 `CONTRACT.md` v2.0 对应）

| 数据 | 形状 | 生产方 → 消费方 |
|---|---|---|
| SOMA 姿态 | 30 关节 × (pos3 + quat4)，30 Hz | Worker → MotionBricksCharacter |
| Mixamo 骨骼 | 65 × mat4 | RetargetedCharacter → `boneTex` |
| 高斯实例 | 120k × 8 texel（pos/normal/color+α/scale/quat/boneIdx4/boneW4） | 构建期采样 → `splatTex`（静态） |
| 绘制序 | 120k × splat id | `updateSort()` → `orderTex`（每帧） |
| 几何 | 4 顶点 quad + 6 索引，`setInstancing(true,true)`，`instancingCount=120000` | `pc.Mesh` → `pc.MeshInstance` |
| 矩阵 / 视口 | 引擎内置 `matrix_model / matrix_view / matrix_projection / viewport_size` | 引擎自动注入，业务层不自定义 |
| 相机 | 宿主唯一 `CameraComponent` | 直接读，无跨上下文 copy |

单位统一 **米**，坐标系 **Y-up 右手**，不做轴变换；角色根原点在**脚底**，归一化身高 1.75 m。排序键与 v1 逐字一致：`Σwᵢ·depth(boneᵢ) + rZL·(p_rest − Σwᵢ·bone_restᵢ)`。

### 0.5 集成点与回滚

`web/gs-viewer.html` **仍是 v1 的 2 处新增，v2 未新增第三处**：

1. `<script type="importmap">` —— 服务 `human/` 下 `three` 裸导入（现为数据层）；
2. `<script type="module" src="./human/human-layer.js">`

`human-layer.js` 自行 `waitForViewer()` 轮询 `window.__viewer`，不改 `app.js`，不与 `editor/bridge.js` 争生命周期。注释这 2 处即回到集成前；要回到 v1 双引擎，把 `versions/v1-dual-engine/` 的 3 个 js 拷回 `web/human/`。

### 0.6 后端矩阵（D11）

| 主后端 | shader | 行为 |
|---|---|---|
| WebGL2（headless / `?renderer=webgl`） | **GLSL** | `shaderDesc.vertexGLSL/fragmentGLSL`，`texelFetch` + `gl_InstanceID` |
| WebGPU（有头 Chrome / `?renderer=webgpu`） | **WGSL** | `shaderDesc.vertexWGSL/fragmentWGSL`，`textureLoad` + `input.instanceIndex` |

`createShaderDefinition()` 的判定是 `device.isWebGPU && !!desc.vertexWGSL && !!desc.fragmentWGSL && useWGSL`；把两套源码同时塞进同一个 `shaderDesc`，引擎按 device 自动选择，**业务层零分支**。`state.shaderLanguage` / `avatar.stats.shaderLanguage` 暴露实际生效语言。

宿主 `createGraphicsDevice()` 未传 `glslangUrl/twgslUrl`，有头实测 `hasTranspilers=false / glslang=false / twgsl=false`，GLSL 在 WebGPU 下会报 `Cannot transpile shader ...` 并静默不出像素。因此**正解是补 WGSL**，而不是给宿主打补丁，也不是 WebGPU 时回退 v1 双引擎（已移除该回退）。

### 0.7 性能与实测口径

| 指标 | 预算 | v2 实测（RTX 3070 / 有头 Chrome / WebGPU） |
|---|---|---|
| 主场景 FPS | ≥55 | **56–57 FPS**（v1 同环境 56 FPS） |
| 推理 | ≤300 ms | **148–246 ms**，`backend=webgpu` |
| 化身属性显存 | ≤64 MB | 3 张浮点纹理约 **16.5 MB**（`splatTex` ≈15.4 MB） |
| 每帧上传 | — | `orderTex` 全量 `lock()/unlock()` ≈ **1.9 MB**（v1 重写 index buffer ≈2.9 MB） |
| 高斯 / 骨骼 | 120k / 65 | 120000 / 65，`splatSize=0.0066 m` |

终验：`check_human.mjs --wait=240` **19 PASS / 0 FAIL**（WebGL2/GLSL）；`--headed --renderer=webgpu` **19 PASS / 0 FAIL**（WebGPU/WGSL）；`verify_editor.mjs` **283 PASS / 0 FAIL**。详见 `TEST_REPORT.md §14`。

### 0.8 已知结构性限制（不掩饰）

1. **遮挡仍不自动解决**：宿主 `GSplatQuadRenderer.configureMaterial()` 设 `depthWrite=false`，SOG 点云本身不写深度。同引擎共享帧缓冲 ≠ 自动获得遮挡；真遮挡需对 `lcc2-collision.js` 碰撞三角网做深度预通道并在数字人 fragment 比较 —— 列为 **v2.1**。
2. **透明绘制顺序**：数字人与 SOG 同在 `defaultDrawLayer`（BACK2FRONT），先后依赖 `sortDistance`；两个后端实测均清晰可见。若后续覆盖异常可用独立 Layer 固定顺序。
3. **持续渲染**：数字人逐帧动画使 `stand` 态也满帧请求渲染（宿主原本按需省电）；后续可按步态/可见性降帧。
4. **沿用 v1 既有局限**：走动后「重新放置」落点偏 1–2 m（`controller.pose` 未被 teleport 收敛）、<1.5 m 仍见点状高斯纹理、Q 版角色约 10% 滑步。

---

## 1. 一句话架构（v1 归档 · 已由 D10 取代）

**现有 PlayCanvas 3DGS 场景一帧不动；上面叠一块透明 canvas，用 three.js 把「MotionBricks 生成的骨架姿态」驱动的高斯化身画出来，两块画面共用同一个世界坐标系与同一个相机位姿。**

```
┌────────────────────────── 同一个页面（gs-viewer.html，同源） ──────────────────────────┐
│                                                                                       │
│  ┌───────────────────────────┐        ┌──────────────────────────────────────────┐   │
│  │ PlayCanvas (WebGL2)       │        │ three.js (WebGL2)  ← 透明 canvas overlay │   │
│  │  SOG 3DGS 场景 + 碰撞      │        │  SplatAvatar：120k 高斯 + LBS + EWA      │   │
│  │  相机实体（唯一真值）      │──位姿──▶│  PerspectiveCamera（每帧 copy）          │   │
│  └───────────────────────────┘        └───────────────▲──────────────────────────┘   │
│             │                                          │ 骨骼 worldMatrix              │
│             │ window.__viewer                          │                              │
│             ▼                                          │                              │
│  ┌───────────────────────────┐        ┌───────────────┴──────────────────────────┐   │
│  │ walk-controls（原漫游）    │        │ MotionDriver：MotionBricksCharacter      │   │
│  │ WASD / 摇杆 / 碰撞         │        │  rig='soma'，setCharacter(astronaut)     │   │
│  └───────────────────────────┘        └───────────────▲──────────────────────────┘   │
│                                                        │ 30 fps 姿态                   │
│                                        ┌───────────────┴──────────────────────────┐   │
│                                        │ Web Worker：onnxruntime-web (WebGPU EP)  │   │
│                                        │  mmm_v6_soma_q8h.onnx (243 MB)           │   │
│                                        └──────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

## 2. 为什么这样切（其他方案的否决理由）

| 方案 | 否决理由 |
|---|---|
| 把高斯化身做成 PlayCanvas 实体 | 要重写 3DGS 着色器为 PlayCanvas 材质、重做排序与混合；改动核心 `viewer/index.js`（禁令） |
| 用 three.js 重建整个 SOG 场景 | 要重做 SOG 解码 + 分块 + 排序 + 碰撞，且现有编辑器/标注/小地图全部失效 |
| 用视频/图片公告板冒充数字人 | 不满足「3DGS 驱动」，且无自遮挡、无真实视差 |
| 等一个带骨骼的高斯扫描人 | 无合规可下载资产；训练需 CUDA 与数据集，超出 demo 范围 |

## 3. 一帧的时序（关键路径）

```
rAF
 ├─① syncCamera()      读 PlayCanvas 相机实体 pos/quat/fov → three 相机（~0.01 ms）
 ├─② driver.update(dt) MotionBricksCharacter.update：播放已生成的帧 / 触发下一段推理
 │                      → 重定向到 Mixamo 骨骼 → 骨骼 matrixWorld（~0.3–1 ms）
 ├─③ avatar.updateBones()  65 骨骼矩阵 → RGBA32F DataTexture（~0.2–0.4 ms）
 ├─④ avatar.updateSort()   8192 桶 counting sort，按骨骼加权视深由远到近（~2–4 ms）
 └─⑤ renderer.render()     120k 高斯，单 draw call（GPU 2–4 ms @3070）
```

**推理不在这一帧里**：`three-motionbricks` 把 ONNX 放在 Web Worker，主线程只在需要新片段时取结果；生成耗时 155–325 ms（WebGPU），一次覆盖 0.6–1.9 s 动作，因此不阻塞渲染。

## 4. 数据契约（与 CONTRACT 对应）

| 数据 | 形状 | 生产方 → 消费方 |
|---|---|---|
| SOMA 姿态 | 30 关节 × (pos3 + quat4)，30 Hz | MotionBricks Worker → MotionBricksCharacter |
| Mixamo 骨骼 | 65 bone matrixWorld (4×4) | RetargetedCharacter → SplatAvatar（GPU 纹理） |
| 高斯实例 | 120k × {pos3, normal3, color3+a, scale3, quat4, boneIdx4, boneW4} | SplatAvatar 构建期一次性上传 |
| 相机 | pos3 + quat4 + fov(deg) + near/far | PlayCanvas → three（每帧） |

单位统一 **米**，坐标系 **Y-up 右手**，不做任何轴变换（两引擎一致）。角色根原点在**脚底**。

## 5. 集成点（只有 3 行）

`web/gs-viewer.html` 追加：
1. `<script type="importmap">` —— 只服务 `human/` 下 `three` 裸导入；
2. `<link rel="modulepreload" href="./human/human-layer.js">`（可选）
3. `<script type="module" src="./human/human-layer.js">`

`human-layer.js` 自己 `waitForViewer()`（轮询 `window.__viewer`），因此**不需要改 app.js 一行**，也不与 `editor/bridge.js` 争生命周期。
默认只挂一个「数字人」按钮；`?human=1` 自动加载。

回滚：注释上述 3 行 → 场景行为与改动前完全一致（已由回归验证）。

## 6. 性能预算与实测口径

| 指标 | 预算 | 实测（RTX 3070 / Chrome / 1600×900） |
|---|---|---|
| 主场景 FPS | ≥55 | 见 TEST_REPORT（原场景 ~60） |
| 化身渲染 | ≤4 ms | 见 TEST_REPORT |
| 排序 | ≤3 ms | 2.1–4.5 ms（swiftshader 软光栅下偏高） |
| 推理 | ≤300 ms | 155–325 ms（WebGPU）/ ~1 s（WASM 回退） |
| 首帧（不含模型下载） | ≤3 s | 见 TEST_REPORT |
| 显存（化身属性） | ≤64 MB | 120k×4 顶点×25 float ≈ 48 MB |

## 7. 降级矩阵

| 条件 | 行为 | 用户可见 |
|---|---|---|
| 无 `navigator.gpu` | ORT 回落 WASM | 面板显示 `后端 wasm` |
| WebGPU 首帧编译 >9 s | 库回落 WASM | 面板显示 `wasm` |
| 模型文件缺失 | 化身以绑定姿态显示，动作按钮无效 | 红字「模型未就绪」 |
| 高斯渲染失败 | 回退显示原始蒙皮网格 | 控制台 + `state.error` |
| 跨上下文遮挡 | 不做（见 D5） | README 已知限制 |

## 8. 已知结构性限制（不掩饰）

1. **无场景级深度遮挡**：两块 canvas 不共享深度缓冲，人站在墙后仍会画在墙上（自遮挡正确）。缓解：放在开阔地、加接触阴影；彻底解决需把化身并入主渲染器（见第 2 节否决理由）。
2. **Q 版角色 + 轻微滑步**：见 D3b。
3. **半透明层淡出会露背面**：3DGS 固有问题（depthWrite 关闭 + 由远到近混合）。
4. **首帧编译 8 s**：WebGPU 着色器编译，一次性；之后 155–325 ms。

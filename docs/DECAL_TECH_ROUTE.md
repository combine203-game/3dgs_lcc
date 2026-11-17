# 视频投射贴合方案 · 技术路线调研（Decal 技术路线）

> 背景：编辑器的「贴面矩形（decal）」当前用「屏幕矩形 → 逐点深度反算 → 生成 81 个世界点 → 连成网格四边形」实现。
> 用户判定该方案不对：**它本质是「重构一块贴合表面的网格」**，而不是游戏引擎里那种「像素级贴合、不重建几何」的 decal。
> 本文调研并给出正确路线：**屏幕空间 / 投影式延迟贴花（Screen-space / Projected Deferred Decal）**。

---

## 0. 结论先行

| | 当前实现（错误路线） | 推荐路线（游戏引擎主流） |
|---|---|---|
| 技术家族 | **网格投影贴花** Mesh / Projection Decal | **屏幕空间 / 投影式延迟贴花** Deferred / Screen-space Decal |
| 是否重建几何 | 是：把表面重建为 9×9 网格四边形 | 否：零几何生成，逐像素贴合 |
| 贴合精度 | 受采样点数限制（曲面会棱角/锯齿） | 像素级，曲面/台阶/斜面零额外成本 |
| 换机位成本 | 需重投影 81 个点 | 仅重算投影矩阵，几何不变 |
| 代表实现 | Wolfire/Lengyel 早期 Source；`viewer_stream/video-projection.js` 的射线-三角网求交 | Valve CS 弹痕、Unreal Decal Actor + DBuffer、Unity DecalProjector |

**推荐**：废弃 `unprojectRect` 的网格重建，改为在 3DGS 渲染管线末尾挂一个**屏幕空间投影贴花后处理 Pass**，
把视频按「投影机矩阵」投到**实际渲染深度的表面**上。碰撞 mesh 只用于定位/瞄准，不参与几何生成。

---

## 1. 两条贴花家族的本质区别

### 1.1 网格投影贴花（当前方案，应废弃）
- 思路：把贴花当作「附着在表面上的几何网格」来生成，再当 polygon list 渲染。
- 生成方式：要么裁剪目标网格三角形（Lengyel / Source 早期），要么像我们那样逐点采样表面重建一张网格。
- 代价：本质是「造了一块新网格去贴合」——点数有限、换机位要重算、曲面会棱角化。
- 文献直引：`blog.wolfire.com/2009/06/how-to-project-decals/`、`Eric Lengyel, "Polygon-Free Method for Rendering Decals"`。

### 1.2 屏幕空间 / 投影式延迟贴花（推荐）
- 思路：贴花是一个**投影机（有向包围盒 OBB / 投影视锥）**。渲染时用包围盒当代理体，在片元着色器里：
  1. 从**深度缓冲**重建该像素的世界坐标（而非用包围盒自身坐标）；
  2. 把世界坐标乘「投影机的逆矩阵」变换到贴花局部空间；
  3. 若落在 `[-0.5,0.5]³` 盒内 → 由局部坐标算 UV → 采样贴花纹理 → 与场景颜色混合；
  4. 可选：用表面法向与投影方向点积做**背面剔除**，避免投到背面/侧面。
- 关键：贴花「不知道表面长什么样」，它直接读深度——表面是什么形状，视频就贴成什么形状。**像素级、零几何生成。**
- 文献直引：`cstopics.com/.../deferred-decals`、`cstopics.com/.../projected-decals`、`OpenGL stencil decal`、`gamedev.stackexchange.com 重建世界坐标 + 盒体判定`。

---

## 2. 游戏引擎是怎么做的（参考）

### 2.1 Valve / Source —— Deferred Decals
- G-buffer（Normal-Depth、Diffuse）渲染完后，在 **G-buffer 之后、光照之前**多一个 Pass，把贴花渲染进 Diffuse buffer。
- 只画贴花体积（盒），用已填好的深度缓冲重建世界坐标，对受影响像素计算/写入贴花贡献。**不修改原始网格与材质。**
- 经典用例：CS 弹痕、爆炸痕。

### 2.2 Unreal Engine —— Decal Actor + DBuffer
- `Decal Actor` 是一个**方向相关的线框盒**，沿其 -X 轴投影；箭头指示投影方向。盒到达边界时贴花淡出。
- 两种方式：先累积进 **DBuffer**（BaseColor/Normal/Roughness），在 BasePass 采样；或 BasePass 之后直接混合进 **GBuffer**。UE5 默认走 DBuffer。
- **注意**：UE 的 `Mesh Decal` 才是「贴一块自定义几何」去贴合——那属于网格家族，正是本任务要避开的。我们要用的是 **Decal Actor（投影盒）** 这一支。

### 2.3 Unity —— DecalProjector（HDRP/URP）
- `DecalProjector` 组件 = 投影盒 + 投影材质，投影到 GBuffer（DBuffer 或 screen-space）。
- 限制同 UE：投影轴与表面不垂直时画面会被拉长/变薄；用浅投影深度避免穿透到其他物体。

### 2.4 三者共性（也是我们要落地的核心）
- 贴花 = **有向包围盒（OBB）** + 一个投影矩阵（world → local）。
- 片元着色器标准管线：`invViewProj` 由深度重建世界坐标 → `invProjectorMatrix` 转到局部 → 盒内判定 → UV 采样 → 混合。
- 每个 decal 一次（scissor 到包围盒屏幕范围）全屏 Pass，**O(屏幕像素 × decal 数)**，与场景复杂度无关。

---

## 3. 移植到 3DGS（高斯泼溅）查看器的具体路线

### 3.1 关键现实约束
- 3DGS 的可见表面是**高斯泼溅点云**，不是三角网；但我们已有 `viewer.collision()` 碰撞 mesh（用于 `queryRay` 拾取）。
- 用户原话「投射到碰撞体 mesh 上」：投影**目标表面**用碰撞 mesh 定义；但**像素级贴合**应读**实际渲染深度**（splat 帧深度，或单独对碰撞 mesh 渲一张深度/法线 RT）。
- `viewer_stream/video-projection.js` 已有「投射」框架，但其做法是「屏幕窗口 UV → 射线 → 逐条碰撞三角网求交 → 生成贴花顶点」，仍属**网格家族**，新路线不沿用它的几何生成，只借鉴其 `projector.position / headingDeg / windowUV / depthTolerance` 的参数组织。

### 3.2 投影机定义（编辑器侧）
- 交互沿用现有「屏幕画矩形」：用 `Picker.pick(x,y)` 取矩形中心处表面世界点 `P` 与表面法向 `N`（碰撞 mesh 上）。
- 构造投影机：
  - `position = P`
  - `forward = -N`（沿法向指向表面；对齐法向可规避掠射角拉伸）
  - `up` 取与 `N` 正交的世界 up
  - 盒半尺寸 `half = (w/2, h/2, d/2)`：`w/h` 由矩形屏幕尺寸 + 深度换算成世界尺寸；`d ≈ 0.3~0.8m`（浅，避免穿透到盒后物体）
  - 视频帧 = 投影纹理，`uv = local.xy + 0.5`

### 3.3 渲染 Pass（核心，零几何）
在 3DGS 主帧之后挂后处理：
- **输入**：场景颜色纹理、场景深度纹理（splat 渲染深度，或碰撞 mesh 深度 RT）、投影机矩阵（world→local）、视频纹理、时间。
- **片元着色器伪码**：
  ```glsl
  // 1) 由屏幕 uv + 深度重建世界坐标
  vec3 W = reconstructWorldPos(vUv, depthTex, invViewProj);
  // 2) 转到投影机局部空间
  vec3 L = (invProjector * vec4(W,1.0)).xyz;
  // 3) 盒外丢弃
  if (any(greaterThan(abs(L), vec3(0.5)))) discard;
  // 4) 背面/侧面剔除（由深度求法线）
  vec3 n = normalize(cross(dFdx(W), dFdy(W)));
  if (dot(n, projectorDir) < 0.0) discard;
  // 5) UV 采样视频
  vec2 uv = L.xy + 0.5;
  vec4 video = texture(videoTex, uv);
  // 6) 边缘软过渡（距盒边界 < t 时淡出）
  float edge = smoothstep(0.5, 0.5 - edgeFade, max(abs(L.x), abs(L.y)));
  // 7) 与场景混合（emissive / alpha）
  outColor = mix(sceneColor, video.rgb, video.a * edge);
  ```
- 这一步**逐像素贴合实际可见表面**，是真正的像素级，不创建任何网格。

### 3.4 为什么比「重构网格」好
- 当前 `unprojectRect` 把屏幕矩形反算成 ~81 个世界点再连网格：点数有限（贴曲面会棱角/锯齿），换机位要重投影，且本身就在「造新网格」。
- 投影贴花不需要「知道表面形状」：直接读深度，表面是什么形状就贴什么形状，**分辨率由屏幕决定（像素级）**，曲面/台阶/斜面零额外成本。

---

## 4. 编辑器侧改动（概念，待实施）

| 项 | 现状 | 改为 |
|---|---|---|
| 存储字段 | `rect` + `surface`（81 点网格） | `projector: { position, quaternion/forward, half:{x,y,z}, videoUrl }` |
| overlay 渲染 | 渲染 81 点四边形网格 + 单应视频面 | 渲染「投影盒框线 + 6 向手柄 + 视频预览缩略」（纯 UI，不参与投射） |
| 真实视频渲染 | DOM `<video>` 单应贴 | 新增 **decal 后处理 shader**（在 viewer 渲染循环里按投影机投射） |
| 三维屏/贴面 | 各自为战 | 共享同一「投影机」概念 |

---

## 5. 风险与取舍

- **深度来源精度**：splat 渲染深度若不够精确，贴合边缘可能微颤 → 可改对碰撞 mesh 单独渲一张深度/法线 RT，贴合度更高（代价：多一个 draw）。
- **掠射角拉伸**：投影轴与表面法向不垂直时画面拉长/变薄 → 把 `forward` 强制对齐表面法向规避（UE/Unity 同理）。
- **体积穿透**：用浅 `d`（投影深度）避免投到盒内其他物体；必要时用 stencil / 物体 ID 限制接收面。
- **多 decal 排序**：重叠时用 `sortOrder` / 画家算法。
- **性能**：每个 decal 一次 scissor 全屏 Pass，`O(像素×decal)`，远低于每帧逐点射线。

---

## 6. 落地步骤建议（待你确认后实施）

1. 在 viewer 渲染管线里拿到/生成深度纹理（splat 深度 或 collision-mesh 深度 RT）。
2. 写 decal 后处理 shader（深度重建世界坐标 + 投影盒判定 + 视频采样 + 边缘软过渡 + 混合）。
3. 用 `viewer_stream` 的 projector 参数先做一个**静态投影验证**（平面墙）。
4. 把编辑器 decal 存储从 `surface` 网格切到 `projector`，overlay 改为盒框线 UI。
5. 接入真实视频纹理（复用现有 `test.mp4` 管线）。

---

## 7. 参考文献 / 出处
- Deferred Decals 综述：`cstopics.com/encyclopedia/graphics/special-effects-rendering/decals-and-effects/deferred-decals`
- Projected Decals（Lengyel 投影视锥 + 包围盒 + 法线剔除）：`cstopics.com/.../projected-decals`
- 屏幕空间贴花从深度重建世界坐标 + 盒体判定：`gamedev.stackexchange.com`（Pope Kim / WH40K Space Marine SSD）、`stackoverflow.com/a/43459434`
- 从深度重建世界坐标：`threejs discourse`、`gamedev.stackexchange.com/questions/88311`
- Unreal Decal Actor / DBuffer：`dev.epicgames.com/documentation/.../decal-materials-in-unreal-engine`
- OpenGL stencil decal：`opengl.org/archives/resources/code/samples/advanced/advanced96/node31.html`

---

## 8. 落地状态（已实现 · 2026-11）

> 第 0~6 节是调研与方案；本节记录已落地的代码，便于后续维护。

### 8.1 已落地的事实决策
- **深度来源**：直接复用引擎 `Picker.renderView()` 返回的 **RGBA16F** 深度纹理（4 通道 = 4 次随机试验的最近存活归一化线性深度，`1.0=空`）。**不另开深度 RT**，因此不增加额外 draw，深度与拾取同源、天然对齐。
- **零几何**：不再生成 81 点网格；只画一个全屏 quad（`matrix_model` 自带，顶点不输出 varying，彻底规避 WGSL 自定义 varying 脚手架差异）。
- **像素级贴合**：每帧在 `frameend` 拿到最新 pick 纹理，在 `prerender` 算 `invViewProj`、投影机 `invProjector`，fragment 用 `texelFetch` 读 RGBA16F（半浮点不可线性过滤，故用整数坐标直读），按引擎 `getWorldPoint` 同款数学重建世界坐标 → 盒内判定 → 背面剔除（`dFdx/dFdy` 叉乘法线）→ UV 采样视频 → 边缘软过渡 → `BLEND_NORMAL` 半透明叠加到已渲染的 splat 帧（等价于 emissive 投影）。
- **像素坐标方向**：WebGL 原点左下需翻转，WebGPU 原点左上无需，由 `uUVSignY/uUVOffsetY` 统一。
- **纹理采样**：pick 用 `texelFetch`（RGBA16F 非可过滤）；视频用 RGBA8（可线性采样，但 decal 同样 `texelFetch` 保持统一）。

### 8.2 新增 / 改动文件
| 文件 | 作用 |
|---|---|
| `web/editor/decal-projection.js`（新增） | 屏幕空间 decal 投射核心：双后端 shader、全屏 quad、`pickPlaceholder` 占位纹理、每帧 uniform、视频逐帧 `setSource`、投影机矩阵工具、防御式初始化 |
| `web/editor/schema.js` | 数据模型切到 `projector:{position,quaternion,half,depth}`；新增 `buildDecalProjector / projectorOBBCorners / quatFromBasis / rotateByQuat`；`defaultStyle` 加 `decalOpacity/decalDepth/decalEdge/normal`；保留 `decalFrame/decalGridPoints/decalGridIndex` 兼容旧 surface 数据 |
| `web/editor/editor.js` | 装配 `decalMgr`；`getDecals/syncDecals`；`rebuildDecalProjector`（用 `unprojectRect` 取深度表面 → `buildDecalProjector`）；`ensureDecalProjectors`（挂载后为缺 projector 的旧数据补算）；`property` 支持 `decalOpacity/decalDepth/decalEdge`（decalDepth 只重算 OBB 半尺寸，不重采表面）；`unmount` 调 `destroy` |
| `web/editor/picking.js` | 新增 `enginePicker()`，暴露 `renderView()` 给 decal 取实时深度纹理 |
| `web/editor/overlay.js` | `projector` 类 decal 画 OBB 线框（12 边）+ 选中 6 向缩放手柄 + 中心移动手柄，并支持拖拽；旧 `surface` 类保留 81 点网格 + 单应视频 DOM 兜底 |
| `web/editor/panel.js` | decal 属性块改为投影机参数：投射视频 URL、不透明度、边缘软过渡、投射深度；移除 `decalGrid/decalLift` |
| `web/editor/editor.css` | 新增 `.ed-decal-obb / .ed-decal-obb-edge / .ed-decal-obb-handles / .ed-decal-obb-handle` 样式 |
| `web/viewer/index.js` | `__pc` 暴露补 `GraphNode / CULLFACE_NONE` 等供 decal 模块复用 |
| `web/editor/sample.json` | 示例 decal 改为 projector 数据模型 |

### 8.3 编辑器交互
- **绘制**：Shift+R（或工具栏）→ 屏幕上点两对角框出矩形 → 挂载时按当前画面深度反算重建投影机 OBB。
- **编辑**：选中后拖 OBB 中心平移、拖 6 向手柄沿轴缩放（中心手柄 = move，±X/±Y/±Z = 对应轴半尺寸）；属性面板改不透明度 / 边缘 / 投射深度。
- **重建**：属性面板「↻ 按当前视角重建投影机」重跑深度反算 → 重算 OBB。

### 8.4 防御式与已知限制
- 非真实 PlayCanvas 运行时（headless mock / 未暴露 `__pc`）或 shader 编译失败时 `console.warn` 并禁用，**绝不抛未捕获异常**；回归 harness 注入 `picker:()=>null` 时自动降级。
- **真实 GPU 验证尚未在 headless 跑通**（回归环境无 100MB SOG / 真实 WebGPU），shader 正确性靠与引擎 `getWorldPoint` 数学对齐 + 双后端语法审查保证；OBB 线框 / 属性面板 / 绘制链路已由 `tools/verify_editor.mjs` 第 24/25 段回归。
- 像素级贴合精度依赖 `Picker.renderView()` 的深度精度；若边缘微颤可后续改为对碰撞 mesh 单渲深度 RT（见 §5）。

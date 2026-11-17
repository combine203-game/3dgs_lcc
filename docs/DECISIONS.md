# DECISIONS.md — Lead 技术裁决

> 每条裁决一轮内定案，不允许两套并存。变更须 Lead 发布并广播。

## D1 · 集成形态：同页第二渲染上下文 + 透明 overlay（2026-11-13）
> **【2026-11-14 更新】本条已被 D10 取代**：v2 改为单引擎（PlayCanvas 一套）。D1 仅作为 v1 历史结论保留，归档实现见 `versions/v1-dual-engine/`。
- **裁决**：数字人用 three.js 独立 canvas 渲染，绝对定位覆盖在 PlayCanvas 3DGS canvas 之上，`pointer-events:none`，每帧从 `window.__viewer` 同步相机位姿；两套渲染互不侵入。
- 否决：① 把高斯化身塞进 PlayCanvas（要把 3DGS 着色器重写成 PlayCanvas 材质，风险与工作量远超收益）；② 用 three.js 重建整个 3DGS 场景（要重做 SOG 解码 + 排序，且会破坏现有全部功能）。
- 代价：跨上下文的**场景级深度遮挡**做不到（只能保证化身自遮挡）。缓解见 D5。

## D2 · 数字人本体：由 skinned GLB 采样得到的 LBS 高斯化身（2026-11-13）
- **裁决**：不等待「可商用带骨骼的高斯扫描人」资产（不存在可下载的合规样本），改为把 `astronaut.glb`（CC0，65 骨骼 Mixamo 骨架，含蒙皮权重与贴图）在**绑定姿态**下按面积采样成高斯点：每点带位置/法向/颜色/4 骨骼索引+权重/尺度/四元数，运行时在顶点着色器里做 **LBS 线性混合蒙皮**后按 EWA 投影成 2D 高斯。
- 这是「真 3DGS 渲染管线 + 骨骼驱动」，不是贴图公告板；但显式标注：**几何来自网格采样，不是扫描重建**。
- 升级路径：换成扫描化身时，只需把「采样 + 骨骼绑定」换成「高斯点 + 最近骨骼权重」，渲染与驱动层不动（CONTRACT 已按此解耦）。

## D3 · 动作来源：three-motionbricks（ORT WebGPU + Worker）+ SOMA 人形 ONNX（2026-11-13 修订）
- **裁决**：用 `repalash/three-motionbricks` v0.2.0 的 `MotionBricksCharacter`，`rig:'soma'`，模型用**单个 .onnx 文件** `web/human/model/mmm_v6_soma_q8h.onnx`（243 MB，q8h 量化，HF 镜像 `monoradio/motionbricks-soma-fp16-onnx`），`setCharacter(astronaut, CHARACTER_RIGS.mixamo)` 把 SOMA 30 关节动作重定向到 Mixamo 骨架。
- **为什么不是 G1**：SOMA 是**人形**骨架，动作语义（走/跑/待机/蹲）直接对应「数字人」；G1 是机器人骨架，需再重定向一层且步态是机器人风格。
- **为什么不是 NVIDIA 官方 758 MB fp32**：`media.githubusercontent.com` 与 `huggingface.co` 在本机均 502 不可达；HF 镜像上的 q8h 实测可用（WebGPU 稳态 155–325 ms/次，WASM 约 1 s/次）。
- **首帧容忍**：库默认 `gpuLimitMs=300` 会在首帧 shader 编译（实测 ~8 s）时误判并回落 WASM；驱动侧默认 `gpuLimitMs=9000`，仅放过冷启动，稳态仍按阈值判定。
- **动作清单以实测为准**：`stand / walk / run` 已实测可切换且骨架不回到绑定姿态；`jump / sit` 依赖 NVIDIA 示例片段（`media.githubusercontent.com` 不可达）→ 本环境**未启用**，如实标注。

## D3b · 人体比例：关掉 matchSize，按 1.75 m 归一（2026-11-13）
- **裁决**：`matchSize:false` + 本层统一缩放到 1.75 m。
- 理由：`astronaut.glb` 是 Q 版比例（原生 1.36 m、短腿），`matchSize:true` 会把人体拉到 **3.4 m**（实测 headY=3.45）才能对齐 SOMA 步幅——在展厅里显然错误。
- 代价：步幅与腿长不完全匹配，**走/跑时脚有轻微滑步**（约 10%），列入 README「已知限制」。

## D4 · 漫游：复用原场景 WASD，数字人独立自主移动（2026-11-13）
- **裁决**：不夺走原控制器。用户用原 WASD/摇杆在 3DGS 场景里自由漫游；数字人有两种模式：`驻留`（站在放置点做动作）与 `自主往返`（在两个路径点之间 `moveTo` 循环）。DoD 第 3 条按「按路径自主漫游 + 用户自由观察」回答。

## D5 · 遮挡与落地：能算的算，算不了的写清楚（2026-11-13）
- 化身自遮挡：GPU 深度测试保证正确。
- 场景遮挡：若 `viewer` 暴露碰撞体射线接口则每 6 帧做 1 次「相机→头部/胸口」射线，被挡则淡出；接口不可用则退化为「距离淡出 + 地面接触阴影」，并在 README 明写「无跨上下文深度遮挡」。
- 落地：以放置时刻的相机位姿推算地面高度（`camY - 1.6`），并把化身 root 固定在世界坐标，用户走动时保留正确视差与比例。

## D6 · WebGPU 边界（2026-11-13）
- MotionBricks **推理走 WebGPU**（`onnxruntime-web` 的 WebGPU EP，Worker 内），这是「WebGPU MotionBricks」的实质。
- 高斯渲染走 **WebGL2**（three.js），与上游 `three-motionbricks` 示例一致（其 demo 也是 WebGL2 渲染 + WebGPU 推理）。
- WebGPU 不可用 → 自动降级 WASM（`backend:'auto'` 上游已实现），UI 明示当前后端。

## D7 · 不修改核心文件（2026-11-13）
- 只允许在 `web/gs-viewer.html` 追加 2 行（`modulepreload` + `script type=module`），且可用注释回滚。其余全部新增于 `web/human/**`、`tools/**`、`docs/**`。

## D8 · 高斯半径按采样间距自适应（2026-11-13 晚，Lead 裁决）
- **问题**：落地检查时发现化身看起来像「彩色毛球」——头盔是一团紫橙色斑点、躯干看不出结构。DoD 2 要求「可见且正确」，这不能算 PASS。
- **根因**：`size=0.012`（可见半径 12 mm、四边形半径 18 mm）是**拍脑袋定的**，而 12 万点在宇航员约 1.5 m² 表面上均匀采样时，相邻点平均距离只有 **3.5 mm** —— 每个高斯盖住 3–4 个邻居，alpha 叠加后颜色饱和成块，细节被糊平。
- **裁决**：默认半径改为 `size = clamp(1.2·sqrt(A/count), 0.0015, 0.02)`，其中 A 是网格三角面总面积、count 是目标高斯数；`SplatAvatar.stats` 增出 `spacing`/`size` 便于核对。同时提供 `setSplatSize()`（只重写 `aScale`，不重采样）与 `?splatsize=` 便于调参。
- **代价**：半径变小后单体覆盖率下降，需要更高的点数或更近的观看距离才能完全无麻点；120k 在当前采样密度下 1.2× 间距仍有交叠，实测无漏光。
- **影响面**：`splat-avatar.js`（新增自适应与 setter）、`human-layer.js`（不再硬编码 0.012，暴露 `state.splatSize`）、`CONTRACT.md` §2 默认值语义、`tools/shoot_human.mjs`（新增 `--splatsize`）。

## D9 · 朝向：模型正面 = 外层局部 +X，删掉「读 hips 骨骼轴」的自校正（2026-11-13 晚，Lead 裁决）
- **问题**：D8 修完半径后仍能看出人「侧对镜头」，DoD 2 的「朝向正确」不成立。
- **取证方式（不猜）**：`tools/probe_yaw.mjs` 把角色放在镜头正前方，用 `setYaw()` 按 0/90/180/270° 各出一张图（`shots/yaw_0.png` … `yaw_270.png`）。结果：`yaw_0`（即 `placeInFront` 算出的基准角）**脸正面朝镜头**（橙色面罩居中、胸前装置可见、双腿分开站立）；`yaw_180`（基准 +90°）**侧对镜头**，与本轮之前所有交付截图的观感完全一致。
- **结论**：`placeInFront` 的 `yaw = atan2(-(camZ-pZ), camX-pX)` 本身是对的，它让**外层局部 +X 指向相机**；模型正面就是局部 +X（数学核对：`R_y(θ)·(1,0,0) = (cosθ,0,-sinθ) = d/|d|`）。
- **错误来源**：R4-D2 之后加的「读 `hips.matrixWorld` 的 +X 当人前向再做一次校正」——**骨骼局部轴 ≠ 网格轴**，Mixamo hips 的局部 +X 与模型正面差 90°，于是把已经正确的人又转歪了 90°。该段已从主循环删除（`human-layer.js:287-291` 保留注释说明）。
- **遗留**：走动时外层偏航按 `×0.85` 衰减到 0，朝向交给 MotionBricks 控制器（否则人的朝向 = 控制器 heading + 常数偏角，会歪着走）；`hipsObj` 仅用于判断位移与归位，不再参与朝向。

## D9b · 「重新放置」的边界：位置归 group，位姿归控制器（2026-11-13 晚，Lead 裁决）
- **现象**：走过一段路之后点「重新放置」，人没有回到镜头前（实测停在 4 m 外）。
- **根因**：MotionBricks 把**地面位姿**存在 `controller.pose` 里、每帧由它推出骨骼；本层改的是外层 group 的 position，两者叠加才对。走动时 pose 继续推进，group 上的偏移就被吃掉一部分。
- **试过的方案**：`MotionDriver.teleport()` 直接改写 `controller.pose`（用上游 `rig.place(rest,x,y,angle)`）。
  - 位置能改（新开页面 `placeInFront` → 落点精确到 0.01 m）；
  - 但 **pose 的 angle 会被控制器下一次生成覆盖**（加 `+π` 与不加看不出区别，截图 `shots/yawadd_pi.png` 仍是背面）；
  - 且 group 有旋转时落点会跟着旋转漂移（`rotation=π/2` 时目标 (0,2.8) 落到 (−2.16,3.23)），两次迭代不收敛。
- **裁决**：`teleport()` 保留为**实验性、默认不启用**（`motion-driver.js`，CONTRACT §3 已标注），`placeInFront` 回到「group 定位置 + group 定朝向」的已验证实现。**已知局限**：新开页面放置精确；走动之后重新放置落点会偏 1–2 m（仍在前方视野内）。要彻底修需要在上游 controller 上加 `setPose()` 并让 heading 与位置解耦，属于改上游，本轮不做。

## D10 · v2 架构：统一到同一套渲染引擎（2026-11-14，Lead 裁决）
- **触发**：用户「本地做版本迭代，改为使用同一套渲染引擎实现」。要求保留并迭代现有 v1，而不是另起一份。
- **裁决**：统一到 **PlayCanvas 2.23.3**，D1 的双 canvas / 双渲染循环作废。数字人改用 `globalThis.__pc` 暴露的原生 `Mesh / MeshInstance / ShaderMaterial / Texture`，挂进 `app.scene.defaultDrawLayer`，与 SOG 场景共用同一 graphicsDevice、同一台相机、同一帧缓冲、同一个渲染循环。
- **否决**：① 把 SOG 场景搬到 three.js（要重写 3.9 MB bundle 的 gsplat/SOG 解码、漫游、碰撞、编辑器、小地图）；② 保留两个 canvas 只统一坐标系（没解决用户诉求）。
- **three.js 的边界**：不能删 —— 上游 `three-motionbricks.setCharacter()` 只吃 three Object3D/Skeleton，GLB 由 `GLTFLoader` 解析。v2 里 three 只作**纯数据/骨架层**，零 `WebGLRenderer`、零 canvas、零 GPU 资源；`WebGL 上下文 2 → 1`，`渲染循环 2 → 1`，跨上下文相机同步延迟消除。
- **改动面**：`gs-viewer.html` 仍是原有 2 处（importmap + module script），不改核心文件；v1 全量备份在 `versions/v1-dual-engine/`。`CONTRACT.md` 升 v2.0，现行渲染器契约改为 `PcSplatAvatar`。
- **实测**：WebGL2 `19 PASS / 0 FAIL`；有头 WebGPU `19 PASS / 0 FAIL`、56–57 FPS、推理 148–246 ms；`verify_editor` `283 PASS / 0 FAIL`。外观、身高 1.75 m、120k splats / 65 bones 与 v1 一致。

## D11 · 两个后端都要真单引擎：按需渲染 + WGSL（2026-11-14，Lead 裁决）
- **问题 A（假阳性）**：v2 对象挂载成功、自检 15 PASS / 0 FAIL，但截图永远没有数字人。连续改 uniform / viewport / depthTest / shader 二分都无效。`tools/diag_v2_decisive.mjs` 一锤定音：`app.stats.drawCalls.total = 0`、5 张实验截图 md5 完全相同 → 宿主在场景 revealed 后 `app.autoRender=false`，`render()` 只在 `renderNextFrame` 时执行；`app.on('update')` 照跑但画面冻结在加载帧。
- **裁决 A**：`human-layer.js` 的 `update` 末尾固定调用 `requestFrame()` → `viewer.events.fire('frame:request')` + `app.renderNextFrame = true`（与 `web/editor/editor.js:165` 同一手法）。`check_human.mjs` 增「drawCalls>0 / frameCalls 增长 / shader 语言匹配 / 无转译错误」4 项守卫，杜绝同类假阳性。
- **问题 B（后端分叉）**：有头 Chrome 默认 WebGPU。`tools/probe_webgpu_shader.mjs` 实测 `hasTranspilers=false / glslang=false / twgsl=false`（宿主 `createGraphicsDevice` 未传 `glslangUrl/twgslUrl`），最小 GLSL 材质报 `Cannot transpile shader` 且静默不出像素；同页最小 WGSL 材质（`instanceIndex` + `textureLoad(RGBA32F)`）正常出图。早期版本在 WebGPU 下自动回退 v1 双引擎 —— 那会让用户默认环境里「同一套引擎」的交付失效。
- **裁决 B**：`shaderDesc` **同时提供 GLSL 与 WGSL**，由 `ShaderGenerator.createShaderDefinition()` 按 `device.isWebGPU` 自动选，业务层零分支；落地阴影材质同样补 WGSL。**移除 WebGPU 回退 v1**，`human-layer-v1.js` 降级为纯备份文件。不通过给宿主塞转译器或强制 `?renderer=webgl` 来绕过 —— 那要么违反「不改核心文件」，要么把交付绑死在单一后端。
- **代价**：维护两套语义等价的 shader（WGSL 里 `inout`→显式循环、`?:`→`select()`、`texelFetch`→`textureLoad`、`gl_InstanceID`→`input.instanceIndex`）；有头 CDP 自检需加 4 个防 rAF 节流 flag（只影响测试浏览器）。

## D12 · 编辑模式 4 项交互修复（2026-11-16，Lead 裁决）
- **动线 = 世界空间面片，不是 billboard**：屏幕空间 SVG 链（旧 `arrowChain()`）本质是朝向
  摄像机的平面片，与「贴合碰撞体 mesh」的产品要求矛盾。裁决沿贴合 MESH 后的**三维中心线**
  直接生成 6 顶点世界空间面片（`arrowChainWorld()`），`lateral = tangent × worldUp` 两级回退，
  抬高 3cm 防 z-fight，逐点投影绘制；带宽从屏幕 px 改为**世界米**。流动相位取
  `raw = (i + frac)·L`：段位置必须随相位向 +s 推进、与箭头尖同向 —— 旧式 `(i - frac)·L`
  是「动画方向和箭头方向反了」的根因。
- **三维屏 gizmo = 编辑软件通用三轴 + 选择柄**：六向（±R/±U/±F）手柄整体删除，
  换成 X 红/Y 绿/Z 蓝三根轴柄 + 中心选择柄（SVG 独立 DOM 层，不被屏体 matrix3d 压扁）。
  拖动数学不变：`_axisBasis` 给出每根世界轴的 world/screen/ppm，投影 <4px 兜底 80px/m。
- **贴花不播视频的数据层根因 = syncDecals 缺调用**：实例由 `decalMgr.sync(getDecals())`
  驱动，而改片源（media / local-video / 文件 / 撤销 / 显隐）从不重喂 sync，实例停在演示
  画面。裁决在 `action()` 末尾统一 `syncDecals()`，一条出口覆盖全部路径。教训：
  `decalMgr.debug()` 的 `videoReady` 写错成 `i.videoWidth`（实例无此属性，恒 false），
  三轮「解码停滞」假象皆源于此 —— 诊断钩子本身也要有测试。
- **双击语义定稿 = 全程无事件**：左键 / 右键双击一律捕获层拦截；2026-11-13 恢复的
  「双击标注回机位」再度移除，定位统一走「飞到此处」。右键单击 = 结束当前标注动作
  （点数足够完成、不足丢弃草稿），无草稿 = 上下文菜单 / 取消选中。
- **证据**：`verify_editor` 292/0；真机探针 `probe_decal_video.mjs` WebGPU 后端 A–F 全 PASS
  （片源设置与改片源均 500ms 内 `videoReady=true`）；mock 截图 17 张重生成。

## D13 · 贴花「只有线框」= 验收口径缺陷（不是渲染缺陷）+ 引擎解耦 A 档（2026-11-16，Lead 裁决）

- **裁决一：重新定性 —— 从「渲染缺陷」改为「验收口径缺陷」**。
  上一轮把「只有线框、无内容」归因为 shader 重建错误，本轮用 `tools/diag_decal_pair.mjs`
  在 49 个像素上把「引擎权威点（`picker.pick()`）」与「shader 口径重建点」逐像素配对：
  **深度对比平均绝对差 0 / 最大差 0**，`top_flipY` 变体**平均误差 0 / 最大误差 0 / 盒内 49/49**。
  即 shader 的世界点重建数学与引擎**逐像素完全一致**，渲染本身正确。
  那个 24% 覆盖率来自探针把「OBB 前表面 AABB」当分母：OBB 厚 4 m，前表面比真实表面近 2 m，
  透视放大使分母**虚大 4.59 倍**（376,356 vs 用户框选区 81,928 设备 px）。
  真机实测贴花覆盖用户框选区 **96.4%**。裁决：验收分母必须用**用户框选矩形**，
  OBB AABB 降级为「溢出参考框」。**教训：指标失真时，先怀疑口径，再怀疑实现** ——
  尤其当"缺陷"与"观察到的数字"之间存在一个看似合理的几何解释时。

- **裁决二：诊断脚本自身也可能是 bug**。`diag_decal_pair.mjs` v1 得出「4 个行序变体误差完全
  相同（6.754 m）、`nd` 全为 0」，一度像"所有口径都错"。真因是 WebGPU 下 `tex.read()`
  不带 `{immediate:true}` 会**读回全零**，所有变体退化成同一结果。
  裁决：任何 GPU 读回的诊断结论，**必须先做非零/范围自检**再解读；
  固化手段是读回后立刻打印「全零计数 / 最小值 / 最大值 / 数据类型」。

- **裁决三：GPU 错误必须归因，不能一律降级**。WebGPU `uncapturederror` 是**全局**的：
  引擎自身 mesh 的 pipeline 出错（CDP 截图触发视口变化 → 重建 VertexState 报
  "Vertex attribute slot 0 ... is not present in the VertexState"）与贴花无关。
  旧实现「任何错误都降级」→ 别人的错把贴花全隐藏 → 用户看到「框线在、视频没了」。
  裁决为**作用域 + 复测二分**：贴花绘制前 `pushErrorScope`、绘制后 `popErrorScope`；
  作用域内报错则**下一帧关掉贴花复测** —— 仍有错 = 非贴花故障（不降级），无错 = 贴花的错
  （降级）。真机验证：引擎错误被正确归为 `foreignErrors`，`degraded=false`，贴花照常渲染。

- **裁决四：引擎解耦采用 A 档**（用户确认）：新增**引擎适配抽象层**
  （`web/engine/engine-adapter.js` 契约 + `playcanvas-adapter.js` 实现 + `index.js` 解析入口），
  暂不实现第二引擎，但**接入路径必须已就位**。
  硬指标（已由回归守卫锁定）：`web/editor/` 目录内 PlayCanvas 具体类引用为 **0**；
  契约层不含任何引擎专有标识；shader 正文抽到引擎层 `decal-shaders.js`（GLSL 与 WGSL 双份，
  WGSL 是 PlayCanvas 专有形态，Babylon.js / three.js 需另写等价实现）；
  第二引擎优先 **Babylon.js**，接入契约见 `web/engine/babylon-adapter.md`。

- **证据**：`verify_editor` **330 PASS / 0 FAIL**（原 325 + 新增 5 条真机结论固化守卫）；
  真机探针 `probe_decal_realpath.mjs --headed` **5 项指标全 PASS**
  （覆盖率 0.9642 / 填充比 1.0000 / 主色差 5° / 孤立点 0% / OBB 外溢出 0.00000）；
  `probe_decal_realpath.mjs --headed --no-shot` 复测 `gpuErrors=0`，证明残留 VertexState
  错误由截图链路触发、与贴花无关。

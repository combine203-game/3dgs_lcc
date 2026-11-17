# DECISIONS.md — Lead 技术裁决

> 每条裁决一轮内定案，不允许两套并存。变更须 Lead 发布并广播。

## D1 · 集成形态：同页第二渲染上下文 + 透明 overlay（2026-11-13）
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

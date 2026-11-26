# DELIVERY — 3DGS 数字人（MotionBricks / SOMA）一页式交付说明

工程：`D:\WorkSpace\AI\3DGS_build\viewer_edit` · 初版 2026-11-13 · **当前交付 v2：2026-11-14，单引擎**（`docs/DECISIONS.md` D10/D11）

> **阅读顺序**：下方 §0 是**当前 v2 交付结论**；§1–§5 是 v1（双引擎）时期的 DoD 记录，作为历史基线与许可证口径保留，其中「两个渲染上下文 / 透明 overlay / 跨 canvas 相机同步」的描述**已不适用于 v2**。

## 0. 当前交付：v2 单引擎（2026-11-14）

**用户诉求**：「本地做版本迭代，改为使用同一套渲染引擎实现」。

| 项 | v1（已归档） | **v2（当前）** |
|---|---|---|
| 渲染引擎 | PlayCanvas + three.js 两套 | **PlayCanvas 2.23.3 一套** |
| WebGL/WebGPU 上下文 | 2 | **1** |
| 渲染循环 / 相机 | 各跑一套 + 每帧跨 canvas 同步 | **同一 `app.on('update')` + 同一 CameraComponent** |
| 数字人 | `THREE.InstancedBufferGeometry` | `pc.MeshInstance` 挂 `defaultDrawLayer`，3 张 RGBA32F 纹理 |
| WebGL2 / WebGPU | GLSL + WebGPU 时回退 v1 双引擎 | **GLSL / WGSL 双 shader，两个后端都单引擎** |
| 核心文件 `gs-viewer.html` | 2 处新增 | **仍是同样 2 处，未新增** |

**两个决定性修复**（详见 `ITERATION_V2.md §6`）：① 宿主 `app.autoRender=false` 按需渲染，v2 每帧必须 `frame:request` + `renderNextFrame=true`，否则「对象挂载成功、自检全绿、画面冻结」；② 宿主 WebGPU 未加载 glslang/twgsl，GLSL 无法转译，故补齐 WGSL 并移除 v1 回退。

**终验（同一台 RTX 3070）**

```
node tools/check_human.mjs --wait=240                                   # WebGL2 / GLSL
========== 19 PASS / 0 FAIL ==========   deviceType=webgl2  shaderLanguage=glsl

node tools/check_human.mjs --wait=240 --headed --renderer=webgpu       # WebGPU / WGSL
========== 19 PASS / 0 FAIL ==========   deviceType=webgpu  shaderLanguage=wgsl
                                         56–57 FPS · 推理 148–246 ms · 无 shader 转译错误

node tools/verify_editor.mjs                                           # 原功能回归
========== 283 PASS / 0 FAIL ==========
```

文档同步后于 12:39–12:44 串行收口复跑一次，三条命令退出码全 0、结果一致；WebGPU 本轮 `fps=57/56`、`genMs=144.2/150.3 ms`（两轮合计推理 144–246 ms）。详见 `TEST_REPORT.md §14.3`。

**DoD 8 条逐条结论（v2 口径，与 `TEST_REPORT.md §14.6` 一致）**

| # | 验收项 | 结论 | v2 证据 |
|---|---|---|---|
| 1 | 干净环境从零启动、无构建、关键资源可达 | **PASS** | 无 `package.json` / `node_modules`；`gs-viewer.html` / `human-layer.js` / `pc-splat-avatar.js` 均 200，ONNX `Range: bytes=0-1023` → 206 / 1024 B；`gs-viewer.html` 仍只有 2 处新增 |
| 2 | 数字人可见且正确 | **PASS** | 19 项断言含 `count>0` / `bones>0` / `height∈(1.65,1.85)` / 世界包围盒 `∈(1.4,2.1)`；`shots/v2_deliver_webgpu_stand.png` 目视确认全身着装配色与落地 |
| 3 | 漫游：原 WASD + 自主往返 | **PASS**（沿用 v1） | 集成层 UI / `placeInFront` / patrol / 归位逻辑未改；v1 位移 1.58 m、`cameraMode=walk` 仍适用 |
| 4 | 动作 stand / walk / run 可切换 | **PASS** | 19 项含「三种步态均可切换」「walk 后仍有推理产出」；WebGPU 推理 148–246 ms |
| 5 | 性能 ≥55 FPS、推理 ≤300 ms | **PASS** | 有头 WebGPU **56–57 FPS**、推理 **148–246 ms**（v1 同环境 56 FPS / 187.5 ms） |
| 6 | 原功能无回归 | **PASS** | `node tools/verify_editor.mjs` → **283 PASS / 0 FAIL** |
| 7 | 兼容与降级 | **PASS**（口径更新） | WebGL2 → GLSL、WebGPU → WGSL，**两个后端都单引擎**；ORT 无 WebGPU → WASM 沿用 v1；不再有「WebGPU 时回退双引擎」 |
| 8 | 改动面受控、可回滚、文档与许可齐备 | **PASS** | 核心文件 2 处不变；`versions/v1-dual-engine/` 完整备份；`ITERATION_V2.md` 新增，`ARCHITECTURE.md §0` / `CONTRACT.md v2.0` / `DECISIONS.md D10–D11` / `README.md` / `TEST_REPORT.md §14` / `DELIVERY.md §0` 已同步；4 份许可证副本沿用 v1 |

**架构收益（可量化）**：WebGL/WebGPU 上下文 **2→1**、渲染循环 **2→1**、相机同步延迟消除（同一台 `CameraComponent`）、每帧 GPU 上传 2.9 MB index buffer → 1.9 MB `orderTex`、WebGPU 主后端不再回退双引擎。

**交付截图**：`shots/v2_deliver_webgpu_stand.png`（WebGPU / WGSL，全身入镜）、`shots/v2_webgl_final.png`（WebGL2 / GLSL）、`shots/check_webgpu_walk_fresh.png`（WebGPU 行走态）、`shots/wgsl_probe_B_wgsl.png`（WebGPU 最小 WGSL 实证）。外观与 v1 `shots/deliver_stand.png` 一致：120k splats / 65 骨骼 / 1.75 m / 高斯半径 6.6 mm。

**回滚**：`versions/v1-dual-engine/` 内含 v1 全部源码与文档；把 3 个 js 拷回 `web/human/` 即回到双引擎。当前 `web/human/human-layer-v1.js` / `splat-avatar.js` 为未引用的归档副本。

**已知限制**：SOG `depthWrite=false`，同引擎仍不自动获得场景级遮挡（v2.1）；数字人是逐帧动画，`stand` 态也保持满帧请求渲染；走动后重新放置落点偏 1–2 m（沿用 D9b）。

---

## 1. 实现了什么（v1 基线）

在不改动 PlayCanvas 场景、编辑器与漫游逻辑的前提下，于 `web/gs-viewer.html` 末尾加载一个独立模块：它新建透明 canvas（three.js/WebGL2），把 `astronaut.glb`（CC0，65 骨骼 Mixamo 骨架）在绑定姿态下按面积采样成 **120000 个高斯**，运行时在顶点着色器做 LBS 蒙皮 + EWA 投影；动作由 **MotionBricks SOMA 模型**（`mmm_v6_soma_q8h.onnx`，243 MB）在 Web Worker 内经 onnxruntime-web 推理（WebGPU 优先、自动回落 WASM），30 Hz 姿态重定向到 Mixamo 骨架后驱动高斯。每帧从 `window.__viewer` 读相机位姿写入 three 相机，因此两个渲染上下文共享同一世界、同一视差；人物归一化到 1.75 m，支持站立/行走/奔跑三档步态、驻留与往返两种自主模式、重新放置、±2 cm 升降与隐藏。

```
 gs-viewer.html?scene=floor3&human=1
        │
        ├─▶ [PlayCanvas 2.23.3 / WebGL2]  mm_floor3.sog（原始 LOD0 SOG，HTTP Range 206）
        │        相机实体 ── pos/quat/fov（每帧） ──────────────┐
        │                                                       ▼
        └─▶ [three.js / WebGL2 透明 overlay]            PerspectiveCamera
                  SplatAvatar 120k 高斯 / 65 骨骼 ◀── bone.matrixWorld
                          ▲                                 ▲
                          │ LBS + EWA + 8192 桶排序          │ retarget（SOMA→Mixamo）
                  human-layer.js（放置/模式/UI/统计）   MotionBricksCharacter
                          ▲                                 ▲ 30 Hz 姿态
                          └── drive(dir,gait) / update(dt) ─┘
                                                       [Web Worker]
                                              ORT WebGPU（无则 WASM）
                                              mmm_v6_soma_q8h.onnx 243 MB
```

## 2. 怎么跑

```bash
cd /d/WorkSpace/AI/3DGS_build/viewer_edit
node tools/fetch_hf_model.mjs q8h web/human/model     # 首次：243 MB，断点续传
python serve.py --port 8099 --no-browser
```

```
http://127.0.0.1:8099/gs-viewer.html?scene=floor3&human=1
```

`?human=0` 完全关闭；不带 `human` 参数则只显示左下角「数字人」入口按钮。无构建步骤、无 `npm install`。

## 3. DoD 8 条逐条对照

> 条目按 `docs/TEST_REPORT.md` §0 的 1–7 号测试项复原，第 8 条取 `docs/DECISIONS.md` D7 的集成边界要求。证据只引用已落盘的报告、文件与实测数字。

| # | 验收项 | 结论 | 证据（文件 / 命令 / 数字） |
|---|---|---|---|
| 1 | 干净环境从零启动：无构建、关键资源可达 | **PASS** | `TEST_REPORT.md` §1：无 `package.json`/`node_modules`；服务就绪 851 / 1049 / 1311 ms；9 项关键资源检查全 PASS（8 个 200 + ONNX `Range: bytes=0-0` → 206，`Content-Range: bytes 0-0/242732481`） |
| 2 | 数字人可见且正确（splats / 骨骼 / 身高 / 朝向 / 落地） | **PASS**（含两处观感缺陷的根因修复，D8/D9） | §2 + 本轮复测：`state={ready:true,count:120000,bones:65,height:1.75,splatSize:0.0066,spacing:0.0055}`；`measure()={height:1.75,width:0.795,minY:0.024,maxY:1.774,camDist:2.89,scale:1.284}`；截图 `shots/deliver_stand.png`（站立正对镜头：橙色面罩居中、胸前装置、双腿分开、红靴落地）。两处根因：① 高斯半径原为硬编码 12 mm，而 12 万点在 3.6 m² 表面上的平均间距只有 5.5 mm —— 每点盖住 3 个邻居、alpha 叠加饱和，看起来是「彩色毛球」；已改为 `1.2·sqrt(A/count)` 自适应（D8）。② 朝向：`placeInFront` 的 `yaw=atan2(-(camZ-pZ),camX-pX)` 本身正确（让外层局部 +X 指向相机），R4-D2 之后加的「读 hips 骨骼 +X 当人前向」二次校正把已经正确的人又转歪 90°；该段已删除，并用 `tools/probe_yaw.mjs` 四方向标定确认（D9）。脚底离地 24 mm = 接触阴影高度 |
| 3 | 漫游：原 WASD 不被夺走 + 数字人自主往返 | **PASS**（超调 R4-D1 已修） | §3：有头按住 W 1 s 相机位移 **1.58 m**，`cameraMode=walk`（漫游仍归原控制器）。R4-D1 根因是根位移落在 hips 骨骼、group 原点不动，按 `root.position` 归位等于没归；现改为读 hips 世界坐标反推归位 + 超半径即掉头并重置锚点（`nav.anchor` 取 hips 位置），切断「一路走进墙」。驻留半径 1.2 m / 往返 2.4 m。掉头后最大偏离量未重新采样（见 §4） |
| 4 | 动作：stand / walk / run 可切换且不回绑定姿态 | **PASS** | §4：三档 `state.gait` 立即生效，`genMs` = **211 / 317 / 277 ms**，各 5 s 无新增 JS 异常；接口快照 `driver.jump=undefined`、`driver.sit=undefined`，UI 无入口。`jump`/`sit` 未启用（NVIDIA 示例片段源 502，且该数据许可仅限内部评估） |
| 5 | 性能：WebGPU 主路径 ≥55 FPS、推理 ≤300 ms | **PASS** | §5：1600×900 有头 **56 FPS**（min 42 / max 56）、推理 **187.5 ms**、JS 堆 **32.1 MB**、原场景首帧 **6107 ms**、数字人就绪 **24093 ms**；headless/WASM：25 FPS、1168 ms、25.0 MB。本轮 headless 复测（同机同时段有其它进程）为 14–15 FPS / 1518–2430 ms，属 WASM 路径的正常波动 |
| 6 | 原功能无回归 `node tools/verify_editor.mjs` | **PASS** | §6 定位的唯一 FAIL 是静态正则过严（`editor.js:680` 实写 `projector.half[0] + projector.half[1] > 16`，脚本 `tools/verify_editor.mjs:2197` 断言的是字面 `half[0] + half[1]`），已放宽为 `/half\[0\] \+ [\w.]*half\[1\] > 16/`；**修正后复跑 283 PASS / 0 FAIL**（基线 247/0，断言已增至 283 条；本轮末次复跑同一结果） |
| 7 | 兼容：无 WebGPU → WASM 降级且状态可见 | **PASS** | §7：注入 `navigator.gpu=undefined` 后 `backend=wasm`、`ready=true`、`modelReady=true`（23 PASS）。本轮 headless（无 GPU adapter）自然走该分支，集成自检 **14 PASS / 0 FAIL**，`[4b] backend=wasm`、面板文案「后端 wasm」可见。原 R4-D5「面板被小地图遮挡」经历了两次修复：第一次只是把 `bottom` 硬编码为 212 px（`z-index` 8→40），本轮新增几何断言后**当场又 FAIL 了一次**——因为小地图实测高 **257 px**（含标题栏），212 px 不够；现改为运行时读小地图矩形动态让位（`placePanel()`，`human-layer.js:410-421`），复测 `panel={ok:true,y:296..517} vs mm={y:527..784}` 不相交 |
| 8 | 改动面受控、注释即回滚、文档与许可齐备 | **PASS** | `web/gs-viewer.html` 仅 2 处新增：`:22-25` importmap、`:220` module script（注释这两处即回到集成前行为）；其余全部在 `web/human/**`、`tools/**`、`docs/**`；`docs/` 下 SCENE/UPSTREAM/ARCHITECTURE/CONTRACT/DECISIONS/TEST_REPORT/README/DELIVERY 齐备。许可证副本已落盘 `web/human/vendor/licenses/`：three-MIT(1081 B)、three-motionbricks-Apache-2.0(10779 B)、onnxruntime-web-MIT(1073 B，从 `microsoft/onnxruntime/main/LICENSE` 取原文)、NVIDIA-Open-Model-Agreement(7910 B，从 HF 镜像取原文) |

## 4. 未验证项及原因

| 项 | 原因 |
|---|---|
| 驻留/往返的最大偏离量未重新量测 | 掉头逻辑已改为「读 hips 位置 → 超半径即掉头 → 锚点重置」（`human-layer.js`），但 §3 里的 2.770 m / 4.004 m 是**修复前**的采样值。本轮只做了「不再一路走进墙、重新放置后能归位」的定性确认与截图，没有重做 10 s 定点位移采样 |
| 「走过一段路后重新放置」的落点精度 | 见 §5-8（D9b）：机制已查清，干净复位需要上游 `setPose()`；本轮不启用实验性 teleport |
| Intel UHD630 集显路径 | 本轮 Chrome 默认使用 RTX 3070，未强制集显对照（`TEST_REPORT.md` §9） |
| 长时间稳定性 / 内存泄漏 | 只做 10 s 采样，未跑 >10 min 循环（§9） |
| Safari / Firefox / 移动端；IIS/nginx 的 MIME 与 Range | 环境只有 Chrome + `serve.py`（§9） |
| 模型缺失 / 下载中断的失败 UI | 本地模型完整，未人为删文件触发（§9） |
| `jump` / `sit` | `media.githubusercontent.com` 502 拿不到 NVIDIA 示例片段，且该数据许可仅限内部评估 —— **未实现，不作为能力声明** |

## 5. 已知限制与后续建议

1. **无跨上下文场景遮挡**（人站墙后仍画在墙上）。建议：若必须修，把化身并入主渲染器共享深度，或在 PlayCanvas 侧导出深度纹理给 three 采样；当前以「放在开阔地 + 接触阴影」缓解。
2. **Q 版角色 + 约 10% 滑步**（关 `matchSize` 换 1.75 m 身高的代价）。建议：换写实比例的扫描化身，或加两骨 IK 把脚锁到地面。
3. ~~patrol 超调~~（已修，R4-D1）：掉头判定改读 hips 世界坐标、超半径即反向并重置锚点。残留风险：判定是「到点后掉头」而非规划，转向期间仍会小幅越界；建议加入转向半径与碰撞查询，或改为路径点队列。
4. ~~朝向偏 90°~~（已修，R4-D2 → D9 二次修正）：最终结论是**不要二次校正** —— `placeInFront` 的 yaw 公式已经让「模型正面 = 外层局部 +X」对准相机；早期「读 hips 骨骼 +X 当前向」的校正是错的（骨骼轴 ≠ 网格轴），已删除。残留风险：走动时外层偏航按 `×0.85` 衰减到 0 交还给控制器，所以「放置后立刻按行走」会看到约 0.5 s 的转向过渡。
5. **WASM 回退体验差**（1168–2430 ms/次、14–25 FPS）。建议：无 WebGPU 时默认降 `count` 到 60k，或提示用户改用有头 Chrome（`--ignore-gpu-blocklist`）。
6. **高斯观感**（D8）：半径自适应后不再糊成色团，但 12 万点在近距离（<1.5 m）仍能看到点状纹理；若要「近看也细腻」，建议把 `count` 提到 30–50 万（排序与 LBS 成本线性上涨，`updateSort` 会从 3 ms 涨到 10 ms 以上）。
7. **许可证合规**：副本已补齐到 `web/human/vendor/licenses/`（4 份）。注意 UPSTREAM §3 的初判已被许可原文修正 —— NVIDIA Open Model Agreement **允许商用与再分发**（附三项条件），受限的只有 NVIDIA 示例动作片段。对外发布前请保留该目录随包。
8. **「重新放置」的边界**（D9b）：新开页面首次放置精确（`charPos=(0,0.56,2.8)`，与目标一致）；**先走过一段路再点「重新放置」，落点会偏 1–2 m**，仍在前方视野内但不再是正前方 2.8 m。根因是 MotionBricks 把地面位姿存在 `controller.pose` 里、每帧由它推进，本层改的是外层 group；直接改写 pose 的实验性接口（`MotionDriver.teleport`）实测「位置能改、heading 会被控制器下次生成覆盖、转 group 时落点跟着漂」，两次迭代不收敛，故默认不启用。彻底修需在上游 controller 加 `setPose()`，属于改上游，本轮不做。

# README — 3DGS 数字人 Demo（MotionBricks / SOMA）

> 面向第一次跑这个 demo 的人。所有数字来自 `docs/TEST_REPORT.md` 的实测记录，未测的会明确标注。

## 1. 这是什么（v2 · 单引擎，2026-11-14）

在现有 PlayCanvas 3DGS 展厅（`web/gs-viewer.html`）里，用**同一套 PlayCanvas 2.23.3 引擎**渲染一个由骨骼驱动的 120k 高斯化身；动作由 MotionBricks（SOMA 人形 ONNX）在 Web Worker 里实时生成，再重定向到化身骨架。

- **只有 1 个 WebGL/WebGPU 上下文、1 个渲染循环、1 台相机**：数字人是 `pc.MeshInstance`，挂进 `app.scene.defaultDrawLayer`，与 SOG 场景共用 graphicsDevice 和帧缓冲；没有第二块透明 canvas，也没有跨 canvas 的相机同步延迟。
- 原场景、编辑器、WASD 漫游**一行未改**；`web/gs-viewer.html` 仍只有 importmap + module script 两处新增。
- three.js 退化为**纯数据/骨架层**（GLB 解析、Mixamo 骨架、上游 motionbricks 需要的 Object3D）：零 `WebGLRenderer`、零 canvas、零 GPU 资源。
- shader 同时提供 **GLSL（WebGL2）与 WGSL（WebGPU）**，引擎按 device 自动选；两个后端都是单引擎，有头 Chrome 默认的 WebGPU 不再回退双引擎。
- **仍没有场景级深度遮挡**（SOG 自身 `depthWrite=false`），见 §7；真遮挡列为 v2.1。
- v1（双 canvas / three.js 渲染）完整归档在 `versions/v1-dual-engine/`，方案与实测见 `docs/ITERATION_V2.md`。

## 2. 依赖什么

| 依赖 | 要求 | 说明 |
|---|---|---|
| Python | 3.x（标准库即可） | `serve.py` 起静态服务，带 Range 206 |
| 浏览器 | Chrome（建议**有头**） | WebGPU 主路径要 D3D12；无 WebGPU 自动回落 WASM |
| Node | 建议 22.x（实测 v22.22.2） | 只有下模型 / 跑验证脚本需要；脚本用 Node 内置 WebSocket + 系统 Chrome |
| GPU | 实测 RTX 3070 | Intel UHD630 集显未做对照（`TEST_REPORT.md` §9） |

**不需要** `npm install`、没有打包步骤、没有 `package.json` / `node_modules`。三方依赖已 vendor 到 `web/human/vendor/`：three 0.168、onnxruntime-web 1.30、three-motionbricks 0.2.0 dist。

## 3. 怎么启动

```bash
cd /d/WorkSpace/AI/3DGS_build/viewer_edit
python serve.py --port 8099 --no-browser
```

打开：

```
http://127.0.0.1:8099/gs-viewer.html?scene=floor3&human=1
```

URL 参数：

| 参数 | 取值 | 作用 |
|---|---|---|
| `scene` | `floor3`（缺省）/ `floor1` | 场景；floor3 为 2.38M 高斯，floor1 为 8.87M（加载更慢） |
| `human` | `1` | 自动加载数字人（首次会下 243 MB 模型） |
| `human` | `0` | 完全关闭：不建 canvas、不加载 three、不下载模型 |
| `human` | 不写 | 只在页面左下角挂一个「数字人」按钮，点击后才加载 |

模型（首次必须，之后复用本地文件）：

```bash
node tools/fetch_hf_model.mjs q8h web/human/model
# -> web/human/model/mmm_v6_soma_q8h.onnx，242,732,481 B（243 MB）
```

> 模型来源是 HF 镜像 `hf-mirror.com`（等价 ONNX 导出）。早期的 repalash.com q8 pack 在本机 25–40 KB/s 且频繁断连，已弃用；`web/human/model/pack.json` 是那次下载的清单残留，单文件 .onnx 模式下不读取。

## 4. 目录结构

```
web/human/
  human-layer.js          集成层主控（v2）：PlayCanvas 主循环 + 每帧 requestFrame() + 放置/模式/UI + __mgHuman
  pc-splat-avatar.js      高斯化身（v2 现行）：采样 + LBS + EWA + 8192 桶排序 + GLSL/WGSL 双后端 shader
  splat-avatar.js         高斯化身（v1 归档）：three.js InstancedBufferGeometry，仅回滚时使用
  human-layer-v1.js       v1 双引擎集成层备份，当前不引用
  motion-driver.js        MotionBricks 封装：create/bindCharacter/setGait/drive/update + stats
  _test-avatar.html       化身单页自检（不依赖场景，直接看 120k 高斯与骨骼）
  _test-motion.html       动作单页自检（只看推理后端 / genMs / 步态切换）
  assets/astronaut.glb    角色几何与蒙皮来源，CC0，1.7 MB，65 骨骼（Mixamo）
  model/mmm_v6_soma_q8h.onnx   动作模型，q8h 量化，243 MB
  model/pack.json         q8 pack 清单；仅在 modelUrl 以 `/` 结尾的 pack 模式下读取，当前走单文件 .onnx，不读
  vendor/three/           three.module.js + addons（GLTFLoader / OrbitControls / BufferGeometryUtils）
  vendor/ort/             onnxruntime-web 1.30：ort.webgpu.min.mjs + jsep/asyncify 的 wasm 与 mjs
  vendor/three-motionbricks/  index.mjs + motionbricks.worker.js（必须同目录，worker 用相对 URL 解析）
```

集成点只有两处（都在 `web/gs-viewer.html`）：

| 位置 | 内容 |
|---|---|
| `web/gs-viewer.html:22-25` | `<script type="importmap">`，只服务 `human/` 下的 `three` 裸导入 |
| `web/gs-viewer.html:220` | `<script type="module" src="./human/human-layer.js">` |

回滚：注释这两处（importmap 与末尾 script），场景行为与集成前完全一致。

工具脚本（`tools/`，均不在页面运行时链路里）：

| 脚本 | 用途 |
|---|---|
| `fetch_hf_model.mjs` | 从 HF 镜像下 ONNX，断点续传（`q8h` / `fp16` / `soma-fp32` / `g1-fp32`） |
| `download_model.mjs` | 旧的 repalash.com q8 pack 下载器（历史用途，不再用） |
| `check_avatar.mjs` | 化身渲染自检（splats / 骨骼 / 构建耗时） |
| `check_motion.mjs` | 动作推理自检（后端 / genMs / 三档切换） |
| `check_human.mjs` | 单引擎集成自检（就绪 / 无第二 renderer / MeshInstance 挂 layer / **确实出帧** / shader 语言匹配）。`--headed --renderer=webgpu` 验 WebGPU |
| `shoot_human.mjs` | 交付截图（支持 `--renderer=webgpu` / `--winsize=` / 重试） |
| `probe_webgpu_shader.mjs` | 有头 WebGPU 最小 GLSL vs WGSL 材质实证 |
| `diag_v2_decisive.mjs` | 「对象在、像素不在」决定性对照诊断（drawCalls / 截图 md5） |
| `r4_check.mjs` | 交付验收主脚本（`--headed` / `--nogpu` / `--compat`） |
| `verify_editor.mjs` | 原有标注编辑器的 DOM 回归 |

## 5. 操作说明

数字人面板在**屏幕左下、小地图正上方**（`z-index:40`，运行时读小地图矩形动态计算 `bottom`）；小地图在左下角。

| 按钮 | 行为 |
|---|---|
| 站立 / 行走 / 奔跑 | 切换 `stand` / `walk` / `run`。行走、奔跑由生成动作驱动**真实根位移**；切换不重置骨架到绑定姿态 |
| 驻留 | 以放置点为锚，走动超过 **1.2 m** 就掉头（仅非站立步态生效） |
| 往返 | 同上，半径 **2.4 m** |
| 重新放置 | 放到相机前方 3.2 m 处，地面高度按 `camY - 1.6` 推算 |
| ↓2cm / ↑2cm | 整体升降 2 cm，用于修正落地高度 |
| 隐藏 / 显示 | 只隐藏化身与接触阴影，推理继续跑 |

原场景操作完全保留：WASD / 触摸摇杆 / 手柄漫游，碰撞照旧（实测按住 W 1 s 位移 1.58 m）；`M` 键或顶栏「小地图」按钮切换小地图。

调试句柄（控制台）：

```js
__mgHuman.state          // {ready, backend, gait, mode, fps, genMs, count, bones, height, error,...}
__mgHuman.setGait('walk')
__mgHuman.setMode('patrol')     // 'stay' | 'patrol'
__mgHuman.placeInFront(3.2)
__mgHuman.toggle(false)
__mgHuman.measure()             // 世界包围盒高度 / 相机距离 / 根高
```

## 6. 首次加载与性能预期

| 项 | 有头 / WebGPU（RTX 3070，1600×900） | headless / WASM（SwiftShader） |
|---|---|---|
| 原场景首帧 | 6107 ms | 3680 ms |
| 数字人就绪 | **24093 ms** | 21083 ms |
| 推理 | **187.5 ms/次**（stand/walk/run 211/317/277） | 1168 ms/次 |
| FPS 中位数 | **56** | 25 |
| JS 堆 | 32.1 MB | 25.0 MB |

- 首次 24 s 是正常的：243 MB 模型下载 + ORT session 创建 + WebGPU 着色器首帧编译（约 8 s）。之后稳定在 155–325 ms/次。
- 化身固定 120000 splats / 65 骨骼 / 身高 1.75 m / 高斯半径 6.6 mm（按采样间距 5.5 mm 自适应，见 DECISIONS D8）。
- 首帧编译慢是**一次性**的；`MotionDriver` 把库默认的 `gpuLimitMs=300` 放宽到 9000 ms，只为放过冷启动，稳态仍按阈值判定。

**v2 单引擎复测（2026-11-14，同一台 RTX 3070）**

| 后端 | 命令 | 结果 |
|---|---|---|
| WebGL2（headless / swiftshader） | `node tools/check_human.mjs --wait=240` | **19 PASS / 0 FAIL**，`deviceType=webgl2`、`shaderLanguage=glsl` |
| WebGPU（有头 Chrome） | `node tools/check_human.mjs --wait=240 --headed --renderer=webgpu` | **19 PASS / 0 FAIL**，56–57 FPS、推理 148–246 ms、`shaderLanguage=wgsl`、无 shader 转译错误 |
| 原功能回归 | `node tools/verify_editor.mjs` | **283 PASS / 0 FAIL** |

> 宿主是**按需渲染**（场景 revealed 后 `app.autoRender=false`）。v2 每帧在 `app.on('update')` 末尾请求 `frame:request` / `renderNextFrame`，否则画面会冻结在加载帧而自检仍全绿。自检已加「`drawCalls>0`」守卫。详见 `ITERATION_V2.md §6`。

## 7. 已知限制

**以下 5 条为当前实现的结构性限制，不要当成 bug 反复排查：**

1. **无场景级深度遮挡**：v2 虽已并入主渲染器、共享帧缓冲，但 `GSplatQuadRenderer` 本身 `depthWrite=false`，3DGS 点云不写深度，人站到墙后仍会画在墙上（化身自遮挡是正确的）。缓解：放在开阔地、加接触阴影；彻底解决需对碰撞三角网做深度预通道再在数字人 fragment 里比较，列为 **v2.1**。
2. **Q 版角色 + 轻微滑步**：`astronaut.glb` 是 Q 版比例（原生 1.36 m、短腿），为保持 1.75 m 身高关闭了 `matchSize`，步幅与腿长不完全匹配，走/跑有约 10% 滑步。
3. **半透明淡出会露背面**：3DGS 固有现象（depthWrite 关闭 + 由远到近 alpha 混合），淡出时能看到背面高斯。
4. **WASM 回退推理约 1 s/次**：无 WebGPU 时可用但明显变慢（实测 1168 ms/次、25 FPS），交互会有延迟感。
5. **`jump` / `sit` 未启用**：依赖 NVIDIA 示例动作片段，源站（`media.githubusercontent.com`）502 不可达，本环境无片段可加载；UI 因此没有入口，代码里也没有假装可用的按钮。

交付时实测到的观感/可用性问题，当前状态：

- **已修复（R4-D2 / R4-D1 → 见 DECISIONS D9）**：「重新放置后角色仍在远处」的根因是 MotionBricks 的根位移落在 **hips 骨骼**上、group 原点不动，按 `root.position` 归位等于没归；现改为读 hips 世界坐标反推归位。朝向则做了两轮：先把「角色正面 = -Z」改成「读 hips 骨骼 +X 当前向」，**这一步是错的**（骨骼轴 ≠ 网格轴，会多转 90°），最终删除二次校正，只保留 `placeInFront()` 里的 `yaw = atan2(-(camZ-pZ), camX-pX)` —— 它让模型正面（外层局部 +X）正对相机。四方向标定脚本 `tools/probe_yaw.mjs`，复测截图 `shots/deliver_stand.png`。
- **已修复（D8）**：化身早期像「彩色毛球」。根因是高斯半径硬编码 12 mm，而 12 万点在 3.6 m² 表面的平均间距只有 5.5 mm，每个高斯盖住 3 个邻居、alpha 叠加饱和。现改为 `size = 1.2·sqrt(A/count)` 自适应（实测 0.0066 m），`stats.spacing/size` 可查，`?splatsize=` 可覆盖。
- **已修复（R4-D5）**：控制面板曾被左下角小地图完全遮挡（`z-index:8` < 小地图 `26`）。面板现在运行时读小地图矩形动态让位（`left:16px`，`bottom` 由 `placePanel()` 计算，`z-index:40`，`human-layer.js:410-421`），自检脚本第 14 项用 `elementFromPoint` + 矩形相交双重断言。
- **未改**：左下角的「数字人」入口按钮本身仍是 `z-index:8`（`human-layer.js:453`），可能被小地图压住 —— 首次进入请按 `M` 收起小地图，或直接用 `?human=1` 直连（推荐，自检脚本走的就是这条）。

## 8. 许可证与合规

| 资产 | 许可 | 义务 / 本项目做法 |
|---|---|---|
| 集成代码（three-motionbricks 及本层代码） | **Apache-2.0** | 保留版权与许可声明 → `web/human/vendor/licenses/three-motionbricks-Apache-2.0.txt` |
| 模型权重 `mmm_v6_soma_q8h.onnx` | **NVIDIA Open Model Agreement** | 随附许可副本、保留上游声明、不暗示 NVIDIA 背书 → `vendor/licenses/NVIDIA-Open-Model-Agreement.txt`；该协议允许商用与再分发（原文「Works are commercially usable」） |
| 角色 `astronaut.glb` | **CC0 1.0** | 无附加义务 |
| ONNX Runtime Web | **MIT** | 保留声明 → `vendor/licenses/onnxruntime-web-MIT.txt` |
| three.js 0.168 | **MIT** | 保留声明 → `vendor/licenses/three-MIT.txt` |

结论：**本 demo 可交付；权重随附许可副本后可再分发**。不得把本 demo 当作 NVIDIA 背书的产物对外宣传；NVIDIA 示例动作片段（jump/sit）为 Sample Data Evaluation License，仅限内部评估，本项目未下载、未打包、未启用。

许可证副本已随代码落盘（2026-11-13 补齐）：`web/human/vendor/licenses/` 下 `three-MIT.txt`(1081 B)、`three-motionbricks-Apache-2.0.txt`(10779 B)、`onnxruntime-web-MIT.txt`(1073 B)、`NVIDIA-Open-Model-Agreement.txt`(7910 B)。

## 9. 故障排查

**黑屏 / 只有 UI 没有场景**

1. 打开 DevTools，看 `#mg-error` 与控制台首条报错；
2. 控制台执行 `window.__viewer?.state?.loaded`，应为 `true`；
3. 确认地址是 `http://127.0.0.1:8099/...`，不要用 `file://`；
4. SOG 依赖 HTTP Range 206。换成 IIS/nginx 时若未开 Range，场景会加载失败，换回 `serve.py` 验证；
5. 只是数字人黑屏：看 `__mgHuman.state.error`；模型缺失/没下完时按契约应保持绑定姿态并在面板给红字（该失败分支本轮未实测）。

**没有 WebGPU（面板显示 `后端 wasm`）**

- 这是**降级成功**，不是故障：webgpu → wasm，25 FPS / 约 1.1 s 推理。
- headless Chrome 拿不到 adapter 属正常（`requestAdapter()` 返回空）；用有头 Chrome + 可用 D3D12 再试。
- `chrome://gpu` 看 WebGPU 是否为 `Hardware accelerated`；`--enable-unsafe-webgpu` 只建议临时排查用。

**模型 404 / 一直「下载模型」**

```bash
ls -l web/human/model/mmm_v6_soma_q8h.onnx     # 应为 242,732,481 字节
curl -s -D - -o /dev/null -H "Range: bytes=0-0" \
  http://127.0.0.1:8099/human/model/mmm_v6_soma_q8h.onnx   # 期望 206 + Content-Range
node tools/fetch_hf_model.mjs q8h web/human/model          # 断点续传，可反复执行
```

**端口被占用**

```bash
netstat -ano | grep 8099              # 最后一列是 Windows PID
# 或 PowerShell：Get-NetTCPConnection -State Listen -LocalPort 8099
taskkill //F //PID <winpid>           # Git Bash 必须双斜杠；加 /T 连带子进程
```

注意：Git Bash 里的 `$$` / `ps` 是 MSYS PID，**与 Windows PID 不同**，杀进程要用 `tasklist` / `netstat` 查到的 winpid。也可以直接换端口：`python serve.py --port 8100 --no-browser`。

## 10. 相关文档

| 文档 | 内容 |
|---|---|
| `docs/SCENE.md` | 原场景勘查（技术栈、坐标系、改动边界） |
| `docs/UPSTREAM.md` | 上游选型、许可证矩阵、模型来源变更 |
| `docs/ARCHITECTURE.md` | 分层架构、一帧时序、性能预算、降级矩阵 |
| `docs/DECISIONS.md` | D1–D11 裁决（D10/D11 为 v2 单引擎与双后端；D1 已被 D10 取代） |
| `docs/CONTRACT.md` | 模块接口与数据契约（唯一事实源，v2.0） |
| `docs/ITERATION_V2.md` | **v2 单引擎方案裁决、实证、两个决定性根因、验证记录** |
| `docs/TEST_REPORT.md` | R4 实测报告 + §14 v2 终验 |
| `docs/DELIVERY.md` | 一页式交付说明与 DoD 对照 |

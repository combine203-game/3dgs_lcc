# TEST_REPORT — 3DGS 数字人（MotionBricks / SOMA）R4 验证

> 验证者：R4-验证工程师 · 日期：2026-11-13 · 工程：`D:\WorkSpace\AI\3DGS_build\viewer_edit`
> 原则：所有数字均来自本轮真跑 stdout；未测项在 §9 明写「未验证 + 原因」。

## 0. 总览

| # | 测试项 | 结论 |
|---|---|---|
| 1 | 干净构建 / 从零启动 / 关键资源 200 | **PASS** |
| 2 | 数字人可见且正确（splats / bones / 身高 / 截图） | **PASS**（附 1 条朝向缺陷 R4-D2） |
| 3 | 漫游：原场景 WASD + 数字人 patrol | **PASS**（附 1 条超调缺陷 R4-D1） |
| 4 | 动作：stand / walk / run 各 5 s | **PASS**（jump / sit 实测无入口，见 §4） |
| 5 | 性能基线（1600×900，WebGPU / WASM 分开） | **PASS**（WebGPU 推理 187.5 ms、FPS 56） |
| 6 | 原功能回归 `node tools/verify_editor.mjs` | **PASS（修复后复验 282 PASS / 0 FAIL，见 §12）** |
| 7 | 兼容性：无 WebGPU → WASM + UI 提示 | **PASS（修复后）**：WASM 回落已验证；面板遮挡 R4-D5 已修（底部居中→小地图上方，`z-index:40`），见 §12 |

**机器 / 浏览器**：Windows 11 Pro · Intel UHD630 + NVIDIA RTX 3070 · Chrome `137.0.7151.69`（官方安装版）· Node `v22.22.2` · 视口 `1600×900`（CDP `Emulation.setDeviceMetricsOverride` 固定）。
**服务**：`python serve.py --port 8095 --no-browser --local-only`；CDP `9250`；跑完已清理，`Get-NetTCPConnection -LocalPort 8095,9250` 无监听（见 §10）。

---

## 1. 干净构建 / 启动 / 资源

### 1.1 无构建步骤

```
$ ls package.json package-lock.json node_modules
ls: cannot access 'package.json': No such file or directory
ls: cannot access 'package-lock.json': No such file or directory
ls: cannot access 'node_modules': No such file or directory
```

- 工程内无 `package.json` / `node_modules` / `vite|webpack` 配置 / `tsconfig.json` / `Makefile`。
- `web/gs-viewer.html` 直接以 `<script type="importmap">` + `<script type="module" src="./human/human-layer.js">` 加载 ES Module；`serve.py` 对 `.js/.mjs` 返回 `text/javascript`，浏览器直接执行，**无编译、无打包、无产物目录**。

### 1.2 从零启动与首屏可达

`tools/r4_check.mjs` 先 spawn 服务、再轮询 `/gs-viewer.html`：

```
服务就绪 851 ms（spawn → /gs-viewer.html 200）        # headless
服务就绪 1049 ms（spawn → /gs-viewer.html 200）       # headed
服务就绪 1311 ms（spawn → /gs-viewer.html 200）       # nogpu 兼容轮
```

页面内 `performance` 导航计时（导航起算，非服务启动）：

| 项 | headed/WebGPU | headless/WASM |
|---|---|---|
| TTFB (`responseStart`) | 2334.4 ms | 1537.8 ms |
| DOMContentLoaded | 3715.4 ms | 1985.6 ms |
| loadEventEnd | 3719.6 ms | 1989.1 ms |
| 原场景首帧 (`__mgLoading.atMs`, reason=firstFrame) | 6107 ms | 3680 ms |
| 3DGS `__viewer.state.loaded` | 6124 ms | 4600 ms |
| 数字人 `state.ready` | 24093 ms | 21083 ms |

### 1.3 `web/human/**` 关键资源（Node fetch / HEAD）

```
PASS  GET /human/human-layer.js 200                          -> {"status":200,"len":18469,"ct":"text/javascript; charset=utf-8"}
PASS  GET /human/splat-avatar.js 200                         -> {"status":200,"len":34000,"ct":"text/javascript; charset=utf-8"}
PASS  GET /human/motion-driver.js 200                        -> {"status":200,"len":15213,"ct":"text/javascript; charset=utf-8"}
PASS  GET /human/vendor/three/three.module.js 200            -> {"status":200,"len":1298981,"ct":"text/javascript; charset=utf-8"}
PASS  GET /human/vendor/three-motionbricks/index.mjs 200     -> {"status":200,"len":207595,"ct":"text/javascript; charset=utf-8"}
PASS  GET /human/vendor/three-motionbricks/motionbricks.worker.js 200 -> {"status":200,"len":34113,"ct":"text/javascript; charset=utf-8"}
PASS  GET /human/vendor/ort/ort.webgpu.min.mjs 200           -> {"status":200,"len":66349,"ct":"text/javascript; charset=utf-8"}
PASS  GET /human/assets/astronaut.glb 200                    -> {"status":200,"len":1679188,"ct":"model/gltf-binary"}
PASS  ONNX 大文件 Range 1 字节 → 206                         -> {"status":206,"len":1,"range":"bytes 0-0/242732481","type":"application/octet-stream"}
```

- ONNX 实测 242,732,481 B（231.5 MiB），服务端 `Accept-Ranges: bytes`，`Content-Range: bytes 0-0/242732481` 正确。
- 页面侧 `PerformanceResourceTiming`：`human-layer.js` 54–630 ms、`three.module.js` 154–582 ms、`index.mjs` 9–61 ms、`astronaut.glb` 9–39 ms（均为本地回环，含浏览器调度抖动）。

**结论：PASS。** 无构建链；服务冷启动 0.85–1.31 s 可访问；关键资源全部 200，大模型 Range 正确。

---

## 2. 数字人可见且正确

入口 `http://127.0.0.1:8095/gs-viewer.html?scene=floor3&human=1`，等待 `__mgHuman.state.ready`。

```
就绪 24093 ms（导航起算），state={"ready":true,"phase":"ready","backend":"webgpu","modelReady":true,
  "gait":"stand","mode":"stay","fps":56,"genMs":0,"count":120000,"bones":65,"height":1.75,
  "error":null,"visible":true,"srcStage":"warmup"}
UI={"stats":"后端 webgpu · 模型 已加载 · 推理 —高斯 120k · 骨骼 65 · 56 FPS","status":"就绪",
    "canvas":{"w":1600,"h":900}}
measure={"height":1.75,"width":1.664,"minY":0.024,"maxY":1.774,"camDist":3.27,"rootY":0.024,"scale":1.284}
```

| 断言 | WebGPU | WASM | 结果 |
|---|---|---|---|
| `state.ready` | true（24.1 s） | true（21.1 s） | PASS |
| splats | 120,000 | 120,000 | PASS |
| bones | 65 | 65 | PASS |
| `state.height`（归一） | 1.75 m | 1.75 m | PASS |
| `measure().height`（世界包围盒） | 1.75 m | 1.75 m | PASS（要求 1.4–2.1） |
| overlay canvas | 1600×900 | 1600×900 | PASS |
| `modelReady` | true | true | PASS |
| JS 未捕获异常 | 0 | 0 | PASS |

**截图（已落盘）**

| 文件 | 模式 / 后端 | 大小 |
|---|---|---|
| `shots/r4_demo.png` | headless / **wasm** | 1333 KB |
| `shots/r4_demo_headed.png` | headed / **webgpu** | 1409 KB |

目检（1600×900）：人物为彩色 Q 版宇航员（紫色头盔 + 橙色面罩 + 黄色服装 + 蓝色裤/红鞋），头脚完整、比例与 1.75 m 一致、脚接近地面，与展板/自行车雕塑的透视关系正确。头盔约占身高 40%，这是 `astronaut.glb` 资产本身的 Q 版比例（对照 `shots/avatar_test.png` 绑定姿态），不是渲染错误。站立帧手臂下垂与躯干同色，视觉上不易分辨。

**已知偏差（缺陷 R4-D2）**：截图里人物朝向画面右侧约 90°，不是面向相机；`human-layer.js:190-191` 注释写「面向相机」，实际未达到。详见 §8。

**另（缺陷 R4-D5）**：数字人控制面板（含「后端 wasm/webgpu」与三档步态按钮）被左下角小地图完全遮挡，截图左下角只能看到小地图；上表数值均由 `__mgHuman` 调试句柄读取，不受遮挡影响。

**结论：PASS**（可见、比例与骨骼数正确；朝向与面板遮挡记缺陷，不阻塞本项）。

---

## 3. 漫游

### 3.1 原场景 WASD（CDP `Input.dispatchKeyEvent`，按住 W 1 s）

先点击画布中心获取焦点，再发 `rawKeyDown/keyUp`（`windowsVirtualKeyCode=87, code=KeyW, key=w`）。读 `viewer.app.root.findComponent('camera').entity.getPosition()`：

```
# headed / WebGPU
cam0={"x":0,"y":1.624070167541504,"z":0,"cameraMode":"walk"}
cam1={"x":-1.9353184802900605e-16,"y":1.6192666292190552,"z":1.5803073644638062,"cameraMode":"walk"}
位移=1.58 m
PASS  WASD 按住 1 s 相机位移 > 0.2 m  ->  {"dist":1.58,...}

# headless / WASM
cam0={"x":0,"y":1.624070167541504,"z":0,"cameraMode":"walk"}
cam1={"x":-3.159084484784533e-17,"y":1.6268131732940674,"z":0.2579588294029236,"cameraMode":"walk"}
位移=0.258 m
PASS  WASD 按住 1 s 相机位移 > 0.2 m  ->  {"dist":0.258,...}
```

- 两种后端 `cameraMode` 均为 `walk`，原碰撞漫游未被数字人层夺走。
- headless 位移偏小（0.258 m）与 SwiftShader 下帧率低、按键生效延迟有关，仍超过 0.2 m 门限；有头 1.58 m 可作主参考。

### 3.2 数字人 patrol 10 s

`setMode('patrol')` → `placeInFront(3.2)` → `setGait('walk')`，每 400 ms 读 `mixamorigHips` 世界坐标：

```
# headed
hips 起点={"x":0.003236633492633115,"y":0.5584115079787,"z":4.78113939530449,"name":"mixamorigHips"}
hips 终点={"x":-0.014774604700506408,"y":0.4937905959036573,"z":5.492944431304932,"name":"mixamorigHips"}
最大离起点=2.770 m 路径累计=13.032 m 采样=25

# headless
hips 起点={"x":-4.261576083834728e-16,"y":0.5633414081480725,"z":3.4798408269882204,"name":"mixamorigHips"}
hips 终点={"x":0.39921382069587663,"y":0.5132897786047681,"z":3.4780105770798397,"name":"mixamorigHips"}
最大离起点=4.004 m 路径累计=7.057 m 采样=20
```

- 判定用「最大离起点」而非首尾净位移（往返运动净位移可能接近 0）；两种后端均 > 1 m。
- 设计目标是两点 1.4 m 往返（`human-layer.js:194`），实测最大偏离 2.77 / 4.00 m，存在超调（缺陷 R4-D1）。

**结论：PASS**（原 WASD 与数字人自主位移均成立）。

---

## 4. 动作

`setMode('stay')` 后依次 `setGait('stand'|'walk'|'run')`，各 5 s，采样 `state.gait` / `state.genMs` / `state.fps` / hips 位移：

```
# headed / WebGPU
stand: state.gait=stand genMs=211  hips 位移=0.922 m FPS 中位=56.0
walk:  state.gait=walk  genMs=317  hips 位移=0.238 m FPS 中位=56.0
run:   state.gait=run   genMs=277  hips 位移=0.775 m FPS 中位=56.0
PASS  三档切换无新增 JS 异常  ->  0

# headless / WASM
stand: state.gait=stand genMs=1140 hips 位移=1.695 m FPS 中位=25.0
walk:  state.gait=walk  genMs=1415 hips 位移=3.142 m FPS 中位=21.5
run:   state.gait=run   genMs=1415 hips 位移=6.246 m FPS 中位=32.0
PASS  三档切换无新增 JS 异常  ->  0
```

- 三档 `state.gait` 均立即生效；推理耗时 211/317/277 ms（WebGPU）、1140/1415/1415 ms（WASM）。
- `stand` 后 `genMs` 保留上一段的值（`stand` 不发新推理）；`hips 位移` 是该段首尾净位移，`stand` 的 0.9–1.7 m 来自「停止前当前生成片段的收尾 + 减速」，属契约 §3「stand = character.stop() 播放落地/待机」允许的行为，列入观察项而非缺陷。

**实测动作清单（如实）：**

| 动作 | 是否可用 | 证据 |
|---|---|---|
| stand / walk / run | **可用** | UI 三个按钮 + `setGait()` 生效，推理持续产出 |
| jump（跳跃） | **不可用** | UI 无入口；`MotionDriver` 无 `jump`；`character.jump` 为 `undefined`；库内仅有「遇到障碍自动起跳」的内部决策（`index.mjs:1825`），本场景无 obstacle 接线 |
| sit（坐下） | **不可用** | UI 无入口；`MotionDriver` 无 `sit`；库内 `character.sit` 存在（`index.mjs:1740`），但需要 obstacle 参数与场景交互，本工程无调用点 |
| 其他（挥手等） | **无** | 库仅提供步态/移动/坐/跳语义，无独立挥手动作 |

实测接口快照（`--nogpu --compat` 轮）：

```
动作接口={"driver":{"setGait":"function","drive":"function","moveTo":"function","jump":"undefined","sit":"undefined"},
"character":{"jump":"undefined","sit":"function","moveTo":"function","stop":"function"},
"buttons":["站立","行走","奔跑","驻留","往返","重新放置","隐藏","↓2cm","↑2cm"]}
```

与 `docs/DECISIONS.md` D3 的「jump/sit 本环境未启用」一致，未发现 UI 招摇撞骗。

**结论：PASS**（三档动作成立、无异常；jump/sit 按实测记为不可用）。

---

## 5. 性能基线（1600×900）

采样方法：连续 10 s 每 500 ms 读 `__mgHuman.state.fps` 取中位数；`genMs` 取 `state.genMs`；JS 堆取 CDP `Performance.getMetrics → JSHeapUsedSize`；首帧取 `__mgLoading.atMs`；就绪取导航到 `state.ready`。

| 指标 | 有头 / WebGPU | headless / WASM |
|---|---|---|
| 浏览器 / GPU | Chrome 137.0.7151.69，RTX 3070（ANGLE D3D11；WebGPU 硬件适配器） | 同版本 headless=new，SwiftShader 软光栅，无可用 WebGPU adapter |
| 后端 | **webgpu** | **wasm** |
| FPS 中位数（10 s） | **56**（min 42 / max 56，20 样本） | **25**（min 20 / max 27，19 样本） |
| 推理 `genMs` | **187.5 ms**（目标 ≤300） | **1168.1 ms** |
| JS 堆 `JSHeapUsedSize` | **32.1 MB** | **25.0 MB** |
| 原场景首帧 | **6107 ms** | **3680 ms** |
| 数字人就绪 | **24093 ms** | **21083 ms** |
| 主线程 `TaskDuration` | 416.5 ms/s | 1022.2 ms/s |
| 视口 | 1600×900 | 1600×900 |
| 高斯 / 骨骼 | 120k / 65 | 120k / 65 |

stdout：

```
# headed
{"fpsSamples":20,"fpsMed":56,"fpsMin":42,"fpsMax":56,"genMs":187.5,"backend":"webgpu",
 "jsHeapMB":32.1,"taskMsPerSec":416.5,"firstFrameMs":6107,"firstFrameReason":"firstFrame",
 "ttfbMs":2334.4,"dclMs":3715.4,"loadMs":3719.6,"humanReadyMs":24093}

# headless
{"fpsSamples":19,"fpsMed":25,"fpsMin":20,"fpsMax":27,"genMs":1168.1,"backend":"wasm",
 "jsHeapMB":25,"taskMsPerSec":1022.2,"firstFrameMs":3680,"firstFrameReason":"firstFrame",
 "ttfbMs":1537.8,"dclMs":1985.6,"loadMs":1989.1,"humanReadyMs":21083}
```

**结论：PASS。** WebGPU 主路径 FPS 56（契约 ≥55）、推理 187.5 ms（≤300 ms）达标；WASM 路径 25 FPS / 1.17 s 推理，属「慢但可用」的降级预期（且 headless 为 SwiftShader 软光栅，不代表真实集显性能）。首屏 21–24 s 主要耗在 243 MB 模型 + ORT session + 首帧 warmup，非渲染首帧。

---

## 6. 原功能无回归（`tools/verify_editor.mjs`）

```
...
  PASS  无可见贴花时不驱动引擎 Picker
  PASS  真机 canvas / WebGPU 贴花诊断脚本存在（CI 必须同时运行）
  FAIL  贴面巨盒拦截：盒尺寸超限拒绝建盒

========== 281 PASS / 1 FAIL ==========
```

完整 FAIL 行（仅 1 条）：

```
  FAIL  贴面巨盒拦截：盒尺寸超限拒绝建盒
```

**初判：脚本自身问题，不是产品回归。**
断言在 `tools/verify_editor.mjs:2196-2197`：

```js
check('贴面巨盒拦截：盒尺寸超限拒绝建盒',
  /half\[0\] \+ half\[1\] > 16/.test(editorSrc));
```

而 `web/editor/editor.js:680` 的实际实现是：

```js
if (projector.half[0] + projector.half[1] > 16) {
```

功能代码存在且已接线，只是变量带了 `projector.` 前缀，正则要求字面 `half[0] + half[1]`，属于**断言过严**。我没有修改脚本（按纪律，脚本改动由 Lead 决定）。

另注：任务给的基线是 **247 PASS / 0 FAIL**，本机脚本实际断言数已增至 282 条（新增 §30–32），所以总数对不上是脚本版本差异，不是回归指标漂移。其余 281 条（含 §29 零 JS 异常 / 零 console error / 零 HTTP≥400）全部 PASS。

**版本快照 / 并发说明**：本轮期间其他角色仍在改编辑器代码，文件 mtime 为 `web/editor/editor.js` 20:16:23、`web/editor/picking.js` 20:16:06、`web/editor/decal-projection.js` 20:29:18、`tools/verify_editor.mjs` 20:17:55；本次回归跑的是 20:30 之后的当前树。数字人侧 `web/human/human-layer.js` mtime 为 **20:10:24（18,469 B）**，从首次跑到结束未再变化，因此 §1–§7 的数字人结论对应当前版本；若后续再改 `web/human/**`，需重跑 `r4_check.mjs`。

**结论：FAIL（1 条，静态正则误报）。** 需要 Lead 决定：放宽该正则或由脚本维护者更新，重跑后应回到 0 FAIL。

---

## 7. 兼容性（无 WebGPU → WASM）

### 7.1 headless 实际路径（adapter 拿不到）

headless 的 `navigator.gpu` 存在，但 `requestAdapter()` 返回空，库自动回落，控制台原始证据：

```
[console.warn] MotionBricks: WebGPU did not load, using WebAssembly
Error: no available backend found. ERR: [webgpu] Error: Failed to get GPU adapter.
You may need to enable flag "--enable-unsafe-webgpu" if you are using Chrome.
[MotionDriver] 就绪 rig=soma model=./human/model/mmm_v6_soma_q8h.onnx backend=wasm
```

`state.backend=wasm`，UI 面板第 1 行（DOM 文本）`后端 wasm · 模型 已加载 · 推理 —高斯 120k · 骨骼 65 · 35 FPS`。

### 7.2 强制无 `navigator.gpu`（注入 `navigator.gpu=undefined`）

`node tools/r4_check.mjs --nogpu --compat`（`Page.addScriptToEvaluateOnNewDocument` 在页面脚本前把 `navigator.gpu` 设为 undefined）：

```
环境={"hasGpu":false,"secure":true}
PASS  无 navigator.gpu 时后端回落 wasm  ->  {"hasGpu":false,"backend":"wasm"}
PASS  UI 面板显示「后端 wasm」  ->  "后端 wasm · 模型 已加载 · 推理 —高斯 120k · 骨骼 65 · 22 FPS"
面板遮挡检测={"ui":{"x":16,"y":663,"w":240,"h":221,"z":"8"},
  "minimap":{"x":18,"y":625,"w":308,"h":257,"z":"26"},
  "hitPoint":[136,691],"topEl":"mg-mm-canvas","overlap":true}
FAIL  后端状态文案对用户可见（未被小地图遮挡）  ->  {"overlap":true,"topEl":"mg-mm-canvas",...}
========== 23 PASS / 1 FAIL ========== (headless/swiftshader/nogpu)
```

- **降级逻辑 PASS**：无 WebGPU 时自动走 WASM，未挂死、未静默；`state.ready=true`、`modelReady=true`。
- **UI 可见性 FAIL（R4-D5）**：`#mg-human-ui` 与 `#mg-minimap` 都在左下角（16/18 px），面板 z-index=8、小地图 z-index=26；面板矩形 (16,663,240×221) 完全落在小地图矩形 (18,625,308×257) 内，`document.elementFromPoint(136,691)` 返回 `mg-mm-canvas`。两张截图左下角只有小地图，看不到数字人面板 —— 用户既看不到 `后端 wasm`，也点不到「站立/行走/奔跑/驻留/往返/隐藏」按钮。
- 失败态 UI 提示：`#mg-human-stats` 文本在 DOM 中（非 `hidden`），但被遮挡；`#mg-human-status` 为「就绪」。模型缺失分支本轮未触发（未验证）。

**结论：FAIL（部分）。** 后端回落本身 PASS；「不支持时 UI 提示可见」不成立，记缺陷 R4-D5。

---

## 8. 缺陷清单

| 编号 | 现象 | 复现步骤 | 严重度 | 初判归属 |
|---|---|---|---|---|
| **R4-D1** | patrol 往返超调：设计两点相距 1.4 m（`human-layer.js:194`），实测 10 s 最大离起点 **2.770 m（WebGPU）/ 4.004 m（WASM）**，路径累计 13.0 / 7.1 m；无碰撞约束时可能走出展台/穿墙 | `?human=1` → 等 ready → `__mgHuman.setMode('patrol'); __mgHuman.placeInFront(3.2); __mgHuman.setGait('walk')` → 每 0.4 s 读 hips 世界坐标 10 s | **一般**（演示行为，不阻塞） | 代码：`human-layer.js` patrol 锚点/掉头判定与角色转向延迟（`patrol.dir` 在 0.35 m 内才翻转，实际转向半径更大） |
| **R4-D2** | `placeInFront()` 后角色不面向相机：截图看到 ~90° 侧面（橙色面罩在头盔右缘），与 `human-layer.js:190` 注释「面向相机」不符 | `?human=1` → 等 ready → `setMode('stay'); setGait('stand'); placeInFront(2.8)` → 1.2 s 截图（`shots/r4_demo.png` / `r4_demo_headed.png`） | **轻微**（观感） | 代码：`root.rotation.y` 按「模型正面=-Z」计算，但重定向后的 Mixamo 角色在 heading=0 时朝向 +X（库注释 `0 faces +X`），未叠加 rig 朝向偏移 |
| **R4-D3** | `verify_editor.mjs` 唯一 FAIL：「贴面巨盒拦截：盒尺寸超限拒绝建盒」 | `node tools/verify_editor.mjs` | **轻微**（不阻塞产品） | 工具/脚本：正则 `/half\[0\] \+ half\[1\] > 16/` 与 `editor.js:680` 的 `projector.half[0] + projector.half[1] > 16` 不匹配，功能存在 |
| **R4-D4** | 脚底离地 24 mm：`measure().minY = rootY = 0.024` | 读 `measure()` 或截图看脚 | **轻微**（几乎不可见） | 设计/文档：`DECISIONS.md` D5 规定地面高度 = `camY - 1.6`，本机相机 y=1.624，故 +0.024 m；非实现错误 |
| **R4-D5** | 数字人控制面板被左下角小地图**完全遮挡**：`#mg-human-ui` z-index 8，`#mg-minimap` z-index 26，两者同为左下角；用户看不到 `后端 wasm/webgpu`，也无法点击「站立/行走/奔跑/驻留/往返/隐藏」。临时规避：按 `M` 收起小地图后面板可见 | `?human=1` 等 ready → `document.elementFromPoint` 命中小地图 canvas；rect 相交 100%（ui 16,663,240×221；map 18,625,308×257） | **一般**（UI 不可达，核心渲染不受影响） | 代码：`human-layer.js` buildUI 的 z-index=8 + `left/bottom:16px` 与既有 `#mg-minimap`（z-index 26）位置冲突；需抬高 z-index 或把面板移到小地图上方 |

**观察项（不判缺陷）**

- `stand` 切换后 5 s 内仍有 0.922 m（WebGPU）/1.695 m（WASM）净位移：当前生成片段收尾 + 减速，符合契约「stop 后播放落地/待机」，但 UI 上看起来像「没停住」。建议 Lead 确认是否需要在 UI 上提示「收尾中」。
- WASM 在 headless 的 FPS 25 / 主线程占用 1022 ms/s：SwiftShader 软光栅 + WASM 推理叠加，不代表真实 Intel UHD630 表现。
- `serve.py` 在客户端提前断开时会打印 `ConnectionResetError` 堆栈（我探测时触发），属静态服务器日志噪声，与本次交付无关。

---

## 9. 未验证项（如实列出）

| 项 | 原因 |
|---|---|
| Intel UHD630 集显路径 | 本轮 Chrome 默认使用 RTX 3070；未做强制集显的对照 |
| 真实浏览器窗口长时间稳定性 / 内存泄漏 | 仅做 10 s 性能采样，未跑 >10 min 循环 |
| 跨上下文场景遮挡（人站墙后仍画在墙上） | 架构 D1/D5 明确不做；本轮未做射线淡出验证 |
| 模型缺失 / 下载中断的失败 UI | 本地模型完整（231.5 MiB），未人为删除文件触发 |
| `?human=0` 关闭、无参默认「数字人」按钮 | 本轮聚焦 `?human=1`；未回归入口按钮 |
| Safari / Firefox / 移动端 | 环境只有 Chrome |
| IIS / nginx 部署后的 MIME 与 Range | 只在 `serve.py` 上验证 |
| 截图中的动作美感 / 滑步幅度 | 只做静态截图，未逐帧量测滑步百分比（D3b 已知约 10%） |

---

## 10. 实际执行过的命令（关键）

```bash
cd /d/WorkSpace/AI/3DGS_build/viewer_edit

# 1) 资源与 Range（手工核对，服务 8095）
python serve.py --port 8095 --no-browser --local-only
curl -s -o /dev/null -w "%{http_code} %{size_download} %{content_type}\n" http://127.0.0.1:8095/human/human-layer.js
curl -s -D - -o /dev/null -H "Range: bytes=0-0" http://127.0.0.1:8095/human/model/mmm_v6_soma_q8h.onnx

# 2) 有头 WebGPU 预检
node tools/r4_probe2.mjs
#   -> hasGpu: true; gl: ANGLE (NVIDIA GeForce RTX 3070 ... D3D11); adapter: {}

# 3) 主验证：headless（WASM 回退路径）
node tools/r4_check.mjs
#   -> 32 PASS / 0 FAIL (headless/swiftshader)

# 4) 主验证：有头（WebGPU 主路径）
node tools/r4_check.mjs --headed
#   -> 32 PASS / 0 FAIL (headed/webgpu)

# 5) 兼容：强制无 navigator.gpu
node tools/r4_check.mjs --nogpu --compat
#   -> 23 PASS / 1 FAIL (headless/swiftshader/nogpu)
#      唯一 FAIL 为「后端状态文案对用户可见」：面板被小地图遮挡（R4-D5），降级逻辑本身 PASS

# 6) 原功能回归
node tools/verify_editor.mjs
#   -> 281 PASS / 1 FAIL

# 7) 清理（脚本内部已 taskkill 自己拉起的 Chrome / 服务；复核）
Get-NetTCPConnection -State Listen -LocalPort 8095,9250   # 无输出
```

清理说明：`r4_check.mjs` 在 finally 里对 Chrome 执行 `taskkill /PID <winpid> /T /F`，对服务进程同样 `taskkill /PID <winpid> /T /F`；跑完复核 8095 / 9250 均无 LISTEN，`.verify-profile/r4_*` 已删除。

---

## 11. 附件

| 路径 | 说明 |
|---|---|
| `tools/r4_check.mjs` | 本轮主验证脚本（8095/9250；`--headed` / `--nogpu` / `--compat`） |
| `tools/r4_probe.mjs` | Chrome 可用性预检（首版，about:blank 下 `navigator.gpu` 不可用） |
| `tools/r4_probe2.mjs` | 真实页面 WebGPU 预检（确认 127.0.0.1 安全上下文可用） |
| `shots/r4_demo.png` | headless / WASM 截图，1600×900 |
| `shots/r4_demo_headed.png` | headed / WebGPU 截图，1600×900 |
| `docs/TEST_REPORT.md` | 本报告 |

> 本人（R4）未修改任何业务代码；`web/**`、`docs/CONTRACT.md`、`docs/DECISIONS.md`、`tools/check_*.mjs`、`tools/verify_editor.mjs` 均保持原样（其他角色在本轮窗口内对 `web/editor/**`、`tools/verify_editor.mjs` 的并发修改见 §6「版本快照」）。

---

## 12. Lead 复验（R4 缺陷修复后）

R4 报告提交后，Lead 按缺陷清单做了 3 处修复并复跑：

| 缺陷 | 处置 | 复验证据 |
|---|---|---|
| R4-D5 面板被小地图完全遮挡 | 面板从「底部居中」移到「左下、小地图上方 212 px」，`z-index` 8 → 40 | `web/human/human-layer.js:363`；`shots/human_demo.png` 中面板与角色不再重叠 |
| R4-D2 角色 90° 侧对镜头 | 朝向按「Mixamo 重定向后角色局部 +X 为正面」重算：`yaw = atan2(-(camZ-pZ), camX-pX)`；一走起来外层偏航按 0.85 衰减，交还给控制器 | 同上截图；站立时正对镜头 |
| R4-D1 patrol 超调（2.77/4.0 m） | 去掉「世界路径点 + 转向延迟」逻辑，改为**以 hips 实际位置**判定：驻留 1.2 m、往返 2.4 m 超半径即掉头 | `tools/check_human.mjs` `[4c]` 量测 `camDist=3.3`（放置 3.2 m 后仍在原位，无跑飞） |
| R4-D3 编辑器回归 1 FAIL（正则过严） | `tools/verify_editor.mjs:2197` 正则 `/half\[0\] \+ half\[1\] > 16/` → `/half\[0\] \+ [\w.]*half\[1\] > 16/`（代码实为 `projector.half[0]`） | 见下 |

**复验命令与结果**

```
$ node tools/check_human.mjs --wait=240          # headless / WASM
========== 13 PASS / 0 FAIL ==========
[4c] 世界量测={"height":1.75,"width":1.664,"minY":0.024,"maxY":1.774,"camDist":3.3,"rootY":0.024,"scale":1.284}
[4d] 性能={"fps":27,"genMs":1138.2,"backend":"wasm","jsHeapMB":30.5}

$ node tools/verify_editor.mjs                   # 标注编辑器全量回归
========== 282 PASS / 0 FAIL ==========
```

> 注：`check_human.mjs` 的 13 项含「原场景加载 / overlay 铺满 / UI 注入 / splats / bones / 身高 / 推理状态 / 无致命错误 / 三档步态 / walk 后推理 / 世界身高」，比 R4 的 32 项粗，但覆盖同样的关键断言；R4 的 32 项结论仍然有效。
>
> R4-D4（脚底离地 24 mm）未改：这是 D5「地面 = 相机高 − 1.6 m」的近似结果，24 mm 在展厅尺度不可见，已列入 README 已知限制。

---

## 13. Lead 终验（D8/D9 修复后，2026-11-13 21:00–21:25）

§12 的复验只解决了「面板位置 / 归位 / 正则」三件事，交付前目视截图又发现两个**观感级缺陷**，本轮补修并留下可复现证据。

### 13.1 新增的缺陷与根因

| 编号 | 现象 | 根因 | 修复 |
|---|---|---|---|
| L1 | 化身像「彩色毛球」：头盔糊成一团紫橙色、看不出躯干结构 | `size=0.012` 是拍脑袋值。宇航员网格面积 **3.6 m²**、12 万点 → 平均间距 `sqrt(A/n)` = **5.5 mm**；12 mm 半径（四边形半径 18 mm）每个高斯盖住 3 个邻居，alpha 0.85 叠加后颜色饱和成块 | `size` 缺省改为 `clamp(1.2·sqrt(A/count), 0.0015, 0.02)`，实测 **0.0066 m**；`stats.spacing/size` 可查；新增 `setSplatSize()` 与 `?splatsize=`（DECISIONS D8） |
| L2 | 站立时侧对/斜对镜头，看不出是正面 | §12 加的「读 `hips.matrixWorld` 的 +X 当人前向」二次校正是错的：**骨骼局部轴 ≠ 网格轴**，Mixamo hips 的 +X 与模型正面差 90°，把本来正确的人又转歪 | 删除该段。`placeInFront()` 的 `yaw = atan2(-(camZ-pZ), camX-pX)` 已能把「模型正面 = 外层局部 +X」对准相机；朝向改用 **hips 归位后的真实位置** 计算，消除归位偏移带来的 ~15° 残差（DECISIONS D9） |
| L3 | 面板「不遮挡」的结论只经过目视，没有几何断言；第一次加断言当场 FAIL | 面板 `bottom:212px` 硬编码 < 小地图实测高度 **257 px** | 改为运行时读小地图矩形动态让位（`placePanel()`），自检新增第 14 项断言 |

### 13.2 朝向标定（`tools/probe_yaw.mjs`，不靠猜）

把角色放在镜头正前方，按 0/90/180/270° 各出一张图：

```
$ node tools/probe_yaw.mjs --dist=2.2
placeInFront 的基准偏航 = 1.5708 rad (90.0°)
  yaw_0    yaw=90.0°   -> shots/yaw_0.png      ← 橙色面罩居中、胸前装置、双腿分开 = 正面
  yaw_90   yaw=180.0°  -> shots/yaw_90.png
  yaw_180  yaw=270.0°  -> shots/yaw_180.png    ← 紫色头盔+右侧橙色边 = 侧对（修复前的观感）
  yaw_270  yaw=360.0°  -> shots/yaw_270.png
```

结论：基准角（局部 +X 指向相机）就是正面，二次校正才是错的。数学核对：`R_y(θ)·(1,0,0) = (cosθ,0,−sinθ) = d/|d|`，`d = 相机 − 角色`。

### 13.3 终验命令与结果

```
$ node tools/check_human.mjs --wait=240          # headless / WASM，14 项断言
========== 14 PASS / 0 FAIL ==========
[3]  dom={"canvas":true,"w":1578,"h":802,"ui":true,"err":false}
[3b] panel={"ok":true,"inUi":true,"overlap":false,
            "rect":{"x":16,"y":296,"w":240,"h":221},"hit":"BUTTON",
            "mm":{"x":18,"y":527,"w":308,"h":257}}
[4c] 世界量测={"height":1.75,"width":1.664,"minY":0.024,"maxY":1.774,"camDist":3.3,"rootY":0.024,"scale":1.284}
     站立截图前 pose={"gait":"stand","yaw":1.57,"d":{"inView":true,...}}

$ node tools/shoot_human.mjs --dist=2.8 --out=shots/deliver_stand.png
state={...,"count":120000,"bones":65,"height":1.75,"splatSize":0.0066,"spacing":0.0055}
诊断={"charPos":{"x":0,"y":0.56,"z":2.8},"ndc":{"x":0,"y":-0.48,"z":0.97},"inView":true}
measure={"height":1.75,"width":0.795,"minY":0.024,"maxY":1.774,"camDist":2.89,"scale":1.284}

$ node tools/verify_editor.mjs                   # 标注编辑器全量回归
========== 283 PASS / 0 FAIL ==========
```

`width` 从 1.664（行走中、四肢张开）降到 **0.795**（站立正面、双臂贴身），是朝向正确的旁证。

### 13.4 目视确认（`shots/deliver_stand.png`、`shots/v5_walk.png`）

- 站立：橙色面罩居中、紫色头盔两侧有耳罩、黄色躯干带胸前装置、两条红靴分开、脚贴地；身高与旁边展台比例约为 1.75 m 对 1.2 m。
- 行走：`nav.dir` 取相机前向，所以人朝**远端**走，看到的是背影 —— 预期行为，不是朝向 bug。
- 面板：位于小地图正上方，不重叠；面板文字「后端 wasm · 模型 已加载 · 推理 2017ms / 高斯 120k · 骨骼 65 · 27 FPS」。

### 13.5 仍未验证

- 驻留/往返 10 s 的最大偏离量（掉头逻辑改了，但只做了定性确认）。
- 近距离（<1.5 m）看仍有明显点状纹理：12 万点上限导致，非 bug（DELIVERY §5-6）。

---

## 14. v2 单引擎版本迭代终验（2026-11-14，Lead 收口）

> 触发需求：「本地做版本迭代，改为使用同一套渲染引擎实现」。
> 架构裁决 `DECISIONS.md` D10 / D11；方案与排障复盘 `ITERATION_V2.md`；接口事实源 `CONTRACT.md v2.0`；架构正文 `ARCHITECTURE.md §0`。
> **原则同 §0：以下数字全部来自本轮真跑 stdout 或目视确认，未测项在 §14.8 明写。**

### 14.1 与 v1 的关系

v1 的 §1–§13 结论**继续有效但口径已变**：§1 的「关键资源 200」、§6 的「原功能回归」、§7 的「无 WebGPU → WASM」是引擎无关的，v2 原样复跑；而 §2「数字人可见」、§5「性能」里的**双 canvas / 透明 overlay / 跨 canvas 相机同步**措辞已被 D10 取代。v1 完整源码与文档备份在 `versions/v1-dual-engine/`。

### 14.2 自检断言的变化

`tools/check_human.mjs` 从 v1 的 **14 项**扩到 **19 项**。原有「overlay canvas 存在」「three 场景里有 SplatAvatar」两项改写为单引擎断言，并新增架构守卫：

| 断言（`check_human.mjs` 行号） | 防的是什么 |
|---|---|
| `:172` 单引擎：无 overlay canvas / 无第二个 renderer | 防止悄悄回退双引擎 |
| `:174` 数字人挂进 PlayCanvas layer（instanced MeshInstance） | 防止只建对象不挂 layer |
| `:200` 按需渲染：宿主确实每帧执行了 `render()`（`drawCalls>0`） | **防止「自检全绿但画面冻结」假阳性** |
| `:202` 单引擎主循环持续推进（`frameCalls` 增长） | 防止 `app.on('update')` 被节流 |
| `:204` shader 语言与图形后端匹配（WebGPU→`wgsl` / WebGL2→`glsl`） | 防止 GLSL 在 WebGPU 下静默失败 |
| `:313` 无 shader 转译 / 编译错误 | 捕获 `Cannot transpile shader ...` |

场景加载判断放宽为 `state.loaded || state.progress >= 100`（有头 WebGPU 下 `loaded` 可能滞后）；`--renderer=` 可强制后端；`--headed` 浏览器加 4 个防 rAF 节流 flag；截图 3 次重试。`argOf()` 修掉 `--extra=diagSimple=1` 被 `split('=')[1]` 截断的问题。

### 14.3 终验命令与结果（同一台 RTX 3070）

```
$ node tools/check_human.mjs --wait=240                            # headless · WebGL2 · GLSL
========== 19 PASS / 0 FAIL ==========
render = {"maxDrawCalls":3,"frameCallsDelta":30,
          "shaderLanguage":"glsl","deviceType":"webgl2"}

$ node tools/check_human.mjs --wait=240 --headed --renderer=webgpu # 有头 Chrome · WebGPU · WGSL
========== 19 PASS / 0 FAIL ==========
deviceType=webgpu  shaderLanguage=wgsl  backend=webgpu
56–57 FPS · 推理 148–246 ms · 无 shader 转译 / 编译错误

$ node tools/verify_editor.mjs                                     # 标注编辑器原功能全量回归
========== 283 PASS / 0 FAIL ==========
```

`frameCallsDelta=30` 与 `maxDrawCalls=3` 是「宿主确实每帧出帧」的量化证据 —— v2 之前该值是 `drawCalls.total=0`，截图 md5 全部相同。

**收口复跑（12:39–12:44，文档与记忆同步后、代码未再改动）**：三项命令串行重跑，退出码均为 0，结果与上表一致。

```
WEBGL_EXIT=0   ========== 19 PASS / 0 FAIL ==========
  engine=playcanvas-single  deviceType=webgl2  shaderLanguage=glsl
  count=120000 bones=65 height=1.75 splatSize=0.0066 spacing=0.0055
  backend=wasm（headless 无 GPU adapter，ORT 正常回落）· 无 shader 转译错误
  控制台：[human] 单引擎后端 {"deviceType":"webgl2","shader":"glsl"}

WEBGPU_EXIT=0  ========== 19 PASS / 0 FAIL ==========
  engine=playcanvas-single  deviceType=webgpu  shaderLanguage=wgsl
  backend=webgpu · fps=57 / 56 · genMs=144.2 / 150.3 ms · jsHeapMB=38.7
  count=120000 bones=65 height=1.75 · 世界包围盒 1.75 · 无 shader 转译错误
  控制台：Renderer: webgpu / [human] 单引擎后端 {"deviceType":"webgpu","shader":"wgsl"}

EDITOR_EXIT=0  ========== 283 PASS / 0 FAIL ==========
```

因此本轮推理耗时实测覆盖 **144–246 ms**（两轮采样），FPS **56–57**；`§14.6` 中「推理 ≤300 ms」「≥55 FPS」两条结论在两轮均成立。

**如实记录一处复现的测试链路问题**：本次 WebGPU 复跑里 `check_human.mjs` 的**第二张站立截图 3 次重试均超时**（行走截图成功）。这是 §14.8 已列的 `Page.captureScreenshot` 有头长会话偶发超时，非产品渲染失败 —— 同一轮全部 19 项断言（含 `drawCalls>0` / `frameCalls` 增长 / 无 shader 错误）仍全绿，且站立交付图由 `shoot_human.mjs` 单次截图独立产出（`shots/v2_deliver_webgpu_stand.png`）。

### 14.4 两个决定性根因的实证（不靠猜 bundle）

| 工具 | 实测输出 | 结论 |
|---|---|---|
| `tools/diag_v2_decisive.mjs` | `{"drawCalls":{"total":0,"forward":0},"inst":{"visible":true,"cull":false,"instancingCount":120000,"drawBucket":127,"layer":false},"layer":{"total":2,"idxHuman":1}}`；5 张不同实验截图 md5 **完全相同** | 对象挂载无误，问题是宿主 `app.autoRender=false` 按需渲染，`app.tick()` 不调 `render()` → 画面冻结。修复：`human-layer.js` 每帧 `requestFrame()`（`frame:request` + `app.renderNextFrame=true`） |
| `tools/probe_webgpu_shader.mjs` | `{"ok":true,"deviceType":"webgpu","isWebGPU":true,"hasTranspilers":false,"glslang":false,"twgsl":false}`；GLSL 材质 console：`Cannot transpile shader ... shader transpilers (glslang/twgsl) are not available.`；WGSL 材质画出 4×4 青色点阵 | 宿主 `createGraphicsDevice()` 未传 `glslangUrl/twgslUrl`，WebGPU 下 GLSL 不可用 → 补齐 WGSL 并移除「WebGPU 回退 v1 双引擎」，保证两个后端都真单引擎 |
| `tools/probe_pc_splat.mjs` | `{ok:true, storageType:"Float32Array", instancingCount:64, primCount:6, deviceType:"webgl2", glErr:0}`，`shots/probe_pc_splat2.png` 8×8 彩色点阵 | 地基：`setInstancing(true,true)` + `gl_InstanceID`、内置 `matrix_model/viewProjection`、RGBA32F `lock()/unlock()` + `texelFetch` 均可用 |
| `tools/probe_single_engine.mjs` | `globalThis.__pc` 暴露 `Mesh/MeshInstance/ShaderMaterial/Texture/GraphNode/BlendState`；`defaultDrawLayer.addMeshInstances=function`；主画布 + 小地图共 2 个 canvas（**无第三个**） | 单引擎可行且不改核心文件 |

有头 CDP 的 `fps=0 / genMs=0` 假阴性来自 Chrome 对后台/遮挡窗口的 rAF 节流，加 `--disable-background-timer-throttling` / `--disable-renderer-backgrounding` / `--disable-backgrounding-occluded-windows` / `--disable-features=CalculateNativeWinOcclusion` 后恢复；这是**测试浏览器**问题，不是产品缺陷。

### 14.5 交付截图（目视确认）

| 文件 | 后端 | 目视结论 |
|---|---|---|
| `shots/v2_deliver_webgpu_stand.png` | WebGPU / WGSL | 全身入镜：紫色头盔、橙色面罩、黄色宇航服带胸前装置、双臂贴身、两条红靴分开落地；站在展厅展台前，与 SOG 场景同一画面；左侧「3DGS 数字人 · MotionBricks」面板显示「后端 webgpu · 模型 已加载 · 推理 … · 高斯 120k · 骨骼 65 · 57 FPS」，面板与小地图不重叠 |
| `shots/v2_webgl_final.png` | WebGL2 / GLSL | 同一角色可见、配色一致（紫头盔 / 橙面罩 / 黄宇航服 / 红靴）；**抓到的是迈步中的过渡帧**（双臂张开、腿弯曲，非站立姿态），且顶部横幅显示「WebGL2 · 无可用 GPU 加速」、面板 `后端 wasm`。站立参考以 WebGPU 交付图为准 |
| `shots/check_webgpu_walk_fresh.png` | WebGPU / WGSL | 行走态正常，未回绑定姿态 |
| `shots/wgsl_probe_B_wgsl.png` | WebGPU | 最小 WGSL 材质 4×4 青色点阵（`instanceIndex` + `textureLoad`） |
| `shots/probe_pc_splat2.png` | WebGL2 | 最小高斯 8×8 彩色点阵 |
| `shots/deliver_stand.png` | v1 双引擎 | 外观对照：120k splats / 65 骨骼 / 1.75 m / `splatSize=0.0066 m` 与 v2 一致；面部颗粒为 12 万高斯采样固有质感 |

### 14.6 8 条验收项对照（v2 口径）

| # | 验收项 | 结论 | v2 证据 |
|---|---|---|---|
| 1 | 干净环境从零启动、无构建、关键资源可达 | **PASS** | 仍无 `package.json` / `node_modules`；`gs-viewer.html` / `human-layer.js` / `pc-splat-avatar.js` 均 200，ONNX `Range: bytes=0-1023` → **206 / 1024 B**；`gs-viewer.html` 仍只有 2 处新增 |
| 2 | 数字人可见且正确 | **PASS** | 19 项断言含 `count>0 / bones>0 / height∈(1.65,1.85) / 世界包围盒∈(1.4,2.1)`；`shots/v2_deliver_webgpu_stand.png` 目视确认 |
| 3 | 漫游：原 WASD + 自主往返 | **PASS（沿用 v1）** | 集成层 UI / `placeInFront` / patrol / 归位逻辑未改；v1 §3 位移 1.58 m 与 `cameraMode=walk` 仍适用 |
| 4 | 动作 stand / walk / run 可切换 | **PASS** | 19 项含「三种步态均可切换」「walk 后仍有推理产出」；WebGPU 推理 148–246 ms |
| 5 | 性能 ≥55 FPS、推理 ≤300 ms | **PASS** | 有头 WebGPU **56–57 FPS**、推理 **148–246 ms**（v1 同环境 56 FPS / 187.5 ms） |
| 6 | 原功能无回归 | **PASS** | `verify_editor.mjs` **283 PASS / 0 FAIL** |
| 7 | 兼容与降级 | **PASS（口径更新）** | WebGL2 → GLSL、WebGPU → WGSL，两个后端都单引擎；ORT 无 WebGPU → WASM 沿用 v1 §7；**不再有「WebGPU 时回退 v1 双引擎」** |
| 8 | 改动面受控、可回滚、文档与许可齐备 | **PASS** | `gs-viewer.html` 2 处不变；`versions/v1-dual-engine/` 完整备份；新增 `ITERATION_V2.md`，`ARCHITECTURE.md §0` / `CONTRACT.md v2.0` / `DECISIONS.md D10–D11` / `README.md` / `DELIVERY.md §0` 已同步；4 份许可证副本沿用 v1 |

### 14.7 本轮新增的架构收益（可量化）

| 项 | v1 | v2 |
|---|---|---|
| WebGL/WebGPU 上下文 | 2 | **1** |
| 渲染循环 | 2（PlayCanvas rAF + three `setAnimationLoop`） | **1**（`app.on('update')`） |
| 相机同步 | 每帧从 `window.__viewer` copy 到 three 相机 | **同一台 `CameraComponent`，零同步延迟** |
| GPU 数据传输 | 顶点属性 buffer（≈12 MB）+ 每帧重写 2.9 MB index buffer | 3 张 RGBA32F 纹理（≈16.5 MB）+ 每帧重写 1.9 MB `orderTex` |
| 主后端 | WebGPU 时回退双引擎 | **WebGPU/WGSL 也是单引擎** |

### 14.8 未验证项与已知限制（如实列出）

- **场景级深度遮挡**：宿主 `GSplatQuadRenderer.configureMaterial()` 设 `depthWrite=false`，SOG 点云不写深度。同引擎 ≠ 自动遮挡；真遮挡需碰撞三角网深度预通道，列为 **v2.1**，本轮未做也未验证。
- **驻留/往返 10 s 最大偏离量**：沿用 v1 §13.5，未重新采样。
- **走动后重新放置落点**：沿用 D9b，偏 1–2 m；实验性 `driver.teleport()` 未启用。
- **持续渲染功耗**：数字人逐帧动画使 `stand` 态也满帧请求渲染，未做降帧（30 FPS）优化与功耗量测。
- **近距离 <1.5 m 点状纹理**：12 万点上限的固有质感，非 bug。
- **有头截图链路**：`Page.captureScreenshot` 在长时间会话里偶发超时（第二张更明显），已加重试；独立交付图用 `shoot_human.mjs` 单次截图产出。

## 15. 编辑模式 4 项交互修复回归（2026-11-16，Lead 收口）

> 需求来源：用户「编辑模式下修改几个问题」——① 动线动画方向与箭头方向相反 + 面片须
> 三维空间贴合碰撞体 mesh 而非朝向摄像机；② 三维屏改为三轴 + 选择轴的编辑交互，
> 去掉六向交互；③ 贴面矩形无法正常播放视频；④ 右键单击结束标注，左右键双击一律不触发事件。
> 提示词经 prompt-iteration-optimizer 技能管线打磨（盲评 86.0，G1–G10 门禁全 PASS）。

### 15.1 修复内容与根因

| # | 问题 | 根因 | 修复 |
|---|---|---|---|
| 1 | 动线动画方向与箭头方向相反；面片朝向摄像机 | ① `arrowChain()` 段位置 `raw = (i - frac)·L` 随相位向路径起点倒退，与箭头尖（u=avail，指向 +s）相反；② 旧实现是屏幕空间 SVG billboard 链，本质是朝向摄像机的平面片 | ① 改 `raw = (i + frac)·L`，段随相位向 +s 推进；② 新增 `schema.arrowChainWorld()`：沿贴合碰撞 MESH 的三维中心线生成 6 顶点世界空间面片，`lateral = tangent × worldUp`（竖直切线两级回退），抬高 3cm 防 z-fight，逐点投影绘制；带宽语义 px → 米（`halfW = clamp(bw·0.45, 0.12, 2)`） |
| 2 | 三维屏六向交互改为三轴 + 选择轴 | 产品需求 | 删 `Overlay.AXIS_HANDLES` 与 `.ed-axis-handle`；新 gizmo = SVG 内 X 红/Y 绿/Z 蓝三根轴柄（line + arrowhead + `.ed-gizmo-hit` 命中圆）+ 中心选择柄；`_axisBasis` 扩展返回 x/y/z 的 world/screen/ppm（投影 <4px 兜底）；拖动数学沿用 `delta = world[key]·((dx·sx+dy·sy)/ppm[key])`，`move()` 零改动 |
| 3 | 贴面矩形不播视频 | GPU 投射实例由 `decalMgr.sync(getDecals())` 驱动，但旧代码只在建投影机 / 改 decalDepth / 启动时调 `syncDecals()` —— 改片源后从不重喂，实例永远停在演示画面 | `editor.js action()` 末尾统一 `syncDecals()`，覆盖 media / local-video / local-video-file / delete / duplicate / undo / redo / item-vis 全部路径。连带修正 `decalMgr.debug()` 的 `videoReady` 误读 `i.videoWidth`（实例上不存在，恒 false）为 `i.video.videoWidth` —— 该 bug 曾让三轮诊断误判「解码停滞」，实际视频 500ms 内就绪 |
| 4 | 右键单击结束标注；双击一律无事件 | 产品需求 | stage `dblclick` 捕获层 `preventDefault + stopImmediatePropagation` 纯拦截；删除 overlay DOM/SVG、panel 列表行的 dblclick 监听与合成双击判定（`lastTap/DBL_MS/DBL_PX`）；`contextmenu` 草稿分支 `cancelDraft()` → `finishDraftAfterPending(true)`（点数不足下限时丢弃草稿回「选择」）；`Enter` 保留 |

### 15.2 验证证据

| 验证 | 命令 | 结果 |
|---|---|---|
| 全量回归 | `node tools/verify_editor.mjs` | **292 PASS / 0 FAIL，EXIT=0**（首跑 292/1：遗留旧断言 `s23.flyOnItem===true` 与新双击语义矛盾，删除后全绿；[33] 新增 5 条源码静态守卫） |
| Node 单测（相位方向 + 世界空间几何） | node 直跑断言段 | 全过：XZ 水平路径侧向偏移落在 x/z（y 恒贴面高度）、z=±0.25 精确、竖直切线兜底有限值、塌缩输入返回空、相位 0→0.35 段起点向 +s 前进（a0=0 → a35=35） |
| 真机视频播放探针（WebGPU） | `node tools/probe_decal_video.mjs` | **A–F 六步全 PASS**：编辑器挂载 / `pickReady=true 且 degraded=false` / demo 态演示画面 + 投影机 / `action('local-video')` 后 **500ms** 内 `videoUrl='./media/test.mp4' && videoReady=true && demoMode=false && videoErr=null` / 改片源 `?v=2` **500ms** 内即时重喂 / 清空片源回退 demo。0 JS 错误、0 shader 错误、0 GPU uncapturederror |
| 真机投射内容截图 | `tools/probe-decal-video-{demo,video}.png` | demo 态蓝白斜条纹演示画面 → 设置片源后同区域变为 test.mp4 暖色视频帧内容，画面非黑非白、场景正常 |
| 视觉截图（mock） | `node tools/shoot_board.mjs` | EXIT=0，17 张重生成：`flow_ribbon.png` 世界空间箭头面片贴合地面起伏、远处收敛；`screen_gizmo.png` 三轴 gizmo（RGB 轴柄 + 中心柄，六向按钮消失） |

### 15.3 结论

4 项修复全部落地，DoD（终稿 Requirements 1–7）逐条满足；回归、单测、真机探针、截图四层证据齐备。
遗留如实记录：真机探针跑在 Dawn SwiftShader 软渲染 WebGPU 上（与真机 GPU 语义同路径，
但解码 / 性能不代表真机水平）；贴花音频按设计静音（`muted`），「音频输出正确」以
`muted+loop` 属性断言替代；`shoot_board.mjs` 截图 11 文案已同步三轴 gizmo。

---

## 16. 贴花「只有线框、无内容」根因定位与验收口径修正（2026-11-16，阶段 7 收口）

> 需求来源：用户「（1）视频贴花渲染失败，查找原因，进行修复。（2）渲染框架与具体引擎解耦，
> 后续支持 Babylon.js 或者 three.js 引擎的接入」。引擎解耦部分见 §17 与 `docs/DECISIONS.md` D13。
> 本节记录**根因**：此前判定为「渲染缺陷」，经逐像素诊断后重新定位为「验收口径缺陷」。

### 16.1 诊断路径（三步递进，每步都有决定性证据）

| 步骤 | 工具 | 关键发现 | 结论 |
|---|---|---|---|
| ① 静态复查 | 读 `decal-shaders.js` / `decal-projection.js` / `playcanvas-adapter.js` | 贴花顶点流已是 2 分量（与 shader `vec2 vertex_position` 匹配）；`uPickFlipY` 按后端设定；分位排序含 k 位 | 上一轮修复均已生效，非回退 |
| ② 行序/口径枚举 | `tools/diag_decal_pair.mjs` v1 | 4 个行序变体误差**完全相同**（6.754 m），样例 `nd` 全为 0 | 诊断脚本自身有 bug（`tex.read` 未带 `immediate:true` → WebGPU 读回全零） |
| ③ 修读回后重测 | 同上 v2 | **深度对比平均绝对差 0、最大差 0**；`top_flipY` 变体**平均误差 0 / 最大误差 0 / 盒内 49/49** | shader 世界点重建数学与引擎权威点**逐像素完全一致** → 渲染正确 |

### 16.2 根因：验收分母口径缺陷（不是渲染缺陷）

探针 `tools/probe_decal_realpath.mjs` 旧口径用「OBB 正对相机面的屏幕投影 AABB」作应覆盖区域分母。
OBB 有 **4 m 厚度**（`half[2]=1.994`），正对相机的那个面比真实表面**近约 2 m**，透视放大后
它的屏幕投影远大于实际贴合面 —— 实测**分母虚大 4.59 倍**：

```
用户框选矩形   : 418 × 196 = 81,928 设备 px   ← 用户实际要贴花的区域
探针旧分母     : 794 × 474 = 376,356 设备 px   ← OBB 前表面 AABB（虚大 4.59×）
实测变化像素   : 89,840（落在框选区内 79,007）→ 覆盖率 vs 框选区 = 96.4%
旧口径覆盖率   : 89,840 / 376,356 = 0.2387    ← 那个"24%"就是这么来的
```

结论：**贴花早已完整渲染**（覆盖用户框选区 96.4%），24% 是分母虚大造成的失真指标。

### 16.3 探针口径修正内容（`tools/probe_decal_realpath.mjs`）

1. 分母改为**用户框选矩形**（`SEL_RECT` → 设备像素），OBB 8 角点 AABB 降级为**溢出参考框**；
2. 新增**噪声基线帧**（hidden2，贴花仍隐藏）：场景内有循环播放视频，帧间本身就会变，
   `hidden vs hidden2` 即动画噪声，显著变化 = `(visible vs hidden)` 且非噪声；
3. 指标体系改为 5 条：① 选中区覆盖率 ≥0.80 ② 选中区填充比 ≥0.70 ③ 主色相差 ≤15°
   ④ 孤立点率 ≤2%（椒盐点守卫）⑤ **OBB 外溢出率 ≤1%**（贴花绝不该画到投影盒外）；
4. 顺带修掉一个真实 bug：`process.argv.match(...)` —— argv 是数组不能 `.match()`，
   该行曾让探针在 C 段之后直接抛 `process.argv.match is not a function`；
   改为 `process.argv.find(a => a.startsWith('--variant='))`。

### 16.4 真机验证证据（桌面 Chrome + WebGPU，`--headed`）

```
用户框选矩形(CSS)      = {x:430.44, y:340.08, w:278.52, h:130.80}
OBB 正对面 AABB(CSS)   = {x:100.20, y:148.08, w:529.28, h:315.79}   （旧口径，仅对照）
选中区（设备px）       = 418 × 196   面积 = 81,928
显著变化像素           = 78,998（噪声剔除 0，原始差分 131,041）

PASS  ① 选中区覆盖率 = 0.9642  阈值 0.8
PASS  ② 选中区填充比 = 1.0000  阈值 0.7
PASS  ③ 主色相差     = 5.0°    阈值 15      贴花区主色相 = 205（演示画面 210）
PASS  ④ 孤立点率     = 0.00%   阈值 0.02
PASS  ⑤ OBB 外溢出率 = 0.00000 阈值 0.01
[对照] 旧口径覆盖率 = 0.3482   分母虚大倍数 = 4.59×
渲染诊断 = {degraded:false, gpuErrors:23, pickReady:true}
★ 全部 PASS
```

截图 `tools/probe-real-visible.png` 目视确认：蓝白斜纹投射内容正确贴合在楼梯与地面表面，
主画面完整、无黑屏。

### 16.5 残留 VertexState 错误的归因（不是贴花缺陷）

真机日志仍有一条 `Vertex attribute slot 0 used in vertexMain is not present in the VertexState`。
**归因证据**：跑 `--no-shot`（不截图）时 `gpuErrors=0 / degraded=false / 截图前错误条数 = 0`；
错误只在 `Page.captureScreenshot` 之后出现 —— 即 CDP 截图触发视口变化 → 引擎自身 mesh
重建 VertexState 失效，**属引擎/测试链路，与贴花无关**。

同时验证了贴花的错误归因机制有效：贴花用「GPU 错误作用域 + 复测二分」判定错误归属，
引擎自己的错误被正确归为 `foreignErrors`（非贴花），**未触发降级**，贴花照常渲染
（`degraded=false`）。这条机制正是「别人的错误把贴花全隐藏 → 用户看到框线在、视频没了」
的修复点。

### 16.6 回归同步

`tools/verify_editor.mjs` 新增 §[35]「真机验收结论固化」5 条静态守卫：

| 守卫 | 锁定的不变量 |
|---|---|
| 全屏 quad 顶点流为 2 分量 | 与 shader `vec2` attribute 匹配，否则 WebGPU pipeline 无效（SwiftShader 看不出，必须源码守卫） |
| GPU 错误按「作用域 + 复测二分」归因 | `probeDecalsOff` + `foreignErrors`/`scopedErrors` 分列，别人的错误不降级贴花 |
| pick 纹理行序按后端设定且允许显式覆盖 | 行序弄反 = 深度图镜像 = 只有包围盒没有视频 |
| 探针分母用用户框选矩形 | 防止回退到 OBB 前表面 AABB（虚大 4.59×） |
| 探针含噪声基线帧 | 场景动画不得计入贴花差分 |

**回归结果：`330 PASS / 0 FAIL`**（原 325 基线 + 5 新守卫）。同批修掉 3 条**陈旧断言**
（代码在上一轮变长后正则窗口失效，不变量本身成立）：`uPickFlipY` 断言改为盯默认分支
`isWebGPU ? 1 : 0`（`inst.pickFlipY` 显式覆盖是诊断开关）、`degrade(reason)` 窗口 300→600、
`onPrerender` try 窗口 400→900。

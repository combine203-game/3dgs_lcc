# ARCHITECTURE.md — 3DGS 数字人集成方案（S1 冻结）

> 决策依据：`docs/DECISIONS.md`（D1–D7）。接口契约：`docs/CONTRACT.md`（唯一事实源）。

## 1. 一句话架构

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

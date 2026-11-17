# UPSTREAM.md — 上游实证调研（S0）

> 结论先行：选 **`repalash/three-motionbricks` v0.2.0** 作为「社区 WebGPU 移植」的落地依赖；
> NVIDIA 官方 `NVlabs/motionbricks` 只作为**权重与协议来源**（它跑 TensorRT/CUDA，浏览器不可用）。
> 3DGS 数字人本体不在上游仓库里，需要我们自己把「骨架驱动的 3DGS 化身」补上（见 ARCHITECTURE）。

## 1. 候选比对（至少 2 个，实际比了 3 个）

| # | 仓库 | 定位 | 运行时 | 浏览器可用 | 许可证 | 结论 |
|---|---|---|---|---|---|---|
| A | `NVlabs/motionbricks` @ `54fc563aea`（v0.2.0，2026-10-23） | NVIDIA 官方实现 + 权重 + 编辑器 | Python + **TensorRT + CUDA**（RTX 4090 实测） | ❌ 需 NVIDIA GPU 本机环境，无 WASM/WebGPU 路径 | 代码 Apache-2.0 + 文档/素材 CC-BY-4.0；**权重 NVIDIA Open Model Agreement**；示例动作数据 NVIDIA Sample Data Evaluation License | 只取权重与协议，不接运行时 |
| B | **`repalash/three-motionbricks` @ `0dfe1929dc`（v0.2.0，2026-10-31）** | 「MotionBricks for three.js」社区移植，**ORT Web + WebGPU 后端 + Web Worker 推理** | three.js ≥0.152 + onnxruntime-web 1.30 | ✅ WebGPU 优先，自动降级 WASM | **Apache-2.0**（`package.json`） | **选型采用** |
| C | `josh-english-2k18/3rd-person-physics-sandbox` @ `0691879bad`（2026-11-08） | 完整第三人称射击原型：MotionBricks SOMA 运行时 TS 移植 + Rapier + three | three.js + ORT WebGPU | ✅ | MIT | 不采用：与游戏逻辑（Rapier、射击、HUD）强耦合，无可复用库边界 |

补充对照（非移植，未采用）：`localai-org/motion-bricks.cpp`（GGML/C++ 原生，非 Web）。

## 2. 选型 B 的关键事实（来自源码，非猜测）

| 项 | 事实 | 证据 |
|---|---|---|
| 包形态 | 纯 ESM，`dist/index.mjs`(207 KB) + `dist/motionbricks.worker.js`(34 KB)，`dist/` 已提交，可从 CDN/GitHub 直接取，**不需要构建** | 仓库 tree；`package.json.files` |
| 依赖 | 仅 peer `three >= 0.152`；ORT Web 在运行时按 URL 动态 import | `package.json`；`MotionBricksCharacter.ts:31-33` |
| 推理后端 | `backend: 'auto'` → 有 WebGPU 且显存够、warm 生成 ≤300 ms 时用 WebGPU，否则 WASM；可强制 `'webgpu'` | README Options 表 |
| Worker | 默认 `worker: true`，模型在 Web Worker 里跑，不阻塞渲染；`MotionBricksRemote` 封装 | `index.mjs:2270-2282` |
| 模型 | G1 fp32 `mmm_v6_g1_fp32.onnx`(730 MB) 或 `tools/pack_model.py` 打的 **q8 pack ≈190 MB**（13 shard）；SOMA 人形 758 MB / pack ≈195 MB | `MotionBricksCharacter.ts:21-30` |
| 动作驱动 | `MotionBricksCharacter.drive(dir, 'walk'|'run')` / `moveTo(v)` / `stop()` / `loadPrimitive('jump_0_5m')` / `sit()`；每帧 `update(dt)` | README 用法段 |
| 骨骼输出 | `g1.controller.pose` → 36 个 G1 关节坐标；`RetargetedCharacter(gltf.scene, CHARACTER_RIGS.mixamo)` 把该姿态映射到 Mixamo 骨架 | `site/bodies/index.html:170-186, 236-246` |
| 人形资产 | `assets/characters/astronaut.glb`(1.6 MB, **CC0**)、`polybot.glb`、`robot_expressive.glb` | `assets/characters/LICENSE.md` |
| 3DGS | **上游没有任何 3DGS 化身**（`grep -i splat` 无命中） | 全仓库检索 |

> 因此「MotionBricks 驱动 3DGS 数字人」= 上游负责**动作**，3DGS 化身与高斯渲染由本项目实现，这是必须自己补的一层，不是调用现成 API。

## 3. 许可证矩阵（代码 / 权重 / 素材分开）

| 资产 | 许可 | 义务 | 本项目用法 |
|---|---|---|---|
| three-motionbricks 代码 | Apache-2.0 | 保留版权与许可声明、NOTICE | `web/human/vendor/three-motionbricks/`（LICENSE 副本：`vendor/licenses/three-motionbricks-Apache-2.0.txt`） |
| MotionBricks 模型权重（q8 pack） | **NVIDIA Open Model Agreement**（Release Date: April 2, 2026） | 见下方「权重许可原文要点」 | `web/human/model/`（LICENSE 副本：`vendor/licenses/NVIDIA-Open-Model-Agreement.txt`） |
| 示例动作数据（jump/sit 等 primitive 片段） | NVIDIA Sample Data Evaluation License | **仅内部评估/测试**，不得再分发 | demo 内从 NVIDIA 源加载或跳过；不打包再分发 |
| astronaut.glb 等角色 | **CC0 1.0** | 无 | 作为高斯化身的几何/蒙皮来源 |
| ONNX Runtime Web | MIT（Copyright (c) Microsoft Corporation） | 保留声明 | `web/human/vendor/ort/`（LICENSE 副本：`vendor/licenses/onnxruntime-web-MIT.txt`，2026-11-13 从 `ghproxy.net` 代理 `microsoft/onnxruntime/main/LICENSE` 取原文 1073 B，npm 包内未随附） |
| three.js 0.168.0 | MIT | 保留声明 | `web/human/vendor/three/`（LICENSE 副本：`vendor/licenses/three-MIT.txt`） |
| 本项目新代码 | 随宿主工程 | — | `web/human/**` |

**权重许可原文要点（2026-11-13 从 `hf-mirror.com/monoradio/motionbricks-soma-fp16-onnx/resolve/main/LICENSE-NVIDIA-Open-Model-Agreement.txt` 实取 7910 B 后核对，修正此前的初判）**

- Grant：NVIDIA 授予「永久的、全球的、非独占、免费、免版税、不可撤销」的复制、制作衍生作品、公开展示/表演、再分发许可；许可原文明确写「Works are commercially usable」。
- Redistribution 三个条件：① 向接收方提供本许可副本；② 在源码形式中保留版权/专利/商标/署名声明；③ 若上游含 `NOTICE` 文件，衍生作品需附可读的 `Notice`，写明「Licensed by NVIDIA Corporation under the NVIDIA Open Model Agreement.」。
- 限制：不得使用 NVIDIA 商号/商标/产品名（正常描述来源除外）；不得暗示 NVIDIA 背书；需遵守美国出口管制与 OFAC 制裁规定。

⚠️ 合规结论（**修正版**）：**权重可随本 demo 再分发，前提是随附 `vendor/licenses/NVIDIA-Open-Model-Agreement.txt`、保留上游声明、且不暗示 NVIDIA 背书**；受限制的是 **NVIDIA 示例动作片段（jump/sit）** —— 该部分为 Sample Data Evaluation License，仅内部评估、不得再分发，本项目因此**未启用也未打包**。README §8 与 DELIVERY §5 已同步该口径。

## 4. 已实证 / 未验证（诚实清单）

**已实证（本次会话实际执行）**
- 仓库、commit、许可证、文件清单、模型体积、依赖方式：全部通过 GitHub API 实读。
- 网络可达性：`api.github.com` 200；`raw.githubusercontent.com` 502；`ghproxy.net` 可代理 raw（~11 KB/s）；`repalash.com` 模型分片可下（~25–40 KB/s）；`huggingface.co` 502；`registry.npmmirror.com` ~1 MB/s。
- 依赖已本地化：`three@0.168.0`、`onnxruntime-web@1.30.0`（含 `ort.webgpu.min.mjs` + jsep wasm）、`three-motionbricks dist`（index.mjs + worker.js）、`astronaut.glb`。
- `dist/index.mjs` 的 worker 解析逻辑（`new URL('motionbricks.worker.js', import.meta.url)`）已读源码确认，故 vendor 时两个文件必须同目录。

**已解决（原阻塞项，2026-11-13 晚）**
- **模型未下载 → 已解决：来源变更。** repalash.com 的 q8 pack 实测 25–40 KB/s、频繁 `ECONNRESET`/416，180 MiB 的 13 个 shard 下不完（该事实保留为背景，`tools/download_model.mjs` 因此弃用）。改为从 HF 镜像取**单个** ONNX：`https://hf-mirror.com/monoradio/motionbricks-soma-fp16-onnx` 的 `mmm_v6_soma_q8h.onnx`（243 MB，实测 675 KB/s 稳定，支持 Range 续传）。
  - 获取命令：`node tools/fetch_hf_model.mjs q8h web/human/model`
  - 落盘实测：`242,732,481 B`，`Range: bytes=0-0` 返回 206；模型路径 `web/human/model/mmm_v6_soma_q8h.onnx`（单文件，无需 shard 拼接）。
- **WebGPU 后端未实测 → 已实测。** 有头 Chrome 137 + RTX 3070 + D3D12：`backend=webgpu`，推理 **155–325 ms/次**（R4 采样 187.5 ms；stand/walk/run 211/317/277 ms），场景 56 FPS。headless（SwiftShader，无 adapter）自动回落 WASM，**约 1 s/次**（实测 1168 ms、25 FPS）。

**仍未验证 / 已确认不可用**
- `jump_0_5m` / `sit` 等 Smart Primitive：依赖 NVIDIA 示例片段，`media.githubusercontent.com` **502 不可达**，本环境拿不到片段 → **未启用**（UI 无入口，驱动无对应方法），不作为已实现能力声明。

## 5. 复现步骤（最小样例）

```bash
# 1) 依赖（已 vendor，无需 npm）
ls web/human/vendor/three/three.module.js
ls web/human/vendor/ort/ort.webgpu.min.mjs
ls web/human/vendor/three-motionbricks/{index.mjs,motionbricks.worker.js}

# 2) 模型（单文件 ONNX，243 MB，HuggingFace 镜像，断点续传）
node tools/fetch_hf_model.mjs q8h web/human/model

# 3) 起服务 + 打开集成页
python serve.py --port 8099 --no-browser
#   http://127.0.0.1:8099/gs-viewer.html?scene=floor3&human=1   ← 主 demo
#   （模块自检页：/human/_test-motion.html、/human/_test-avatar.html）
```

> 注：§4 中的 `tools/download_model.mjs` 属旧的 repalash.com shard 方案，已弃用；当前唯一模型入口是 `fetch_hf_model.mjs`。

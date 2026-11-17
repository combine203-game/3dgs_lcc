# 3dgs_lcc

三维高斯泼溅（3D Gaussian Splatting）场景查看器 —— 茂名展示馆版。

基于 **PlayCanvas** 引擎的 Web 端 3DGS 查看与标注编辑器，支持高斯点云场景浏览、
视角编辑、视频贴花投影、路径漫游与碰撞调试。

> 引擎适配层已解耦：业务代码（`web/editor/`）不直接依赖 PlayCanvas，
> 统一通过 `web/engine/engine-adapter.js` 契约访问；第二引擎（Babylon.js）
> 的接入契约见 [`web/engine/babylon-adapter.md`](web/engine/babylon-adapter.md)。

---

## 快速开始

```bash
# 1. 启动静态服务（零第三方依赖，仅需 Python 3.8+）
python serve.py                    # 默认 8099 端口，自动打开浏览器
python serve.py --port 8080 --no-browser
python serve.py --local-only       # 只监听 127.0.0.1

# 或 Windows 下双击
start.bat
```

浏览器打开后进入展厅 / 查看器 / 编辑器。

---

## 需要另行获取的大二进制资产

本仓库**只跟踪源码**。以下资产因体积（GitHub 单文件上限 100MB）未纳入版本控制，
需按需获取。完整清单与体积见 [`docs/ASSETS.md`](docs/ASSETS.md)。

| 资产 | 体积 | 获取方式 |
|---|---|---|
| MotionBricks 动作模型 `mmm_v6_soma_q8h.onnx` | 231 MB | `node tools/fetch_hf_model.mjs q8h` |
| SOG 高斯点云 `mm_floor1_clean.sog` / `mm_floor3_clean.sog` | 120 MB | 需从资产提供方获取 |
| 演示视频 `web/media/test.mp4` | 94 MB | 需从资产提供方获取 |
| ONNX Runtime Web WASM | 53 MB | `npm i onnxruntime-web` |

ONNX 模型可用国内镜像拉取（脚本已内置 `hf-mirror.com` + 断点续传）：

```bash
node tools/fetch_hf_model.mjs q8h        # q8 量化，约 231MB
node tools/fetch_hf_model.mjs fp16       # fp16 精度，约 380MB
node tools/download_model.mjs            # 旧源（repalash.com）分片下载
```

---

## 目录结构

```
├── serve.py              静态服务器（零第三方依赖）
├── start.bat             Windows 启动脚本
├── docs/                 设计文档（架构 / 契约 / 决策 / 测试报告 / 编辑器手册）
├── tools/                开发与验收脚本（Node）
│   ├── verify_editor.mjs     静态回归守卫（330 PASS / 0 FAIL）
│   ├── probe_decal_realpath.mjs  真机贴花像素级验收
│   └── diag_decal_pair.mjs   贴花世界点重建逐像素诊断
├── versions/             历史版本快照（v1-dual-engine 等）
└── web/                  站点根目录（URL 路径与磁盘一一对应）
    ├── app.js / app.css  应用入口
    ├── index.html        首页
    ├── editor.html       编辑器
    ├── gs-viewer.html    查看器
    ├── editor/           编辑器业务代码（**零 PlayCanvas 直接依赖**）
    │   ├── editor.js         主控制器
    │   ├── schema.js         注记 / 投影机建模
    │   ├── picking.js        深度拾取与反投影
    │   └── decal-projection.js  GPU 投影式贴花
    ├── engine/           引擎适配层
    │   ├── engine-adapter.js    适配契约（31 方法 / 6 组）
    │   ├── playcanvas-adapter.js PlayCanvas 实现
    │   ├── decal-shaders.js      贴花 shader（GLSL + WGSL 双份）
    │   └── babylon-adapter.md   Babylon.js 接入契约
    ├── viewer/           PlayCanvas 引擎 bundle 与查看器
    ├── human/            数字人层（ONNX Runtime Web + three.js）
    ├── sog/              SOG 高斯点云数据
    ├── maoming-showroom/ 茂名展示馆场景
    └── vendor/           本地图标
```

---

## 贴花（视频投影贴花）验收口径

> **重要**：判断「贴花有没有正确渲染」**不能**用「OBB 前表面屏幕投影 AABB」当分母。
> 该盒有 4m 厚度，前表面比真实表面近约 2m，透视放大后分母**虚大 4.59 倍**，
> 覆盖率被稀释到 0.24，看似「渲染不完整」实则完全正常。

正确口径（`tools/probe_decal_realpath.mjs` 采用）：

| 指标 | 定义 | 阈值 |
|---|---|---|
| 选中区覆盖率 | 显著变化像素 ∩ 用户框选矩形 ÷ 框选区面积 | ≥ 0.80 |
| 选中区填充比 | 变化像素包围盒 ÷ 框选区面积 | ≥ 0.70 |
| 主色相差 | 贴花区主色相 vs 演示画面主色相 | ≤ 15° |
| 孤立点率 | 8 邻域无变化的变化像素占比 | ≤ 2% |
| OBB 外溢出率 | 变化像素落在投影盒外的比例 | ≤ 1% |

详见 [`docs/EDITOR.md`](docs/EDITOR.md) 与 [`docs/TEST_REPORT.md`](docs/TEST_REPORT.md) §16。

---

## 测试

```bash
# 静态回归守卫（无需 GPU，秒级）
node tools/verify_editor.mjs

# 真机像素级验收（需桌面 Chrome + WebGPU）
node tools/probe_decal_realpath.mjs --headed
```

当前基线：**330 PASS / 0 FAIL**（静态守卫）；真机贴花 5 项指标全 PASS
（覆盖率 0.9642 / 填充比 1.0000 / 主色差 5° / 孤立点 0% / OBB 外溢出 0.00000）。

---

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 整体架构与分层 |
| [`docs/CONTRACT.md`](docs/CONTRACT.md) | 引擎适配契约 |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | 技术决策记录（含根因反转复盘） |
| [`docs/EDITOR.md`](docs/EDITOR.md) | 编辑器手册与贴花验收口径 |
| [`docs/TEST_REPORT.md`](docs/TEST_REPORT.md) | 测试报告与诊断证据 |
| [`docs/SCENE.md`](docs/SCENE.md) | 场景数据说明 |
| [`docs/DELIVERY.md`](docs/DELIVERY.md) | 交付说明 |

---

## 许可

Apache License 2.0，见 [LICENSE](LICENSE)。

# SCENE.md — 现有场景勘查报告（S0）

> 勘查时间：2026-11-13 18:00 前后。所有结论均来自实地读取源码与目录，不来自记忆。

## 1. 工程路径

| 项 | 值 |
|---|---|
| 工程根 | `D:\WorkSpace\AI\3DGS_build\viewer_edit`（Git Bash: `/d/WorkSpace/AI/3DGS_build/viewer_edit`） |
| 站点根 | `<root>/web`（`serve.py` 把 URL 直接映射到该目录） |
| 场景数据 | 默认 `web/sog/<scene>_masked/` 的 .lcc2 八叉树分块流式（一层 266.8 MB / 32 块、三层 74.4 MB / 9 块，按视野按需请求）；`?source=sog` 回落到原始未清理的单文件 `mm_floor1.sog`(112.9 MB) / `mm_floor3.sog`(33.1 MB) |
| 现有文档 | `docs/EDITOR.md`(43 KB)、`docs/DECAL_TECH_ROUTE.md` |

## 2. 技术栈与版本

| 层 | 实现 | 证据 |
|---|---|---|
| 渲染引擎 | **PlayCanvas Engine 2.23.3**（`revision b7655d8`），单文件 bundle `web/viewer/index.js`(3.9 MB) | `index.js` 首行常量 `version$1 = "2.23.3"` |
| 3DGS 渲染 | bundle 内置 gsplat / SOG 解码器（`gsplat` 出现 798 次，`SOG` 15 次），wasm 解码器 `web/viewer/gsaf-decoder.wasm` | bundle 关键字统计 |
| 图形后端 | **WebGL2 主路径**（`WebGL2` 12 次）；bundle 内含 WebGPU 设备实现（`WebGPU` 141 次）但场景走 WebGL2 | bundle 关键字统计 |
| 页面编排 | 无构建步骤，原生 ES Module：`index.html` → `maoming-showroom/fusion.js` → iframe `gs-viewer.html` → `app.js` → `createViewer()` | `index.html` 的 module script；`app.js:1` |
| 服务 | `serve.py`（Python 标准库，零第三方依赖）+ `start.bat` | `serve.py` docstring |
| 碰撞 | `web/lcc2-collision.js` 注入 `window.__mgMakeMeshCollision`，由 bundle 以 PLY+btree 构造 MeshCollision | `lcc2-collision.js:142` |

> 重要：**没有 `package.json`、没有 bundler、没有 node_modules**。新增代码必须是「原生 ESM + 相对路径」，不能假设 `npm install` 可用（本机 npm 仅镜像可达、且该包不在镜像上）。

## 3. 渲染循环

- PlayCanvas `app` 驱动渲染；`window.__viewer.app.autoRender` 可被关闭（`app.js:566`）。
- 编辑器（`web/editor/*`）通过 `postMessage` + 动态 `import()` 挂在同一 iframe 内，使用**同一 canvas**。
- 3DGS 渲染长期占满主线程（`gs-viewer.html` 注释：动态 import 求值要等渲染空窗，冷启动 2~8 s），因此任何新模块都要用 `<link rel="modulepreload">` 预热。

## 4. 坐标系与单位

- 世界：**Y 轴向上，右手系，米制（1 unit = 1 m）**。`app.js:8-20` 明确「碰撞网格修复后渲染世界是米制」。
- 历史遗留：`scene-meta.json` 的 `spawnPoint.worldPosition` / `worldTarget` 仍是 **log 压缩空间**标定值（`ln(2.6)=0.9555`、`ln(3)=1.0986`），由 bundle 内部解压；新代码**不要**直接把这些数当米用。
- 相机实体：`viewer.app.root.findComponent('camera').entity`（`app.js:645`）；`viewer.setCameraPose(world,target,fov)` 可设位姿。
- 入场 FOV：floor3 `75`（`scene-meta.json.spawnPoints.floor3.fov`）。

## 5. 相机与控制器

- 漫游：`web/walk-controls.js` 控制 `globalThis.__MG_WALK`（胶囊 1.8 / 半径 0.30 / 眼高 1.6 / 重力 9.8 / 地面速度 4.0 m/s），bundle 内读 getter 实时生效；WASD + 触摸摇杆 + 手柄三条输入。
- 碰撞开关：`viewer.setCollisionEnabled(on)`；关闭后为 fly 模式。
- 自动巡航：`?play=1` 走 `walk_path.json` 位姿序列（`app.js:660`）。

## 6. 资源加载

- SOG 单文件按 **HTTP Range 206** 读取（`serve.py` 保留 Range 支持，缺了会直接失败）。
- `settings-*.json` 控制 tonemapping/背景/后处理。
- 所有资源相对路径，站点根为 `web/`。

## 7. 构建与启动命令

```bash
# 方式 A（推荐，与现场一致）
cd /d/WorkSpace/AI/3DGS_build/viewer_edit
python serve.py --port 8099 --no-browser      # 或 start.bat
# 访问 http://127.0.0.1:8099/

# 方式 B：只跑验证脚本（工具链自带，用系统 Chrome + CDP）
node tools/verify_editor.mjs                  # 基线：247 PASS / 0 FAIL
```

- 工具链事实：`tools/verify_editor.mjs` **不依赖 playwright**，spawn 系统 Chrome（`C:\Program Files\Google\Chrome\Application\chrome.exe`）+ CDP `--remote-debugging-port`，用 Node 内置 `WebSocket` 驱动。Node v22.22.2。
- 端口约定：编辑回归 18120/9246；截图 18121/9247。**Windows PID 与 Git Bash PID 不同**，杀进程必须 `taskkill //F //PID <winpid>`。

## 8. 允许改动的文件边界

| 类别 | 文件 | 规则 |
|---|---|---|
| ✅ 新增（自由） | `web/human/**`（本次所有新代码/资源） | 新目录，互不侵入 |
| ✅ 新增 | `tools/*.mjs`、`docs/*.md` | 只增不改 |
| ⚠️ 最小改动（可回滚） | `web/gs-viewer.html` 增加 2 行（`modulepreload` + `script type=module`） | 必须能一行注释还原 |
| ❌ 禁止 | `web/viewer/index.js`、`web/app.js`、`web/editor/**`、`serve.py` | 原核心，不得改 |

## 9. 硬件与浏览器（实测）

| 项 | 值 |
|---|---|
| GPU | NVIDIA GeForce RTX 3070（驱动 32.0.15.8129）+ Intel UHD 630 |
| Chrome | `C:\Program Files\Google\Chrome\Application\chrome.exe` |
| Node | v22.22.2 / npm 10.9.7（仅 `registry.npmmirror.com` 可用，~1 MB/s） |
| 网络 | `api.github.com` ✅；`raw.githubusercontent.com` ❌(502)；`ghproxy.net` ✅ 但 ~11 KB/s；`repalash.com` ✅ 但 ~25–40 KB/s；`huggingface.co` ❌；`cdn.jsdelivr.net` 部分可达 |

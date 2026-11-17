# web/engine —— 渲染引擎适配层

把「渲染框架」（查看器 + 三维标注编辑器）与「具体引擎」（PlayCanvas / Babylon.js / three.js）解耦。

## 目录结构

| 文件 | 职责 |
| --- | --- |
| `engine-adapter.js` | **契约层**：定义 31 个引擎无关方法（6 组），含矩阵约定与参数语义。纯接口，无引擎依赖。 |
| `playcanvas-adapter.js` | **PlayCanvas 实现**：唯一允许直接引用 `pc.*` 的文件。 |
| `index.js` | **解析入口**：探测当前引擎并装配适配器。编辑器只 import 本文件。 |
| `decal-shaders.js` | 贴花投影 shader 源码（GLSL 算法段跨引擎可复用，WGSL 段为 PlayCanvas 专有）。 |
| `babylon-adapter.md` | Babylon.js 接入的**可执行规格**（本轮未实现，含逐方法对照表与深度语义差异分析）。 |

## 设计约束

1. **契约层零引擎依赖**：`engine-adapter.js` 不 import 任何引擎包，也不出现 `pc.*` / `BABYLON.*` / `THREE.*`。
2. **实现层零泄漏**：`web/editor/` 目录内不出现任何引擎专有类型（`pc.Mesh` / `pc.Material` / `pc.Entity`）。
   校验命令：

   ```bash
   grep -rn "globalThis\.__pc\|playcanvas\|pc\.\(Mesh\|Material\|Entity\|Texture\|Mat4\|Quat\)" web/editor/*.js
   ```

   预期命中数：**0**（仅注释提及路径时除外）。
3. **参数只用内建类型**：`number` / `string` / `boolean` / `Array` / `TypedArray` / 普通对象。
   纹理与材质以「不透明句柄」传递。
4. **矩阵约定显式化**：契约内所有 4×4 矩阵一律「列主序 + 列向量约定（v' = M · v）」的
   `Float32Array(16)`。Babylon.js 内部是行主序 + 行向量，**其适配器必须转置后再返回**。
5. **契约全覆盖**：适配器必须实现全部 31 个方法；`createEngineAdapter` 会校验，
   缺失方法被替换为抛错桩，并在 `__contractReport` 中列出 `missing` 清单。

## 契约分组速查

| 组 | 数量 | 覆盖内容 |
| --- | --- | --- |
| `lifecycle` | 8 | 引擎类型、就绪判定、渲染尺寸、DPR、后端类型、渲染钩子、GPU 错误订阅 |
| `scene` | 5 | 场景句柄、相机节点、相机位置、逆 view×projection、近远裁剪 |
| `material` | 4 | 着色器材质创建、参数设置、销毁、混合与深度状态 |
| `texture` | 4 | 画布纹理创建、内容更新、尺寸查询、格式查询、销毁 |
| `geometry` | 5 | 全屏 quad、可渲染实例、加入/移出绘制层、可见性 |
| `picking` | 6 | 深度拾取视图、拾取后端标识、实例标志、刚体矩阵合成、矩阵求逆、四元数旋转向量 |

完整清单（含每个方法的参数、返回类型与语义）见 `engine-adapter.js` 的 `ADAPTER_CONTRACT`。

## 接入新引擎的步骤

1. 新建 `web/engine/<name>-adapter.js`，`export function create<Name>Adapter(opts)`。
2. 逐条实现契约的 31 个方法（矩阵记得转置）。
3. 在 `web/engine/index.js` 的 `resolveEngineAdapter()` 加一个分支。
4. 跑 `node tools/verify_editor.mjs`，适配层契约断言应保持全绿。
5. 跑像素级贴花验收（见 `tools/probe_decal_video_pixel.mjs`），四项指标阈值与 PlayCanvas 路径同口径。

## 当前状态

- PlayCanvas（v2，2.23.3）：**已实现**，为当前生产引擎。
- Babylon.js：规格已就绪（`babylon-adapter.md`），实现待下一阶段。
- three.js：仅在 `index.js` 中留探测位。

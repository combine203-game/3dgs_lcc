# 视频投射（GPU 贴花）技术实现细节与问题判断

> 目的：把当前实现的**完整技术链路**摊开写清楚，据此判断「投射结果错误」到底出在哪个环节。
> 这是一份**审计/诊断文档**，不是结论文档。所有数字来自 `tools/probe-real-report.json` 真机实测。
> 日期：2026-11-17

---

## 0. 先说三个关键事实（决定了后面怎么看）

1. **之前的验收口径有根本盲点**：`probe_decal_realpath.mjs` 的 5 项指标（覆盖率 / 填充比 / 主色相差 / 孤立点率 / OBB 外溢出）量的全是「有没有像素变化、颜色像不像、有没有画出盒外」——
   **没有任何一项验证「视频投在了正确的那一个表面上、形状/朝向/比例对不对」**。
   所以「5 项全 PASS」和「用户看到的结果是错的」完全可以同时成立。这一点必须先承认。

2. **shader 重建数学误差 0 是「同义反复」，不代表结果正确**：`diag_decal_pair.mjs` 证明的是
   「shader 用 `surfaceDepth` 口径重建的世界点 == 引擎 `picker.pick()` 用同一口径返回的世界点」。
   两者用**同一个深度源、同一套数学**，当然逐像素相等。这个结论只能证明「shader 忠实复刻了深度源」，
   **不能证明深度源给的那些点就是用户想贴的表面**。

3. **截图直接显示错误现象**：`tools/probe-real-visible.png` 中蓝白斜纹同时涂在
   **台阶立面 + 不锈钢栏杆 + 地面 + 花坛灌木** 上——一个正确的贴花不该穿透到前景栏杆和灌木。

---

## 1. 完整技术链路（五步）

### ① 交互：屏幕框选
文件：`web/editor/editor.js`、`web/editor/picking.js:unprojectRect`

- 用户 Shift+R 拖框 → 屏幕归一化矩形 `rect = [u0,v0,u1,v1]`（CSS 像素 / canvas 尺寸）。
- 真机样例：`rect = [0.34, 0.52, 0.56, 0.72]` → 设备像素 `[646,510,418,196]`。
- 对矩形取 `7×7 = 49` 个采样点，逐点做深度反算。

### ② 深度反算：屏幕点 → 世界表面点
文件：`web/editor/picking.js:depthUnproject`（:399-426）

- 每个采样点调 `picker.pick(x/cssW, y/cssH)`，走引擎 3DGS 高斯深度拾取。
- 引擎深度口径（`web/viewer/index.js:surfaceDepth` :87622）：5×5 邻域圆盘（13 texel）× 4 次随机试验，
  取 30% 分位数；返回**归一化线性深度** `nd`，`1.0 = 无表面`。
- 再由 `getWorldPoint`（:87452）反投影成世界坐标：`ndcZ = far*nd/(nd*(far-near)+near)`，
  乘 `inv(viewProj)` 得世界点。
- 49 点深度源真机实测 `stats:{depth:49}`——**全部来自 3DGS 深度，没有走 mesh 兜底**。

**这一步的关键问题**：49 个点分属**不同深度的表面**。真机报告只存了 4 个样例点，Z 分别是
`8.84 / 4.26 / 4.79 / 5.41`，跨度 **4.58 米**——既有近处的栏杆/台阶，也有远处的地面。
代码对此**不做任何深度不连续检测或分割**，把跨多个物体的点当成一个连续表面。

### ③ 几何：49 点拟合投影机 OBB
文件：`web/editor/schema.js:buildDecalProjector`（:537-617）

- 中心 = 49 点均值。
- 局部基：`right = 框选水平方向`（`colMid(nu) - colMid(0)`），`up = 竖直方向`，`法向 = right × up`，
  法向按 `toward`（相机位置）翻到朝向观察者一侧，再正交化（`up = nrm × right`）。
- 把 49 点投到局部基，取轴向范围：`halfX/halfY/halfZ = (max-min)/2 + 0.05`。
- **盒厚（致命处）**：
  ```js
  const wantDepth = Number(opts.depth);                    // 面板 decalDepth，默认 0.5
  const depth = Math.max(0.2, wantDepth||0, halfZ * 2);    // ← halfZ*2 把盒撑厚
  half = [halfX, halfY, Math.max(halfZ, depth / 2)];
  ```
- 真机实测：`half = [2.08, 1.08, 1.99]`，`depth = 3.99m`。
- **与技术路线文档 §3.2 的约定直接冲突**：文档要求 `d ≈ 0.3~0.8m`（浅盒，避免穿透到盒后物体），
  实现却因 `halfZ*2` 让盒厚等于「表面深度跨度」= 3.99m。

### ④ 渲染：全屏 quad + 逐像素 shader
文件：`web/engine/decal-shaders.js`（GLSL/WGSL 双后端）、`web/editor/decal-projection.js`

- **几何**：一个全屏 quad（2 分量顶点，`setPositions(...,2)`，`node.setLocalScale(2,-2,1)`），零场景几何生成。
- **深度源**：复用引擎 Picker 的 RGBA16F 深度纹理（4 通道 = 4 次随机试验，`1.0=空`），
  在 `frameend` 取回，`prerender` 注入 uniform。不另开深度 RT。
- **片元算法**（逐像素）：
  1. `frag → uvTL`（uUVSignY/uUVOffsetY 按后端）
  2. `pickUV = 按 uPickFlipY 处理行序`（WebGPU 行0=顶，WebGL 行0=底）
  3. `nd = pickSurfaceDepth(pickUV)`——5×5 圆盘 13 texel × 4 通道，取 30% 分位，部分选择排序排到 k（含 k）
  4. `world = worldFromPick(pickUV, nd)`——复刻引擎 `getWorldPoint`
  5. `L = invProjector * world`——世界点转到 OBB 局部
  6. `ln = L / (decalHalf * uBoxScale)`，`uBoxScale = 1.0`（盒面 |ln|=1 整框命中）
  7. **盒内判定**：`|ln.xy| ≤ 1 且 |ln.z| ≤ 1`，否则 discard
  8. 背面剔除（`pickFastDepth` 差分求法向，与投影法向点积 < -0.25 才剔除，软剔除）
  9. `uv = ln.xy*0.5+0.5` → `texelFetch` 采样视频（1024×576 固定尺寸，URL 空则用内置动画条纹）
  10. `a = vid.a * opacity * edge`（smoothstep 边缘软过渡）→ `BLEND_NORMAL` 叠加（depthTest=false, depthWrite=false）

- **关键**：第 7 步 `|ln.z| ≤ 1` 用的是第 ③ 步那个 3.99m 厚的盒——法向方向 ±1.99m 内的
  **所有表面都会被涂色**，不区分是不是用户框的那个表面。这与截图现象完全吻合。

### ⑤ 生命周期与降级
- 实例 Map（id → material/renderable/video/texture）；`sync()` 增删实例；`frameend` 逐帧上传视频帧。
- GPU 错误归因：`pushErrorScope/popErrorScope` + 关贴花复测二分，只有贴花作用域内的错才降级；
  引擎自身的 VertexState 错误归为 `foreignErrors`，不误降级。
- 该机制工作正常（真机 `degraded=false`），**不是本次问题的原因**。

---

## 2. 问题判断（按嫌疑度排序）

### 🔴 P0-1：盒厚被深度跨度撑爆 → 贴花穿透到多个表面（首要嫌疑）
- **现象**：斜纹同时出现在栏杆、台阶、地面、灌木上。
- **证据**：49 点深度跨度 4.58m → `halfZ*2 = 3.99m` → shader `|ln.z|≤1` 覆盖法向 ±1.99m。
- **根因**：`schema.js:610` 的 `depth = max(..., halfZ*2)`。设计意图是「盒要包住整个表面」，
  但当用户框选跨越**深度不连续**的多个物体时，这个「表面深度跨度」变成了 4m，盒变成了穿透盒。
- **对照**：技术路线文档 §3.2 明确要求浅盒 0.3~0.8m。实现偏离了自己的设计文档。

### 🔴 P0-2：验收口径量不到「空间正确性」
- 5 项指标全是统计量，无法区分「贴在正确的单一表面」和「涂满整个盒内所有表面」。
- 覆盖率 96.4% 恰恰说明贴花**画得很多很满**——如果它只该贴一块，画满 4 个表面反而是缺陷。
- 这是「为什么之前全 PASS 但结果错」的直接答案。

### 🟠 P1-1：深度不连续无处理
- `unprojectRect` 把跨物体的 49 点当连续表面；`fillGridGaps` 只补空值，不做异常点剔除/表面分割。
- 用户框选时很容易框到「栏杆 + 后面的墙」这种前后叠加区域。

### 🟠 P1-2：法向可能来自混合深度
- 局部基由跨表面的点算 `right/up`，法向是「平均朝向」，不贴合任何真实表面；
  背面剔除和 UV 朝向都可能偏。

### 🟡 P2：UV 随 fat box 拉伸
- `uv = ln.xy*0.5+0.5` 映射到 2.08×1.08m 的盒面，视频被拉到这个尺寸；盒越大拉伸越明显。

---

## 3. 待确认与修复方向（一起判断）

**需要你确认的现象**（决定修复优先级）：
1. 错误是「视频涂到了不该涂的表面（栏杆/灌木）」——支持 P0-1？
2. 还是「视频内容本身变形/朝向不对/位置不对」——更偏 P1/P2？
3. 还是「某些视角下整个贴花消失或闪烁」——另需查深度源时序？

**可选修复方向**（确认后再动手）：
- A. **回退浅盒**：删掉 `halfZ*2`，盒厚固定用 `decalDepth`（默认 0.5m，可给 0.3~0.8m）。
  好处：立刻不穿透；代价：若表面本身起伏 >0.5m，远处部分可能出盒。
- B. **深度分割**：在 `unprojectRect` 检测深度跳变，只对主表面（占比最高那一簇）建盒。
- C. **深度一致性测试**：shader 里比对重建点深度与 `surfaceDepth`，只涂「盒前表面附近」那层。
- D. **物体 ID / stencil 限定接收面**（改动最大，3DGS 需额外 RT）。

我倾向 **A + B 组合**：先把盒厚收回浅盒止血，再对深度不连续做主表面聚类。等你的现象确认。

---

## 4. 修复尝试与真机对照实验（2026-11-17）——推翻 A+B，锁定真正根因

按用户「尝试修复」指令，实施了 A+B（浅盒 + 主表面聚类），并做了 3 组真机对照实验。
**结果：A+B 让结果更糟，已全部回退。** 关键数据如下（真机桌面 Chrome + WebGPU，`--headed`）：

| 方案 | 盒心 position | half[2] | 斜纹实际落点 | 选中区覆盖率 |
|---|---|---|---|---|
| 原始（深盒 1.99m） | [1.49, 1.10, 6.42] | 1.99 | 台阶+栏杆+花坛+灌木（涂满，但有穿透） | 0.964 |
| A+B（聚类+浅盒） | [0.63, 0.74, 6.75] | 0.25 | **跳到花坛、柱子、地面**（更糟） | 0.197 |
| A-only（仅浅盒） | [1.49, 1.10, 6.42] | 0.25 | **只剩栏杆扶手几条细线**（更糟） | 0.030 |

日志：`tools/realpath-fix-verify.log`(A+B)、`tools/realpath-ab-nocluster.log`(A-only)。

### 4.1 为什么 A+B 失败：盒心/法向本就是为配合深盒而算的

- 浅盒 A-only 下盒心不变，但斜纹只剩栏杆扶手 —— 说明**台阶表面根本不在盒心附近的薄层内**；
- 原始深盒之所以"看起来覆盖台阶"，是靠 1.99m 厚度**穿透**到了栏杆后面的台阶 —— 歪打正着；
- 聚类 B 把盒心从台阶 [1.49,1.1] 拉到花坛方向 [0.63,0.74]，因为"到相机距离"聚类把沿视线连续延伸的台阶错误分组。

### 4.2 ★ 决定性根因：3DGS 深度拾取返回的全是栏杆，不是台阶

导出完整 49 点（`tools/realpath-fullpts.log`，探针加 `--full-pts`）后真相大白。
把点投到 X–Y 平面，它们聚成 **12 条竖直线**：X 固定在离散值（-0.86/-0.34/0.20/0.54/0.83/1.06/1.24/2.83…），
每条线的 Y 从 0.1 贯穿到 1.5m，Z 随距离缓变（4.26~8.84m）。

**这是栏杆立柱的空间特征，不是连续台阶面。** 用户框选台阶区域，但：

```
depthUnproject() → picker.pick(u,v) → 引擎 RendererPicker.surfaceDepth()
   → 3DGS 深度纹理里那个像素的 30% 分位深度 → 最近的不透明表面 = 栏杆
```

3DGS 渲染中栏杆是不透明的，深度拾取命中**最靠近相机的栏杆**，拿不到栏杆后面的台阶。
49 点全部落在栏杆上 → OBB 拟合的是栏杆 → 深盒靠厚度穿透到台阶（歪打正着），
浅盒忠实贴在栏杆上（只剩扶手细线）。**问题不在投影机算法，在深度源。**

这也解释了为什么上一轮「shader 重建误差 0」是对的却没用：shader 忠实重建了深度源给的栏杆点，
但用户想贴的是台阶 —— 深度源本身就选错了表面。

### 4.3 ★ 方案 E（换碰撞 mesh 深度）真机验证：不可行

用户选择方案 E 后，写了 `tools/diag_collision_depth.mjs` 做对照诊断：
对同一框选区 49 点，分别用 3DGS 深度拾取（`depthUnproject`）和碰撞 mesh 射线
（`viewer.collision().queryRay`，72.5 万三角形）取命中。结果（`tools/diag-collision-depth.json`）：

| 深度源 | 有效点 | X 范围 | Y 范围 | Z 范围 | 离散 X 列数 |
|---|---|---|---|---|---|
| 3DGS 深度拾取 | 49/49 | -0.86~2.83 | 0.10~1.54 | 4.26~8.84 | 12 |
| 碰撞 mesh 射线 | 49/49 | -0.87~2.81 | 0.10~1.54 | 4.17~8.78 | 12 |

两者**几乎完全相同**（差几厘米）。结论：碰撞 mesh 是 XGrids LCC 重建的精细网格
（72.5 万三角形），**栏杆也在碰撞网格里**，射线同样命中栏杆，拿不到后面台阶。
**方案 E 被真机数据否决，不实施。**

### 4.4 补充证据：49 点屏幕位置正确，空间上不共面

`tools/diag-points-overlay.png` 把 49 点投影回截图（红点 + 黄框）：
- 红点**均匀填满用户框选区**（屏幕 X 430–708 / Y 340–470 CSS），拾取位置完全正确；
- 但按屏幕列看深度：第 0 列 Z≈8.8、第 1 列 Z≈4.2、第 6 列 Z≈7.2 —— **每根竖直栏杆柱
  占一个屏幕列，列间深度差达 4.6m**（见 `diag-collision-depth.json` 的逐行 Z 表）；
- 即框选区被若干**空间上不共面的栏杆柱**覆盖。3DGS 与碰撞 mesh 两种深度源都忠实返回
  这些栏杆表面 —— **深度拾取没错，错在「用单一 OBB 去贴合多个不共面的表面」**。

修正 4.2 节措辞：不是"深度源选错表面"，而是"框选区本身横跨多根不共面栏杆，
没有任何单点深度能代表它"。上一轮"shader 重建误差 0"仍成立且有意义，只是单一 OBB
这个**表示模型**能力不足，无法同时贴合多表面。

### 4.5 剩余可行方向（需用户拍板）

- **F. 多层深度拾取 / 深度剥离**：引擎深度纹理支持取第 2/第 3 层命中，跳过前景栏杆。
  改动最大（改引擎 bundle），但唯一能拿到栏杆后表面的通用方案。
- **G. 深度一致性剔除**：保持深盒，shader 里对"与局部拟合平面深度偏差过大"的像素
  （前景栏杆）做剔除，只保留占多数的那层表面。中等改动，需调阈值；对斜台阶边缘可能误伤。
- **H. 使用方式规避**：框选时避开栏杆、只框纯墙面/纯台阶 —— 非代码方案，验证成本最低，
  可先确认"只要框选区共面，现有算法就正确"。

**当前代码状态：已全部回退到原始版本**（`git checkout` 恢复 schema.js/editor.js/verify_editor.mjs/probe），
工作区只新增诊断文档与探针脚本。未留半吊子改动。等用户确认方向后再实施。

---

## 5. 室内墙面 + 疯狂闪烁复测（2026-11-17，推翻「深度抖动」假设）

用户把测试目标从栏杆改到一楼室内**平面墙面**，问题依旧且新增**整屏疯狂闪烁**。
平面墙是单一共面、无遮挡的理想情形——若 4.4 节「多表面 OBB 贴不住」是唯一根因，此处应当成功。
它没有，说明还有别的机制。于是做了两组真机诊断。

### 5.1 整屏闪烁定位（`tools/diag_flicker.mjs`，相机全程静止）

连续抓 6 帧量「帧间整屏像素差 MAD」：

| 状态 | MAD | 变化像素 | 说明 |
|---|---|---|---|
| A 无贴花基线 | 0.00 | 0% | 场景本身绝对稳定 |
| B 贴花可见（demo 模式 `url:''`） | 24.14 | 7.4% | 剧烈闪烁 |
| **B2 `debugMode=1`（shader 只输出深度灰度、完全不采样视频）** | **0.00** | **0%** | **深度链路稳定，不闪** |
| B3 冻结视频时间（`debugMode=0`） | 24.39 | 7.5% | 仍闪，冻结未生效 |
| C 贴花隐藏（管理器仍在跑帧钩子/requestRender） | 0.00 | 0% | 无限渲染循环本身不闪 |
| D 销毁 decalMgr | 0.00 | 0% | 基线 |

**关键陷阱**：第一版 B2 用 `manager.setOptions({debugMode:1})`，但它只改全局 `options`，
shader 实际读的是 `inst.debugMode`（:390），后者只在 `sync()`（:264）里从 options 拷贝，
而 sync 只在 store 变化时触发、**不是每帧**。所以第一版 B2 根本没生效（仍在播 demo），
得到 MAD=24 的假象。改成直接 `instances.forEach(i=>i.debugMode=1)` 后，MAD 立刻归零。

**结论**：闪烁 100% 来自**视频纹理内容逐帧变化**，与深度重建、pick 纹理、相机矩阵、渲染循环全部无关。

### 5.2 逐帧内部状态探针（`tools/diag_pick_stability.mjs`）

相机静止、贴花可见、`debugMode=1` 下连续采样 8 次：

- `pv.renders = 2`（恒定）→ picker snapshot 未重绘；
- `pickHash = 4136991064`、`sampleVals`（4×4 块原始半精度值）全程一致 → **pick 深度纹理内容不变**；
- `projHash / viewHash / invHash / camPos` 全部唯一值个数 = 1 → **相机矩阵与位置不变**。

与 5.1 的 B2（MAD=0）互相印证：**深度链路在相机静止时完全确定、逐帧一致**。

### 5.3 闪烁的真实来源（不是产品 bug）

`drawDemoFrame(now)`（`decal-projection.js:185`）用 `(now/1000)%4` 与 `off=(t*48)%64`
画**故意滚动的斜条纹测试图**；`onFrameEnd`（:329）每帧把它上传成视频纹理。
所以 demo 模式（`media.url===''`）**本来就是动画**，MAD=24 是预期行为，
**不是产品缺陷**。真实视频（`media.url` 非空）本来也逐帧变化，闪烁与否取决于视频内容本身。

→ 「疯狂闪烁」这条线索对定位「投射结果错误」**没有诊断价值**，应丢弃。

### 5.4 室内墙面「只有框线没视频」——根因确认并修复（已完成）

用户澄清：室内墙面用**内置 demo 画面**，现象是**只有框线没有视频**（不是位置/朝向错）。
真机探针 `tools/diag_indoor_spread.mjs` 直达一层室内机位（`?view=floor-1.html&edit=1`，
相机 [18.502, 2.47, 17.075]），对实际框选区 `rect=[0.3,0.42,0.72,0.78]` 做 49 点深度反算：

```
src=depth(48)+mesh(1)  min=6.46  p10=7.04  med=12.4  p90=16.29  max=24.11
min/max 口径 spread=(24.11-6.46)/12.4=1.424 > 1.2  → 被 editor.js:683 拦截
```

**根因**：`rebuildDecalProjector()`（editor.js:683）用 **min/max** 算深度跨度并拦截。
室内墙面 49 点里 1 个点深度拾取失败退化到碰撞网格 / 落到前景近物（6.5m），少数离群点
把 max 拉到 24m，`spread>1.2` → **直接 return，不生成 projector** → getDecals() 过滤掉
（`editor.js:209` 要求 a.projector）→ shader 不渲染 → **只剩 Overlay 画的框线**。
重建后状态栏实测就是「框选区域深度跨度过大（近 6.5m ~ 远 24.1m）」。

**修复**（`web/editor/editor.js`，仅此一文件，+15/-4）：把跨度判断从 min/max 改为
**鲁棒分位数 p10~p90**：`spread=(p90-p10)/med`。室内墙面 `(16.29-7.04)/12.4=0.75 < 1.2`
→ 放行；真正横跨多表面的场景分位数跨度仍大 → 仍拦截。离群点不再主导判断。

**验证**（真机 + 回归）：
- 修复后重建：`hasProj:true`，状态栏「已生成投影机 OBB · 宽 10.87m × 高 17.84m」，
  `instances:1 / pickReady:true / gpuErrors:0 / degraded:false`；
- 截图 `tools/indoor-fixed.png`：DEMO 蓝白条纹**确实贴在室内波浪墙/接待台墙面上**，
  不再是空框线；
- `tools/verify_editor.mjs` 回归 330 PASS / 0 FAIL。

**最终结论**：整个「投射错误」排查链里，真正的产品缺陷只有一个 —— **深度跨度拦截对
离群点不鲁棒，误杀室内平面墙**。此前怀疑的 stochastic 深度抖动、OBB 多表面表示力、
深度源选错、shader 行序等均被真机证据排除。工作区仅 `web/editor/editor.js` 有改动。

---

## 6. 性能问题：贴花拖垮 GPU / 整屏闪烁（2026-11-18）

用户反馈：延迟贴花**性能非常差**；一楼室内测试时，**有些情况下视频没出来，导致整台
电脑屏幕都在闪烁（不止浏览器）**。注意「整屏闪烁（含桌面）」是 **GPU 驱动级 TDR 超时
重置**的典型症状，不是普通 shader 动画，必须按 GPU 过载处理。

### 6.1 真机量化（`tools/diag_decal_perf.mjs`，室内机位，24 帧 rAF 间隔）

修复前：

| 状态 | 中位 | p90 |
|---|---|---|
| A 贴花可见 + depthMode=1（52 值排序） | **25.6ms** | 45.4ms |
| B 贴花可见 + depthMode=0（单 texel 中位） | 14.5ms | 54ms |
| C 贴花隐藏 | 17.1ms | 19.5ms |

慢路径比「隐藏贴花」中位慢 50%、p90 慢 2.3 倍。叠加上次放宽 spread 后室内 OBB 达到
`half=[5.43, 8.92, 3.32]`（约 11m×18m，覆盖大半屏幕），海量像素进入昂贵路径 →
弱 GPU 单帧超时 → TDR → 整屏闪。

### 6.2 根因（代码事实，三处叠加）

1. **全屏 quad 每像素跑 52 值选择排序**：`main()` 里 `nd = pickSurfaceDepth()` 在
   `discard` 之前计算，即使像素最终被丢弃也照算；`pickSurfaceDepth` 取 13 texel ×
   4 通道 = 52 值，部分选择排序约 400 次比较/像素。
2. **WGSL `select()` 双求值**：`select(pickFastDepth(), pickSurfaceDepth(), cond)` 的
   两个参数**都会被求值**，所以 WebGPU 下即使切 fast 模式也照样跑排序（B 态 p90
   反而 54ms 佐证）。
3. **无空间早退**：盒外像素（占全屏大多数）没有被提前剔除。

### 6.3 修复（`web/engine/decal-shaders.js` + 回归守卫）

- **fast 粗筛早退**（GLSL/WGSL 对称）：先用单 texel 中位 `pickFastDepth` 重建世界点，
  `ndFast>=1` 或落在 OBB 外（**放宽 1.5 倍**，只做排除、绝不误杀）直接 `discard`，
  不再进入 52 值排序。盒外像素开销从 ~400 比较降到 1 texelFetch + 1 矩阵乘。
- **WGSL `select` → `if/else`**：真正让 fast 模式跳过排序。
- **debugMode=1 复用 fast 值**：深度灰度诊断无需精确排序。
- 回归新增性能护栏断言（`verify_editor.mjs`），并更新深度口径切换断言以匹配新语义。

### 6.4 验证

修复后同样测量：

| 状态 | 中位 | p90 |
|---|---|---|
| A 贴花可见 + depthMode=1 | **16.5ms** | 42.8ms |
| B 贴花可见 + depthMode=0 | 17.2ms | 39.8ms |
| C 贴花隐藏 | 16.7ms | 18.5ms |

A 态中位 25.6 → **16.5ms**，与「隐藏贴花」基线（16.7ms）持平 —— 慢路径的额外开销
基本消除。`tools/indoor-fixed.png` 复拍确认视频仍完整连续贴在墙面（粗筛未误杀）；
`verify_editor.mjs` 回归 **331 PASS / 0 FAIL**；`gpuErrors:0 / degraded:false`。

**剩余风险**：A 态 p90 仍有 42.8ms 尖峰（C 态也有波动，属测量噪声/视频纹理上传）。
若弱机仍偶发闪烁，下一步可做「相机+视频静止时暂停 `requestRender()` 空转」的降频守卫，
但改渲染循环风险较高，本轮未动。工作区改动：`editor.js`（分位数修复）、
`decal-shaders.js`（性能护栏）、`verify_editor.mjs`（守卫）。

### 6.5 架构反思：52 值排序本身是错误路线的产物（未执行，待决策）

用户质疑「为什么要进行像素排序，实现的技术路线有问题」——**此判断成立**。

**排序的由来**：3DGS 的 Picker 深度纹理是 stochastic 的（RGBA 4 通道 = 4 次随机
试验）。引擎 `surfaceDepth()`（index.js:87622）用 13 texel × 4 trial = 52 样本排序取
30% 分位去噪，但它本是 **CPU 单点**调用（`pick(x,y)` 一次鼠标点击算一次）。贴花 shader
为求「与引擎同口径」，把这段 CPU 代码**逐像素移植到全屏 quad** → 52 值排序从
「1 次/点击」变成「200 万次/帧」。

**核心矛盾**：噪声是这条路线自己引入的，排序在消除自己制造的噪声。框选阶段
`unprojectRect` 的 49 个世界点**已经过 `surfaceDepth()` 去噪**，OBB 就是拟合它们得来；
渲染阶段却丢弃 OBB，逐像素重新采样随机深度 → 重新排序 → 重新反投影，把已解决的
问题在最贵尺度上重做一遍。OBB 越大（室内 11m×18m）重做像素越多 = 性能悬崖 + TDR。

**正确路线**：贴花本质是几何 + UV 映射问题，不是屏幕空间统计问题。框选完成时用
49 世界点（或 OBB 前表面 + 单应）**烘焙一次带 UV 的贴片 mesh**，视频作纹理贴上去，
每帧只剩纹理采样 + 遮挡测试 —— 零排序 / 零反投影 / 零 stochastic，同时根治性能、
闪烁、以及「视频随视角游走」。UE Decal Actor / Unity DecalProjector 即此思路。

**为何未立即重构（两点硬约束，需先厘清）**：
1. **历史否决**：第六轮（11-12）正是「切平面 + 向下射线」网格贴面方案（`drapeQuad`/
   `decalGridPoints`），用户判定「完全不可用」才改为第七轮深度反算。注意失败的是
   **贴合方式**（射线打不到起伏墙/误吸天花板），不是「网格承载」本身；第七轮的 49 点
   真实世界点恰好是第六轮缺失的输入。但不能不复核就直接回退。
2. **适配器能力**：`playcanvas-adapter.js` 目前只有 `createFullscreenQuad()`（内部
   `setPositions(Float32Array, 2)`），**无通用 mesh 创建接口**。烘焙贴片需先扩展
   `engine-adapter.js` 契约 + 两个后端实现，属架构级改动。

**当前决策**：保留 6.3 的性能护栏补丁（已真机验证可用、331 PASS）。重构为「烘焙贴片」
是正解但需：① 扩展适配器 mesh 接口；② 用第七轮 49 点重做第六轮失败的贴合；③ 处理
无 GBuffer 下的遮挡（一次性 picker 深度快照或轻微 lift）；④ 全量回归。未获明确授权前
不动架构，避免重蹈「盲改→更糟→回退」覆辙。

---

## 7. 技术路线切换：shadow map 式虚拟相机投射（已实施）

用户进一步明确要求：不要继续优化「全屏逐像素排序」，改为 **shadow map 原理**——
交互时用一个虚拟相机定义投射视锥；虚拟相机生成深度图；主相机像素反投影到世界点，
再变换到虚拟相机空间与深度图比较；通过的像素换算成虚拟相机 UV 采样视频。
此要求取代了 6.5 中「烘焙贴片 mesh」的备选路线。

### 7.1 实现链路

1. **虚拟相机与深度图**（`web/editor/schema.js`）
   - `buildShadowDepthMap(projector, raycast, { n:24 })`：由 projector OBB 的正交基构造
     虚拟相机，位置 `position + normal*(half.z+margin)`，视线 `-normal`，`far` 覆盖整盒；
     在每个纹素中心从虚拟相机沿视线投射碰撞 mesh，写入归一化深度（1.0 = 空）。
   - 深度只在 projector 变化时算一次，返回 `{ n,size,depth,vcam,right,up,normal,far,hits }`。
   - `depth` 用**普通数组**返回而非 `Float32Array`：标注文档要经 `JSON.stringify` 落
     localStorage，typed array 会变成 `{"0":...}` 对象，刷新后上传纹理会静默失败
     （「第一次能贴，刷新后只有框线」）。
2. **编辑器装配**（`web/editor/editor.js`）
   - `rebuildDecalProjector()` 在 OBB 拟合成功后调用 `buildShadowDepthMap`，raycast 走
     `window.__viewer.collision().queryRay` + `rayHitMesh`；失败则 `shadow=null` 回退旧路径。
   - 状态栏显示 `深度图 24²（N 命中）`；`ensureDecalProjectors()` 对旧 projector 无 shadow
     的情况补算一次；`getDecals()` 把 `shadow` 透传给渲染层。
3. **纹理契约**（`web/engine/engine-adapter.js` / `playcanvas-adapter.js`）
   - 新增 `createDataTexture` / `updateDataTexture`；PlayCanvas 实现用 `PIXELFORMAT_R32F`
     + `texture.lock().set(data).unlock()`（引擎灯光/聚簇纹理同款写法）。
   - `syncShadow()` 把 JSON 反序列化后的普通数组/对象统一转成 `Float32Array` 再上传。
4. **Shader**（`web/engine/decal-shaders.js`）
   - GLSL/WGSL 对称新增 `decalShadow()`：主相机像素 `pickFastDepth` → 世界点 W →
     `(u,v,dW)` → 与 `shadowDepth` 比较 → 通过则 `uv=(u,v)*0.5+0.5` 采样视频。
   - 热路径只有 **1 次 pick 纹理采样 + 1 次 shadow 纹理采样**，不再调用 52 值排序。
   - 保留旧 OBB 分支作为无 shadow 时的回退；恢复 `uBoxScale` 归一化、`uv` 边缘
     `smoothstep`、以及默认关闭的深度差分法向背面剔除（默认开关语义不变）。
   - `uShadowBias=0.05`，由 `decal-projection.js` 在 `onPrerender` 注入。

### 7.2 验证结论

- **静态回归**：`node tools/verify_editor.mjs` = **337 PASS / 0 FAIL**。
  原有 331 条中 4 条因新路线删除旧写法而失败，已按真实不变量恢复（不是放宽断言），
  另新增 `[36] shadowmap 贴花架构守卫` 6 条（深度图构造、JSON 持久化、R32F 契约、
  shader 判定、热路径无排序、uniform/调试字段）。
- **离线深度口径**（`tools/diag_shadow_verify2.mjs`）：
  - synthetic 同口径 diff med=0.0166 / p90=0.0284；
  - 主相机 mesh 点跨源 diff med=0.0031 / p90=0.0082 / max=0.0449。
- **真机室内（一楼墙面，非截图路径）**：
  - projector half≈[2.00,1.35,0.68]，shadow `24²`、`hits=576/576`，`shadowReady=true`；
  - `degraded=false`；无截图干扰的运行中 `gpuErrors=0`；
  - 49 个框选点的 3DGS 深度世界点与 shadow 深度图跨源比较：
    |abs diff| med=0.0025 / p90=0.0074 / max=0.0305，49/49 通过 bias=0.05。
- **性能**：旧 52 值路径此前实测中位 25.6ms；加 fast 粗筛后 16.5ms；新 shadow 热路径
  已去掉排序，但本轮 `diag_decal_perf.mjs` 出现 48s 级异常帧与后续超时，数据不可用于
  精确对比，需后续在稳定会话复测。

### 7.3 已知限制（不要当作验证通过）

- 当前 headful WebGPU 会话中，CDP 截图会触发引擎自身的
  `Vertex attribute slot 0 ... is not present in the VertexState` 与 Invalid RenderPipeline，
  主画面变黑；**shadow 与强制旧路径均复现**，与贴花 shader 无关。因此本轮无法用
  `probe_decal_realpath.mjs` 的像素覆盖率作为 shadow 路线通过证据。
- headless SwiftShader 下 picker 退化为 mesh，同一矩形被判为 10.66m×18.40m 巨盒并拦截，
  也不能作为该矩形的验收口径。
- 因此当前证据链为：**静态守卫 + 离线深度口径 + 真机 shadowReady/深度差**，
  尚缺「室内墙面视频像素覆盖」的可重复截图证据。该缺口已明确记录，不编造通过结论。

### 7.4 本轮改动文件

`web/editor/schema.js`、`web/editor/editor.js`、`web/editor/decal-projection.js`、
`web/engine/engine-adapter.js`、`web/engine/playcanvas-adapter.js`、
`web/engine/decal-shaders.js`、`tools/verify_editor.mjs`、
`tools/probe_decal_realpath.mjs`（新增 `--view` / `--rect` / `--force-legacy` /
`--no-from-surface` 诊断开关）。

---

## 8. 无头复验：GLSL 编译缺陷与证据链重建

### 8.1 找到并修复的真实缺陷（WebGL2 回退路径整块贴花不渲染）

强制 WebGL2（`?renderer=webgl` 对 iframe 无效，改用同源
`sessionStorage.mg_fallback=1` 注入）后，控制台出现：

```
Failed to compile fragment shader: ERROR: 0:297:
'decalShadow' : no matching overloaded function found
```

根因在 `web/engine/decal-shaders.js`：

- GLSL 定义：`void decalShadow(out vec2 uvOut, out float ndOut, out float diffOut)` —— **3 个参数**，
  `pickUV` 在函数内部由 `gl_FragCoord` 推导；
- GLSL `main()` 却调用 `decalShadow(pickUV, uv, nd, diff)` —— **4 个实参**；
- WGSL 版签名是 `fn decalShadow(pickUV: vec2f) -> vec4f`（1 个参数，返回结构体），
  调用方式不同且正确，所以 WebGPU 主路径从未暴露该问题。

修复：`decalShadow(uv, nd, diff)`。**影响面**：所有走 WebGL2 的机器
（WebGPU 不可用 / 无安全上下文 / 上次回退标记），贴花 shader 根本编译不过，
表现为「框线在、视频始终没有」——与用户早期反馈的现象一致。

### 8.2 回归守卫自身写错，把 bug 固化成「正确行为」

`tools/verify_editor.mjs` 原守卫明确要求
`/decalShadow\(pickUV, uv, nd, diff\)/.test(fragGlsl)`，即把错误调用当成不变量，
所以旧版 338 PASS 也没能拦住。已修正为 3 实参调用，并新增独立守卫：

- `GLSL decalShadow 定义的 out 参数个数与调用实参数一致（防 WebGL2 编译失败）`
  ——校验定义签名、调用点唯一、且不存在 4 参调用。

当前静态回归：**339 PASS / 0 FAIL**。

### 8.3 无头 GPU 读帧不可作为视觉验收证据（已定性）

逐层排查记录，避免后来者重复踩坑：

1. `probe_decal_realpath.mjs --use-dataurl` 原检查
   `url.startsWith('data:image/png,')`，实际前缀是 `data:image/png;base64,`，
   导致明明返回了 1.7MB PNG 却判为失败。已修正。
2. WebGPU 下帧外 `toDataURL` / `Page.captureScreenshot` 会触发 Dawn
   `Vertex attribute slot 0 ... not present in the VertexState`，之后帧缓冲交替全白
   （实测 visible 1.30MB / hidden 16KB / hidden2 1.30MB），差分全部失真。
3. 改 `app.once('postrender')` 在渲染帧内读，WebGL2 下三帧都能读到正常画面，
   但完全相同（原始差分=0）；WebGPU 下 hidden 帧回调直接不触发。
4. 强制 WebGL2 + `debugMode=2`（未命中应整屏红）后，实例 `debugMode=2` 已生效，
   但 GPU uniform 快照仍是 `uDebugMode:0` —— 说明引擎按需渲染下设置后没有新帧，
   读到的是同一帧缓存。**因此「零差分」不能证明贴花没渲染。**

结论：无头环境下无法取得可信的贴花像素差分；此前 0.8885 覆盖率与 0.9572 外溢率
均建立在空白帧之上，**全部作废，不作为通过或失败证据**。

### 8.4 新增纯 CPU 无头算法验证（不依赖 GPU 读帧）

`tools/verify_decal_shadowmap_cpu.mjs` 读取真实探针导出的
`tools/probe-real-report.json`，在 CPU 上复现 shader `decalShadow()` 的数学：

```
① L = rotateByConjQuat(W - projector.position, q)
② ln = L / (half * boxScale)，要求 |ln| <= 1
③ uv = ln.xy * 0.5 + 0.5，要求落在 [0,1]
④ dW = dot(W - vcam, forward) / far；diff = dW - dMap
   要求 -4*bias <= diff <= bias（bias=0.05）
```

实测输出：

```
投影机 half≈[2.71,1.23,0.25]，深度图 24² 有效命中 574/576，far=3.2
① projector 局部盒命中 = 49/49 (100.0%)
② UV 落在 [0,1]      = 49/49
③ shadow 表面判定通过 = 49/49 (100.0%)
diff 分位数 = p10 -0.0070  p50 0.0048  p90 0.0181  允许区间 -0.200..0.050
★ 全部 PASS（4 项）
```

这证明**投影范围与 shadow 表面判定的算法数学正确**：框选的 49 个表面点全部命中，
深度差中位 0.0048 远小于 bias，不存在跨源误杀。

### 8.5 当前证据链

| 证据 | 结果 | 可信度 |
|---|---|---|
| 静态回归 `verify_editor.mjs` | 339 PASS / 0 FAIL | 高（含 GLSL 参数守卫） |
| CPU 算法验证 `verify_decal_shadowmap_cpu.mjs` | 4 PASS，49/49 命中 | 高 |
| WebGL2 shader 编译 | 报错消失（修复后无 `Failed to compile`） | 高 |
| 无头像素覆盖率 / 外溢率 | 作废（空白帧 / 帧缓存） | 无 |
| 真机室内视觉覆盖 | 仍未取得可重复截图 | 缺口 |

**不再宣称像素级视觉验收通过。** 若需闭环最后一项，应在真机用页面内
`postrender` + 强制请求新帧的方式取两帧，或有头环境直接人工确认。

### 8.6 本轮改动文件

`web/engine/decal-shaders.js`（GLSL 调用参数修复）、
`tools/verify_editor.mjs`（守卫纠错 + 新增一致性守卫）、
`tools/probe_decal_realpath.mjs`（dataURL 前缀、变量 TDZ、`--renderer=webgl`、
postrender 读帧、uniform 快照、debugMode 时机）、
`tools/verify_decal_shadowmap_cpu.mjs`（新增）、本文档。

---

## 9. 降噪优化（2026-11-19，真机截图反馈：贴花框内大量蓝色椒盐噪点）

### 9.1 根因（不是投影路线错，是 shadow 判定的采样口径错）

真机鸟瞰截图：投影盒内上部树冠与中线区域密布蓝色椒盐点，并有蓝色三角块外溢。
链路定位：shader `decalShadow` 对 shadow 深度图是**单 texel 硬比较**
（`texelFetch` 一次 → `if (diff>bias||diff<-4bias) return`）。3DGS picker 的深度纹理
在树冠这类稀疏/多层表面会随机命中近点或远点，单 texel 中位仍有米级抖动；
硬阈值把抖动放大成相邻像素 0/1 翻转 → 椒盐。掠射面/侧墙则因深度差偶发吻合被误命中 → 外溢。

### 9.2 落地方案（三件套，全部可开关 A/B）

| 开关（默认） | 机制 | 解决的噪点类型 |
|---|---|---|
| `uPcf=1` | ① 深度 3×3 邻域中位（9 fetch + 5 步选择排序）替代单点；② shadow 3×3 PCF 软覆盖率替代硬比较 | 深度 stochastic 抖动的二值翻转 |
| `uNormalCut=0.90` | 从确定性 shadow 深度图梯度重建世界法线，`dot(n, projectorNormal) < 阈值` 剔除 | 掠射面/树冠/侧墙误命中 + 抗拉伸 |
| `uSoftMask=1` | `alpha *= cov`（PCF 覆盖×法线剔除的合成软 mask），残留噪点变半透明过渡 | 硬边椒盐 |

**三平面投影 / 分层贴花未采用**：视频贴花语义下三平面会在侧面重复内容，
改用"掠射面剔除"达到抗拉伸目的；当前单贴花无叠加需求。
**贴花 LOD 以"性能早退"替代**（见 9.4）。

### 9.3 参数标定（法线阈值不是拍脑袋）

OBB 横向半尺寸 2.71m 远大于深度跨度 far=3.2m，法线对深度梯度不敏感：
构造 slope=1.0 的强掠射面，重建法线 cos 仍 0.646。实测真实墙面 24×24 深度图
400 个法线样本 cos 分布：min=0.712 / p5=0.935 / p50=0.987。
- 初值 0.35 实测 **0/400 剔除，形同虚设**；
- 定稿 **0.90**：真实墙面仅剔 ~2% 边缘掠射点，强掠射面 cos=0.577 被正确剔除。

### 9.4 性能防护（用户明确要求保证性能，历史教训：52 值排序曾致弱 GPU TDR 整屏闪）

- 深度平滑用 3×3 中位（9 fetch）**替代**旧的 5×5×4=52 值分位排序，成本降约 6 倍；
- `decalShadow` 入口加**单 texel 放宽 1.3× 盒判定早退**：全屏 quad 的盒外像素
  1 次 fetch 即返回，不付 3×3 中位 + PCF 成本（盒外通常占屏幕绝大多数）；
- 三件套均可在 `options`（`pcf`/`normalCut`/`softMask`）与单条标注上关闭回退旧硬判定。

### 9.5 验证结果（无头，不依赖 GPU 像素读帧）

| 证据 | 结果 | 说明 |
|---|---|---|
| 静态回归 `verify_editor.mjs` | **342 PASS / 0 FAIL** | 新增早退守卫、三件套实现/注入守卫、4 参数一致性守卫 |
| CPU 算法验证 `verify_decal_shadowmap_cpu.mjs` | **8 PASS** | 合成 ±0.075 抖动：旧硬判定 77.6% 二值通过，新 PCF 连续软覆盖 66.5%；墙面法线 2/49 剔除，强掠射面 cos=0.577 剔除 |
| WebGL2 shader 编译（无头） | **0 编译错误**，实例 pcf=1/normalCut=0.9/softMask=1/shadowReady=true，gpuErrors=0 | 加早退前后各验证一次 |
| 无头像素覆盖率/外溢率 | 仍作废 | SwiftShader/Dawn 帧缓冲污染未解决 |
| **真机视觉降噪对比** | **待用户真机确认** | 无头无法出可信视觉证据；需真机看椒盐是否消失 |

### 9.6 本轮改动文件

`web/engine/decal-shaders.js`（三件套 GLSL+WGSL 同构实现、4 参数 decalShadow、性能早退）、
`web/editor/decal-projection.js`（`uPcf`/`uNormalCut`/`uSoftMask` 注入 + options/setOptions/debug）、
`tools/verify_editor.mjs`（342 PASS）、
`tools/verify_decal_shadowmap_cpu.mjs`（8 PASS）、本文档。

**真机验证方法**：打开展厅一楼室内，框选贴花区域后，在控制台执行
`__mgEditor.decalMgr.setOptions({ pcf:0, softMask:0 })` 看旧硬判定（噪点应明显），
再执行 `setOptions({ pcf:1, softMask:1, normalCut:0.9 })` 看新降噪效果对比。
GPU 无头像素证据不可信，闭环以真机肉眼确认为准。

---

## 10. 技术路线再简化：视频始终在前（always-on-top projected decal，2026-11-19）

第 9 节的三件套（PCF + 法线剔除 + 软 mask）经真机反馈**未解决遮挡错误**：贴花框内
仍有椒盐噪点与蓝色三角外溢。复盘后确认是路线层面的问题，不是参数问题。

### 10.1 根因：两个深度源跨源比较

贴花 shader 里存在**两个不同来源的深度**，却被拿来做逐像素比较：

| 深度 | 来源 | 用途 |
|---|---|---|
| `pickDepth` | **3DGS Picker**（RGBA16F，随机试验线性深度） | `worldFromPick` 重建世界点 W → 算 dW、盒内判定、投影 UV |
| `shadowDepth` | **碰撞体 mesh**（`buildShadowDepthMap` 用 `col.queryRay()` CPU 射线生成的 24² R32F） | dMap，做 `dW vs dMap` 表面判定 |

3DGS 深度在树冠/稀疏/多层表面随机命中近/远点（米级差），碰撞 mesh 深度是确定性
几何表面。两者跨源比较，二值判定把深度抖动放大成：相邻像素随机通过/失败 → **椒盐**，
前景/背景误判 → **破洞与外溢**。第 9 节的 `smoothPickDepth`（3×3 中位）与 PCF 只是在
这个错误比较之上做平滑，治标不治本，还多付每像素 9+9 次采样。

### 10.2 决策：去掉跨源深度遮挡测试

用户诉求："视频的像素应该始终在前面"。落地为 **always-on-top projected decal**：

- 深度**只**用来把屏幕像素重建成世界点 W，从而算投影 UV（`ln.xy*0.5+0.5`），保持
  贴花随相机移动的三维贴合；**不再**参与"是否显示视频"的判定。
- 投影范围完全由 projector 局部盒（`|L/(half*boxScale)|<=1`）决定，命中即显示。
- alpha 只由 `视频透明度 × decalOpacity × 边缘软过渡` 决定，无条件叠加在最前。

**删除的机制**（GLSL + WGSL 同步）：
- `smoothPickDepth` — 3×3 深度中位滤波（用户明确要求去掉，9 次采样）
- `shadowPcf` — dW 与碰撞 mesh dMap 的跨源软比较
- `shadowWorldNormal` — 基于 shadow 深度梯度重建法线的剔除
- `decalShadow`(4 out) / `decalCov` — 统一替换为 `decalProject`(2 out / vec3f)
- main 中 `uShadowReady` 双分支与 `uDepthMode` 分位回退 — 统一为单 texel 直判

**保留**：`shadowDepth` 纹理生成与 uniform 声明、`uPcf/uNormalCut/uSoftMask`、
`uDepthMode` 等（只保留声明与注入做兼容，shader 主路径已不读取）。shadow 数据仍
由编辑器生成，便于后续若要恢复深度测试时零成本回退。

### 10.3 性能与数学收益

- 命中热路径从「3×3 中位(9 fetch + 排序) + 9 fetch PCF + 3 fetch 法线」降为
  **单 texel 重建 + 一次矩阵乘 + 盒判定**，是历史最低成本，彻底消除弱 GPU TDR 风险。
- 投影 UV 与深度解耦：CPU 验证中把世界点沿投影机法向 ±2m 平移，横向 UV 完全不变
  （49/49 点），直接证明"遮挡错误"的跨源深度项已从链路中移除。

### 10.4 验证结果

| 证据 | 结果 | 说明 |
|---|---|---|
| 静态回归 `verify_editor.mjs` | **339 PASS / 0 FAIL** | 新增 4 条 always-on-top 守卫：单 texel 热路径、彻底删除跨源比较/降噪三件套、废弃 uniform 不入判定、与深度解耦 |
| CPU 验证 `verify_decal_shadowmap_cpu.mjs` | **5 PASS** | 49/49 盒内命中、UV 覆盖 u[0.009,0.991]/v[0.020,0.980]、深度 ±2m 扰动下横向 UV 49/49 稳定 |
| WebGL2 编译（无头） | **0 错误**，gpuErrors=0，后端=webgl2 | GLSL 路径 |
| WebGPU 编译（无头） | **0 错误**，gpuErrors=0，degraded=false，后端=webgpu | WGSL 路径（主路径） |
| 无头像素覆盖率/外溢率 | 仍作废 | SwiftShader/Dawn 帧缓冲污染未解决 |
| **真机视觉** | **待用户确认** | 无头无法出可信视觉证据 |

### 10.5 本轮改动文件

`web/engine/decal-shaders.js`（GLSL+WGSL 同构简化为 always-on-top）、
`tools/verify_editor.mjs`（守卫改写为"始终在前"不变量）、
`tools/verify_decal_shadowmap_cpu.mjs`（重写为深度解耦验证）、本文档。
`web/editor/decal-projection.js` 本轮未改（shadow uniform 注入保留兼容）。

### 10.6 语义边界（需真机确认）

当前实现仍用 3DGS 深度重建 W 做局部盒的 **z 判定**（half.z≈0.25m 的薄盒）。这意味着：
- 已消除：跨源 shadow 比较造成的椒盐/破洞/外溢（本次 target）。
- 仍保留：贴花贴合三维表面的语义——相机移动时视频跟随墙面；前景物体若把 W 推到盒外
  （z 超界），该处视频不显示。这是 projected decal 的自然边界，不是"遮挡错误"。

若真机仍要求"连前景遮挡也一律盖住"，则需放宽/去掉盒 z 判定（只判 ln.xy）或改纯屏幕
矩形叠加（零深度依赖，代价是失去三维贴合）。这一步需真机观察后再定，不预先实现。

---

## 11. 整屏剧烈闪烁：紧急熔断 + 帧率节流（2026-11-19）

### 11.1 根因链（代码事实，非臆测）

用户报告"程序导致整个电脑屏幕剧烈闪烁"（真机 Edge + `--enable-unsafe-webgpu`）。
整屏闪（不止浏览器）是弱 GPU 单帧超时 **TDR** 的典型表现，与第 6 节 52 值排序 TDR 同类。本轮叠加三重负载：

1. **永动渲染循环**（历史遗留，非本轮引入）：`onFrameEnd` 挂在 `app.on('frameend')`，
   每帧渲染结束都调 `adapter.requestRender()` → `renderNextFrame=true` → 下一帧 → 又触发
   frameend。目的是防止 Picker pass 破坏 framebuffer 后的"编辑黑屏"，但把按需渲染
   （autoRender=false）变成 **60fps 永动满载**。
2. **每帧纹理上传**：`onFrameEnd` 对每个贴花实例每帧 `updateCanvasTexture`（demo 模式还每帧
   `drawDemoFrame` 重画 1024×576 滚动条纹）。
3. **always-on-top 放大**（本轮引入）：第 10 节删掉深度测试的 discard，盒内像素**无条件**执行
   视频采样 + alpha 混合，通过的片元数暴增。

三者叠加 → 弱 GPU 单帧超时 → 驱动级 TDR → 整屏闪。

### 11.2 关键缺陷：只有隐藏、没有熔断

原实现里 `setDecalsVisible(false)` / `degraded` 只是隐藏 renderable，但 `onFrameEnd` 的
`requestRender()` 仍在跑 —— GPU 照样满载。这就是"关了贴花还闪"的原因。诊断脚本
`tools/diag_flicker.mjs` 的假设 C（"贴花藏起来但 decalMgr 仍在跑帧钩子"）正是此问题。

### 11.3 修复（web/editor/decal-projection.js）

**① 紧急熔断 `renderEnabled`**（三个入口，立即断开永动循环）：
- URL 加 `decal=0` 或 `sessionStorage.mg_decal_stop=1` → 页面加载即熔断；
- 控制台 `__mgEditor.decalMgr.setOptions({renderEnabled:0})` → 不刷新立即生效。
熔断时 `onFrameEnd`/`onPrerender` 直接 return（不上传纹理、不喂 uniform、不 requestRender），
并隐藏所有 renderable，GPU 立即空载。恢复：`setOptions({renderEnabled:1})`。

**② 帧率节流 `maxFps`（默认 30）**：
- `onFrameEnd` 末尾的 `adapter.requestRender()` 改为 `requestThrottled()`；
- 用时间戳限频到 <=30fps，未到节流点时用 `setTimeout` **补帧**（关键：直接在 frameend 里
  跳过 requestRender 会断掉按需渲染链 → 画面永久停止；补帧保证链不断）；
- 弱 GPU 渲染耗时本身 > 间隔时，`elapsed >= interval` 自然立即请求，不会二次加速，
  实际帧率取 `min(maxFps, 硬件上限)`；
- `maxFps>=120 或 0` 解除节流回退旧全速行为；`destroy()` 清理补帧定时器。

### 11.4 验证与证据边界

| 证据 | 结果 |
|---|---|
| 静态回归 | **341 PASS / 0 FAIL**（新增熔断三入口 + 帧率节流两条守卫，并更新过期守卫） |
| JS 语法检查 | `node --check decal-projection.js` 通过 |
| 真机闪烁是否消除 | **待用户确认** —— 无头像素证据已定性作废，TDR 只能真机肉眼判断 |

### 11.5 真机操作指南

- **正在闪**：关闭浏览器标签页（或任务管理器结束 msedge）。
- **重开后先止血验证**：地址栏 URL 追加 `&decal=0` 打开 → 场景静态无贴花、不闪 → 证明是贴花驱动循环所致。
- **恢复贴花**：去掉 `decal=0` 重开，默认已节流 30fps；若仍闪，控制台执行
  `__mgEditor.decalMgr.setOptions({maxFps:15})` 进一步降频，或 `renderEnabled:0` 熔断。
- **确认无残留探针**：本次进程核对未发现无头探针占用 GPU（仅 WorkBuddy/Edge 自身进程）。

### 11.6 改动文件

`web/editor/decal-projection.js`（熔断 + 节流的全部实现）、`tools/verify_editor.mjs`
（守卫）、本文档。Shader 本轮未改。改动**尚未提交 git**。

## 12. 视频上下颠倒：纹理行序与投影局部基同向

### 12.1 两个坐标事实（代码证据）

1. `buildDecalProjector`（`web/editor/schema.js`）由网格边缘中点定基：`tMid = rowMid(nv)` 是框选区
   **下**边、`bMid = rowMid(0)` 是**上**边，故 `dy = tMid - bMid` 指向屏幕下方。经 `toward`
   把法向翻到朝向相机后，`up = cross(normal, right)` 反向，最终 projector 局部 **+Y 指向框选区上方**。
2. PlayCanvas `Texture` 构造默认 `flipY = options.flipY ?? false`
   （`playcanvas.dbg.mjs:11604`），本工程 `createCanvasTexture` 未显式传 `flipY`。shader 用
   `texelFetch(videoTex, ivec2(vpx), 0)` 直取行号，**v=0 = canvas 第 0 行 = 图像顶部**。

两者同向：框选区上方点的 `ln.y > 0` → `v ≈ 1` → 采到图像**底部**行 ⇒ 视频上下颠倒。
注意这与 `uPickFlipY` 是两件独立的事：后者管 **pick 深度快照**的行序，本项管 **视频纹理**的行序。

### 12.2 修复

- 新增 `uVideoFlipY`（GLSL/WGSL + `DECAL_UNIFORM_NAMES` + JS `setParameter` 全链路）：
  `u = ln.x*0.5+0.5`，`v = mix(vy, 1-vy, uVideoFlipY)`，其中 `vy = ln.y*0.5+0.5`。
- 默认 `videoFlipY = 1`（正确方向）；注记级 `dec.videoFlipY` 可覆盖，运行时
  `__mgEditor.decalMgr.setOptions({videoFlipY:0})` 可 A/B 回退到旧（颠倒）行为验证。
- `tools/verify_decal_shadowmap_cpu.mjs` 同步翻转，并新增方向断言：局部 +Y 最大的点
  必须映射到更小的 v（真机报告实测 `v(0.020) < v(0.980)`）。

### 12.3 验证

静态回归 **342 PASS / 0 FAIL**（新增行序守卫，更新 UV 映射守卫）；GLSL/WGSL lint 4/4 PASS；
CPU 验证 **6 PASS**（49/49 盒内、UV 覆盖、行序方向、深度解耦）。无头像素证据仍作废，
最终方向以真机肉眼为准。

## 13. 与标准 Shadow-Map Decal 方案的路线对比

| 环节 | 标准 Shadow-Map Decal（用户给的方案） | 当前实现 |
|---|---|---|
| Pass1 深度图 | GPU depth-only pass，正交 projector ViewProj，渲染不透明物体到 D32_FLOAT | **没有 GPU pass**：`buildShadowDepthMap()` 用 `col.queryRay()` CPU 射线 24² 采样，结果注入 R32F 纹理；且 shader 主路径**不读**它 |
| Pass2 主渲染 | 常规 mesh 颜色 + 深度 | 3DGS splatting + Picker 另出 RGBA16F 深度（4 通道随机试验） |
| Pass3 绘制几何 | projector 的 AABB 立方体，光栅化覆盖候选像素 | **全屏 quad**，所有像素都跑一遍 shader |
| FS 投影坐标 | `decalProjHPos/w * 0.5 + 0.5`（投影矩阵 NDC） | `gl_FragCoord` → pick 深度 → 世界点 W → `invProjector` → `ln.xy*0.5+0.5`（正交下与 NDC 数学等价） |
| 边界判定 | `uvProj` 超出 [0,1] discard | `|L/(half*boxScale)| > 1` discard（含 z 薄盒） |
| 遮挡测试 | 采样 shadow map + depthBias，当前 Z 远小于图 Z 则 discard | **没有遮挡测试**（按用户"视频像素始终在前"的要求删除） |
| 采样/混合 | `uvProj.xy` 采样 albedo，`SrcAlpha/OneMinusSrcAlpha` | `uVideoFlipY` 修正后的 uv 采样视频，`BLEND_NORMAL`（等价混合） |

**结论：思想同源（都是 projected decal / 光空间投影 UV），实现路线不一致。** 三个关键差异：

1. **GPU 深度图没有实现**：此前用户要求"不能用 CPU 做深度采样，全部用 GPU 生成深度图"，
   该工作因整屏闪烁止血而中断。当前仍是 CPU 射线深度图，且不被 shader 读取。
2. **遮挡语义相反**：标准方案要 depth test；当前按用户先前要求刻意 always-on-top。若把
   `dW vs dMap` 跨源比较加回来，会重新引入已证实的椒盐/破洞/外溢（树冠与稀疏深度米级抖动）。
   只有在 Pass1 与主相机深度**同源**（同一批不透明 mesh）时，标准遮挡判定才可信。
3. **全屏 quad vs AABB**：全屏 quad 是 TDR/整屏闪的片元放大器；改 AABB 光栅化可在不触碰
   遮挡语义的前提下大幅降载，是比"恢复深度比较"更优先的性能改造。

下一步若按标准方案推进，建议顺序：① AABB 光栅化替掉全屏 quad；② GPU depth-only Pass1
替掉 CPU 射线；③ 在同源深度前提下再评估是否恢复 depthBias 遮挡。三步应分别真机验证，
不要一次性全改。

## 14. 按用户方案重构为标准三段式（2026-11-19 实施）

上一节的三步建议已被用户要求一次性实施。当前默认路径即标准 Shadow-Map Decal，
旧全屏 quad + CPU 24² 深度图仅在引擎不具备 depth-only pass 能力时回退。

### 14.1 Pass1：GPU depth-only（正交投影仪视角）

- `web/viewer/index.js` 的 `__pc` 白名单补出 `RenderTarget / Entity / Layer /
  PIXELFORMAT_DEPTH / PROJECTION_ORTHOGRAPHIC / RENDERTARGET_ORIGIN_NATIVE / FUNC_LESS`。
  只改 bundle 尾部导出，**未改 PlayCanvas 引擎内部**，viewer_app 交付工程无需改动。
- `web/engine/engine-adapter.js` 契约新增 G 组 `renderpass` 7 方法 + E 组
  `createSceneNode/createMesh/destroyMesh`（共 48 方法）。
- `web/engine/playcanvas-adapter.js`：
  - `new Texture({format: PIXELFORMAT_DEPTH})` = WebGL2 `DEPTH_COMPONENT32F` /
    WebGPU `depth32float`；`new RenderTarget({depthBuffer, origin:NATIVE})`，无 colorBuffer；
  - `StandardMaterial` 的 `redWrite/greenWrite/blueWrite/alphaWrite=false` +
    `depthTest/depthWrite=true`，即颜色写掩码全关的 depth-only pass（引擎阴影 pass 同范式）；
  - 独立 `Layer` 只挂在专用正交相机上，**主相机 layers 不含它**，碰撞 mesh 不会出现在主画面；
  - 相机置于 OBB 局部 -Z 侧朝 +Z 看，`orthoHeight=half[1]`、
    `aspectRatio=half[0]/half[1]`、`near=0.01`、`far=2*halfZ+4`；
  - 相机默认 disabled，`setDepthPassProjector` 时启用一帧，`frameend` 内部回调再关掉，
    避免每帧重画碰撞 mesh 造成 TDR；关掉后 `renderNextFrame=true` 保证主画面恢复。

### 14.2 Pass3：AABB 立方体光栅化 + 同源深度比较

- `web/engine/decal-shaders.js` 新增 4 段 shader + `DECAL_SHADOW_UNIFORM_NAMES`：
  - VS：`gl_Position = matrix_viewProjection * world`（主相机裁剪坐标，只覆盖候选像素），
    同时 `vProj = uProjVP * world` 输出投影仪齐次坐标；
  - FS：用主相机 pick 深度重建世界点 W → `uProjVP` 得 `uvProj` 与 `fragD`，
    采样 Pass1 深度纹理 → `if (fragD > mapD + uShadowBias) discard`，
    通过后 `uvProj` 采样视频（v 仍由 `uVideoFlipY` 修正）。
  - **不能用插值 vProj 算 uvProj**：那是盒子表面，贴花会浮在空中；必须用场景表面点 W。
- 深度比较方向修正：用户原描述「当前 Z 比深度图 Z 小很多 → 被遮挡」在常规深度约定
  （越近越小）下是反的；标准方向是 `fragD > mapD + bias` → 片元在阴影图表面之后 → 被遮挡。
- `uShadowBias=0.002`（正交 window z 线性，约 9mm），运行中可用
  `__mgEditor.decalMgr.setOptions({depthTest:0})` 切回 always-on-top 做 A/B。
- 投影机 OBB 8 角 → 24 顶点/36 索引立方体（`projectorCubeGeometry`），
  projector 变化时才重建 mesh；`createMesh` 的 3 分量属性与 `attribute vec3` 对齐。

### 14.3 深度同源边界（必须知道的风险）

Pass1 渲染的是**碰撞 mesh**（场景里唯一可光栅化的不透明代理几何），Pass3 的 `fragD`
来自**主相机 3DGS 深度**重建的 W。两者不是完全同一份几何：平整室内墙面通常吻合，
树冠/稀疏/多层表面仍可能有厘米到米级偏差。因此保留 `depthTest` 开关：
默认按用户方案开深度比较；若真机出现椒盐/破洞，用 `depthTest:0` 回退 always-on-top。
这与第 10 节「跨源比较无解」的结论并不矛盾——那里是 CPU 射线 24² 图对 3DGS 深度，
这里是 GPU 光栅化正交深度图，量级不同，但仍非严格同源。

### 14.4 改动文件与验证

| 文件 | 改动 |
|---|---|
| `web/viewer/index.js` | `__pc` 导出补 RenderTarget/Entity/Layer/深度常量 |
| `web/engine/engine-adapter.js` | 契约 38 → 48 方法，新增 G 组 renderpass |
| `web/engine/playcanvas-adapter.js` | Pass1 完整实现（RT/正交相机/独立 layer/颜色写掩码/一帧渲染） |
| `web/engine/decal-shaders.js` | Pass3 cube VS/FS（GLSL+WGSL），WGSL 深度纹理用 `texture_depth_2d` |
| `web/editor/decal-projection.js` | 默认走三段式；inst 持有 depthPass/projVP；cube 重建；uniform 注入；旧路径回退 |
| `web/editor/editor.js` | 标准路径跳过 CPU `buildShadowDepthMap`；状态文案更新 |
| `tools/glsl-lint.mjs` | 新增 Pass3 四段 shader 结构校验 |
| `tools/verify_shadow_decal_cpu.mjs` | 新增：正交投影 uv/深度域、深度方向、行序 5 项 CPU 验证 |
| `tools/verify_editor.mjs` | 新增 [37] 节 6 条守卫；契约分组守卫更新 |

验证：**348 PASS / 0 FAIL**（静态回归）、shader 结构 **8/8 PASS**、
标准方案 CPU **5 PASS**（49/49 uv、49/49 深度域、49/49 深度方向、行序正确）、
旧 CPU 验证 6 PASS（回退路径仍有效）。**未运行任何会触发 GPU 的无头截图探针**
（用户曾因此遭遇整屏闪烁）；真机需确认：贴花是否显示、遮挡是否正确、是否再闪烁。

## 15. 真机「视频完全不投射」根因：初始化 TDZ（2026-11-19）

### 15.1 现象与根因
用户在标准三段式重构后反馈「视频没法正常投射」（完全无视频，非遮挡错误）。
静态回归 348 PASS 全过、GLSL/WGSL lint 与 CPU 数学全过，但真机零输出——因为
**所有守卫都是静态文本/正则匹配，从未真正 import 模块并执行 JS**。

实测 `createDecalProjection()` 一调用即抛：
```
ReferenceError: Cannot access 'shadowPathSupported' before initialization
```
两处 TDZ（暂时性死区）：
1. `manager` 对象字面量直接引用了下方才 `const` 声明的 `shadowPathSupported`；
2. `stoppedByEntry` 分支提前调用了下方才声明的 `const warn`。

`node --check` 只查语法不查 TDZ；正则守卫只看文本存在性，二者都无法发现。异常被
`editor.js:205` 的 `try/catch` 吞成一句 console.warn，`decalMgr` 保持 `null`，
`syncDecals()` 第 228 行 `decalMgr && ...` 短路跳过 → 贴花实例从未创建 → 完全没视频。

### 15.2 修复
- `web/editor/decal-projection.js`：`warn`、`numOr`、`manager` 提到引用之前初始化；
  `manager.shadowPathSupported` 改为先占位 `false`，待能力探测完成后回填；
  `warn` 定义移到 `stoppedByEntry` 分支之前。
- 深度图可用性兜底：`depthPassOk` 由 `setDepthPassGeometry()` 返回值驱动。碰撞 mesh
  不可用时 Pass1 深度纹理保持 clear=1.0，会让 Pass3 的 `mapD>=1 discard` 丢掉全部
  视频——此时自动回退 `uDepthTest=0`（always-on-top），保证视频一定能投射。
  `debug().instances[]` 新增 `useShadow/depthPassOk/hasProjVP/hasShadowTex/effectiveDepthTest`
  供真机定位。

### 15.3 防回归：真实运行时验证
新增 `tools/verify_decal_runtime.mjs`：mock DOM + mock adapter（覆盖全部 48 契约方法），
真正 `import` 模块并走通 `createDecalProjection → sync → BEFORE_RENDER → AFTER_RENDER →
setOptions → destroy`。当前 **11 PASS**：含 TDZ 不复发、标准/回退双路径、深度几何
装载成功/失败两支的 uniform 断言。`verify_editor.mjs` [37] 节新增 2 条守卫（初始化
顺序 + runtime 脚本存在）。静态回归升至 **350 PASS / 0 FAIL**。

**铁律教训**：任何被 `try/catch` 包裹的初始化链路，静态文本守卫都不足以证明可用——
必须有一次真实 import + 调用，否则 TDZ / undefined 方法 / 参数错位会静默溜过。

## 16. 三段式真机失败：默认回退 always-on-top（2026-11-19）

### 16.1 两个症状与根因
用户真机反馈：①绝大部分视频像素看不到；②缩放包围盒时黑屏闪烁。两者都源于
上一轮默认开启的标准三段式深度比较，而它在本场景（3DGS + 碰撞 mesh）并不成立：

1. **像素丢失**：Pass1 深度图由**碰撞 mesh** 光栅化，Pass3 的 `fragD` 由 **3DGS 主
   深度**重建——跨源。`fragD > mapD + 0.002`（约 9mm）在米级差异下几乎恒成立，
   绝大部分片元被判「被遮挡」discard → 视频几乎全丢。这正是第 10/14.3 节反复
   记载的跨源比较无解问题，三段式把它重新引入。
2. **缩放黑屏闪**：每次 projector 变化（缩放 half）→ `syncShadowPass` →
   `setDepthPassProjector` → 正交相机 `enabled=true` + `renderNextFrame` → 每帧重渲
   几十万三角碰撞 mesh → 弱 GPU TDR → 整屏闪（叠加既有 30fps 节流仍不住）。

### 16.2 修复：默认 back to always-on-top，深度比较降级为可选
- `options.depthTest` 默认 `1 → 0`。默认路径 Pass3 的 UV 改走 **OBB 局部坐标**
  （`invProjector * W` → `ln = L/(half*boxScale)` → `uv = ln.xy*0.5+0.5`），
  视频在盒内无条件显示（视频始终在前），不依赖 Pass1 矩阵/深度纹理。
- `syncShadowPass` 开头：`if (!options.depthTest)` 时**只同步 AABB cube 几何**，
  绝不创建/启用/重渲 Pass1 深度相机 → 缩放不再触发碰撞 mesh 重渲 → 不闪。
- GLSL/WGSL Pass3 FS 同步：`uvProj` 默认由 OBB 局部坐标算；`vProj.w<=0` 判定与
  深度比较移入 `if (uDepthTest>0.5)` 可选分支。两后端同构，新增 uniform
  `invProjector/decalHalf/uBoxScale`（`DECAL_SHADOW_UNIFORM_NAMES` 同步）。
- `onPrerender` 无论深度开关如何都注入 `invProjector/decalHalf/projectorNormal`
  （默认路径核心 uniform，缺它 UV 全 0 → 视频全丢）；`uDepthTest` 严格取
  `options.depthTest && depthPassOk && projVP`。
- `setOptions({depthTest})` 立即对现有实例重配（0→1 建 Pass1、1→0 关 Pass1），
  真机 A/B 无需改标注。
- `debug().instances[]` 保留 `depthPassOk/hasProjVP/effectiveDepthTest` 供定位。

### 16.3 何时可开 depthTest=1
只有 Pass1 深度图与 Pass3 主深度**同源**时深度比较才可信（例如引擎能直接从
3DGS 主相机渲 depth-only，而非碰撞 mesh 代理）。当前用碰撞 mesh 属跨源，真机
必然椒盐/破洞，故默认关闭。若未来引擎提供同源深度，再评估开启 + depthBias。

### 16.4 验证
- 运行时链路 `tools/verify_decal_runtime.mjs`：**12 PASS**（新增：默认不启 Pass1、
  默认注入 OBB uniform、缩放不触发 setDepthPassProjector、depthTest 1→0 立即关闭）。
- 静态回归 **351 PASS / 0 FAIL**（[37] 节守卫更新为默认 always-on-top）。
- shader lint 8/8、标准 CPU 5 PASS、旧 CPU 6 PASS（均全 PASS）。
- 未跑任何 GPU 无头截图探针。真机需确认：视频可见、缩放不闪、遮挡观感。

## 17. 「添加投影矩形就开始闪」：纹理上传 + 永动帧率双重减载（2026-11-19）

### 17.1 现象与根因
用户真机反馈「又开始闪烁了」，进一步确认为「添加投影矩形就开始闪」。
上一轮（第 16 节）把 `depthTest` 默认从 1 改回 0（always-on-top）后，视频恢复可见，
但重新打开了两个确定的每帧负载源，叠加成弱 GPU TDR / 整屏闪：

1. **纹理逐帧同步上传**：`onFrameEnd` 对每个实例每帧调 `adapter.updateCanvasTexture()`
   → `texture.setSource(canvas)`，1024×576×4B ≈ 2.36MB/实例/帧。多个投影矩形叠加时
   上传带宽线性增长，`setSource` 在多数驱动上是同步 GPU 上传 → stall。
2. **永动循环帧率偏高**：`frameend → requestThrottled → requestRender` 的永动链虽已
   经 30fps 节流，但 30fps × always-on-top 盒内无条件采样混合仍超弱 GPU 预算。

### 17.2 修复（纯 JS 侧减载，不动 shader，避免编译风险）
- 新增 `options.uploadFps`（默认 15）：`uploadDue()` 用时间戳独立节流纹理上传，
  未达间隔的帧完全跳过 `setSource`，复用上一帧纹理内容（视频 24~30fps，肉眼无损）。
  设 0 或 >=120 解除节流（恢复逐帧上传）。
- `maxFps` 默认 `30 → 15`：永动主渲染帧率再减半，动画仍连续。
- `setOptions` 白名单 + `debug()` 均纳入 `uploadFps`，真机可 `setOptions({uploadFps:0,
  maxFps:120})` 一键回到旧满速口径做 A/B。
- 保留 `renderEnabled` 熔断（URL `decal=0` / sessionStorage / 运行时）作为最终止血。

### 17.3 验证
- 运行时链路 `tools/verify_decal_runtime.mjs`：**13 PASS**（新增：连续 20 帧 onFrameEnd
  只上传 <=1 次；解除节流后 5 帧 5 次上传）。
- 静态回归 **352 PASS / 0 FAIL**（[38] 节新增上传节流守卫，`maxFps` 守卫更新为 15）。
- shader lint 8/8、标准 CPU 5 PASS、旧 CPU 6 PASS。
- 未跑任何 GPU 无头截图探针。真机需确认：加矩形不再闪、视频仍可见、动画流畅度可接受。

## 18. 闪烁真因：error scope 异步竞态 + 持续 foreign 错误反复复测（2026-11-19）

### 18.1 用户判断与纠错
用户明确指出：**机器性能没问题，闪烁是代码逻辑问题**，并要求恢复到「无 GPU pass /
全屏 quad / always-on-top」基线（本文档第 10 节定稿），再逐步验证代码哪里出错。
此前第 16/17 节把闪烁归因于弱 GPU TDR、做纹理上传节流 + 降帧率，方向错误。

### 18.2 真实逐帧执行定位（不臆测，工具 `tools/diag_frame_scope.mjs`）
mock 真实 WebGPU 的 `popErrorScope().then()` 异步回调，逐帧调用 onPrerender/onFrameEnd，
记录每帧渲染时刻的 `renderable.visible`。修前实测**可见性 10 帧内切换 9 次**
（true/false 交替）= 闪烁复现。定位到两个叠加的逻辑 bug：

1. **异步竞态**：`endScope()` 调 `adapter.endGpuErrorScope(cb)` 内部是
   `popErrorScope().then(cb)`（playcanvas-adapter.js:116，异步）；而 `onFrameEnd`
   紧接着**同步**执行 `probeDecalsOff=false; setDecalsVisible(true)`（原 596-598 行）。
   异步回调真正执行时读到的全局 `probeDecalsOff` 已被同步代码重置为 false →
   「复测帧无错→是贴花的错→degrade」与「复测帧有错→非贴花→忽略」两条归因分支
   永远走不到，每次都当「首次捕获」重设 `suspicion.probeNextFrame=true` →
   贴花每帧隐藏/恢复交替。
2. **持续 foreign 错误反复复测**：即使修好竞态，若引擎自身 validation error
   （如 Dawn VertexState）每帧都出现，二分复测「隐藏贴花一帧」会被每帧触发 →
   贴花每两帧隐藏一次，仍是持续闪烁。实测修竞态后 engine 场景仍切换 9 次。

### 18.3 修复（纯逻辑，无 shader 改动）
- `endScope()` 在调用瞬间用 `const wasProbeFrame = probeDecalsOff` 快照本帧是否复测帧，
  回调只用快照值，不再读被同步重置的全局量 → 归因分支可正确收敛。
- 新增 `foreignResolvedMsgs: Set`：某条错误消息一旦复测证明与贴花无关，冻结结论；
  后续同消息直接计入 foreign 并忽略，不再触发 `probeNextFrame`/隐藏贴花。新消息
  （真正贴花故障）仍独立复测、必要时 degrade。→ 引擎持续错误只在首帧探测一次。
- 恢复无 GPU pass 基线：`useShadowPass` 默认 0（三段式需 `createDecalProjection({
  useShadowPass:1 })` 或 URL `shadowPass=1` / sessionStorage 显式开启）；
  `maxFps` 恢复 30、`uploadFps` 恢复 0（性能非瓶颈，视频流畅优先）。
- 保留 TDZ / uVideoFlipY 等正确性修复。

### 18.4 验证
- 逐帧诊断 `tools/diag_frame_scope.mjs`：**7 PASS**，双场景：
  ①贴花自身错误→切换 1 次后降级稳定隐藏；②引擎持续错误→切换 2 次（仅首次归因探测）
  后永久稳定可见、不误降级。修前 9 次交替 → 修后 ≤2 次。
- 运行时链路 `tools/verify_decal_runtime.mjs`：**13 PASS**（基线默认全屏 quad、无 Pass1）。
- 静态回归 **355 PASS / 0 FAIL**（[38] 节新增竞态/冻结/基线守卫）。
- shader lint 8/8。未跑任何 GPU 无头截图探针。改动未提交 git。

**铁律**：GPU error scope 归因的异步回调绝不能读会被同步代码改写的状态；必须用
调用瞬间快照。且「隐藏被诊断对象」作为探测手段时，若错误持续存在，必须冻结已判定
的 foreign 结论，否则探测本身就成了可见的周期性故障。

---

## 19. 默认启用正统三段式 Shadow-Map Decal（3DGS 同源深度）

### 19.1 用户规格与决策
用户给出完整三段式规格（Pass1 正交相机 depth-only / Pass2 主渲染 / Pass3 AABB 光栅化
+ shadow map 深度比较 + 法线点积剔除 + alpha 混合），并明确两项决策：
① Pass1 深度源 **渲染 3DGS 场景本身（同源）**，不是碰撞 mesh；
② **直接默认启用三段式**，always-on-top 退为回退。

### 19.2 关键技术发现（决定了最低风险改造路径）
- 引擎 `Picker` 的 pick pass 本质就是「用指定相机渲染 3DGS 到深度纹理」：
  `RenderPassPicker.before() -> gsplatDirector.prepareForPicking(camera.camera, w, h, layer)`
  用**传入相机的 node** 做 GPU 排序，`pick shader` 的 `camera_params.w` 已内置
  `isOrtho` 分支（正交时直接用 `gl_FragCoord.z` 线性深度）。
  → **无需重写 11 万行 bundle 里的 gsplat 排序管线**，只需传一台正交相机。
- pick pass 用 `BLENDEQUATION_MIN` 逐通道保留最近深度，与 splat 绘制顺序无关。
- pick buffer 是 RGBA16F 4 通道，每通道一次独立伯努利试验的最近幸存深度
  （= 引擎 `surfaceDepth()` 的 52 样本输入口径）。Pass3 自己做 30% 分位 resolve
  即得确定性表面深度，**无需改 pick shader 输出口径、无 CPU 采样**。

### 19.3 实现改动
- `web/viewer/index.js`：新增 `ProjectorDepthRenderer` 类（正交相机 + RenderPassPicker
  + RGBA16F RT + 复用 picker shader patches），工厂挂 `app.__mgProjectorDepth`。
  正交相机放 OBB 背面（局部 -Z）朝 +Z 看，用引擎 `Quat.transformVector` 算朝向
  （避免手写四元数符号错误），`render(projector,size)` 同步渲染返回 {texture,viewProj}。
- `web/engine/playcanvas-adapter.js`：G 组接口不变；`createDepthPass` 优先走新 3DGS
  源（返回 `useGsplat` 句柄），不可用时回退碰撞 mesh；`setDepthPassProjector` 在
  gsplat 路径同步调 `renderer.render()`；共享 renderer 单例不随 depthPass 销毁。
- `web/engine/decal-shaders.js`：shadow FS 的 `shadowDepth` 从单通道 D32 改为
  RGBA16F 4 通道；新增 `shadowSurfaceDepth()`（3×3×4=36 样本 30% 分位）与
  `pickSurfaceDepthShadow()`（5×5×4=52 样本）同源 resolve；法线剔除改为世界空间
  重建法线翻向相机后与 `projectorNormal` 点积（避免光空间梯度符号/噪声误杀）。
  GLSL/WGSL 双后端同步。
- `web/editor/decal-projection.js`：`useShadowPass`/`depthTest` 默认 1（URL
  `shadowPass=0`/`depthTest=0` 可回退）；`syncShadowPass` 的 gsplat 分支由
  `setDepthPassProjector` 返回值驱动 `depthPassOk`，不依赖碰撞 mesh。

### 19.4 深度方向辨析（关键防回归）
用户规格写「当前 Z 比深度图 Z 小很多 → 被遮挡」——这是 reversed-Z / 距离口径的
表述。本项目 pick shader 输出 `gl_FragCoord.z`（常规深度：越近越小，1=空），
数值方向相反但语义相同，正确判定仍是 `fragD > mapD + bias → discard`。
照字面取反会重蹈「贴花完全看不到」的历史覆辙（第 8/10 节）。已加静态守卫固化。

### 19.5 验证
- 静态 `verify_editor.mjs`：**371 PASS / 0 FAIL**（[37] 节新增同源深度源、4 通道
  resolve、法线剔除、默认启用、深度方向语义 4 条守卫；修正两条旧默认断言 +
  一条历史遗留 `#gsPanoStatus` 正则）。
- 运行时 `verify_decal_runtime.mjs`：**13 PASS**（改为默认三段式语义）。
- 新增 `verify_gsplat_depth_adapter.mjs`：**3 PASS**（真实 import adapter，验证
  gsplat 深度路径 / 渲染失败回退 / 无工厂时回退碰撞 mesh）。
- shader lint 8/8；`verify_decal_shadowmap_cpu` / `verify_shadow_decal_cpu` 全 PASS。
- **headless 无法定论**：CDP headless WebGL2 下 gsplat 走 CPU 排序路径，
  `prepareForPicking` 返回 null（主相机对照同样 null）——同源深度图能否正确渲出、
  深度比较是否稳定、有无闪烁，**必须真机 WebGPU 肉眼验证**（项目铁律：无头像素证据作废）。

### 19.6 真机验证清单
1. 添加投影矩形：视频正常投射、方向正确、无上下颠倒。
2. 缩放 projector：不黑屏、不闪烁（3DGS 深度同步渲染，非每帧重渲碰撞 mesh）。
3. 遮挡：被墙/柱挡住的部分按 shadow map 消失，前景不被误杀（椒盐/破洞检查）。
4. 法线剔除：掠射角贴花不糊在侧面，正对表面不误删（必要时 `setOptions({normalCut:0})` 关）。
5. 回退 A/B：URL `&depthTest=0` 应立刻回到 always-on-top；`&shadowPass=0`（需刷新）
   回到全屏 quad 基线。

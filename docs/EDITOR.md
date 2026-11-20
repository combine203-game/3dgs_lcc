# 标注编辑模块 · 使用说明

在 3DGS 实景场景里交互式添加标注：点、贴地动线、面、悬浮展板、**三维实体屏**，并支持测量、图层、分组、导览与 JSON 导入导出。
展板引线锚点可在编辑态拖动并自动吸附最近碰撞 MESH；动线会等距重采样并逐点吸附模型表面，
渲染成**等宽的箭头形状多边形链**；每个注记还能单独设置「是否开启深度检测」。
拾取任何标注后右侧属性面板会自动展示内容预览。
**单击任何标注都不会改变它的位置**（只有超过 6px 的真实拖拽才会移动展板）。

## 启动

```bat
cd /d D:\WorkSpace\AI\3DGS_build\viewer_edit
runtime\python\python.exe serve.py --no-browser --port 8099
```

浏览器打开 `http://127.0.0.1:8099/`（默认浏览态）。
直接进编辑态：`http://127.0.0.1:8099/?edit=1`，或启动时加 `--edit` 参数。

## 进入 / 退出编辑

| 操作 | 方式 |
|---|---|
| 进入 | 点融合页左下角辅助条的「**标注编辑**」 |
| 退出 | 点右上角「× 退出编辑」（`Esc` 在编辑态内用于取消绘制 / 取消选中 / 回到选择工具） |

进入后：融合页的全部浏览 HUD 隐藏，只留三维画面 + 编辑面板。
三维画面内的键盘控制保持可用（`W A S D` 漫游、`Shift` 加速）。

## 鼠标操作规则

| 场景 | 行为 |
|---|---|
| 在三维画面上**单击** | 落一个标注点（**不会**触发引擎的「点击自动漫游过去」） |
| 在三维画面上**拖拽** | 放行给引擎，用于旋转视角，不误落点 |
| **移动鼠标**（绘制中） | 实时显示落点十字准星 + 橡皮筋预览，零延迟 |
| 在编辑面板上点击 | 只操作面板，不落点 |
| 点标注 / 展板本体 | **只选中、绝不改变位置**，不弹出任何独立页面（展板内容已内嵌在三维面板里）；右侧属性面板自动展示内容预览 |
| 点**三维实体屏** | 只选中；选中后屏心出现**三轴 gizmo**（X 红 / Y 绿 / Z 蓝带箭头轴柄 + 中心选择柄），拖轴柄沿世界 X/Y/Z 移动、拖屏体 / 中心柄在相机平面内自由移动；微抖 ≤6px 绝不改写位置 |
| 点左侧列表项 | 选中该标注，右侧属性面板同步切换，可直接改字 |
| **拖动展板本体**（仅编辑态，位移 > 6px） | 以「锚点 + 鼠标位移」平移展板，不会跳到光标所指的场景表面；一次拖动合并成一条撤销 |
| 拖动展板底部的**引线锚点圆点**（仅编辑态） | 锚点自动吸附到最近碰撞 MESH 表面，导引线随之拉长 / 转向；预览态只读 |
| **双击**（左键 / 右键，任何位置） | **完全不触发任何事件**：stage 捕获层 `preventDefault + stopImmediatePropagation` 纯拦截（不结束绘制、不回机位、不漫游）；绘制收尾统一走右键 / `Enter` |
| **右键单击**（绘制中） | **结束当前标注动作**（`finishDraftAfterPending(true)`，与 `Enter` 等价）：点数达到下限即完成并回「选择」，不足下限时 `finishDraft` 丢弃草稿同样回「选择」 |
| **右键单击**（无草稿） | 命中标注弹上下文菜单；空白处取消选中并回「选择」。状态栏区分「已取消本次标注」/「已取消选中」 |
| **选中任一标注后** | 该标注高亮可编辑，其余标注变暗并锁定：不响应拾取、拖拽、列表删除 / 显隐按钮；`Esc` 或右键取消选中后解锁 |

## 工具栏（快捷键）

| 键 | 工具 | 说明 |
|---|---|---|
| `Shift+V` | 选择 | 选中 / 移动 / 删除已有标注 |
| `Shift+P` | 点标注 | 图标 + 标题 + 图文 + 链接，点击只选中 |
| `Shift+L` | 折线 / 动线 | 多点折线，贴合模型表面渲染成等宽箭头链（箭头即多边形轮廓），可实时读里程 |
| `Shift+E` | 面域 | 闭合多边形，实时面积读数 |
| `Shift+B` | 展板 | 面向相机的全息面板，按距离缩放 |
| `Shift+N` | 三维屏 | 世界空间固定朝向的实体显示屏，可播放视频（快捷键刻意避开 W/A/S/D） |
| `Shift+R` | 贴面矩形 | 在画面里框一个屏幕矩形，逐点用高斯深度反算成贴合眼前真实表面的世界网格，预留视频投射 |
| `Shift+M` | 测量 | 两点距离 + 比例校准（米） |

工具栏右侧还有两个**全局功能按钮**（不属于绘制工具，随时可切）：

| 按钮 | 说明 |
|---|---|
| **碰撞体 开/关**（`Shift+C`） | 全局显示 / 隐藏碰撞体 MESH 线框；直接驱动引擎 `collisionOverlayEnabled`，状态写入 localStorage（`mgEditorMeshOn`），退出编辑时恢复原值。贴面矩形 / 动线贴地时可打开对照表面 |
| **深度 开/关** | 落点贴合 MESH 表面 vs 锁定绘制平面 |

> 工具键统一用 `Shift+字母`，且**刻意避开 `W A S D`**——这四个键归漫游，
> 且引擎按 `event.code` 判定（`Shift+A` 会被当成「加速左移」）。
> 快捷键注册在 `document` 冒泡阶段，引擎的监听挂在 `window` 冒泡阶段，
> 因此编辑器能在引擎之前拦截按键，两者互不干扰。

其他快捷键：`Enter` 完成当前绘制并回到「选择」 · `Esc` 取消绘制 / 取消选中 ·
`Backspace` 退掉上一个顶点 · `Ctrl+Z` 撤销 · `Ctrl+Shift+Z` / `Ctrl+Y` 重做 ·
`Tab` 预览态 · `Ctrl+S` 导出 JSON · `Delete` 删除选中标注。

## 展板：悬浮全息面板

展板是悬浮在三维空间里的半透明玻璃面板（等宽网格底纹 + 扫描线 + 四角切角 +
发光描边 + 四角拖拽手柄 + 到底部锚点的导引线）。**内容全部直接内嵌在展板本体里，
不会弹出独立页面 / 内容卡片**，在右侧属性面板的「**展板内容**」区切换：

| 类型 | 渲染方式 | 说明 |
|---|---|---|
| 无（纯文字） | 标题 + 正文段落 | 默认形态 |
| 图片 | `<img>` 等比裁切 | 支持本地路径 / 外链 / data URL |
| 网页 | 展板内 `<iframe>` 直接嵌入 | sandbox 隔离（不含 `allow-popups`，链接不会弹新页面）；未选中时透明遮罩接管点击用于选中 / 拖拽，选中后网页可直接交互 |
| 视频 | `<video controls muted loop>` | 直接在展板内播放 / 暂停 |

展板内容区在面板内部滚动（`overflow:auto`），媒体 DOM 用签名比对，**只有内容真的变了才重建**，
所以改标题 / 颜色不会让 iframe 或视频重载闪烁。
展板按距离缩放但设有可读下限（`BOARD_BASE_PX=200`、`zoom≥0.8`）；
`--w/--h` 已包含 zoom，因此 `transform` **只做位移、不再二次 scale**，否则远处展板会被压成看不清的小方块。
标题、正文、颜色、透明度、图层、分组、外链、宽高（米）均可编辑，四角拖拽缩放、拖拽面板移动。

### 引线锚点：拖动 + 自动吸附最近碰撞 MESH

默认导引线只有 14px，末端圆点就是展板自身的落点。编辑模式下圆点会亮起呼吸光环、
变成 `cursor:move` 的拖拽手柄（命中范围外扩 9px），拖动时：

```
picker.snapToMesh(光标)
  L1 光标处主射线 × 碰撞 MESH           -> 直接吸附
  L2 落空时按 7/14/24/38px 环形投射辅助射线 -> 取离光标最近的一处 MESH 命中
  L3 全落空时用三角网空间哈希查最近三角面 -> 把自由落点投影到真实表面
```

结果写入 `style.leadTo`（一个独立于 `points[0]` 的世界坐标），导引线据此**实时拉长并旋转**
到新锚点；状态栏提示「已吸附 MESH 表面」。属性面板的「**复位引线锚点**」按钮把锚点收回脚下。
预览态圆点 `pointer-events:none`，只读。

> 实现要点：吸附全程同步、只查已就绪的 BVH，拖动不会因等待碰撞体异步加载而卡顿；
> 三角网空间哈希按 2m 体素只建一次并缓存在 `WeakMap`，不会重复下载 / 重建 BVH。

## 三维实体屏：世界空间里一块固定不动的显示屏

工具栏 `Shift+N` 新增 `screen` 类型。它和「悬浮全息展板」是**两类完全不同的对象**：

| | 悬浮展板 `board` | 三维实体屏 `screen` |
|---|---|---|
| 朝向 | 永远正对相机（billboard） | 由 `style.yaw / pitch` 固定，不随视角转正 |
| 大小 | 屏幕像素按 `zoom = clamp(18/d)` 人为缩放，设可读下限 | 世界尺寸 `style.size{w,h}`（米），视觉大小只由真实透视决定 |
| 相机绕到侧面 | 仍是正对的矩形 | 自然压扁成梯形；绕到背面显示金属背板 |
| 位置 | 可拖动面板 / 拖引线锚点 | 选中后拖屏体 / 中心柄或 X/Y/Z 轴柄移动；未选中时单击只选中 |
| 内容 | 文字 / 图片 / 网页 iframe / 视频 | 屏内 `<video>` 循环播放视频 |

**实现**：`schema.screenCorners()` 由世界中心点、世界尺寸、固定 yaw/pitch 算出 4 个世界角点
（yaw=0 时屏面法向为 -Z，即默认相机侧），`overlay` 每帧把这 4 点投影到屏幕，
再用 `schema.homographyMatrix3d()` 求四点单应，写成 CSS `matrix3d(...)` 把一块
480×(480·h/w) 的 DOM 贴到透视四边形上（`transform-origin:0 0`，平行四边形自动退化为纯仿射）。
相机 right 与屏面局部 right 相反时会自动交换左右角点，避免屏内文字镜像。

**视频**：屏内是真正的 `<video muted loop autoplay playsinline>`。
未填视频 URL 时播放 `canvas.captureStream()` 生成的程序化演示流（有画面、零网络请求）；
在属性面板填入 mp4 / webm URL 后立即切换为真实片源。媒体签名比对，改标题 / 颜色不会重载视频。

**属性面板「三维实体屏」区**：视频地址、宽 / 高（米）、`yaw` / `pitch`（度）、静音、循环。
DOM 含金属外框、铭牌、四角螺丝、底部支架与背板，整体随同一个 `matrix3d` 一起透视变形。

### 选中后三轴 gizmo 拖动（X / Y / Z + 中心选择柄）

选中屏后，屏心浮出 `.ed-screen-gizmo`（编辑软件通用交互）：3 根带箭头的彩色轴柄
（X 红 `#f87171` / Y 绿 `#4ade80` / Z 蓝 `#60a5fa`，line + arrowhead + `.ed-gizmo-hit` 命中圆）
+ 中心选择柄。挂在**独立 DOM 层**（不受屏体 `matrix3d` 压扁），取消选中即隐藏。
旧的六向（上/下/左/右/前/后）手柄已整体移除（`.ed-axis-handle` 不复存在）。

- `overlay._axisBasis()` 返回 x/y/z 三根世界轴的 `world` 方向、屏幕投影方向与
  「每米多少像素」`ppm`；某轴投影长度 < 4px（几乎与视线重合）时兜底 `ppm=80`
  与固定屏幕方向，斜视 / 背面时方向也不会反。
- 拖轴柄沿 `world[key]` 一维移动；拖屏体 / 中心柄在相机平面内自由移动（保留 right/up 组合）。
- 位移统一用「按下瞬间的世界起点 `start` + 累计 `delta`」写回 `points[0]`，不做逐帧累加，
  避免漂移；位移 ≤ `DRAG_PX`(6px) 一律视为单击，**绝不改写位置**。
- 每次拖动合并为一条撤销记录（`coalesceKey: screen-move:<id>`），多选平移逻辑不变。

> 已知边界：DOM 透视方案不做近平面裁剪，任一角点落到相机背后时整块屏暂隐；
> 真实 GPU 环境下由引擎相机投影，正常浏览视角不会触发。

## 动线：贴合模型的等宽「箭头形状多边形」链

`line` 不再是一根细线，也不是「底带里塞几个小箭头」。它本身就是一串首尾相接、
**由多边形轮廓形成箭头**的段（`.ed-flow-arrow-seg`），宽度全程一致。

### ① 贴合模型（不悬空）

用户落点只是几个控制点，长直段跨过台阶 / 坡道时会从模型上方飞过去。渲染前：

```
picker.drapePolyline(points, 0.45m)
  ├─ schema.resamplePolyline  : 按 0.45 m 等距补点（段终点仍是原顶点）
  └─ 逐点 drapeSurface        : 从 p.y + 0.18m 向下打 2.5m 短射线 × 碰撞 MESH
                                ├─ 拒绝高于采样点的命中（天花板一律丢弃）
                                ├─ 落空时从 p.y - 0.45m 向上打 0.7m 短射线兜底
                                └─ 仍落空时 nearestMeshPoint 最近三角面兜底
```

- 命中点必须满足 **XZ 自洽**（与采样点平面距离 < 0.5 m）。垂直射线不该横向偏移，
  否则说明是擦边物体或测试桩 `queryRay` 恒返回固定点 —— 这类命中一律丢弃、保留原 Y，
  避免整条动线塌缩到一个点。
- 贴合结果**与相机无关**，overlay 按 `points / bandWidth / MESH 版本` 签名缓存，
  不会每帧打几百条射线；MESH 就绪或顶点变化时才重算一次。

#### 修复：结束后「乱飞到天花板」

旧版 `drapeSurface(p, up=4)` 从 `p.y + 4m` 向下打 `10m` 射线。展厅天花板通常只有
3~3.5 m，射线起点已经在天花板上方，**第一个命中就是屋顶**；而垂直射线的 XZ 自洽校验
永远成立，于是绘制中的草稿看着正常，双击 / `Enter` 结束后整条动线被吸到天花板上。

现在改为：`up = 0.18m` 的短射线（最长 2.5 m）、强制 `q.y <= p.y + up + 0.02`、
反向短射线兜底、`drapePolyline()` 再叠加「垂直位移 > 1.5 m 一律判为错误吸附」的二次保险；
`drapeQuad()` 起点从 3.5 m 降到 0.25 m，`drapeVersion()` 表面探针从 24 m 降到 2.2 m。
回归里专门用「向下射线恒返回 3.2 m 屋顶」的桩验证：双击 / `Enter` 结束后动线仍在地面。

### ② 宽度一致 + 箭头即轮廓（本轮迭代：面片改世界空间贴合）

`schema.arrowChainWorld()` 沿贴合碰撞 MESH 后的**三维中心线**直接生成箭头段，
每段是 6 顶点世界空间面片（局部 u 前进 / v 横向），再逐点投影到屏幕绘制。
**不再是屏幕空间 SVG billboard 链** —— 旧 `arrowChain()` 先投影成屏幕折线再铺段，
本质是朝向摄像机的平面片，斜视时横穿立体物会「飘」在画面上；新实现的面片严格贴在
碰撞体 mesh 表面上方 3cm（防 z-fight），带真实三维侧向：

- 侧向 `lateral = tangent × worldUp`（水平侧向）；竖直切线（楼梯 / 电梯井）回退
  `cross(t, [1,0,0])`，再不行取 `[0,0,1]`，任何路径都有有限值。
- **带宽语义从屏幕 px 改为世界米**：`halfW = clamp(bandWidth × 0.45, 0.12, 2)`，
  `segLen = max(0.8, halfW × 4.6)`；端点残段整体等比缩短，箭头尖不越出路径终点。
- **流动相位方向与箭头指向一致**（本轮修复）：段位置 `raw = (i + frac)·L` 随相位向
  路径前进方向 +s 推进，与箭头尖（u=avail，指向 +s）同向；旧式 `(i - frac)·L`
  会让段向起点倒退，看起来「动画方向和箭头方向反了」。

```
(0,-hw) → (headStart,-hw) → (tip,0) → (headStart,hw) → (0,hw) → (notch,0)
   尾部角      肩部          箭头尖       肩部          尾部角    V 形凹口
```

- **严格等宽**：所有顶点横向偏移都落在 `[-hw, hw]`，箭头翼绝不外扩，不产生 miter 飞边；
  宽度取屏幕像素，全段（含远处）一致，不随透视忽宽忽窄。
- **指向来自轮廓**：前端三角尖 + 尾部 V 凹口由多边形自己形成，没有任何叠加的小箭头图标。
- 弯道处每个顶点按所在弧长取局部切线 / 法向，箭头跟着折线一起转弯。
- 跨界（路径首尾）的段按可用弧长**整体等比缩短**，而不是把超出的顶点夹到端点 ——
  后者会让多个顶点塌成一点、拉出细长三角尖刺。
- 相位 `flowSpeed` 让整串箭头沿路径向前推进；`flowArrow=false` 时退化为 4 顶点等宽矩形段。

属性面板「动线样式」可调带宽（米）、箭头速度、箭头开关；示例动线默认 `0.9m`。
`bandWidth` 只映射为屏幕半宽（`clamp(bw×26, 8, 36) px`），因此数值含义是「相对粗细基准」。

### ③ 绘制过程中也能看见线（不再只出现点）

早期版本在草稿阶段只画顶点手柄，箭头链要等双击结束才渲染，视觉上像「只点了几个点、
没有线」。现在草稿层同时给出三段反馈：

- **双层折线**：`.ed-draft-halo`（深色粗光晕）+ `.ed-draft`（亮色主线），
  在明亮墙面 / 深色地面上都保证可见；顶点手柄与橡皮筋照旧。
- **实时箭头预览**：草稿是 `line` 时按同样的 `arrowChainWorld()` 世界空间面片生成
  `.ed-draft-flow-seg`（光标点以直线段近似拼入三维中心线，按
  `JSON.stringify(points) + '|' + drapeVersion()` 签名缓存），
  画中的箭头链与最终成线完全一致，边画边看走向；**右键 / `Enter` 结束**。
- **双重退化兜底**：贴合后的中心线若塌缩成一点（长度 < 0.5px），退回原始锚点重画；
  箭头链确实画不出来时，把底层折线从 `transparent` 改成显式可见描边
  （`stroke-opacity=0.95`），任何情况下都至少有一条完整线，不会只剩孤立的点。

## 双击语义、选中锁定与全局碰撞体

**双击全程无事件（本轮迭代定稿）**。`stage` 捕获层对 `dblclick` 一律
`preventDefault + stopImmediatePropagation` 纯拦截：不结束绘制、不回标注机位、不触发引擎
「双击漫游到目的地」。绘制收尾统一走**右键单击 / `Enter`**；列表定位走「飞到此处」按钮。
`overlay` 元素 / SVG 与 `panel.js` 列表行的 dblclick 监听已全部移除，
合成双击判定（`lastTap / DBL_MS / DBL_PX`）也已删除，左键和右键的双击都不触发任何事件。

**右键单击 = 结束当前标注动作**。`stage` 捕获阶段的 `contextmenu` 监听统一处理：
`preventDefault + stopImmediatePropagation`（拦掉引擎右键菜单 / 漫游）；有草稿时
`finishDraftAfterPending(true)` —— 点数达到该工具下限即完成标注并回「选择」，
不足下限 `finishDraft` 丢弃草稿同样回「选择」（状态栏「已取消本次标注」）；
无草稿时命中标注弹上下文菜单、空白处取消选中（状态栏「已取消选中」）。
`.ed-ui` 面板内的右键仍交给浏览器（复制 / 粘贴等），不受影响。

**选中一个标注，其余全部锁定**：被选中项加 `.ed-sel` 高亮；未选中项加 `.ed-locked`
（变暗 + `pointer-events:none`），`onPick`、展板拖拽、锚点拖动、列表行删除 / 显隐按钮
全部走 `isLocked(id)` 守卫，锁定期内不可被拾取或改写。`Esc` / 右键取消选中即解锁。

**全局碰撞体 MESH 开关**：工具栏「碰撞体 开/关」或 `Shift+C`，调用引擎
`__mgCollisionDebug.setMeshOverlay()`（旧引擎退回 `state.collisionOverlayEnabled`），
按钮文案、状态栏、localStorage（`mgEditorMeshOn`）同步；进入编辑时按记忆恢复、
退出时还原浏览态原值。截图 `selection_lock_mesh.png` 里可见 MESH 线框与锁定态列表。

## 贴面矩形：用深度反算贴合眼前真实表面

旧实现「两个世界点 + 表面法向切平面 + 逐点向下射线吸附 MESH」已被判定**完全不可用**：
向下射线会先命中天花板，且切平面与用户在屏幕上框的位置毫无关系。现在改为
**屏幕矩形 + 逐像素深度反算**。

`Shift+R` → 在三维画面里点两个对角。编辑器把这两次**屏幕点击**用
`schema.screenRectUV(canvasRect, p0, p1)` 归一化成 `[u0,v0,u1,v1]`（0..1，与窗口分辨率无关，
反向拖拽自动交换、退化成线时补最小可视框），随标注持久化到顶层 `rect` 字段。

```
picker.unprojectRect(rectUV, nu, nv)
  ├─ 在矩形内按 (nu+1)×(nv+1) 取采样点，换算成 CSS 像素 clientX/Y
  └─ 逐点 depthUnproject(x, y)        ← 每批 6 条并发，避免塞爆拾取队列
       ├─ 优先 viewer.picker().pick(u,v)：引擎读高斯 / 帧深度缓冲反投影为世界点
       │    （screen(x,y) + depth → world），命中即 source = 'depth'
       └─ 深度图不可用时回退：相机射线 × 碰撞 MESH → 地面 → 自由点
  空采样由 fillGridGaps() 用最近有效邻居补齐
  → { rect, nu, nv, points, source, samples, stats }
```

结果写进注记顶层 `surface` 字段持久化。**之后每帧只需把这些世界点重新投影到当前相机**：
换机位会自然产生透视变形，墙面凹凸 / 台阶 / 斜顶也真实弯折，贴面始终黏在模型上。

| 层 | 实现 | 作用 |
|---|---|---|
| GPU 投射（现行） | `decal-projection.js` 全屏 quad + 逐像素反算投影机 OBB（WebGL2/GLSL + WebGPU/WGSL 双 shader） | 视频逐像素投射到真实表面，像素级贴合、不重构网格 |
| SVG 网格 | `a.surface.points` 每格一个 `.ed-decal-cell` 四边形 | 几何事实可见 + 拾取命中区；换视角只重投影，不重算深度 |

- **片源同步（本轮修复的根因）**：GPU 投射实例由 `decalMgr.sync(getDecals())` 驱动，
  `getDecals().videoUrl` 来自 `a.media[0].url`。旧代码只在建投影机 / 改 decalDepth /
  编辑器启动时调 `syncDecals()` —— **先画贴面、再填视频 URL 时实例永远停在演示画面**，
  这就是「贴面矩形没法正常播放视频」的数据层根因。现在 `action()` 末尾统一
  `syncDecals()`，media / local-video / local-video-file / delete / duplicate / undo / redo /
  item-vis 等全部路径改完片源即时重喂，实例 `videoUrl` 与 `demoMode` 状态同步翻转。
- 真机探针（`tools/probe_decal_video.mjs`，WebGPU 后端）实证：`action('local-video')`
  后 500ms 内实例 `videoReady=true / demoMode=false / videoErr=null`；改片源
  `?v=2` 同样 500ms 内重喂成功；清空片源回退演示画面。
- 无片源时播放 GPU 端内置演示画面（动画条纹 canvas，零外部资源）；填入视频 URL
  即切换为该片源（`mp4 / webm`）；`muted + loop + playsinline` 保证自动播放不被拦截。
- `decalMgr.debug()` 诊断钩子返回 `pickReady / degraded / gpuErrors / instances[]
  {videoUrl, demoMode, videoReady, videoErr}`；本轮修正 `videoReady` 误读
  `i.videoWidth`（实例上不存在）为 `i.video.videoWidth`。
- 属性面板显示「投影机 OBB · 深度表面：N×N 网格 · M 点 · 来源 高斯深度 / MESH 表面 · 屏幕框 [...]」，
  提供 **`↻ 按当前视角重建投影机`** 按钮（换机位后按当前画面重算同一屏幕区域）、
  投射不透明度 / 边缘 / 盒厚（decalDepth，改后仅重算 OBB 半尺寸）、颜色与投射 URL。
  旧版细分密度 / 法向抬升控件已随 GPU 投射方案移除。
- 挂载时 `ensureDecalSurfaces()` 给「有 `rect`、无 `surface`」的示例 / 旧文档自动补算一次；
  `decalTokens` 令牌防止并发重建互相覆盖。导入的**老文档两个字段都没有**时仍走
  `drapeQuad()` 切平面兼容兜底（起点已从 3.5 m 降到 0.25 m，同样修掉天花板误吸），不会白屏。

### 验收口径（2026-11-16 修正，重要）

「贴花有没有正确渲染」**不能**用「OBB 正对相机面的屏幕投影 AABB」当分母来量：
OBB 有 4 m 厚度，前表面比真实表面近约 2 m，透视放大后它的屏幕投影**虚大 4.59 倍**
（实测 376,356 vs 用户框选区 81,928 设备 px），覆盖率被稀释到 0.24，
看起来像「渲染不完整」，其实贴花是完整的。

**正确口径**（`tools/probe_decal_realpath.mjs` 现已采用）：

| 指标 | 定义 | 阈值 |
|---|---|---|
| ① 选中区覆盖率 | 显著变化像素 ∩ **用户框选矩形** ÷ 框选区面积 | ≥ 0.80 |
| ② 选中区填充比 | 变化像素包围盒 ÷ 框选区面积 | ≥ 0.70 |
| ③ 主色相差 | 贴花区主色相 vs 演示画面主色相 | ≤ 15° |
| ④ 孤立点率 | 8 邻域无变化的变化像素占比（椒盐点守卫） | ≤ 2% |
| ⑤ OBB 外溢出率 | 变化像素落在投影机盒外的比例 | ≤ 1% |

配套要点：
- **噪声基线帧**：场景内有循环播放的视频，帧间本身就会变。探针多截一帧「贴花仍隐藏」
  的帧（hidden2），`hidden vs hidden2` 即动画噪声，显著变化 = `(visible vs hidden)` 且非噪声；
- **行序约定**（WebGPU 与 WebGL2 不同）：WebGPU pick 纹理**行 0 = 屏幕顶**，
  WebGL2 行 0 = 屏幕底，弄反 = 深度图上下镜像 = 重建点全部落在盒外 = 「只有包围盒没有视频」。
  实测 WebGPU 下 `top_flipY` 变体与引擎权威点误差为 0；
- **GPU 错误归属**：WebGPU `uncapturederror` 是全局的，引擎自己 mesh 的 pipeline 出错
  也会走同一回调。贴花用「错误作用域 + 复测二分」判定归属：关掉贴花后仍有错 = 非贴花故障，
  **不降级**。否则会出现「别人的错误把贴花全隐藏 → 用户只看到框线」。

真机结果（桌面 Chrome + WebGPU）：**5 项全 PASS**，覆盖率 0.9642 / 填充比 1.0000 /
主色差 5° / 孤立点 0% / OBB 外溢出 0.00000。

## 本地视频播放（test.mp4）

用户指定的测试片源 `viewer_stream/www/media/test.mp4`（99,031,577 B）已复制到
`web/media/test.mp4`。三维屏、贴面矩形、以及「内容类型 = 视频」的展板都支持：

| 入口 | 行为 |
|---|---|
| 属性面板 **`▶ 使用工程内测试视频`** | 写入 `./media/test.mp4`，屏内 `<video>` 立即换源循环播放 |
| **`选择本地视频文件`** | `<input type=file>` → `URL.createObjectURL(file)` → 写入 `media.url`，零上传、零外链；刷新后需重新选择 |
| 视频地址输入框 | 任意 mp4 / webm / m4v URL |

`serve.py` 为 `.mp4/.m4v/.webm/.ogv/.mov` 显式声明 MIME，并支持 `Accept-Ranges: bytes`。
播放器首包通常请求 `Range: bytes=0-`：对 >4 MB 的视频只返回 **1 MB** 的 `206 Partial Content`
（`Content-Range: bytes 0-1048575/99031577`），Chromium 按需续传后续分片，边下边播；
文件尾部的 `moov` 元数据也能通过 `Range: bytes=99000000-` 单独读取，进度条可拖动。
面板销毁时 `URL.revokeObjectURL()` 释放本机文件占用的内存。

## 拾取后属性面板自动展示内容

任何标注（点 / 线 / 面 / 展板 / 测量）被场景内点击或列表点击拾取后，右侧属性面板顶部
出现只读「**内容预览**」：类型标签、标题、正文、媒体（图片 / 视频 / 网页 iframe）、外链。
它与三维空间内嵌内容互补，**不是独立弹层**；外链资源不在面板里预加载（避免跨域请求）。

- 预览区只改 `textContent` / 按媒体签名替换，输入时**不重建 DOM**，焦点与光标全程保持。
- 预览态默认收起左右栏，但拾取标注后右侧面板以「只读内容预览」重新出现，编辑控件仍隐藏。
- 顺带修掉三个既有问题：展板 `pointerdown` 曾无条件抑制 `click`（导致单击展板永远不选中）；
  属性面板 `change` 曾把 `<input type=number>` 的值当字符串写回数据模型；
  展板拖动曾用「鼠标当前屏幕坐标」直接反投影覆盖 `points[0]`，点一下板面位置就跳到光标下的场景表面
  （现改为 6px 阈值 + 以锚点屏幕位置按位移平移 + 不再打断原生 `mousedown → click` 序列）。

## 拾取来源与深度开关

工具栏的「**深度 开 / 深度 关**」决定落点方式：

| 深度 | 落点来源 | 适用 |
|---|---|---|
| **开**（默认） | `MESH` → 深度图 → 地面/墙面平面 → 悬浮 | 贴合真实表面，单点标注用 |
| **关** | 统一锁定在相机前方的**绘制平面** | 画线/面，保证所有顶点严格共面 |

状态栏会实时显示当前来源：`MESH 88,888 面`、`深度图就绪`、`深度开/深度关` 等。

**有碰撞体 MESH 时优先用 MESH**：工程自带的官方分块 PLY + btree 碰撞体被直接复用
（`viewer.collision()`），不重复下载、不重复构建 BVH；点线面都落在真实三角面上。

碰撞体在**后台**预热，拾取热路径上从不等待它——早期版本在热路径里 `await` 碰撞体，
一次点击最多要卡 8 秒，是「显示不及时」的主要根因。

### 每个注记独立的「深度检测」

工具栏那个开关只管**绘制时落点**；属性面板里的「**开启深度检测**」是**逐注记的渲染期开关**，
两者互不相干：

| `depthTest` | 行为 |
|---|---|
| `false`（默认） | 始终置顶可见，DOM 叠加层原有语义，不改变既有视觉 |
| `true` | 每帧从相机向该注记投射射线，若**所有顶点**都被更近的碰撞 MESH 挡住则整体隐藏 |

- 用「全部顶点」而非「任一顶点」，避免长动线 / 大面因一个角被挡就整条消失。
- 命中点必须落在「相机 → 注记」视线上（偏离 < 0.45 m）且距离更近才判定遮挡，
  避免擦边物体或测试桩造成误隐藏。
- 字段在 `makeAnnotation()` 顶层，旧文档经 `Store._normalize()` 自动补 `false`；
  随 JSON 导入导出、撤销栈一起持久化，不影响 `style` 合并逻辑。

## 落点为什么会「画不进场景」

3DGS 没有可 raycast 的网格表面，落点靠三级降级：

```
MESH 三角形求交  →  高斯深度图回读  →  地面/墙面平面求交  →  相机前悬浮
```

- **MESH**：官方碰撞体，`queryRay` / `querySurfaceNormal`，最精确。
- **深度图**：引擎的 `FrameDepthPicker`，基于高斯渲染的深度缓冲回读（带 900 ms 超时兜底）。
- **平面**：深度关闭时锁定的绘制平面，保证线面共面。

## 分组管理

分组是**业务归类 / 批量管理**，与「图层」（渲染层级 + 颜色）互不干扰。数据存在
`doc.groups[]`（`{id,name,color,visible,collapsed,order}`），标注用 `groupId` 归属；
旧文档读取 / 导入 / 撤销恢复时自动补默认分组与 `groupId`，无需迁移。

- 左栏「分组」区：`＋` 新建（并自动设为当前分组）、点击行设为当前分组、行内 input 直接改名、
  `▾` 折叠、`↳` 把当前选中标注归入此组、`◎` 飞到该组标注中心、`👁` 整组显隐、`✕` 解散分组。
- **当前分组**：之后绘制的标注 `groupId` 自动设为该组（默认 `default`）。
- 标注列表按分组折叠展示，组头显示名称与数量；引用了已删分组的标注兜底显示在「未分组」。
- 右栏「属性」新增「分组」下拉，可直接改派；也可在分组行点 `↳`。
- **整组显隐**只切换 `groups[].visible`，由 overlay 每帧过滤，**不改写**每个标注自身的
  `visible`，取消隐藏后用户单独隐藏的标注原样恢复；一次操作 = 一条撤销。
- **解散分组不删标注**：组内标注移回默认组；默认组不可删除。折叠不进撤销栈但仍持久化。

## 图层、导览与数据

- **图层**：左栏新建图层、显隐、颜色标识；标注按图层过滤。
- **属性**：右栏编辑标题、正文、展板内容、外链、样式、图层、分组、机位、可见性、
  逐注记「开启深度检测」、锁定。
  连续打字会**合并成一次撤销**，输入框焦点与光标位置全程保持，不会被打断。
- **导览**：站点机位 + 停留时长 + 自动播放。
- **持久化**：默认存浏览器 localStorage；`Ctrl+S` 导出 `maoming-annotations.json`（含分组 / 图层 / 导览 / 比例校准）。

## 目录结构

```
web/editor.html            旧链接跳转入口（兼容用）
web/editor/
  schema.js                数据模型（含逐注记 depthTest / rect / surface）+ 分组常量 + 距离/面积
                           + 动线几何 resamplePolyline/arrowChain
                           + 实体屏四角(screenCorners)与四点单应(homographyMatrix3d)
                           + 深度贴面 screenRectUV/decalGridIndex（decalFrame/GridPoints 兼容旧文档）
  store.js                 CRUD / undo-redo / 分组 / 图层 / 导览 / 旧文档归一化（补 rect/surface）
  picking.js               三级拾取降级 + 深度开关 + 绘制平面锁定 + 同步预览拾取
                           + snapToMesh 吸附 + drapePolyline/drapeSurface/drapeQuad 短射线贴地
                           + depthUnproject/unprojectRect 逐像素深度反算
                           + occluded 遮挡 + drapeVersion 表面探针缓存版本
  mesh-pick.js             碰撞体 MESH 复用与求交 + nearestMeshPoint 最近三角面查询
  overlay.js               世界锚定投影（DOM 点/展板/实体屏/贴面 + 世界空间箭头面片动线
                           + 草稿双层线与实时箭头 + 选中锁定 + 内嵌媒体
                           + 三维屏三轴 gizmo _axisBasis/_updateScreenGizmoGeom/_attachScreenDrag）
  panel.js                 工具栏（含全局碰撞体按钮）/ 图层 / 分组 / 属性 / 内容预览 / 列表 / 导览
                           + 本地视频（工程内片源 / 本机文件 object URL）+ 深度表面状态
  editor.js                状态机、快捷键、动作分发、右键统一语义、surface 异步重建，暴露 window.__mgEditor
  bridge.js                iframe 生命周期桥 + 模块预载
  editor.css               编辑态样式（浏览态无对应 DOM，零视觉影响）
web/media/test.mp4         本地测试片源（99 MB，来自 viewer_stream/www/media）
serve.py                   静态服务：视频 MIME + 1MB Range 分片（206 边下边播）
tools/verify_editor.mjs    全链路回归（Chrome CDP，292 项 / 33 段，含 [33] 源码静态守卫）
tools/probe_decal_video.mjs  **真机视频播放探针**：WebGPU 后端进编辑态，断言贴面矩形
                          片源设置 / 改片源 / 清空回退 demo 全链路（videoReady/demoMode/videoErr）
tools/diagnose_decal_repro.mjs  **真机后端专项**：强制 WebGPU（Dawn SwiftShader）、
                          真实新建贴面矩形、canvas 像素 / shader 编译错误 / 前置条件断言
tools/diagnose_editor_canvas.mjs  编辑态画布专项诊断（WebGL2）：隐藏全部 DOM 后只测
                          canvas 像素、postrender 帧计数、GL framebuffer/clearColor、
                          JS 异常与贴花守卫告警
tools/diagnose_blackscreen.mjs  黑屏真机诊断（不注入 mock：iframe 异常 / 404 / 像素亮度 /
                          帧间差分 / gsplats / 首帧门控时间线 / 楼层切换 / 机位 A-B）
tools/shoot_board.mjs      展板 / 动线 / 实体屏 / 深度反算贴面 / 三轴 gizmo / 本地视频截图（shots/，17 张）
```

## 性能说明

编辑器模块通过 `modulepreload` 在 HTML 解析期预下载，并在桥接脚本加载时立即求值，
用户点击时 `import()` 直接命中模块缓存。

另外，3DGS 渲染循环会长时间占满主线程，而模块求值必须排队进入主线程。
进入编辑模式时，父页会**同步**暂停 iframe 的渲染（`app.autoRender = false`），
给模块求值让路；编辑器挂载完成后立即恢复。暂停的只是绘制，
`update(dt)` 照常执行，所以 WASD 漫游与相机状态不受影响。

实测（真实 GPU 环境）：从点击到编辑面板出现 **13 ms**。

叠加层每帧只做两件事：把标注世界坐标投影到屏幕、更新已有 DOM 的 `textContent` / `src`。
DOM 结构只在标注首次出现或类型变化时创建，**不会每帧重建**——
展板里的 `<iframe>` / `<video>` 一旦被重建就会重新加载，视觉上表现为闪烁与加载延迟。

## 回归

```bat
cd /d D:\WorkSpace\AI\3DGS_build\viewer_edit
node tools/verify_editor.mjs
```

覆盖 32 段流程、**264 项**断言，实测 `264 PASS / 0 FAIL`：

1. 静态资源 18 项可达
2. 浏览态（编辑入口 / 桥接就绪 / 模块预载）
3. 进入编辑（模式切换 / UI 隐藏 / MESH 就绪 / 让路机制）
4. 交互（单击落点 / 拖拽放行 / 深度开关 / 绘制平面锁定）
5. 叠加层定位（absolute 定位 / 保留 `ed-item` 基座 / 落在舞台内 / 展板有实际尺寸）
6. 左侧列表 → 右侧属性联动（选中同步 / 焦点不丢 / 光标不丢 / 写回数据）
7. 展板四种内容形态（文字 / 图片 / 网页 / 视频 / 网页内嵌 iframe / 无弹出卡片）
8. 键盘隔离（宿主单键不泄漏 / 工具快捷键生效 / 漫游键放行 / 输入框内不泄漏）
9. 草稿反馈（顶点手柄 / 折线 / 橡皮筋 / 十字准星）
10. 退出编辑（UI 清理 / 渲染恢复）
11. 列表按钮 / 双击结束且回到选择 / 右键取消 / 展板拖拽 / 面板滚轮隔离
12. 分组管理（新建 / 改名 / 指派 / 批量显隐 / 折叠 / 定位 / 解散 / 撤销）
13. 展板内容三维空间内嵌展示（iframe / sandbox / 不重载 / 视频 / 图片 / 只选中不弹页）
14. 引线锚点（编辑态可拖 / MESH 吸附 / 导引线拉长旋转 / 复位 / 预览态只读）
15. 拾取后属性面板自动展示内容（标题 / 正文 / 图片 / 链接 / 同步 / 单击不再被抑制 / 预览态只读面板）
16. 动线等宽箭头链（6 顶点箭头轮廓 / 无渐变底带与带内小箭头 / 宽度严格一致 /
    尖与凹口在中心线上 / 弯道转向 / 流动动画 / 带宽与箭头开关 / 点击拾取）
17. 单击展板不改位置（微抖不写数据 / 真拖拽以锚点为基准）+ 三维实体屏
    （KINDS / 工具栏 / 四角世界几何 / 四点单应 / matrix3d / video 播放 / 视角变而世界数据不变 /
    yaw 写入 / 尺寸与视频 URL 控件 / 背面背板 / 单击屏体只选中）
18. 动线贴合模型（0.5m 等距补点 / 0.18m 短射线逐点吸附 / XZ 不变 / 丢弃不自洽命中 /
    **拒绝天花板命中** / overlay 缓存贴合结果且世界点未吸屋顶）
19. 逐注记深度检测（属性默认关闭 / 开关写回 / 遮挡判定 / 开启时隐藏 / 其它注记不受影响 /
    关闭后置顶可见 / JSON 持久化）
20. 动线绘制可见性（草稿双层线 / 实时箭头预览 / 双击出线 / 箭头链退化兜底 / 贴合塌缩恢复 /
    结束后复位选择 / 双击不漫游）
21. 全局碰撞体 MESH 开关（按钮 / Shift+C / 引擎 `collisionOverlayEnabled` / 文案状态栏 /
    localStorage 持久化 / 退出恢复）
22. 右键单击结束绘制 + 双击全程禁用（stage dblclick 纯拦截 / 左右键双击零事件 /
    合成双击判定已删除 / 列表行双击监听已移除 / `Enter` 结束保留）
23. 选中高亮与其余标注锁定（`.ed-sel` / `.ed-locked` / 禁止命中 / 禁止拖拽 / 列表按钮禁用 /
    属性只对应选中项 / `Esc` 解锁）
24. 贴面矩形（KINDS / 工具栏 / 深度反算表面 / 投影机 OBB 持久化 / GPU 投射实例 /
    投射不透明度 / 边缘 / 盒厚可调 / `Shift+R` 两点成面 / 片源变更即时重喂 syncDecals）
25. 深度反算链路（`screenRectUV` 正/反拖与最小框 / `Picker.pick` 深度命中 /
    深度图不可用回退 / 网格点与 stats / 重建按钮 / 巨盒拦截 /
    换机位只重投影、世界点不漂移）
26. 三维屏三轴 gizmo（X/Y/Z 轴柄 + 中心选择柄 / 世界三轴 world·screen·ppm / 微抖 ≤6px
    不改位置 / 轴柄一维拖动无串扰 / 屏体相机平面移动 / 多选平移 / 取消选中隐藏 /
    旧六向交互入口 `AXIS_HANDLES / ed-axis-handle` 已移除守卫）
27. 本地视频（HEAD 200 + `video/mp4` + 99MB / `Accept-Ranges` / 首包 1MB `206` /
    尾部分片可读 / 工程内测试视频按钮换源 / 本机文件 object URL / 贴面同样有入口）
28. 右键统一回「选择」（清选中 + 工具复位 + 阻止默认菜单与漫游 + 状态栏提示 /
    绘制中丢弃草稿且不生成标注）+ 动线双击 / `Enter` 结束后贴地、不飞天花板
29. 错误汇总（0 JS 异常 / 0 console error / 0 HTTP≥400）
30. 复制 / 层级置顶置底 / 右键上下文菜单（Ctrl+D 偏移 0.5m / order 极值 /
    撤销合并按对象 id 隔离 / 删除后选中态 reconcile / 菜单复制生效）
31. 多选 / 框选 / 对齐吸附（Shift+点击切换成员 / Ctrl+A 全选 / 空白 Shift+拖拽矩形命中 /
    多选删除与复制 / 组内边对齐 + 黄色引导线）
32. GPU 贴花渲染路径守卫（黑屏回归）：WGSL 用 `pcPosition` 而非不存在的
    `input.pcPosition`、WGSL 模板串无反引号、`setTRS` 取代 `setFromQuat`、
    `onPrerender` 异常隔离、`onFrameEnd` 请求主帧 + 异常隔离、无贴花不驱动 Picker、
    真机 WebGPU / 画布诊断脚本存在

展板 / 动线（世界空间面片） / 实体屏 / 深度检测 / 深度反算贴面 / 三轴 gizmo / 本地视频 / 选中锁定视觉验证
（生成 `shots/board_*.png`、`flow_ribbon.png`、`flow_arrows_closeup.png`、
`flow_draft.png`、`screen_3d.png`、`screen_closeup.png`、`depth_test_prop.png`、
`decal_depth.png`、`decal_depth_closeup.png`、`selection_lock_mesh.png`、
`screen_gizmo.png`、`screen_gizmo_closeup.png`、`local_video.png`、
`local_video_prop.png`、`flow_grounded_rightclick.png`）：

```bat
node tools/shoot_board.mjs
```

> 注：headless SwiftShader 软渲染环境下挂载耗时会显示十几秒，这是
> SOG 解码阻塞主线程造成的**环境噪声**；真实 GPU 环境实测 13 ms。

## 黑屏专项测评（修订版 2 · WebGPU 真因）

> **二次勘误**：本页前两版结论都不完整。
> ① 第一版归因为「加载遮罩提前淡出」——错，那只是加载期观感问题。
> ② 第二版归因为 `Mat4.setFromQuat()` 抛异常 + Picker 离屏 framebuffer——
>    **只在 WebGL2 成立**；修完后真机（WebGPU）仍然「一用贴面矩形就黑屏」。
> ③ 真机根因是 **WGSL 编译失败**，见下。用户指出「测试和评估有技术漏洞」是对的：
>    前两版所有诊断都固定跑 WebGL2，从未验证过真机后端。

### 三个层次的问题，别混为一谈

| | 加载期遮罩 | WebGL2 编辑态 | **WebGPU 真机（用户报障）** |
|---|---|---|---|
| 现象 | 首帧前短暂空画布 | 画面冻结 / `clearColor` 变白 | 编辑器 UI / DOM 标注正常，画布整片纯色 `sd=0` |
| 根因 | 遮罩按 canvas DOM 出现 / 600ms 淡出 | `setFromQuat` 抛异常中断 `app.render()`；Picker 离屏 pass 不恢复 framebuffer | `fragmentWGSL` 引用不存在的 `input.pcPosition`，WGSL 编译失败 → WebGPU render pass 整体不呈现 |
| 修复 | `installFirstFrameGate()` | `setTRS` + 异常隔离 + `renderNextFrame` | WGSL 改用引擎私有量 `pcPosition` |
| 是否真因 | 否 | 否（并存缺陷） | **是** |

### WebGPU 黑屏的决定性证据

引擎 `viewer/index.js:9323` 的 `FRAGMENT_BUILTINS` 把 `@builtin(position)` 映射为
`FragmentInput.position`，并由 `_pcCopyInputs` 拷进 **`var<private> pcPosition`**
（`viewer/index.js:9951-9963`、`renderBuiltinCopies` at `:9351`）。而
`decal-projection.js` 的 `fragmentWGSL` 写的是 `input.pcPosition.xy`：
`FragmentInput` 根本没有这个成员，**WGSL 编译必然失败**。GLSL 分支用
`gl_FragCoord.xy`，完全不受影响。

更隐蔽的三点：

- `makeMaterial()` 的 `shaderOk` 探测（`:442-450`）只 `new ShaderMaterial()` +
  `update()` + `destroy()`，**从不编译 shader**，捕获不到 WGSL 错误。
- 全屏 quad 加在 `app.scene.defaultDrawLayer`、`BLEND_NORMAL`、`depthTest=false`、
  `cull=false`（`:205-256`）；WGSL 失效时整个 render pass 不呈现，画面只剩
  `#mg-stage` 底色。
- PlayCanvas **不抛 JS 异常**：WebGPU 专项诊断里画面纯色黑屏，但
  `JS/console 错误 = 0`。所以「看有没有异常」的旧诊断永远测不到。

**修复**：`let frag = pcPosition.xy;`，并在 `[32]` 加源码守卫（含「WGSL 模板串内
不得出现反引号」——曾因在模板串注释里写了反引号提前终止 JS 模板串，导致整个
`editor-bridge` 语法错误、编辑器不挂载，测试却因判定太松给出假 PASS）。

**运行时加固**：实例创建即 `setParameter('uPickReady', 0)`（shader 首行 discard）；
`sync()` 校验 projector 的 `position/quaternion/half` 长度与数值，含 0 / NaN 时
`visible=false`，避免 `L / decalHalf` 除零导致「整屏都在盒内」。

### 为什么前两版测试全部漏掉

- **后端不对**：所有 headless 诊断都用 `--use-gl=angle --use-angle=swiftshader`，
  `navigator.gpu.requestAdapter()` 返回 `adapter-null`，viewer 静默回退 WebGL2。
  WebGL2 全绿完全不能证明 WGSL 能编译。
- **没执行报障操作**：旧诊断只「进入编辑态」，从没选「贴面矩形」工具、没新建过
  一条 decal；示例数据里已有的 decal 也不等于新建链路。
- **判定太松**：曾有 1 条 `editor-bridge SyntaxError` 却仍判 PASS（编辑器根本没挂载，
  自然不黑屏）。现在把「编辑器挂载 / 工具选中 / 贴面确实新增 / 0 错误 / 后端必须是
  WebGPU」全部列为前置条件。
- `verify_editor.mjs` mock 了 `__viewer` 且没有 `globalThis.__pc`，
  `createDecalProjection()` 在 `decal-projection.js:49-56` 直接返回 disabled，
  整条 GPU 路径不执行；`diagnose_blackscreen.mjs` 对**整页截图**算亮度，被编辑器
  UI 拉高，又把 `gsplats`（统计值）当成像素证据。

### 双击标注定位（已再度移除 · 2026-11-16）

「双击标注回到保存机位」曾在 2026-11-13 作为功能恢复并被回归断言固化；本轮迭代
按用户需求（**左键和右键的双击都不触发任何事件**）**再次整体移除**：stage 捕获层
`dblclick` 纯拦截、`overlay`/`panel` 的双击监听删除、`flyOnItem` 断言删除。
标注定位统一走属性面板 / 列表行的「飞到此处」按钮（`action('fly', id)`，仍用
`flyToAnnotation()` 的保存机位优先 + 落点中心反推逻辑）。以下旧记录仅作沿革存档。

用户反馈「双击标注不能自动定位到之前标注的正确位置」。查明是**有意的设计变更被
回归测试固化**：`editor.js` 的 stage 捕获 `dblclick` 用 `stopImmediatePropagation`
连标注自身的监听一起吃掉，`panel.js` 列表行、`overlay.js` DOM/SVG 三处把双击降级
为「选中」，而 `verify_editor.mjs` 把「0 次 `setCameraPose`」写成了断言。同时
`view` 创建时不保存，`viewFromPoint()` 把 `position.y` 硬编码成 `pt.y+1.0`、
丢弃视线 y 分量，且只取第一个落点。

**修复**：创建标注时保存 `__mgPose()` 到 `view`；双击标注 / 列表行 →
`flyToAnnotation(a)` 优先用保存机位，旧数据按**所有落点中心**反推；`viewFromPoint`
沿完整视线后退保持俯仰；双击空场景仍维持「结束绘制 + 回选择 + 不漫游」。

### 修正后的测试体系（必跑三条）

```bat
node tools/qa_acceptance.mjs             :: 【交付验收门】一键跑完下面三层，产出 qa-report.json
node tools/diagnose_decal_repro.mjs      :: 【真机后端】强制 WebGPU + 真实新建贴面矩形
node tools/diagnose_editor_canvas.mjs    :: WebGL2 编辑态画布 / postrender / GL 状态
node tools/verify_editor.mjs             :: 267 项 DOM/状态回归 + [32] 源码守卫
node tools/diagnose_blackscreen.mjs --wait=12000 --loops=2 --timeline  :: 加载期/楼层切换
```

**GPU 错误观测与 fail-safe**：引擎对 WebGPU `uncapturederror` 的处理是空操作，
任何 validation error 都会让整条 command buffer 提交失败（整屏黑）且完全静默。
`decal-projection.js` 现在会挂自己的监听把错误以 `console.error` 输出，并在贴花
激活期间出错时**自动降级**（隐藏全部贴花实例 + 页面 toast 提示，`sync()` 不会
重新点亮）——宁失贴花显示，不失主画面。`window.__mgEditor.decalMgr.debug()`
返回 `pickReady / degraded / gpuErrors / instances`（含 videoUrl / demoMode /
videoErr），供诊断脚本与真机排查。

### 第四次勘误：「只有包围盒、没有投射视频」与右键失灵（2026-11-13）

| # | 表象 | 真因 | 修复 |
|---|------|------|------|
| 1 | `Destroyed texture used in a submit`（贴花 GPU 错误 6 次、整 pass 失败） | 贴花纹理初始 2×2，首次上传 512×288 内容时引擎销毁旧 GPU 纹理，而上一帧在途 submit 仍引用它 | 纹理固定 1024×576 永不 resize；视频帧经同尺寸转绘画布 `drawImage` 后上传 |
| 2 | 真机投射内容零星碎片 | pick 快照采样行序：WGSL `textureLoad` 行 0 = **顶部**（WebGL 行 0 = 底部），行序反了 = 深度图上下镜像 = 重建点全部落在投影盒外 | 新增 `uPickFlipY`（WebGPU=1 用 uvTL，WebGL=0 用 uvBL），GLSL/WGSL 双分支同步 |
| 3 | 投射碎片化 / OBB 26m×10m 巨盒 | 深度拾取超时退化到碰撞网格（headless 里引擎 pick 慢至 346s）；框选横跨远近物体 → 网格点深度跨度几十米 | rebuild 拾取超时放宽 4000ms + **数据层拦截**：深度跨度 > 1.2×中位或盒宽高和 > 16m 时拒绝建盒并提示重新框选 |
| 4 | 掠射面上贴花只剩一半像素 | 背面剔除硬阈值 `dot<0`：屏幕空间导数法线在掠射面上符号抖动 | 软剔除 `dot < -0.25`，只挡真背面 |
| 5 | URL 留空时什么都不投 | 面板承诺「留空播放内置演示画面」但占位纹理全透明（`vid.a=0` → discard） | 内置演示画面：动画条纹画布逐帧上传，零外部资源，亮色主题暗面也可见 |
| 6 | 右键停不下来长方体交互 | ① `pointerup` 未过滤 `e.button`（右键也进落点队列）；② 异步拾取返回后不复核草稿状态（cancelDraft 后孤儿点又把草稿复活） | pointerup 只认左键；`cancelDraft` 自增 `draftGen`，`placeAsync` 拾取返回后复核世代号与工具；绘制中右键优先取消草稿（先于标注上下文菜单） |

端到端验证：手工构造对准已知地面深度的 OBB（position [0,1.22,7.7]、局部 +z 转
世界 +y、half [4,3,1.2]），WebGPU/SwiftShader 下投射内容实心上屏，A/B 亮度差
0.72~0.80（可见态 vs 隐藏态），GPU 错误 0、degraded=false、pickReady=true。

`diagnose_decal_repro.mjs` 用 `--enable-unsafe-webgpu --use-webgpu-adapter=swiftshader`
拿到 Dawn SwiftShader adapter（实测唯一可用组合，加 `--use-gl=angle` 会把 adapter
挤掉）；断言 `backend === 'webgpu'`，并用 `store.add()` 真实注入一条 decal 以覆盖
`onChange -> syncDecals -> createInstance` 链路。`--gl` 可做 WebGL2 A/B 对照。

`diagnose_editor_canvas.mjs` 截图前**同时隐藏 iframe 内与父页全部 DOM**（否则父页
HUD 在编辑态被 CSS 撤掉，基线不可比）、用 `postrender` 计数证明主帧在重绘、直读
`gl.COLOR_CLEAR_VALUE` / `FRAMEBUFFER_BINDING`、捕获 JS 异常与守卫 `console.warn`
（并自检 iframe warn 捕获通道）。

### 第五次勘误：三段式 shadow-map 深度比较把贴花整块丢光（2026-11-20）

表象：`diagnose_decal_repro` 的 `projDelta = 0`，可见态与隐藏态均值完全相同
（92.46 / 92.46），即「只有包围盒、画面里没有任何视频」。

取证与真因（三步定位，均有截图/日志）：

1. 对照实验 `DECAL_SHADOW=0`（等价 `?shadowPass=0`）→ 投射立刻恢复，差值 6.57
   ⇒ 故障完全来自 shadow-map 三段式，与 OBB / 视频纹理 / 深度反算无关。
2. 给 shadow FS 加诊断探针 `uDebugMode=2`：**蓝 = 投影 UV 越界，品红 = Pass1
   深度图为空，绿 = 有深度**。截图整片品红 ⇒ `shadowSurfaceDepth() = 1.0`。
3. 读实现：Pass1 用引擎自带 `RenderPassPicker` + 正交相机渲染 World 层 splat。
   但本构建主画面已由自定义高斯渲染器接管（引擎 gsplat `meshInstance` 被隐藏），
   pick 通道渲不出任何 splat ⇒ 深度纹理只有清屏色 ⇒ shader 里
   `mapD >= 0.999999 → discard` 把每一个像素都丢掉。

附带发现的两个同源缺陷：

- 碰撞 mesh 回退写的是 **D32 深度纹理**，而 Pass3 的 FS 按 **RGBA16F 四通道
  伯努利试验 + 3×3 邻域 30% 分位** 解码 —— 两种口径混用，要么 `mapD≈0` 全丢，
  要么 WebGPU 深度纹理绑到 `texture_2d<f32>` 触发 pipeline 校验失败。
- `debug()` 的 `shadowReady` 只看旧 CPU 深度图字段，新三段式恒为 `false`，真机
  排查会被误读成「深度图没就绪」。
- 诊断探针初版在 WGSL 里写了 C 风格三元 `?:`（WGSL 非法）→ Invalid RenderPipeline，
  被 fail-safe 判为贴花自身错误而整体降级；改用 `select(falseValue, trueValue, cond)`。

修复（默认回到可工作路径，坏分支显式禁用）：

| 项 | 修复 |
|---|---|
| 默认投影方式 | `depthTest` 默认 **0** → always-on-top：UV 走 OBB 局部坐标，视频在投影盒内无条件显示（Pass3 立方体几何仍启用） |
| 深度比较 | 保留为显式可选：`?depthTest=1` / `sessionStorage.mg_decal_depth='1'` / `setOptions({depthTest:1})`，仅在引擎自带 splat pick 可用的构建里成立 |
| 碰撞 mesh 深度回退 | **禁用**并告警一次：D32 与 RGBA16F 试验口径不兼容，不再假装支持 |
| 诊断字段 | `shadowReady` 统一为「新路径看 depthPassOk+shadowTex、旧路径看 CPU 深度图」，并暴露 `depthTestOption` |
| 调参下沉 | `setOptions({debugMode/boxScale/depthMode/videoFlipY/cull/...})` 立即写进已有实例，探针不再「看起来没输出」 |

验证：同一脚本默认参数下 `projDelta = 7.46`（可见 99.92 / 隐藏 92.46）、
`pickReady=true`、`degraded=false`、GPU 错误 0、`贴面矩形结果: PASS`。

**验证结果（同一脚本、同机前后对比）**：

| 指标 | 修复前 | 修复后 |
|---|---|---|
| WebGPU 编辑态 canvas | `mean=12.72 / sd=0 / blank=true` | `mean=92.63 / sd=46.17` |
| 新建第 2 条贴面后 | 仍 `12.76` 纯色 | `92.64`，与基线偏差 **0.0%** |
| JS/console 错误 | 0（静默失效） | 0 |
| 前置条件 | — | 挂载 / 工具 / 新增 / 后端 全绿 |
| WebGL2 画布诊断 | — | PASS，偏差 0.0%，0 异常 0 告警 |
| 全量回归 | 259 PASS | **264 PASS / 0 FAIL** |

> `autoRender=false` 是 Viewer 首帧后的按需渲染，本身不是故障；加载期首帧门控
> 保留，但它只解决加载窗口。WebGL2 与 WebGPU 是两套 shader 源码，**任何只跑
> 单一后端的「真机诊断」都不算覆盖**。

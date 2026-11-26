/**
 * 引擎适配抽象层（Engine Adapter Contract）
 * ----------------------------------------------------------------
 * 目标：让「渲染框架」与「具体引擎」解耦。编辑器与贴花模块只依赖本文件导出的
 * 契约接口，不出现任何 PlayCanvas 专有类型（pc.Mesh / pc.Material / pc.Entity
 * 既不作参数类型，也不作返回类型）。后续接入 Babylon.js（优先）或 three.js 时，
 * 只需新增一个适配器实现文件，编辑器代码零改动。
 *
 * 契约设计原则（Babylon.js 优先）：
 *   1. 方法名用「意图命名」而非「引擎类命名」：
 *      Babylon 有 Scene / Camera / Engine / Material / Texture / VertexData，
 *      PlayCanvas 有 AppBase / Entity / MeshInstance / ShaderMaterial / Texture。
 *      契约取两者的交集语义（scene / camera / material / texture / mesh），
 *      任何一方的专有后缀（-Instance / -Data / Base）都不进契约。
 *   2. 参数与返回值只用语言内建类型：number / string / boolean / Array /
 *      TypedArray / 普通对象。数学量一律用长度 3/4/16 的普通数组，
 *      纹理与材质用「句柄对象」（不透明引用），不暴露具体类。
 *   3. **矩阵约定显式化**：契约内所有 4×4 矩阵一律是
 *      「列主序（column-major）+ 列向量约定（v' = M · v）」的 Float32Array(16)，
 *      与 GLSL / WGSL / PlayCanvas / three.js 一致。
 *      Babylon.js 内部是行主序 + 行向量约定，其适配器必须转置后再返回，
 *      否则本契约的语义会在 Babylon 上整体错位。
 *   4. 每个方法都有「不可用时」的确定行为：抛错由调用方捕获，或返回 null，
 *      绝不让调用方因引擎差异而崩。
 *
 * 契约分组（7 组 / 48 方法）：
 *   A. lifecycle  生命周期与渲染上下文   (10)
 *   B. scene      场景与相机             (5)
 *   C. material   材质与着色器           (4)
 *   D. texture    纹理与视频             (6)
 *   E. geometry   几何与绘制             (8)
 *   F. picking    拾取与数学             (6)
 *   G. renderpass 深度预通道             (7)   ← Shadow-Map Decal Pass1
 */

export const ENGINE_KINDS = {
  PLAYCANVAS: 'playcanvas',
  BABYLON: 'babylon',
  THREE: 'three'
};

/** 渲染钩子相位（引擎无关；各适配器映射到自己的生命周期事件） */
export const RENDER_HOOKS = {
  BEFORE_RENDER: 'beforeRender',   // 即将渲染本帧（写 uniform / 更新相机矩阵）
  AFTER_RENDER: 'afterRender'      // 本帧渲染完成（抓帧缓冲 / 上传纹理）
};

/**
 * 契约方法清单。
 * 每个条目描述一个方法在跨引擎场景下「必须能做」的事。
 * 适配器实现必须逐条落地；未实现的方法会在 createEngineAdapter 时被记为 missing。
 */
export const ADAPTER_CONTRACT = [
  // ---- A. 生命周期与渲染上下文 (7) ----
  { group: 'lifecycle', name: 'getEngineKind', params: [], returns: 'string',
    desc: '返回适配器对应的引擎标识（playcanvas / babylon / three）。' },
  { group: 'lifecycle', name: 'isReady', params: [], returns: 'boolean',
    desc: '引擎实例是否已就绪、可用于渲染（应用启动完成、画布与设备均可用）。' },
  { group: 'lifecycle', name: 'getRenderSize', params: [], returns: 'number[]',
    desc: '当前渲染目标的物理像素尺寸 [width, height]（非 CSS 像素）。' },
  { group: 'lifecycle', name: 'getBackendType', params: [], returns: 'string',
    desc: '返回图形后端类型：webgpu / webgl2。着色器里的帧缓冲 Y 原点方向与纹理行序都由它决定。' },
  { group: 'lifecycle', name: 'getPixelRatio', params: [], returns: 'number',
    desc: '设备像素比 DPR，用于把 CSS 像素换算成物理像素。' },
  { group: 'lifecycle', name: 'requestRender', params: [], returns: 'void',
    desc: '请求引擎渲染下一帧（按需渲染模式下保证画面持续更新）。' },
  { group: 'lifecycle', name: 'addRenderHook', params: ['phase', 'callback'], returns: 'void',
    desc: '订阅渲染钩子。phase 取 RENDER_HOOKS.BEFORE_RENDER / AFTER_RENDER。' },
  { group: 'lifecycle', name: 'removeRenderHook', params: ['phase', 'callback'], returns: 'void',
    desc: '取消订阅渲染钩子。' },
  { group: 'lifecycle', name: 'observeGpuErrors', params: ['callback'], returns: 'function|null',
    desc: '订阅底层 GPU 未捕获错误（WebGPU uncapturederror / WebGL context lost）。返回取消订阅函数；该引擎不支持时返回 null。' },
  { group: 'lifecycle', name: 'beginGpuErrorScope', params: [], returns: 'boolean',
    desc: '开启一个 GPU 错误作用域：此后本作用域内产生的 GPU 错误会被单独捕获，而不会走全局 uncapturederror 回调。返回是否成功开启（不支持时返回 false）。' },
  { group: 'lifecycle', name: 'endGpuErrorScope', params: ['callback'], returns: 'boolean',
    desc: '结束 GPU 错误作用域并把捕获到的错误交给 callback(errorMessage|null)。返回是否成功结束。作用域内无错误时 callback 收到 null。' },

  // ---- B. 场景与相机 (5) ----
  { group: 'scene', name: 'getScene', params: [], returns: 'object|null',
    desc: '取得场景句柄（不透明）。编辑器只把它透传给适配器自身的其他方法。' },
  { group: 'scene', name: 'getCameraEntity', params: [], returns: 'object|null',
    desc: '取得当前激活相机所在节点句柄（不透明）。' },
  { group: 'scene', name: 'getCameraPosition', params: [], returns: 'number[]',
    desc: '取得相机世界坐标 [x,y,z]（米）。' },
  { group: 'scene', name: 'getCameraInverseViewProjection', params: [], returns: 'Float32Array|null',
    desc: '取得「逆 view×projection」矩阵，列主序 + 列向量约定（可直接喂给 GLSL/WGSL）。' },
  { group: 'scene', name: 'getCameraNearFar', params: [], returns: 'number[]',
    desc: '取得相机近裁剪与远裁剪距离 [near, far]（米）。' },

  // ---- C. 材质与着色器 (4) ----
  { group: 'material', name: 'createShaderMaterial', params: ['shaderSpec'], returns: 'object|null',
    desc: '按引擎无关的着色器规格创建材质。shaderSpec = { name, vertexGLSL, vertexWGSL, fragmentGLSL, fragmentWGSL }。' },
  { group: 'material', name: 'setMaterialParameter', params: ['material', 'name', 'value'], returns: 'void',
    desc: '设置材质 uniform 参数。value 支持 number / number[] / Float32Array / 纹理句柄。' },
  { group: 'material', name: 'destroyMaterial', params: ['material'], returns: 'void',
    desc: '销毁材质句柄。' },
  { group: 'material', name: 'setMaterialBlendState', params: ['material', 'state'], returns: 'void',
    desc: '设置混合与深度状态。state = { blend: \'normal\'|\'none\', depthTest, depthWrite, cull }。' },

  // ---- D. 纹理与视频 (4) ----
  { group: 'texture', name: 'createCanvasTexture', params: ['options'], returns: 'object|null',
    desc: '创建一张固定尺寸的画布纹理。options = { name, width, height, format, filter, address }。' },
  { group: 'texture', name: 'updateCanvasTexture', params: ['texture', 'source'], returns: 'void',
    desc: '用 HTMLCanvasElement / HTMLVideoElement / ImageBitmap 更新纹理内容（尺寸须与创建时一致）。' },
  { group: 'texture', name: 'getTextureSize', params: ['texture'], returns: 'number[]',
    desc: '取得纹理物理尺寸 [width, height]。' },
  { group: 'texture', name: 'getTextureFormat', params: ['texture'], returns: 'string|null',
    desc: '取得纹理像素格式的引擎无关标识（如 rgba8 / rgba16f），供诊断显示。' },
  { group: 'texture', name: 'createDataTexture', params: ['options'], returns: 'object|null',
    desc: '创建一张可由 CPU 数据填充的纹理（用于 shadowmap 深度图）。options = { name, width, height, format:\'r32f\'|\'rgba8\', filter:\'nearest\'|\'linear\' }。' },
  { group: 'texture', name: 'updateDataTexture', params: ['texture', 'data'], returns: 'void',
    desc: '用 Float32Array/Uint8Array 填充数据纹理（尺寸须与创建时一致）。' },
  { group: 'texture', name: 'destroyTexture', params: ['texture'], returns: 'void',
    desc: '销毁纹理句柄。' },

  // ---- E. 几何与绘制 (5) ----
  { group: 'geometry', name: 'createFullscreenQuad', params: [], returns: 'object|null',
    desc: '创建覆盖整个屏幕的四边形几何。返回 { mesh, node }（不透明句柄）。' },
  { group: 'geometry', name: 'createRenderable', params: ['mesh', 'material', 'node'], returns: 'object|null',
    desc: '用给定网格与材质创建一个可渲染实例。' },
  { group: 'geometry', name: 'addRenderable', params: ['renderable'], returns: 'void',
    desc: '把可渲染实例加入默认绘制层。' },
  { group: 'geometry', name: 'removeRenderable', params: ['renderable'], returns: 'void',
    desc: '把可渲染实例移出绘制层并销毁。' },
  { group: 'geometry', name: 'setRenderableVisible', params: ['renderable', 'visible'], returns: 'void',
    desc: '设置可渲染实例的可见性。' },
  { group: 'geometry', name: 'createSceneNode', params: ['name'], returns: 'object|null',
    desc: '创建一个独立场景节点句柄（用于给网格实例提供独立世界变换）。' },
  { group: 'geometry', name: 'createMesh', params: ['positions', 'indices', 'componentCount'], returns: 'object|null',
    desc: '由顶点/索引数组创建三角网格。positions 为 Float32Array，componentCount 为每顶点分量数（2 或 3，必须与 shader attribute 一致）。' },
  { group: 'geometry', name: 'destroyMesh', params: ['mesh'], returns: 'void',
    desc: '销毁 createMesh 创建的网格句柄。' },

  // ---- F. 拾取与数学 (6) ----
  { group: 'picking', name: 'getCameraViewProjection', params: [], returns: 'Float32Array|null',
    desc: '取得主相机当前帧的 projection × view（列主序 + 列向量约定，不转置）。供 CPU 光栅化等确定性计算与 GPU 侧同口径对齐。' },
  { group: 'picking', name: 'getDepthPickView', params: [], returns: 'object|null',
    desc: '取得可用于深度重建的拾取视图。返回 { texture, width, height, renders } 或 null（该引擎不提供时返回 null，调用方需有降级路径）。' },
  { group: 'picking', name: 'getPickingBackend', params: [], returns: 'string',
    desc: '返回拾取后端标识（用于诊断面板显示），如 playcanvas-picker / babylon-picker / none。' },
  { group: 'picking', name: 'setRenderableFlags', params: ['renderable', 'flags'], returns: 'void',
    desc: '设置可渲染实例的附加标志。flags = { castShadow, receiveShadow, pick, cull }。' },
  { group: 'picking', name: 'composeRigidMatrix', params: ['position', 'quaternion'], returns: 'Float32Array|null',
    desc: '由位置 [x,y,z] 与四元数 [x,y,z,w] 构造刚体变换矩阵（列主序 + 列向量约定，无缩放）。' },
  { group: 'picking', name: 'invertMatrix', params: ['matrix'], returns: 'Float32Array|null',
    desc: '求 4×4 矩阵逆，返回同约定的列主序 Float32Array(16)；奇异矩阵返回 null。' },
  { group: 'picking', name: 'rotateVectorByQuaternion', params: ['vector', 'quaternion'], returns: 'number[]',
    desc: '用四元数旋转向量，返回 [x,y,z]（世界坐标方向，例如投影机本地 +Z 的世界方向）。' },

  // ---- G. 深度预通道 (7)：Shadow-Map Decal 的 Pass1 ----
  { group: 'renderpass', name: 'createDepthPass', params: ['options'], returns: 'object|null',
    desc: '创建 depth-only 渲染通道：正交相机 + D32_FLOAT 深度纹理 + 独立绘制层。options={size:[w,h], name}。返回不透明句柄。' },
  { group: 'renderpass', name: 'setDepthPassGeometry', params: ['pass', 'triangles'], returns: 'boolean',
    desc: '填充通道要渲染的不透明几何。triangles={positions:Float32Array, indices:Uint32Array|Uint16Array}（世界坐标，flat 三角形）。' },
  { group: 'renderpass', name: 'setDepthPassProjector', params: ['pass', 'projector'], returns: 'boolean',
    desc: '设置正交投影仪 {position,quaternion,half,near,far}；相机放到 OBB 背面朝 +Z 看，只渲染一次。' },
  { group: 'renderpass', name: 'setDepthPassEnabled', params: ['pass', 'enabled'], returns: 'void',
    desc: '启用/停用通道相机。停用后深度纹理内容保留，供 Pass3 采样。' },
  { group: 'renderpass', name: 'getDepthPassTexture', params: ['pass'], returns: 'object|null',
    desc: '取得通道的深度纹理句柄（可直接喂给材质的 sampler uniform）。' },
  { group: 'renderpass', name: 'getDepthPassViewProjection', params: ['pass'], returns: 'Float32Array|null',
    desc: '取得投影仪正交相机 ViewProj，列主序 + 列向量约定，供 Pass3 VS/FS 使用。' },
  { group: 'renderpass', name: 'destroyDepthPass', params: ['pass'], returns: 'void',
    desc: '销毁通道的相机实体、绘制层、深度纹理与网格。' }

  /* 碰撞 mesh 深度**不再走引擎离屏通道**：自建 Layer + 自建相机在这个构建里
     只清屏不提交 draw（贴花 Pass1 同坑）。现在由 web/mesh-depth-raster.js 在 CPU
     上按主相机 ViewProj 光栅化，再用 texture 组的 createDataTexture /
     updateDataTexture 上传 RGBA8，所以契约只需 getCameraViewProjection。 */
];

/** 契约分组（用于文档与断言） */
export const ADAPTER_GROUPS = {
  lifecycle: '生命周期与渲染上下文',
  scene: '场景与相机',
  material: '材质与着色器',
  texture: '纹理与视频',
  geometry: '几何与绘制',
  picking: '拾取与数学',
  renderpass: '深度预通道'
};

/**
 * 校验一个适配器实现是否覆盖了全部契约方法。
 * @param {object} adapter
 * @returns {{ok:boolean, missing:string[], groups:object, total:number}}
 */
export function validateEngineAdapter(adapter) {
  const missing = [];
  const groups = {};
  let total = 0;
  for (const spec of ADAPTER_CONTRACT) {
    total++;
    if (!adapter || typeof adapter[spec.name] !== 'function') {
      missing.push(spec.name);
    }
    groups[spec.group] = groups[spec.group] || { total: 0, ok: 0 };
    groups[spec.group].total++;
    if (adapter && typeof adapter[spec.name] === 'function') groups[spec.group].ok++;
  }
  return { ok: missing.length === 0, missing, groups, total };
}

/**
 * 创建一个「带契约校验」的适配器包装。
 * 缺失的方法会被替换为「抛错并返回 null」的桩，绝不静默 undefined。
 * @param {object} impl 引擎适配器实现
 * @param {object} [opts] { onMissing }
 */
export function createEngineAdapter(impl, opts = {}) {
  const report = validateEngineAdapter(impl);
  if (!report.ok && typeof opts.onMissing === 'function') {
    opts.onMissing(report.missing, report.groups);
  }
  const wrapped = Object.create(null);
  for (const spec of ADAPTER_CONTRACT) {
    if (impl && typeof impl[spec.name] === 'function') {
      wrapped[spec.name] = impl[spec.name].bind(impl);
    } else {
      wrapped[spec.name] = () => {
        throw new Error('[engine-adapter] 未实现契约方法：' + spec.name);
      };
    }
  }
  wrapped.__contractReport = report;
  wrapped.__impl = impl;
  return wrapped;
}

/**
 * 一次性抽取脚本：把 decal-projection.js 里的四段 shader 模板逐字搬到
 * web/engine/decal-shaders.js（GLSL 拆成 preamble + body 两段，便于其他引擎
 * 复用同一份算法；WGSL 保持 PlayCanvas 专有形态）。
 * 用完即可删除，不参与运行时。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/WorkSpace/AI/3DGS_build/viewer_edit';
const src = fs.readFileSync(path.join(ROOT, 'web/editor/decal-projection.js'), 'utf8');

function grab(name) {
  const re = new RegExp('const ' + name + ' = /\\* (glsl|wgsl) \\*/ `([\\s\\S]*?)\\n  `;');
  const m = src.match(re);
  if (!m) throw new Error('not found: ' + name);
  return { lang: m[1], body: m[2] };
}

const vg = grab('vertexGLSL');
const vw = grab('vertexWGSL');
const fg = grab('fragmentGLSL');
const fw = grab('fragmentWGSL');

// GLSL：按「uniform 声明块结束」切分 —— preamble 依赖引擎后端的 uniform 布局，
// body（辅助函数 + main）是纯算法，可跨引擎复用。
// 关键：切分点必须保留换行。若把 '\n\n    /* 单 texel' 的换行一起吃掉，
// preamble 末尾的 '// 注释' 会把 body 开头那行 /* 块注释 */ 的首行吞进
// 行注释里，块注释剩余行变成裸代码 → GLSL 编译失败 → 整个贴花系统静默禁用。
const gSplit = fg.body.indexOf('\n\n    /* 单 texel');
if (gSplit < 0) throw new Error('glsl split marker not found');
const gPre = fg.body.slice(0, gSplit + 1);   // 保留一个换行
const gBody = fg.body.slice(gSplit + 2);

// WGSL：整段保留（PlayCanvas 专有：uniform 命名空间 / pcPosition 内建 / FragmentOutput）
const wBody = fw.body;

const out = `/**
 * 贴花投影 shader 源码（引擎层）
 * ----------------------------------------------------------------
 * 从 web/editor/decal-projection.js 抽出，使编辑器模块不再内嵌着色器。
 *
 * 分层：
 *   - DECAL_VERTEX_GLSL / DECAL_VERTEX_WGSL：顶点着色器（PlayCanvas 形态）
 *   - DECAL_FRAGMENT_PREAMBLE_GLSL：uniform 声明块（依赖后端 uniform 布局）
 *   - DECAL_FRAGMENT_BODY_GLSL：**纯算法**（深度重建 + 盒内判定 + 剔除 + UV），
 *     任何支持 GLSL ES 3.0 的后端（PlayCanvas WebGL2 / Babylon.js / three.js）可直接复用
 *   - DECAL_FRAGMENT_WGSL：PlayCanvas 专有 WGSL 形态（uniform 命名空间 + pcPosition 内建），
 *     其他引擎需另写等价实现（Babylon.js WebGPU 路径的 uniform buffer 布局不同）
 *
 * 本文件由 tools/extract_decal_shaders.mjs 一次性生成后手工维护。
 */

/** 贴花用到的全部 uniform 名称（JS 侧 setParameter 必须与之一致） */
export const DECAL_UNIFORM_NAMES = [
  'pickDepth', 'videoTex', 'uPickSize', 'uVideoSize', 'uPickReady',
  'invViewProj', 'invProjector', 'decalHalf', 'projectorNormal',
  'nearClip', 'farClip', 'decalOpacity', 'decalEdge', 'uCull',
  'uResolution', 'uUVSignY', 'uUVOffsetY', 'uPickFlipY',
  'uBoxScale', 'uDepthMode', 'uDebugMode', 'uCameraPos'
];

export const DECAL_VERTEX_GLSL = /* glsl */ \`${vg.body}\`;

export const DECAL_VERTEX_WGSL = /* wgsl */ \`${vw.body}\`;

export const DECAL_FRAGMENT_PREAMBLE_GLSL = /* glsl */ \`${gPre}\`;

export const DECAL_FRAGMENT_BODY_GLSL = /* glsl */ \`${gBody}\`;

export const DECAL_FRAGMENT_WGSL = /* wgsl */ \`${wBody}\`;
`;

fs.mkdirSync(path.join(ROOT, 'web/engine'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'web/engine/decal-shaders.js'), out, 'utf8');
console.log('WROTE web/engine/decal-shaders.js');
console.log('  vertexGLSL  chars:', vg.body.length);
console.log('  vertexWGSL  chars:', vw.body.length);
console.log('  fragPreamble chars:', gPre.length);
console.log('  fragBodyGLSL chars:', gBody.length);
console.log('  fragWGSL    chars:', wBody.length);

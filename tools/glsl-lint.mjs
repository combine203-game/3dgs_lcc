/**
 * GLSL / WGSL 结构校验器（零依赖）
 * ----------------------------------------------------------------
 * 为什么需要：贴花 shader 由「uniform 声明块（preamble）」+「算法体（body）」
 * 两段拼接而成。拼接时若吃掉一个换行，preamble 末尾的行注释会把 body
 * 开头块注释的首行吞进行注释，块注释的剩余行变成裸代码 —— GLSL
 * 编译失败。而 PlayCanvas 编译失败不抛 JS 异常，只表现为「贴花整块不显示」，
 * 排查成本极高（本次真实踩中）。
 *
 * 本校验器做结构级检查（不依赖 GPU 上下文）：
 *   1. 注释配对：块注释成对闭合，且行注释里不吞掉未闭合的块注释起始
 *   2. 括号配平：{} () [] 各自配平（剔除注释与字符串后统计）
 *   3. 入口存在：含 void main（GLSL）或 fn fragmentMain（WGSL）
 *   4. 必备 uniform：声明齐全
 *
 * 用法： node tools/glsl-lint.mjs [file.mjs ...]
 */

/** 剔除注释与字符串，返回「可执行代码骨架」与注释诊断 */
export function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  const errors = [];
  let blockDepth = 0;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (blockDepth === 0 && c === '/' && c2 === '/') {
      // 行注释：吞到行尾。若行内出现未闭合的 /* 起始，块注释会跨行 —— 这是合法的
      // C 风格注释嵌套禁止的行为，须报错。
      let j = i + 2;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '*' && src[j + 1] === '/') {
          errors.push('行注释中出现块注释结束符 */（位置 ' + j + '）：块注释起始被行注释吞掉');
          j += 2;
          continue;
        }
        if (src[j] === '/' && src[j + 1] === '*') {
          errors.push('行注释中出现未闭合的块注释起始 /*（位置 ' + j +
            '）：该块注释的其余行会变成裸代码，着色器必然编译失败');
          break;
        }
        j++;
      }
      out += '\n';
      i = j;
      continue;
    }
    if (c === '/' && c2 === '*') {
      const close = src.indexOf('*/', i + 2);
      if (close < 0) {
        errors.push('块注释未闭合（起始位置 ' + i + '）');
        blockDepth = 1;
        out += '\n';
        i = n;
        break;
      }
      blockDepth = 0;
      out += '\n';
      i = close + 2;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== '"') { if (src[j] === '\\') j++; j++; }
      out += '""';
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return { code: out, errors };
}

/** 括号配平检查 */
export function checkBalance(code) {
  const pairs = { '{': '}', '(': ')', '[': ']' };
  const closers = { '}': '{', ')': '(', ']': '[' };
  const stack = [];
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (pairs[c]) stack.push({ c, i });
    else if (closers[c]) {
      const top = stack.pop();
      if (!top || top.c !== closers[c]) {
        return { ok: false, msg: '括号不配平：位置 ' + i + ' 出现 ' + c };
      }
    }
  }
  if (stack.length) {
    return { ok: false, msg: '括号未闭合：' + stack.length + ' 个 ' + stack[stack.length - 1].c + ' 未闭合' };
  }
  return { ok: true, msg: '' };
}

/**
 * 校验一段着色器源码。
 * @param {string} src
 * @param {object} opts { entry: 'main'|'fragmentMain', uniforms: string[] }
 */
export function lintShader(src, opts = {}) {
  const issues = [];
  const { code, errors } = stripComments(src);
  issues.push(...errors);
  const bal = checkBalance(code);
  if (!bal.ok) issues.push(bal.msg);

  const entry = opts.entry || 'main';
  const entryPat = entry === 'fragmentMain' ? /fn\s+fragmentMain\s*\(/
    : entry === 'vertexMain' ? /fn\s+vertexMain\s*\(/
    : /void\s+main\s*\(/;
  if (!entryPat.test(code)) {
    issues.push('找不到着色器入口 ' + entry);
  }
  for (const u of (opts.uniforms || [])) {
    const re = new RegExp('\\b' + u + '\\b');
    if (!re.test(code)) issues.push('缺少必备 uniform：' + u);
  }
  // 常见笔误：重复声明同一个 uniform
  const DUP_UNIFORM_RE = new RegExp('\\buniform\\s+float\\s+(\\w+)\\s*;\\s*uniform\\s+float\\s+\\1\\b');
  if (DUP_UNIFORM_RE.test(code)) {
    issues.push('存在重复声明的 uniform');
  }
  return { ok: issues.length === 0, issues };
}

/** 从 ESM 模块里取导出的模板串（用于直接校验引擎层 shader） */
export async function loadShaderSources(modulePath) {
  const mod = await import(modulePath);
  return {
    glsl: (mod.DECAL_FRAGMENT_PREAMBLE_GLSL || '') + (mod.DECAL_FRAGMENT_BODY_GLSL || ''),
    wgsl: mod.DECAL_FRAGMENT_WGSL || '',
    vertexGLSL: mod.DECAL_VERTEX_GLSL || '',
    vertexWGSL: mod.DECAL_VERTEX_WGSL || '',
    uniforms: mod.DECAL_UNIFORM_NAMES || []
  };
}

// 直接执行：校验引擎层 shader
if (process.argv[1] && process.argv[1].endsWith('glsl-lint.mjs')) {
  const target = new URL('../web/engine/decal-shaders.js', import.meta.url).href;
  const s = await loadShaderSources(target);
  const mod = await import(target);
  const g = lintShader(s.glsl, { entry: 'main', uniforms: s.uniforms });
  const w = lintShader(s.wgsl, { entry: 'fragmentMain', uniforms: s.uniforms });
  const vg = lintShader(s.vertexGLSL, { entry: 'main' });
  const vw = lintShader(s.vertexWGSL, { entry: 'vertexMain' });
  // 标准三段式 Shadow-Map Decal 的 Pass3 cube shader（GLSL/WGSL 双份）
  const shadowU = mod.DECAL_SHADOW_UNIFORM_NAMES || [];
  const sgv = lintShader(mod.DECAL_SHADOW_VERTEX_GLSL || '', { entry: 'main' });
  const sgw = lintShader(mod.DECAL_SHADOW_VERTEX_WGSL || '', { entry: 'vertexMain' });
  const sfv = lintShader(mod.DECAL_SHADOW_FRAGMENT_GLSL || '', { entry: 'main', uniforms: shadowU });
  const sfw = lintShader(mod.DECAL_SHADOW_FRAGMENT_WGSL || '', { entry: 'fragmentMain', uniforms: shadowU });
  let bad = 0;
  for (const [name, r] of [
    ['fragment GLSL', g], ['fragment WGSL', w], ['vertex GLSL', vg], ['vertex WGSL', vw],
    ['shadow vertex GLSL', sgv], ['shadow vertex WGSL', sgw],
    ['shadow fragment GLSL', sfv], ['shadow fragment WGSL', sfw]
  ]) {
    if (r.ok) { console.log('  PASS  ' + name); }
    else { bad++; console.log('  FAIL  ' + name); r.issues.forEach(i => console.log('        - ' + i)); }
  }
  process.exit(bad ? 1 : 0);
}

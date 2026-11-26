#!/usr/bin/env node
/* 交付验收门（QA gate）
 * ---------------------------------------------------------------
 * 用户要求「专门负责测试与交付成果」：交付前必须跑完本脚本且全绿。
 * 串联三层测试（每层都含真机后端与前置条件断言，杜绝「假 PASS」）：
 *   1) dom-regression  tools/verify_editor.mjs            DOM/状态全量回归 + 源码守卫
 *   2) webgpu-decal    tools/diagnose_decal_repro.mjs     WebGPU 后端 + 真实新建贴面矩形
 *      （断言 pickReady=1 / 无 degraded / 0 GPU uncaptured error）
 *   3) editor-canvas   tools/diagnose_editor_canvas.mjs   WebGL2 编辑态画布 / postrender / GL 状态
 *   4) panorama-ui     tools/verify_panorama_ui.mjs       真实 Viewer 页内六面取帧 + 拼接 + 导出
 *   5) browse-ann      tools/verify_ann_layer.mjs         浏览态标注层 + 场景图层显隐（含编辑态开合）
 *   6) browse-decal    tools/diagnose_browse_decal.mjs    浏览态贴花投射（真机 WebGPU：
 *      投射像素差 / 不画辅助线框 / 进编辑态线框回来且不双份投射）
 *   7) editor-fly-drape tools/diagnose_editor_fly_drape.mjs 编辑器默认飞行相机 +
 *      动线深度反算贴地（a.drape 持久化 / 箭头链真的贴住表面 / 退出不污染浏览态）
 *   8) depth-view      tools/diagnose_depth_view.mjs      实时深度图独立视口（3DGS 深度）
 *   9) mesh-depth      tools/diagnose_mesh_depth.mjs      碰撞 Mesh 深度（CPU 光栅化 +
 *      数据纹理），与 3DGS 深度并排比对；两个后端都要过
 * 产出 qa-report.json；任一步 FAIL 即退出码 1。
 * 用法：node tools/qa_acceptance.mjs [--skip-canvas] [--skip-pano] [--skip-ann]
 *       [--skip-browsedecal] [--skip-flydrape] [--skip-guides] [--skip-depth]
 *       [--skip-meshdepth]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = process.env.QA_REPORT || path.join(ROOT, 'qa-report.json');
const skipCanvas = process.argv.includes('--skip-canvas');
const skipPano = process.argv.includes('--skip-pano');
const skipAnn = process.argv.includes('--skip-ann');
const skipBrowseDecal = process.argv.includes('--skip-browsedecal');
const skipFlyDrape = process.argv.includes('--skip-flydrape');
const skipGuides = process.argv.includes('--skip-guides');
const skipDepth = process.argv.includes('--skip-depth');
const skipMeshDepth = process.argv.includes('--skip-meshdepth');

const steps = [
  { name: 'dom-regression', cmd: 'node tools/verify_editor.mjs', timeout: 600000 },
  { name: 'webgpu-decal', cmd: 'node tools/diagnose_decal_repro.mjs --wait=18000', timeout: 600000 }
];
if (!skipCanvas) {
  steps.push({ name: 'editor-canvas', cmd: 'node tools/diagnose_editor_canvas.mjs --wait=18000', timeout: 600000 });
}
if (!skipPano) {
  steps.push({ name: 'panorama-ui', cmd: 'node tools/verify_panorama_ui.mjs --wait=20000', timeout: 600000 });
}
if (!skipAnn) {
  steps.push({ name: 'browse-ann', cmd: 'node tools/verify_ann_layer.mjs', timeout: 600000 });
}
if (!skipBrowseDecal) {
  steps.push({ name: 'browse-decal', cmd: 'node tools/diagnose_browse_decal.mjs --wait=18000', timeout: 600000 });
}
if (!skipFlyDrape) {
  steps.push({ name: 'editor-fly-drape', cmd: 'node tools/diagnose_editor_fly_drape.mjs --wait=18000', timeout: 900000 });
}
// 贴花辅助线：场景深度判断（逐段遮挡）+ 正交 OBB 旋转环 + 块回读快路径能力
if (!skipGuides) {
  steps.push({ name: 'decal-guides', cmd: 'node tools/diagnose_decal_guides.mjs --wait=18000', timeout: 900000 });
}
// 实时深度图：默认流式数据 + 顶栏按钮 → 独立视口渲染深度（视口外主画面不变、
// 可拖动移动 / 可拖动缩放）→ 关闭后恢复。两个后端都要过（深度纹理行序 / UV 翻转相反）。
if (!skipDepth) {
  steps.push({ name: 'depth-view', cmd: 'node tools/diagnose_depth_view.mjs --wait=45000', timeout: 900000 });
}
// 碰撞 Mesh 深度：CPU 光栅化（主相机 ViewProj + 同 near/far + 同归一化）→ 16bit 打包
// 进 RGBA8 数据纹理 → 与 3DGS 深度并排比对。两个后端都要过（纹理行序相反）。
if (!skipMeshDepth) {
  steps.push({ name: 'mesh-depth', cmd: 'node tools/diagnose_mesh_depth.mjs --wait=60000', timeout: 900000 });
}

const report = { time: new Date().toISOString(), node: process.version, steps: [], pass: false };
let allPass = true;

for (const s of steps) {
  console.log(`\n########## [${s.name}] ${s.cmd} ##########`);
  const [bin, ...args] = s.cmd.split(' ');
  const r = spawnSync(bin, args, { cwd: ROOT, encoding: 'utf8', timeout: s.timeout, shell: true });
  const out = ((r.stdout || '') + '\n' + (r.stderr || '')).trim();
  /* 判定依据：
   * - verify_editor 输出「N PASS / M FAIL」摘要（注意：摘要里含 "FAIL" 字样，
   *   不能简单用 /FAIL/ 匹配，否则全绿也会被误判）；
   * - 诊断脚本以「编辑态画布: PASS/FAIL」「贴面矩形结果: PASS/FAIL」收尾。 */
  const domSummary = out.match(/(\d+) PASS \/ (\d+) FAIL/);
  let pass = r.status === 0;
  if (domSummary) pass = pass && domSummary[2] === '0';
  else pass = pass && /编辑态画布: PASS|贴面矩形结果: PASS|全景功能: PASS|场景图层: PASS|浏览态贴花: PASS|编辑器飞行\+贴地: PASS|辅助线深度判断: PASS|深度图\[webgpu\+webgl2\]: PASS|碰撞Mesh深度\[[^\]]+\]: PASS/.test(out) &&
    !/编辑态画布: FAIL|贴面矩形结果: FAIL|全景功能: FAIL|场景图层: FAIL|浏览态贴花: FAIL|编辑器飞行\+贴地: FAIL|辅助线深度判断: FAIL|深度图\[webgpu\+webgl2\]: FAIL|碰撞Mesh深度\[[^\]]+\]: FAIL|DIAG FAILED/.test(out);
  const passLine = domSummary;
  const lines = out.split(/\r?\n/).filter(l => /PASS|FAIL|结论|mean|pickReady|偏差|错误|告警|前置条件|GPU 管线|====/.test(l));
  console.log(lines.slice(-14).join('\n'));
  console.log(`--> [${s.name}] ${pass ? 'PASS' : 'FAIL'}（exit=${r.status}）`);
  report.steps.push({
    name: s.name,
    pass,
    exit: r.status,
    domSummary: passLine ? `${passLine[1]} PASS / ${passLine[2]} FAIL` : null,
    tail: out.split(/\r?\n/).slice(-10).join('\n')
  });
  if (!pass) allPass = false;
}

report.pass = allPass;
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log('\n========================================');
console.log(allPass ? 'QA 验收：全部通过，可以交付' : 'QA 验收：存在失败，禁止交付');
console.log('report ->', OUT);
process.exit(allPass ? 0 : 1);

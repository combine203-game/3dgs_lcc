#!/usr/bin/env node
/* 交付验收门（QA gate）
 * ---------------------------------------------------------------
 * 用户要求「专门负责测试与交付成果」：交付前必须跑完本脚本且全绿。
 * 串联三层测试（每层都含真机后端与前置条件断言，杜绝「假 PASS」）：
 *   1) dom-regression  tools/verify_editor.mjs            DOM/状态全量回归 + 源码守卫
 *   2) webgpu-decal    tools/diagnose_decal_repro.mjs     WebGPU 后端 + 真实新建贴面矩形
 *      （断言 pickReady=1 / 无 degraded / 0 GPU uncaptured error）
 *   3) editor-canvas   tools/diagnose_editor_canvas.mjs   WebGL2 编辑态画布 / postrender / GL 状态
 * 产出 qa-report.json；任一步 FAIL 即退出码 1。
 * 用法：node tools/qa_acceptance.mjs [--skip-canvas]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = process.env.QA_REPORT || path.join(ROOT, 'qa-report.json');
const skipCanvas = process.argv.includes('--skip-canvas');

const steps = [
  { name: 'dom-regression', cmd: 'node tools/verify_editor.mjs', timeout: 600000 },
  { name: 'webgpu-decal', cmd: 'node tools/diagnose_decal_repro.mjs --wait=18000', timeout: 600000 }
];
if (!skipCanvas) {
  steps.push({ name: 'editor-canvas', cmd: 'node tools/diagnose_editor_canvas.mjs --wait=18000', timeout: 600000 });
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
  else pass = pass && /编辑态画布: PASS|贴面矩形结果: PASS/.test(out) &&
    !/编辑态画布: FAIL|贴面矩形结果: FAIL|DIAG FAILED/.test(out);
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

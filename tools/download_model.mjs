#!/usr/bin/env node
/**
 * MotionBricks 模型包下载器（整片流式 + 失败重下）
 *
 * 实测：repalash.com（Cloudflare 后）单连接 ~40 KB/s，Range 请求在高并发下会
 * 返回 416/空响应。因此改成「每个 shard 一条整片 GET、流式落盘」，最多 2 个
 * shard 并发；失败整片重下。已完整落盘的 shard 直接跳过，可反复重跑。
 *
 * 用法：node tools/download_model.mjs [目标目录] [并发 shard 数]
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';

const BASE = 'https://repalash.com/three-motionbricks/model/';
const OUT = process.argv[2] || 'web/human/model';
const CONC = Number(process.argv[3] || 2);

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function fetchBuf(url, redirects = 0) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { 'accept-encoding': 'identity' } }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && redirects < 5) {
        r.resume();
        return res(fetchBuf(new URL(r.headers.location, url).href, redirects + 1));
      }
      if (r.statusCode !== 200) { r.resume(); return rej(new Error('HTTP ' + r.statusCode)); }
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => res(Buffer.concat(chunks)));
      r.on('error', rej);
    }).on('error', rej);
  });
}

function download(url, file, expect) {
  return new Promise((res, rej) => {
    const tmp = file + '.tmp';
    const out = fs.createWriteStream(tmp);
    let got = 0;
    https.get(url, { headers: { 'accept-encoding': 'identity' } }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume(); out.close();
        return res(download(new URL(r.headers.location, url).href, file, expect));
      }
      if (r.statusCode !== 200) { r.resume(); out.close(); return rej(new Error('HTTP ' + r.statusCode)); }
      r.on('data', (c) => { got += c.length; });
      r.pipe(out);
      out.on('finish', () => {
        out.close(async () => {
          if (expect && got !== expect) { await fsp.rm(tmp, { force: true }); return rej(new Error(`长度不符 ${got}/${expect}`)); }
          await fsp.rename(tmp, file);
          res(got);
        });
      });
      r.on('error', (e) => { out.close(); rej(e); });
    }).on('error', (e) => { out.close(); rej(e); });
  });
}

async function pool(tasks, n) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < tasks.length) await tasks[i++]();
  }));
}

async function main() {
  await fsp.mkdir(OUT, { recursive: true });
  let pack;
  for (let i = 0; i < 10; i++) {
    try { pack = JSON.parse((await fetchBuf(BASE + 'pack.json')).toString()); break; }
    catch (e) { log('pack.json 重试', i + 1, e.message); await new Promise((r) => setTimeout(r, 2000)); }
  }
  if (!pack) throw new Error('pack.json 不可用');
  await fsp.writeFile(path.join(OUT, 'pack.json'), JSON.stringify(pack));
  log('pack', pack.format, 'shards=' + pack.shards.length, '总 ' + (pack.q8Length / 1048576).toFixed(0) + ' MiB');

  const tasks = pack.shards.map((name) => async () => {
    const file = path.join(OUT, name);
    const st = await fsp.stat(file).catch(() => null);
    if (st && st.size === pack.shardBytes) { log('跳过已完成', name); return; }
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const t0 = Date.now();
        const n = await download(BASE + name, file, pack.shardBytes);
        log(`完成 ${name} ${(n / 1048576).toFixed(2)} MiB, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
        return;
      } catch (e) {
        log(`  ${name} 重试 ${attempt + 1}: ${e.message}`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    throw new Error(name + ' 下载失败');
  });

  await pool(tasks, CONC);
  const sizes = [];
  for (const n of pack.shards) sizes.push((await fsp.stat(path.join(OUT, n))).size);
  const sum = sizes.reduce((a, b) => a + b, 0);
  log(`全部完成，共 ${(sum / 1048576).toFixed(1)} MiB（期望 ${(pack.q8Length / 1048576).toFixed(1)}）`);
}

main().catch((e) => { console.error('FAILED', e); process.exit(1); });

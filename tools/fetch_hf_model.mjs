#!/usr/bin/env node
/**
 * 从 HF 镜像（hf-mirror.com）拉取 MotionBricks ONNX 权重。
 *
 * 为什么换源：repalash.com 实测 5–40 KB/s 且频繁 ECONNRESET（188 MB 的 q8 pack
 * 下不完）；hf-mirror.com 实测 675 KB/s 且稳定，且有等价的 SOMA/G1 ONNX 导出。
 *
 * 用法：
 *   node tools/fetch_hf_model.mjs q8h|fp16|soma-fp32|g1-fp32 [目标目录]
 * 特性：断点续传（HTTP Range）、重定向跟随、60s 空闲超时、进度打印。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';

const SOURCES = {
  q8h: {
    url: 'https://hf-mirror.com/monoradio/motionbricks-soma-fp16-onnx/resolve/main/mmm_v6_soma_q8h.onnx',
    name: 'mmm_v6_soma_q8h.onnx', bytes: 243022000
  },
  fp16: {
    url: 'https://hf-mirror.com/monoradio/motionbricks-soma-fp16-onnx/resolve/main/mmm_v6_soma_fp16.onnx',
    name: 'mmm_v6_soma_fp16.onnx', bytes: 380000000
  },
  'soma-fp32': {
    url: 'https://hf-mirror.com/julienkay/MotionBricks-inference-engine/resolve/main/onnx/motionbricks_soma_fp32.onnx',
    name: 'motionbricks_soma_fp32.onnx', bytes: 758000000
  },
  'g1-fp32': {
    url: 'https://hf-mirror.com/julienkay/MotionBricks-inference-engine/resolve/main/onnx/motionbricks_unitree_g1_fp32.onnx',
    name: 'motionbricks_unitree_g1_fp32.onnx', bytes: 734000000
  }
};

const key = process.argv[2] || 'q8h';
const outDir = process.argv[3] || 'web/human/model';
const src = SOURCES[key];
if (!src) { console.error('未知来源', key, '可选:', Object.keys(SOURCES).join(', ')); process.exit(1); }

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function download(url, file, redirects = 0) {
  return new Promise((resolve, reject) => {
    const tmp = file + '.part';
    const have = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
    const req = https.get(url, { headers: Object.assign({ 'accept-encoding': 'identity' }, have ? { Range: `bytes=${have}-` } : {}) }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume();
        const next = new URL(r.headers.location, url).href;
        if (redirects > 6) return reject(new Error('重定向过多'));
        return resolve(download(next, file, redirects + 1));
      }
      if (r.statusCode === 416) { r.resume(); return resolve(have); }
      if (r.statusCode !== 200 && r.statusCode !== 206) { r.resume(); return reject(new Error('HTTP ' + r.statusCode)); }
      const total = Number(r.headers['content-length'] || 0) + (r.statusCode === 206 ? have : 0);
      const out = fs.createWriteStream(tmp, { flags: have && r.statusCode === 206 ? 'a' : 'w' });
      let got = r.statusCode === 206 ? have : 0;
      let lastLog = 0;
      r.on('data', (c) => {
        got += c.length;
        const now = Date.now();
        if (now - lastLog > 5000) { lastLog = now; log(`  ${(got / 1048576).toFixed(1)} / ${total ? (total / 1048576).toFixed(0) : '?'} MiB`); }
      });
      r.pipe(out);
      out.on('finish', () => out.close(async () => {
        if (total && got !== total) return reject(new Error(`长度不符 ${got}/${total}`));
        await fsp.rename(tmp, file);
        resolve(got);
      }));
      r.on('error', reject);
    });
    req.setTimeout(60000, () => req.destroy(new Error('空闲超时')));
    req.on('error', reject);
  });
}

async function main() {
  await fsp.mkdir(outDir, { recursive: true });
  const file = path.join(outDir, src.name);
  if (fs.existsSync(file)) {
    log('已存在', file, (fs.statSync(file).size / 1048576).toFixed(0) + ' MiB，跳过');
    return;
  }
  log('下载', src.name, '->', file);
  for (let i = 0; i < 30; i++) {
    try {
      const n = await download(src.url, file);
      log('完成', (n / 1048576).toFixed(1) + ' MiB');
      return;
    } catch (e) {
      log('重试', i + 1, e.message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error('下载失败');
}

main().catch((e) => { console.error('FAILED', e); process.exit(1); });

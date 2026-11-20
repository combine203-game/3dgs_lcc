/**
 * 浏览器端 720° 全景生成（iframe 内运行，父页面 fusion.js 调用）。
 * 复用 Viewer 的 captureFrame() 离屏取帧：不需要 preserveDrawingBuffer，
 * WebGL2 / WebGPU 都能用。六个 90° 面 → 球面方向采样 → 2:1 equirectangular PNG。
 */
const EPS = 1e-4;
const DIRS = [
  [1, 0, 0], [-1, 0, 0], [0, 1, EPS], [0, -1, EPS], [0, 0, 1], [0, 0, -1]
];
const NAMES = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'];
const BASES = [
  { f: [1, 0, 0], r: [0, 0, 1], u: [0, 1, 0] },
  { f: [-1, 0, 0], r: [0, 0, -1], u: [0, 1, 0] },
  { f: [0, 1 / Math.hypot(1, EPS), EPS / Math.hypot(1, EPS)], r: [-1, 0, 0], u: [0, 0, -1] },
  { f: [0, -1 / Math.hypot(1, EPS), EPS / Math.hypot(1, EPS)], r: [-1, 0, 0], u: [0, 0, 1] },
  { f: [0, 0, 1], r: [-1, 0, 0], u: [0, 1, 0] },
  { f: [0, 0, -1], r: [1, 0, 0], u: [0, 1, 0] }
];

let generating = false;
const waitViewer = () => new Promise((resolve) => {
  const tick = () => {
    if (window.__viewer?.captureFrame && window.__viewer?.setCameraPose) resolve(window.__viewer);
    else requestAnimationFrame(tick);
  };
  tick();
});

function decodeFace(data, w, h) {
  const bin = atob(data);
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < bin.length; i++) px[i] = bin.charCodeAt(i);
  return px;
}

function sample(face, sx, sy, fw, fh, out, o) {
  let px = (sx + 1) * 0.5 * (fw - 1);
  let py = (1 - sy) * 0.5 * (fh - 1);
  px = px < 0 ? 0 : (px > fw - 1 ? fw - 1 : px);
  py = py < 0 ? 0 : (py > fh - 1 ? fh - 1 : py);
  const x0 = px | 0, y0 = py | 0;
  const x1 = x0 + 1 < fw ? x0 + 1 : x0;
  const y1 = y0 + 1 < fh ? y0 + 1 : y0;
  const tx = px - x0, ty = py - y0;
  const i00 = (y0 * fw + x0) * 4, i10 = (y0 * fw + x1) * 4;
  const i01 = (y1 * fw + x0) * 4, i11 = (y1 * fw + x1) * 4;
  for (let c = 0; c < 3; c++) {
    const a = face[i00 + c] + (face[i10 + c] - face[i00 + c]) * tx;
    const b = face[i01 + c] + (face[i11 + c] - face[i01 + c]) * tx;
    out[o + c] = a + (b - a) * ty;
  }
  out[o + 3] = 255;
}

async function generate({ face = 1024, onProgress = () => {} } = {}) {
  if (generating) throw new Error('全景正在生成中，请稍候');
  generating = true;
  let savedPose = null;
  try {
    const v = await waitViewer();
    const pose = window.__mgPose?.();
    savedPose = pose && { position: pose.position.slice(), target: pose.target.slice(), fov: pose.fov };
    if (!pose?.position || !pose?.target) throw new Error('当前机位尚未就绪');
    const p = pose.position.slice();
    const f = Math.max(128, Math.min(2048, Math.round(face)));
    const faces = [];
    for (let i = 0; i < 6; i++) {
      onProgress(`正在采集 ${NAMES[i]} 面（${i + 1}/6）…`);
      const d = DIRS[i];
      if (!v.setCameraPose(p, [p[0] + d[0], p[1] + d[1], p[2] + d[2]], 90)) {
        throw new Error('设置全景机位失败');
      }
      const cap = await v.captureFrame({ width: f, height: f, supersample: 1 });
      faces.push(decodeFace(cap.data, cap.width, cap.height));
    }
    // 无论成功失败都要把用户机位还回去
    onProgress('六面采集完成，正在拼接球面…');
    const W = f * 4, H = f * 2;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(W, H);
    const out = image.data;

    const cosLon = new Float64Array(W), sinLon = new Float64Array(W);
    for (let x = 0; x < W; x++) {
      const lon = 2 * Math.PI * (x + 0.5) / W - Math.PI;
      sinLon[x] = Math.sin(lon); cosLon[x] = Math.cos(lon);
    }
    for (let y0 = 0; y0 < H; y0 += 128) {
      const yEnd = Math.min(y0 + 128, H);
      for (let y = y0; y < yEnd; y++) {
        const lat = Math.PI * (0.5 - (y + 0.5) / H);
        const cl = Math.cos(lat), dy = Math.sin(lat);
        for (let x = 0; x < W; x++) {
          const dx = cl * sinLon[x], dz = -cl * cosLon[x];
          const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
          let i;
          if (ax >= ay && ax >= az) i = dx >= 0 ? 0 : 1;
          else if (ay >= az) i = dy >= 0 ? 2 : 3;
          else i = dz >= 0 ? 4 : 5;
          const b = BASES[i];
          const sc = dx * b.f[0] + dy * b.f[1] + dz * b.f[2];
          const inv = 1 / (sc > 1e-6 ? sc : 1e-6);
          const sx = (dx * b.r[0] + dy * b.r[1] + dz * b.r[2]) * inv;
          const sy = (dx * b.u[0] + dy * b.u[1] + dz * b.u[2]) * inv;
          sample(faces[i], sx, sy, f, f, out, (y * W + x) * 4);
        }
      }
      if (yEnd < H) {
        onProgress(`正在拼接球面（${Math.round(yEnd / H * 100)}%）…`);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    ctx.putImageData(image, 0, 0);
    onProgress('完成');
    return { dataUrl: canvas.toDataURL('image/png'), width: W, height: H, position: p };
  } finally {
    generating = false;
    // 恢复用户原来的机位（采集期间相机被临时转向六个方向）
    try {
      if (savedPose && window.__viewer?.setCameraPose) {
        window.__viewer.setCameraPose(savedPose.position, savedPose.target, savedPose.fov);
      }
    } catch (_) { /* noop */ }
  }
}

window.__mgPanorama = {
  supported: true,
  isGenerating: () => generating,
  generate
};

#!/usr/bin/env python3
"""把 6 张 90° 立方体面截图拼成 720° equirectangular 全景（Y-up，右手系）。

面文件名与朝向（与 generate_panorama.mjs 的 setCameraPose 方向一一对应）：
  face0=+X  face1=-X  face2=+Y  face3=-Y  face4=+Z  face5=-Z
相机 lookAt 的右向量 = forward × worldUp；本脚本使用同样的基向量采样。
"""
import sys
import numpy as np
from PIL import Image

faces_dir, out_path = sys.argv[1], sys.argv[2]
W = int(sys.argv[3]) if len(sys.argv) > 3 else 4096
H = W // 2

EPS = 1e-4
def norm(v):
    v = np.asarray(v, dtype=np.float64)
    return v / np.linalg.norm(v)

# (forward, right, up)：与 PlayCanvas lookAt(up=(0,1,0)) 的屏幕基一致
BASES = [
    (norm((1, 0, 0)),        norm((0, 0, 1)),         norm((0, 1, 0))),    # +X
    (norm((-1, 0, 0)),       norm((0, 0, -1)),        norm((0, 1, 0))),    # -X
    (norm((0, 1, EPS)),      norm((-1, 0, 0)),        norm((0, 0, -1))),   # +Y
    (norm((0, -1, EPS)),     norm((-1, 0, 0)),        norm((0, 0, 1))),    # -Y
    (norm((0, 0, 1)),        norm((-1, 0, 0)),        norm((0, 1, 0))),    # +Z
    (norm((0, 0, -1)),       norm((1, 0, 0)),         norm((0, 1, 0))),    # -Z
]

imgs = []
for i in range(6):
    im = Image.open(f"{faces_dir}/face{i}.png").convert("RGB")
    imgs.append(np.asarray(im, dtype=np.float32))
fh, fw = imgs[0].shape[:2]

y, x = np.mgrid[0:H, 0:W]
lon = 2.0 * np.pi * (x + 0.5) / W - np.pi
lat = np.pi * (0.5 - (y + 0.5) / H)
cl = np.cos(lat)
d = np.stack((cl * np.sin(lon), np.sin(lat), -cl * np.cos(lon)), axis=-1)  # (H,W,3)

# 选面：最大绝对值分量决定主轴，符号决定哪一面
ax = np.argmax(np.abs(d), axis=-1)
neg = (np.take_along_axis(d, ax[..., None], axis=-1)[..., 0] < 0)
idx = np.where(ax == 0, np.where(neg, 1, 0),
      np.where(ax == 1, np.where(neg, 3, 2),
               np.where(neg, 5, 4)))

out = np.zeros((H, W, 3), dtype=np.float32)
for i, (f, r, u) in enumerate(BASES):
    m = (idx == i)
    if not np.any(m):
        continue
    dm = d[m]
    sc = dm @ f
    sc = np.maximum(sc, 1e-6)
    sx = (dm @ r) / sc
    sy = (dm @ u) / sc
    px = np.clip((sx + 1.0) * 0.5 * (fw - 1), 0, fw - 1)
    py = np.clip((1.0 - sy) * 0.5 * (fh - 1), 0, fh - 1)
    # 双线性采样（手写避免对 6 个面引入 cv2/scipy 依赖）
    x0 = np.floor(px).astype(int); x1 = np.minimum(x0 + 1, fw - 1)
    y0 = np.floor(py).astype(int); y1 = np.minimum(y0 + 1, fh - 1)
    tx = (px - x0)[..., None]; ty = (py - y0)[..., None]
    im = imgs[i]
    c = (im[y0, x0] * (1 - tx) + im[y0, x1] * tx) * (1 - ty) + \
        (im[y1, x0] * (1 - tx) + im[y1, x1] * tx) * ty
    out[m] = np.clip(c, 0, 255)

Image.fromarray(out.astype(np.uint8), "RGB").save(out_path)
print(f"panorama saved: {out_path} ({W}x{H}) from {fw}x{fh} faces")

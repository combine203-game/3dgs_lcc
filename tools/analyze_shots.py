#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""对 compare_sog_assets.mjs 产出的截图做像素统计，量化「发黑 / 半透明 / 噪点」。

指标（只统计画面中央 60%，避开顶栏 UI 与黑边）：
  lum      平均亮度 0-255
  dark     亮度 < 40 的像素占比（"发黑"程度）
  blown    亮度 > 235 的像素占比（过曝）
  blue     蓝通道显著高于红通道的像素占比（大屏/水池区域）
  hf       高频能量：相邻像素亮度差绝对值均值（噪点 / 破碎程度）
  alphaGap 亮度低于同行中位数的比例（"斑驳"感）

用法：
  python tools/analyze_shots.py tools/shots/clean.png tools/shots/clamp.png [...]
"""
import os
import sys

import numpy as np
from PIL import Image


def stats(path):
    im = Image.open(path).convert('RGB')
    a = np.asarray(im).astype(np.int32)
    h, w, _ = a.shape
    # 中央 60%（避开顶栏、底部按钮与四周黑边）
    y0, y1 = int(h * 0.20), int(h * 0.80)
    x0, x1 = int(w * 0.20), int(w * 0.80)
    c = a[y0:y1, x0:x1]
    g = c.mean(axis=2)
    gx = np.abs(np.diff(g, axis=1)).mean()
    gy = np.abs(np.diff(g, axis=0)).mean()
    row_med = np.median(g, axis=1, keepdims=True)
    return {
        'file': os.path.basename(path),
        'size': '%dx%d' % (w, h),
        'lum': round(float(g.mean()), 1),
        'dark%': round(100.0 * float((g < 40).mean()), 1),
        'blown%': round(100.0 * float((g > 235).mean()), 1),
        'blue%': round(100.0 * float(((c[:, :, 2] - c[:, :, 0]) > 20).mean()), 1),
        'hf': round(float((gx + gy) / 2.0), 2),
        'alphaGap%': round(100.0 * float((g < row_med - 25).mean()), 1),
    }


def main():
    paths = sys.argv[1:]
    if not paths:
        base = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'shots')
        paths = [os.path.join(base, f) for f in ('clean.png', 'clamp.png')
                 if os.path.isfile(os.path.join(base, f))]
    if not paths:
        raise SystemExit('no screenshots found')
    rows = [stats(p) for p in paths if os.path.isfile(p)]
    keys = ['lum', 'dark%', 'blown%', 'blue%', 'hf', 'alphaGap%']
    print('%-12s %-10s ' % ('file', 'size') + ' '.join('%8s' % k for k in keys))
    for r in rows:
        print('%-12s %-10s ' % (r['file'], r['size'])
              + ' '.join('%8s' % r[k] for k in keys))
    if len(rows) == 2:
        a, b = rows
        print('\n差值 (%s - %s):' % (b['file'], a['file']))
        for k in keys:
            print('  %-8s %+8.2f' % (k, b[k] - a[k]))


if __name__ == '__main__':
    main()

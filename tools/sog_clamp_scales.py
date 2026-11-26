#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""方案 1（SOG 版）：只改代码表，把「删除大高斯 / 低 alpha 点」换成「压小大高斯」。

为什么不用重新编码
------------------
SOG 的尺度是**码表量化**的：
  · meta.json 的 `scales.codebook` 存 256 个代表值（log 空间）
  · scales.webp 里每个高斯只存 3 个字节索引，指向码表
所以「压住大尺度」只需要把码表里超出上限的那几个条目改小 ——
webp 一个字节都不用动，8.87M 个高斯的索引全部保持原样。

这同时绕开了 splat-transform 的 SOG 编码（本机上 CPU 跑十几分钟、
GPU 停在 Detecting GPU adapters），把一次 O(点数 × SH) 的重编码
降成一次 O(256) 的数组改写。

用法
----
  python sog_clamp_scales.py in.sog out.sog --cap 0.15 [--hard]
    --cap   线性半径上限（米）
    --hard  硬截断 min(s, cap)；默认用软压缩 cap*tanh(s/cap)，
            避免大量高斯精确落在同一半径上、视觉糊成一层壳
"""
import argparse
import json
import math
import os
import zipfile


def clamp_one(v, cap, hard):
    lin = math.exp(v)
    if lin <= cap:
        return v, False
    new_lin = cap if hard else cap * math.tanh(lin / cap)
    return math.log(new_lin), True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('dst')
    ap.add_argument('--cap', type=float, default=0.15)
    ap.add_argument('--hard', action='store_true')
    args = ap.parse_args()

    with zipfile.ZipFile(args.src) as zin:
        meta = json.loads(zin.read('meta.json'))
        scales = meta.get('scales') or {}
        cb = scales.get('codebook')
        if not cb:
            raise SystemExit('meta.json 没有 scales.codebook，无法按码表钳制')
        n = len(cb)
        touched, new_cb = 0, []
        for v in cb:
            nv, hit = clamp_one(v, args.cap, args.hard)
            touched += 1 if hit else 0
            new_cb.append(nv)
        before = max(math.exp(v) for v in cb)
        after = max(math.exp(v) for v in new_cb)
        print('codebook=%d 条目  命中=%d  最大半径 %.4f m -> %.4f m  (%s)'
              % (n, touched, before, after, 'hard' if args.hard else 'tanh'))
        if not touched:
            print('警告：没有条目超过上限，输出与输入等价')

        scales['codebook'] = new_cb
        meta['scales'] = scales
        payload = json.dumps(meta, ensure_ascii=False, separators=(',', ':')).encode('utf-8')

        if os.path.exists(args.dst):
            os.remove(args.dst)
        with zipfile.ZipFile(args.dst, 'w') as zout:
            for item in zin.infolist():
                data = zin.read(item.filename)
                if item.filename == 'meta.json':
                    data = payload
                zi = zipfile.ZipInfo(item.filename, date_time=item.date_time)
                zi.compress_type = item.compress_type
                zi.external_attr = item.external_attr
                zout.writestr(zi, data)

    print('count=%s  输出 %.1f MB  -> %s'
          % (meta.get('count'), os.path.getsize(args.dst) / 1048576.0, args.dst))


if __name__ == '__main__':
    main()

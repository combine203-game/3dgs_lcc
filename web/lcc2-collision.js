/* 直接使用 XGrids 官方碰撞数据（分块 PLY + 对应 btree BVH）。
 *
 * 重要：这里不重建、不合并、不改写任何原始网格文件。
 *   - PLY  提供真实三角形几何（米制 Z-up），顶点数值原样读取
 *   - btree 提供官方 BVH（每节点 32B：AABB 6*f32 + a/b 两个 u32），
 *           用于校验分块完整性并取得分块空间范围
 * 唯一必需的处理是轴变换：官方 PLY 是米制 Z-up，PlayCanvas 渲染世界是
 * 米制 Y-up，因此 world = (x, z, -y)。
 *
 * 2026-11-09 修正：早期版本在这里对顶点做了 log 压缩
 *   (logc(x), logc(z), -logc(y))，把碰撞体压到 ±4；而当前 mm_floor*.sog
 *   的渲染世界是米制（相机在 (18.50, 1.89, 17.08)），碰撞体整体缩在原点，
 *   与 3DGS 完全错位。工具面板「碰撞体」实测：相机命中 log 盒子 0 个、
 *   米制盒子 1 个。现改为仅轴变换，与 3DGS / 出生点 / 漫游路径对齐。
 * 三角形拓扑与相对关系完全来自原始 PLY，不产生任何中间网格文件。
 */
(function () {
    'use strict';


    function parsePly(buf) {
        const bytes = new Uint8Array(buf);
        // 找 end_header\n
        let end = -1;
        const limit = Math.min(bytes.length, 4096);
        for (let i = 0; i < limit - 10; i++) {
            if (bytes[i] === 101 && bytes[i + 1] === 110 && bytes[i + 2] === 100 &&
                bytes[i + 3] === 95 && bytes[i + 4] === 104 && bytes[i + 5] === 101 &&
                bytes[i + 6] === 97 && bytes[i + 7] === 100 && bytes[i + 8] === 101 &&
                bytes[i + 9] === 114) {
                let j = i + 10;
                while (j < bytes.length && (bytes[j] === 10 || bytes[j] === 13)) j++;
                end = j;
                break;
            }
        }
        if (end < 0) throw new Error('PLY end_header not found');
        const head = new TextDecoder('ascii').decode(bytes.subarray(0, end));
        let nv = 0, nf = 0;
        for (const line of head.split(/\r?\n/)) {
            const t = line.trim().split(/\s+/);
            if (t[0] === 'element' && t[1] === 'vertex') nv = parseInt(t[2], 10);
            else if (t[0] === 'element' && t[1] === 'face') nf = parseInt(t[2], 10);
        }
        if (!(nv > 0 && nf > 0)) throw new Error('bad PLY counts ' + nv + '/' + nf);

        const dv = new DataView(buf);
        const vOff = end;
        const fOff = end + nv * 12;
        const need = fOff + nf * 13;
        if (buf.byteLength < need) {
            throw new Error('PLY truncated, need ' + need + ' got ' + buf.byteLength);
        }
        const verts = new Float32Array(nv * 3);
        for (let i = 0; i < nv * 3; i++) verts[i] = dv.getFloat32(vOff + i * 4, true);
        const idx = new Uint32Array(nf * 3);
        let p = fOff;
        for (let f = 0; f < nf; f++) {
            const n = dv.getUint8(p);
            p++;
            if (n !== 3) throw new Error('non-triangle face at ' + f + ' (n=' + n + ')');
            idx[f * 3] = dv.getUint32(p, true); p += 4;
            idx[f * 3 + 1] = dv.getUint32(p, true); p += 4;
            idx[f * 3 + 2] = dv.getUint32(p, true); p += 4;
        }
        return { verts, idx, nv, nf };
    }

    // 官方 btree：扁平 BVH，节点 32 字节。
    //   min(3*f32) max(3*f32) a(u32) b(u32)
    //   b 高 16 位 == 0xFFFF 表示叶子，低 16 位是该叶三角形数；a 是三角形起始索引
    //   否则 b 是分裂轴(0/1/2)，a 与右子树定位有关
    function parseBtree(buf) {
        const dv = new DataView(buf);
        const nodes = Math.floor(buf.byteLength / 32);
        if (nodes < 1) throw new Error('empty btree');
        const min = [dv.getFloat32(0, true), dv.getFloat32(4, true), dv.getFloat32(8, true)];
        const max = [dv.getFloat32(12, true), dv.getFloat32(16, true), dv.getFloat32(20, true)];
        let leaves = 0, leafTris = 0, maxTriIndex = 0;
        for (let i = 0; i < nodes; i++) {
            const o = i * 32;
            const a = dv.getUint32(o + 24, true);
            const b = dv.getUint32(o + 28, true);
            if ((b >>> 16) === 0xffff) {
                const cnt = b & 0xffff;
                leaves++;
                leafTris += cnt;
                maxTriIndex = Math.max(maxTriIndex, a + cnt);
            }
        }
        return { nodes, leaves, leafTris, maxTriIndex, min, max };
    }

    async function fetchBuf(url) {
        const r = await fetch(url);
        if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
        return r.arrayBuffer();
    }

    async function loadTriangles(manifestUrl) {
        const m = await (await fetch(manifestUrl)).json();
        const base = new URL('.', new URL(manifestUrl, location.href)).href;
        const parts = m.parts || [];
        const raw = await Promise.all(parts.map(async (p) => {
            const [plyBuf, treeBuf] = await Promise.all([
                fetchBuf(new URL(p.ply, base).href),
                p.btree ? fetchBuf(new URL(p.btree, base).href) : Promise.resolve(null)
            ]);
            return { ply: parsePly(plyBuf), tree: treeBuf ? parseBtree(treeBuf) : null, name: p.ply };
        }));

        let nv = 0, ni = 0;
        for (const r of raw) { nv += r.ply.nv; ni += r.ply.idx.length; }
        const positions = new Float32Array(nv * 3);
        const indices = new Uint32Array(ni);
        let vo = 0, io = 0;
        const report = [];
        for (const r of raw) {
            const { verts, idx, nv: n, nf } = r.ply;
            // 坐标适配：官方米制 Z-up -> PlayCanvas 米制 Y-up，仅轴变换。
            // 与 3DGS / 出生点 / 漫游路径共用同一个米制世界，不做任何缩放。
            for (let i = 0; i < n; i++) {
                const x = verts[i * 3], y = verts[i * 3 + 1], z = verts[i * 3 + 2];
                positions[(vo + i) * 3] = x;
                positions[(vo + i) * 3 + 1] = z;
                positions[(vo + i) * 3 + 2] = -y;
            }
            for (let i = 0; i < idx.length; i++) indices[io + i] = idx[i] + vo;
            report.push({
                part: r.name, verts: n, tris: nf,
                bvhNodes: r.tree ? r.tree.nodes : null,
                bvhLeaves: r.tree ? r.tree.leaves : null,
                bvhTris: r.tree ? r.tree.leafTris : null,
                triMatch: r.tree ? (r.tree.leafTris === nf) : null
            });
            vo += n;
            io += idx.length;
        }
        return { positions, indices, parts: report, nv, tris: ni / 3 };
    }

    window.__mgLoadLcc2Collision = async function (app, url) {
        const t0 = performance.now();
        const data = await loadTriangles(url);
        const factory = window.__mgMakeMeshCollision;
        if (typeof factory !== 'function') {
            throw new Error('MeshCollision factory not available');
        }
        const collision = factory(data.positions, data.indices);
        window.__mgCollisionInfo = {
            ...data, positions: undefined, indices: undefined,
            space: 'meter-y-up (x, z, -y)',
            ms: Math.round(performance.now() - t0)
        };
        console.info('[lcc2-collision] raw PLY+btree:', data.parts.length, 'parts',
            data.nv, 'verts', data.tris, 'tris', window.__mgCollisionInfo.ms, 'ms');
        return collision;
    };
})();

/**
 * 标注文档存储层：单一数据源 + 可插拔持久化
 *
 * 默认 LocalStore（localStorage，离线、零后端）。
 * 预留 HttpStore：把 adapter 换成 { load, save } 即可对接 serve.py 的
 * /api/annotations 或云端数据库，上层 Editor / Overlay / Panel 完全不用改。
 */
import { SCHEMA_VERSION, blankDoc, validate, newId, makeAnnotation, defaultStyle,
  DEFAULT_GROUP_ID, GROUP_PALETTE, defaultGroups } from './schema.js';

const KEY = 'mg3dgs.annotations.v1';

export class LocalAdapter {
  load() { return localStorage.getItem(KEY); }
  save(text) { localStorage.setItem(KEY, text); }
}

/** 需要服务端持久化时启用：GET /api/annotations、PUT /api/annotations */
export class HttpAdapter {
  constructor(url = './api/annotations') { this.url = url; }
  async load() {
    const r = await fetch(this.url, { cache: 'no-store' });
    return r.ok ? r.text() : null;
  }
  async save(text) {
    await fetch(this.url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: text });
  }
}

export class Store extends EventTarget {
  constructor(adapter = new LocalAdapter()) {
    super();
    this.adapter = adapter;
    this.doc = this._read() || blankDoc();
    this._undo = [];
    this._redo = [];
    this._suspend = false;
    this._coalesceKey = null;
    this._coalesceAt = 0;
    this._coalesceBase = null;
  }

  /** 旧文档（无 groups / groupId）无缝升级：补默认分组 + 把标注归入默认组。
   *  导入、读取、撤销恢复都走这里，保证任何入口拿到的 doc 结构一致。 */
  _normalize(d) {
    if (!Array.isArray(d.groups) || !d.groups.length) d.groups = defaultGroups();
    else if (!d.groups.some(g => g.id === DEFAULT_GROUP_ID)) d.groups.unshift(defaultGroups()[0]);
    for (const g of d.groups) {
      if (g.visible === undefined) g.visible = true;
      if (g.collapsed === undefined) g.collapsed = false;
      if (g.order === undefined) g.order = 0;
      if (!g.color) g.color = '#22d3ee';
    }
    /* 深度检测默认开启（2026-11-23 需求变更）。
       旧文档里每条都显式存了 `depthTest: false`，只改 undefined 兜底不够 ——
       用一次性迁移标记 depthDefault=2 把它们统一打开；迁移后用户手动关掉的
       标注不会被后续加载重新打开。 */
    const migrateDepth = d.depthDefault !== 2;
    for (const a of d.annotations) {
      if (!a.groupId) a.groupId = DEFAULT_GROUP_ID;
      if (migrateDepth || a.depthTest === undefined) a.depthTest = true;
      if (!a.style || typeof a.style !== 'object') a.style = {};
      // 与默认样式合并：仅补缺失字段，不覆盖已有值，也不重置时间戳。
      // 否则导入一个缺 style 的标注会让面板读取 a.style.color 直接崩溃（QA 组「导入无单条校验」缺口）。
      a.style = { ...defaultStyle(a.kind), ...a.style };
      if (a.style.bandWidth === undefined) a.style.bandWidth = 0.7;
      // 贴面矩形的屏幕框 / 深度反算表面：旧文档没有就补 null，挂载时自动补算
      if (a.rect === undefined) a.rect = null;
      if (a.surface === undefined) a.surface = null;
    }
    d.depthDefault = 2;                          // 深度检测默认开的迁移标记（见上）
    return d;
  }

  _read() {
    try {
      const raw = this.adapter.load();
      if (typeof raw !== 'string') return null;
      const d = JSON.parse(raw);
      if (d?.version !== SCHEMA_VERSION || !Array.isArray(d.annotations)) return null;
      return this._normalize(d);
    } catch { return null; }
  }

  _snapshot() {
    if (!this._suspend) {
      this._undo.push(JSON.stringify(this.doc));
      if (this._undo.length > 60) this._undo.shift();
      this._redo.length = 0;
      // 新的结构性快照：打断连续输入的合并链
      this._coalesceKey = null;
    }
  }

  _changed(reason) {
    this.doc.updatedAt = new Date().toISOString();
    try { this.adapter.save(JSON.stringify(this.doc)); }
    catch (err) {
      // 只读环境 / 配额超限 / 隐私模式都可能抛错。
      // 配额超限（QuotaExceededError）是最常见的「静默丢数据」根因：
      // 含大 surface 网格的标注文档极易超过浏览器 5MB 单 key 上限，
      // 一旦吞掉错误，刷新后 localStorage 仍是旧值 -> 整份标注丢失。
      // 这里区分错误类型并派发 'error' 事件，由 UI 给出可见告警。
      const e = err || {};
      const quota = e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014;
      this.dispatchEvent(new CustomEvent('error', {
        detail: { type: quota ? 'quota' : 'save', message: String(e?.message || e) }
      }));
    }
    this.dispatchEvent(new CustomEvent('change', { detail: { reason } }));
  }

  // ---------------------------------------------------------------- 标注
  list(scene) {
    return this.doc.annotations
      .filter(a => !scene || a.scene === scene)
      .slice()
      .sort((a, b) => a.order - b.order);
  }
  get(id) { return this.doc.annotations.find(a => a.id === id) || null; }

  add(a) {
    // 归一化：无论调用方（编辑器绘制 / 程序化新增 / 外部补加）传入的标注是否完整，
    // 都经 makeAnnotation 补齐 id/order/style 默认/坐标类型，避免面板读取 a.style.color 时崩溃，
    // 同时给「新增无单条校验」做兜底（QA 组缺口）。对完整标注而言 makeAnnotation 是幂等的。
    const norm = makeAnnotation(a.kind, a.points, a);
    const err = validate(norm);
    if (err) throw new Error(err);
    this._snapshot();
    this.doc.annotations.push(norm);
    this._changed('add');
    return norm;
  }

  update(id, patch, opts = {}) {
    const a = this.get(id);
    if (!a) return null;
    // 锁定后除「解锁」本身外不可改（否则复选框勾上就再也解不开）
    if (a.locked && !('locked' in patch)) return null;
    // 连续输入（打字 / 拖滑块）合并成一次撤销，避免撤销栈被几十条快照刷爆
    const key = opts.coalesceKey || null;
    const now = Date.now();
    // noUndo：机器派生字段（如动线贴地结果 a.drape）的回写不进撤销栈 ——
    // 用户按一次 Ctrl+Z 应该撤销「我画的那条线」，而不是撤销看不见的贴地重算。
    if (opts.noUndo) {
      this._coalesceKey = null;
    } else if (key && this._coalesceKey === key && now - this._coalesceAt < 1200 && this._undo.length) {
      // 同一字段的连续编辑：把栈顶快照换回最初状态，撤销一次就回到编辑前
      this._undo[this._undo.length - 1] = this._coalesceBase;
      this._redo.length = 0;
    } else {
      this._snapshot();
      this._coalesceKey = key;
      this._coalesceAt = now;
      this._coalesceBase = JSON.stringify(this.doc);
    }
    // Object.assign 会把 patch.style 整个替换掉，必须先留旧 style 再合并
    const merged = patch.style ? { ...a.style, ...patch.style } : null;
    Object.assign(a, patch, { updatedAt: new Date().toISOString() });
    if (merged) a.style = merged;
    const err = validate(a);
    if (err) { this.undo(); throw new Error(err); }
    this._changed('update');
    return a;
  }

  remove(id) {
    const i = this.doc.annotations.findIndex(a => a.id === id);
    if (i < 0) return false;
    this._snapshot();
    this.doc.annotations.splice(i, 1);
    this._changed('remove');
    return true;
  }

  move(id, points) { return this.update(id, { points }); }

  /** 复制标注：深拷贝成新对象（新 id / 新标题），所有顶点整体平移 (dx,dz)，
   *  保留分组 / 图层 / 内容 / 样式，作为一条独立撤销记录。用于批量布点 / 快速复用。 */
  duplicate(id, dx = 0.5, dz = 0.5) {
    const a = this.get(id);
    if (!a) return null;
    this._snapshot();
    const copy = JSON.parse(JSON.stringify(a));
    copy.id = newId();
    copy.title = (a.title || '') + ' 副本';
    copy.points = (copy.points || []).map(p =>
      [Number(p[0]) + dx, Number(p[1]), Number(p[2]) + dz]);
    if (Array.isArray(copy.surface?.points))
      copy.surface.points = copy.surface.points.map(p => [p[0] + dx, p[1], p[2] + dz]);
    // 动线贴地中心线必须跟着平移，否则副本的箭头链还画在原位置
    if (Array.isArray(copy.drape))
      copy.drape = copy.drape.map(p => [p[0] + dx, p[1], p[2] + dz]);
    if (Array.isArray(copy.rect)) copy.rect = copy.rect.slice();
    copy.order = Date.now();
    copy.createdAt = new Date().toISOString();
    copy.updatedAt = copy.createdAt;
    this.doc.annotations.push(copy);
    this._changed('duplicate');
    return copy;
  }

  /** 层级（z-order）：DOM / SVG 叠加层按 order 升序绘制，order 越大越靠前。 */
  bringToFront(id) {
    const a = this.get(id); if (!a) return null;
    this._snapshot();
    const max = this.doc.annotations.reduce((m, x) => Math.max(m, Number(x.order) || 0), 0);
    a.order = max + 1;
    this._changed('order'); return a;
  }
  sendToBack(id) {
    const a = this.get(id); if (!a) return null;
    this._snapshot();
    const min = this.doc.annotations.reduce((m, x) => Math.min(m, Number(x.order) || 1e15), 1e15);
    a.order = min - 1;
    this._changed('order'); return a;
  }

  // ---------------------------------------------------------------- 分组
  // 组级 visible 只作为「渲染开关」，不改写每个标注的 visible ——
  // 这样批量显隐是一次撤销、也不会把用户单独隐藏的标注误改回显示。
  groups() { return this.doc.groups; }
  group(id) { return this.doc.groups.find(g => g.id === id) || null; }
  listByGroup(id, scene) {
    return this.list(scene).filter(a => (a.groupId || DEFAULT_GROUP_ID) === id);
  }
  /** overlay 每帧调用：分组被隐藏时整组不参与投影 */
  groupVisible(a) {
    const g = this.group(a?.groupId);
    return !g || g.visible !== false;
  }
  addGroup(name, color) {
    this._snapshot();
    const n = this.doc.groups.length;
    const g = { id: newId(), name: name || '分组 ' + (n + 1),
      color: color || GROUP_PALETTE[n % GROUP_PALETTE.length],
      visible: true, collapsed: false, order: n };
    this.doc.groups.push(g);
    this._changed('group-add');
    return g;
  }
  renameGroup(id, name) {
    const g = this.group(id);
    if (!g) return null;
    const v = String(name ?? '').trim();
    if (!v || v === g.name) return g;
    this._snapshot();
    g.name = v;
    this._changed('group-rename');
    return g;
  }
  toggleGroup(id) {
    const g = this.group(id);
    if (!g) return null;
    this._snapshot();
    g.visible = g.visible === false;
    this._changed('group-visible');
    return g;
  }
  /** 折叠是纯 UI 状态：不进撤销栈，但仍持久化并重绘 */
  setGroupCollapsed(id, collapsed) {
    const g = this.group(id);
    if (!g || g.collapsed === !!collapsed) return g;
    g.collapsed = !!collapsed;
    this._changed('group-fold');
    return g;
  }
  /** 删除分组只「解散」：组内标注移回默认组，默认组本身不可删 */
  removeGroup(id) {
    if (id === DEFAULT_GROUP_ID) return false;
    const i = this.doc.groups.findIndex(g => g.id === id);
    if (i < 0) return false;
    this._snapshot();
    for (const a of this.doc.annotations) if (a.groupId === id) a.groupId = DEFAULT_GROUP_ID;
    this.doc.groups.splice(i, 1);
    this._changed('group-remove');
    return true;
  }
  /** 批量指派：把若干标注移入某组 */
  assignGroup(ids, groupId) {
    if (!this.group(groupId)) return 0;
    const set = new Set(Array.isArray(ids) ? ids : [ids]);
    const todo = this.doc.annotations.filter(a => set.has(a.id) && a.groupId !== groupId);
    if (!todo.length) return 0;
    this._snapshot();
    for (const a of todo) a.groupId = groupId;
    this._changed('group-assign');
    return todo.length;
  }

  // ---------------------------------------------------------------- 图层 / 导览
  layers() { return this.doc.layers; }
  layer(id) { return this.doc.layers.find(l => l.id === id) || null; }
  addLayer(name, color) {
    this._snapshot();
    const l = { id: newId(), name: name || '新图层', color: color || '#22d3ee', visible: true };
    this.doc.layers.push(l);
    this._changed('layer');
    return l;
  }
  toggleLayer(id) {
    const l = this.layer(id);
    if (!l) return;
    this._snapshot();
    l.visible = !l.visible;
    this._changed('layer');
  }
  tours() { return this.doc.tours; }
  saveTour(name, stops) {
    this._snapshot();
    const i = this.doc.tours.findIndex(t => t.name === name);
    const t = { id: i >= 0 ? this.doc.tours[i].id : newId(), name, stops };
    if (i >= 0) this.doc.tours[i] = t; else this.doc.tours.push(t);
    this._changed('tour');
    return t;
  }

  calibration() { return this.doc.calibration; }
  setCalibration(patch) {
    this._snapshot();
    Object.assign(this.doc.calibration, patch);
    this._changed('calibration');
  }

  // ---------------------------------------------------------------- 撤销 / 重做
  undo() {
    if (!this._undo.length) return false;
    this._redo.push(JSON.stringify(this.doc));
    this.doc = this._normalize(JSON.parse(this._undo.pop()));
    // 复位合并链，避免「撤销新动作却把撤销前的旧动作一起撤掉」的跨边界泄漏
    this._coalesceKey = null; this._coalesceBase = null;
    this._changed('undo');
    return true;
  }
  redo() {
    if (!this._redo.length) return false;
    this._undo.push(JSON.stringify(this.doc));
    this.doc = this._normalize(JSON.parse(this._redo.pop()));
    this._coalesceKey = null; this._coalesceBase = null;
    this._changed('redo');
    return true;
  }

  // ---------------------------------------------------------------- 导入导出
  exportText() { return JSON.stringify(this.doc, null, 2); }
  importText(text, { merge = false } = {}) {
    const d = JSON.parse(text);
    if (d?.version !== SCHEMA_VERSION || !Array.isArray(d.annotations)) {
      throw new Error('不是有效的标注文档（schema 版本不符）');
    }
    this._snapshot();
    this._normalize(d);
    if (merge) {
      const ids = new Set(this.doc.annotations.map(a => a.id));
      d.annotations.forEach(a => { if (!ids.has(a.id)) this.doc.annotations.push(a); });
      (d.layers || []).forEach(l => { if (!this.layer(l.id)) this.doc.layers.push(l); });
      (d.groups || []).forEach(g => { if (!this.group(g.id)) this.doc.groups.push(g); });
    } else {
      this.doc = d;
    }
    this._changed('import');
  }
  reset() {
    this._snapshot();
    this.doc = blankDoc();
    this._changed('reset');
  }
}

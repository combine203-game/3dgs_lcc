/**
 * 浏览态「场景图层」面板（纯 DOM 构建，双宿主复用）
 *
 * 为什么不写死在某一个文档里：
 *   · 展厅融合页（maoming-showroom/index.html）的右侧 HUD 列在**父页**，
 *     iframe 内左下 / 右下分别被父页辅助条与小地图占用，面板只能挂在父页；
 *   · 独立打开的 gs-viewer.html 没有父页，面板只能挂在 iframe 内。
 * 本模块不读全局 document 以外的东西，谁 import 就建在谁的文档里，
 * 样式自带注入（幂等），因此两个宿主共用同一份实现，行为完全一致。
 *
 * 数据与显隐由宿主提供：
 *   getTree()  -> { sceneLabel, total, shown, groups:[...], layers:[...] }
 *   onToggle(kind, id, on)   kind = 'ann' | 'group' | 'layer'
 *   onAll(mode)              mode = 'on' | 'off' | 'reset'
 *   onRefresh()              重新读取编辑器标注（localStorage → 场景）
 */

const STYLE_ID = 'mg-ann-ui-style';

const CSS = `
.mg-ann-panel{position:absolute;right:16px;bottom:64px;width:320px;
  max-height:min(64vh,540px);display:flex;flex-direction:column;overflow:hidden;
  background:rgba(16,22,31,.97);border:1px solid rgba(90,150,180,.34);border-radius:10px;
  box-shadow:0 16px 44px rgba(0,0,0,.55);color:#dfeef7;z-index:46;
  font:12px/1.5 "Microsoft YaHei","PingFang SC",system-ui,sans-serif}
.mg-ann-panel[hidden]{display:none!important}
.mg-ann-hd{display:flex;align-items:center;justify-content:space-between;gap:8px;
  padding:9px 11px;border-bottom:1px solid rgba(90,150,180,.22);background:rgba(22,30,42,.96)}
.mg-ann-hd b{font-size:12px;letter-spacing:.06em}
.mg-ann-hd small{display:block;margin-top:2px;font-size:9px;letter-spacing:.12em;color:#6f9cb0}
.mg-ann-x{padding:0 6px;font-size:16px;line-height:20px;cursor:pointer;border-radius:5px;
  border:1px solid transparent;background:transparent;color:#8fb4c2}
.mg-ann-x:hover{color:#fff;border-color:rgba(122,219,239,.45)}
.mg-ann-sum{padding:7px 11px 5px;font-size:10px;color:#8fb4c2;letter-spacing:.03em}
.mg-ann-tools{display:flex;flex-wrap:wrap;gap:5px;padding:0 11px 8px}
.mg-ann-tools button{padding:3px 7px;font-size:10px;cursor:pointer;border-radius:5px;
  border:1px solid rgba(90,150,180,.3);background:#1a2534;color:#bcd8e6}
.mg-ann-tools button:hover{background:#233448;color:#eaf8ff;border-color:#3f7392}
.mg-ann-body{flex:1;min-height:0;overflow:auto;padding:2px 7px 8px}
.mg-ann-sec{padding:7px 4px 3px;font-size:9px;letter-spacing:.14em;color:#5f8ba0;
  border-top:1px solid rgba(90,150,180,.16);margin-top:4px}
.mg-ann-sec:first-child{border-top:0;margin-top:0}
.mg-ann-row{display:flex;align-items:center;gap:6px;padding:3px 5px;border-radius:5px;
  cursor:default;font-size:11px;color:#cfe6f2}
.mg-ann-row:hover{background:#14293a}
.mg-ann-group{cursor:pointer}
.mg-ann-group>.mg-ann-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mg-ann-group>small{font-size:10px;color:#6f9cb0;font-variant-numeric:tabular-nums}
.mg-ann-caret{width:10px;flex:none;font-size:9px;color:#6f9cb0;text-align:center}
.mg-ann-eye{width:20px;flex:none;padding:0;font-size:11px;line-height:16px;cursor:pointer;
  border:1px solid transparent;border-radius:4px;background:transparent;color:#63e2ff}
.mg-ann-eye:hover{border-color:rgba(122,219,239,.5);background:#122a3a}
.mg-ann-eye[data-on="0"]{color:#4a6373}
.mg-ann-dot{width:8px;height:8px;flex:none;border-radius:50%;background:var(--c,#22d3ee);
  box-shadow:0 0 0 2px color-mix(in srgb,var(--c,#22d3ee) 24%,transparent)}
.mg-ann-item{padding-left:20px}
.mg-ann-item[data-on="0"]{opacity:.45}
.mg-ann-item>.mg-ann-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mg-ann-kind{flex:none;font-size:9px;color:#7fb6cc;letter-spacing:.02em;
  border:1px solid rgba(90,150,180,.28);border-radius:3px;padding:0 3px}
.mg-ann-empty{padding:12px 8px;font-size:11px;line-height:1.7;color:#7796a6}
.mg-ann-ft{padding:6px 11px;border-top:1px solid rgba(90,150,180,.18);
  font-size:9px;line-height:1.6;color:#5f8ba0}
.mg-ann-btn{position:absolute;right:16px;bottom:16px;z-index:45;padding:7px 12px;
  font:11px/1.2 "Microsoft YaHei",system-ui,sans-serif;cursor:pointer;border-radius:8px;
  background:rgba(16,22,31,.94);border:1px solid rgba(90,150,180,.34);color:#cfe6f2;
  box-shadow:0 8px 24px rgba(0,0,0,.45)}
.mg-ann-btn:hover{background:#1b2a3a;color:#eaf8ff}
.mg-ann-btn.is-on{border-color:#63e2ff;color:#63e2ff}
.mg-ann-btn b{margin-left:5px;color:#8fb4c2;font-weight:600}
html.mg-editor-on .mg-ann-panel,html.mg-editor-on .mg-ann-btn{display:none!important}
`;

export function injectAnnPanelStyle() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  (document.head || document.documentElement).appendChild(el);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * @param {object} o
 * @param {Element} o.mount      挂载父节点（须为 position:relative/absolute 容器）
 * @param {() => object|null} o.getTree
 * @param {(kind:string,id:string,on:boolean)=>any} o.onToggle
 * @param {(mode:string)=>any} [o.onAll]
 * @param {()=>any} [o.onRefresh]
 * @param {object} [o.style]     额外定位（父页右侧面板列等）
 * @param {string} [o.emptyText] 数据未就绪时的占位文案
 * @param {string} [o.id]        面板 id（默认 mg-ann-panel）
 */
export function createAnnotationPanel(o = {}) {
  const { mount, getTree, onToggle } = o;
  if (!mount) throw new Error('createAnnotationPanel: 缺少 mount 容器');
  injectAnnPanelStyle();

  const collapsed = new Set();
  const root = document.createElement('section');
  root.id = o.id || 'mg-ann-panel';
  root.className = 'mg-ann-panel';
  root.hidden = true;
  root.innerHTML =
    '<div class="mg-ann-hd"><div><b>场景图层</b>' +
      '<small>SCENE LAYERS · ANNOTATION VISIBILITY</small></div>' +
      '<button type="button" class="mg-ann-x" aria-label="关闭">×</button></div>' +
    '<div class="mg-ann-sum">载入中…</div>' +
    '<div class="mg-ann-tools">' +
      '<button type="button" data-ann-all="on">全部显示</button>' +
      '<button type="button" data-ann-all="off">全部隐藏</button>' +
      '<button type="button" data-ann-all="reset">恢复默认</button>' +
      '<button type="button" data-ann-all="reload">重新读取</button>' +
    '</div>' +
    '<div class="mg-ann-body"></div>' +
    '<div class="mg-ann-ft">显隐只作用于浏览画面，不改写编辑器里的标注数据。</div>';
  if (o.style) Object.assign(root.style, o.style);
  mount.appendChild(root);

  const sumEl = root.querySelector('.mg-ann-sum');
  const bodyEl = root.querySelector('.mg-ann-body');

  function rowItem(it) {
    const on = it.visible !== false;
    return '<div class="mg-ann-row mg-ann-item" data-ann="' + esc(it.id) + '" data-on="' + (on ? '1' : '0') + '">' +
      '<button type="button" class="mg-ann-eye" data-ann-act="toggle" data-kind="ann" data-id="' + esc(it.id) + '" ' +
        'data-on="' + (on ? '1' : '0') + '" title="显示 / 隐藏">' + (on ? '◉' : '○') + '</button>' +
      '<span class="mg-ann-kind">' + esc(it.kindLabel || it.kind || '') + '</span>' +
      '<span class="mg-ann-name">' + esc(it.title || '未命名') + '</span>' +
    '</div>';
  }

  function rowGroup(g, kind) {
    const on = g.visible !== false;
    const fold = collapsed.has(kind + ':' + g.id);
    const attr = kind === 'group' ? 'data-group' : 'data-layer';
    const head = '<div class="mg-ann-row mg-ann-group" ' + attr + '="' + esc(g.id) + '" data-on="' +
      (on ? '1' : '0') + '">' +
      '<span class="mg-ann-caret">' + (fold ? '▸' : '▾') + '</span>' +
      '<button type="button" class="mg-ann-eye" data-ann-act="toggle" data-kind="' + kind + '" data-id="' +
        esc(g.id) + '" data-on="' + (on ? '1' : '0') + '" title="整组显示 / 隐藏">' + (on ? '◉' : '○') + '</button>' +
      '<i class="mg-ann-dot" style="--c:' + esc(g.color || '#22d3ee') + '"></i>' +
      '<span class="mg-ann-name">' + esc(g.name || g.id) + '</span>' +
      '<small>' + (g.count || 0) + '</small>' +
    '</div>';
    if (fold || kind !== 'group') return head;
    return head + g.items.map(rowItem).join('');
  }

  function render() {
    let tree = null;
    try { tree = getTree(); } catch (_) { tree = null; }
    if (!tree) {
      sumEl.textContent = o.emptyText || '三维场景还没就绪…';
      bodyEl.innerHTML = '<div class="mg-ann-empty">等待三维场景与标注数据加载。</div>';
      return;
    }
    sumEl.textContent = (tree.sceneLabel || '当前场景') + ' · 共 ' + tree.total +
      ' 条 · 显示 ' + tree.shown + ' 条';
    if (!tree.total) {
      bodyEl.innerHTML = '<div class="mg-ann-empty">当前场景暂无标注。' +
        '在「标注编辑」里创建 / 载入标注后，退出编辑回到浏览模式即可在这里控制显隐。</div>';
      return;
    }
    let html = '<div class="mg-ann-sec">分组 / GROUP</div>';
    html += tree.groups.map((g) => rowGroup(g, 'group')).join('');
    if (tree.layers && tree.layers.length) {
      html += '<div class="mg-ann-sec">图层 / LAYER</div>';
      html += tree.layers.map((l) => rowGroup(l, 'layer')).join('');
    }
    bodyEl.innerHTML = html;
  }

  function refresh() { render(); }

  bodyEl.addEventListener('click', (e) => {
    const eye = e.target.closest('[data-ann-act="toggle"]');
    if (eye) {
      e.stopPropagation();
      const kind = eye.dataset.kind || 'ann';
      const id = eye.dataset.id;
      const next = eye.dataset.on !== '1';
      try { onToggle?.(kind, id, next); } catch (_) { /* 宿主异常不影响面板 */ }
      render();
      return;
    }
    const g = e.target.closest('[data-group]') || e.target.closest('[data-layer]');
    if (g) {
      const key = (g.dataset.group ? 'group:' : 'layer:') + (g.dataset.group || g.dataset.layer);
      if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);
      render();
    }
  });

  root.querySelector('.mg-ann-x').addEventListener('click', () => setOpen(false));
  root.querySelectorAll('[data-ann-all]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.annAll;
      try {
        if (mode === 'reload') o.onRefresh?.();
        else o.onAll?.(mode);
      } catch (_) { /* noop */ }
      render();
    });
  });

  function setOpen(on) {
    const show = !!on;
    root.hidden = !show;
    if (show) render();
    o.onOpenChange?.(show);
  }

  render();
  return {
    el: root,
    refresh,
    render,
    setOpen,
    isOpen: () => !root.hidden,
    destroy: () => { try { root.remove(); } catch (_) { /* noop */ } }
  };
}

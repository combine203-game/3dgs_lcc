/**
 * 编辑器 UI：工具栏（含深度开关）/ 图层 / 分组 / 标注列表 / 属性 / 状态栏
 * 纯 DOM + CSS，与展厅 HUD 同风格，不引入框架。
 * 所有操作通过 onAction(type, payload) 上抛给 editor.js，UI 不直接改数据。
 *
 * 【交互修复要点】
 *  1. 属性面板 **不再每次整块重建**。store 每次 change 都全量 innerHTML 的话，
 *     用户在「标题 / 说明」里打字时输入框会被重建 -> 失焦、光标丢失，
 *     表现就是「点了左侧标注却没法在右侧属性里编辑」。
 *     现在：切换标注 / 分组结构变化才重建；只改数值时只同步 value，并跳过正在聚焦的输入框。
 *  2. 左侧列表按分组折叠，同样按签名增量更新，避免滚动位置被重置。
 *  3. 展板支持四种内容形态：文字 / 图片 / 网页 / 视频，内容由 overlay 直接
 *     内嵌在三维展板里 —— 这里**不提供任何弹出式内容卡片**。
 */
import { TOOLS, KINDS, LAYER_PALETTE, DEFAULT_GROUP_ID } from './schema.js';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 只有内容真的变了才写 innerHTML（保住焦点 / 滚动位置） */
function setHTML(el, html) {
  if (el.__html === html) return false;
  el.__html = html;
  el.innerHTML = html;
  return true;
}

export const MEDIA_TYPES = [
  { id: 'none',     label: '无（纯文字）' },
  { id: 'image',    label: '图片' },
  { id: 'webpage',  label: '网页' },
  { id: 'video',    label: '视频' },
];

/** 内容预览：只读渲染标注的标题 / 正文 / 媒体 / 链接。
 *  拾取（场景内点击或列表点击）后属性面板重建时会自动带上这一块。
 *  外链资源不预加载（只显示来源），避免属性面板为了预览去发一堆跨域请求。 */
function pickMediaHtml(m, a) {
  if (!m) {
    if (a?.kind === 'screen') return '<div class="ed-pick-none">三维实体屏 · 播放内置演示画面（可在下方填入视频 URL）</div>';
    if (a?.kind === 'decal') {
      return a.projector?.mode === 'persp'
        ? '<div class="ed-pick-none">透视贴花 · 视锥体透视投影（填入视频 URL 后即为投射面）</div>'
        : '<div class="ed-pick-none">贴面矩形 · 投影式延迟贴花（填入视频 URL 后即为投射面）</div>';
    }
    return '<div class="ed-pick-none">纯文字标注 · 无媒体内容</div>';
  }
  const url = m.url || '';
  const local = /^(data:|\.\/|\/)/.test(url);
  const cap = m.caption ? `<div class="ed-pick-cap">${esc(m.caption)}</div>` : '';
  if (m.type === 'image') {
    return local ? `<img class="ed-pick-img" src="${esc(url)}" alt="${esc(m.caption || '')}">${cap}`
      : `<div class="ed-pick-ext" data-src="${esc(url)}">🖼 图片（外链，不预加载）</div>${cap}`;
  }
  if (m.type === 'video') {
    return local ? `<video class="ed-pick-video" src="${esc(url)}" controls muted playsinline preload="metadata"></video>${cap}`
      : `<div class="ed-pick-ext" data-src="${esc(url)}">▶ 视频（外链，不预加载）</div>${cap}`;
  }
  if (m.type === 'webpage') {
    return local
      ? `<div class="ed-pick-web"><iframe src="${esc(url)}" sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer"></iframe><span>◫ 内嵌网页</span></div>${cap}`
      : `<div class="ed-pick-ext" data-src="${esc(url)}">◫ 网页（外链，不预加载）</div>${cap}`;
  }
  if (m.type === 'text') return `<div class="ed-pick-note">${esc(m.caption || url || '')}</div>`;
  if (m.type === 'link') return `<div class="ed-pick-note">↗ ${esc(m.caption || url || '')}</div>`;
  return '<div class="ed-pick-none">未识别的媒体类型</div>';
}

function pickViewHtml(a) {
  const m = (a.media || [])[0] || null;
  const sig = m ? `${m.type}|${m.url}|${m.caption || ''}` : '';
  return `
    <div class="ed-sec-hd ed-pick-sec"><b>内容预览</b><small>拾取后自动展示</small></div>
    <div class="ed-pick-view" data-role="pick-view">
      <div class="ed-pick-kicker">${KINDS[a.kind].icon} ${esc(KINDS[a.kind].label)}${a.locked ? ' · 已锁定' : ''}</div>
      <h4 data-role="pick-title">${esc(a.title)}</h4>
      <p data-role="pick-body">${esc(a.body || '（暂无正文）')}</p>
      <div class="ed-pick-media" data-role="pick-media" data-sig="${esc(sig)}">${pickMediaHtml(m, a)}</div>
      <a class="ed-pick-link" data-role="pick-link" target="_blank" rel="noopener" ${a.link ? `href="${esc(a.link)}"` : 'hidden'}>${esc(a.link || '')}${a.link ? ' ↗' : ''}</a>
    </div>`;
}

export function createPanel({ host, store, onAction, getState, getDecalDiag }) {
  const root = document.createElement('div');
  root.className = 'ed-ui';
  host.appendChild(root);

  root.innerHTML = `
    <div class="ed-toolbar">
      <span class="ed-logo">标注编辑</span>
      <div class="ed-tools">${TOOLS.map(t =>
        `<button data-act="tool" data-v="${t.id}" title="${t.label} (Shift+${t.key})"><i>${t.icon}</i><em>${t.label}</em></button>`).join('')}</div>
      <span class="ed-sep"></span>
      <button data-act="depth" class="ed-depth" title="开：落点贴合 MESH / 高斯表面；关：锁定绘制平面，线面严格共面">深度 开</button>
      <button data-act="mesh" class="ed-mesh" title="全局显示 / 隐藏碰撞体 MESH 线框（Shift+C）；贴面矩形与动线贴合时可对照表面">碰撞体 关</button>
      <label class="ed-plane" title="关闭深度时，绘制平面距相机的距离（米）">距离
        <input type="range" data-act="plane" min="0.5" max="30" step="0.5" value="6">
        <span data-role="plane-val">6.0m</span>
      </label>
      <span class="ed-sep"></span>
      <button data-act="undo" title="Ctrl+Z">↶</button>
      <button data-act="redo" title="Ctrl+Shift+Z">↷</button>
      <button data-act="export" title="导出 JSON (Ctrl+S)">导出</button>
      <button data-act="import" title="导入 JSON">导入</button>
      <button data-act="preview" class="ed-preview" title="切换预览 / 编辑 (Tab)">预览</button>
      <input type="file" accept=".json,application/json" hidden data-act="file">
    </div>

    <div class="ed-wasd">
      <b>WASD</b> 自由飞行 · 拖拽旋转视角 · 滚轮缩放 · 单击落点 · <b>双击</b> / <b>Enter</b> 结束绘制并回到「选择」 · <b>右键</b> 取消当前标注并回到「选择」 · <b>Shift+V/P/L/E/B/N/R/M</b> 切工具 · <b>Shift+C</b> 碰撞体 · <b>Esc</b> 取消选中
    </div>

    <aside class="ed-left">
      <div class="ed-sec-hd"><b>图层</b><button data-act="layer-add" title="新建图层">＋</button></div>
      <div class="ed-layers"></div>
      <div class="ed-sec-hd"><b>分组</b><button data-act="group-add" title="新建分组（新绘制的标注将归入当前分组）">＋</button></div>
      <div class="ed-groups"></div>
      <div class="ed-group-tip">点击组名可设为当前分组，之后绘制的标注自动归入；组名可直接编辑</div>
      <div class="ed-sec-hd"><b>标注</b><span class="ed-count" data-role="count">0</span></div>
      <input class="ed-search" data-act="search" placeholder="搜索标题 / 正文…">
      <div class="ed-list"></div>
      <div class="ed-sec-hd"><b>导览</b><button data-act="tour-add" title="把当前机位存为导览站点">＋</button></div>
      <div class="ed-tours"></div>
    </aside>

    <aside class="ed-right"><div class="ed-prop"></div></aside>

    <div class="ed-status"><span data-role="status">就绪</span><span data-role="hint"></span></div>
  `;

  const $ = sel => root.querySelector(sel);
  const layersEl = $('.ed-layers');
  const groupsEl = $('.ed-groups');
  const listEl = $('.ed-list');
  const toursEl = $('.ed-tours');
  const propEl = $('.ed-prop');
  const fileEl = root.querySelector('[data-act="file"]');
  let keyword = '';
  let propsFor = null;       // 当前属性面板对应的标注 id（变了才重建结构）
  let propsKind = null;
  let propsGroupSig = null;  // 分组列表变了也要重建（groupId 下拉选项）
  let propsAnchorSig = null; // 展板引线锚点状态变了也要重建（提示文案 / 复位按钮）
  let propsSurfaceSig = null; // 贴面深度表面异步生成完成也要重建（状态行）
  let localObjectUrl = null; // 本地视频文件生成的 blob URL（替换 / 卸载时释放）

  root.addEventListener('click', e => {
    // 组名是可直接编辑的 input：点它只聚焦，不触发「设为当前分组」等行动作
    if (e.target.closest('[data-role="group-name"]')) return;
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act, v = b.dataset.v;
    if (act === 'import') { fileEl.click(); return; }
    if (act === 'file' || act === 'search' || act === 'plane') return;
    // 列表行 Shift+单击 = 加选 / 减选（Figma/Miro 式多选）
    if (act === 'item' && e.shiftKey) { onAction('select-toggle', v); return; }
    onAction(act, v);
  });

  // 双击一律不触发任何事件（左键 / 右键都是）：列表行双击不再「飞到机位」，
  // 与场景内双击禁用的语义保持一致；定位走列表行上的「飞到此处」按钮。

  root.addEventListener('change', e => {
    const t = e.target;
    // 分组改名：行内 input，失焦 / 回车时提交（不用 prompt，便于自动化回归）
    if (t.dataset?.role === 'group-name') {
      onAction('group-rename', { id: t.dataset.v, name: t.value });
      return;
    }
    // 展板内容字段用 data-media-field，没有 data-act，必须先单独判断
    if (t.dataset?.mediaField) {
      onAction('media', {
        id: getState().selectedId,
        type: t.dataset.mediaField === 'type' ? t.value : undefined,
        url: t.dataset.mediaField === 'url' ? t.value : undefined,
        caption: t.dataset.mediaField === 'caption' ? t.value : undefined
      });
      return;
    }
    // 展板尺寸（宽 / 高）-> 合并进 style.size
    if (t.dataset.field === 'sizeW' || t.dataset.field === 'sizeH') {
      const a = store.get(getState().selectedId);
      const cur = a?.style.size || { w: 1.8, h: 1.35 };
      const w = t.dataset.field === 'sizeW' ? Number(t.value) : cur.w;
      const h = t.dataset.field === 'sizeH' ? Number(t.value) : cur.h;
      onAction('property', { id: getState().selectedId, field: 'size', val: { w: Number.isFinite(w) ? w : cur.w, h: Number.isFinite(h) ? h : cur.h } });
      return;
    }
    // 属性控件把 data-field 写在自身（不是带 data-act 的祖先）上，
    // 早先误用 closest('[data-act]') 会让 select / checkbox / color / range 的
    // change 全部落空（分组下拉、图层下拉、显隐勾选因此不生效）。
    if (t.dataset?.act === 'plane') { onAction('plane-dist', Number(t.value)); return; }
    if (t.dataset?.act === 'file') {
      const f = t.files?.[0];
      if (f) { const r = new FileReader(); r.onload = () => onAction('import-text', r.result); r.readAsText(f); }
      return;
    }
    // 本地视频文件：浏览器 object URL 直接交给三维屏 / 贴面 / 展板里的 <video>
    if (t.dataset?.act === 'local-video-file') {
      const f = t.files?.[0];
      if (f) {
        if (localObjectUrl) { try { URL.revokeObjectURL(localObjectUrl); } catch (_) { /* noop */ } }
        localObjectUrl = URL.createObjectURL(f);
        onAction('local-video-file', { id: t.dataset.v, name: f.name, url: localObjectUrl });
      }
      return;
    }
    if (t.dataset?.field) {
      const id = getState().selectedId;
      const field = t.dataset.field;
      // number / range 必须转成数值：直接写字符串会让带宽 / 速度变成 "2"，
      // 虽然几何换算里 Number() 能兜住，但导出的数据模型与断言都会不一致。
      let val;
      if (t.type === 'checkbox') val = t.checked;
      else if (t.type === 'color') val = t.value;
      else if (t.type === 'range' || t.type === 'number') {
        val = Number(t.value);
        if (!Number.isFinite(val)) return;        // 输入框清空时不写入 NaN
      } else val = t.value;
      onAction('property', { id, field, val });
    }
  });

  root.addEventListener('input', e => {
    const t = e.target;
    if (t.dataset?.act === 'plane') {
      $('[data-role="plane-val"]').textContent = Number(t.value).toFixed(1) + 'm';
    }
    if (t.dataset?.act === 'search') { keyword = t.value.trim().toLowerCase(); renderList(); }
    if (t.dataset?.mediaField) {
      // 媒体字段连续输入：quiet 更新，不重建 DOM
      onAction('media', {
        id: getState().selectedId,
        type: t.dataset.mediaField === 'type' ? t.value : undefined,
        url: t.dataset.mediaField === 'url' ? t.value : undefined,
        caption: t.dataset.mediaField === 'caption' ? t.value : undefined
      }, true);
      return;
    }
    if (t.dataset.field === 'sizeW' || t.dataset.field === 'sizeH') {
      const a = store.get(getState().selectedId);
      const cur = a?.style.size || { w: 1.8, h: 1.35 };
      const w = t.dataset.field === 'sizeW' ? Number(t.value) : cur.w;
      const h = t.dataset.field === 'sizeH' ? Number(t.value) : cur.h;
      onAction('property', { id: getState().selectedId, field: 'size', val: { w: Number.isFinite(w) ? w : cur.w, h: Number.isFinite(h) ? h : cur.h } }, true);
      return;
    }
    if (t.dataset?.field && ['title', 'body', 'link'].includes(t.dataset.field)) {
      onAction('property', { id: getState().selectedId, field: t.dataset.field, val: t.value }, true);
      return;
    }
    // 动线样式 / 实体屏朝向 / 贴花投射参数：输入时实时预览，不必等失焦
    if (['bandWidth', 'flowSpeed', 'yaw', 'pitch', 'decalOpacity', 'decalEdge', 'decalDepth',
      // 透视贴花视锥体参数：FOV / 宽高比 / 远距 / 近距
      'projFov', 'projAspect', 'projFar', 'projNear'].includes(t.dataset?.field)) {
      const f = t.dataset.field, v = Number(t.value);
      const positive = f === 'bandWidth' || f === 'flowSpeed';
      const min = { decalOpacity: 0.2, decalEdge: 0, decalDepth: 0.1,
        projFov: 10, projAspect: 0.2, projFar: 0.3, projNear: 0.02 }[f] ?? 0;
      if (Number.isFinite(v) && v >= min && (!positive || v > 0))
        onAction('property', { id: getState().selectedId, field: f, val: v }, true);
      return;
    }
    if (t.dataset?.field === 'flowArrow') {
      onAction('property', { id: getState().selectedId, field: 'flowArrow', val: t.checked }, true);
      return;
    }
    // 贴花诊断开关：背面剔除（布尔）
    if (t.dataset?.field === 'decalCull') {
      onAction('property', { id: getState().selectedId, field: 'decalCull', val: t.checked }, true);
      return;
    }
    // 贴花诊断开关：归一化基准 / 深度采样口径（数值下拉）
    if (t.dataset?.field === 'decalBoxScale' || t.dataset?.field === 'decalDepthMode') {
      const v = Number(t.value);
      if (Number.isFinite(v)) onAction('property', { id: getState().selectedId, field: t.dataset.field, val: v }, true);
      return;
    }
  });

  function renderLayers() {
    const counts = {};
    store.list().forEach(a => { counts[a.layerId] = (counts[a.layerId] || 0) + 1; });
    setHTML(layersEl, store.layers().map(l => `
      <div class="ed-layer-row ${l.visible ? '' : 'ed-off'}">
        <button data-act="layer-toggle" data-v="${l.id}" title="显示 / 隐藏">${l.visible ? '◉' : '○'}</button>
        <i style="background:${esc(l.color)}"></i>
        <span>${esc(l.name)}</span><small>${counts[l.id] || 0}</small>
      </div>`).join(''));
  }

  /** 分组管理行：改名 / 设为当前组 / 折叠 / 整组显隐 / 定位 / 解散 */
  function renderGroups() {
    const active = getState().activeGroupId;
    const counts = {};
    store.list().forEach(a => {
      const k = a.groupId || DEFAULT_GROUP_ID;
      counts[k] = (counts[k] || 0) + 1;
    });
    setHTML(groupsEl, store.groups().map(g => `
      <div class="ed-group-row ${g.visible === false ? 'ed-off' : ''} ${g.id === active ? 'ed-group-active' : ''}"
           data-act="group-activate" data-v="${g.id}" title="设为当前分组（之后绘制的标注归入该组）">
        <button class="ed-ib" data-act="group-fold" data-v="${g.id}" title="展开 / 折叠">${g.collapsed ? '▸' : '▾'}</button>
        <i style="background:${esc(g.color)}"></i>
        <input class="ed-group-name" data-role="group-name" data-v="${g.id}" value="${esc(g.name)}" title="直接改名，回车或失焦提交">
        <small>${counts[g.id] || 0}</small>
        <button class="ed-ib" data-act="group-put" data-v="${g.id}" title="把当前选中的标注归入此组">↳</button>
        <button class="ed-ib" data-act="group-fly" data-v="${g.id}" title="飞到该组标注中心">◎</button>
        <button class="ed-ib" data-act="group-vis" data-v="${g.id}" title="显示 / 隐藏整组">${g.visible === false ? '🚫' : '👁'}</button>
        ${g.id === DEFAULT_GROUP_ID ? '' : `<button class="ed-ib ed-ib-del" data-act="group-del" data-v="${g.id}" title="解散分组（标注移回默认分组，不删除标注）">✕</button>`}
      </div>`).join(''));
  }

  function rowHtml(a, selIds) {
    // 多选：被选中的行高亮，不再「锁定」其余行（选中不再锁死其它对象）。
    const isSel = Array.isArray(selIds) && selIds.includes(a.id);
    const lk = a.locked ? ' ed-locked' : '';
    const dis = a.locked ? ' disabled' : '';
    return `
      <div class="ed-list-row ${isSel ? 'ed-active' : ''} ${a.visible ? '' : 'ed-hidden'}${lk}" data-act="item" data-v="${a.id}" title="单击选中编辑${isSel ? '（已选中，Shift+单击可加选/减选）' : ''}${a.locked ? '（已锁定，禁止编辑）' : ''}">
        <i style="color:${esc(a.style.color)}">${KINDS[a.kind].icon}</i>
        <span>${esc(a.title)}</span>${isSel ? '<em class="ed-lock-tag">✓</em>' : ''}${a.locked ? '<em class="ed-lock-tag">🔒</em>' : ''}<small>${KINDS[a.kind].label}</small>
        <span class="ed-list-btns">
          <button class="ed-ib" data-act="item-vis" data-v="${a.id}" title="${a.visible ? '隐藏' : '显示'}"${dis}>${a.visible ? '👁' : '🚫'}</button>
          <button class="ed-ib ed-ib-del" data-act="item-del" data-v="${a.id}" title="删除"${dis}>✕</button>
        </span>
      </div>`;
  }

  /** 标注列表按分组折叠展示；签名变了才重建，保证滚动位置 & hover 状态 */
  function renderList() {
    const scene = getState().scene;
    const selIds = getState().selectedIds;
    const items = store.list(scene).filter(a =>
      !keyword || (a.title + ' ' + a.body).toLowerCase().includes(keyword));
    const groups = store.groups();
    const gid = a => a.groupId || DEFAULT_GROUP_ID;
    const blocks = groups.map(g => ({
      id: g.id, name: g.name, color: g.color,
      collapsed: !!g.collapsed, visible: g.visible !== false,
      items: items.filter(a => gid(a) === g.id)
    })).filter(b => !keyword || b.items.length);
    // 引用了已删除分组的标注：兜底显示，避免「标注凭空消失」
    const orphan = items.filter(a => !groups.some(g => g.id === gid(a)));
    if (orphan.length) blocks.unshift({ id: '__none__', name: '未分组', color: '#64748b',
      collapsed: false, visible: true, items: orphan });

    // 组名 / 折叠 / 显隐 / 组内标注状态都进签名；选中态也进签名，确保选中高亮能触发重渲染
    const sig = `sel=${JSON.stringify(selIds)}|` + blocks.map(b =>
      `${b.id}|${b.name}|${b.collapsed}|${b.visible}|` +
      b.items.map(a => `${a.id}|${a.title}|${a.kind}|${a.style.color}|${a.visible}|${a.locked ? 1 : 0}|${gid(a)}`).join(',')
    ).join('~');
    if (listEl.__sig !== sig) {
      listEl.__sig = sig;
      listEl.innerHTML = blocks.length ? blocks.map(b => `
        <div class="ed-group-hd ${b.visible ? '' : 'ed-off'}" data-act="group-fold" data-v="${b.id}"
             title="展开 / 折叠该分组" style="--gc:${esc(b.color)}">
          <span>${b.collapsed ? '▸' : '▾'}</span><i></i><b>${esc(b.name)}</b>
          <small>${b.items.length}</small>${b.visible ? '' : '<em>已隐藏</em>'}
        </div>` + (b.collapsed ? '' : b.items.map(a => rowHtml(a, selIds)).join(''))
      ).join('') : '<div class="ed-empty">暂无标注，选工具后在场景中点击</div>';
    }
    $('[data-role="count"]').textContent = items.length;
  }

  function renderTours() {
    setHTML(toursEl, store.tours().map(t => `
      <div class="ed-tour-row"><button data-act="tour-play" data-v="${esc(t.name)}">▶</button>
      <span>${esc(t.name)}</span><small>${t.stops.length} 站</small></div>`).join('')
      || '<div class="ed-empty">把机位存为站点可生成导览</div>');
  }

  // ------------------------------------------------------------ 属性面板
  function propsHtml(a) {
    const c = a.style.color;
    const media = (a.media || [])[0] || null;
    const mType = media?.type || 'none';
    const mUrl = media?.url || '';
    const mCap = media?.caption || '';
    const size = a.style.size || { w: 1.8, h: 1.35 };
    // 本地视频：工程内测试片源 + 任意本地文件（object URL）。
    // 三维屏 / 贴面矩形恒为视频投射面，展板在内容类型=视频时也可用。
    const localVideoBlock = (a.kind === 'screen' || a.kind === 'decal' ||
      (a.kind === 'board' && mType === 'video')) ? `
      <div class="ed-sec-hd"><b>本地视频</b><small>零外链 · 大文件分段播放</small></div>
      <div class="ed-local-video">
        <button data-act="local-video" data-v="${esc(a.id)}" title="播放工程内 web/media/test.mp4">▶ 使用工程内测试视频</button>
        <label class="ed-file-btn" title="从本机选一个视频文件，直接投到三维里的屏 / 贴面上">选择本地视频文件
          <input type="file" data-act="local-video-file" data-v="${esc(a.id)}" accept="video/*,.mp4,.webm,.m4v">
        </label>
      </div>
      <div class="ed-prop-hint">测试片源来自 <code>viewer_stream/www/media/test.mp4</code>，已放到 <code>web/media/test.mp4</code>，服务端按 1MB 分段返回 Range 请求，边下边播。选择本机文件用 object URL 播放（刷新后需重新选择）。</div>` : '';
    const boardBlock = a.kind === 'board' ? `
      <div class="ed-sec-hd"><b>展板内容</b><small>文字 / 图片 / 网页 / 视频</small></div>
      <label>内容类型<select data-media-field="type">${MEDIA_TYPES.map(m =>
        `<option value="${m.id}" ${m.id === mType ? 'selected' : ''}>${m.label}</option>`).join('')}</select></label>
      <label>内容地址<input data-media-field="url" value="${esc(mUrl)}" placeholder="图片 / 网页 / 视频 URL"></label>
      <label>内容说明<input data-media-field="caption" value="${esc(mCap)}" placeholder="显示在展板上的注解"></label>
      <div class="ed-prop-hint">内容直接内嵌在三维展板里，不会弹出独立页面：网页以 iframe 嵌入（sandbox 隔离，选中展板后可交互），视频静音循环；拖拽四角缩放、拖拽面板移动。</div>
      <div class="ed-sec-hd"><b>展板尺寸</b><small>米（世界单位）</small></div>
      <label>宽度<input type="number" min="0.3" max="12" step="0.1" data-field="sizeW" value="${esc(size.w)}"></label>
      <label>高度<input type="number" min="0.25" max="12" step="0.1" data-field="sizeH" value="${esc(size.h)}"></label>
      <div class="ed-prop-hint">编辑模式下可拖动展板底部的<b>发光锚点</b>：会自动吸附到最近的碰撞 MESH 表面，导引线随之拉长 / 转向。${a.style.leadTo ? '当前已设置独立锚点。' : '当前锚点在展板脚下。'}</div>` : '';
    const screenBlock = a.kind === 'screen' ? `
      <div class="ed-sec-hd"><b>三维实体屏</b><small>固定世界朝向 · 视频播放</small></div>
      <label>视频地址<input data-media-field="url" value="${esc(mUrl)}" placeholder="留空播放内置演示画面；支持 mp4 / webm URL"></label>
      <div class="ed-prop-hint">这是固定在世界空间里的一块显示屏：尺寸（米）与朝向由数据决定，<b>不随视角自动缩放或转正</b>；相机绕到侧面会看到透视收窄，走到背面显示金属背板。<b>选中后</b>拖动屏体可在相机平面内左右 / 上下移动，拖动六个圆手柄可沿上 / 下 / 左 / 右 / 前 / 后六个方向精确移动；<b>屏体底部中心还有一枚旋转锚点</b>，左右拖 = 转向（yaw）、上下拖 = 俯仰（pitch），只改朝向不动位置；单击（微抖 ≤6px）只选中，<b>不会改变位置</b>。填入视频 URL 后由屏内 &lt;video&gt; 直接循环播放。</div>
      <div class="ed-sec-hd"><b>屏体尺寸 / 朝向</b><small>米 / 度</small></div>
      <label>宽度（米）<input type="number" min="0.3" max="20" step="0.1" data-field="sizeW" value="${esc(size.w)}"></label>
      <label>高度（米）<input type="number" min="0.2" max="20" step="0.1" data-field="sizeH" value="${esc(size.h)}"></label>
      <label>水平朝向 yaw°<input type="number" min="-180" max="180" step="1" data-field="yaw" value="${esc(a.style.yaw ?? 0)}"></label>
      <label>俯仰 pitch°<input type="number" min="-80" max="80" step="1" data-field="pitch" value="${esc(a.style.pitch ?? 0)}"></label>
      <label class="ed-chk"><input type="checkbox" data-field="muted" ${a.style.muted !== false ? 'checked' : ''}> 静音播放</label>
      <label class="ed-chk"><input type="checkbox" data-field="loop" ${a.style.loop !== false ? 'checked' : ''}> 循环播放</label>` : '';
    const flowBlock = a.kind === 'line' ? `
      <div class="ed-sec-hd"><b>动线样式</b><small>贴合模型 · 等宽箭头链</small></div>
      <label>带宽（米）<input type="number" min="0.1" max="4" step="0.05" data-field="bandWidth" value="${esc(a.style.bandWidth ?? 0.7)}"></label>
      <label>箭头速度<input type="range" min="0.2" max="3" step="0.1" data-field="flowSpeed" value="${esc(a.style.flowSpeed ?? 1.4)}"></label>
      <label class="ed-chk"><input type="checkbox" data-field="flowArrow" ${a.style.flowArrow !== false ? 'checked' : ''}> 箭头指向（关闭则为等宽条带）</label>
      <div class="ed-prop-hint">中心线按 0.45 m 等距重采样并逐点吸附到碰撞 MESH 表面，<b>贴合模型起伏、不悬空</b>；动线本身是一串<b>带箭头尖的等宽多边形</b>（不是底带里塞小箭头），宽度在屏幕上全程一致，箭头整串沿路径流动。绘制中即实时预览箭头链，双击结束后回到「选择」。</div>` : '';
    const proj = a.projector;
    /* 投影机两种工作模式：ortho = 正交 OBB（贴面矩形），persp = 透视视锥体（透视贴花）。
       二者数据同构（position / quaternion / half），只有参数语义不同，
       所以面板只在「参数区」分叉，其余（视频源 / 不透明度 / 诊断）完全共用。 */
    const isPersp = !!(proj && proj.mode === 'persp');
    const obbStatus = projectorStatusText(proj);
    const kindLabel = isPersp ? '透视贴花' : KINDS[a.kind].label;
    const decalProjBlock = isPersp ? `
      <div class="ed-sec-hd"><b>透视贴花 · 视锥体投射</b><small>透视投影 · 光心布设</small></div>
      <label>投射视频地址<input data-media-field="url" value="${esc(mUrl)}" placeholder="留空播放内置演示画面；支持 mp4 / webm URL"></label>
      <div class="ed-prop-hint">两次点击布设视锥体：<b>第 1 点 = 光心</b>，<b>第 2 点 = 光轴指向</b>。贴花以<b>透视投影</b>从光心投射到场景表面（近大远小），深度预通道（Pass1）同样由透视相机渲染。拖动视锥中心手柄平移光心，±X / ±Y 手柄改视场，+Z 手柄改远距。</div>
      <div class="ed-prop-status" data-role="decal-obb-status">${obbStatus}</div>
      <div class="ed-sec-hd"><b>视锥参数</b><small>FOV / 宽高比 / 远近</small></div>
      <label>竖直 FOV（度）<input type="range" min="10" max="120" step="1" data-field="projFov" value="${esc(Number(proj.fov ?? 45).toFixed(0))}"></label>
      <label>宽高比<input type="number" min="0.2" max="6" step="0.05" data-field="projAspect" value="${esc(Number(proj.aspect ?? 16 / 9).toFixed(2))}"></label>
      <label>远距（米）<input type="number" min="0.3" max="120" step="0.1" data-field="projFar" value="${esc(Number(proj.far ?? proj.half[2]).toFixed(2))}"></label>
      <label>近距（米）<input type="number" min="0.02" max="20" step="0.02" data-field="projNear" value="${esc(Number(proj.near ?? 0.05).toFixed(2))}"></label>
      <div class="ed-prop-hint">FOV 与远距共同决定远平面尺寸（半高 = 远距 × tan(FOV/2)），任何一项改动都会重算视锥体，线框与投射立即同步；近距只裁掉光心附近像素。</div>
      <div class="ed-sec-hd"><b>投射参数</b><small>不透明度 / 边缘</small></div>
      <label>不透明度<input type="range" min="0.2" max="1" step="0.05" data-field="decalOpacity" value="${esc(a.style.decalOpacity ?? 0.9)}"></label>
      <label>边缘软过渡<input type="range" min="0" max="0.5" step="0.01" data-field="decalEdge" value="${esc(a.style.decalEdge ?? 0.12)}"></label>` : `
      <div class="ed-sec-hd"><b>贴面矩形 · 投影式延迟贴花</b><small>GPU 逐像素贴合表面</small></div>
      <label>投射视频地址<input data-media-field="url" value="${esc(mUrl)}" placeholder="留空播放内置演示画面；支持 mp4 / webm URL"></label>
      <div class="ed-prop-hint">屏幕框选两对角后，引擎按当前画面逐像素读取深度、反投影到世界坐标，重建「投影机 OBB」。贴花在 GPU 后处理阶段逐像素投射到<b>真实渲染表面</b>——像素级贴合、不重构网格。选中后拖动 OBB 中心可平移、拖动六向手柄可缩放。</div>
      <div class="ed-prop-status" data-role="decal-obb-status">${obbStatus}</div>
      <div class="ed-prop-btns"><button data-act="decal-rebuild" data-v="${esc(a.id)}">↻ 按当前视角重建投影机</button></div>
      <div class="ed-sec-hd"><b>投射参数</b><small>不透明度 / 边缘 / 深度</small></div>
      <label>不透明度<input type="range" min="0.2" max="1" step="0.05" data-field="decalOpacity" value="${esc(a.style.decalOpacity ?? 0.9)}"></label>
      <label>边缘软过渡<input type="range" min="0" max="0.5" step="0.01" data-field="decalEdge" value="${esc(a.style.decalEdge ?? 0.12)}"></label>
      <label>投射深度（米）<input type="number" min="0.1" max="4" step="0.05" data-field="decalDepth" value="${esc(a.style.decalDepth ?? 0.5)}"></label>
      <div class="ed-prop-hint">「投射深度」只改投影机盒厚（沿法向的容纳范围），不重采表面；调大可容纳更厚的模型起伏，调小让贴花贴得更紧。</div>`;
    const decalBlock = a.kind === 'decal' ? `${decalProjBlock}
      <div class="ed-sec-hd"><b>投射诊断</b><small>归一化 / 深度口径 / 分辨率</small></div>
      <label class="ed-chk" title="按深度差分重建表面法向剔除背面。掠射角法向仍有噪声，开启会在贴花上打出斑驳空洞，故默认关闭"><input type="checkbox" data-field="decalCull" ${a.style.decalCull ? 'checked' : ''}> 背面剔除</label>
      <label>归一化基准<select data-field="decalBoxScale">
        <option value="1" ${Number(a.style.decalBoxScale ?? 1) === 1 ? 'selected' : ''}>1.0（整框命中）</option>
        <option value="0.5" ${Number(a.style.decalBoxScale ?? 1) === 0.5 ? 'selected' : ''}>0.5（旧行为·仅内侧 1/4）</option>
      </select></label>
      <label>深度采样口径<select data-field="decalDepthMode">
        <option value="1" ${Number(a.style.decalDepthMode ?? 1) === 1 ? 'selected' : ''}>引擎同族（5×5 邻域 30% 分位）</option>
        <option value="0" ${Number(a.style.decalDepthMode ?? 1) === 0 ? 'selected' : ''}>单 texel 中位（性能兜底）</option>
      </select></label>
      <div class="ed-prop-status" data-role="decal-diag-status">贴花诊断：等待运行时数据…</div>
      <div class="ed-prop-hint">「归一化基准」=1 表示投影机边界即贴花边界（整框命中）；=0.5 复现历史行为（每轴只命中内侧 1/4，表现为框线清楚、框内只有中间一小块）。「深度采样口径」决定如何从引擎深度快照取值：引擎同族口径与引擎拾取结果一致，推荐保持默认。</div>` : '';
    return `
      <div class="ed-sec-hd"><b>属性</b><small>${kindLabel}</small></div>
      ${pickViewHtml(a)}
      <label>标题<input data-field="title" value="${esc(a.title)}"></label>
      <label>说明<textarea data-field="body" rows="4">${esc(a.body)}</textarea></label>
      ${boardBlock}
      ${screenBlock}
      ${flowBlock}
      ${decalBlock}
      ${localVideoBlock}
      <label>颜色<input type="color" data-field="color" value="${esc(c)}"></label>
      <label>不透明度<input type="range" min="0.2" max="1" step="0.05" data-field="opacity" value="${a.style.opacity}"></label>
      <label>图层<select data-field="layerId">${store.layers().map(l =>
        `<option value="${l.id}" ${l.id === a.layerId ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
      <label>分组<select data-field="groupId">${store.groups().map(g =>
        `<option value="${g.id}" ${g.id === (a.groupId || DEFAULT_GROUP_ID) ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label>
      <label>链接<input data-field="link" value="${esc(a.link)}" placeholder="https://"></label>
      <label class="ed-chk"><input type="checkbox" data-field="visible" ${a.visible ? 'checked' : ''}> 显示</label>
      <label class="ed-chk" title="开启后该标注被前方模型挡住时自动隐藏；关闭则始终置顶可见"><input type="checkbox" data-field="depthTest" ${a.depthTest ? 'checked' : ''}> 开启深度检测</label>
      <label class="ed-chk"><input type="checkbox" data-field="labelAlways" ${a.style.labelAlways ? 'checked' : ''}> 始终显示标签</label>
      <label class="ed-chk"><input type="checkbox" data-field="locked" ${a.locked ? 'checked' : ''}> 锁定</label>
      <div class="ed-prop-hint">深度检测按<b>单个注记</b>生效，<b>新标注默认开启</b>：开启 = 被三维模型遮挡时隐藏；关闭 = 始终置顶显示。与工具栏「深度 开/关」不同，后者只决定绘制时落点是否贴合表面。</div>
      <div class="ed-coord">${a.points.map((p, i) => `<code>P${i + 1} ${p.map(n => n.toFixed(2)).join(', ')}</code>`).join('')}</div>
      <div class="ed-prop-btns">
        <button data-act="saveview" data-v="${a.id}">存当前机位</button>
        <button data-act="fly" data-v="${a.id}">飞到此处</button>
        <button data-act="duplicate" data-v="${a.id}" title="复制并偏移 0.5m (Ctrl+D)">复制</button>
        <button data-act="bring-front" data-v="${a.id}" title="置于最前（覆盖其他标注）">置顶</button>
        <button data-act="send-back" data-v="${a.id}" title="置于最后（被其他标注覆盖）">置底</button>
        ${a.kind === 'board' ? `<button data-act="anchor-reset" data-v="${a.id}">复位引线锚点</button>` : ''}
        <button data-act="delete" data-v="${a.id}" class="ed-danger">删除</button>
      </div>`;
  }

  /** 投影机状态行文案（ortho = OBB 盒尺寸，persp = 视锥体参数）。
   *  首屏渲染与 syncProps 共用同一口径，避免拖拽 / 改参后文案退回 OBB。 */
  function projectorStatusText(proj) {
    if (!proj) return '尚未生成投影机（等待相机 / 深度就绪，或点下方按钮重建）';
    if (proj.mode === 'persp') {
      return `透视视锥体：FOV ${Number(proj.fov ?? 45).toFixed(0)}° · ` +
        `宽高比 ${Number(proj.aspect ?? 16 / 9).toFixed(2)} · ` +
        `近 ${Number(proj.near ?? 0).toFixed(2)} m / 远 ${Number(proj.far ?? proj.half[2]).toFixed(2)} m（光心布设）`;
    }
    return `投影机 OBB：${(proj.half[0] * 2).toFixed(2)} m × ${(proj.half[1] * 2).toFixed(2)} m × ` +
      `${(proj.half[2] * 2).toFixed(2)} m（深度反算表面）`;
  }

  /** 只同步控件数值，不重建 DOM —— 输入时不失焦 */
  function syncProps(a) {
    const media = (a.media || [])[0] || null;
    propEl.querySelectorAll('[data-field]').forEach(el => {
      if (document.activeElement === el) return;     // 正在编辑的控件不覆盖
      const f = el.dataset.field;
      if (f === 'color') { if (el.value !== a.style.color) el.value = a.style.color; }
      else if (f === 'opacity') { const v = String(a.style.opacity); if (el.value !== v) el.value = v; }
      else if (f === 'labelAlways') { el.checked = !!a.style.labelAlways; }
      else if (f === 'visible') { el.checked = !!a.visible; }
      else if (f === 'depthTest') { el.checked = !!a.depthTest; }
      else if (f === 'locked') { el.checked = !!a.locked; }
      else if (f === 'layerId') { if (el.value !== a.layerId) el.value = a.layerId; }
      else if (f === 'groupId') { const v = a.groupId || DEFAULT_GROUP_ID; if (el.value !== v) el.value = v; }
      else if (f === 'title') { if (el.value !== a.title) el.value = a.title; }
      else if (f === 'body') { if (el.value !== (a.body || '')) el.value = a.body || ''; }
      else if (f === 'link') { if (el.value !== (a.link || '')) el.value = a.link || ''; }
      else if (f === 'sizeW') { const v = String(a.style.size?.w ?? 1.8); if (el.value !== v) el.value = v; }
      else if (f === 'sizeH') { const v = String(a.style.size?.h ?? 1.35); if (el.value !== v) el.value = v; }
      else if (f === 'bandWidth') { const v = String(a.style.bandWidth ?? 0.7); if (el.value !== v) el.value = v; }
      else if (f === 'flowSpeed') { const v = String(a.style.flowSpeed ?? 1.4); if (el.value !== v) el.value = v; }
      else if (f === 'flowArrow') { el.checked = a.style.flowArrow !== false; }
      else if (f === 'yaw') { const v = String(a.style.yaw ?? 0); if (el.value !== v) el.value = v; }
      else if (f === 'pitch') { const v = String(a.style.pitch ?? 0); if (el.value !== v) el.value = v; }
      else if (f === 'muted') { el.checked = a.style.muted !== false; }
      else if (f === 'loop') { el.checked = a.style.loop !== false; }
      else if (f === 'decalOpacity') { const v = String(a.style.decalOpacity ?? 0.9); if (el.value !== v) el.value = v; }
      else if (f === 'decalEdge') { const v = String(a.style.decalEdge ?? 0.12); if (el.value !== v) el.value = v; }
      else if (f === 'decalDepth') { const v = String(a.style.decalDepth ?? 0.5); if (el.value !== v) el.value = v; }
      else if (f === 'decalCull') { el.checked = a.style.decalCull === true; }
      else if (f === 'decalBoxScale') { const v = String(a.style.decalBoxScale ?? 1); if (el.value !== v) el.value = v; }
      else if (f === 'decalDepthMode') { const v = String(a.style.decalDepthMode ?? 1); if (el.value !== v) el.value = v; }
    });
    // 贴花 / 视锥体状态行随拖拽 / 重建 / 改参实时刷新，不重建整块属性面板
    const obbStatus = propEl.querySelector('[data-role="decal-obb-status"]');
    if (obbStatus && a.projector) {
      const txt = projectorStatusText(a.projector);
      if (obbStatus.textContent !== txt) obbStatus.textContent = txt;
    }
    // 贴花诊断状态行：只读展示渲染层运行时参数（不重建面板，避免打断输入）
    const diagEl = propEl.querySelector('[data-role="decal-diag-status"]');
    if (diagEl) {
      let d = null;
      try { d = typeof getDecalDiag === 'function' ? getDecalDiag() : null; } catch (_) { d = null; }
      if (!d) {
        diagEl.textContent = '贴花诊断：渲染层未就绪（贴花投射器不可用或已降级）';
      } else if (d.degraded) {
        diagEl.textContent = `贴花诊断：已降级（GPU 错误 ${d.gpuErrors} 次），贴花画面已隐藏`;
      } else {
        const ps = d.pickSize ? `${d.pickSize[0]}×${d.pickSize[1]}` : '未知';
        const scale = d.pickSize && d.dpr ? (d.pickSize[0] / Math.max(1, d.dpr)) : 0;
        diagEl.textContent =
          `贴花诊断：深度快照 ${d.pickReady ? '就绪' : '未就绪'}（${ps} 设备像素，DPR ${d.dpr}，屏幕≈${Math.round(scale)}px）｜` +
          `归一化基准 ${Number(d.boxScale).toFixed(2)}｜深度口径 ${Number(d.depthMode) === 1 ? '引擎同族' : '单 texel 中位'}｜` +
          `背面剔除 ${d.cull ? '开' : '关'}｜实例 ${d.visible}/${d.instances}`;
      }
    }
    propEl.querySelectorAll('[data-media-field]').forEach(el => {
      if (document.activeElement === el) return;
      const f = el.dataset.mediaField;
      if (f === 'type') { const v = media?.type || 'none'; if (el.value !== v) el.value = v; }
      else if (f === 'url') { const v = media?.url || ''; if (el.value !== v) el.value = v; }
      else if (f === 'caption') { const v = media?.caption || ''; if (el.value !== v) el.value = v; }
    });
    // 内容预览：只改文本 / 按媒体签名替换，不重建输入框，焦点全程不受影响
    const view = propEl.querySelector('[data-role="pick-view"]');
    if (view) {
      const title = view.querySelector('[data-role="pick-title"]');
      const body = view.querySelector('[data-role="pick-body"]');
      if (title && title.textContent !== (a.title || '')) title.textContent = a.title || '';
      if (body && body.textContent !== (a.body || '（暂无正文）')) body.textContent = a.body || '（暂无正文）';
      const link = view.querySelector('[data-role="pick-link"]');
      if (link) {
        if (a.link) { link.removeAttribute('hidden'); link.href = a.link; link.textContent = a.link + ' ↗'; }
        else { link.setAttribute('hidden', ''); link.removeAttribute('href'); link.textContent = ''; }
      }
      // 用户正在编辑媒体 URL 时不重建 iframe（避免每敲一个字就重载闪烁）
      if (!document.activeElement?.dataset?.mediaField) {
        const box = view.querySelector('[data-role="pick-media"]');
        const sig = media ? `${media.type}|${media.url}|${media.caption || ''}` : '';
        if (box && box.dataset.sig !== sig) { box.dataset.sig = sig; box.innerHTML = pickMediaHtml(media, a); }
      }
    }
  }

  function renderProps() {
    const a = store.get(getState().selectedId);
    if (!a) {
      if (propsFor !== null) {
        propEl.innerHTML = `<div class="ed-empty ed-prop-empty">未选中标注<br><small>点场景中的标注，或左侧列表</small></div>`;
        propEl.__html = undefined;
        propsFor = null; propsKind = null;
      }
      return;
    }
    const groupSig = store.groups().map(g => g.id + ':' + g.name).join('|');
    const anchorSig = a.kind === 'board' ? (a.style.leadTo ? 'anchored' : 'foot') : '-';
    const surfaceSig = a.kind === 'decal' ? (a.projector ? 'ok' : 'no') : '-';
    if (propsFor !== a.id || propsKind !== a.kind || propsGroupSig !== groupSig ||
        propsAnchorSig !== anchorSig || propsSurfaceSig !== surfaceSig) {
      // 切换标注 / 分组结构变化：重建结构，并把焦点交给标题输入框 ——
      // 用户点完左侧列表就能直接在右侧改字，不用再点一次输入框。
      propEl.innerHTML = propsHtml(a);
      propEl.__html = undefined;
      propsFor = a.id; propsKind = a.kind; propsGroupSig = groupSig;
      propsAnchorSig = anchorSig; propsSurfaceSig = surfaceSig;
      const first = propEl.querySelector('[data-field="title"]');
      if (first) {
        first.focus({ preventScroll: true });
        const len = String(a.title || '').length;
        try { first.setSelectionRange(len, len); } catch { /* 部分输入类型不支持 */ }
      }
      return;
    }
    syncProps(a);
  }

  const SRC_LABEL = { mesh: 'MESH', depth: '深度图', ground: '地面', wall: '墙面',
    plane: '绘制平面', free: '悬浮', fallback: '悬浮' };

  /** 右键标注弹出的轻量上下文菜单（Figma / Miro 式）：复制 / 飞到 / 置顶 / 置底 / 删除。
   *  挂在 body 上（脱离 .ed-ui，避免被 stage 的 contextmenu 捕获拦截），点击外部自动关闭。 */
  function contextMenu(x, y, id) {
    const a = store.get(id);
    if (!a) return;
    const m = document.createElement('div');
    m.className = 'ed-ctx';
    const items = [
      { label: '复制 (Ctrl+D)', act: 'duplicate' },
      { label: '飞到此处', act: 'fly' },
      { label: '置顶', act: 'bring-front' },
      { label: '置底', act: 'send-back' },
      { label: '删除 (Del)', act: 'delete' },
    ];
    m.innerHTML = items.map(it =>
      `<button data-act="${it.act}" data-v="${id}">${it.label}</button>`).join('');
    m.style.left = Math.min(x, window.innerWidth - 160) + 'px';
    m.style.top = Math.min(y, window.innerHeight - 180) + 'px';
    document.body.appendChild(m);
    const close = () => {
      m.remove();
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('blur', close);
    };
    const onDown = (ev) => { if (!m.contains(ev.target)) close(); };
    m.addEventListener('click', ev => {
      const b = ev.target.closest('[data-act]');
      if (b) { onAction(b.dataset.act, b.dataset.v); close(); }
    });
    setTimeout(() => {
      window.addEventListener('pointerdown', onDown, true);
      window.addEventListener('blur', close);
    }, 0);
  }

  function renderTools(state) {
    root.querySelectorAll('[data-act="tool"]').forEach(b =>
      b.classList.toggle('ed-on', b.dataset.v === state.tool));
    const depthBtn = root.querySelector('[data-act="depth"]');
    depthBtn.textContent = state.depthOn ? '深度 开' : '深度 关';
    depthBtn.classList.toggle('ed-on', !!state.depthOn);
    depthBtn.classList.toggle('ed-depth-off', !state.depthOn);
    const meshBtn = root.querySelector('[data-act="mesh"]');
    if (meshBtn) {
      meshBtn.textContent = state.meshVisible ? '碰撞体 开' : '碰撞体 关';
      meshBtn.classList.toggle('ed-on', !!state.meshVisible);
      meshBtn.classList.toggle('ed-mesh-off', !state.meshVisible);
      meshBtn.title = state.meshOverlayReady
        ? '全局显示 / 隐藏碰撞体 MESH 线框（Shift+C）'
        : '碰撞体尚未就绪，点击会在 MESH 载入后自动生效（Shift+C）';
    }
    root.querySelector('.ed-plane').classList.toggle('ed-plane-off', !!state.depthOn);
    const plane = root.querySelector('[data-act="plane"]');
    if (document.activeElement !== plane) plane.value = String(state.planeDistance);
    $('[data-role="plane-val"]').textContent = Number(state.planeDistance).toFixed(1) + 'm';
    root.querySelector('[data-act="preview"]').textContent = state.preview ? '返回编辑' : '预览';
    root.classList.toggle('ed-is-preview', !!state.preview);
    // 预览态默认收起左右栏；但一旦拾取了标注，右侧属性面板以「只读内容预览」重新出现
    root.classList.toggle('ed-has-pick', !!state.preview && !!state.selectedId);

    const mesh = state.meshStatus === 'ready'
      ? `MESH ${Number(state.meshTris || 0).toLocaleString()} 面`
      : state.meshStatus === 'loading' ? 'MESH 载入中' : 'MESH 不可用';
    const depth = state.depthReady ? '深度图就绪' : '深度图回退';
    const cam = state.cameraMode === 'walk' ? '贴地漫游' : '自由飞行';
    $('[data-role="hint"]').textContent = state.preview
      ? '只读预览 · 点击标注查看内容'
      : `${cam} · ${state.depthOn ? '深度开' : '深度关'} · ${state.meshVisible ? '碰撞体显示' : '碰撞体隐藏'} · ${mesh} · ${depth}` +
        (state.selectedId ? ' · 已选中 1 个（其余锁定）' : '') +
        (state.lastSource && state.lastSource !== '-' ? ` · 落点 ${SRC_LABEL[state.lastSource] || state.lastSource}` : '');
  }

  function render(state) {
    renderTools(state); renderLayers(); renderGroups(); renderList(); renderTours(); renderProps();
  }

  /* 贴花诊断状态行轮询：深度快照就绪与否、实例可见数都是异步变化的，
     store change 不一定会触发重绘，故单独按 600ms 刷新这一行文本。
     只改 textContent，不重建面板，输入焦点不受影响。 */
  const diagTimer = setInterval(() => {
    const el = propEl.querySelector('[data-role="decal-diag-status"]');
    if (!el) return;
    let d = null;
    try { d = typeof getDecalDiag === 'function' ? getDecalDiag() : null; } catch (_) { d = null; }
    let txt;
    if (!d) txt = '贴花诊断：渲染层未就绪（贴花投射器不可用或已降级）';
    else if (d.degraded) txt = `贴花诊断：已降级（GPU 错误 ${d.gpuErrors} 次），贴花画面已隐藏`;
    else {
      const ps = d.pickSize ? `${d.pickSize[0]}×${d.pickSize[1]}` : '未知';
      const scale = d.pickSize && d.dpr ? (d.pickSize[0] / Math.max(1, d.dpr)) : 0;
      txt =
        `贴花诊断：深度快照 ${d.pickReady ? '就绪' : '未就绪'}（${ps} 设备像素，DPR ${d.dpr}，屏幕≈${Math.round(scale)}px）｜` +
        `归一化基准 ${Number(d.boxScale).toFixed(2)}｜深度口径 ${Number(d.depthMode) === 1 ? '引擎同族' : '单 texel 中位'}｜` +
        `背面剔除 ${d.cull ? '开' : '关'}｜实例 ${d.visible}/${d.instances}`;
    }
    if (el.textContent !== txt) el.textContent = txt;
  }, 600);

  // 展板内容已直接内嵌在三维空间的 overlay 中，这里不再提供任何弹出式内容卡片。
  return {
    render,
    renderList,
    renderProps,
    status(text) { $('[data-role="status"]').textContent = text; },
    contextMenu,
    palette: LAYER_PALETTE,
    destroy() {
      clearInterval(diagTimer);
      if (localObjectUrl) { try { URL.revokeObjectURL(localObjectUrl); } catch (_) { /* noop */ } }
      localObjectUrl = null;
      root.remove();
    },
  };
}

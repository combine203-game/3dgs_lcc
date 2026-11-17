/**
 * 漫游路线录制 / 回放 / 导出（工具栏）。
 *
 * 录制：按固定帧率采样相机 (position, target, fov)，存 localStorage。
 * 回放：逐帧 viewer.setCameraPose()，与官方 walk_path.json 的 poses 同构。
 * 下次直接播放：?route=<id> 链接，或勾选「打开页面自动播放」。
 * 导出：walk_path 兼容 JSON + canvas.captureStream + MediaRecorder 的 WebM 视频。
 */
const $ = (id) => document.getElementById(id);
const KEY = 'mgRoutes_v1';
const AUTO_KEY = 'mgRouteAuto_';
const MAX_ROUTES = 12;
const MAX_SECONDS = 300;

export function initRouteRecorder(viewer, { scene, params }) {
  const state = {
    recording: false, playing: false, video: false,
    frames: [], recFps: 24, idx: 0, raf: 0, timer: 0,
    recorder: null, stream: null, hadCollision: false,
    activeId: null, message: ''
  };

  /* ---------- 相机位姿 ---------- */
  function pose() {
    const cam = viewer.app?.root?.findComponent('camera');
    if (!cam?.entity) return null;
    const e = cam.entity.getPosition();
    const f = cam.entity.forward || { x: 0, y: 0, z: -1 };
    return {
      world: [e.x, e.y, e.z],
      target: [e.x + f.x, e.y + f.y, e.z + f.z],
      fov: cam.fov ?? 75
    };
  }

  /* ---------- 路线存储 ---------- */
  function all() {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; }
    catch (_) { return {}; }
  }
  function saveAll(o) {
    try { localStorage.setItem(KEY, JSON.stringify(o)); return true; }
    catch (_) { msg('本机存储写入失败（可能已满）'); return false; }
  }
  const fmtTime = (ts) => new Date(ts).toLocaleString('zh-CN', { hour12: false });

  function store(poses, fps, label) {
    const routes = all();
    const id = 'r' + Date.now().toString(36);
    routes[id] = { id, scene, fps, created: Date.now(), label: label || '', poses };
    // 超出条数上限时删最旧
    const keys = Object.keys(routes).sort((a, b) => routes[a].created - routes[b].created);
    while (keys.length > MAX_ROUTES) delete routes[keys.shift()];
    if (!saveAll(routes)) return null;
    state.activeId = id;
    return id;
  }

  function current() {
    const routes = all();
    const id = $('mg-route-list')?.value || state.activeId;
    return (id && routes[id]) ? routes[id] : null;
  }

  function refreshList() {
    const sel = $('mg-route-list');
    if (!sel) return;
    const routes = all();
    const ids = Object.keys(routes)
      .filter((k) => routes[k].scene === scene)
      .sort((a, b) => routes[b].created - routes[a].created);
    sel.innerHTML = ids.length
      ? ids.map((k) => {
        const r = routes[k];
        return '<option value="' + k + '">' +
          (r.label || fmtTime(r.created)) + ' · ' + r.poses.length + ' 帧 · ' +
          (r.poses.length / (r.fps || 24)).toFixed(1) + 's</option>';
      }).join('')
      : '<option value="">（暂无录制路线）</option>';
    if (state.activeId && ids.includes(state.activeId)) sel.value = state.activeId;
    const auto = $('mg-route-auto');
    if (auto) auto.checked = localStorage.getItem(AUTO_KEY + scene) === sel.value;
    const has = ids.length > 0;
    for (const id of ['mg-route-play', 'mg-route-json', 'mg-route-video',
                      'mg-route-copy', 'mg-route-del']) {
      const el = $(id);
      if (el) el.disabled = !has;
    }
  }

  function msg(t) {
    state.message = t;
    const el = $('mg-route-msg');
    if (el) el.textContent = t;
    clearTimeout(msg._t);
    msg._t = setTimeout(() => {
      state.message = '';
      if (el) el.textContent = '';
    }, 5000);
  }

  function info() {
    const r = current();
    const lines = [
      '场景: ' + scene + ' · 录制帧率: ' + (Number($('mg-route-fps')?.value) || 24) + ' fps',
      '路线: ' + (r ? (r.label || fmtTime(r.created)) + ' · ' + r.poses.length +
        ' 帧 / ' + (r.poses.length / (r.fps || 24)).toFixed(1) + 's' : '无'),
      '状态: ' + (state.recording ? '● 录制中 ' + state.frames.length + ' 帧'
        : state.playing ? '▶ 播放中 ' + (state.idx + 1) + '/' + (r?.poses.length || 0) +
          (state.video ? ' · 同时录制 WebM' : '') : '空闲')
    ];
    if (state.message) lines.push('', state.message);
    const el = $('mg-route-info');
    if (el) el.textContent = lines.join('\n');
  }

  function refresh() { refreshList(); info(); }

  /* ---------- 录制 ---------- */
  function stopRecord(save) {
    if (!state.recording) return;
    state.recording = false;
    clearInterval(state.timer);
    const poses = state.frames;
    state.frames = [];
    if (save && poses.length >= 2) {
      const fps = state.recFps;
      store(poses, fps, fmtTime(Date.now()));
      msg('已保存 ' + poses.length + ' 帧 / ' + (poses.length / fps).toFixed(1) + 's');
      refreshList();
    } else if (save) {
      msg('帧数不足，未保存');
    }
    const b = $('mg-route-rec');
    if (b) { b.textContent = '● 开始录制'; b.classList.remove('mg-on'); }
    info();
  }

  function startRecord() {
    if (state.recording) { stopRecord(true); return; }
    if (!pose()) { msg('相机尚未就绪'); return; }
    stopPlayback();
    state.recFps = Math.max(5, Math.min(60, Number($('mg-route-fps')?.value) || 24));
    const secs = Math.max(5, Math.min(MAX_SECONDS, Number($('mg-route-secs')?.value) || 60));
    const maxFrames = Math.round(state.recFps * secs);
    state.frames = [];
    state.recording = true;
    const sample = () => {
      const p = pose();
      if (!p) return;
      state.frames.push(p);
      if (state.frames.length >= maxFrames) stopRecord(true);
      else info();
    };
    sample();
    state.timer = setInterval(sample, 1000 / state.recFps);
    const b = $('mg-route-rec');
    if (b) { b.textContent = '■ 停止并保存'; b.classList.add('mg-on'); }
    msg('开始漫游，最长 ' + secs + ' 秒，点「停止并保存」结束');
    info();
  }

  /* ---------- 回放 ---------- */
  function restoreCollision() {
    if (state.hadCollision) {
      try { viewer.setCollisionEnabled?.(true); } catch (_) { /* noop */ }
      state.hadCollision = false;
    }
  }

  function stopPlayback() {
    if (!state.playing) return;
    state.playing = false;
    cancelAnimationFrame(state.raf);
    if (state.recorder && state.recorder.state !== 'inactive') {
      try { state.recorder.stop(); } catch (_) { /* noop */ }
    }
    state.recorder = null;
    state.stream = null;
    state.video = false;
    restoreCollision();
    const b = $('mg-route-play');
    if (b) { b.textContent = '▶ 播放'; b.classList.remove('mg-on'); }
    info();
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function startVideo(fps) {
    const canvas = document.querySelector('#mg-stage canvas');
    if (!canvas?.captureStream) throw new Error('浏览器不支持 canvas.captureStream');
    if (typeof MediaRecorder === 'undefined') throw new Error('浏览器不支持 MediaRecorder');
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
      .find((t) => MediaRecorder.isTypeSupported(t));
    if (!mime) throw new Error('浏览器不支持 WebM 录制');
    const stream = canvas.captureStream(fps);
    const chunks = [];
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8000000 });
    rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: mime });
      if (blob.size) download(blob, 'roam_' + scene + '_' + Date.now() + '.webm');
      msg('视频已导出 (' + (blob.size / 1048576).toFixed(1) + ' MB)');
    };
    rec.start(1000);
    state.recorder = rec;
    state.stream = stream;
    state.video = true;
  }

  function play(withVideo) {
    if (state.playing) { stopPlayback(); return; }
    const r = current();
    if (!r || r.poses.length < 2) { msg('请先录制一条路线'); return; }
    stopRecord(false);
    const fps = r.fps || 24;
    if (withVideo) {
      try { startVideo(fps); }
      catch (e) { msg(String(e?.message ?? e)); return; }
    }
    // 播放期间摘掉碰撞，避免 FlyController 的 SphereMover 把相机推离录制机位
    state.hadCollision = !!viewer.state?.hasCollision;
    if (state.hadCollision) viewer.setCollisionEnabled?.(false);
    const loop = !withVideo && !!$('mg-route-loop')?.checked;
    state.playing = true;
    state.idx = 0;
    let last = performance.now();
    const tick = (now) => {
      if (!state.playing) return;
      if (now - last >= 1000 / fps) {
        last = now;
        const p = r.poses[state.idx];
        if (p) viewer.setCameraPose?.(p.world, p.target, p.fov || 75);
        viewer.app.renderNextFrame = true;
        state.idx++;
        if (state.idx >= r.poses.length) {
          if (loop) state.idx = 0;
          else { stopPlayback(); if (withVideo) msg('播放结束，视频正在封装…'); return; }
        }
        info();
      }
      state.raf = requestAnimationFrame(tick);
    };
    state.raf = requestAnimationFrame(tick);
    const b = $('mg-route-play');
    if (b) { b.textContent = '■ 停止播放'; b.classList.add('mg-on'); }
    msg(withVideo ? '开始播放并录制 WebM，结束自动下载' : '开始播放路线');
    info();
  }

  /* ---------- 导入 / 导出 ---------- */
  function exportJson() {
    const r = current();
    if (!r) { msg('请先录制一条路线'); return; }
    const doc = {
      version: 1, source: 'MaomingGSViewer route-recorder', scene: r.scene,
      fps: r.fps, frames: r.poses.length, created: new Date(r.created).toISOString(),
      poses: r.poses.map((p, i) => ({ i, t: +(i / r.fps).toFixed(4),
                                      world: p.world, target: p.target, fov: p.fov }))
    };
    download(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }),
      'walk_path_' + r.scene + '_' + r.id + '.json');
    msg('已导出 walk_path 兼容 JSON（可交给 cdp_video.mjs / ffmpeg 转 MP4）');
  }

  function importJson(file) {
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const doc = JSON.parse(String(fr.result));
        const raw = doc.poses || doc.frames;
        if (!Array.isArray(raw)) throw new Error('缺少 poses 数组');
        const poses = raw.map((p) => ({
          world: p.world || p.position || p.pos,
          target: p.target || p.look,
          fov: p.fov || 75
        })).filter((p) => Array.isArray(p.world) && Array.isArray(p.target));
        if (poses.length < 2) throw new Error('有效帧不足 2 帧');
        const id = store(poses, doc.fps || 24, (doc.source || '导入') + ' ' + fmtTime(Date.now()));
        if (id) { refreshList(); msg('已导入 ' + poses.length + ' 帧'); }
      } catch (e) { msg('导入失败: ' + String(e?.message ?? e)); }
    };
    fr.readAsText(file);
  }

  function copyLink() {
    const r = current();
    if (!r) { msg('请先录制一条路线'); return; }
    const q = new URLSearchParams(params);
    q.set('scene', scene);
    q.set('route', r.id);
    q.delete('pos'); q.delete('look'); q.delete('spawn'); q.delete('play');
    const url = location.origin + location.pathname + '?' + q.toString();
    (async () => {
      // 局域网 http://<IP> 下 navigator.clipboard 不可用，走 app.js 的统一回退
      const ok = window.__mgCopyText
        ? await window.__mgCopyText(url)
        : await navigator.clipboard.writeText(url).then(() => true).catch(() => false);
      if (ok) msg('播放链接已复制，下次打开自动播放');
      else { $('mg-route-info').textContent = url; msg('播放链接已显示在下方'); }
    })();
  }

  /* ---------- UI ---------- */
  $('mg-route-rec')?.addEventListener('click', startRecord);
  $('mg-route-play')?.addEventListener('click', () => play(false));
  $('mg-route-stop')?.addEventListener('click', () => { stopRecord(true); stopPlayback(); });
  $('mg-route-video')?.addEventListener('click', () => play(true));
  $('mg-route-json')?.addEventListener('click', exportJson);
  $('mg-route-copy')?.addEventListener('click', copyLink);
  $('mg-route-del')?.addEventListener('click', () => {
    const routes = all();
    const id = $('mg-route-list')?.value;
    if (!id || !routes[id]) return;
    delete routes[id];
    if (localStorage.getItem(AUTO_KEY + scene) === id) localStorage.removeItem(AUTO_KEY + scene);
    saveAll(routes);
    state.activeId = null;
    refreshList(); msg('已删除该路线');
  });
  $('mg-route-list')?.addEventListener('change', () => {
    state.activeId = $('mg-route-list').value;
    const auto = $('mg-route-auto');
    if (auto) auto.checked = localStorage.getItem(AUTO_KEY + scene) === state.activeId;
    info();
  });
  $('mg-route-auto')?.addEventListener('change', (e) => {
    const id = $('mg-route-list')?.value;
    if (e.target.checked && id) {
      localStorage.setItem(AUTO_KEY + scene, id);
      msg('下次打开本场景自动播放这条路线');
    } else localStorage.removeItem(AUTO_KEY + scene);
  });
  $('mg-route-import')?.addEventListener('click', () => $('mg-route-file')?.click());
  $('mg-route-file')?.addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) importJson(f);
    e.target.value = '';
  });

  // CDP / 控制台接口
  const api = {
    getState: () => ({
      recording: state.recording, playing: state.playing, video: state.video,
      recFrames: state.frames.length, idx: state.idx, activeId: state.activeId
    }),
    refresh, info,
    routes: () => all(),
    startRecord, stopRecord, play, stopPlayback, exportJson, copyLink,
    importJson,
    current
  };
  window.__mgRoute = api;
  refresh();

  // 下次直接播放：?route=<id> 优先，其次本机「自动播放」设置
  const routeId = params.get('route') || localStorage.getItem(AUTO_KEY + scene);
  if (routeId) {
    const wait = setInterval(() => {
      if (!viewer.state?.loaded) return;
      clearInterval(wait);
      const routes = all();
      if (!routes[routeId] || routes[routeId].scene !== scene) {
        msg('?route 指定的路线不存在或不属于本场景'); return;
      }
      state.activeId = routeId;
      refreshList();
      setTimeout(() => play(false), 600);
    }, 400);
    setTimeout(() => clearInterval(wait), 60000);
  }

  return api;
}

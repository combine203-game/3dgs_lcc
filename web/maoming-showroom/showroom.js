/* 由 tools/build_showroom_spa.py 从四页公共内联脚本合并生成。
   全局函数供 HTML 内联 onclick 调用；initView() 在每次视图切换后调用。 */
let recording = false;
    let recordSeconds = 0;
    let recordTimer = null;
    let toastTimer = null;
    let clockTimer = null;
    let currentAngle = 132;
    let currentProgress = 34;
    let currentDistance = 12;

    function fitStage() {
      /* 统一 UI 缩放：HUD 仍按 1920x1080 设计稿的固定 px 排布，由 #stage 的
         zoom 整体等比缩放到当前视口。逻辑画布 = 视口 / zoom，最小 1920x1080，
         所以 16:10、超宽、4K、小笔记本下面板都不会互相挤压或重叠。 */
      const raw = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
      const z = Math.max(0.45, Math.min(2.4, raw));
      const v = String(Number(z.toFixed(4)));
      document.documentElement.style.setProperty('--ui-zoom', v);
      const stage = document.getElementById('stage');
      if (stage) {
        stage.style.setProperty('--ui-zoom', v);
        stage.style.setProperty('--vw', window.innerWidth + 'px');
        stage.style.setProperty('--vh', window.innerHeight + 'px');
      }
    }

    function tickClock() {
      const now = new Date();
      const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
      const pad = function (value) { return String(value).padStart(2, '0'); };
      const timeEl = document.getElementById('clockTime');
      const dateEl = document.getElementById('clockDate');
      if (timeEl) timeEl.textContent = pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
      if (dateEl) {
        dateEl.textContent = now.getFullYear() + '.' + pad(now.getMonth() + 1) + '.' + pad(now.getDate()) +
          ' · ' + week[now.getDay()] + ' / 26°C 多云';
      }
    }

    function showOverlay(id, display) {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.remove('hidden');
      el.classList.add(display || 'flex');
      if (id === 'exhibitDrawer') el.classList.add('drawer-enter');
    }

    function hideOverlay(id, display) {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.remove(display || 'flex');
      el.classList.add('hidden');
      if (id === 'exhibitDrawer') el.classList.remove('drawer-enter');
    }

    function toggleSpeed() {
      const panel = document.getElementById('speedPanel');
      if (panel.classList.contains('hidden')) {
        showOverlay('speedPanel', 'block');
      } else {
        hideOverlay('speedPanel', 'block');
      }
    }

    function setSpeed(value) {
      const speed = Number(value);
      const label = speed.toFixed(1) + '×';
      document.getElementById('speedValue').textContent = label;
      document.getElementById('speedToolValue').textContent = label;
      const range = document.getElementById('speedRange');
      range.value = String(speed);
      const ratio = (speed - 0.5) / 2.5;
      range.style.background = 'linear-gradient(90deg, var(--accent) 0%, var(--accent) ' +
        (ratio * 100) + '%, rgba(121,176,193,.18) ' + (ratio * 100) + '%, rgba(121,176,193,.18) 100%)';
      document.querySelectorAll('.speed-chip').forEach(function (chip) {
        chip.classList.toggle('is-current', chip.textContent.indexOf(speed.toFixed(1)) === 0);
      });
    }

    function quickSpeed(value) {
      setSpeed(value);
      showToast('漫游速度已调整为 ' + Number(value).toFixed(1) + '×');
    }

    function toggleRecord() {
      recording = !recording;
      const btn = document.getElementById('recordBtn');
      const icon = document.getElementById('recordIcon');
      const badge = document.getElementById('recBadge');
      if (recording) {
        recordSeconds = 0;
        document.getElementById('recordTime').textContent = '00:00';
        btn.classList.add('is-recording');
        icon.setAttribute('icon', 'ph:stop-circle');
        badge.classList.remove('hidden');
        badge.classList.add('flex');
        clearInterval(recordTimer);
        recordTimer = setInterval(function () {
          recordSeconds += 1;
          const min = String(Math.floor(recordSeconds / 60)).padStart(2, '0');
          const sec = String(recordSeconds % 60).padStart(2, '0');
          document.getElementById('recordTime').textContent = min + ':' + sec;
        }, 1000);
        showToast('漫游录制已开始 · 将生成 3D 路径回放');
      } else {
        clearInterval(recordTimer);
        btn.classList.remove('is-recording');
        icon.setAttribute('icon', 'ph:record');
        badge.classList.add('hidden');
        badge.classList.remove('flex');
        showToast('录制已结束 · 已保存至「我的漫游」');
      }
    }

    function showToast(message) {
      const toast = document.getElementById('toast');
      const text = document.getElementById('toastText');
      if (!toast || !text) return;
      text.textContent = message;
      toast.classList.remove('hidden');
      toast.classList.add('flex');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () {
        toast.classList.remove('flex');
        toast.classList.add('hidden');
      }, 2800);
    }

    function openExhibit(button) {
      const dataset = button.dataset;
      document.querySelectorAll('.hotspot').forEach(function (item) {
        item.classList.remove('is-active');
      });
      button.classList.add('is-active');
      document.getElementById('exhibitIndex').textContent = dataset.index || '01';
      document.getElementById('exhibitEn').textContent = dataset.en || 'EXHIBIT';
      document.getElementById('exhibitName').textContent = dataset.name || '展项';
      document.getElementById('exhibitDesc').textContent = dataset.desc || '';
      document.getElementById('exhibitMeta').textContent = dataset.meta || '空间数据同步中';
      document.getElementById('exhibitDuration').textContent = dataset.duration || '建议停留 3 分钟';
      const tags = document.getElementById('exhibitTags');
      tags.innerHTML = '';
      (dataset.tags || '').split('|').forEach(function (text) {
        if (!text) return;
        const span = document.createElement('span');
        span.className = 'tag-chip';
        span.textContent = text;
        tags.appendChild(span);
      });
      showOverlay('exhibitDrawer', 'block');
      if (document.getElementById('speedPanel').classList.contains('hidden') === false) {
        hideOverlay('speedPanel', 'block');
      }
    }

    function closeDrawer() {
      hideOverlay('exhibitDrawer', 'block');
      document.querySelectorAll('.hotspot').forEach(function (item) {
        item.classList.remove('is-active');
      });
    }

    function enterExhibit() {
      if (!document.getElementById('exhibitName')) return;
      const name = document.getElementById('exhibitName').textContent;
      const fx = document.getElementById('enterFx');
      fx.classList.remove('hidden');
      fx.classList.add('flex');
      closeDrawer();
      showToast('正在进入「' + name + '」沉浸视角');
      setTimeout(function () {
        fx.classList.remove('flex');
        fx.classList.add('hidden');
      }, 1150);
    }

    function updateHud() {
      const setText = function (id, text) { const el = document.getElementById(id); if (el) el.textContent = text; };
      const rb = document.getElementById('routeBar'); if (rb) rb.style.width = currentProgress + '%';
      setText('routePercent', currentProgress + '%');
      setText('distanceValue', String(currentDistance));
      setText('viewAngle', String(currentAngle).padStart(3, '0') + '°');
      setText('angleMini', String(currentAngle).padStart(3, '0') + '°');
      const needle = document.getElementById('compassNeedle');
      if (needle) needle.style.transform = 'rotate(' + currentAngle + 'deg)';
      const cone = document.getElementById('miniCone');
      if (cone) {
        const d = document.body.dataset;
        cone.setAttribute('transform', 'rotate(' + (currentAngle - Number(d.coneBase || 132)) +
          ' ' + (d.coneX || 160) + ' ' + (d.coneY || 202) + ')');
      }
    }

    function stepTour(direction) {
      currentProgress = Math.max(6, Math.min(96, currentProgress + direction * 6));
      currentAngle = (currentAngle + direction * 9 + 360) % 360;
      currentDistance = Math.max(2, Math.min(36, currentDistance - direction * 2));
      updateHud();
      if (direction > 0) {
        showToast('沿导览线前进 · 当前视角 ' + String(currentAngle).padStart(3, '0') + '°');
      } else {
        showToast('后退并环视 · 当前视角 ' + String(currentAngle).padStart(3, '0') + '°');
      }
    }

    function toggleFullscreen() {
      if (!document.fullscreenElement) {
        const request = document.documentElement.requestFullscreen();
        if (request && request.then) {
          request.then(function () {
            document.getElementById('fullscreenIcon').setAttribute('icon', 'ph:corners-in');
            document.getElementById('fullscreenLabel').textContent = '退出全屏';
            showToast('已进入全屏沉浸模式');
          }).catch(function () {
            showToast('当前预览环境暂不支持全屏');
          });
        }
      } else {
        document.exitFullscreen().then(function () {
          document.getElementById('fullscreenIcon').setAttribute('icon', 'ph:corners-out');
          document.getElementById('fullscreenLabel').textContent = '全屏';
          showToast('已退出全屏模式');
        });
      }
    }

    function confirmClose() {
      hideOverlay('closeModal', 'flex');
      hideOverlay('helpModal', 'flex');
      closeDrawer();
      document.getElementById('systemClosed').classList.remove('hidden');
      document.getElementById('systemClosed').classList.add('flex');
    }

    function reopenSystem() {
      document.getElementById('systemClosed').classList.remove('flex');
      document.getElementById('systemClosed').classList.add('hidden');
      showToast('正在重新连接展厅三维模型');
    }

    document.addEventListener('keydown', function (event) {
      if (event.target.tagName === 'INPUT') return;
      if (event.key === 'Escape') {
        closeDrawer();
        hideOverlay('helpModal', 'flex');
        hideOverlay('closeModal', 'flex');
        hideOverlay('speedPanel', 'block');
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        stepTour(-1);
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        stepTour(1);
      }
    });

    document.addEventListener('fullscreenchange', function () {
      const icon = document.getElementById('fullscreenIcon');
      const label = document.getElementById('fullscreenLabel');
      if (document.fullscreenElement) {
        icon.setAttribute('icon', 'ph:corners-in');
        label.textContent = '退出全屏';
      } else {
        icon.setAttribute('icon', 'ph:corners-out');
        label.textContent = '全屏';
      }
    });

    /* ---------- SPA 重入：每次切楼层只重置状态，不重复注册全局监听 ---------- */
    function initView() {
      clearInterval(recordTimer); clearTimeout(toastTimer); clearInterval(clockTimer);
      recording = false; recordSeconds = 0;
      const d = document.body.dataset;
      currentAngle = Number(d.angle || 132);
      currentProgress = Number(d.progress || 34);
      currentDistance = Number(d.distance || 12);
      fitStage();
      tickClock();
      setSpeed(1);
      updateHud();
    }
    /* 全页只保留 fusion.js 的一个 500ms 心跳；时钟由其按秒驱动，
       避免「时钟 + 罗盘 + 状态」三个定时器并存。 */
    window.Showroom = { initView, fitStage, tickClock, updateHud, setSpeed };
    window.addEventListener('resize', fitStage);
    /* showroom.js 在 <head> 执行，此时 #stage 可能尚未解析：DOM 就绪后再算一次，
       同时先写到 <html> 保证首帧就能继承到正确的缩放值（无闪动）。 */
    document.addEventListener('DOMContentLoaded', fitStage);
    fitStage();

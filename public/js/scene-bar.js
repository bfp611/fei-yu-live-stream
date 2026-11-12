// 场景外壳 · 控制台
// 由服务端注入到控制台页面，所以 V1 的 control.html 源文件不用改。
// 1) 右下角：场景切换器（工作摸鱼 / AI 辩论赛）
// 2) 头部：注入「直播窗口」按钮，打开无地址栏的 Chrome app 窗口
(function () {
  if (document.getElementById('sceneBar')) return;

  const style = document.createElement('style');
  style.textContent = `
  #sceneBar{position:fixed;right:18px;bottom:18px;z-index:9999;display:flex;align-items:center;gap:4px;
    padding:6px;border-radius:999px;background:rgba(255,255,255,.94);border:1px solid #dfe7df;
    box-shadow:0 10px 30px rgba(20,40,30,.16);backdrop-filter:blur(8px);
    font:600 13px/1 "PingFang SC","Hiragino Sans GB",system-ui,sans-serif;color:#3d5148}
  #sceneBar b{font-weight:600;font-size:11px;color:#7b8f84;padding:0 8px 0 12px;letter-spacing:1px}
  #sceneBar button{border:0;background:transparent;padding:8px 14px;border-radius:999px;cursor:pointer;
    font:inherit;color:#3d5148;transition:background .15s,color .15s}
  #sceneBar button:hover{background:#eef3ee}
  #sceneBar button.on{background:#1d7a4d;color:#fff}
  #sceneBar button.on:hover{background:#1d7a4d}
  #sceneBar.busy button{opacity:.45;pointer-events:none}
  .sceneToast{position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:10000;
    background:#1f2a24;color:#fff;font:500 13px/1.5 "PingFang SC","Hiragino Sans GB",system-ui,sans-serif;
    padding:10px 18px;border-radius:10px;box-shadow:0 12px 30px rgba(0,0,0,.25);max-width:min(90vw,560px);
    opacity:0;transition:opacity .18s}
  .sceneToast.on{opacity:1}
  .sceneToast.bad{background:#7a2f2f}
  /* 注入到控制台头部的“直播窗口”按钮，和原按钮同一套观感 */
  button.sceneOpenLive{background:#1f5e44;color:#fff;border:0;border-radius:9px;padding:9px 15px;
    font-family:inherit;font-size:14px;line-height:1.6;cursor:pointer;white-space:nowrap}
  button.sceneOpenLive:hover{background:#26714f}
  button.sceneOpenLive:active{transform:scale(.98)}
  button.sceneOpenLive:disabled{opacity:.6;cursor:wait}
  /* 给切换器留出底部空间，别压住最后的卡片 */
  .main{padding-bottom:96px!important}`;
  document.head.append(style);

  let toastTimer = null;
  function sceneToast(text, bad = false) {
    let el = document.querySelector('.sceneToast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'sceneToast';
      document.body.append(el);
    }
    el.textContent = text;
    el.classList.toggle('bad', bad);
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('on'), 3200);
  }

  // 按你的屏幕算一个合适的竖屏窗口，别固定 720×1280 显得又小又窄
  function liveWindowSize() {
    const availH = (window.screen && screen.availHeight) || 1280;
    const availW = (window.screen && screen.availWidth) || 720;
    let h = Math.min(1920, Math.floor(availH * 0.94));
    let w = Math.round((h * 9) / 16);
    if (w > availW * 0.94) {
      w = Math.floor(availW * 0.94);
      h = Math.round((w * 16) / 9);
    }
    return `${Math.max(360, w)}x${Math.max(640, h)}`;
  }

  async function openLiveWindow(btn) {
    if (btn.dataset.busy) return;
    btn.dataset.busy = '1';
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '打开中…';
    try {
      const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined;
      const res = await fetch('/api/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'open-window', size: liveWindowSize() }),
        signal
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || '打不开');
      if (json.browserUrl) window.open(json.browserUrl, '_blank');
      sceneToast(json.browserUrl ? '直播画面已打开；若被拦截，请允许弹出窗口或手动打开直播画面地址' : '直播窗口已打开');
    } catch (err) {
      sceneToast('打开直播窗口失败：' + (err.message || err) + '。可以先手动打开 /?view=stream', true);
    } finally {
      btn.textContent = label;
      btn.disabled = false;
      delete btn.dataset.busy;
    }
  }

  function injectLiveButton(bar) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sceneOpenLive';
    btn.textContent = '▭ 直播窗口';
    btn.title = '无地址栏的直播窗口，给直播伴侣做窗口捕获';
    btn.addEventListener('click', () => openLiveWindow(btn));
    const actions = document.querySelector('.head .actions');
    if (actions) actions.prepend(btn);
    else if (bar) {
      btn.style.marginLeft = '6px';
      bar.append(btn);
    }
  }

  fetch('/api/scene')
    .then((r) => r.json())
    .then((d) => {
      const bar = document.createElement('div');
      bar.id = 'sceneBar';
      const list = d.list || [];
      bar.innerHTML =
        '<b>场景</b>' +
        list
          .map(
            (s) =>
              `<button data-scene="${s.id}"${s.id === d.active ? ' class="on"' : ''}>${s.label || s.id}</button>`
          )
          .join('');
      document.body.append(bar);
      injectLiveButton(bar);

      bar.addEventListener('click', async (e) => {
        const btn = e.target.closest('button[data-scene]');
        if (!btn || btn.classList.contains('on')) return;
        bar.classList.add('busy');
        const target = btn.dataset.scene;
        try {
          const res = await fetch('/api/scene', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scene: target })
          });
          const json = await res.json();
          if (!json.ok) throw new Error(json.error || '切换失败');
          location.href = '/control';
        } catch (err) {
          bar.classList.remove('busy');
          sceneToast('切换场景失败：' + err.message, true);
        }
      });
    })
    .catch(() => {});
})();

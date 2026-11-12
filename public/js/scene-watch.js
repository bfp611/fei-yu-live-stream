// 场景外壳 · 页面跟随
// 服务端按“当前场景”决定返回哪张页面；这个脚本只负责一件事：
// 后台切了场景 → 当前页面自动换成另一张（OBS 的浏览器源地址不用改）。
(function () {
  let current = null;
  let reloading = false;

  function reload() {
    if (reloading) return;
    reloading = true;
    location.reload();
  }

  // 用轮询而不是第二条 SSE：Chrome 对同一域名只给 6 条长连接，
  // 每个页面占两条的话，开三四个标签页就再也打不开新页面了。
  let bootScene = null;
  let pageVersion = null;

  async function poll() {
    try {
      const r = await fetch('/api/version', { cache: 'no-store' });
      const d = await r.json();
      if (!d.version) return;
      if (bootScene === null) {
        bootScene = d.scene;
        pageVersion = d.version;
        return;
      }
      if (d.scene !== bootScene) reload();
      else if (d.version !== pageVersion && !window.aliveSpeechBusy?.()) reload();
    } catch {
      /* 服务没起来就下次再试 */
    }
  }
  setInterval(poll, 2000);
  poll();

})();

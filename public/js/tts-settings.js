// 两个场景共用的语音服务配置。不读取或回显已保存的密钥。
(() => {
  const card = document.createElement('details');
  card.id = 'ttsSettings';
  card.style.cssText = 'padding:16px 20px;margin:0 0 18px;border:1px solid #dce5dc;border-radius:12px;background:#fff';
  card.innerHTML = `<summary style="cursor:pointer;font-weight:600">语音服务配置 · 两个场景共用 <span id="ttsKeyState" style="font-weight:400;color:#718179">正在读取…</span></summary>
    <form id="ttsSettingsForm" style="margin-top:14px">
      <label style="display:block;margin-bottom:6px" for="volcApiKey">豆包语音 API Key</label>
      <input id="volcApiKey" type="password" autocomplete="new-password" spellcheck="false" placeholder="输入新 Key；留空保留已保存的 Key" style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #dde3da;border-radius:8px">
      <label style="display:block;margin:12px 0 6px" for="volcResourceId">资源 ID（Resource ID）</label>
      <input id="volcResourceId" type="text" value="seed-tts-2.0" spellcheck="false" style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #dde3da;border-radius:8px">
      <p style="font-size:12px;color:#718179">语音合成 2.0 通常使用 seed-tts-2.0，以服务商提供的资源 ID 为准。Key 保存在本机配置文件，页面不回显；保存立即生效，无需重启或启动互动。</p>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <button id="saveTtsSettings" type="submit" style="background:#2f7d5c;color:white;border:0;border-radius:8px;padding:9px 16px;cursor:pointer">保存语音配置</button>
        <button id="clearTtsKey" type="button" style="background:white;color:#b44646;border:1px solid #e4d5d5;border-radius:8px;padding:9px 16px;cursor:pointer">清除已保存 Key</button>
        <span id="ttsSaveStatus" role="status" style="font-size:12px;color:#718179"></span>
      </div>
    </form>`;
  const host = document.querySelector('#interactionControl');
  if (host) host.after(card);
  else (document.querySelector('main') || document.body).prepend(card);
  const key = card.querySelector('#volcApiKey');
  const resource = card.querySelector('#volcResourceId');
  const status = card.querySelector('#ttsSaveStatus');
  const saved = card.querySelector('#ttsKeyState');
  function showConfig(tts) {
    saved.textContent = tts.hasVolcApiKey ? '已配置 Key' : '尚未配置 Key';
    resource.value = tts.volcResourceId || 'seed-tts-2.0';
  }
  fetch('/api/state').then(r => r.json()).then(s => showConfig(s.config?.tts || {}))
    .catch(() => { saved.textContent = '暂时无法读取配置'; });
  let busy = false;
  async function save(clear = false) {
    if (busy) return;
    if (!clear && !resource.value.trim()) { status.textContent = '请填写资源 ID'; return; }
    busy = true;
    card.querySelector('#saveTtsSettings').disabled = true;
    card.querySelector('#clearTtsKey').disabled = true;
    status.textContent = '正在保存…';
    const tts = clear ? { clearVolcApiKey: true } : { volcResourceId: resource.value.trim() };
    if (!clear && key.value.trim()) tts.volcApiKey = key.value.trim();
    try {
      const r = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tts }) });
      const data = await r.json();
      if (!r.ok || data.error) throw new Error(data.error || '保存失败');
      key.value = '';
      showConfig(data.config.tts);
      status.textContent = clear ? 'Key 已清除' : '配置已保存并生效；没有发起语音合成';
    } catch (err) { status.textContent = err.message; }
    finally {
      busy = false;
      card.querySelector('#saveTtsSettings').disabled = false;
      card.querySelector('#clearTtsKey').disabled = false;
    }
  }
  card.querySelector('#ttsSettingsForm').onsubmit = e => { e.preventDefault(); save(); };
  card.querySelector('#clearTtsKey').onclick = () => {
    if (confirm('清除本机已保存的豆包语音 Key？清除后需要重新配置才能合成语音。')) save(true);
  };
})();

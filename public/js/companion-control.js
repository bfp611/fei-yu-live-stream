// Shared by both scene consoles. Connecting does not enable paid interaction.
(() => {
  const card = document.createElement('section');
  card.id = 'companionControl';
  card.style.cssText = 'padding:16px 20px;margin:0 0 18px;border:1px solid #dce5dc;border-radius:12px;background:#fff;display:flex;align-items:center;gap:16px;flex-wrap:wrap';
  card.innerHTML = '<button type="button" id="companionConnect" style="border:0;border-radius:9px;padding:11px 20px;background:#2f7d5c;color:#fff;font:inherit;font-weight:600;cursor:pointer">连接直播伴侣</button><div style="flex:1;min-width:220px"><strong id="companionStatus" role="status">正在读取礼物采集状态…</strong><div style="font-size:12px;color:#718179;margin-top:4px">连接后采集新礼物；如伴侣已运行但未开放调试，请先下播并退出伴侣，再点击连接。礼物回复需另行启动互动。</div></div>';
  const interaction = document.getElementById('interactionControl');
  if (interaction) interaction.after(card);
  else (document.querySelector('main') || document.body).prepend(card);
  const button = card.querySelector('#companionConnect');
  const label = card.querySelector('#companionStatus');
  let pending = false;
  function render(data) {
    label.textContent = data.message;
    label.style.color = data.state === 'connected' ? '#237a52' : data.state === 'conflict' ? '#b44646' : '#718179';
    button.textContent = data.state === 'connected' ? '检查伴侣连接' : '连接直播伴侣';
  }
  async function refresh() {
    if (pending) return;
    try {
      const response = await fetch('/api/companion');
      if (!response.ok) throw new Error('后台无响应');
      render(await response.json());
    } catch { label.textContent = '暂时无法读取礼物采集状态，请检查后台连接。'; }
  }
  button.onclick = async () => {
    if (pending) return;
    pending = true; button.disabled = true;
    label.textContent = '正在连接直播伴侣，请稍候…';
    try {
      const response = await fetch('/api/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'companion-connect' }) });
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error || '连接失败');
      render(data);
    } catch (err) { label.textContent = err.message; label.style.color = '#b44646'; }
    finally { pending = false; button.disabled = false; }
  };
  refresh();
  setInterval(refresh, 5000);
})();

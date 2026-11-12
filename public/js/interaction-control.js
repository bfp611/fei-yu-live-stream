// 总开关与在线心跳。关闭所有控制台/有声舞台约20秒后，服务端自动停止付费互动。
(() => {
  const script = document.currentScript;
  const isControl = script?.dataset.console === '1';
  const params = new URLSearchParams(location.search);
  if (!isControl && (params.get('mute') === '1' || params.get('embed') === '1')) return;
  let state = null;
  let pending = false;
  let button, status, hint;
  if (isControl) {
    const card = document.createElement('section');
    card.id = 'interactionControl';
    card.style.cssText = 'padding:16px 20px;margin:0 0 18px;border:1px solid #dce5dc;border-radius:12px;background:#fff;display:flex;align-items:center;gap:16px;flex-wrap:wrap';
    card.innerHTML = '<button id="interactionToggle" disabled style="border:0;border-radius:9px;padding:11px 20px;background:#2f7d5c;color:#fff;font:inherit;font-weight:600;cursor:pointer">正在连接后台…</button><div><strong id="interactionStatus">正在读取运行状态</strong><div id="interactionHint" style="font-size:12px;color:#718179;margin-top:4px">停止后不再调用大模型和语音接口；控制台仍可打开。</div></div>';
    (document.querySelector('main') || document.querySelector('.main') || document.body).prepend(card);
    button = card.querySelector('#interactionToggle');
    status = card.querySelector('#interactionStatus');
    hint = card.querySelector('#interactionHint');
    button.onclick = async () => {
      if (!state || pending) return;
      pending = true; button.disabled = true;
      try {
        const r = await fetch('/api/control', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: state.enabled ? 'interaction-stop' : 'interaction-start' }) });
        const data = await r.json();
        if (!r.ok || data.error) throw new Error(data.error || '操作失败');
        apply(data.interaction);
      } catch (err) { hint.textContent = `操作未确认：${err.message}，请重试`; }
      finally { pending = false; button.disabled = false; }
    };
  }
  function apply(next) {
    if (!next || (state && next.generation < state.generation)) return;
    const changed = !state || state.generation !== next.generation || state.enabled !== next.enabled;
    state = next;
    window.aliveInteractionState = state;
    if (button) {
      button.textContent = state.enabled ? '停止互动' : '启动互动';
      button.style.background = state.enabled ? '#b44646' : '#2f7d5c';
      button.disabled = pending;
      status.textContent = state.enabled ? '● 互动运行中' : '● 互动已停止，不会自动消耗额度';
      status.style.color = state.enabled ? '#237a52' : '#718179';
      hint.textContent = state.enabled ? '自动辩论、弹幕回复和进场欢迎已启用；所有控制窗口关闭约20秒后自动停止。' : `${state.reason}。点击启动后才会调用大模型和语音；控制台服务保持可访问。`;
    }
    if (changed) window.dispatchEvent(new CustomEvent('alive-interaction', { detail: state }));
  }
  window.aliveApplyInteraction = apply;
  async function heartbeat() {
    try {
      const r = await fetch('/api/control', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'interaction-heartbeat' }) });
      if (!r.ok) throw new Error('后台无响应');
      const data = await r.json();
      apply(data.interaction);
    } catch {
      if (status) status.textContent = '后台连接中断，正在重连';
    }
  }
  window.aliveHeartbeatTimer = setInterval(heartbeat, 4000);
  heartbeat();
})();

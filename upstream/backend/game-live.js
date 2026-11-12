/* Optional game composition. Pure chat remains the default, unchanged route. */
(() => {
  const query = new URLSearchParams(location.search);
  const gameLayout = query.get('layout') === 'game';
  const externalCapture = query.get('capture') === 'external';
  const css = document.createElement('style');
  css.textContent = `
    #game-controls {padding:14px 24px;background:#10283f;color:#e9d6ac}
    #game-controls a{color:#abdfec;margin-right:20px}#game-status{margin-left:16px}
    .output #game-controls{display:none}
    #game-screen{display:none}.game-view #game-screen{display:flex;position:relative;background:#081423;
      align-items:center;justify-content:center;overflow:hidden;border:1px solid #d9bd8566;border-radius:18px}
    #game-picture,#game-video{width:100%;height:100%;object-fit:contain}#game-video{display:none}.video-ready #game-video{display:block}.video-ready #game-picture{display:none}#game-placeholder{position:absolute;color:#bed3df}
    #game-invite{display:none}.game-view #game-invite{display:block;position:absolute;bottom:0;left:0;right:0;z-index:4;padding:.65vh 1vw;background:#10283ff2;border-top:1px solid #d9bd85aa;text-align:center;color:#ffdfa1;font-size:clamp(15px,1.35vw,27px);line-height:1.5}
    .output.game-view main{padding-bottom:5vh;position:relative}
    .output.game-view main{grid-template-columns:minmax(0,74fr) minmax(0,26fr);grid-template-rows:minmax(0,1fr) auto;gap:0 1.2vw}
    .game-view #game-screen{grid-column:1;grid-row:1/3}.game-view #stage{grid-column:2;grid-row:1;overflow:hidden}
    .game-view aside{grid-column:2;grid-row:2;padding:1.2vw}.output.game-view #stage #subtitle{font-size:clamp(15px,1.05vw,22px);left:51%;right:1%;top:16%;bottom:auto;max-height:79%;padding:.9vw;line-height:1.75}.output.game-view #stage>iframe{width:49%!important}.output.game-view aside{background:#102c45d9;padding:.7vw}.output.game-view #ledger{margin:0}
    .game-view #ledger{font-size:clamp(12px,1vw,20px);margin-bottom:1vh}.game-view #ledger h2{font-size:1.2vw}
    .game-view .message{font-size:clamp(13px,1vw,21px);padding:6px 0}.game-view aside:before{padding-bottom:6px;margin-bottom:4px}
    .game-view.external-game{background:transparent}.external-game #game-screen{background:transparent;border:0}
    .external-game #game-picture,.external-game #game-placeholder{display:none}
    .external-game #stage{background:linear-gradient(180deg,#15394ddd,#15394d22)}
  `;
  document.head.append(css);
  const controls=document.createElement('nav');controls.id='game-controls';
  controls.innerHTML='<a href="/?view=stream&audio=direct&layout=game">游戏直播画面</a><a href="/?view=stream&audio=direct">纯聊天画面</a><button id="game-start">开启自主操作</button><button id="game-pause">暂停游戏操作</button><button id="game-review">让她复盘</button><span id="game-status">检查游戏模块…</span>';
  document.querySelector('header').after(controls);
  const nextLabel=document.createElement('label');nextLabel.style.marginLeft='16px';
  nextLabel.innerHTML='<input id="game-auto-next" type="checkbox"> 本局结束后自动下一局（保留游戏设置）';controls.append(nextLabel);
  nextLabel.querySelector('input').onchange=e=>post('/api/game/control',{autoNext:e.target.checked}).catch(showError);
  const panel=document.createElement('section');panel.id='game-screen';
  panel.innerHTML='<img id="game-picture" alt="当前游戏画面"><span id="game-placeholder">等待游戏画面</span>';
  const video=document.createElement('video');video.id='game-video';video.autoplay=true;video.muted=visualOnly;video.volume=.6;video.playsInline=true;panel.prepend(video);
  let streaming=false;
  if(gameLayout&&!externalCapture){const script=document.createElement('script');script.src='/game-video.js';script.onload=()=>window.startGameVideo(video,active=>{streaming=active;panel.classList.toggle('video-ready',active);if(active)document.querySelector('#game-placeholder').hidden=true;});document.head.append(script);}
  document.querySelector('main').prepend(panel);
  const invite=document.createElement('div');invite.id='game-invite';
  invite.textContent='弹幕可以指挥大肥鱼！试试「展开基地车」「造发电厂」「派坦克侦察」 · 聊天也欢迎';
  document.querySelector('main').append(invite);
  if(gameLayout)document.body.classList.add('game-view');
  if(gameLayout&&externalCapture)document.body.classList.add('external-game');
  async function post(path,body){const c=await(await fetch('/api/config')).json();const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Pilot-Token':c.token},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Error(data.error||'操作失败');return data;}
  controls.querySelector('#game-start').onclick=()=>post('/api/game/control',{enabled:true}).catch(showError);
  controls.querySelector('#game-pause').onclick=()=>post('/api/game/control',{enabled:false}).catch(showError);
  controls.querySelector('#game-review').onclick=()=>post('/api/game/review',{}).then(r=>{document.querySelector('#game-status').textContent='已保存 '+r.lessons.length+' 条待验证经验'}).catch(showError);
  controls.querySelectorAll('a')[1].onclick=async e=>{e.preventDefault();try{await post('/api/game/control',{mode:'chat'});location.href=e.target.href;}catch(err){showError(err)}};
  function showError(e){document.querySelector('#game-status').textContent=e.message;}
  async function status(){try{const s=await(await fetch('/api/game/status')).json();controls.hidden=!s;if(s){document.querySelector('#game-status').textContent=s.status+' · 待处理 '+s.queued+' · 经验 '+s.lessons.length+' · 本地等待 '+(s.localWaits||0)+' 次'+(s.error?' · '+s.error:'');nextLabel.querySelector('input').checked=!!s.autoNext;}}catch(e){showError(e)}finally{setTimeout(status,2500)}}status();
  const usage=document.createElement('small');usage.style.display='block';controls.append(usage);
  async function usageStatus(){try{const r=await(await fetch('/api/ledger')).json();const names={decision:'决策',classification:'弹幕分类',chat:'聊天',report:'指令回复',review:'复盘',unclassified:'历史未分类'};usage.textContent=Object.entries(r?.usageCategories||{}).map(([k,v])=>(names[k]||k)+' '+v.tokens.toLocaleString()+' Token（'+v.calls+'次）').join(' · ');}catch(e){usage.textContent='用量暂时不可用';}finally{setTimeout(usageStatus,5000)}}usageStatus();
  // At most ten requests/s; one in flight, shared capture and no work in hidden previews.
  // Native game capture remains available for a full 30/60 fps broadcast.
  async function frame(){if(!gameLayout||externalCapture)return;try{if(document.hidden||streaming)return;const r=await fetch('/api/game/frame',{signal:AbortSignal.timeout(6000)});if(!r.ok)throw Error();const f=await r.json();if(!/^data:image\/(png|jpeg);base64,/.test(f.dataUrl))throw Error();document.querySelector('#game-picture').src=f.dataUrl;document.querySelector('#game-placeholder').hidden=true;}catch(e){if(!streaming)document.querySelector('#game-placeholder').hidden=false;}finally{setTimeout(frame,1000)}}frame();
  async function replies(){
    // The control page must not take the broadcast's exclusive reply lease.
    if(visualOnly||!streamOutput)return;
    if(!config?.game){setTimeout(replies,2000);return;}
    if(busy||audioBlocked||!audio.paused){setTimeout(replies,1000);return;}
    try{busy=true;const r=await post('/api/game/next',{session});if(r.reply){const v=r.reply;message(v.comment?.name||'观众',v.comment?.text||'');message('大肥鱼',v.text);$('#subtitle').textContent=v.text;if(v.warning)$('#error').textContent=v.warning;if(v.audio)await speak(v.audio);}}
    catch(e){showError(e)}finally{busy=false;setTimeout(replies,1000)}
  }replies();
  // The local control page can exercise classification without reading the real live room.
  const originalSubmit=$('#chat-form').onsubmit;
  $('#chat-form').onsubmit=async e=>{
    if(!config?.game)return originalSubmit(e);
    e.preventDefault();const text=$('#comment').value.trim();if(!text)return;
    try{await post('/api/game/message',{name:'本地观众',text,id:crypto.randomUUID()});$('#comment').value='';state('已进入游戏互动队列');}catch(err){showError(err)}
  };
})();

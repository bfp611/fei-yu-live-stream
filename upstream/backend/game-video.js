/* Game audio/video receiver. The source owns the sole game instance. */
window.startGameVideo = function(video, onState) {
  const enableSound=document.createElement('button');enableSound.textContent='启用游戏声音';enableSound.hidden=true;
  enableSound.style='position:absolute;bottom:12px;left:12px;z-index:5';video.parentElement.append(enableSound);
  async function playMedia(){try{await video.play();enableSound.hidden=true;}catch{enableSound.hidden=false;}}
  enableSound.onclick=()=>{video.muted=false;playMedia();};
  let peer=null, id=null, token=null, dead=false, answering=false, appliedAnswer=null, touched=0, started=0;
  const endpoint='/api/game/video';
  async function send(body){const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-Video-Token':token},body:JSON.stringify(body)});if(!r.ok)throw Error('Video signal unavailable');}
  function reset(){peer?.close();peer=null;video.srcObject=null;id=null;answering=false;appliedAnswer=null;onState(false);}
  async function poll(){
    try{
      const r=await fetch(endpoint);if(!r.ok)throw Error();const data=await r.json();token=data.token;
      if(!peer){
        if(data.signal){onState(false);return;}
        id=crypto.randomUUID();const current=new RTCPeerConnection({iceServers:[]});peer=current;started=Date.now();
        current.addTransceiver('video',{direction:'recvonly'});
        current.addTransceiver('audio',{direction:'recvonly'});
        current.ontrack=e=>{video.srcObject=e.streams[0];playMedia();};
        current.onconnectionstatechange=()=>{if(peer===current)onState(current.connectionState==='connected');};
        await current.setLocalDescription(await current.createOffer());
        await new Promise(resolve=>{if(current.iceGatheringState==='complete')return resolve();const timer=setTimeout(resolve,2500);current.addEventListener('icegatheringstatechange',()=>{if(current.iceGatheringState==='complete'){clearTimeout(timer);resolve();}});});
        if(dead||peer!==current)return;
        await send({kind:'offer',id,sdp:current.localDescription.sdp});touched=Date.now();
      }else{
        if(data.signal?.id!==id)throw Error('Video lease changed');
        if(appliedAnswer&&data.signal.answer!==appliedAnswer)throw Error('Game video source replaced');
        if(data.signal.answer&&!answering){answering=true;await peer.setRemoteDescription({type:'answer',sdp:data.signal.answer});appliedAnswer=data.signal.answer;}
        if(Date.now()-touched>3000){await send({kind:'heartbeat',id,values:{fps:Number(video.dataset.fps)||0,frames:Number(video.dataset.frames)||0,dropped:Number(video.dataset.dropped)||0,width:video.videoWidth,height:video.videoHeight,timestamp:Date.now()}});touched=Date.now();}
        if(['failed','closed'].includes(peer.connectionState)||(Date.now()-started>20000&&peer.connectionState!=='connected'))throw Error('Video disconnected');
      }
    }catch{if(id&&token)send({kind:'close',id}).catch(()=>{});reset();}
    finally{if(!dead)setTimeout(poll,750);}
  }
  video.addEventListener('playing',()=>onState(true));
  let lastFrames=0,lastSample=performance.now();
  const meter=setInterval(()=>{const now=performance.now(),quality=video.getVideoPlaybackQuality();video.dataset.fps=((quality.totalVideoFrames-lastFrames)*1000/(now-lastSample)).toFixed(1);video.dataset.frames=String(quality.totalVideoFrames);video.dataset.dropped=String(quality.droppedVideoFrames);video.dataset.size=video.videoWidth+'x'+video.videoHeight;lastFrames=quality.totalVideoFrames;lastSample=now;},1000);
  addEventListener('pagehide',()=>{dead=true;clearInterval(meter);if(id&&token)fetch(endpoint,{method:'POST',keepalive:true,headers:{'Content-Type':'application/json','X-Video-Token':token},body:JSON.stringify({kind:'close',id})}).catch(()=>{});reset();},{once:true});
  poll();
};

import {createAvatarController} from './controller.mjs'
try{
 const config=await(await fetch('/api/config')).json(),catalog=await(await fetch('/api/avatar/render')).json()
 const stage=document.querySelector('#stage'),app=new PIXI.Application({resizeTo:stage,backgroundAlpha:0,antialias:true,resolution:Math.min(devicePixelRatio||1,2),autoDensity:true});stage.append(app.view)
 catalog.settings.url=location.origin+'/model/'+catalog.modelFile
 const model=await PIXI.live2d.Live2DModel.from(catalog.settings,{autoInteract:false,autoUpdate:false,motionPreload:'NONE',idleMotionGroup:'__no_idle__'});app.stage.addChild(model)
 const internal=model.internalModel;const fit=()=>{const scale=Math.min(stage.clientWidth/internal.originalWidth,stage.clientHeight/internal.originalHeight)*.96;model.scale.set(scale);model.position.set((stage.clientWidth-internal.originalWidth*scale)/2,(stage.clientHeight-internal.originalHeight*scale)/2)};fit();addEventListener('resize',fit)
 async function receipt(id,state){if(id)await fetch('/api/avatar/ack',{method:'POST',headers:{'Content-Type':'application/json','X-Pilot-Token':config.token},body:JSON.stringify({id,state})})}
 const controller=createAvatarController(internal.coreModel,catalog,(id,state)=>{receipt(id,state).catch(()=>{})});let level=0,after=0,lastSync=0
 addEventListener('message',e=>{if(e.source!==parent||e.origin!==location.origin||e.data?.type!=='sync')return;level=Number.isFinite(e.data.level)?Math.max(0,Math.min(1,e.data.level)):0;lastSync=performance.now()})
 const original=internal.updateNaturalMovements?.bind(internal)
 internal.updateNaturalMovements=(...args)=>{original?.(...args);controller.update(performance.now()/1000,performance.now()-lastSync<1000?level:0)}
 app.ticker.maxFPS=60;app.ticker.add(()=>model.update(app.ticker.deltaMS))
 async function poll(){try{const response=await fetch('/api/avatar/events?after='+after);if(!response.ok)throw Error('Avatar event service unavailable');for(const e of await response.json()){after=e.id;controller.select(e,performance.now()/1000);await receipt(e.id,(e.expression==='keep'||e.expression==='neutral')&&(e.motion==='none'||e.motion==='stop')?'completed':'playing')}}catch(e){document.querySelector('#error').textContent=e.message}finally{setTimeout(poll,300)}};poll()
 window.avatarReady=true;window.avatarParameters=controller.parameters();parent.postMessage({type:'lane-ready'},location.origin)
}catch(e){document.querySelector('#error').textContent=e.message;window.avatarError=e.message}

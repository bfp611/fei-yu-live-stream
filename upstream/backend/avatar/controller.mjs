import {DriverPipeline,blendExpression} from './upstream/driver-pipeline.mjs'
import {sampleMotion} from './upstream/motion-sampling.mjs'

// Caller supplies the same clock used by audio/video; no text/emotion guessing.
export function createAvatarController(core,catalog,notify=()=>{}){
 const params=new Map();for(let i=0;i<core.getParameterCount();i++){
  const id=core._model.parameters.ids[i];params.set(id,{value:core.getParameterValueById(id),min:core.getParameterMinimumValue(i),max:core.getParameterMaximumValue(i)})
 }
 const physics=new Set(catalog.physicsOutputs||[]);let expression=null,motion=null,level=0,now=0
 const controlled=new Set(),set=(id,v)=>{const p=params.get(id);if(p&&!physics.has(id)&&Number.isFinite(v)){controlled.add(id);core.setParameterValueById(id,Math.max(p.min,Math.min(p.max,v)))}}
 const pending=new Set();function finish(state='completed'){for(const id of pending){if(expression?.plan.id!==id&&motion?.plan.id!==id){notify(id,state);pending.delete(id)}}}
 function select(plan,t){

  if(plan.expression==='neutral')expression=null
  else if(plan.expression!=='keep'&&catalog.expressions[plan.expression])expression={plan,start:t,data:catalog.expressions[plan.expression]}
  if(plan.motion==='stop')motion=null
  else if(plan.motion!=='none'&&catalog.motions[plan.motion])motion={plan,start:t,data:catalog.motions[plan.motion]}
  finish('superseded');if(plan.id)pending.add(plan.id)
 }
 const pipeline=new DriverPipeline().add('restore',0,()=>{for(const id of controlled)set(id,params.get(id).value)})
 .add('motion',10,()=>{if(!motion)return;const {plan,start,data}=motion;const elapsed=now-start,duration=Number(data.Meta?.Duration)||plan.seconds;const end=Math.min(plan.seconds,duration);if(elapsed>=end){motion=null;return}const fade=Math.min(1,elapsed/.2,(end-elapsed)/.25);for(const c of data.Curves||[]){if(c.Target!=='Parameter'||!params.has(c.Id))continue;const base=params.get(c.Id).value;set(c.Id,base+(sampleMotion(c.Segments,elapsed)-base)*fade)}})
 .add('expression',20,()=>{if(!expression)return;const {plan,start,data}=expression;const elapsed=now-start;if(elapsed>=plan.seconds){expression=null;return}const weight=Math.min(1,elapsed/.2,(plan.seconds-elapsed)/.2);for(const p of data.Parameters||[])if(params.has(p.Id))set(p.Id,blendExpression(core.getParameterValueById(p.Id),p.Value,weight,p.Blend||'Add'))})
 .add('mouth',30,()=>set('ParamMouthOpenY',Math.max(0,Math.min(1,level))))
 return {select,update:(t,mouth=0)=>{now=t;level=mouth;pipeline.run({});finish()},parameters:()=>[...params.keys()],stages:()=>pipeline.names()}
}

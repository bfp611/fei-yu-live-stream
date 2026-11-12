// Optional model-selected performance; no sentiment-to-action rules.
export function createPerformanceController({model,catalog,clock,film,metrics,cfg,started=0}) {
let expressionState=null,motionState=null,gestureState=null,pendingGesture=null;
const core=model.internalModel.coreModel,expressionDefaults={};
for(const expr of Object.values(catalog.expressions))for(const p of expr.Parameters)expressionDefaults[p.Id]=core.getParameterValueById(p.Id);
async function perform(plan){
 if(!plan)return;
 const now=clock()*cfg.speed;
 if(plan.expression==='neutral')expressionState=null;
 else if(plan.expression!=='keep'&&catalog.expressions[plan.expression])expressionState={name:plan.expression,start:now,end:now+plan.duration};
 if(['hand_on_chest','point'].includes(plan.motion)){
   if(!gestureState){gestureState={name:plan.motion,start:now,end:now+Math.max(2,plan.duration),phase:'hold'};await model.motion(plan.motion+'_enter',0,3)}
   else if(gestureState.name===plan.motion&&gestureState.phase==='hold')gestureState.end=now+Math.max(2,plan.duration);
   else pendingGesture=plan;
 }else if(plan.motion!=='none')motionState={name:plan.motion,start:now,end:now+plan.duration};
 metrics.performances.push({wall:clock(),source:film.currentTime,selected:plan,expression:expressionState?.name||'neutral',motion:motionState?.name||'none',gesture:gestureState?.name||'none'});
}
function animatePerformance(){
 const now=started===null?0:clock()*cfg.speed;
 for(const [id,v] of Object.entries(expressionDefaults))core.setParameterValueById(id,v);
 if(expressionState){let e=expressionState;if(now>=e.end)expressionState=null;else{let w=Math.min(1,(now-e.start)/.25,(e.end-now)/.25);for(const p of catalog.expressions[e.name].Parameters){let base=expressionDefaults[p.Id];let value=p.Blend==='Add'?base+p.Value*w:p.Blend==='Multiply'?base*(1+(p.Value-1)*w):base*(1-w)+p.Value*w;core.setParameterValueById(p.Id,value)}}}
 if(gestureState&&now>=gestureState.end){const prev=gestureState;if(prev.phase==='hold'){gestureState={...prev,phase:'exit',end:now+1.3};model.motion(prev.name+'_exit',0,3)}else{gestureState=null;if(pendingGesture){const next=pendingGesture;pendingGesture=null;perform({...next,expression:'keep'})}}}
 for(const id of ['AngleX','AngleY','AngleZ'])core.setParameterValueById(id,0);
 if(motionState){let m=motionState,t=(now-m.start)/(m.end-m.start);if(t>=1){motionState=null;if(['hand_on_chest','point'].includes(m.name))model.motion(m.name+'_exit',0,3)}else{const w=Math.sin(Math.PI*Math.max(0,t));if(m.name==='nod')core.setParameterValueById('AngleY',-12*Math.sin(t*Math.PI*2)*w);if(m.name==='shake_head')core.setParameterValueById('AngleX',15*Math.sin(t*Math.PI*4)*w);if(m.name.startsWith('tilt_'))core.setParameterValueById('AngleZ',(m.name==='tilt_left'?-12:12)*w)}}
}
return {perform, update:animatePerformance, snapshot:()=>({expression:expressionState?.name||'neutral',motion:motionState?.name||'none',gesture:gestureState?.name||'none'})};
}

import { defineTool } from '@deepseek-ai/dsh-tools'
export function registerAvatarTools(ctx,config){
 const base=`http://127.0.0.1:${config.port||3088}`
 const read=async path=>{const r=await fetch(base+path,{signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error('Live2D 服务暂不可用');return r.json()}
 const output={schema:{type:'json'},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]}
 const add=(name,description,parameters,execute)=>ctx.tools.register(defineTool({name,description,parameters,output,isConcurrencySafe:()=>false,execute}))
 add('live2d_catalog','查询当前模型实际支持的表情和动作。由你决定是否使用，不根据台词自动猜测情绪。',{},()=>read('/api/avatar/catalog'))
 add('live2d_status','查询动作回执；queued 仅代表排队，playing 才表示画面开始播放。',{},()=>read('/api/avatar/status'))
 add('live2d_perform','选择 catalog 中的表情或动作，可保持、恢复中性或停止。只控制模型，不更改模型文件。',{expression:{type:'string'},motion:{type:'string'},seconds:{type:'number'}},async args=>{
  const {token}=await read('/api/config');const r=await fetch(base+'/api/avatar/perform',{method:'POST',signal:AbortSignal.timeout(5000),headers:{'Content-Type':'application/json','Origin':base,'X-Pilot-Token':token},body:JSON.stringify(args)});if(!r.ok)throw Error('动作无效或舞台不可用，请先查询 catalog');return r.json()
 })
}

// 离线总开关测试：拦截fetch，不调用任何真实收费服务。
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { InteractionSession } from '../lib/interaction-session.mjs';
import { LLM } from '../llm.mjs';
import { TTS } from '../tts.mjs';
let count = 0;
function check(name, fn) { fn(); console.log(`PASS ${name}`); count++; }
let now = 100000;
const session = new InteractionSession({now:() => now});
check('默认停止，信号已取消', () => { assert.equal(session.active,false); assert.equal(session.signal.aborted,true); });
session.start(); const firstGeneration=session.generation; const oldSignal=session.signal;
now+=19000; assert.equal(session.active,true);session.heartbeat();now+=19000;
check('心跳续期，后台/隐藏窗口仍在线时不误停', () => assert.equal(session.active,true));
now+=1001;
check('所有窗口失联20秒后禁止收费请求', () => assert.equal(session.active,false));
session.stop('窗口已关闭'); session.start();
check('重新启动新会话，旧任务不能复活', () => { assert.equal(oldSignal.aborted,true);assert.equal(session.valid(firstGeneration),false); });
session.stop();
const dir=await mkdtemp(join(tmpdir(),'alive-runtime-unit-'));
const originalFetch=globalThis.fetch;
let requests=0;
try {
  const config={llm:{enabled:true,apiKey:'offline',model:'fake',baseUrl:'http://never-called.invalid'},tts:{enabled:true,provider:'volc',volcApiKey:'offline',voice:'fake',rate:20,pitch:0}};
  const llm=new LLM(config,new URL('../persona.md',import.meta.url));
  const tts=new TTS(config,dir); llm.session=session;tts.session=session;
  globalThis.fetch=(url,{signal})=>{
    requests++;
    return new Promise((resolve,reject)=>{
      if(signal.aborted)return reject(signal.reason);
      signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
    });
  };
  await llm.debateLine({side:'fish',topic:'测试'});
  await llm.judgeTopic('测试');await llm.debateReply({side:'fish',message:{text:'你好'}});
  await llm.reply({message:{text:'你好'},state:{}});await tts.synth('测试语音');
  check('停止时所有模型和语音入口均零请求',()=>assert.equal(requests,0));
  session.start();
  const model=llm.debateLine({side:'fish',topic:'测试'});
  const audio=tts.synth('待取消的语音');
  while(requests<2)await tick();
  session.stop();
  const answers=await Promise.all([model,audio]);
  check('停止取消在途模型和语音，不继续重试',()=>{assert.deepEqual(answers,[null,null]);assert.equal(requests,2);});
  await tts.synth('停止后不得重试');
  check('停止后后续请求继续被挡住',()=>assert.equal(requests,2));
  session.start();
  check('启动可恢复请求权限，旧信号仍保持取消',()=>{assert.equal(session.active,true);assert.equal(oldSignal.aborted,true);});
  let active=0,peak=0;
  const releases=[];
  tts.volcSynth=()=>new Promise(resolve=>{
    active++;peak=Math.max(peak,active);
    releases.push(()=>{active--;resolve(Buffer.alloc(1024));});
  });
  const parallel=[tts.synth('角色甲发言'),tts.synth('角色乙发言'),tts.synth('后台试听')];
  while(releases.length<1)await tick();
  check('正式发言和试听同时触发，只发出1个语音请求',()=>{assert.equal(releases.length,1);assert.equal(active,1);});
  for(let i=0;i<3;i++){
    while(releases.length<=i)await tick();
    releases[i]();
  }
  const sounds=await Promise.all(parallel);
  check('全部语音依次完成，峰值并发始终为1',()=>{assert.equal(peak,1);assert.equal(sounds.filter(Boolean).length,3);});
  session.stop();
} finally {
  globalThis.fetch=originalFetch;
  assert.ok(resolve(dir).startsWith(resolve(tmpdir(),'alive-runtime-unit-')));
  await rm(dir,{recursive:true,force:true});
}
console.log(`\n${count} 项总开关离线检查通过。`);

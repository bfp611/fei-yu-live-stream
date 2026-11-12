// 便携包启动器：只用包内Node，不安装系统服务、不修改注册表、不结束其他应用。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root=dirname(fileURLToPath(import.meta.url));
const port=Number(process.env.PORT || 3088);
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('PORT需要是1024–65535的整数');
const url=`http://127.0.0.1:${port}`;
const check=process.argv.includes('--check');
const noBrowser=process.argv.includes('--no-browser');
const env={...process.env,PORT:String(port),HOST:'127.0.0.1'};
delete env.ELECTRON_RUN_AS_NODE;
// 不继承AI工具的付费API Key，用户只用本机控制台保存的Key。
delete env.DEEPSEEK_API_KEY;
const args={cwd:root,env,windowsHide:true};
function browser(address){
  if(noBrowser)return;
  const command=process.platform==='darwin'?'open':process.platform==='win32'?'rundll32':'xdg-open';
  const list=process.platform==='win32'?['url.dll,FileProtocolHandler',address]:[address];
  const child=spawn(command,list,{...args,stdio:'ignore',detached:true});
  child.on('error',()=>console.log('请手动打开：'+address));child.unref();
}
for(const name of ['server.mjs','config.default.json','node_modules/ws/package.json','node_modules/protobufjs/package.json'])if(!existsSync(join(root,name)))throw Error('缺少文件：'+name+'。请先完整解压，不要直接在压缩包里运行。');
console.log('Alive 免费公开便携版 0.2.0');
console.log(`运行环境：Node ${process.version} / ${process.platform} ${process.arch}`);
if(check){console.log('检查通过；未启动后台、未联网下载、未调用任何模型。');process.exit(0);}
let alive=false;
try{
  const r=await fetch(url+'/health',{signal:AbortSignal.timeout(1200)});const j=await r.json();
  if(j.app==='alive-portable'&&j.release==='0.2.0')alive=true;
  else throw Error('OTHER_SERVICE');
}catch(err){
  if(err.message==='OTHER_SERVICE'){console.error(`端口${port}已有其他服务或旧版本，未结束任何进程。请让AI核对该进程；或设置PORT为另一个空闲端口。`);process.exit(1);}
  if(!['ECONNREFUSED','ECONNRESET'].includes(err.cause?.code)){
    // TCP可连接但不是本程序，不能用第二个服务去抢端口。
    try{const r=await fetch(url,{signal:AbortSignal.timeout(1000)});if(r){console.error('端口已占用；未停止任何应用。请更换PORT。');process.exit(1);}}catch{}
  }
}
mkdirSync(join(root,'data'),{recursive:true});
if(!alive){
  const log=openSync(join(root,'data','server.log'),'a');
  const child=spawn(process.execPath,['server.mjs'],{...args,detached:true,stdio:['ignore',log,log]});
  child.unref();closeSync(log);
  child.on('error',err=>console.error('后台启动失败：'+err.message));
  for(let i=0;i<80;i++){
    await new Promise(r=>setTimeout(r,150));
    try{const j=await(await fetch(url+'/health',{signal:AbortSignal.timeout(500)})).json();if(j.app==='alive-portable'){alive=true;break;}}catch{}
  }
  if(!alive){console.error('后台未就绪，请让AI查看data/server.log；请勿修改Key或重复购买额度来解决启动错误。');process.exit(1);}
  writeFileSync(join(root,'data','server.pid'),String(child.pid));
}
console.log('控制台：'+url+'/control');
console.log('启动后默认「互动已停止」；配置完成并决定产生用量后再点「启动互动」。');
console.log('关闭所有控制台/有声舞台约20秒会自动停止；无需关闭Node来防止扣费。');
browser(url+'/control');

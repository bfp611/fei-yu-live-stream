// 调试伴侣连接器。Windows仅提供兼容探测，不承诺所有版本支持CDP/DOM采集。
import {spawn,spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,openSync,closeSync,readdirSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import { launchCompanion } from './lib/companion-launch.mjs';
const root=dirname(fileURLToPath(import.meta.url));
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const cdp=process.env.CDP||'http://127.0.0.1:9222';
const appUrl=(process.env.APP||`http://127.0.0.1:${process.env.PORT||3088}`).replace(/\/$/, '');
const healthUrl=`http://127.0.0.1:${process.env.COLLECTOR_PORT||3089}/health`;
function ownsCollector(data){return data.target===appUrl&&data.cdp===cdp&&data.root===root;}
async function existingCollector(){
  let data;
  try{data=await(await fetch(healthUrl,{signal:AbortSignal.timeout(1000)})).json();}catch{return null;}
  if(data.app!=='alive-gift-collector'||!ownsCollector(data)){
    throw new Error('采集端口已由其他项目或旧版采集器使用，请先关闭原采集器；未改动其他进程。');
  }
  return data;
}
async function companionPage(){
  try{const pages=await(await fetch(cdp+'/json',{signal:AbortSignal.timeout(1200)})).json();return pages.find(p=>p.type==='page'&&(/抖音.*伴侣|直播伴侣|Douyin.*(?:Mate|Live)/i.test(p.title||'')||/Douyin(?:%20| )Webcast/.test(p.url||'')));}catch{return null;}
}
async function collector(){
  mkdirSync(join(root,'data'),{recursive:true});
  const log=openSync(join(root,'data','companion.log'),'a');
  const p=spawn(process.execPath,[join(root,'tools/companion-dom.mjs')],{cwd:root,env:{...env,CDP:cdp,APP:appUrl},detached:true,windowsHide:true,stdio:['ignore',log,log]});
  let failure='';p.on('error',err=>{failure=err.message;});
  p.on('exit',code=>{failure=`采集器退出（${code}），请检查 data/companion.log`;});
  p.unref();closeSync(log);
  for(let i=0;i<30;i++){
    if(failure)throw new Error(failure);
    if(await existingCollector()){
      console.log('礼物采集器已启动；首次只记录基线，不补播旧礼物。');
      console.log('日志 data/companion.log；本操作不会开播，也不会启用付费互动。');
      return;
    }
    await new Promise(r=>setTimeout(r,100));
  }
  throw new Error('未确认采集器启动，请检查 data/companion.log。');
}
let existing;
try{existing=await existingCollector();if(existing?.connected){console.log('当前项目的礼物采集器已运行，直接复用。');process.exit(0);}}
catch(err){console.error(err.message);process.exit(1);}
let page=await companionPage();
if(!page){
  let target=process.env.COMPANION_EXE||process.argv[2];
  if(process.platform==='darwin'){
    target=target||'/Applications/Douyin Webcast Mate.app/Contents/MacOS/Douyin Webcast Mate';
    const running=spawnSync('/usr/bin/pgrep',['-f','^/Applications/Douyin Webcast Mate.app/Contents/MacOS/Douyin Webcast Mate( |$)']);
    if(running.status===0){console.error('伴侣已运行但未开放调试。请先下播并手动退出伴侣，再运行本文件；不会自动结束直播进程。');process.exit(1);}
  }else if(process.platform==='win32'){
    const names=['直播伴侣.exe','抖音直播伴侣.exe','DouyinLive.exe','Douyin Webcast Mate.exe','LiveMate.exe'];
    if(!target){
      const bases=[process.env.LOCALAPPDATA,process.env.ProgramFiles,process.env['ProgramFiles(x86)']].filter(Boolean);
      const dirs=['DouyinLive','Douyin Live','Douyin Webcast Mate','直播伴侣','抖音直播伴侣','Programs/DouyinLive','Programs/直播伴侣'];
      for(const base of bases)for(const dir of dirs)for(const name of names){const p=join(base,dir,name);if(existsSync(p)&&!target)target=p;}
    }
    console.log('Windows伴侣调试/礼物采集尚未实机验证，是否支持取决于伴侣版本；失败不影响后台和网页。');
    const list=spawnSync('tasklist',['/FO','CSV','/NH'],{encoding:'utf8',windowsHide:true}).stdout||'';
    if(names.some(name=>list.toLowerCase().includes(name.toLowerCase()))){console.error('检测到伴侣进程。请先下播并手动退出，再开启调试；未结束任何进程。');process.exit(1);}
  }
  if(!target||!existsSync(target)){
    console.error('未定位到直播伴侣。请先安装官方版本；让AI定位其可执行文件，然后执行：');
    console.error('包内node companion.mjs "直播伴侣可执行文件完整路径"');process.exit(1);
  }
  try {
    const result = await launchCompanion({ target, cdp, env });
    console.log(result.nativeLaunch ? `已通过 macOS 系统启动器打开伴侣${result.appleSilicon ? '（原生 Apple Silicon 启动路径）' : ''}` : '已启动直播伴侣');
  } catch (err) { console.error('启动失败：'+err.message); process.exit(1); }
  for(let i=0;i<60;i++){page=await companionPage();if(page)break;await new Promise(r=>setTimeout(r,500));}
  if(!page){console.error('未获得直播伴侣调试页面。请确认伴侣已正常打开、调试端口未被占用且此版本支持调试模式；没有强制结束任何程序。');process.exit(1);}
}
console.log('已找到调试页面：'+page.title);
if(existing){console.log('复用当前项目采集器，等待重新连接伴侣。');process.exit(0);}
try{await collector();}catch(err){console.error(err.message);process.exitCode=1;}

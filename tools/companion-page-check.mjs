import { mkdtemp, cp, symlink, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import http from 'node:http';
import assert from 'node:assert/strict';
const root=resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture=await mkdtemp(join(tmpdir(),'alive-companion-ui-'));
console.log('Isolated verification directory: '+fixture);
await cp(root,fixture,{recursive:true,filter:p=>!['.git','node_modules','data','config.json','runtime'].includes(p.slice(root.length+1).split('/')[0])});
await symlink(join(root,'node_modules'),join(fixture,'node_modules'),'dir');
const reservation=http.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
const child=spawn(process.execPath,['server.mjs'],{cwd:fixture,env:{...process.env,PORT:String(port),HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe']});
let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
try{
 let ready=false;for(let i=0;i<60;i++){try{ready=(await fetch(`http://127.0.0.1:${port}/health`)).ok;if(ready)break;}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready,logs);
 const base=`http://127.0.0.1:${port}`;
 for(const scene of ['work','debate']){
  const url=base+`/control?scene=${scene}`;
  const html=await(await fetch(url)).text();assert.ok(html.includes('/js/companion-control.js'));
  const profile=join(fixture,'chrome-'+scene);
  const chrome=spawn(process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless','--disable-gpu','--no-first-run','--no-default-browser-check',`--user-data-dir=${profile}`,'--remote-debugging-port=0',url],{stdio:['ignore','ignore','pipe']});
  let chromeLog='';chrome.stderr.on('data',d=>chromeLog+=d);
  let ws;
  try {
    let debugPort;
    for(let i=0;i<200;i++){try{debugPort=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);if(debugPort)break;}catch{}await new Promise(r=>setTimeout(r,100));}
    assert.ok(debugPort,chromeLog);
    const pages=await(await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    const page=pages.find(p=>p.type==='page');assert.ok(page,'no browser tab');
    ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});
    let id=0;const pending=new Map();ws.on('message',d=>{const m=JSON.parse(d);if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}});
    const evaluate=expression=>new Promise((r,j)=>{const seq=++id;const timer=setTimeout(()=>j(new Error('Browser evaluation timed out')),5000);pending.set(seq,m=>{clearTimeout(timer);r(m.result?.result?.value);});ws.send(JSON.stringify({id:seq,method:'Runtime.evaluate',params:{expression,returnByValue:true}}));});
    let found=false;for(let i=0;i<100;i++){found=await evaluate('Boolean(document.getElementById("companionConnect") && document.getElementById("companionStatus"))');if(found)break;await new Promise(r=>setTimeout(r,100));}
    const dom=await evaluate('document.documentElement.outerHTML');await writeFile(join(fixture,scene+'-dom.html'),dom||'');
    assert.ok(found,scene+' button missing; inspect saved DOM');
  } finally {ws?.close();chrome.kill();await writeFile(join(fixture,scene+'-chrome.log'),chromeLog);}
  console.log(`PASS ${scene}: real Chrome renders companion button and status`);
 }
 const stage=await(await fetch(base+'/?view=stream')).text();assert.ok(!stage.includes('/js/companion-control.js'));
 const state=await(await fetch(base+'/api/state')).json();assert.equal(state.interaction.enabled,false);
 console.log('PASS stage has no console button; page loads do not enable interaction');
 const status=await(await fetch(base+'/api/companion')).json();assert.ok(['idle','conflict'].includes(status.state));
 console.log('PASS read-only status endpoint responds without starting collector');
}finally{child.kill();}

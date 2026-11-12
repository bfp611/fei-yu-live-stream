import test from 'node:test'
import assert from 'node:assert/strict'
import {launchArguments,mountService} from '../launcher.mjs'
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import net from 'node:net'
import {once} from 'node:events'
test('configuration rejects remote model bridges and missing game adapter without spawning',()=>{
 const base={home:process.cwd(),persona:new URL('../LICENSE',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1'),jingyuUrl:'http://127.0.0.1:61948/'}
 assert.throws(()=>launchArguments({...base,jingyuUrl:'https://example.com/'}))
 assert.throws(()=>launchArguments(base,'adapter'))
 assert.ok(launchArguments(base).args.includes('--managed'))
})
test('disabled plugin never invokes a process',()=>{
 const ctx={effect:()=>{}};mountService(ctx,{enabled:false},'dsh-live-studio')
})
test('host mount registers a running service and disposal releases the child',async()=>{
 const root=mkdtempSync(join(tmpdir(),'live-mount-')),persona=join(root,'persona.md');writeFileSync(persona,'Test persona')
 const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r))
 const cleanups=[],registry=join(root,'plugin-services','dsh-live-studio.json')
 const ctx={effect:f=>cleanups.push(f()),webServer:{register:()=>()=>{}},connection:{requestRejection:()=>undefined}}
 const until=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setTimeout(r,100))}throw Error('Service timeout')}
 try{
  mountService(ctx,{enabled:true,home:root,persona,port,python:process.env.PYTHON||'python',jingyuUrl:'http://127.0.0.1:61948/'},'dsh-live-studio')
  await until(()=>JSON.parse(readFileSync(registry)).state==='running')
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/service`)).json()).name,'dsh-live-studio')
 }finally{
  for(const cleanup of cleanups)cleanup?.()
  await until(()=>!JSON.parse(readFileSync(registry)).pid)
  rmSync(root,{recursive:true,force:true})
 }
})

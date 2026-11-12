import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, join, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'

export function launchArguments(config, gameBackend) {
  const port = config.port ?? (gameBackend ? 3098 : 3088)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('端口须为 1024–65535')
  if (!config.home || !config.persona) throw Error('请配置 home 与 persona，沿用原目录可保留记录')
  if (!existsSync(resolve(config.persona))) throw Error('角色文件不存在')
  const args = ['-u', fileURLToPath(new URL('./backend/live-pilot-server.py', import.meta.url)),
    '--managed', '--port', String(port), '--home', resolve(config.home), '--persona', resolve(config.persona)]
  if (config.cubismCore) {
    if (!config.model) throw Error('内置舞台需要 model 目录')
    args.push('--model',resolve(config.model),'--cubism-core',resolve(config.cubismCore))
  } else if (config.jingyuUrl) {
    const url = new URL(config.jingyuUrl)
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password) throw Error('鲸语地址须为本机 HTTP 地址')
    args.push('--jingyu-url', url.href)
  } else if (config.model) args.push('--model', resolve(config.model))
  else throw Error('请配置 jingyuUrl 或本机 model 目录')
  if (config.room) {
    if (!Number.isSafeInteger(config.room) || config.room < 1) throw Error('直播间 ID 无效')
    args.push('--live-room', String(config.room))
  }
  for (const [key, flag] of [['credential','--live-credential'],['ledger','--ledger'],['pet','--pet']])
    if (config[key]) args.push(flag, resolve(config[key]))
  if (gameBackend) {
    if (!config.gameSkill || !config.experience) throw Error('游戏模式须配置 gameSkill 与 experience')
    args.push('--game-plugin',gameBackend,'--game-control-skill',resolve(config.gameSkill),'--game-state',resolve(config.experience),
      '--game-channel',config.channel || '1')
  }
  return { executable: config.python || 'python', args, port }
}

export function mountService(ctx, config, name, gameBackend) {
  let child, state='disabled', error=null, stopping=false
  const descriptor=()=>({name,state,error,port:config.port || (gameBackend?3098:3088),pid:child?.pid || null,
    url: `http://127.0.0.1:${config.port || (gameBackend?3098:3088)}/`, updatedAt:Date.now()})
  function persist() {
    if (!config.home) return
    const dir=join(resolve(config.home),'plugin-services');mkdirSync(dir,{recursive:true})
    writeFileSync(join(dir,name+'.json'),JSON.stringify(descriptor()))
  }
  // This registry never contains API keys or credential paths.
  if (config.enabled) {
    const launch=launchArguments(config,gameBackend)
    state='starting';persist()
    child=spawn(launch.executable,launch.args,{windowsHide:true,shell:false,
      env:{...process.env,PYTHONUTF8:'1',DAFEIYU_PREFILL_HOME:resolve(config.home),
        PYTHONPATH:[fileURLToPath(new URL('./backend/prefill_python',import.meta.url)),process.env.PYTHONPATH].filter(Boolean).join(delimiter)},stdio:['pipe','pipe','pipe']})
    let output=''
    child.stdout.on('data',data=>{output=(output+data).slice(-2000);if(output.includes('Local rehearsal:')){state='running';persist()}})
    child.stderr.on('data',()=>{}) // Provider packet bodies must not reach DSH logs.
    child.on('error',()=>{state='failed';error='启动失败，请检查 Python 与依赖';persist()})
    child.on('exit',code=>{state=stopping?'stopped':'failed';error=stopping?null:`服务退出 (${code})`;child=null;persist()})
  } else persist()
  ctx.effect(()=>()=>{stopping=true;state='stopped';child?.stdin.end();persist()},name+': service lifetime')
  ctx.effect(()=>ctx.webServer.register({kind:'exact',path:`/api/${name}/status`,handler:(req,res)=>{
    const rejection=ctx.connection.requestRejection(req)
    if(rejection){res.writeHead(rejection);res.end();return}
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(descriptor()))
  }}),name+': status')
}

import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createCompanionControl } from '../lib/companion-control.mjs';
import { companionLaunchSpec, companionLaunchEnv, isAppleSilicon } from '../lib/companion-launch.mjs';

const macTarget = '/Applications/Douyin Webcast Mate.app/Contents/MacOS/Douyin Webcast Mate';
const nativeSpec = companionLaunchSpec({ target: macTarget, cdp: 'http://127.0.0.1:9334', platform: 'darwin', appleSilicon: true });
assert.equal(nativeSpec.command, '/usr/bin/arch');
assert.deepEqual(nativeSpec.args, ['-arm64', '/usr/bin/open', '-a', '/Applications/Douyin Webcast Mate.app', '--args', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9334']);
assert.ok(!nativeSpec.args.includes('-n'));
assert.equal(nativeSpec.cwd, undefined);
const intelSpec = companionLaunchSpec({ target: macTarget, cdp: 'http://127.0.0.1:9222', platform: 'darwin' });
assert.equal(intelSpec.command, '/usr/bin/open');
const cleanEnv = companionLaunchEnv({ PATH: '/usr/bin', HOME: '/Users/example', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect', DYLD_INSERT_LIBRARIES: 'example', DSH_SESSION_ID: 'example' });
assert.deepEqual(cleanEnv, { PATH: '/usr/bin', HOME: '/Users/example' });
assert.throws(() => companionLaunchSpec({ target: macTarget, cdp: 'http://example.com:9222', platform: 'darwin' }), /本机/);
console.log('PASS Mac 使用系统原生启动路径，不继承 Rosetta 直接启动和工具运行环境，调试端口正确');
assert.equal(isAppleSilicon({ platform: 'darwin', arch: 'x64', probe: () => ({ status: 0, stdout: '1\n' }) }), true);
assert.equal(isAppleSilicon({ platform: 'darwin', arch: 'x64', probe: () => ({ status: 0, stdout: '0\n' }) }), false);
assert.equal(isAppleSilicon({ platform: 'darwin', arch: 'arm64', probe: () => { throw new Error('不应探测'); } }), true);
assert.equal(isAppleSilicon({ platform: 'darwin', arch: 'x64', probe: (_cmd, args) => args[1] === 'hw.optional.arm64' ? { status: 1, stderr: 'unknown oid' } : { status: 0, stdout: 'Intel(R) Core(TM) i7' } }), false);
assert.equal(isAppleSilicon({ platform: 'darwin', arch: 'x64', probe: (_cmd, args) => args[1] === 'hw.optional.arm64' ? { status: 1 } : { status: 0, stdout: 'Apple M2' } }), true);
assert.throws(() => isAppleSilicon({ platform: 'darwin', arch: 'x64', probe: () => ({ status: 1 }) }), /无法确认/);
for (const arch of ['x64', 'arm64']) {
  assert.equal(isAppleSilicon({ platform: 'win32', arch, probe: () => { throw new Error('Windows 不应运行 sysctl'); } }), false);
  const spec = companionLaunchSpec({ target: 'C:\\Program Files\\DouyinLive\\DouyinLive.exe', cdp: 'http://127.0.0.1:9444', platform: 'win32' });
  assert.equal(spec.command, 'C:\\Program Files\\DouyinLive\\DouyinLive.exe');
  assert.equal(spec.cwd, 'C:\\Program Files\\DouyinLive');
  assert.deepEqual(spec.args, ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9444']);
}
assert.throws(() => companionLaunchSpec({ target: '/tmp/app', cdp: 'http://127.0.0.1:9222', platform: 'linux' }), /仅支持/);
console.log('PASS 区分 Apple Silicon、Rosetta、Intel Mac、Windows x64/ARM64；Windows 不使用 Mac 命令');


const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let i = 0; i < 120; i++) { const value = await fn(); if (value) return value; await wait(100); } throw new Error('Timed out'); }
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; }
let collector;
let launchedPid;
let evaluationFails = false;
let stallReads = false;
let stalledRequests = 0;
let cards = ['旧观众\u0001送出\u0001小心心\u0001x1'];
const gifts = [];
const app = http.createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  gifts.push(JSON.parse(body)); res.end('{"ok":true}');
});
const appPort = await listen(app);
const appUrl = `http://127.0.0.1:${appPort}`;
const cdpServer = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify([{ type: 'page', title: '抖音直播伴侣', webSocketDebuggerUrl: `ws://127.0.0.1:${cdpServer.address().port}` }]));
});
const cdpPort = await listen(cdpServer);
const wss = new WebSocketServer({ server: cdpServer });
wss.on('connection', ws => ws.on('message', data => {
  const message = JSON.parse(data);
  if (stallReads) { stalledRequests++; return; }
  ws.send(JSON.stringify({ id: message.id, result: evaluationFails ? { exceptionDetails: { text: 'test evaluation failure' } } : { result: { value: JSON.stringify(cards) } } }));
}));
const reservation = http.createServer();
const collectorPort = await listen(reservation);
await new Promise(r => reservation.close(r));
const env = { ...process.env, APP: appUrl, CDP: `http://127.0.0.1:${cdpPort}`, COLLECTOR_PORT: String(collectorPort) };
const control = createCompanionControl({ root, appUrl, env });
try {
  assert.equal((await control.status()).state, 'idle');
  collector = spawn(process.execPath, ['tools/companion-dom.mjs'], { cwd: root, env, stdio: 'ignore' });
  await until(async () => (await control.status()).state === 'connected');
  assert.equal(gifts.length, 0);
  console.log('PASS 读取伴侣并建立基线，不补发旧礼物');
  cards = [...cards, '新观众\u0001送出\u0001小心心\u0001x1'];
  await until(() => gifts.length === 1);
  assert.deepEqual(gifts[0], { action: 'gift', name: '新观众', gift: '小心心', count: 1, diamond: 1 });
  console.log('PASS 新礼物投递到当前服务地址（随机端口），不使用3088');
  const first = control.start();
  assert.equal(first, control.start());
  assert.equal((await first).state, 'connected');
  console.log('PASS 同时点击共享启动任务，已连接时直接复用');
  const conflict = createCompanionControl({ root, appUrl: 'http://127.0.0.1:1', env });
  assert.equal((await conflict.status()).state, 'conflict');
  await assert.rejects(conflict.start(), /其他项目/);
  assert.equal((await control.status()).state, 'connected');
  console.log('PASS 拒绝复用其他项目采集器，原采集器保持连接');
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ['companion.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d);
    child.once('error', reject); child.once('close', code => resolveResult({ code, output }));
  });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /直接复用/);
  console.log('PASS 命令行启动器也识别当前采集器，避免重复启动');
  evaluationFails = true;
  await until(async () => (await control.status()).state === 'waiting');
  await control.start(); // Waiting collectors must still let the launcher inspect/reopen the companion.
  evaluationFails = false;
  await until(async () => (await control.status()).state === 'connected');
  console.log('PASS 读取异常显示等待状态，重试不重复启动，恢复后重新显示连接');
  collector.kill(); await once(collector, 'exit');
  await control.start();
  const health = await (await fetch(`http://127.0.0.1:${collectorPort}/health`)).json();
  launchedPid = health.pid;
  assert.equal(health.target, appUrl);
  await until(async () => (await control.status()).state === 'connected');
  assert.equal(gifts.length, 1);
  console.log('PASS 启动器实际拉起采集器，并传入当前地址，不重放旧礼物');
  stallReads = true;
  await until(async () => (await control.status()).state === 'waiting');
  assert.equal(stalledRequests, 1);
  stallReads = false;
  await until(async () => (await control.status()).state === 'connected');
  assert.equal(gifts.length, 1);
  console.log('PASS 伴侣卡住时只保留一个读取请求，超时断开后恢复连接，不积压或重播礼物');
  for (const ws of wss.clients) ws.close();
  await until(async () => (await control.status()).state === 'waiting');
  console.log('PASS 伴侣断开后显示等待重连');
} finally {
  if (launchedPid) { try { process.kill(launchedPid); } catch {} }
  if (collector && collector.exitCode === null && collector.signalCode === null) { collector.kill(); await once(collector, 'exit'); }
  for (const ws of wss.clients) ws.terminate();
  await new Promise(r => wss.close(r));
  await Promise.all([new Promise(r => app.close(r)), new Promise(r => cdpServer.close(r))]);
}

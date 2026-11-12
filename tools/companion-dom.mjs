// 读取直播伴侣「礼物卡片」，增量识别礼物；伴侣未启动/重启时自动等待重连
import WebSocket from 'ws';
import http from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const CDP = process.env.CDP || 'http://127.0.0.1:9222';
const APP = (process.env.APP || 'http://127.0.0.1:3088').replace(/\/$/, '');
const collectorState = { app: 'alive-gift-collector', pid: process.pid, target: APP, cdp: CDP,
  root: resolve(dirname(fileURLToPath(import.meta.url)), '..'), connected: false, error: '' };
const health=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(collectorState));});
await new Promise((resolve,reject)=>{health.once('error',reject);health.listen(Number(process.env.COLLECTOR_PORT || 3089),'127.0.0.1',resolve);}).catch(err=>{console.error('采集器端口已占用或无法监听，未终止其他程序：'+err.message);process.exit(1);});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EXPR = `(() => {
  const cards = [...document.querySelectorAll('[data-testid="gift-message-card"]')];
  return JSON.stringify(cards.map((el) => el.innerText.replace(/\\n/g, '\\u0001')));
})()`;

function parseCard(text) {
  const p = text.split('\u0001').map((s) => s.trim()).filter(Boolean);
  const i = p.indexOf('送出');
  if (i < 0) return null;
  const name = p[i - 1];
  const gift = p[i + 1];
  const m = /^x(\d+)$/.exec(p[i + 2] || '');
  if (!name || !gift || !m) return null;
  return { name, gift, count: Number(m[1]) };
}

function appended(prev, seq) {
  const max = Math.min(prev.length, seq.length);
  for (let k = max; k >= 0; k -= 1) {
    let same = true;
    for (let i = 0; i < k; i += 1) {
      if (prev[prev.length - k + i] !== seq[i]) { same = false; break; }
    }
    if (same) return seq.slice(k);
  }
  return seq;
}

async function run() {
  const list = await (await fetch(`${CDP}/json`, { signal: AbortSignal.timeout(3000) })).json();
  const page = list.find((x) => x.type === 'page' && (/抖音.*伴侣|直播伴侣|Douyin.*(?:Mate|Live)/i.test(x.title || '') || /Douyin(?:%20| )Webcast/.test(x.url || '')));
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { handshakeTimeout: 3000 });
  let id = 0; const waiting = new Map();
  const rejectPending = () => {
    for (const pending of waiting.values()) { clearTimeout(pending.timer); pending.reject(new Error('cdp closed')); }
    waiting.clear();
  };
  ws.on('message', (d) => {
    let m; try { m = JSON.parse(d); } catch { return; }
    const pending = waiting.get(m.id);
    if (pending) { clearTimeout(pending.timer); waiting.delete(m.id); pending.resolve(m); }
  });
  ws.on('close', rejectPending);
  ws.on('error', rejectPending);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id;
    const timer = setTimeout(() => { waiting.delete(i); reject(new Error('伴侣读取超时')); ws.terminate(); }, 3000);
    waiting.set(i, { resolve, reject, timer });
    try { ws.send(JSON.stringify({ id: i, method, params })); }
    catch (err) { clearTimeout(timer); waiting.delete(i); reject(err); }
  });
  console.log('[dom] connected', page.title);

  let prev = null;
  let reading = false;
  const timer = setInterval(async () => {
    if (reading || ws.readyState !== WebSocket.OPEN) return;
    reading = true;
    try {
      const r = await send('Runtime.evaluate', { expression: EXPR, returnByValue: true });
      if (r.error || r.result?.exceptionDetails || typeof r.result?.result?.value !== 'string') throw new Error('无法读取伴侣礼物区域');
      const seq = JSON.parse(r.result.result.value);
      if (!Array.isArray(seq)) throw new Error('伴侣礼物数据格式异常');
      collectorState.connected = true; collectorState.error = '';
      if (prev === null) { prev = seq; console.log('[dom] baseline', seq.length); return; }
      const added = appended(prev, seq);
      prev = seq;
      for (const text of added) {
        const g = parseCard(text);
        if (!g) continue;
        console.log('[GIFT]', JSON.stringify(g));
        await fetch(`${APP}/api/control`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'gift', name: g.name, gift: g.gift, count: g.count, diamond: 1 }),
          signal: AbortSignal.timeout(3000)
        }).catch(() => {});
      }
    } catch (e) {
      collectorState.connected = false;
      collectorState.error = `礼物采集暂不可用：${e.message}`;
      console.log('[err]', e.message);
    } finally { reading = false; }
  }, 1000);

  await new Promise((resolve) => {
    ws.on('close', resolve);
    ws.on('error', resolve);
  });
  clearInterval(timer);
  throw new Error('cdp closed');
}

while (true) {
  try {
    await run();
  } catch (e) {
    collectorState.connected = false;
    collectorState.error = `等待直播伴侣重连：${e.message}`;
    console.log('[wait]', e.message, '5s 后重试');
    await sleep(5000);
  }
}

import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SalaryEngine } from './engine.mjs';
import { DouyinSource } from './danmaku.mjs';
import { TTS } from './tts.mjs';
import { LLM } from './llm.mjs';
import { ReplyBank } from './replies.mjs';
import { Debate } from './scenes/debate.mjs';
import { InteractionSession } from './lib/interaction-session.mjs';
import { createCompanionControl } from './lib/companion-control.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 3088);
const HOST = process.env.HOST || '127.0.0.1';
const companionHost = HOST === '0.0.0.0' ? '127.0.0.1' : HOST === '::' ? '[::1]' : HOST.includes(':') ? `[${HOST}]` : HOST;
const companionControl = createCompanionControl({ root: ROOT.replace(/[\\/]$/, ''), appUrl: `http://${companionHost}:${PORT}` });

const DEFAULTS = JSON.parse(await readFile(join(ROOT, 'config.default.json'), 'utf8'));
const CONFIG_PATH = join(ROOT, 'config.json');
let config = DEFAULTS;
if (existsSync(CONFIG_PATH)) {
  try {
    config = deepMerge(DEFAULTS, JSON.parse(await readFile(CONFIG_PATH, 'utf8')));
  } catch (err) {
    console.warn('[config] config.json 解析失败，使用默认配置：', err.message);
  }
}
if (!existsSync(CONFIG_PATH)) await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));

/* ------------------------------------------------------------------
   场景（scene）
   一个后端、一个直播间连接、一套语音/LLM，只换“当前在演哪一出”。
   场景之间的差异全部落在 config.scenes[id] 里：
     人物设定 persona / 规则 salary·rules / 语音 tts.voice / 背景乐 bgm / 冷场 idle / 页面 ui
   config 顶层的 persona·salary·ui·idle·tts 始终是“当前场景的投影”，
   这样 V1 的 engine/tts/页面不用改一行就能照常工作。
------------------------------------------------------------------ */
const SCENE_ORDER = ['work', 'debate'];
const DEFAULT_FISH_PERSONA =
  '你是大鲵（也叫大肥鱼），海底办公室的老员工。嘴贫、护着打工人、爱摸鱼，被怼了会炸毛但马上嘴硬回来。你说话像直播间随口怼人：短、有梗、带点撒娇和自嘲，不讲大道理。';
const DEFAULT_DOU_PERSONA =
  '你是豆包，理性、讲效率、有点小傲娇的 AI 助理。说话短、逻辑清楚，喜欢用反问和举例压人，不刻薄、不人身攻击，偶尔阴阳怪气。';

function fillDebateDefaults() {
  const d = config.scenes?.debate;
  if (!d) return false;
  let changed = false;
  d.actors = d.actors || {};
  for (const [side, persona] of [['fish', DEFAULT_FISH_PERSONA], ['doubao', DEFAULT_DOU_PERSONA]]) {
    const a = (d.actors[side] = d.actors[side] || {});
    if (!a.persona) { a.persona = persona; changed = true; }
    if (!Number.isFinite(Number(a.rate))) { a.rate = 20; changed = true; }
    if (!Number.isFinite(Number(a.volume))) { a.volume = 1; changed = true; }
  }
  d.idle = d.idle || {};
  if (!Array.isArray(d.idle.topics)) {
    d.idle.topics = ['该不该在上班时间摸鱼', '年轻人该先攒钱还是先享受生活', '朋友之间该不该借钱'];
    changed = true;
  }
  d.ui = d.ui || {};
  if (!d.ui.placeholder) { d.ui.placeholder = '发一条弹幕，出个辩题'; changed = true; }
  return changed;
}
const PAGES = {
  work: { stage: 'index.html', console: 'control.html' },
  debate: { stage: 'debate.html', console: 'debate-console.html' }
};

function normalizeScenes(force = false) {
  if (!config.scenes || typeof config.scenes !== 'object') config.scenes = {};
  if (force || !config.scenes.work) {
    config.scenes.work = {
      label: '工作摸鱼',
      persona: config.persona,
      salary: config.salary,
      ui: config.ui,
      idle: config.idle,
      tts: { voice: config.tts?.voice, rate: config.tts?.rate, pitch: config.tts?.pitch },
      bgm: { track: config.scenes.work?.bgm?.track || '' }
    };
  }
  if (force || !config.scenes.debate) {
    const d = config.debate || {};
    const prev = config.scenes.debate || {};
    config.scenes.debate = {
      label: 'AI 辩论赛',
      banner: d.banner || prev.banner || 'AI 辩论赛 · 谁更懂人类',
      actors: {
        fish: {
          name: d.fishName || prev.actors?.fish?.name || '大鲵',
          voice: d.fishVoice || prev.actors?.fish?.voice || config.tts?.voice || '',
          persona: prev.actors?.fish?.persona || ''
        },
        doubao: {
          name: d.doubaoName || prev.actors?.doubao?.name || '豆包',
          voice: d.doubaoVoice || prev.actors?.doubao?.voice || 'zh_female_xiaohe_uranus_bigtts',
          persona: d.doubaoPersona || prev.actors?.doubao?.persona || ''
        }
      },
      rules: { voteSeconds: Number(d.voteSeconds || prev.rules?.voteSeconds) || 20, rounds: prev.rules?.rounds || 2 },
      ui: { hint: prev.ui?.hint || '发弹幕出题 · 支持谁扣 1 / 2' },
      idle: prev.idle || {
        enabled: true,
        minSeconds: 90,
        topics: ['该不该在上班时间摸鱼', '年轻人该先攒钱还是先享受生活', '朋友之间该不该借钱']
      },
      tts: {
        voice: d.fishVoice || prev.tts?.voice || config.tts?.voice,
        rate: prev.tts?.rate ?? config.tts?.rate ?? 20,
        pitch: prev.tts?.pitch ?? config.tts?.pitch ?? 0
      },
      bgm: { track: prev.bgm?.track || '' }
    };
  }
  if (!SCENE_ORDER.includes(config.scene)) config.scene = 'work';
  // 老版本把辩论参数放在顶层 config.debate，迁移后就没用了
  if (config.debate) delete config.debate;
}

function projectScene(name) {
  const s = config.scenes?.[name];
  if (!s) return;
  config.scene = name;
  for (const k of ['persona', 'salary', 'ui', 'idle']) if (s[k]) config[k] = s[k];
  if (s.tts) {
    if (s.tts.voice) config.tts.voice = s.tts.voice;
    if (Number.isFinite(Number(s.tts.rate))) config.tts.rate = Number(s.tts.rate);
    if (Number.isFinite(Number(s.tts.pitch))) config.tts.pitch = Number(s.tts.pitch);
  }
}

function captureScene(name) {
  const s = config.scenes?.[name];
  if (!s) return;
  for (const k of ['persona', 'salary', 'ui', 'idle']) if (config[k]) s[k] = config[k];
  s.tts = { ...(s.tts || {}), voice: config.tts.voice, rate: config.tts.rate, pitch: config.tts.pitch };
}

function sceneList() {
  return SCENE_ORDER.filter((id) => config.scenes?.[id]).map((id) => ({ id, label: config.scenes[id].label || id }));
}

async function persistConfig() {
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// 是否要从旧的“扁平 config”迁移：看用户自己的 config.json 里有没有 scenes，
// 而不是看合并后的 config——默认配置里已经有 scenes 了，不然会把用户参数顶掉。
let userConfig = null;
if (existsSync(CONFIG_PATH)) {
  try {
    userConfig = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  } catch {
    userConfig = null;
  }
}
const migrated = !userConfig || !userConfig.scenes;
normalizeScenes(migrated);
const filledDefaults = fillDebateDefaults();
projectScene(process.env.SCENE && SCENE_ORDER.includes(process.env.SCENE) ? process.env.SCENE : config.scene);
if (migrated || filledDefaults) {
  await persistConfig();
  console.log('[scene] config.json 已升级为 scene + scenes 结构');
}

// 直接从场景二启动时，仍需初始化共用的工资引擎（随后会暂停）。
config.salary ??= config.scenes.work.salary;
config.persona ??= config.scenes.work.persona;
const engine = new SalaryEngine(config, join(ROOT, 'data', 'state.json'));
const tts = new TTS(config, join(ROOT, 'data', 'tts'));
const llm = new LLM(config, join(ROOT, 'persona.md'));
const interaction = new InteractionSession();
llm.session = interaction;
tts.session = interaction;
const bank = new ReplyBank();
const douyin = new DouyinSource(config);
const debate = new Debate({ config, tts, llm, broadcast, onUpdate: (st) => broadcast('debate', st) });

const clients = new Set();
const bgm = { playing: false, index: 0, volume: 0.25, track: null, output: 'console' };
const bgmOutputs = new Map();
function musicOutputs() {
  const now = Date.now();
  for (const [id, output] of bgmOutputs) if (now - output.at > 10000) bgmOutputs.delete(id);
  return [...bgmOutputs.values()];
}
const BGM_EXT = new Set(['.mp3', '.m4a', '.ogg', '.wav']);

async function bgmTracks() {
  try {
    const dir = join(ROOT, 'public', 'assets', 'bgm');
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(dir);
    return files
      .filter((f) => BGM_EXT.has(extname(f).toLowerCase()))
      .sort()
      .map((f) => ({ file: f, title: f.replace(/\.[^.]+$/, '') }));
  } catch {
    return [];
  }
}
let lastStatus = douyin.snapshot();
let replyBusy = false;
let pending = [];
let pendingTimer = null;
let replySeq = 0;
let lastReply = null;
let lastActivity = Date.now();
let idleIndex = 0;
const history = [];

function stopInteraction(reason = '已手动停止互动') {
  interaction.stop(reason);
  debate.stop();
  pauseWork();
  pending = [];
  clearTimeout(pendingTimer);
  replyBusy = false;
  bgm.playing = false;
  broadcast('bgm', { ...bgm });
  broadcast('interaction', interaction.state);
  broadcast('interaction-stop', { at: Date.now() });
  douyin.disconnect().catch(() => {});
  return interaction.state;
}
function startInteraction() {
  if (!interaction.start()) return interaction.state;
  lastActivity = Date.now();
  debate.lastActivity = Date.now();
  if (config.scene === 'work') resumeWork();
  const generation = interaction.generation;
  broadcast('interaction', interaction.state);
  if (config.douyin.autoConnect && config.douyin.roomId && !douyin.client) {
    douyin.connect(config.douyin.roomId).then(() => {
      if (!interaction.valid(generation)) douyin.disconnect().catch(() => {});
    }).catch(err => { if (interaction.valid(generation)) toast(`抖音连接失败：${err.message}`, 'warn'); });
  }
  return interaction.state;
}
setInterval(() => {
  if (interaction.enabled && !interaction.active) stopInteraction('控制窗口已关闭或连接中断，已自动停止互动');
}, 1000).unref();


// 场景切换时，另一套的计时器要停下来，免得辩论到一半弹出“被老板抓到”
function pauseWork() {
  if (engine.timer) {
    clearInterval(engine.timer);
    engine.timer = null;
  }
}

function resumeWork() {
  if (!interaction.active) return;
  if (engine.timer) return;
  engine.state.patrolAt = Date.now() + engine.patrolDelay();
  engine.timer = setInterval(() => engine.tick(), 1000);
  engine.timer.unref?.();
}

function deepMerge(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return b ?? a;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return b ?? a;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = k in a ? deepMerge(a[k], v) : v;
  return out;
}

function broadcast(type, payload) {
  const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try {
      res.write(frame);
    } catch {
      clients.delete(res);
    }
  }
}

function toast(text, tone = 'info') {
  broadcast('toast', { text, tone, at: Date.now() });
}

// 每个场景各记一套 BGM：曲目 + 音量 + 开关。以前只记了曲目，
// 音量和播放状态是全局共享的，切场景就会「听着像窜了 / 暂停也没生效」。
async function applySceneBgm(name) {
  const want = config.scenes?.[name]?.bgm || {};
  const tracks = await bgmTracks();
  const idx = tracks.findIndex((t) => t.file === want.track);
  if (idx >= 0) bgm.index = idx;
  bgm.track = tracks[bgm.index]?.file || null;
  if (Number.isFinite(Number(want.volume))) bgm.volume = Math.max(0, Math.min(1, Number(want.volume)));
  if (typeof want.playing === 'boolean') bgm.playing = want.playing;
  bgm.output = want.output === 'stage' ? 'stage' : 'console';
  if (!interaction.active) bgm.playing = false;
  broadcast('bgm', { ...bgm, tracks });
  return { ...bgm, tracks };
}

async function switchScene(name) {
  if (!SCENE_ORDER.includes(name) || !config.scenes?.[name]) return { ok: false, error: '未知场景' };
  if (name === config.scene) return { ok: true, scene: name, unchanged: true };
  captureScene(config.scene);
  projectScene(name);
  engine.cfg = config;
  tts.cfg = config.tts;
  debate.configure(config);
  if (name === 'work') {
    resumeWork();
    debate.stop(); // 离开辩论场景：正在跑的那局要停掉，否则它还在后台说话
  } else {
    pauseWork();
  }
  // 排队中的 V1 回复属于上一个场景，别带过来
  pending = [];
  replyBusy = false;
  clearTimeout(pendingTimer);
  lastActivity = Date.now();
  await applySceneBgm(name);
  await persistConfig();
  if (debate.config !== config) debate.configure(config);
  broadcast('scene', { scene: name, label: config.scenes[name].label, list: sceneList(), at: Date.now() });
  toast(`已切到「${config.scenes[name].label}」`, 'success');
  return { ok: true, scene: name, label: config.scenes[name].label };
}

engine.on('state', ({ kind, state }) => broadcast('state', { kind, state }));
engine.on('chat', (msg) => {
  lastActivity = Date.now();
  broadcast('danmaku', msg);
  enqueueReply(msg);
});
engine.on('gift', (g) => {
  lastActivity = Date.now();
  broadcast('gift', { ...g, test: Boolean(g.test) });
  enqueueReply({
    name: g.name,
    text: `送出了 ${g.giftName} ×${g.count}`,
    gift: true,
    giftName: g.giftName,
    giftCount: g.count,
    giftYuan: g.yuan
  }, true);
});
engine.on('follow', (f) => {
  lastActivity = Date.now();
  broadcast('follow', f);
  enqueueReply({ name: f.name, text: '关注了直播间', follow: true }, true);
});
engine.on('like', (l) => broadcast('like', l));
engine.on('member', (m) => broadcast('member', m));
engine.on('event', (e) => {
  broadcast('event', e);
  if (config.scene !== 'work') return;
  if (e.type === 'target') toast('工资达标，进入合法摸鱼', 'success');
  if (e.type === 'patrol' && e.caught) toast(`被老板抓到了，扣 ${e.penalty} 元`, 'warn');
  if (e.type === 'deliver') toast(`第 ${e.shift - 1} 班交付完成`, 'success');
});

douyin.on('status', (s) => {
  lastStatus = s;
  broadcast('status', s);
});
douyin.on('chat', (m) => {
  if (!interaction.active) return;
  if (config.scene === 'debate') {
    lastActivity = Date.now();
    broadcast('danmaku', m);
    debate.handleChat(m).catch((err) => console.error('[debate]', err));
    return;
  }
  engine.onChat(m);
});
douyin.on('gift', (g) => {
  if (!interaction.active) return;
  if (config.scene === 'debate') {
    lastActivity = Date.now();
    broadcast('gift', g);
    debate.onGift(g).catch(() => {});
    return;
  }
  engine.onGift(g);
});
douyin.on('like', (l) => {
  if (!interaction.active) return;
  if (config.scene === 'debate') broadcast('like', l);
  else engine.onLike(l);
});
douyin.on('follow', (f) => {
  if (!interaction.active) return;
  if (config.scene === 'debate') {
    lastActivity = Date.now();
    broadcast('follow', f);
    return;
  }
  engine.onFollow(f);
});
const welcomed = new Map();
let lastWelcomeAt = 0;
function welcomeViewer(name) {
  const who = String(name || '').trim();
  if (!who || who.length > 20) return;
  const now = Date.now();
  if (now - lastWelcomeAt < 8000) return;
  const seen = welcomed.get(who);
  if (seen && now - seen < 10 * 60 * 1000) return;
  welcomed.set(who, now);
  if (welcomed.size > 500) welcomed.delete(welcomed.keys().next().value);
  lastWelcomeAt = now;
  lastActivity = now;
  enqueueReply({ name: who, text: '进入了直播间', enter: true });
}
douyin.on('member', (m) => {
  if (!interaction.active) return;
  lastActivity = Date.now();
  if (config.scene === 'debate') {
    broadcast('member', m);
    debate.onMember(m).catch((err) => console.error('[debate:member]', err));
    return;
  }
  engine.onMember(m);
  welcomeViewer(m.name);
});

function enqueueReply(msg, priority = false) {
  if (!interaction.active) return;
  if (priority) pending.unshift(msg);
  else pending.push(msg);
  if (pending.length > 6) {
    const gifts = pending.filter((m) => m.gift || m.follow);
    const chats = pending.filter((m) => !(m.gift || m.follow));
    pending = [...gifts.slice(0, 3), ...chats].slice(-5);
  }
  if (replyBusy) return;
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(flushReplies, priority ? 120 : 320);
}

async function flushReplies() {
  if (!interaction.active || replyBusy || !pending.length) return;
  const generation = interaction.generation;
  replyBusy = true;
  const msg = pending.shift();
  try {
    let text = await llm.reply({ message: msg, state: engine.state, history, queue: pending.length });
    if (!interaction.valid(generation)) return;
    if (!text) text = bank.fallback({ text: msg.text, name: msg.name, gift: msg.gift, giftName: msg.giftName, enter: msg.enter, state: engine.state });
    text = text.slice(0, 80);
    const seq = ++replySeq;
    engine.setLine(text);
    engine.publish('reply');
    history.push({ role: 'user', content: `${msg.name}：${msg.text}` });
    history.push({ role: 'assistant', content: text });
    while (history.length > 12) history.shift();
    let audio = null;
    try {
      audio = await tts.synth(text);
    } catch {
      audio = null;
    }
    if (!interaction.valid(generation)) return;
    lastReply = { name: msg.name, text: msg.text, reply: text };
    broadcast('reply', {
      id: seq,
      text,
      audio,
      comments: [msg],
      at: Date.now()
    });
    if (!audio) {
      // 语音被限流时不放弃：后台重试，成功后补发同一句语音
      const retry = (attempt) => {
        setTimeout(async () => {
          if (!interaction.valid(generation)) return;
          try {
            const late = await tts.synth(text);
            if (!interaction.valid(generation)) return;
            if (late) {
              broadcast('reply-audio', { id: seq, audio: late, at: Date.now() });
            } else if (attempt < 3) {
              retry(attempt + 1);
            }
          } catch {
            if (attempt < 3) retry(attempt + 1);
          }
        }, 15000);
      };
      retry(0);
    }
  } catch (err) {
    console.error('[reply]', err);
  } finally {
    if (!interaction.valid(generation)) return;
    replyBusy = false;
    if (pending.length) pendingTimer = setTimeout(flushReplies, 220);
  }
}

function publicTtsConfig() {
  const { volcApiKey, ...safe } = config.tts;
  return { ...safe, hasVolcApiKey: Boolean(volcApiKey) };
}

async function apiState() {
  return {
    state: engine.snapshot(),
    status: lastStatus,
    scene: {
      active: config.scene,
      label: config.scenes?.[config.scene]?.label || '',
      list: sceneList(),
      pages: PAGES[config.scene] || PAGES.work
    },
    scenes: config.scenes,
    debate: debate.state,
    debateActivity: debate.activities,
    interaction: interaction.state,
    bgmOutputs: musicOutputs(),
    config: {
      persona: config.persona,
      salary: config.salary,
      ui: config.ui,
      llm: { enabled: llm.available, model: config.llm.model, baseUrl: config.llm.baseUrl, hasKey: Boolean(config.llm.apiKey) },
      tts: publicTtsConfig(),
      douyin: { roomId: config.douyin.roomId }
    },
    persona: await readFile(join(ROOT, 'persona.md'), 'utf8'),
    bgm: { ...bgm, tracks: await bgmTracks() },
    idle: config.idle,
    lastReply,
    runtime: { sse: clients.size, uptime: Math.round(process.uptime()) },
    now: Date.now()
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.webm': 'video/webm',
  '.ogg': 'audio/ogg',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon'
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  res.end(body);
}

function sendJSON(res, value, status = 200) {
  send(res, status, JSON.stringify(value), { 'Content-Type': 'application/json; charset=utf-8' });
}

async function readJSON(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function serveFile(res, path, headOnly = false, rangeHeader = '') {
  try {
    const info = await stat(path);
    if (!info.isFile()) return send(res, 404, 'not found');
    const headers = {
      'Content-Type': MIME[extname(path).toLowerCase()] || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    };
    let start = 0, end = info.size - 1, status = 200;
    // 浏览器播放长音频、跳转进度和循环时会请求部分字节。
    if (rangeHeader && !headOnly) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
      if (!match || (!match[1] && !match[2])) {
        return send(res, 416, '', { ...headers, 'Content-Range': `bytes */${info.size}` });
      }
      if (!match[1]) start = Math.max(0, info.size - Number(match[2]));
      else {
        start = Number(match[1]);
        if (match[2]) end = Math.min(end, Number(match[2]));
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) {
        return send(res, 416, '', { ...headers, 'Content-Range': `bytes */${info.size}` });
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
    }
    headers['Content-Length'] = Math.max(0, end - start + 1);
    res.writeHead(status, headers);
    if (headOnly || !info.size) return res.end();
    const stream = createReadStream(path, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  } catch {
    if (!res.headersSent) send(res, 404, 'not found');
    else res.destroy();
  }
}

// 页面托管：按“当前场景”决定发哪张页面，并在发送时注入场景外壳脚本。
// 注入发生在服务端，所以 V1 的 index.html / control.html 源文件保持原封不动。
// 页面版本号：public 下的 html/js 一变，旧页面就能自己发现自己过期了
async function buildVersion() {
  const { readdir, stat } = await import('node:fs/promises');
  const parts = [];
  for (const dir of [join(ROOT, 'public'), join(ROOT, 'public', 'js')]) {
    let names = [];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (!/\.(html|js|css)$/.test(name)) continue;
      try {
        const info = await stat(join(dir, name));
        parts.push(`${name}:${Math.round(info.mtimeMs)}`);
      } catch {
        /* ignore */
      }
    }
  }
  let h = 0;
  const str = parts.join('|');
  for (let i = 0; i < str.length; i += 1) h = (h * 31 + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + '-' + parts.length;
}

async function servePage(res, file, headOnly = false, { bar = false } = {}) {
  try {
    const full = join(ROOT, 'public', file);
    const info = await stat(full);
    if (!info.isFile()) return send(res, 404, 'not found');
    let html = await readFile(full, 'utf8');
    const inject = `<script src="/js/interaction-control.js" data-console="${bar ? '1' : '0'}"></script>${bar ? '<script src="/js/companion-control.js"></script><script src="/js/scene-bar.js"></script><script src="/js/tts-settings.js"></script>' : ''}<script src="/js/scene-watch.js"></script>`;
    html = html.includes('</body>') ? html.replace(/<\/body>/i, `${inject}</body>`) : html + inject;
    const body = Buffer.from(html, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    if (headOnly) return res.end();
    res.end(body);
  } catch {
    send(res, 404, 'not found');
  }
}

function pageFor(kind, url) {
  const forced = url?.searchParams?.get('scene');
  const scene = SCENE_ORDER.includes(forced) ? forced : config.scene;
  return (PAGES[scene] || PAGES.work)[kind];
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const path = decodeURIComponent(url.pathname);
  const headOnly = req.method === 'HEAD';

  try {
    if (req.method === 'GET' && path === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.write(`retry: 2000\n\n`);
      res.write(`event: state\ndata: ${JSON.stringify({ kind: 'init', state: engine.snapshot(), scene: config.scene })}\n\n`);
      res.write(`event: status\ndata: ${JSON.stringify(lastStatus)}\n\n`);
      clients.add(res);
      const ping = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          /* ignore */
        }
      }, 15000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }

    if (req.method === 'GET' && path === '/api/companion') return sendJSON(res, await companionControl.status());
    if (req.method === 'GET' && path === '/api/state') return sendJSON(res, await apiState());
    if (req.method === 'GET' && path === '/health') return sendJSON(res, { ok: true, app: 'alive-portable', release: '0.2.0', uptime: process.uptime() });
    if (req.method === 'GET' && path === '/api/version') {
      return sendJSON(res, { version: await buildVersion(), scene: config.scene });
    }

    if (path === '/api/scene') {
      if (req.method === 'GET') {
        return sendJSON(res, {
          active: config.scene,
          label: config.scenes?.[config.scene]?.label || '',
          list: sceneList(),
          scenes: config.scenes
        });
      }
      if (req.method === 'POST') {
        const body = await readJSON(req);
        const r = await switchScene(String(body.scene || ''));
        return sendJSON(res, r, r.ok ? 200 : 400);
      }
      return send(res, 405, 'method not allowed');
    }

    if (req.method === 'GET' && path === '/api/tts') {
      if (!interaction.active) return sendJSON(res, { error: '互动已停止，请先点击启动互动' }, 409);
      const generation = interaction.generation;
      const text = (url.searchParams.get('text') || '工资够了，合理摸鱼。').slice(0, 120);
      const voice = url.searchParams.get('voice') || undefined;
      const rate = url.searchParams.get('rate');
      const audio = await tts.synth(text, { voice, rate: rate === null ? undefined : Number(rate) });
      if (!interaction.valid(generation)) return sendJSON(res, { error: '互动已停止' }, 409);
      return sendJSON(res, { audio, text });
    }

    if (req.method === 'GET' && path === '/api/voices') {
      return sendJSON(res, { voices: tts.voices, current: config.tts.voice, provider: config.tts.provider });
    }

    if (req.method === 'POST' && path === '/api/config') {
      const body = await readJSON(req);
      if (body.salary && typeof body.salary === 'object') {
        for (const key of ['target', 'perChat', 'perDiamond', 'perFollow', 'restSeconds', 'patrolPenalty']) {
          if (Number.isFinite(Number(body.salary[key]))) config.salary[key] = Number(body.salary[key]);
        }
      }
      if (body.idle && typeof body.idle === 'object') {
        if (typeof body.idle.enabled === 'boolean') config.idle.enabled = body.idle.enabled;
        if (Number.isFinite(Number(body.idle.minSeconds))) config.idle.minSeconds = Math.max(20, Number(body.idle.minSeconds));
        if (Array.isArray(body.idle.lines)) config.idle.lines = body.idle.lines.map((x) => String(x).slice(0, 80)).filter(Boolean).slice(0, 8);
      }
      if (body.debate && typeof body.debate === 'object') {
        // 辩论场景专属参数，只写 scenes.debate，不碰“工作摸鱼”那一套
        const d = (config.scenes.debate = config.scenes.debate || {});
        d.actors = d.actors || {};
        d.actors.fish = d.actors.fish || {};
        d.actors.doubao = d.actors.doubao || {};
        d.rules = d.rules || {};
        d.ui = d.ui || {};
        const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
        const b = body.debate;
        if (str(b.banner, 60) !== null) d.banner = str(b.banner, 60);
        if (b.actors && typeof b.actors === 'object') {
          const fish = b.actors.fish || {};
          const dou = b.actors.doubao || {};
          if (str(fish.name, 20) !== null) d.actors.fish.name = str(fish.name, 20);
          if (str(fish.voice, 80) !== null) d.actors.fish.voice = str(fish.voice, 80);
          if (str(dou.name, 20) !== null) d.actors.doubao.name = str(dou.name, 20);
          if (str(dou.voice, 80) !== null) d.actors.doubao.voice = str(dou.voice, 80);
          if (str(dou.persona, 2000) !== null) d.actors.doubao.persona = str(dou.persona, 2000);
          if (str(fish.persona, 2000) !== null) d.actors.fish.persona = str(fish.persona, 2000);
          for (const [side, src] of [['fish', fish], ['doubao', dou]]) {
            if (Number.isFinite(Number(src.rate))) {
              d.actors[side].rate = Math.max(-50, Math.min(100, Number(src.rate)));
            }
            if (Number.isFinite(Number(src.volume))) {
              d.actors[side].volume = Math.max(0, Math.min(1, Number(src.volume)));
            }
          }
        }
        if (b.rules && Number.isFinite(Number(b.rules.voteSeconds))) {
          d.rules.voteSeconds = Math.max(8, Math.min(120, Number(b.rules.voteSeconds)));
        }
        if (b.rules?.rounds !== undefined) {
          const rounds = Number(b.rules.rounds);
          if (!Number.isInteger(rounds) || rounds < 1 || rounds > 30) {
            return sendJSON(res, { error: '辩论轮次请填 1–30 的整数' }, 400);
          }
          d.rules.rounds = rounds;
        }
        if (str(b.ui?.hint, 60) !== null) d.ui.hint = str(b.ui.hint, 60);
        if (str(b.ui?.placeholder, 40) !== null) d.ui.placeholder = str(b.ui.placeholder, 40);
        d.idle = d.idle || {};
        if (Array.isArray(b.idleTopics)) {
          d.idle.topics = b.idleTopics.map((x) => String(x).trim().slice(0, 60)).filter(Boolean).slice(0, 8);
        }
        if (typeof b.idleEnabled === 'boolean') d.idle.enabled = b.idleEnabled;
        if (b.idleMinSeconds !== undefined && Number.isFinite(Number(b.idleMinSeconds))) {
          d.idle.minSeconds = Math.max(0, Math.min(3600, Number(b.idleMinSeconds)));
        }
        debate.configure(config);
      }
      if (body.llm && typeof body.llm === 'object') {
        if (typeof body.llm.apiKey === 'string' && body.llm.apiKey.trim()) config.llm.apiKey = body.llm.apiKey.trim();
        if (typeof body.llm.model === 'string' && body.llm.model.trim()) config.llm.model = body.llm.model.trim();
        if (typeof body.llm.baseUrl === 'string' && body.llm.baseUrl.trim()) config.llm.baseUrl = body.llm.baseUrl.trim();
        if (typeof body.llm.enabled === 'boolean') config.llm.enabled = body.llm.enabled;
        llm.configure(config.llm);
      }
      if (body.tts && typeof body.tts === 'object') {
        if (body.tts.clearVolcApiKey === true) config.tts.volcApiKey = '';
        else if (typeof body.tts.volcApiKey === 'string' && body.tts.volcApiKey.trim()) {
          config.tts.volcApiKey = body.tts.volcApiKey.trim();
        }
        if (typeof body.tts.volcResourceId === 'string' && body.tts.volcResourceId.trim()) {
          config.tts.volcResourceId = body.tts.volcResourceId.trim().slice(0, 120);
        }

        if (typeof body.tts.voice === 'string' && body.tts.voice) config.tts.voice = body.tts.voice;
        if (Number.isFinite(Number(body.tts.rate))) config.tts.rate = Number(body.tts.rate);
        if (Number.isFinite(Number(body.tts.pitch))) config.tts.pitch = Number(body.tts.pitch);
      }
      engine.cfg = config;
      tts.cfg = config.tts;
      captureScene(config.scene);
      debate.configure(config);
      await persistConfig();
      return sendJSON(res, { ok: true, config: { salary: config.salary, tts: publicTtsConfig() } });
    }

    if (req.method === 'POST' && path === '/api/control') {
      const body = await readJSON(req);
      const action = body.action;
      if (action === 'companion-connect') {
        try { return sendJSON(res, { ok: true, ...await companionControl.start() }); }
        catch (err) { return sendJSON(res, { ok: false, error: err.message }, 409); }
      }
      if (action === 'interaction-start') return sendJSON(res, { ok: true, interaction: startInteraction() });
      if (action === 'interaction-stop') return sendJSON(res, { ok: true, interaction: stopInteraction() });
      if (action === 'interaction-heartbeat') {
        interaction.heartbeat();
        return sendJSON(res, { ok: true, interaction: interaction.state });
      }
      const paidActions = ['test-danmaku', 'debate-start', 'debate-tally', 'say', 'simulate', 'test-llm', 'enter', 'gift'];
      if (paidActions.includes(action) && !interaction.active) {
        return sendJSON(res, { ok: false, error: '互动已停止，请先点击启动互动' }, 409);
      }
      const actionGeneration = interaction.generation;
      if (action === 'scene') {
        const r = await switchScene(String(body.scene || ''));
        return sendJSON(res, r, r.ok ? 200 : 400);
      }
      if (action === 'open-window') {
        // 打开一个无地址栏的直播窗口（给直播伴侣做窗口捕获 / 直接看）
        if (process.platform !== 'darwin') return sendJSON(res, { ok: true, browserUrl: `http://${HOST}:${PORT}/?view=stream` });
        if (!existsSync('/Applications/Google Chrome.app')) {
          return sendJSON(res, { error: '没找到 Google Chrome，请先安装或直接打开 /?view=stream' }, 400);
        }
        const url = `http://${HOST}:${PORT}/?view=stream`;
        const size = String(body.size || '720x1280');
        const [w, h] = size.split('x').map((n) => Math.max(360, Math.min(2160, Number(n) || 0)));
        const { spawn } = await import('node:child_process');
        // 把 open 的真实错误回给前端，别只丢一句 Failed to fetch
        const result = await new Promise((resolve) => {
          let settled = false;
          const finish = (ok, error) => {
            if (settled) return;
            settled = true;
            resolve({ ok, error });
          };
          let child;
          try {
            child = spawn(
              'open',
              [
                '-na',
                'Google Chrome',
                '--args',
                `--app=${url}`,
                `--window-size=${w},${h}`,
                '--window-position=40,40',
                // 专用 profile：第二次点会复用同一个浏览器实例，不会越开越卡
                `--user-data-dir=${join(ROOT, 'data', 'live-window')}`,
                '--no-first-run',
                '--no-default-browser-check',
                '--autoplay-policy=no-user-gesture-required'
              ],
              { stdio: ['ignore', 'ignore', 'pipe'] }
            );
          } catch (err) {
            return finish(false, err.message);
          }
          let stderr = '';
          child.stderr?.on('data', (d) => { stderr += d.toString(); });
          child.on('error', (err) => finish(false, err.message));
          child.on('close', (code) => finish(code === 0, stderr.trim() || `open 退出码 ${code}`));
          setTimeout(() => finish(true), 3000); // open 正常是立刻返回，别把请求挂住
        });
        if (!result.ok) {
          console.warn('[open-window] 打开失败：', result.error);
          return sendJSON(res, { ok: false, error: result.error || '打不开直播窗口' }, 500);
        }
        console.log('[open-window] 已打开', url);
        return sendJSON(res, { ok: true, url, size: `${w}x${h}` });
      }
      if (action === 'bgm-output') {
        const clientId = String(body.clientId || '').slice(0, 80);
        if (!clientId) return sendJSON(res, { error: '缺少播放器标识' }, 400);
        bgmOutputs.set(clientId, { clientId, paused: body.paused !== false, muted: Boolean(body.muted),
          currentTime: Math.max(0, Number(body.currentTime) || 0), duration: Math.max(0, Number(body.duration) || 0),
          track: String(body.track || '').slice(0, 200), error: String(body.error || '').slice(0, 200), at: Date.now() });
        const outputs = musicOutputs();
        broadcast('bgm-output', outputs);
        return sendJSON(res, { ok: true });
      }
      if (action === 'debate-playback') {
        return sendJSON(res, { ok: debate.acknowledge(body) });
      }
      if (action === 'test-danmaku') {
        const text = String(body.text || '').slice(0, 120).trim();
        if (!text) return sendJSON(res, { ok: false, error: '先写一条弹幕' }, 400);
        const verdict = await debate.judge(text);
        return sendJSON(res, { ok: true, text, verdict });
      }
      if (action === 'debate-start') {
        // 只有切到「辩论赛」场景时才允许开局，免得在摸鱼场景里后台偷偷说话
        if (config.scene !== 'debate') {
          return sendJSON(res, { ok: false, error: '当前不是「AI 辩论赛」场景，先切场景再开局' }, 409);
        }
        // 上一局还在收尾时不能直接开新局，否则台词会叠在一起
        if (debate.phase !== 'idle') {
          return sendJSON(res, { ok: false, busy: true, error: `上一局还在收尾（${debate.phase}），等一下再开` }, 409);
        }
        debate.start(String(body.topic || '该不该在上班时间摸鱼'), String(body.author || '导播'))
          .catch((err) => console.error('[debate]', err));
        return sendJSON(res, { ok: true });
      }
      if (action === 'debate-tally') {
        // 导播手动开票：不等倒计时，直接结算这一轮
        if (debate.phase === 'idle') return sendJSON(res, { ok: false, error: '现在没在比赛' }, 409);
        debate.tally().catch((err) => console.error('[debate]', err));
        return sendJSON(res, { ok: true });
      }
      if (action === 'debate-score-reset') {
        return sendJSON(res, { ok: true, score: debate.resetScore() });
      }
      if (action === 'debate-stop') {
        debate.stop();
        return sendJSON(res, { ok: true });
      }
      if (action === 'debate-vote') {
        if (body.side === 'fish' || body.side === 'doubao') {
          debate.votes[body.side] += 1;
          debate.update();
        }
        return sendJSON(res, { ok: true, state: debate.state });
      }
      if (action === 'connect') {
        const room = body.roomId || config.douyin.roomId;
        config.douyin.roomId = room;
        await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
        await douyin.connect(room);
        return sendJSON(res, { ok: true, status: douyin.snapshot() });
      }
      if (action === 'disconnect') {
        await douyin.disconnect();
        return sendJSON(res, { ok: true, status: douyin.snapshot() });
      }
      if (action === 'reset') {
        lastReply = null;
        engine.reset();
        return sendJSON(res, { ok: true, state: engine.snapshot() });
      }
      if (action === 'say') {
        const text = String(body.text || '').slice(0, 120);
        if (!text) return sendJSON(res, { error: '内容为空' }, 400);
        engine.setLine(text);
        engine.publish('say');
        const audio = await tts.synth(text);
        if (!interaction.valid(actionGeneration)) return sendJSON(res, { ok: false, error: '互动已停止' }, 409);
        broadcast('reply', { id: ++replySeq, text, audio, comments: [{ name: '导播', text }], at: Date.now() });
        return sendJSON(res, { ok: true, audio });
      }
      if (action === 'simulate') {
        const name = String(body.name || '测试观众');
        const text = String(body.text || '领导在吗，工资够了吗');
        const msg = { id: `sim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name, text, userId: `sim-${Date.now()}`, test: true };
        if (config.scene === 'debate') {
          broadcast('danmaku', msg);
          const accepted = await debate.handleChat(msg);
          return sendJSON(res, { ok: accepted, chatId: msg.id, ...(accepted ? {} : { error: '当前弹幕较多，请稍后再发' }) });
        }
        engine.onChat(msg);
        return sendJSON(res, { ok: true, state: engine.snapshot() });
      }
      if (action === 'test-llm') {
        const text = await llm.reply({
          message: { name: '测试观众', text: '用一句话证明你会聊天' },
          state: engine.state,
          history: []
        });
        return sendJSON(res, { ok: Boolean(text), text: text || '模型未返回（检查 Key / 模型名 / 网络）' });
      }
      if (action === 'bgm') {
        const op = String(body.op || 'play');
        const tracks = await bgmTracks();
        if (op === 'play') bgm.playing = true;
        else if (op === 'pause') bgm.playing = false;
        else if (op === 'next') { bgm.index = (bgm.index + 1) % Math.max(1, tracks.length); bgm.playing = true; }
        else if (op === 'prev') { bgm.index = (bgm.index - 1 + tracks.length) % Math.max(1, tracks.length); bgm.playing = true; }
        else if (op === 'select') { bgm.index = Math.max(0, Math.min(tracks.length - 1, Number(body.index) || 0)); bgm.playing = true; }
        else if (op === 'output') bgm.output = body.output === 'stage' ? 'stage' : 'console';
        else if (op === 'volume') bgm.volume = Math.max(0, Math.min(1, Number(body.volume) || 0));
        bgm.track = tracks[bgm.index]?.file || null;
        // BGM 是场景级配置：曲目 / 音量 / 开关都记到当前场景下，切场景各放各的
        if (config.scenes?.[config.scene]) {
          config.scenes[config.scene].bgm = { track: bgm.track, volume: bgm.volume, playing: bgm.playing, output: bgm.output };
        }
        await persistConfig();
        broadcast('bgm', { ...bgm, tracks });
        return sendJSON(res, { ok: true, bgm: { ...bgm, tracks } });
      }
      if (action === 'enter') {
        const name = String(body.name || '狂赚500亿');
        if (config.scene === 'debate') {
          broadcast('member', { name });
          debate.onMember({ name }).catch((err) => console.error('[debate:member]', err));
        } else {
          engine.onMember({ name });
          welcomeViewer(name);
        }
        return sendJSON(res, { ok: true });
      }
      if (action === 'action') {
        const index = Math.max(0, Math.min(5, Number(body.index) || 0));
        broadcast('action', { index, at: Date.now() });
        return sendJSON(res, { ok: true, index });
      }
      if (action === 'gift') {
        const gift = {
          name: String(body.name || '测试观众'),
          giftName: String(body.gift || '小心心'),
          count: Number(body.count || 1),
          diamond: Number(body.diamond || 1)
        };
        if (config.scene === 'debate') {
          broadcast('gift', gift);
          debate.onGift(gift).catch((err) => console.error('[debate:gift]', err));
        } else engine.onGift(gift);
        return sendJSON(res, { ok: true, state: engine.snapshot() });
      }
      if (action === 'patrol') {
        engine.patrol();
        return sendJSON(res, { ok: true, state: engine.snapshot() });
      }
      if (action === 'deliver') {
        engine.deliver();
        return sendJSON(res, { ok: true, state: engine.snapshot() });
      }
      return sendJSON(res, { error: 'unknown action' }, 400);
    }

    if (req.method === 'POST' && path === '/api/ingest') {
      if (!interaction.active) return sendJSON(res, { ok: false, error: '互动已停止' }, 409);
      const body = await readJSON(req);
      const type = body.type || 'chat';
      if (config.scene === 'debate') {
        if (type === 'chat') {
          broadcast('danmaku', body);
          debate.handleChat(body).catch((err) => console.error('[debate:ingest]', err));
        } else if (type === 'member') {
          broadcast('member', body);
          debate.onMember(body).catch((err) => console.error('[debate:member]', err));
        } else if (type === 'gift') {
          const gift = { ...body, giftName: body.giftName || body.gift };
          broadcast('gift', gift);
          debate.onGift(gift).catch((err) => console.error('[debate:gift]', err));
        } else if (type === 'like' || type === 'follow') broadcast(type, body);
        else return sendJSON(res, { error: 'unknown type' }, 400);
        return sendJSON(res, { ok: true });
      }
      if (type === 'chat') engine.onChat({ name: body.name, text: body.text, userId: body.userId });
      else if (type === 'gift') engine.onGift({ name: body.name, giftName: body.giftName || body.gift, count: body.count, diamond: body.diamond });
      else if (type === 'like') engine.onLike({ name: body.name, count: body.count });
      else if (type === 'follow') engine.onFollow({ name: body.name });
      else return sendJSON(res, { error: 'unknown type' }, 400);
      return sendJSON(res, { ok: true });
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && path.startsWith('/media/')) {
      const name = normalize(path.slice('/media/'.length));
      if (name.includes('..')) return send(res, 403, 'forbidden');
      return serveFile(res, join(ROOT, 'data', 'tts', name), headOnly, req.headers.range);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');

    if (path === '/' || path === '/index.html' || path === '/stream') {
      return servePage(res, pageFor('stage', url), headOnly);
    }
    if (path === '/control') return servePage(res, pageFor('console', url), headOnly, { bar: true });
    if (path === '/control/work') return servePage(res, PAGES.work.console, headOnly, { bar: true });
    if (path === '/control/debate') return servePage(res, PAGES.debate.console, headOnly, { bar: true });
    if (path.startsWith('/js/')) {
      const name = normalize(path.slice('/js/'.length));
      if (name.includes('..')) return send(res, 403, 'forbidden');
      return serveFile(res, join(ROOT, 'public', 'js', name), headOnly, req.headers.range);
    }
    if (path.startsWith('/assets/')) {
      const name = normalize(path.slice('/assets/'.length));
      if (name.includes('..')) return send(res, 403, 'forbidden');
      return serveFile(res, join(ROOT, 'public', 'assets', name), headOnly, req.headers.range);
    }
    if (path === '/favicon.ico') return send(res, 204, '');
    return send(res, 404, 'not found');
  } catch (err) {
    console.error('[server]', err);
    if (!res.headersSent) sendJSON(res, { error: err.message || 'internal error' }, 500);
    else res.end();
  }
});

async function idleTick() {
  if (!interaction.active) return;
  const generation = interaction.generation;
  try {
    if (config.scene === 'debate') {
      if (replyBusy || pending.length) return;
      await debate.idleLine();
      return;
    }
    const idle = config.idle || {};
    if (!idle.enabled || !Array.isArray(idle.lines) || !idle.lines.length) return;
    if (Date.now() - lastActivity < (Number(idle.minSeconds) || 75) * 1000) return;
    if (replyBusy || pending.length) return;
    const text = idle.lines[idleIndex % idle.lines.length];
    idleIndex += 1;
    lastActivity = Date.now();
    engine.setLine(text);
    engine.publish('idle');
    let audio = null;
    try { audio = await tts.synth(text); } catch { audio = null; }
    if (!interaction.valid(generation)) return;
    broadcast('reply', { id: ++replySeq, text, audio, comments: [], idle: true, at: Date.now() });
  } catch (err) {
    console.error('[idle]', err);
  }
}
setInterval(idleTick, 5000);

server.listen(PORT, HOST, async () => {
  pauseWork(); // 启动默认停止；控制台启动互动后才允许运行。
  // 启动就把当前场景的 BGM 套上（曲目/音量/开关），否则页面加载时 track 是 null，音乐永远不响
  await applySceneBgm(config.scene).catch(() => {});
  console.log(`\n  Alive · 抖音直播助手`);
  console.log(`  当前场景  ${config.scenes[config.scene]?.label || config.scene}（${config.scene}）→ / 与 /control 自动跟随`);
  console.log(`  直播画面  http://${HOST}:${PORT}/?view=stream`);
  console.log(`  预览/调参 http://${HOST}:${PORT}/`);
  console.log(`  控制台    http://${HOST}:${PORT}/control`);
  console.log(`  LLM       ${llm.available ? `已启用 ${config.llm.model}` : '未配置 DEEPSEEK_API_KEY，使用本地话术'}`);
  console.log(`  语音      ${config.tts.enabled ? `${config.tts.provider === 'volc' ? '豆包 TTS' : config.tts.provider === 'say' ? 'macOS say' : 'Edge 神经语音'} (${config.tts.voice})` : '关闭'}`);
  console.log(`  抖音      ${config.douyin.roomId ? `房间 ${config.douyin.roomId}` : '未填写房间号'}\n`);
  if (interaction.active && config.douyin.autoConnect && config.douyin.roomId) {
    douyin.connect(config.douyin.roomId).catch((err) => {
      console.warn('[douyin] 自动连接失败：', err.message);
      toast(`抖音连接失败：${err.message}`, 'warn');
    });
  }
});

process.on('SIGINT', async () => {
  await douyin.disconnect().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500);
});

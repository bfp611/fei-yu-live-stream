// 场景二：AI 辩论赛
// 只负责“辩论这件事”本身：出题、轮次、投票、情绪。
// 语音/LLM/弹幕连接/直播间都归属宿主（server.mjs），这里只借不用。

const SENSITIVE = ['习近平', '政治', '共产党', '台独', '港独', '色情', '裸', '自杀', '毒品', '赌博', '杀人', '强奸', '未成年', '包养', '约炮', '地域黑', '种族'];
const QUESTION = /[?？]|该不该|是不是|能不能|会不会|要不要|算不算|有没有|哪个|谁更|谁才|为什么|凭什么|值不值|对不对/;

const FALLBACK = {
  fish: [
    '这事我站打工人，别跟我讲大道理',
    '你这话听着就累，摸鱼才是人间清醒',
    '我不同意，效率再高也得先活着',
    '别卷了，卷到最后还不是给老板换车',
    '你先等一下，把话说清楚，什么叫应该？',
    '行吧，你讲逻辑，我讲人话，咱俩不在一个频道'
  ],
  doubao: [
    '情绪不能当论据，先把逻辑捋顺',
    '你这是在偷换概念，我不接受',
    '摸鱼解决不了问题，效率才可以',
    '我尊重你的感受，但你的结论站不住',
    '你这个结论，换个场景就自相矛盾了',
    '别急着下结论，你先把前提说清楚'
  ]
};

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// 情绪只给 key，具体换成哪张图/哪段动画由前端决定
function moodFor(side, round, text) {
  if (round === 'win') return 'happy';
  if (round === 'lose') return 'sad';
  if (/[?？]$/.test(text)) return 'shock';
  if (round === 'opening') return 'smug';       // 开场都在放狠话
  if (side === 'fish') return 'angry';          // 大鲵被怼急了
  return 'smug';                                 // 豆包一贯的阴阳怪气
}

export class Debate {
  constructor({ config, tts, llm, broadcast, onUpdate }) {
    this.config = config;
    this.tts = tts;
    this.llm = llm;
    this.broadcast = broadcast;
    this.onUpdate = onUpdate;
    this.phase = 'idle';
    this.topic = '';
    this.author = '';
    this.round = 0;
    this.activeRounds = 0;
    this.votes = { fish: 0, doubao: 0 };
    this.score = { fish: 0, doubao: 0, draw: 0 };
    this.verdict = null;
    this.deadline = 0;
    this.speakerTurn = 'fish';
    this.lastInterject = 0;
    this.lastGiftAck = 0;
    this.lastActivity = Date.now();
    this.idleIndex = 0;
    this.runId = 0;
    this.timer = null;
    this.speaking = null;
    this.speechChain = Promise.resolve();
    this.playback = null;
    this.lineSeq = 0;
    this.interactions = [];
    this.flushing = null;
    this.welcomed = new Map();
    this.lastWelcome = 0;
    this.lastLine = '';
    this.activities = [];
    this.activitySeq = 0;
    this.chatSeq = 0;
  }

  record(kind, data = {}) {
    const entry = { ...data, kind, id: `${Date.now()}-${++this.activitySeq}`, at: Date.now() };
    this.activities.push(entry);
    if (this.activities.length > 200) this.activities.shift();
    this.broadcast('debate-activity', entry);
    return entry;
  }

  configure(config) {
    this.config = config;
    this.update();
  }

  get cfg() {
    return this.config.scenes?.debate || {};
  }

  get actors() {
    const a = this.cfg.actors || {};
    const f = a.fish || {};
    const d = a.doubao || {};
    return {
      fish: {
        name: f.name || '大鲵',
        voice: f.voice || this.config.tts.voice,
        rate: Number.isFinite(Number(f.rate)) ? Number(f.rate) : 20,
        volume: Number.isFinite(Number(f.volume)) ? Math.max(0, Math.min(1, Number(f.volume))) : 1,
        persona: f.persona || ''
      },
      doubao: {
        name: d.name || '豆包',
        voice: d.voice || 'zh_female_xiaohe_uranus_bigtts',
        rate: Number.isFinite(Number(d.rate)) ? Number(d.rate) : 20,
        volume: Number.isFinite(Number(d.volume)) ? Math.max(0, Math.min(1, Number(d.volume))) : 1,
        persona: d.persona || ''
      }
    };
  }

  actor(side) {
    return this.actors[side === 'doubao' ? 'doubao' : 'fish'];
  }

  voice(side) {
    return this.actor(side).voice;
  }

  get rounds() {
    const value = Number(this.cfg.rules?.rounds);
    return Number.isFinite(value) && value >= 1 ? Math.max(1, Math.min(30, Math.floor(value))) : 2;
  }

  get state() {
    const actors = this.actors;
    return {
      phase: this.phase,
      topic: this.topic,
      author: this.author,
      round: this.round,
      rounds: this.rounds,
      totalRounds: this.phase === 'idle' ? this.rounds : this.activeRounds,
      votes: { ...this.votes },
      score: { ...this.score },
      verdict: this.verdict,
      deadline: this.deadline,
      speaking: this.speaking,
      banner: this.cfg.banner || 'AI 辩论赛 · 谁更懂人类',
      hint: this.cfg.ui?.hint || '发弹幕出题 · 支持谁扣 1 / 2',
      placeholder: this.cfg.ui?.placeholder || '发一条弹幕，出个辩题',
      voteSeconds: Number(this.cfg.rules?.voteSeconds) || 20,
      names: { fish: actors.fish.name, dou: actors.doubao.name },
      doubaoName: actors.doubao.name,
      fishName: actors.fish.name
    };
  }

  update() {
    this.onUpdate?.(this.state);
  }

  // 所有发言（辩论、弹幕、欢迎、谢礼）共享同一个串行通道。
  async say(side, text, opts = {}) {
    const run = opts.run ?? this.runId;
    if (!opts.interaction) await this.flushInteractions();
    const task = this.speechChain.then(() => this.speak(side, text, { ...opts, run }));
    this.speechChain = task.catch(() => {});
    await task;
    if (!opts.interaction && run === this.runId) await this.flushInteractions();
  }

  async speak(side, text, opts) {
    if (!text || opts.run !== this.runId) return;
    const a = this.actor(side);
    let audio = null;
    try { audio = await this.tts.synth(text, { voice: a.voice, rate: a.rate }); } catch {}
    // 合成期间也可能停止或换题，旧音频绝不能补发。
    if (opts.run !== this.runId) return;
    const id = `${this.runId}-${++this.lineSeq}`;
    const maxMs = 45000;
    const fallbackMs = Math.min(14000, Math.max(2500, text.length * 240 + 1200));
    this.speaking = side;
    this.speakerTurn = side;
    this.lastActivity = Date.now();
    console.log('[debate]', side, text);
    const done = new Promise((resolve) => {
      const finish = () => {
        if (this.playback?.id !== id) return;
        clearTimeout(this.playback.timer);
        this.playback = null;
        resolve();
      };
      this.playback = { id, finish, clients: new Set(), timer: setTimeout(finish, fallbackMs + 2000), maxMs };
    });
    this.record(opts.chatId ? 'reply' : 'line', { lineId: id, chatId: opts.chatId, side,
      name: a.name, text, comment: opts.comment, audio: Boolean(audio) });
    this.broadcast('debate-line', {
      id, run: opts.run, side, text,
      mood: opts.mood || moodFor(side, opts.round || '', text),
      audio, volume: a.volume, fallbackMs, maxMs, at: Date.now()
    });
    this.update();
    await done;
    if (opts.run !== this.runId) return;
    this.speaking = null;
    this.lastActivity = Date.now();
    this.update();
  }

  // 舞台实际 ended/error 回执；静音预览不参与。客户端自身也串行播放兜底。
  acknowledge({ id, clientId, status }) {
    const p = this.playback;
    if (!p || p.id !== id || !clientId) return false;
    if (status === 'started') {
      p.clients.add(clientId);
      clearTimeout(p.timer);
      p.timer = setTimeout(p.finish, p.maxMs + 1000);
    } else if (status === 'ended' || status === 'error') {
      if (!p.clients.delete(clientId)) return false;
      if (!p.clients.size) p.finish();
    } else return false;
    return true;
  }

  async flushInteractions() {
    if (this.flushing) return this.flushing;
    // 延迟一个微任务，先挂上锁，避免 start/say 重入。
    this.flushing = Promise.resolve().then(async () => {
      while (this.interactions.length) {
        this.interactions.sort((a, b) => (a.kind === 'chat' ? 0 : 1) - (b.kind === 'chat' ? 0 : 1));
        const item = this.interactions.shift();
        if (item.run !== this.runId) continue;
        if (item.kind === 'chat') {
          const verdict = await item.verdict;
          if (item.run !== this.runId) continue;
          const blocked = verdict.blocked || (!verdict.ok && /政治|色情|暴力|敏感|自杀|赌博|毒品|种族|未成年/.test(verdict.reason || ''));
          this.record('judged', { chatId: item.msg.id, name: item.msg.name, text: item.msg.text,
            action: blocked ? 'blocked' : verdict.ok ? 'topic' : 'comment', topic: verdict.topic, source: verdict.source });
          if (verdict.ok) {
            // 句末换局，不给被替换的旧局计比分；保留后续互动。
            if (this.timer) clearTimeout(this.timer);
            this.timer = null;
            this.runId += 1;
            this.phase = 'idle';
            this.deadline = 0;
            for (const pending of this.interactions) pending.run = this.runId;
            this.update();
            const topic = String(verdict.topic || item.msg.text).trim();
            // 不等待整局，否则 start 中的 say 会等这把锁，造成死锁。
            queueMicrotask(() => this.start(topic, item.msg.name, { trusted: true, keepInteractions: true })
              .catch((err) => console.error('[debate:start]', err)));
            break;
          }
          const side = item.side;
          this.record('responding', { chatId: item.msg.id, name: item.msg.name, side, text: item.msg.text });
          const text = blocked ? this.tip(verdict.reason) :
            await this.llm.debateReply?.({ side, message: item.msg, topic: this.topic,
              last: this.lastLine, persona: this.actor(side).persona });
          if (item.run !== this.runId) continue;
          await this.say(side, text || `${item.msg.name || '朋友'}，听到你说的了，咱接着聊${this.topic ? '这道题' : '，你也出个辩题呗'}。`,
            { run: item.run, interaction: true, mood: 'neutral', chatId: item.msg.id, comment: item.msg.text });
        } else {
          await this.say(item.side, item.text, { run: item.run, interaction: true, mood: 'happy' });
        }
      }
    }).finally(() => { this.flushing = null; });
    return this.flushing;
  }

  queueInteraction(item) {
    // 上限防止大量进场/刷屏积压；已排队的弹幕优先保留。
    if (this.interactions.length >= 30 && item.kind !== 'welcome') return false;
    this.interactions.push({ ...item, run: this.runId });
    if (!this.speaking) this.flushInteractions().catch((err) => console.error('[debate:interaction]', err));
    return true;
  }

  async line(side, round, last) {
    const text = await this.llm.debateLine({
      side,
      topic: this.topic,
      last,
      round,
      persona: this.actor(side).persona
    });
    return text || pick(FALLBACK[side === 'doubao' ? 'doubao' : 'fish']);
  }

  validate(text) {
    const t = String(text || '').trim();
    if (!t || t.length < 4) return { ok: false, reason: 'short' };
    if (t.length > 60) return { ok: false, reason: 'long' };
    if (SENSITIVE.some((w) => t.includes(w))) return { ok: false, reason: 'sensitive' };
    if (!QUESTION.test(t) && t.length < 8) return { ok: false, reason: 'unclear' };
    return { ok: true, text: t };
  }

  // 只挡「必须硬挡」的：空内容、敏感话题、超长乱码。太短/不像辩题这些交给大模型判断，
  // 别在后台拿长度一刀切（「你好呀」会被大模型判成打招呼并给出引导，而不是「太短」）。
  hardBlock(text) {
    const t = String(text || '').trim();
    if (!t) return { ok: false, reason: '空弹幕' };
    if (SENSITIVE.some((w) => t.includes(w))) return { ok: false, reason: '敏感话题，不辩' };
    return null;
  }

  // 直播里的弹幕、控制台的「测试弹幕」都走这一个入口，两边判断一定一致
  async judge(text) {
    const raw = String(text || '').trim().slice(0, 120);
    const hard = this.hardBlock(raw);
    if (hard) return { ...hard, blocked: true, source: 'rule' };
    const ai = await this.llm.judgeTopic(raw);
    if (ai) return { ...ai, source: 'llm' };
    // 大模型没配 / 断网 / 超时：退回规则，至少别让直播卡住
    const v = QUESTION.test(raw) ? this.validate(raw) : { ok: false, reason: 'unclear' };
    return v.ok
      ? { ok: true, topic: v.text, reason: '大模型没响应，规则放行', source: 'rule' }
      : { ok: false, reason: this.tip(v.reason), source: 'rule' };
  }

  tip(reason) {
    const r = String(reason || '');
    if (/敏感|不辩|政治|色情|暴力/.test(r)) return '这个题咱不辩，换个轻松点的。';
    if (/长/.test(r)) return '题太长了，一句话说清你的观点。';
    return '这不算辩题，发个能吵起来的观点，比如“该不该摸鱼”。';
  }

  async start(raw, author, opts = {}) {
    if (this.phase !== 'idle') return;
    const text = String(raw || '').trim().slice(0, 120);
    // 敏感词永远挡；太短/太长只在「非大模型判定」时才作为兜底门槛
    const hard = this.hardBlock(text);
    if (hard) {
      await this.say(this.speakerTurn, this.tip(hard.reason), { mood: 'neutral', hold: false });
      return;
    }
    const v = opts.trusted ? { ok: true, text } : this.validate(text);
    if (!v.ok) {
      await this.say(this.speakerTurn, this.tip(v.reason), { mood: 'neutral', hold: false });
      return;
    }
    this.runId += 1;
    const run = this.runId;
    if (opts.keepInteractions) for (const pending of this.interactions) pending.run = run;
    this.lastLine = '';
    this.phase = 'opening';
    this.activeRounds = this.rounds; // 开局锁定，后台修改从下一局生效
    this.round = 1;
    this.topic = v.text;
    this.author = author || '观众';
    this.votes = { fish: 0, doubao: 0 };
    this.verdict = null;
    this.deadline = 0;
    this.update();

    const turns = Array.from({ length: this.activeRounds }, (_, index) =>
      [['fish', index === 0 ? 'opening' : 'rebuttal'], ['doubao', index === 0 ? 'opening' : 'rebuttal']]).flat();
    let nextLine = this.line('fish', 'opening', '');
    await this.say('fish', `辩题来了：${this.topic}。${this.actors.doubao.name}，我先说。`, { run, mood: 'smug', round: 'opening' });
    for (let i = 0; i < turns.length; i += 1) {
      if (run !== this.runId) return;
      await this.flushInteractions();
      if (run !== this.runId) return;
      const [side, round] = turns[i];
      const text = await nextLine;
      if (run !== this.runId) return;
      this.phase = round === 'opening' ? 'opening' : 'rebuttal';
      this.round = Math.floor(i / 2) + 1;
      this.update();
      // 当前角色说话时预生成对手下一句；换题后只丢弃旧结果，不再播出。
      if (turns[i + 1]) nextLine = this.line(turns[i + 1][0], turns[i + 1][1], text);
      this.lastLine = text;
      await this.say(side, text, { run, round });
      if (run !== this.runId) return;
    }
    if (run !== this.runId) return;
    this.phase = 'vote';
    this.round = this.activeRounds;
    const seconds = Number(this.cfg.rules?.voteSeconds) || 20;
    this.update();
    await this.say('fish', `支持${this.actors.fish.name}扣 1，支持${this.actors.doubao.name}扣 2，${seconds} 秒后见分晓。`, { run, mood: 'happy' });
    if (run !== this.runId) return;
    this.deadline = Date.now() + seconds * 1000;
    this.timer = setTimeout(() => this.finish(run).catch((err) => console.error('[debate:finish]', err)), seconds * 1000);
    this.update();
  }

  async finish(run) {
    if (run !== this.runId) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.deadline = 0;
    this.phase = 'result';
    this.round = this.activeRounds;
    const { fish, doubao } = this.votes;
    const winner = fish === doubao ? null : fish > doubao ? 'fish' : 'doubao';
    this.verdict = winner || 'draw';
    if (winner) this.score[winner] += 1;
    else this.score.draw += 1;
    this.update();
    // 处罚：输的一方被盖「退」章，比分记在场上
    this.broadcast('debate-result', {
      winner,
      loser: winner ? (winner === 'fish' ? 'doubao' : 'fish') : null,
      score: { ...this.score },
      topic: this.topic,
      at: Date.now()
    });
    if (!winner) {
      await this.say('fish', '平票？行吧，谁也说服不了谁。', { run, mood: 'shock', round: 'lose' });
      await this.say('doubao', '平局说明这个问题本来就值得吵。', { run, mood: 'neutral', round: 'lose' });
    } else {
      // 不喊「退退退」了，输的一方自己认输
      const loser = winner === 'fish' ? 'doubao' : 'fish';
      const concede = loser === 'fish' ? '行吧，这局姐认输了。' : '好吧，这局我认输。';
      await this.say(loser, concede, { run, mood: 'sad', round: 'lose' });
    }
    if (run !== this.runId) return;
    this.phase = 'idle';
    this.round = 0;
    this.topic = '';
    this.author = '';
    this.lastActivity = Date.now();
    this.update();
  }

  voteSide(text) {
    const t = String(text || '').replace(/１/g, '1').replace(/２/g, '2')
      .replace(/\s+/g, '').replace(/[!！。.,，~～]+$/g, '');
    const fishName = this.actors.fish.name.replace(/\s+/g, '');
    const douName = this.actors.doubao.name.replace(/\s+/g, '');
    if (/^1+$/.test(t) || /^(?:扣|支持|我支持|投|投给)(?:1|正方)$/.test(t) ||
        t === `支持${fishName}` || t === `我支持${fishName}` || /^(?:我)?支持(?:大鲵|肥鱼)$/.test(t)) return 'fish';
    if (/^2+$/.test(t) || /^(?:扣|支持|我支持|投|投给)(?:2|反方)$/.test(t) ||
        t === `支持${douName}` || t === `我支持${douName}` || /^(?:我)?支持豆包$/.test(t)) return 'doubao';
    return null;
  }

  async handleChat(msg) {
    const text = String(msg.text || '').trim().slice(0, 120);
    if (!text) return false;
    this.lastActivity = Date.now();
    // 先识别支持票，开场/反驳/倒计时全程计票，不送模型、不生成语音。
    const side = this.voteSide(text);
    if (side) {
      const counted = ['opening', 'rebuttal', 'vote'].includes(this.phase);
      if (counted) this.votes[side] += 1;
      this.record('vote', { name: msg.name, text, side, counted });
      this.update();
      return true;
    }
    return this.queueChat({ ...msg, text });
  }

  queueChat(msg) {
    msg = { ...msg, id: msg.id || `chat-${Date.now()}-${++this.chatSeq}` };
    if (this.interactions.length >= 30) {
      this.record('busy', { chatId: msg.id, name: msg.name, text: msg.text });
      return false;
    }
    this.record('received', { chatId: msg.id, name: msg.name, text: msg.text, test: Boolean(msg.test) });
    // 判题在上一句播放期间进行，回复仍然只能在句末开口。
    return this.queueInteraction({ kind: 'chat', msg,
      side: this.speaking || this.speakerTurn,
      verdict: this.judge(msg.text).catch(() => ({ ok: false, source: 'rule' })) });
  }

  async onMember(msg) {
    const name = String(msg.name || '').trim().slice(0, 20);
    if (!name) return false;
    const now = Date.now();
    const key = String(msg.userId || name);
    // 只去重同一个人的短时间重复推送，其他新观众不能被全局限流跳过。
    if (now - (this.welcomed.get(key) || 0) < 30000) return false;
    this.welcomed.set(key, now);
    this.record('member', { name, text: '进入直播间，已安排角色欢迎' });
    if (this.welcomed.size > 500) this.welcomed.delete(this.welcomed.keys().next().value);
    const side = this.speaking || this.speakerTurn;
    return this.queueInteraction({ kind: 'welcome', side,
      text: `${name}，快来出个辩题，让我跟她干一仗呗！` });
  }

  // 冷场配置现在存辩题，轮到哪题就真正启动哪题的一整局。
  async idleLine() {
    const idle = this.cfg.idle || {};
    if (!idle.enabled || !Array.isArray(idle.topics) || !idle.topics.length) return;
    if (this.phase !== 'idle' || this.speaking || this.flushing || this.interactions.length) return;
    const seconds = Math.max(0, Number.isFinite(Number(idle.minSeconds)) ? Number(idle.minSeconds) : 90);
    if (Date.now() - this.lastActivity < seconds * 1000) return;
    const text = String(idle.topics[this.idleIndex % idle.topics.length] || '').trim();
    this.idleIndex += 1;
    await this.start(text, '预设辩题', { trusted: true });
  }

  async onGift(g) {
    const now = Date.now();
    if (now - this.lastGiftAck < 20000) return;
    this.lastGiftAck = now;
    const side = this.speaking || this.speakerTurn;
    return this.queueInteraction({ kind: 'gift', side,
      text: `${g.name}的${g.giftName}收到了，${this.actor(side).name}替你记一功。` });
  }

  resetScore() {
    this.score = { fish: 0, doubao: 0, draw: 0 };
    this.verdict = null;
    this.update();
    return this.score;
  }

  async tally() {
    if (this.phase === 'idle') return false;
    if (this.phase === 'result') return false;
    this.runId += 1;              // 只作废原辩论；正在播放的一句说完再结算
    this.interactions = [];
    await this.finish(this.runId);
    return true;
  }

  stop() {
    this.runId += 1;
    for (const item of this.interactions) {
      if (item.kind === 'chat') this.record('cancelled', { chatId: item.msg.id, name: item.msg.name, text: item.msg.text });
    }
    this.interactions = [];
    this.playback?.finish();
    this.broadcast('debate-stop', { run: this.runId });
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.phase = 'idle';
    this.topic = '';
    this.author = '';
    this.round = 0;
    this.votes = { fish: 0, doubao: 0 };
    this.verdict = null;
    this.deadline = 0;
    this.speaking = null;
    this.update();
  }
}

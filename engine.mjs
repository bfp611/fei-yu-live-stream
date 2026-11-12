import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const PHASE = {
  WORK: '上班',
  SLACK: '摸鱼',
  PATROL: '巡查'
};

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function partOfDay(h) {
  if (h < 5) return '凌晨';
  if (h < 8) return '清晨';
  if (h < 12) return '上午';
  if (h < 14) return '中午';
  if (h < 18) return '下午';
  if (h < 23) return '晚上';
  return '深夜';
}

export class SalaryEngine extends EventEmitter {
  constructor(config, statePath) {
    super();
    this.cfg = config;
    this.statePath = statePath;
    this.state = this.fresh();
    this.load();
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref?.();
  }

  fresh() {
    const s = this.cfg.salary;
    return {
      shift: 1,
      target: s.target,
      salary: 0,
      phase: PHASE.WORK,
      restLeft: 0,
      focusMinutes: 0,
      gifts: 0,
      caught: 0,
      delivered: 0,
      likes: 0,
      viewers: 0,
      mood: this.cfg.persona.mood,
      speaker: this.cfg.persona.name,
      speakerStatus: '正在认真上班',
      line: '第 1 班开工，先攒工资，攒够就摸鱼。',
      clock: '',
      updatedAt: Date.now(),
      patrolAt: Date.now() + this.patrolDelay()
    };
  }

  load() {
    try {
      const raw = JSON.parse(readFileSync(this.statePath, 'utf8'));
      if (raw && typeof raw.salary === 'number') {
        this.state = { ...this.state, ...raw };
        const st = this.state;
        if (st.salary >= st.target) {
          if (st.phase !== PHASE.SLACK || !(st.restLeft > 0)) {
            st.phase = PHASE.SLACK;
            st.restLeft = Math.max(1, st.restLeft || 1);
          }
        } else if (st.phase !== PHASE.WORK) {
          st.phase = PHASE.WORK;
          st.restLeft = 0;
        }
      }
    } catch {
      /* first run */
    }
    this.tickClock();
  }

  save() {
    const now = Date.now();
    if (this.lastSave && now - this.lastSave < 2500) return;
    this.lastSave = now;
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      writeFileSync(this.statePath, JSON.stringify(this.state));
    } catch {
      /* persistence is best-effort */
    }
  }

  patrolDelay() {
    const { patrolMinSeconds: a, patrolMaxSeconds: b } = this.cfg.salary;
    return (a + Math.random() * Math.max(1, b - a)) * 1000;
  }

  tickClock() {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    this.state.clock = `${hh}:${mm}`;
    this.state.partOfDay = partOfDay(d.getHours());
  }

  snapshot() {
    const st = this.state;
    return {
      ...st,
      progress: clamp(st.salary / st.target, 0, 1),
      targetReached: st.salary >= st.target,
      restText: st.phase === PHASE.SLACK ? formatClock(st.restLeft) : null
    };
  }

  publish(kind = 'state') {
    this.state.updatedAt = Date.now();
    this.save();
    this.emit('state', { kind, state: this.snapshot() });
  }

  setLine(text, status) {
    if (text) this.state.line = text;
    if (status) this.state.speakerStatus = status;
  }

  addSalary(n, reason) {
    const before = this.state.salary;
    this.state.salary = clamp(this.state.salary + n, 0, this.state.target);
    if (before < this.state.target && this.state.salary >= this.state.target) {
      this.reachTarget(reason);
    }
    this.publish('salary');
  }

  reachTarget(reason) {
    const st = this.state;
    st.phase = PHASE.SLACK;
    st.restLeft = this.cfg.salary.restSeconds;
    st.mood = '光明正大摸鱼';
    st.speakerStatus = '正在合法休息';
    st.line = this.pickLine('target');
    this.emit('event', {
      type: 'target',
      text: `工资达标！${st.speaker} 开始合法摸鱼 ${st.restLeft} 秒`,
      reason
    });
  }

  onChat({ name, text, userId, test }) {
    const st = this.state;
    st.viewers = Math.max(st.viewers, 0);
    this.state.focusMinutes = Math.round((this.state.focusMinutes + this.cfg.salary.focusPerChat) * 10) / 10;
    if (st.phase === PHASE.WORK) {
      this.addSalary(this.cfg.salary.perChat, 'chat');
    } else {
      this.publish('chat');
    }
    this.emit('chat', {
      test: Boolean(test),
      name: name || '观众',
      text: String(text || '').slice(0, 200),
      userId
    });
  }

  onGift({ name, giftName, count = 1, diamond = 1 }) {
    const st = this.state;
    const yuan = Math.max(0, Number(diamond) || 0) * Math.max(1, Number(count) || 1) * 0.1;
    st.gifts += 1;
    const gain = Math.round(Math.max(0, Number(diamond) || 0) * Math.max(1, Number(count) || 1) * this.cfg.salary.perDiamond);
    if (st.phase !== PHASE.PATROL) this.addSalary(gain, 'gift');
    this.emit('gift', { name, giftName, count, diamond, yuan: Math.round(yuan * 100) / 100, gain });
  }

  onLike({ name, count = 1 }) {
    const st = this.state;
    st.likes += count;
    const gain = Math.round(count * this.cfg.salary.perLike);
    if (st.phase === PHASE.WORK && gain > 0) this.addSalary(gain, 'like');
    else this.publish('like');
  }

  onFollow({ name }) {
    this.state.focusMinutes += 1;
    this.addSalary(this.cfg.salary.perFollow, 'follow');
    this.emit('follow', { name });
  }

  onMember() {
    this.publish('member');
  }

  tick() {
    this.tickClock();
    const st = this.state;

    if (st.phase === PHASE.PATROL) {
      if (Date.now() >= st.patrolUntil) {
        if (st.salary >= st.target) {
          st.phase = PHASE.SLACK;
          st.speakerStatus = '正在合法休息';
          st.mood = '惊魂未定';
        } else {
          st.phase = PHASE.WORK;
          st.restLeft = 0;
          st.speakerStatus = this.cfg.persona.status;
          st.mood = '老实上班';
          st.line = '工资被扣回去了，接着上班吧。';
        }
        this.publish('patrol-end');
      }
      return;
    }

    if (st.phase === PHASE.SLACK) {
      st.restLeft -= 1;
      if (st.restLeft <= 0) {
        this.deliver();
      } else if (st.restLeft % 5 === 0) {
        this.publish('rest');
      }
      return;
    }

    if (Date.now() >= st.patrolAt) {
      this.patrol();
      return;
    }
    this.publish('tick');
  }

  patrol() {
    const st = this.state;
    const slack = st.phase === PHASE.SLACK;
    st.phase = PHASE.PATROL;
    st.patrolWasSlack = slack;
    st.patrolUntil = Date.now() + 8000;
    st.patrolAt = Date.now() + this.patrolDelay();
    st.speakerStatus = '领导巡查中';
    st.mood = '装忙';
    if (slack) {
      st.caught += 1;
      st.salary = clamp(st.salary - this.cfg.salary.patrolPenalty, 0, st.target);
      st.line = this.pickLine('caught');
      this.emit('event', { type: 'patrol', caught: true, penalty: this.cfg.salary.patrolPenalty });
    } else {
      st.line = this.pickLine('patrol');
      this.emit('event', { type: 'patrol', caught: false, penalty: 0 });
    }
    this.publish('patrol');
  }

  deliver() {
    const st = this.state;
    st.delivered += 1;
    st.shift += 1;
    st.salary = 0;
    st.restLeft = 0;
    st.phase = PHASE.WORK;
    st.mood = this.cfg.persona.mood;
    st.speakerStatus = this.cfg.persona.status;
    st.line = this.pickLine('deliver');
    this.emit('event', { type: 'deliver', shift: st.shift });
    this.publish('deliver');
  }

  say(text) {
    this.state.line = String(text).slice(0, 160);
    this.publish('say');
  }

  reset() {
    this.state = this.fresh();
    this.tickClock();
    this.publish('reset');
  }

  pickLine(kind) {
    const banks = {
      target: [
        '工资到账，从现在开始是合法摸鱼时间，谁都别拦我。',
        '够了够了，这个月的班就上到这儿，摸鱼！',
        '达标——领导你看，是工资先动的手。'
      ],
      caught: [
        '领导你听我解释，我这是在整理桌面，顺便整理人生。',
        '被抓了，扣钱吧，反正摸鱼那几秒值了。',
        '哎呀，鼠标自己点开的视频，真的。'
      ],
      patrol: [
        '领导好！我在写周报，你看这个字多工整。',
        '巡查就巡查，我这一脸班味你还看不出来吗。'
      ],
      deliver: [
        '摸鱼结束，下一班继续攒，为了下一次摸鱼。',
        '下班，交付。工资清零，快乐不清零。'
      ]
    };
    const bank = banks[kind] || banks.target;
    return bank[Math.floor(Math.random() * bank.length)];
  }
}

function formatClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const m = String(Math.floor(s / 60)).padStart(2, '0');
  const r = String(s % 60).padStart(2, '0');
  return `${m}:${r}`;
}

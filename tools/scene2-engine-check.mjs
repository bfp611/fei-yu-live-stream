// 场景二调度自检：假 LLM/TTS + 真实播放回执，完全离线，无音频和配置副作用。
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { Debate } from '../scenes/debate.mjs';

let checks = 0;
function check(name, fn) { fn(); checks++; console.log(`PASS ${name}`); }
async function until(fn) {
  const deadline = Date.now() + 2000;
  while (!fn()) { if (Date.now() > deadline) throw new Error('等待状态超时'); await tick(); }
}
function harness({ auto = true, judge, reply, synth } = {}) {
  const events = [], updates = [], judged = [], replies = [];
  const config = { tts: { voice: 'fake' }, scenes: { debate: {
    actors: { fish: { name: '大鲵A' }, doubao: { name: '豆包B' } },
    rules: { voteSeconds: 20 },
    idle: { enabled: true, minSeconds: 0, topics: ['该不该上班摸鱼', '朋友之间该不该借钱'] }
  } } };
  let active = 0, maximum = 0;
  const h = { events, updates, judged, replies, auto, lines: () => events.filter(e => e.type === 'debate-line') };
  h.d = new Debate({ config,
    tts: { synth: synth || (async () => '/media/fake.mp3') },
    llm: {
      debateLine: async ({ topic, side, round }) => `${topic}-${side}-${round}`,
      judgeTopic: async text => { judged.push(text); return judge ? judge(text) : { ok: text.includes('该不该'), topic: text, reason: '普通评论' }; },
      debateReply: async args => { replies.push(args); return reply ? reply(args) : `接评论：${args.message.text}，继续原题。`; }
    },
    broadcast: (type, data) => {
      events.push({ type, ...data });
      if (type === 'debate-line') {
        active++; maximum = Math.max(active, maximum);
        h.d.acknowledge({ id: data.id, clientId: 'stage', status: 'started' });
        if (h.auto) setImmediate(() => h.end());
      }
      if (type === 'debate-stop') active = 0;
    }, onUpdate: st => updates.push(st)
  });
  h.end = () => {
    if (!h.d.playback) return;
    active--;
    h.d.acknowledge({ id: h.d.playback.id, clientId: 'stage', status: 'ended' });
  };
  h.maximum = () => maximum;
  return h;
}

// 完整比赛和投票结算。
{
  const h = harness();
  await h.d.start('该不该上班摸鱼', '测试');
  check('完整局：四句辩论 + 报题 + 投票引导', () => assert.equal(h.lines().length, 6));
  check('完整局：阶段 opening → rebuttal → vote', () => assert.deepEqual([...new Set(h.updates.map(s => s.phase))], ['opening', 'rebuttal', 'vote']));
  await h.d.handleChat({ name: 'A', text: '1' });
  await h.d.handleChat({ name: 'B', text: '支持大鲵A' });
  await h.d.handleChat({ name: 'C', text: '扣2' });
  check('投票保留，数字票不送模型', () => { assert.deepEqual(h.d.votes, { fish: 2, doubao: 1 }); assert.equal(h.judged.length, 0); });
  await h.d.tally();
  check('结算只加一次比分，输方认输，清理计时器', () => { assert.equal(h.d.score.fish, 1); assert.equal(h.d.phase, 'idle'); assert.equal(h.d.timer, null); assert.match(h.lines().at(-1).text, /认输/); });
  check('全局语音最多一条在播放', () => assert.equal(h.maximum(), 1));
  h.d.stop();
}

// 每个进行中的阶段都直接计支持票，且不产生模型/语音调用。
for (const phase of ['opening','rebuttal','vote']) {
  const h=harness();h.d.phase=phase;h.d.topic='该不该上班摸鱼';
  for(const text of ['扣1','1','111','支持大鲵A','扣 ２！']) await h.d.handleChat({name:'观众',text});
  check(`${phase}阶段均能投票，支持率立即更新且不回复`,()=>{
    assert.deepEqual(h.d.votes,{fish:4,doubao:1});
    assert.deepEqual(h.updates.at(-1).votes,{fish:4,doubao:1});
    assert.equal(h.judged.length,0);assert.equal(h.replies.length,0);assert.equal(h.lines().length,0);
  });
  h.d.stop();
}
{
  const h=harness();
  for(const phase of ['idle','result']){h.d.phase=phase;await h.d.handleChat({name:'观众',text:'扣1'});}
  check('未开始或已结算不加票，也不把扣1当普通评论回复',()=>{assert.deepEqual(h.d.votes,{fish:0,doubao:0});assert.equal(h.judged.length,0);});
  check('扣12和评论里提到扣1不会误计票',()=>{assert.equal(h.d.voteSide('扣12'),null);assert.equal(h.d.voteSide('你们是不是要大家扣1呀'),null);});
  h.d.stop();
}

// 正在开口的人欢迎；同句之后弹幕比欢迎优先；普通评论不改辩题。
{
  const h = harness({ auto: false });
  const run = h.d.start('该不该上班摸鱼', '测试');
  await until(() => h.lines().length === 1);
  await h.d.onMember({ name: '小王' });
  await h.d.handleChat({ name: '小李', text: '你们好可爱' });
  check('播放未结束：进场和弹幕均不抢话', () => assert.equal(h.lines().length, 1));
  h.end();
  await until(() => h.lines().length === 2);
  check('句末弹幕优先且回复实际评论', () => { assert.match(h.lines()[1].text, /你们好可爱/); assert.equal(h.replies[0].topic, '该不该上班摸鱼'); });
  h.end();
  await until(() => h.lines().length === 3);
  check('欢迎由收到事件时正在说话的同一角色说', () => { assert.equal(h.lines()[2].side, h.lines()[0].side); assert.match(h.lines()[2].text, /小王，快来出个辩题/); });
  h.auto = true; h.end(); await run;
  check('回复评论后继续原题直到投票', () => { assert.equal(h.d.topic, '该不该上班摸鱼'); assert.equal(h.d.phase, 'vote'); assert.equal(h.maximum(), 1); });
  h.d.stop();
}

// 播放中收到新题，旧流程、旧计时器不能污染新局；排队评论不能丢。
{
  const h = harness({ auto: false });
  const old = h.d.start('该不该上班摸鱼', '旧题');
  await until(() => h.lines().length === 1);
  await h.d.handleChat({ name: '新观众', text: '朋友之间该不该借钱' });
  await h.d.handleChat({ name: '后续观众', text: '好热闹啊' });
  h.end();
  await until(() => h.d.topic === '朋友之间该不该借钱' && h.lines().length >= 2);
  h.auto = true; h.end();
  await old;
  await until(() => h.d.phase === 'vote');
  check('新题替换旧题并保留后续排队评论', () => { assert.equal(h.d.author, '新观众'); assert.ok(h.replies.some(r => r.message.text === '好热闹啊')); assert.deepEqual(h.d.score, { fish: 0, doubao: 0, draw: 0 }); });
  check('换题后旧题不会再补播', () => assert.equal(h.lines().filter(e => e.text.includes('上班摸鱼')).length, 1));
  h.d.stop();
}

// 预设题轮换；间隔=0有效；清空可停用。
{
  const h = harness();
  await h.d.idleLine();
  check('无人发言会用预设题真正开整局', () => { assert.equal(h.d.topic, '该不该上班摸鱼'); assert.equal(h.lines().length, 6); });
  await h.d.tally();
  await h.d.idleLine();
  check('下一局按配置顺序换题', () => assert.equal(h.d.topic, '朋友之间该不该借钱'));
  h.d.stop();
  h.d.cfg.idle.topics = [];
  await h.d.idleLine();
  check('清空预设题不再自动开局', () => assert.equal(h.d.phase, 'idle'));
}

// TTS 还在合成时 stop，不许补发。
{
  let resolveSynth;
  const h = harness({ synth: () => new Promise(r => { resolveSynth = r; }) });
  const run = h.d.start('该不该上班摸鱼', '测试');
  await until(() => !!resolveSynth);
  h.d.stop(); resolveSynth('/media/late.mp3'); await run;
  check('合成中停止：旧语音不广播', () => { assert.equal(h.lines().length, 0); assert.equal(h.d.phase, 'idle'); });
}

// 投票时普通弹幕仍回应；新题可以替换；播放错误也能放行下一句。
{
  const h = harness();
  await h.d.start('该不该上班摸鱼', '测试');
  await h.d.handleChat({ name: 'A', text: '你说得好有道理' });
  await until(() => h.replies.length === 1 && !h.d.flushing);
  check('投票时的普通弹幕仍送模型回复', () => { assert.equal(h.d.phase, 'vote'); assert.match(h.lines().at(-1).text, /好有道理/); });
  await h.d.handleChat({ name: 'B', text: '朋友之间该不该借钱' });
  await until(() => h.d.topic.includes('借钱') && h.d.phase === 'vote');
  check('投票时新题会清掉旧局计时器、开新局', () => assert.deepEqual(h.d.score, { fish: 0, doubao: 0, draw: 0 }));
  h.d.stop();
}
{
  const h = harness({ auto: false });
  const one = h.d.say('fish', '第一句');
  const two = h.d.say('doubao', '第二句');
  await until(() => h.lines().length === 1);
  h.d.acknowledge({ id: h.d.playback.id, clientId: 'stage', status: 'error' });
  await until(() => h.lines().length === 2);
  h.end(); await Promise.all([one, two]);
  check('播放错误能释放队列，过期回执被忽略', () => assert.equal(h.d.acknowledge({ id: 'old', clientId: 'stage', status: 'ended' }), false));
  h.d.stop();
}
{
  const h = harness({ judge: () => null });
  const greeting = await h.d.judge('你们两个都好可爱呀');
  check('模型离线：长问候不会因字数多被误当新题', () => assert.equal(greeting.ok, false));
  assert.equal((await h.d.judge('上班该不该摸鱼')).ok, true);
  assert.equal((await h.d.judge('聊聊政治吧')).blocked, true);
  h.d.stop();
}
for (const rounds of [1, 3, 6]) {
  const h = harness(); h.d.cfg.rules.rounds = rounds;
  await h.d.start('该不该上班摸鱼', '轮次测试');
  check(`${rounds}轮是双方各${rounds}句，完成后投票`, () => {
    assert.equal(h.lines().length, rounds * 2 + 2);
    assert.equal(h.d.round, rounds); assert.equal(h.d.phase, 'vote');
    assert.equal(h.d.state.totalRounds, rounds);
    const spoken = h.lines().slice(1, -1).map(e => e.side);
    assert.deepEqual(spoken, Array.from({length:rounds}, () => ['fish','doubao']).flat());
    assert.equal(h.maximum(), 1);
  }); h.d.stop();
}
{
  const h = harness({auto:false}); h.d.cfg.rules.rounds = 3;
  const run = h.d.start('该不该上班摸鱼','轮次测试');
  await until(() => h.lines().length===1);
  h.d.cfg.rules.rounds = 6;
  check('中途修改只影响下一局，当前局轮次锁定', () => {
    assert.equal(h.d.state.rounds,6);assert.equal(h.d.state.totalRounds,3);
  });
  h.auto=true;h.end();await run;
  assert.equal(h.lines().length,8);h.d.stop();
}
console.log(`\n${checks} 项场景二引擎检查通过。`);

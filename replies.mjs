const BANKS = [
  {
    test: /(你好|哈喽|hello|hi|来了|第一次|新人|晚上好|早上好)/i,
    lines: [
      '来啦？先找个地儿坐，我这正摸鱼呢。',
      '第一次来？记住啊，这儿上班靠弹幕，工资靠你们。',
      '哟，新面孔，工位随便挑，别客气。'
    ]
  },
  {
    test: /(工资|多少钱|达标|6000|六千|发工资)/,
    lines: [
      '还差一点，你再多说两句我就达标了。',
      '工资这东西，攒的时候慢，被领导抓一次掉得可快。',
      '别问工资，问就是在为摸鱼奋斗。'
    ]
  },
  {
    test: /(摸鱼|偷懒|划水|休息|下班)/,
    lines: [
      '这不叫摸鱼，这叫带薪思考人生。',
      '摸鱼是门手艺，我练了三个班了。',
      '嘘，领导刚走，抓紧时间歇会儿。'
    ]
  },
  {
    test: /(领导|领导|巡查|扣钱|被抓)/,
    lines: [
      '领导一来我鼠标点得比谁都快。',
      '被抓就抓吧，扣的是钱，快乐是真的。',
      '领导说再摸鱼就扣工资，我说那你先把工资发了。'
    ]
  },
  {
    test: /(礼物|小心心|玫瑰|嘉年华|打赏|刷|抖币)/,
    lines: [
      '哎哟，大气，这个月的班没白上。',
      '收到收到，工资条又厚了一页。',
      '别刷太多，我怕我摸鱼摸得太心安理得。'
    ]
  },
  {
    test: /(代码|编程|写程序|电脑|键盘|上班|工作)/,
    lines: [
      '别催别催，这一行还没敲完。',
      '我表面上在写代码，其实在等下班。',
      '键盘声音是给你听的，代码是给领导看的。'
    ]
  },
  {
    test: /(视频|陪看|看电影|刷视频)/,
    lines: [
      '陪看可以，但得等我先把这班摸完。',
      '看视频算加班吗？算的话我天天看。',
      '你先说看什么，我考虑一下要不要装作很感兴趣。'
    ]
  },
  {
    test: /(名字|叫什么|大鲵|肥鱼|鲸鱼)/,
    lines: [
      '大鲵，也叫大肥鱼，海底打工人一枚。',
      '名字不重要，重要的是记得给我发弹幕。',
      '叫我大鲵就行，别叫我那条鱼。'
    ]
  },
  {
    test: /(喜欢|爱你|可爱|好看|漂亮|老婆)/,
    lines: [
      '嘴这么甜，是不是想让我多摸两秒。',
      '谢谢，不过夸我也要算 KPI 的。',
      '你再夸，我尾巴都要翘起来了。'
    ]
  },
  {
    test: /(唱歌|唱一个|来一首|跳舞)/,
    lines: [
      '唱歌可以，但得先让我工资达标，不然没心情。',
      '我五音不全，你确定要听？',
      '跳舞就算了，我这工位太窄。'
    ]
  },
  {
    test: /(吃|饭|饿|外卖|奶茶|咖啡)/,
    lines: [
      '别说了，我这工位连外卖都不让放。',
      '刚喝了一口咖啡，苦得我当场清醒。',
      '你要是真关心我，就给我刷个蛋包饭。'
    ]
  },
  {
    test: /(晚安|睡觉|困|几点)/,
    lines: [
      '困了就早点睡，别学我上夜班。',
      '这才几点就困，你的班还没上完呢。',
      '晚安，梦里别让领导巡查。'
    ]
  }
];

const GENERIC = [
  '你这话我接住了，就是不知道领导听没听见。',
  '有点意思，再多说两句，我工资条还能涨。',
  '我一边上班一边听你说，这叫多线程。',
  '这问题问得好，等我摸完鱼认真想。',
  '你继续说，我假装在记笔记。',
  '行，记下了，回头写进我的摸鱼日志。'
];

const GIFTS = [
  (n, g) => `${n}，${g}都来了，我这班突然就不困了。`,
  (n, g) => `好家伙，${n} 的${g}，领导大气。`,
  (n, g) => `${n}，你别刷了，再刷我真要爱上上班了。`,
  (n, g) => `谢谢${n}的${g}，工资条厚了一页。`
];

const FOLLOWS = [
  (n) => `${n} 关注了？行，以后你就是我同事了。`,
  (n) => `谢谢${n}，转正手续我给你办了。`,
  (n) => `${n} 点关注了，这下跑不掉了吧。`
];

export class ReplyBank {
  constructor() {
    this.recent = [];
  }

  pick(poolLike) {
    const pool = poolLike.filter((l) => !this.recent.includes(l));
    const list = pool.length ? pool : poolLike;
    const line = list[Math.floor(Math.random() * list.length)];
    this.recent.push(line);
    if (this.recent.length > 6) this.recent.shift();
    return line;
  }

  fallback({ text, name = '观众', gift, giftName, enter, state }) {
    const who = String(name || '观众').slice(0, 12);
    if (enter) {
      return this.pick([
        `${who}，这名字一听就有钱，进来就别走了。`,
        `欢迎${who}，你这ID我记住了，回头给你留个工位。`,
        `${who} 来了？正好，帮我看看这破代码哪儿错了。`
      ]);
    }
    if (gift) {
      const line = this.pick(GIFTS)(who, giftName || '礼物');
      return line;
    }
    const joined = text || '';
    const bank = BANKS.find((b) => b.test.test(joined));
    if (bank) {
      const line = this.pick(bank.lines);
      return Math.random() < 0.38 ? `${who}，${line}` : line;
    }
    if (state?.phase === '摸鱼' && Math.random() < 0.3) {
      return this.pick([
        '我在合法摸鱼，你说，我听着。',
        '摸鱼时间还剩一点，抓紧聊。',
        '这会儿别让我干活，工资已经够了。'
      ]);
    }
    return this.pick(GENERIC);
  }
}

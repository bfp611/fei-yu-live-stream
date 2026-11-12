import { EventEmitter } from 'node:events';
import DouyinClient from './lib/douyin-danma/index.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

export class DouyinSource extends EventEmitter {
  constructor(config) {
    super();
    this.cfg = config.douyin;
    this.client = null;
    this.status = '未连接';
    this.roomId = null;
    this.webRid = null;
    this.since = 0;
    this.counts = { chat: 0, gift: 0, member: 0, like: 0, follow: 0 };
    this.seen = new Set();
    this.combo = new Map();
    this.rankScores = new Map();
  }

  async resolveRoomId(input) {
    const raw = String(input || '').trim();
    // 分享短链（v.douyin.com/xxx）先跟随跳转，拿到 reflow 里的 room_id
    if (/v\.douyin\.com\//.test(raw)) {
      const res = await fetch(raw, { headers: { 'User-Agent': UA }, redirect: 'follow' });
      const finalUrl = res.url || '';
      const room = finalUrl.match(/reflow\/(\d+)/) || finalUrl.match(/live\.douyin\.com\/(\d{5,})/);
      if (room) return { webRid: null, roomId: room[1] };
      throw new Error('分享链接里没有解析到直播间，请在浏览器打开链接后复制 live.douyin.com 那条');
    }
    const match = raw.match(/(?:live\.douyin\.com\/)?(\d{5,})/);
    if (!match) throw new Error('直播间号格式不正确，应形如 123456789');
    const num = match[1];
    if (num.length >= 15) return { webRid: null, roomId: num };
    const res = await fetch(`https://live.douyin.com/${num}`, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      redirect: 'follow'
    });
    if (!res.ok) throw new Error(`打开直播间失败：HTTP ${res.status}`);
    const html = await res.text();
    const room = html.match(/roomId\\":\\"(\d+)/) || html.match(/"roomId":"(\d+)"/);
    if (!room) throw new Error('没有在直播间页面找到 roomId，可能未开播或页面结构变化');
    return { webRid: num, roomId: room[1] };
  }

  async connect(input) {
    await this.disconnect();
    const rid = input ?? this.cfg.roomId;
    if (!rid) throw new Error('请先填写抖音直播间号（live.douyin.com/ 后面的数字）');
    this.status = '解析直播间…';
    this.emitStatus();
    let resolved;
    try {
      resolved = await this.resolveRoomId(rid);
    } catch (err) {
      this.status = `连接失败：${err.message}`;
      this.emitStatus();
      throw err;
    }
    this.webRid = resolved.webRid;
    this.roomId = resolved.roomId;
    this.counts = { chat: 0, gift: 0, member: 0, like: 0, follow: 0 };
    this.seen.clear();
    this.status = '连接中…';
    this.emitStatus();

    const client = new DouyinClient(this.roomId, {
      autoReconnect: 20,
      reconnectInterval: 5000,
      heartbeatInterval: 10000,
      timeoutInterval: 120000
    });
    this.client = client;
    client.on('open', () => {
      this.status = '已连接抖音弹幕';
      this.since = Date.now();
      this.emitStatus();
    });
    client.on('close', () => {
      this.status = '连接断开，自动重连中…';
      this.emitStatus();
    });
    client.on('error', (err) => {
      this.status = `连接异常：${err?.message || err}`;
      this.emitStatus();
    });
    client.on('reconnect', (n) => {
      this.status = `第 ${n} 次重连…`;
      this.emitStatus();
    });
    client.on('chat', (m) => {
      if (this.dupe(m)) return;
      this.counts.chat++;
      this.bump();
      this.emit('chat', {
        name: m.user?.nickName || '观众',
        text: m.content || '',
        userId: String(m.user?.id || ''),
        avatar: pickAvatar(m.user)
      });
    });
    client.on('gift', (m) => {
      console.log('[debug] gift event', m && m.gift && m.gift.name, m && m.comboCount);
      if (this.dupe(m)) return;
      this.counts.gift++;
      this.bump();
      this.emit('gift', {
        name: m.user?.nickName || '观众',
        giftName: m.gift?.name || '礼物',
        count: Number(m.comboCount || m.gift?.comboCount || 1),
        diamond: Number(m.gift?.diamondCount || 0),
        avatar: pickAvatar(m.user)
      });
    });
    client.on('member', (m) => {
      this.counts.member++;
      this.bump();
      this.emit('member', { name: m.user?.nickName || '观众', userId: String(m.user?.id || '') });
    });
    client.on('like', (m) => {
      this.counts.like++;
      this.bump();
      this.emit('like', { name: m.user?.nickName || '观众', count: Number(m.count || 1) });
    });
    client.on('social', (m) => {
      this.counts.follow++;
      this.bump();
      this.emit('follow', { name: m.user?.nickName || '观众' });
    });
    client.connect();
    this.emitStatus();
  }

  dupe(m) {
    const id = m?.common?.msgId || m?.common?.msgIdStr;
    if (!id) return false;
    if (this.seen.has(id)) return true;
    this.seen.add(id);
    if (this.seen.size > 800) {
      const first = this.seen.values().next().value;
      this.seen.delete(first);
    }
    return false;
  }

  bump() {
    const now = Date.now();
    if (this.lastBump && now - this.lastBump < 1000) return;
    this.lastBump = now;
    this.emitStatus();
  }

  emitStatus() {
    this.emit('status', this.snapshot());
  }

  snapshot() {
    return {
      status: this.status,
      roomId: this.roomId,
      webRid: this.webRid,
      since: this.since,
      counts: { ...this.counts }
    };
  }

  async disconnect() {
    if (this.client) {
      try {
        this.client.close();
      } catch {
        /* ignore */
      }
      this.client = null;
    }
    this.status = '未连接';
    this.emitStatus();
  }
}

function pickAvatar(user) {
  const urls = user?.avatarThumb?.urlList;
  return Array.isArray(urls) && urls.length ? urls[0] : null;
}

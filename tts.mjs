import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, readdirSync, unlinkSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EdgeTTS } from '@andresaya/edge-tts';

const run = promisify(execFile);

// 与桌宠 dsh-pet 完全一致的四个音色（src/host/voice/voices.ts），默认晓伊。
const VOLC_VOICES = [
  { id: 'zh_female_tianmeixiaoyuan_uranus_bigtts', name: '甜美小源 · 甜妹', locale: 'zh-CN' },
  { id: 'zh_female_tianmeitaozi_uranus_bigtts', name: '甜美桃子', locale: 'zh-CN' },
  { id: 'zh_female_kailangjiejie_uranus_bigtts', name: '开朗姐姐 · 活泼', locale: 'zh-CN' },
  { id: 'zh_female_mengyatou_uranus_bigtts', name: '萌丫头 · 可爱', locale: 'zh-CN' },
  { id: 'zh_female_shuangkuaisisi_uranus_bigtts', name: '爽快思思', locale: 'zh-CN' },
  { id: 'zh_female_linjianvhai_uranus_bigtts', name: '邻家女孩', locale: 'zh-CN' },
  { id: 'zh_female_qingxinnvsheng_uranus_bigtts', name: '清新女声', locale: 'zh-CN' },
  { id: 'zh_female_qingchezizi_uranus_bigtts', name: '清澈梓梓', locale: 'zh-CN' },
  { id: 'zh_female_tiexinnvsheng_uranus_bigtts', name: '贴心女声', locale: 'zh-CN' },
  { id: 'zh_female_jitangmei_uranus_bigtts', name: '鸡汤妹妹', locale: 'zh-CN' },
  { id: 'zh_female_qinqienv_uranus_bigtts', name: '亲切女声', locale: 'zh-CN' },
  { id: 'zh_female_wenroushunv_uranus_bigtts', name: '温柔淑女', locale: 'zh-CN' },
  { id: 'zh_female_wenjingmaomao_uranus_bigtts', name: '文静毛毛', locale: 'zh-CN' },
  { id: 'zh_female_gaolengyujie_uranus_bigtts', name: '高冷御姐', locale: 'zh-CN' },
  { id: 'zh_female_sophie_uranus_bigtts', name: '魅力苏菲', locale: 'zh-CN' },
  { id: 'zh_female_yingtaowanzi_uranus_bigtts', name: '樱桃丸子', locale: 'zh-CN' },
  { id: 'zh_female_vv_uranus_bigtts', name: 'Vivi · 亲切', locale: 'zh-CN' },
  { id: 'zh_female_xiaohe_uranus_bigtts', name: '小何 · 柔和', locale: 'zh-CN' },
  { id: 'zh_female_zhixingnv_uranus_bigtts', name: '知性女声', locale: 'zh-CN' },
  { id: 'zh_female_popo_uranus_bigtts', name: '婆婆 · 年长', locale: 'zh-CN' }
];

const EDGE_VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓 · 通用', locale: 'zh-CN' },
  { id: 'zh-CN-XiaoyiNeural', name: '晓伊 · 活泼', locale: 'zh-CN' },
  { id: 'zh-CN-YunxiNeural', name: '云希 · 年轻男声', locale: 'zh-CN' },
  { id: 'zh-CN-YunjianNeural', name: '云健 · 沉稳男声', locale: 'zh-CN' }
];

export class TTS {
  constructor(config, cacheDir) {
    this.cfg = config.tts;
    this.dir = resolve(cacheDir);
    this.memo = new Map();
    this.synthChain = Promise.resolve();
    this.edgeCooldownUntil = 0;
    this.edgeChain = Promise.resolve();
    this.edgeNextAt = 0;
    mkdirSync(this.dir, { recursive: true });
    this.sweep();
  }

  get voices() {
    if (this.cfg.provider === 'volc') {
      return VOLC_VOICES;
    }
    if (this.cfg.provider === 'say') {
      return [{ id: 'Tingting', name: 'Tingting · 系统中文', locale: 'zh-CN' }, { id: 'Meijia', name: 'Meijia · 系统台湾', locale: 'zh-TW' }];
    }
    return EDGE_VOICES;
  }

  sweep() {
    try {
      const files = readdirSync(this.dir)
        .map((f) => ({ f, t: statSync(join(this.dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      for (const { f } of files.slice(260)) unlinkSync(join(this.dir, f));
    } catch {
      /* ignore */
    }
  }

  async volcSynth(text, voice, rate, signal) {
    if (signal?.aborted || (this.session && !this.session.active)) return null;
    const key = this.cfg.volcApiKey;
    if (!key) throw new Error('missing volc api key');
    const body = {
      user: { uid: 'alive-studio' },
      req_params: {
        text,
        speaker: voice,
        audio_params: { format: 'mp3', sample_rate: 24000, speech_rate: Math.max(-50, Math.min(100, Number(rate) || 0)) }
      }
    };
    const res = await fetch('https://openspeech.bytedance.com/api/v3/tts/unidirectional', {
      method: 'POST',
      headers: {
        'X-Api-Key': key,
        'X-Api-Resource-Id': this.cfg.volcResourceId || 'seed-tts-2.0',
        'X-Api-Request-Id': crypto.randomUUID(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([AbortSignal.timeout(20000), signal]) : AbortSignal.timeout(20000)
    });
    const raw = await res.text();
    const chunks = raw.split('\n').map((l) => l.trim()).filter(Boolean);
    const parts = [];
    for (const line of chunks) {
      try {
        const j = JSON.parse(line);
        if (j.code && j.code !== 0 && j.code !== 20000000) throw new Error(j.message || `volc code ${j.code}`);
        if (j.data) parts.push(Buffer.from(j.data, 'base64'));
      } catch (e) {
        if (e instanceof SyntaxError) continue;
        throw e;
      }
    }
    if (!parts.length) throw new Error('empty volc audio');
    return Buffer.concat(parts);
  }

  synth(text, opts = {}) {
    // 正式发言、欢迎、谢礼、试听共用1个合成通道，两个角色不需要买2并发。
    const signal = this.session?.signal;
    const run = () => {
      if (signal?.aborted || (this.session && !this.session.active)) return null;
      return this.synthOne(text, opts);
    };
    const task = this.synthChain.then(run, run);
    this.synthChain = task.catch(() => null);
    return task;
  }

  async synthOne(text, opts = {}) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    if (!clean || !this.cfg.enabled || (this.session && !this.session.active)) return null;
    const signal = this.session?.signal;

    const useVolc = this.cfg.provider === 'volc';
    const useEdge = this.cfg.provider === 'edge' && Date.now() >= this.edgeCooldownUntil;
    const voice = (useVolc ? (opts.voice || this.cfg.voice) : useEdge ? (opts.voice || this.cfg.voice) : (this.cfg.fallbackVoice || 'Tingting')) || 'zh_female_xiaohe_uranus_bigtts';
    const rate = Number.isFinite(Number(opts.rate)) ? Number(opts.rate) : Number(this.cfg.rate) || 0;
    const hash = createHash('sha1')
      .update(`${useEdge ? 'edge' : 'say'}|${voice}|${rate}|${this.cfg.pitch}|${clean}`)
      .digest('hex')
      .slice(0, 16);
    if (this.memo.has(hash)) return this.memo.get(hash);

    if (useVolc) {
      const out = join(this.dir, `${hash}.mp3`);
      if (existsSync(out)) {
        const url = `/media/${hash}.mp3`;
        this.memo.set(hash, url);
        return url;
      }
      let last;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (signal?.aborted || (this.session && !this.session.active)) return null;
        try {
          const buf = await this.volcSynth(clean, voice, rate, signal);
          if (signal?.aborted) return null;
          if (!buf || buf.length < 1000) throw new Error('empty volc audio');
          writeFileSync(out, buf);
          const url = `/media/${hash}.mp3`;
          this.memo.set(hash, url);
          return url;
        } catch (err) {
          if (signal?.aborted || (this.session && !this.session.active)) return null;
          last = err;
          await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
        }
      }
      console.warn('[tts] 豆包 TTS 失败，本条跳过语音：', last?.message || last);
      return null;
    }

    if (useEdge) {
      const out = join(this.dir, `${hash}.mp3`);
      if (existsSync(out)) {
        const url = `/media/${hash}.mp3`;
        this.memo.set(hash, url);
        return url;
      }
      try {
        const buf = await this.edgeQueued(clean, voice, rate, signal);
        if (!buf || buf.length < 1000) throw new Error('empty edge audio');
        writeFileSync(out, buf);
        const url = `/media/${hash}.mp3`;
        this.memo.set(hash, url);
        return url;
      } catch (err) {
        this.edgeCooldownUntil = Date.now() + 20000;
        // 不再回退到系统语音：宁可这一条没声音，也不让观众听到机器音
        console.warn('[tts] Edge TTS 失败，本条跳过语音（不回退 Tingting）：', err?.message || err);
        return null;
      }
    }

    if (this.cfg.provider === 'say') {
      return this.saySynth(clean, this.cfg.fallbackVoice || 'Tingting', hash, signal);
    }
    return null;
  }

  edgeQueued(text, voice, rate, signal) {
    const now = Date.now();
    const wait = Math.max(0, this.edgeNextAt - now);
    this.edgeNextAt = Math.max(now, this.edgeNextAt) + 900;
    const run = async () => {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      if (signal?.aborted || (this.session && !this.session.active)) return null;
      return this.edgeSynth(text, voice, rate, signal);
    };
    const next = this.edgeChain.then(run, run);
    this.edgeChain = next.catch(() => {});
    return next;
  }

  async edgeSynth(text, voice, rateOverride, signal) {
    const rate = Number.isFinite(Number(rateOverride)) ? Number(rateOverride) : Number(this.cfg.rate) || 0;
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (signal?.aborted || (this.session && !this.session.active)) return null;
      try {
        const tts = new EdgeTTS();
        const result = await tts.generate(text, voice, {
          rate: `${rate >= 0 ? '+' : ''}${rate}%`,
          timeout: 15000
        });
        if (signal?.aborted) return null;
        const audio = result?.audio;
        if (!audio) throw new Error('empty edge audio');
        return Buffer.isBuffer(audio) ? audio : Buffer.from(audio);
      } catch (err) {
        lastError = err;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  async saySynth(clean, voice, hash, signal) {
    if (signal?.aborted || (this.session && !this.session.active)) return null;
    const out = join(this.dir, `${hash}.m4a`);
    if (existsSync(out)) {
      const url = `/media/${hash}.m4a`;
      this.memo.set(hash, url);
      return url;
    }
    const aiff = join(this.dir, `${hash}.aiff`);
    try {
      await run('say', ['-v', voice, '-r', '185', '-o', aiff, clean], { timeout: 20000, signal });
      await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', aiff, '-c:a', 'aac', '-b:a', '96k', out], { timeout: 20000, signal });
    } catch {
      return null;
    } finally {
      try {
        if (existsSync(aiff)) unlinkSync(aiff);
      } catch {
        /* ignore */
      }
    }
    if (!existsSync(out)) return null;
    const url = `/media/${hash}.m4a`;
    this.memo.set(hash, url);
    return url;
  }
}

export function plainSpeech(text) {
  return String(text || '')
    .replace(/[（(][^）)]{0,30}[）)]/g, '')
    .replace(/[*#`>]/g, '')
    .trim();
}

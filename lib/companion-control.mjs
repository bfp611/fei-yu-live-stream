import { spawn } from 'node:child_process';
import { join } from 'node:path';

// Only the explicit connect action launches applications; status reads never do.
export function createCompanionControl({ root, appUrl, env = process.env }) {
  const cdp = env.CDP || 'http://127.0.0.1:9222';
  const healthUrl = `http://127.0.0.1:${env.COLLECTOR_PORT || 3089}/health`;
  let launching = null;
  let lastError = '';
  const matches = data => data.target === appUrl && data.cdp === cdp && data.root === root;
  async function status() {
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1200) });
      const data = await response.json();
      if (data.app !== 'alive-gift-collector') throw new Error('unknown collector');
      if (!matches(data)) return { state: 'conflict', message: '采集端口已由其他项目或旧版采集器使用，请先关闭原采集器，再连接本项目。' };
      if (data.connected) return { state: 'connected', message: '礼物采集已连接；只处理连接后新出现的礼物。', target: appUrl };
      return { state: 'waiting', message: data.error || '采集器已启动，等待直播伴侣连接。', target: appUrl };
    } catch {
      return { state: launching ? 'starting' : 'idle', message: launching ? '正在连接直播伴侣…' : lastError || '尚未连接礼物采集。请点击连接直播伴侣。' };
    }
  }
  function start() {
    if (launching) return launching;
    launching = (async () => {
      const current = await status();
      if (current.state === 'connected') return current;
      if (current.state === 'conflict') throw new Error(current.message);
      lastError = '';
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [join(root, 'companion.mjs')], {
          cwd: root, env: { ...env, APP: appUrl, CDP: cdp }, windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        });
        let output = '';
        const collect = chunk => { output = (output + chunk.toString()).slice(-6000); };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        const timer = setTimeout(() => { child.kill(); reject(new Error('连接超时，请检查直播伴侣是否正常启动后重试。')); }, 45000);
        child.once('error', err => { clearTimeout(timer); reject(err); });
        child.once('close', code => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(output.trim() || '直播伴侣连接失败，请重试。'));
        });
      });
      return status();
    })().catch(err => { lastError = err.message; throw err; }).finally(() => { launching = null; });
    return launching;
  }
  return { status, start };
}

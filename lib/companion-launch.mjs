import { spawn, spawnSync } from 'node:child_process';
import { resolve, win32 } from 'node:path';

// GUI applications must not inherit the architecture of a Rosetta Node process.
// LaunchServices also preserves the normal macOS application launch context.
export function companionLaunchSpec({ target, cdp, platform = process.platform, appleSilicon = false }) {
  const endpoint = new URL(cdp);
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(endpoint.hostname)) {
    throw new Error('直播伴侣调试地址必须是本机 HTTP 地址。');
  }
  const args = ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${endpoint.port || '80'}`];
  if (platform === 'win32') return { command: target, args, cwd: win32.dirname(target) };
  if (platform !== 'darwin') throw new Error('自动启动直播伴侣仅支持 macOS 和 Windows；其他系统请手动启动调试伴侣。');
  const marker = '.app/Contents/MacOS/';
  const index = target.indexOf(marker);
  if (index < 0) throw new Error('Mac 直播伴侣必须位于完整的 .app 应用包中。');
  const bundle = resolve(target.slice(0, index + 4));
  const openArgs = ['-a', bundle, '--args', ...args];
  return appleSilicon
    ? { command: '/usr/bin/arch', args: ['-arm64', '/usr/bin/open', ...openArgs] }
    : { command: '/usr/bin/open', args: openArgs };
}

export function companionLaunchEnv(env) {
  const cleanEnv = { ...env };
  for (const key of Object.keys(cleanEnv)) {
    if (/^(ELECTRON_|NODE_OPTIONS$|NODE_PATH$|DYLD_|DSH_)/.test(key)) delete cleanEnv[key];
  }
  return cleanEnv;
}

export function isAppleSilicon({ platform = process.platform, arch = process.arch, probe = spawnSync } = {}) {
  if (platform !== 'darwin') return false;
  if (arch === 'arm64') return true;
  // process.arch may be x64 under Rosetta; inspect the host hardware instead.
  const result = probe('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'], { encoding: 'utf8', timeout: 2000 });
  if (!result.error && result.status === 0 && ['0', '1'].includes(result.stdout?.trim())) return result.stdout.trim() === '1';
  // Some Intel macOS releases do not expose hw.optional.arm64.
  const brand = probe('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8', timeout: 2000 });
  if (!brand.error && brand.status === 0) {
    if (/^Apple\b/i.test(brand.stdout?.trim() || '')) return true;
    if (/Intel/i.test(brand.stdout || '')) return false;
  }
  throw new Error('无法确认 Mac 硬件架构，请手动以调试模式打开伴侣后再连接。');
}

export async function launchCompanion({ target, cdp, env }) {
  const appleSilicon = isAppleSilicon();
  const spec = companionLaunchSpec({ target, cdp, appleSilicon });
  const cleanEnv = companionLaunchEnv(env);
  await new Promise((resolveLaunch, reject) => {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd, env: cleanEnv, detached: process.platform !== 'darwin',
      windowsHide: false, stdio: process.platform === 'darwin' ? ['ignore', 'ignore', 'pipe'] : 'ignore'
    });
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.once('error', reject);
    if (process.platform === 'darwin') {
      child.once('close', code => code === 0 ? resolveLaunch() : reject(new Error(stderr.trim() || `应用启动失败（${code}）`)));
    } else {
      child.once('spawn', () => { child.unref(); resolveLaunch(); });
    }
  });
  return { nativeLaunch: process.platform === 'darwin', appleSilicon };
}

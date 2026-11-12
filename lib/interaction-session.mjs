// 互动总开关：HTTP控制台一直可访问，付费请求只在本次启动会话内允许。
export class InteractionSession {
  constructor({ now = Date.now, timeoutMs = 20000 } = {}) {
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.enabled = false;
    this.generation = 0;
    this.reason = '尚未启动互动';
    this.lastHeartbeat = 0;
    this.changedAt = this.now();
    this.controller = new AbortController();
    this.controller.abort();
  }
  get signal() { return this.controller.signal; }
  get active() { return this.enabled && this.now() - this.lastHeartbeat <= this.timeoutMs; }
  get state() {
    return { enabled: this.enabled, generation: this.generation, reason: this.reason, changedAt: this.changedAt,
      heartbeatTimeoutSeconds: this.timeoutMs / 1000 };
  }
  start() {
    if (this.enabled) { this.heartbeat(); return false; }
    this.controller = new AbortController();
    this.enabled = true;
    this.generation++;
    this.lastHeartbeat = this.now();
    this.changedAt = this.now();
    this.reason = '互动运行中';
    return true;
  }
  heartbeat() { if (this.enabled) this.lastHeartbeat = this.now(); }
  stop(reason = '已手动停止互动') {
    this.enabled = false;
    this.generation++;
    this.reason = reason;
    this.changedAt = this.now();
    this.controller.abort(new Error(reason));
  }
  valid(generation) { return this.active && this.generation === generation; }
}

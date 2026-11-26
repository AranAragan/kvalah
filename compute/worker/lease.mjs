import {ComputeError} from '../protocol/errors.mjs';

const terminal = new Set(['LEASE_EXPIRED','NOT_FOUND','NOT_OWNER','STALE','REVOKED','SESSION_SUPERSEDED']);

export function maintainLease({task, renew, serverNow, onEvent, mono = () => performance.now()}) {
  const abort = new AbortController();
  let expiresAt, expiresMono, deadlineMono, timer, watchdog, closed = false, lastRenewAt = null;

  function stop(error) {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    clearTimeout(watchdog);
    if (error) onEvent('lease.lost', {code:error.code, task:task.task_id});
    abort.abort(error);
  }

  const expire = () => stop(new ComputeError('LEASE_EXPIRED','lease expired before another renewal was confirmed'));

  function setExpiry(expiry, at) {
    expiresAt = Math.min(expiry,task.round_deadline_at);
    expiresMono = Math.min(mono()+expiresAt-at,deadlineMono);
    clearTimeout(watchdog);
    watchdog = setTimeout(expire, Math.max(0,expiresMono-mono()));
  }

  function schedule(retry = false) {
    const remaining = expiresMono-mono();
    if (remaining <= 0) return expire();
    if (expiresAt >= task.round_deadline_at && !retry) return;
    const normal = Math.min(30000,remaining/3)*(0.85+Math.random()*0.3);
    timer = setTimeout(refresh, Math.max(1,retry ? Math.min(1000,remaining/4) : normal));
  }

  async function refresh() {
    try {
      const result = await renew(abort.signal);
      if (closed) return;
      if (!Number.isFinite(result.lease_expires_at)) throw new ComputeError('INVALID_SCHEMA','renewal returned no expiry');
      lastRenewAt = result.server_time ?? serverNow();
      setExpiry(result.lease_expires_at,Math.max(lastRenewAt,serverNow()));
      schedule();
    } catch (error) {
      if (closed) return;
      if (terminal.has(error.code)) return stop(error);
      onEvent('lease.retry', {code:error.code, task:task.task_id});
      schedule(true);
    }
  }

  const start = serverNow();
  deadlineMono = mono()+task.round_deadline_at-start;
  setExpiry(task.lease_expires_at,start);
  schedule();
  return {
    signal:abort.signal,
    stop,
    check() {
      if (!closed && mono() >= expiresMono) expire();
      abort.signal.throwIfAborted();
    },
    get snapshot() {
      return {expires_at:expiresAt, last_renew_at:lastRenewAt, remaining_ms:Math.max(0,expiresMono-mono())};
    }
  };
}

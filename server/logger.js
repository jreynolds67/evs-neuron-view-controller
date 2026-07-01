// server/logger.js
// Lightweight in-memory ring buffer of board API activity, surfaced on the admin page.
// No files, no external deps. Survives only until container restart — that's fine for
// live troubleshooting.

const MAX = 500;
const buffer = [];
let seq = 0;

// Pull the useful low-level detail out of a thrown fetch/undici error. Node's fetch
// wraps the real reason in error.cause, where ECONNREFUSED/ETIMEDOUT/ENOTFOUND/
// EHOSTUNREACH actually live — that code is what tells us WHY a board is unreachable.
export function describeError(err) {
  const cause = err?.cause || err;
  const code = cause?.code || (err?.name === 'AbortError' ? 'ETIMEDOUT (client abort)' : null);
  const parts = [];
  if (code) parts.push(code);
  if (cause?.message && cause.message !== err?.message) parts.push(cause.message);
  parts.push(err?.message || String(err));
  return { code: code || 'ERROR', detail: parts.filter(Boolean).join(' · ') };
}

export function log(entry) {
  const rec = {
    id: ++seq,
    ts: Date.now(),
    ...entry,
  };
  buffer.push(rec);
  if (buffer.length > MAX) buffer.shift();
  // Also mirror to container stdout so it shows in Portainer logs.
  const tag = rec.ok === false ? 'ERR ' : '';
  console.log(`[board] ${tag}${rec.method || ''} ${rec.ip || ''}${rec.path || ''} ` +
    `${rec.status ?? ''} ${rec.durationMs ?? ''}ms ${rec.error ? '- ' + rec.error : ''}`.trim());
  return rec;
}

export function getEntries(sinceId = 0) {
  return buffer.filter((r) => r.id > sinceId);
}

export function clear() {
  buffer.length = 0;
}

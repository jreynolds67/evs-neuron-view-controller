// server/util.js
// Small shared utilities with no project dependencies.

import { writeFile, rename } from 'node:fs/promises';

// Strict UUID shape check. The API spec never declares `format: uuid`, so this is an
// observation about the firmware rather than a contract — but one the app already depends
// on everywhere (snapshot/head/widget ids are all this shape).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

// Crash-safe file write: write to a sibling temp file, then rename into place. A reader
// never sees a half-written file; a crash mid-write leaves only a stray .tmp.
export async function writeAtomic(path, data) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

// Serialise async writes through a promise chain. Two concurrent writers against ONE shared
// temp path can otherwise interleave (each renames the other's half-written file into place).
// The chain survives a failed write (a rejected link would poison every later write), while
// each caller still sees their own failure via the returned promise.
export function makeWriteChain() {
  let chain = Promise.resolve();
  return function enqueue(job) {
    const run = chain.then(job);
    chain = run.then(() => {}, () => {});
    return run;
  };
}

// Run `worker` over `items` with bounded concurrency. An individual failure does NOT abort
// the run — the caller gets a count of failures and decides what that means. Bounded so a
// big item list can't stampede a board's fragile storage layer all at once.
export async function runPool(items, worker, concurrency = 16) {
  let i = 0;
  let failed = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { await worker(items[idx], idx); } catch { failed++; }
    }
  });
  await Promise.all(runners);
  return failed;
}

// Whether to trust the X-Forwarded-For header for the client IP. OFF by default: on a flat
// macvlan with no reverse proxy, XFF is attacker-controlled — anything on the network could
// forge it to impersonate a registered panel. Only enable when a trusted proxy actually
// sits in front and sets it, via TRUST_PROXY=1.
const TRUST_PROXY = String(process.env.TRUST_PROXY || '') === '1';

// Normalise the requesting client's IP (strip IPv6-mapped prefix). Uses the real TCP socket
// address unless a trusted proxy is configured (then honour X-Forwarded-For's first hop).
export function clientIp(req) {
  let ip = '';
  if (TRUST_PROXY && req.headers['x-forwarded-for']) {
    ip = req.headers['x-forwarded-for'].split(',')[0].trim();
  } else {
    ip = (req.socket.remoteAddress || '').trim();
  }
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

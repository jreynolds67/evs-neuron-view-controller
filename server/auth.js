// server/auth.js
// Admin authentication: a single username/password stored (hashed) in config, exchanged
// for a short-lived, in-memory session cookie. Sessions are idle-expiring and are NOT
// persisted — a container restart logs everyone out, which is fine for an admin surface.
//
// Password storage: scrypt with a per-credential random salt, encoded as
//   scrypt$<saltHex>$<hashHex>
// so config never holds a plaintext password. Generate one with:
//   node -e "import('./server/auth.js').then(m=>console.log(m.hashPassword(process.argv[1])))" 'yourpassword'
// (or use the printHash helper at the bottom).

import { randomBytes, scryptSync, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

// Async scrypt for the login path: scrypt is deliberately CPU-heavy (tens of ms), and the
// SYNC variant blocks Node's single shared event loop — so a burst of login attempts would
// stall restore requests for every operator facility-wide. The async form runs on libuv's
// threadpool instead, keeping the loop free. hashPassword (a one-off CLI/admin action) can
// stay sync.
const scryptAsync = promisify(scryptCb);

const SESSION_COOKIE = 'nmv_admin';
const IDLE_MS = 30 * 60 * 1000; // 30 minutes of inactivity ends the session

// sessionId -> { user, lastSeen }
const sessions = new Map();

// --- password hashing ------------------------------------------------------

export function hashPassword(plain) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(plain), salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

// Verify a plaintext attempt against a stored `scrypt$salt$hash` string. Constant-time,
// and async so the hash computation runs off the event loop.
export async function verifyPassword(plain, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  let salt, expected;
  try { salt = Buffer.from(parts[1], 'hex'); expected = Buffer.from(parts[2], 'hex'); }
  catch { return false; }
  if (expected.length !== 32) return false;
  let actual;
  try { actual = await scryptAsync(String(plain), salt, 32); } catch { return false; }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// --- sessions --------------------------------------------------------------

export function createSession(user) {
  const id = randomBytes(24).toString('hex');
  sessions.set(id, { user, lastSeen: Date.now() });
  return id;
}

// Returns the session record if valid and not idle-expired, refreshing lastSeen; else null.
export function touchSession(id) {
  if (!id) return null;
  const s = sessions.get(id);
  if (!s) return null;
  if (Date.now() - s.lastSeen > IDLE_MS) { sessions.delete(id); return null; }
  s.lastSeen = Date.now();
  return s;
}

export function destroySession(id) {
  if (id) sessions.delete(id);
}

// Periodic sweep of idle sessions so the map can't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.lastSeen > IDLE_MS) sessions.delete(id);
}, 5 * 60 * 1000).unref?.();

// --- cookie helpers --------------------------------------------------------

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  raw.split(';').forEach((pair) => {
    const i = pair.indexOf('=');
    if (i < 0) return;
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1).trim();
    if (!k) return;
    // decodeURIComponent throws on a malformed escape (e.g. "nmv_admin=%zz"). That must not
    // take down an admin route: requireAdmin and the /admin page call this synchronously, so a
    // throw here surfaces as a 500 instead of a clean 401/redirect. Keep the raw value — a
    // session id is hex, so an un-decodable one simply matches nothing and fails auth normally.
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  });
  return out;
}

export function sessionIdFromReq(req) {
  return parseCookies(req)[SESSION_COOKIE] || null;
}

// Session cookie (no Max-Age/Expires) → dies when the browser session ends. HttpOnly and
// SameSite=Strict; no Secure flag because the container is plain HTTP on a closed network.
export function setSessionCookie(res, id) {
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict`);
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

// Convenience for generating a hash from the CLI:
//   node server/auth.js 'mypassword'
if (process.argv[1] && process.argv[1].endsWith('auth.js') && process.argv[2]) {
  // eslint-disable-next-line no-console
  console.log(hashPassword(process.argv[2]));
}

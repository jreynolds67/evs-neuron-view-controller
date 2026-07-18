// server/adminroutes.js
// The admin API (mounted at /api/admin): login/session, config read/write, board probes,
// the activity log, share-sweep status, and backup management. Everything except the auth
// endpoints themselves is gated by requireAdmin.

import express from 'express';
import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';

import {
  loadConfig, saveConfig, updateConfig, getCardById, assignedHeadKeys,
} from './config.js';
import {
  getSelf, getSnapshotInfo, getStorageStatus,
  getStorageSync, triggerStorageSync, getHeads, normalizeSnapshotEntry,
} from './board.js';
import { pruneSolo } from './solostore.js';
import { getEntries, clear as clearLog } from './logger.js';
import { shareSweepStatus, runShareSweepNow, applyShareSweepConfig } from './sharesweep.js';
import {
  runBackupNow, backupStatus, listBackups, backupFilePath, hhmmToMinutes, normalizeBackupConfig,
} from './backup.js';
import {
  verifyPassword, createSession, touchSession, destroySession,
  sessionIdFromReq, setSessionCookie, clearSessionCookie,
} from './auth.js';
import { broadcastControl, clientIdOf } from './control.js';
import { clientIp } from './util.js';

const router = express.Router();
export default router;

// Admin API gate: a valid, non-idle session cookie is required. Touching the session here
// also slides the 30-minute idle window forward on every admin request.
function requireAdmin(req, res, next) {
  if (touchSession(sessionIdFromReq(req))) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}

function sendErr(res, e) {
  const status = e.status || 502;
  res.status(status).json({ error: e.message, code: e.code || null, detail: e.detail || e.body || null });
}

// --- auth ------------------------------------------------------------------

// Read the admin credential from config. Shape: config.admin = { user, passwordHash }.
// If no credential is configured, admin auth is effectively disabled and login always
// fails — the operator is expected to set one (the login page explains this).
async function getAdminCred() {
  const cfg = await loadConfig();
  const a = cfg.admin || {};
  return { user: a.user || '', passwordHash: a.passwordHash || '' };
}

// Per-IP login throttle. scrypt is intentionally expensive, so even off the event loop we
// don't want an unbounded attempt rate. Track recent failures per client IP: after a
// threshold within the window, reject fast (before hashing) with a short cooldown. Cleared
// on success. This is a brute-force/self-DoS guard, not a substitute for the strong hash.
const loginAttempts = new Map(); // ip -> { count, first, blockedUntil }
const LOGIN_MAX = 5;             // failures allowed within the window
const LOGIN_WINDOW_MS = 60000;   // rolling window
const LOGIN_BLOCK_MS = 60000;    // cooldown once tripped
function loginThrottle(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec) return { blocked: false };
  if (rec.blockedUntil && now < rec.blockedUntil) return { blocked: true, retryMs: rec.blockedUntil - now };
  if (rec.first && now - rec.first > LOGIN_WINDOW_MS) { loginAttempts.delete(ip); return { blocked: false }; }
  return { blocked: false };
}
function noteLoginFailure(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip) || { count: 0, first: now, blockedUntil: 0 };
  if (now - rec.first > LOGIN_WINDOW_MS) { rec.count = 0; rec.first = now; rec.blockedUntil = 0; }
  rec.count += 1;
  if (rec.count >= LOGIN_MAX) rec.blockedUntil = now + LOGIN_BLOCK_MS;
  loginAttempts.set(ip, rec);
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of loginAttempts) {
    if ((!rec.blockedUntil || now >= rec.blockedUntil) && now - rec.first > LOGIN_WINDOW_MS) loginAttempts.delete(ip);
  }
}, 5 * 60 * 1000).unref?.();

router.post('/login', async (req, res) => {
  const ip = clientIp(req);
  const throttled = loginThrottle(ip);
  if (throttled.blocked) {
    return res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil(throttled.retryMs / 1000)}s.` });
  }
  const { user, password } = req.body || {};
  const cred = await getAdminCred();
  if (!cred.user || !cred.passwordHash) {
    return res.status(503).json({ error: 'No admin credential is configured on the server.' });
  }
  const userOk = typeof user === 'string' && user === cred.user;
  // Always run verification (async / off-loop) even if the user is wrong, so timing
  // doesn't leak which field failed.
  const passOk = await verifyPassword(password || '', cred.passwordHash);
  if (!userOk || !passOk) {
    noteLoginFailure(ip);
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  loginAttempts.delete(ip); // success clears the counter
  const id = createSession(cred.user);
  setSessionCookie(res, id);
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  destroySession(sessionIdFromReq(req));
  clearSessionCookie(res);
  res.json({ ok: true });
});

// Lightweight check the admin page calls on load to confirm the session is still valid.
router.get('/session', (req, res) => {
  const s = touchSession(sessionIdFromReq(req));
  if (!s) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ ok: true, user: s.user });
});

// --- config ----------------------------------------------------------------

router.get('/config', requireAdmin, async (_req, res) => {
  const cfg = await loadConfig();
  const { admin, ...safe } = cfg; // never expose the password hash to the client
  res.json(safe);
});

router.put('/config', requireAdmin, async (req, res) => {
  const next = req.body;
  if (!next || !Array.isArray(next.cards) || !Array.isArray(next.panels)) {
    return res.status(400).json({ error: 'Config must have cards[] and panels[]' });
  }

  // Optimistic concurrency. This PUT is a whole-config REPLACE, so two admin windows open at
  // once were last-write-wins: the second Save silently reverted everything the first changed,
  // and neither side ever saw a sign of it. Refuse a save built on a stale read instead.
  // Checked before any normalisation so a doomed save does no work — but this early check is
  // only the fast-fail: the AUTHORITATIVE check runs inside saveConfig's write lock (see
  // stale409 below), where it can't race another save's in-flight disk write.
  const existing = await loadConfig();
  const currentVersion = Number(existing.configVersion) || 0;
  const clientVersion = Number(next.configVersion) || 0;
  const stale409 = () => res.status(409).json({
    code: 'CONFIG_STALE',
    error: 'Another admin session saved changes since this page loaded, so saving now would '
      + 'silently revert them. Use “Export backup” if you want to keep your edits, then '
      + 'reload the page and reapply them.',
  });
  if (currentVersion !== clientVersion) return stale409();

  next.settings = { showUuids: true, ...(next.settings || {}) };
  if (!next.headFilters || typeof next.headFilters !== 'object') next.headFilters = {};
  if (!Array.isArray(next.panelGroups)) next.panelGroups = [];

  // Reject duplicate card IDs and panel IPs. getCardById/getPanelByIp return the first
  // match, so a duplicate silently produces heads/filters that half-work and are miserable
  // to debug. Fail the save with a clear message instead.
  const cardIds = next.cards.map((c) => (c.id || '').trim()).filter(Boolean);
  const dupCard = cardIds.find((id, i) => cardIds.indexOf(id) !== i);
  if (dupCard) return res.status(400).json({ error: `Duplicate card ID: "${dupCard}". Card IDs must be unique.` });
  const panelIps = next.panels.map((p) => (p.ip || '').trim()).filter(Boolean);
  const dupIp = panelIps.find((ip, i) => panelIps.indexOf(ip) !== i);
  if (dupIp) return res.status(400).json({ error: `Duplicate panel IP: "${dupIp}". Panel IPs must be unique.` });
  (next.panels || []).forEach((p) => { if (!Array.isArray(p.heads)) p.heads = []; });

  // Drop head filters for cards that no longer exist, so deleting a card doesn't leave its
  // per-head snapshot filters orphaned in the config forever. Filters for a head that's merely
  // unassigned are KEPT — the head may be reassigned later, and unlike a deleted card the
  // config can't tell "removed" from "temporarily off a panel". (A deleted card is
  // unambiguous.)
  const liveCardIds = new Set(next.cards.map((c) => (c.id || '').trim()).filter(Boolean));
  for (const key of Object.keys(next.headFilters)) {
    const idx = key.indexOf('::');
    if (idx > 0 && !liveCardIds.has(key.slice(0, idx))) delete next.headFilters[key];
  }

  // `admin` is owned by auth (login) and is never sent to or accepted from the client.
  // We ALWAYS take it from stored config and ignore whatever the client sent.
  // (`existing` was loaded above for the version check.)
  if (existing.admin) next.admin = existing.admin; else delete next.admin;

  // backup and shareSweep are edited inline on the Backups tab, so they arrive with the main
  // save. Validate/normalise both, then re-apply their schedulers so changes take effect
  // immediately.
  if (next.backup && typeof next.backup === 'object') {
    // Reject a bad time rather than silently substituting 03:00. Quietly rewriting it meant a
    // mistyped time saved "successfully" and then backed up at an hour nobody chose, with no
    // warning anywhere. Same rule as the dedicated /api/admin/backup endpoint (both call
    // normalizeBackupConfig, so the two save paths can't drift).
    const b = next.backup;
    if (b.timeHHMM !== undefined && b.timeHHMM !== '' && hhmmToMinutes(b.timeHHMM) === null) {
      return res.status(400).json({ error: `Backup time "${b.timeHHMM}" isn’t a valid 24-hour time (HH:MM).` });
    }
    next.backup = normalizeBackupConfig(b, existing.backup || {});
  } else if (existing.backup !== undefined) {
    next.backup = existing.backup;
  } else {
    delete next.backup;
  }

  if (next.shareSweep && typeof next.shareSweep === 'object') {
    next.shareSweep = {
      enabled: !!next.shareSweep.enabled,
      intervalSec: Math.max(10, Math.min(3600, parseInt(next.shareSweep.intervalSec, 10) || 60)),
      targets: Array.isArray(next.shareSweep.targets) ? next.shareSweep.targets.filter((t) => typeof t === 'string') : [],
    };
  } else if (existing.shareSweep !== undefined) {
    next.shareSweep = existing.shareSweep;
  } else {
    delete next.shareSweep;
  }

  try {
    await saveConfig(next, clientVersion);
  } catch (e) {
    if (e && e.code === 'CONFIG_STALE') return stale409();
    return res.status(500).json({ error: `Saving the config failed: ${e.message}` });
  }
  // Unassigning a head (or removing its card) makes any solo capture it holds unrestorable —
  // un-solo is only reachable from a panel the head is assigned to. Drop those now rather than
  // leaving them on the volume forever.
  try { await pruneSolo(assignedHeadKeys(next)); } catch (e) { console.warn('[solo] prune failed:', e.message); }
  // Re-apply the sweep scheduler from the just-saved config so a change takes effect now.
  // (The backup scheduler re-reads config every minute, so it needs no explicit reschedule.)
  if (next.shareSweep) { try { await applyShareSweepConfig(); } catch (e) { console.warn('[sharesweep] apply failed:', e.message); } }
  // Tell every connected panel to reload so config changes apply immediately.
  broadcastControl({ type: 'reload' });
  // Separately, tell any other ADMIN page that the config moved. Deliberately NOT the same
  // message as 'reload': the two audiences need opposite things. A panel holds no state and
  // can reload on the spot; an admin page may hold unsaved edits, so it must decide for
  // itself (see the handler in admin-core.js) and must never be reloaded out from under
  // someone. Without this, the other window sits on a stale config until a manual refresh —
  // and its next Save just fails the version check with no idea why. Excludes the window that
  // saved: it already has the new config, and telling it would report its own save as someone
  // else's.
  broadcastControl({ type: 'config-changed', configVersion: next.configVersion }, clientIdOf(req));
  // Hand back the new token so THIS window's next save isn't refused as stale.
  res.json({ ok: true, configVersion: next.configVersion });
});

// --- board probes ----------------------------------------------------------

// Probe a card's board so the admin can label heads while configuring filters.
router.get('/cards/:cardId/heads', requireAdmin, async (req, res) => {
  const config = await loadConfig();
  const card = getCardById(config, req.params.cardId);
  if (!card) return res.status(404).json({ error: 'Unknown card' });
  try {
    const heads = await getHeads(card.ip);
    res.json(heads.map((h) => ({ uuid: h.uuid, name: h.name })));
  } catch (e) { sendErr(res, e); }
});

router.get('/cards/:cardId/snapshots', requireAdmin, async (req, res) => {
  const config = await loadConfig();
  const card = getCardById(config, req.params.cardId);
  if (!card) return res.status(404).json({ error: 'Unknown card' });
  try {
    const info = await getSnapshotInfo(card.ip);
    // Metadata is inline on the list (see normalizeSnapshotEntry) — no per-item fetch needed.
    const metas = (info.snapshots || [])
      .map(normalizeSnapshotEntry)
      .filter((e) => e.uuid && e.deleted !== true) // hide board-deleted (tombstoned) snapshots
      .map((e) => ({ uuid: e.uuid, name: e.name || e.uuid, path: e.path || '' }));
    res.json(metas);
  } catch (e) { sendErr(res, e); }
});

// Reachability probe: try a lightweight GET against a card's board and report the
// raw outcome (status or connection error code). Does not change anything on the board.
router.get('/cards/:cardId/reach', requireAdmin, async (req, res) => {
  const config = await loadConfig();
  const card = getCardById(config, req.params.cardId);
  if (!card) return res.status(404).json({ error: 'Unknown card' });
  if (!card.ip) return res.json({ ok: false, ip: null, error: 'No IP set for this card' });
  const started = Date.now();
  try {
    const self = await getSelf(card.ip);
    res.json({ ok: true, ip: card.ip, durationMs: Date.now() - started,
      product: self?.app?.productName || null, version: self?.app?.productVersion || null });
  } catch (e) {
    res.json({ ok: false, ip: card.ip, durationMs: Date.now() - started,
      error: e.code || e.message, detail: e.detail || null });
  }
});

// Per-card snapshot storage usage. The boards report their own total, so the percentage is
// computed against the board-reported total ONLY when the board actually reports a usable
// total (> 0). If it doesn't, we return the used bytes alone with no percentage and no
// invented denominator, rather than showing a misleading figure.
router.get('/cards/:cardId/storage', requireAdmin, async (req, res) => {
  const config = await loadConfig();
  const card = getCardById(config, req.params.cardId);
  if (!card) return res.status(404).json({ error: 'Unknown card' });
  if (!card.ip) return res.json({ ok: false, error: 'No IP set for this card' });
  try {
    const info = await getSnapshotInfo(card.ip);
    const used = Number(info?.usedStorageBytes);
    const boardTotal = Number(info?.totalStorageBytes);
    const hasUsed = Number.isFinite(used);
    const hasTotal = Number.isFinite(boardTotal) && boardTotal > 0;
    const percent = (hasUsed && hasTotal) ? Math.round((used / boardTotal) * 100) : null;

    // Board activity + sync state from /v1/storage/status. A failed status read is
    // non-fatal — the storage numbers are still useful on their own.
    let activity = null, syncState = null, syncMessage = null;
    try {
      const st = await getStorageStatus(card.ip);
      activity = st.activity; syncState = st.syncState; syncMessage = st.syncMessage;
    } catch { /* status unreachable — report storage only */ }

    res.json({
      ok: true,
      usedBytes: hasUsed ? used : null,
      totalBytes: hasTotal ? boardTotal : null,  // board-reported; null if not reported
      percent,                                     // null when total is unknown
      state: activity,
      syncState,
      syncMessage,
    });
  } catch (e) {
    res.json({ ok: false, error: e.code || e.message, detail: e.detail || null });
  }
});

// Sync diagnostics for one card: the board's own sync config + live status + a flag
// breakdown of its snapshots. This is a read-only investigation aid for sync failures —
// it surfaces the board's own failure message and shows whether flags like readOnly /
// shared correlate with what's failing.
router.get('/cards/:cardId/sync-diagnostics', requireAdmin, async (req, res) => {
  const config = await loadConfig();
  const card = getCardById(config, req.params.cardId);
  if (!card) return res.status(404).json({ error: 'Unknown card' });
  if (!card.ip) return res.json({ ok: false, error: 'No IP set for this card' });
  const out = { ok: true, cardId: card.id, label: card.label || card.id };

  // Board sync config.
  try { out.syncConfig = await getStorageSync(card.ip); }
  catch (e) { out.syncConfig = null; out.syncConfigError = e.code || e.message; }

  // Live activity + sync state/message.
  try {
    const st = await getStorageStatus(card.ip);
    out.activity = st.activity; out.syncState = st.syncState; out.syncMessage = st.syncMessage;
    out.tasks = (st.tasks || []).map((t) => ({ name: t.name, state: t.state, message: t.message }));
  } catch (e) { out.statusError = e.code || e.message; }

  // Snapshot flag breakdown — counts + a sample of any readOnly / unshared / deleted entries,
  // since those are the flags most likely to block a sync.
  try {
    const info = await getSnapshotInfo(card.ip);
    const entries = (info.snapshots || []).map(normalizeSnapshotEntry).filter((e) => e.uuid);
    const readOnly = entries.filter((e) => e.readOnly);
    const unshared = entries.filter((e) => e.shared !== true && !e.deleted);
    const deleted = entries.filter((e) => e.deleted);
    out.snapshotFlags = {
      total: entries.length,
      shared: entries.filter((e) => e.shared === true).length,
      unshared: unshared.length,
      readOnly: readOnly.length,
      deleted: deleted.length,
      usedBytes: Number(info?.usedStorageBytes) || null,
      totalBytes: Number(info?.totalStorageBytes) || null,
      // Small samples so you can spot the offenders without dumping everything.
      readOnlySample: readOnly.slice(0, 10).map((e) => e.name || e.uuid),
      unsharedSample: unshared.slice(0, 10).map((e) => e.name || e.uuid),
    };
  } catch (e) { out.snapshotError = e.code || e.message; }

  res.json(out);
});

// Manually trigger the board's native sync, then read status so the result is visible.
router.post('/cards/:cardId/sync-trigger', requireAdmin, async (req, res) => {
  const config = await loadConfig();
  const card = getCardById(config, req.params.cardId);
  if (!card) return res.status(404).json({ error: 'Unknown card' });
  if (!card.ip) return res.json({ ok: false, error: 'No IP set for this card' });
  try {
    await triggerStorageSync(card.ip);
    // Give the board a moment, then report status.
    await new Promise((r) => setTimeout(r, 1500));
    const st = await getStorageStatus(card.ip);
    res.json({ ok: true, activity: st.activity, syncState: st.syncState, syncMessage: st.syncMessage });
  } catch (e) {
    res.json({ ok: false, error: e.code || e.message, detail: e.detail || null });
  }
});

// --- API activity log ------------------------------------------------------

router.get('/log', requireAdmin, (req, res) => {
  const since = parseInt(req.query.since, 10) || 0;
  res.json({ entries: getEntries(since) });
});

router.delete('/log', requireAdmin, (_req, res) => {
  clearLog();
  res.json({ ok: true });
});

// --- Share sweep (auto-share unshared snapshots) ---------------------------
// The sweep's settings are edited inline on the Backups tab and saved with the main config
// PUT above; only live status and a manual run are served here.

router.get('/sharesweep', requireAdmin, (_req, res) => {
  res.json(shareSweepStatus());
});
router.post('/sharesweep/run', requireAdmin, async (_req, res) => {
  res.json(await runShareSweepNow());
});

// --- Scheduled backups -----------------------------------------------------

router.get('/backup', requireAdmin, async (_req, res) => {
  const config = await loadConfig();
  res.json({ config: config.backup || {}, status: backupStatus(), files: await listBackups() });
});

router.put('/backup', requireAdmin, async (req, res) => {
  const body = req.body || {};
  // Validate against the same rule the scheduler fires on, so a time that stores can always run.
  if (body.timeHHMM && hhmmToMinutes(body.timeHHMM) === null) {
    return res.status(400).json({ error: `Backup time "${body.timeHHMM}" isn’t a valid 24-hour time (HH:MM).` });
  }
  // Patch ONLY the backup block, inside the config write lock. A read-modify-write in the
  // handler (loadConfig → mutate → saveConfig) would race a concurrent full-config PUT: if that
  // PUT's write landed first, this save — built from the pre-PUT snapshot — would silently
  // revert it. updateConfig re-reads the freshest config inside the lock.
  const saved = await updateConfig((cfg) => {
    cfg.backup = normalizeBackupConfig(body, cfg.backup || {});
  });
  // Other admin pages need to know the token moved. Note: 'config-changed' ONLY — no 'reload'.
  // This endpoint exists precisely so "Back up now" doesn't bounce every operator panel
  // mid-show; broadcasting a reload here would reintroduce exactly that on-air side effect.
  // Excludes the caller: "Back up now" writes through here, so without it the very window that
  // pressed the button reported its own write as another session's change, every single time.
  broadcastControl({ type: 'config-changed', configVersion: saved.configVersion }, clientIdOf(req));
  // configVersion: "Back up now" saves through here, and every save bumps the token — so
  // return it, or that button would leave the page unable to save anything else.
  res.json({ ok: true, config: saved.backup, configVersion: saved.configVersion });
});

router.post('/backup/run', requireAdmin, async (_req, res) => {
  res.json(await runBackupNow());
});

router.get('/backup/files', requireAdmin, async (_req, res) => {
  // running/runKey ride along so the page can poll this one endpoint while a backup is in
  // progress: it marks that run's not-yet-written files as in-flight instead of showing the
  // half-finished run as if it were a complete one.
  const st = backupStatus();
  res.json({ files: await listBackups(), running: st.running, runKey: st.runKey });
});

// Download a backup file. Filename validated in backupFilePath to prevent traversal.
router.get('/backup/download/:file', requireAdmin, async (req, res) => {
  const path = backupFilePath(req.params.file);
  if (!path || !existsSync(path)) return res.status(404).json({ error: 'Not found' });
  res.download(path, req.params.file);
});

// Delete a single backup file.
router.delete('/backup/files/:file', requireAdmin, async (req, res) => {
  const path = backupFilePath(req.params.file);
  if (!path || !existsSync(path)) return res.status(404).json({ error: 'Not found' });
  try { await unlink(path); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

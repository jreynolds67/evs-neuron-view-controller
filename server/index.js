// server/index.js
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';

import {
  loadConfig, saveConfig, getCardById, getPanelByIp,
  getPanelHead, resolveAllowedSnapshots, isConfigAuthoritative,
} from './config.js';
import {
  getSelf, getSnapshotInfo, getSnapshotMeta, getStorageStatus,
  getStorageSync, triggerStorageSync, getHeads,
  extractSnapshotHeads, restorePartial,
  normalizeSnapshotEntry, getHeadWidgets, normalizeWidgetForPreview,
  getSnapshotModelCached, buildSnapshotWidgetIndex,
  getInputGroups, setWidgetGroup,
  deleteHeadWidget, createHeadWidget, setWidgetFull, setWidgetFullscreenVideoOnly,
} from './board.js';
import { loadSoloStore, isSoloed, getSolo, setSolo, clearSolo, pruneSolo } from './solostore.js';
import { getEntries, clear as clearLog, log } from './logger.js';
import { startShareSweep, shareSweepStatus, runShareSweepNow, applyShareSweepConfig } from './sharesweep.js';
import {
  startBackupScheduler, runBackupNow, backupStatus, listBackups, backupFilePath, hhmmToMinutes,
} from './backup.js';
import {
  verifyPassword, createSession, touchSession, destroySession,
  sessionIdFromReq, setSessionCookie, clearSessionCookie,
} from './auth.js';
import { createTtlCache } from './cache.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const PRIVATE_DIR = join(__dirname, '..', 'private');
const PORT = process.env.PORT || 8080;

const app = express();
// 5 MB: headFilters can grow large (per-head lists of 36-char UUIDs across 12 cards ×
// ~20 heads × many allowed snapshots). The old 256 KB limit could reject a legitimate
// config save with an opaque 413. Payloads are still small relative to this ceiling.
app.use(express.json({ limit: '5mb' }));

// Serve the admin HTML shell ONLY through this authenticated route. admin.html lives in
// PRIVATE_DIR, outside the static root, so there is no static path for express.static to
// resolve — closing off URL-normalization bypasses (/%61dmin.html, /./admin.html, etc.).
// A valid session serves the file; otherwise redirect to login. (admin.js and the rest
// stay static; every admin API is separately session-gated by requireAdmin.)
app.get(['/admin', '/admin.html'], (req, res) => {
  if (!touchSession(sessionIdFromReq(req))) return res.redirect(302, '/login.html');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(join(PRIVATE_DIR, 'admin.html'));
});

// No-cache on static assets: these are operator panels that must pick up a redeploy on
// their next load without any manual cache-clearing. The payloads are tiny, so skipping
// caching costs nothing meaningful and guarantees fresh code (e.g. the control-reload WS).
app.use(express.static(PUBLIC_DIR, {
  etag: false,
  lastModified: false,
  cacheControl: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  },
}));

// --- helpers ---------------------------------------------------------------

// Whether to trust the X-Forwarded-For header for the client IP. OFF by default: on a flat
// macvlan with no reverse proxy, XFF is attacker-controlled — anything on the network could
// forge it to impersonate a registered panel. Only enable when a trusted proxy actually
// sits in front and sets it, via TRUST_PROXY=1.
const TRUST_PROXY = String(process.env.TRUST_PROXY || '') === '1';

// Normalise the requesting panel's IP (strip IPv6-mapped prefix). Uses the real TCP socket
// address unless a trusted proxy is configured (then honour X-Forwarded-For's first hop).
function clientIp(req) {
  let ip = '';
  if (TRUST_PROXY && req.headers['x-forwarded-for']) {
    ip = req.headers['x-forwarded-for'].split(',')[0].trim();
  } else {
    ip = (req.socket.remoteAddress || '').trim();
  }
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

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

// Panel-facing error sender. Board errors carry the board IP and path in their message
// ("Board 10.x.x.x /heads/... -> 500") and the raw board response in `detail` — the documented
// design is that board IPs stay hidden from panels, so strip both here. Errors we generate
// ourselves (with an explicit `code`) are already operator-safe and pass through, since they
// are the clear messages the UI is built around (HEAD_STALE, BOARD_BUSY, RECALLED, ...).
// The full error is still logged server-side and shown on the admin activity log.
function sendPanelErr(res, e) {
  const status = e.status || 502;
  const safeCodes = new Set(['HEAD_STALE', 'BOARD_BUSY', 'RECALLED', 'META_INCOMPLETE']);
  if (e.code && safeCodes.has(e.code)) {
    return res.status(status).json({ error: e.message, code: e.code });
  }
  // Generic, non-leaking message for anything board-originated.
  const generic = status >= 500 || !e.status
    ? 'The card didn’t respond as expected. Please try again — if it keeps happening, tell an engineer.'
    : 'The card couldn’t complete that request. Please try again — if it keeps happening, tell an engineer.';
  res.status(status).json({ error: generic, code: e.code || null });
}

// Path parameters that get spliced into a BOARD API url must be real UUIDs before they go
// anywhere near boardFetch. Express decodes %2F, so an unvalidated one can smuggle extra path
// segments ("x%2F..%2Fheads") and steer a board GET/POST to an arbitrary endpoint — routing
// around the choke point this server exists to be. It needs a registered panel IP first, so
// this isn't a hole an outsider can reach, but the choke point should hold regardless.
//
// Scoped deliberately to the two params that actually reach a board url:
//   snapUuid   -> /snapshots/{snapUuid}/...      (heads, previews, restore)
//   widgetUuid -> /heads/{h}/widgets/{widgetUuid} (group repoint)
// NOT headUuid: it's already constrained by having to string-match a stored assignment, and on
// the snapshot-scoped preview route it's only ever used as a Map key. The API spec never
// declares `format: uuid` on anything, so the strict shape is an observation about this
// firmware, not a contract — and it's one the app already depends on (normalizeSnapshotEntry
// and extractSnapshotHeads both drop non-UUID ids outright, so snapshots simply would not work
// if it were false). Widening this to live head ids would add risk without adding cover.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
for (const name of ['snapUuid', 'widgetUuid']) {
  app.param(name, (req, res, next, value) => {
    if (!UUID_RE.test(value)) {
      return res.status(400).json({ error: 'That item is no longer valid — go back and try again.' });
    }
    return next();
  });
}

// --- panel-facing API ------------------------------------------------------

// Authorization helper: does this panel have this exact card+head assigned?
function panelAuthorizesHead(panel, cardId, headUuid) {
  return !!getPanelHead(panel, cardId, headUuid);
}

// Every "<cardId>::<headUuid>" still reachable from some panel — i.e. assigned to a panel AND
// on a card that still exists. This is exactly the set of heads a solo capture can still be
// restored from, so it's what prunes the solo store (see pruneSolo).
function assignedHeadKeys(config) {
  const keys = new Set();
  for (const p of config.panels || []) {
    for (const h of p.heads || []) {
      if (h && h.cardId && h.headUuid && getCardById(config, h.cardId)) {
        keys.add(`${h.cardId}::${h.headUuid}`);
      }
    }
  }
  return keys;
}

// Resolve panel + card + assigned head for a panel-facing request, or send an error and
// return null. Every operator endpoint is scoped to a specific assigned head now.
async function resolveHeadRequest(req, res) {
  const config = await loadConfig();
  const panel = getPanelByIp(config, clientIp(req));
  const { cardId, headUuid } = req.params;
  if (!panel || !panelAuthorizesHead(panel, cardId, headUuid)) {
    res.status(403).json({ error: 'This head is no longer assigned to this panel — go back and pick another, or ask an engineer.' });
    return null;
  }
  const card = getCardById(config, cardId);
  if (!card) { res.status(404).json({ error: 'That card is no longer available — go back and try again, or ask an engineer.' }); return null; }
  return { config, panel, card, panelHead: getPanelHead(panel, cardId, headUuid) };
}

// For snapshot-scoped endpoints (no target head in the path): authorize if the panel has
// ANY assigned head on this card, since the operator reached the snapshot through one.
async function resolveCardRequest(req, res) {
  const config = await loadConfig();
  const panel = getPanelByIp(config, clientIp(req));
  const { cardId } = req.params;
  const hasHeadOnCard = panel && (panel.heads || []).some((h) => h.cardId === cardId);
  if (!hasHeadOnCard) {
    res.status(403).json({ error: 'This card is no longer available to this panel — go back and try again, or ask an engineer.' });
    return null;
  }
  const card = getCardById(config, cardId);
  if (!card) { res.status(404).json({ error: 'That card is no longer available — go back and try again, or ask an engineer.' }); return null; }
  return { config, panel, card };
}

// Container's local time — lets the admin confirm the container's timezone. Returns the
// epoch plus the container's IANA timezone so the client renders the wall clock the
// container actually runs on (not the browser's local time).
app.get('/api/time', (_req, res) => {
  const now = new Date();
  const tz = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  res.json({
    epochMs: now.getTime(),
    iso: now.toISOString(),
    tz,
  });
});

// Who am I? Resolve the calling panel by its source IP and return its assigned heads.
// Cards are no longer exposed to the operator — the panel presents a flat, curated head
// list. Each head carries its source card+uuid (needed for downstream calls), a display
// label (admin override or board name), and its order.
app.get('/api/panel/me', async (req, res) => {
  const config = await loadConfig();
  const ip = clientIp(req);
  const panel = getPanelByIp(config, ip);
  if (!panel) {
    return res.status(404).json({ error: 'Panel not registered', ip });
  }
  const cols = (panel.layout === 'strip') ? 8 : 7;

  // The operator view is driven ENTIRELY by the layout grid (row-major slots). Each slot
  // is either a head (resolved to the data the client needs) or a blank spacer. Heads
  // whose card was removed, or that don't resolve, become blanks so the grid keeps shape.
  const grid = (panel.layoutGrid || []).map((slot) => {
    if (!slot || slot.type !== 'head') return { type: 'blank' };
    if (!getCardById(config, slot.cardId)) return { type: 'blank' };
    // Resolve against the panel's head assignments. A grid reference with no matching
    // assignment (head was unassigned) becomes a blank so the grid keeps its shape.
    const h = (panel.heads || []).find(
      (x) => x.cardId === slot.cardId && x.headUuid === slot.headUuid);
    if (!h) return { type: 'blank' };
    return {
      type: 'head',
      cardId: slot.cardId,
      headUuid: slot.headUuid,
      label: h.label || h.boardName || 'Head',
    };
  });

  res.json({
    ip, label: panel.label, layout: panel.layout || '1080', cols,
    grid,
    showUuids: config.settings?.showUuids !== false,
    allowShowAll: panel.allowShowAll === true,
  });
});

// Scheduled-backup health for the operator banner. Returns the scheduled failure (or null)
// ONLY for 1080-layout panels — strip/CTP panels never see the banner. Kept tiny so panels
// can poll it cheaply alongside their preview polling.
app.get('/api/panel/backup-status', async (req, res) => {
  const config = await loadConfig();
  const panel = getPanelByIp(config, clientIp(req));
  if (!panel) return res.status(404).json({ error: 'Panel not registered' });
  if ((panel.layout || '1080') !== '1080') return res.json({ failure: null });
  const st = backupStatus();
  const f = st.scheduledFailure;
  if (!f) return res.json({ failure: null });
  // Rebuild the failure with ONLY panel-safe fields. `message` is raw board-layer error text
  // and stays admin-only: board IPs are deliberately never shown to panels (same rule as
  // sendPanelErr), and it can echo arbitrary board response bodies. The card is named by its
  // label instead — unless the backup target was configured as a raw IP, in which case the
  // label IS that IP and is withheld for the same reason.
  const cardLabel = (f.cardLabel && !/^\d+\.\d+\.\d+\.\d+$/.test(f.cardLabel)) ? f.cardLabel : null;
  res.json({ failure: { at: f.at, reason: f.reason, cardLabel } });
});

// Snapshots offered for a given card+head, honouring the admin filter.
app.get('/api/panel/cards/:cardId/heads/:headUuid/snapshots', async (req, res) => {
  const r = await resolveHeadRequest(req, res);
  if (!r) return;
  const { config, panel, card, panelHead } = r;

  try {
    const info = await getSnapshotInfo(card.ip);
    // "Show all" is honoured only when the panel is configured to allow it. When active,
    // the per-head filter is bypassed so every snapshot for this head is offered.
    const showAll = req.query.showAll === '1' && panel.allowShowAll === true;
    const allow = showAll
      ? null
      : resolveAllowedSnapshots(config, panelHead, req.params.cardId, req.params.headUuid);
    const includeDeleted = req.query.includeDeleted === '1';

    // Normalise entries (string UUIDs or richer objects) to a consistent shape.
    let entries = (info.snapshots || [])
      .map(normalizeSnapshotEntry)
      .filter((e) => e.uuid); // drop anything we couldn't resolve a UUID for

    // Hide board-side deleted (tombstoned) snapshots unless explicitly requested.
    if (!includeDeleted) entries = entries.filter((e) => e.deleted !== true);

    if (allow) entries = entries.filter((e) => allow.includes(e.uuid));

    // Enrich with metadata. If the list entry already carried it, use that and skip
    // the per-item fetch (which is what was 404ing when the UUID was an [object Object]).
    // Bounded via runPool: on 1.10 firmware the list is bare UUIDs, so every entry needs its
    // own board fetch — unbounded, a large snapshot library meant hundreds of simultaneous
    // requests to a storage layer the rest of this codebase deliberately paces.
    const metas = new Array(entries.length);
    await runPool(entries, async (e, idx) => {
      if (e.inlineMeta) {
        metas[idx] = {
          uuid: e.uuid,
          name: e.name || e.uuid,
          description: e.description || '',
          timestamp: e.timestamp || 0,
          path: e.path || '',
        };
        return;
      }
      try {
        const m = await getSnapshotMeta(card.ip, e.uuid);
        metas[idx] = { uuid: e.uuid, name: m.name || e.uuid, description: m.description || '', timestamp: m.timestamp || 0, path: m.path || '' };
      } catch {
        metas[idx] = { uuid: e.uuid, name: e.uuid, description: '', timestamp: 0, path: '' };
      }
    });
    // Sort by folder, then name, for a predictable grouped list.
    metas.sort((a, b) =>
      (a.path || '').localeCompare(b.path || '') || (a.name || '').localeCompare(b.name || ''));
    // Board activity for the panel's "board busy" hint. On 1.13 info.state no longer exists
    // (it moved to /storage/status), so read it via the compat helper rather than passing
    // through a field that is always undefined on current firmware.
    // Reuse the `info` fetched at the top of this handler: on 1.10 the busy state lives on that
    // very response, so re-fetching it here made every snapshot listing pull the whole snapshot
    // list from the board twice.
    let boardState = null;
    try { boardState = await readBoardBusyState(card.ip, info); } catch { /* non-fatal */ }
    res.json({ state: boardState, snapshots: metas });
  } catch (e) { sendPanelErr(res, e); }
});

// The heads stored inside a snapshot (candidates for the partial mapping source).
app.get('/api/panel/cards/:cardId/snapshots/:snapUuid/heads', async (req, res) => {
  const r = await resolveCardRequest(req, res);
  if (!r) return;
  const { card } = r;
  try {
    const modelEntry = await getSnapshotModelCached(card.ip, req.params.snapUuid);
    // Extractor already returns only named heads (unnamed entries aren't selectable).
    let heads = extractSnapshotHeads(modelEntry.model);

    // Diagnostic: when extraction yields nothing, record whether the model blob parsed at
    // all, so a failure can be told apart from "parsed fine but no named heads." This is
    // what distinguishes a board that returned a malformed blob (e.g. a snapshot name with
    // unescaped characters) from a genuinely head-less snapshot.
    if (heads.length === 0) {
      const root = modelEntry.root;
      let shape = typeof root;
      try {
        if (root && typeof root === 'object') {
          // Top-level keys, and for each key a hint of what's under it, so we can see where
          // heads actually live in this board's model structure.
          shape = Object.entries(root).map(([k, v]) => {
            if (Array.isArray(v)) return `${k}[${v.length}]`;
            if (v && typeof v === 'object') return `${k}{${Object.keys(v).slice(0, 6).join(',')}}`;
            return `${k}=${String(v).slice(0, 20)}`;
          }).join(' ');
        }
      } catch { shape = 'introspection-failed'; }
      log({
        ip: card.ip, method: 'PARSE', path: `/snapshots/${req.params.snapUuid}/model`,
        status: null, ok: false,
        detail: `no heads extracted; rootType=${typeof root}; keys: ${String(shape).slice(0, 400)}`,
      });
    }

    // Source heads come straight from the snapshot's own model — a partial restore reads the
    // source layout FROM THE SNAPSHOT, never from the live board, so the live heads are
    // irrelevant to what's recallable. (An earlier "intersect with live heads" backstop hid
    // valid source heads whenever a snapshot was recalled on the same card after a head was
    // rebuilt — the strict name/shape check in extractSnapshotHeads is the real guard against
    // junk, so no live-board filter is needed.)
    res.json({ heads, parsed: heads.length > 0 });
  } catch (e) { sendPanelErr(res, e); }
});

// Preview: widget layout currently on a LIVE head.
// Short-lived caches for the two endpoints panels poll continuously (every ~5s). With many
// panels watching the same head, coalescing collapses N simultaneous polls into ONE board
// fetch, so board load tracks the number of distinct heads/cards viewed rather than panel
// count. TTL is under the poll interval so a manual navigation still gets near-fresh data.
const PREVIEW_TTL_MS = 3500;
const GROUPS_TTL_MS = 3500;
const NEG_TTL_MS = 5000; // brief failure caching so a down board isn't re-hit every poll
// The live head roster of a card, cached for the HEAD_STALE probe below. It changes rarely
// (only when heads are reconfigured on the board), so a longer TTL is fine and further cuts
// board load. The negative window is the important part: it stops a card that's answering
// with HTTP errors from getting an uncached, full-timeout getHeads on EVERY poll/attempt.
const HEADS_TTL_MS = 10000;
const previewCache = createTtlCache(PREVIEW_TTL_MS, { negativeTtlMs: NEG_TTL_MS });
const groupsCache = createTtlCache(GROUPS_TTL_MS, { negativeTtlMs: NEG_TTL_MS });
const headsCache = createTtlCache(HEADS_TTL_MS, { negativeTtlMs: NEG_TTL_MS });
setInterval(() => { previewCache.prune(30000); groupsCache.prune(30000); headsCache.prune(30000); }, 30000).unref?.();

// A board software update regenerates head UUIDs while keeping names, which orphans a panel's
// stored binding — the board then errors (often a 500) on the dead UUID. After such a failure,
// this decides whether the head is genuinely GONE (=> surface HEAD_STALE and tell the admin to
// re-link) versus a transient/transport problem we shouldn't mislabel.
//
// Only probe when the board actually ANSWERED with an HTTP error (err.status set, err.code
// absent). A transport failure sets err.code (ECONNREFUSED/ETIMEDOUT/…) and means the board is
// unreachable — the head might be perfectly valid, so we must NOT claim it's stale. The probe
// goes through headsCache so N panels polling a faulting card collapse into one getHeads per
// TTL (and one per negative window while it keeps failing) instead of one per request.
const HEAD_STALE_MESSAGE =
  'Head UUID changed — use the “Re-link heads by name” function in the admin page to correct it.';
async function headIsStale(cardIp, headUuid, err) {
  if (err && err.code) return false; // transport failure — can't tell; don't claim stale
  try {
    const live = await headsCache.get(cardIp, () => getHeads(cardIp));
    return !(live || []).some((h) => h.uuid === headUuid);
  } catch {
    return false; // couldn't reach the board to check — let the original error surface
  }
}
function sendHeadStale(res) {
  return res.status(409).json({ error: HEAD_STALE_MESSAGE, code: 'HEAD_STALE' });
}

app.get('/api/panel/cards/:cardId/heads/:headUuid/preview', async (req, res) => {
  const r = await resolveHeadRequest(req, res);
  if (!r) return;
  const { card } = r;
  try {
    const key = `${card.ip}::${req.params.headUuid}`;
    const widgets = await previewCache.get(key, () => getHeadWidgets(card.ip, req.params.headUuid));
    // `soloed` (sync Map lookup, no board call) tells the enlarged editor a window here is blown
    // up to fullscreen, so it offers "hold to restore" instead of treating it as a normal head.
    res.json({ widgets: (widgets || []).map(normalizeWidgetForPreview), soloed: isSoloed(req.params.cardId, req.params.headUuid) });
  } catch (e) {
    // If the head's board UUID drifted (typically a board software update), return a clear,
    // actionable message instead of leaking a raw "IP/UUID -> 500". headIsStale() only probes
    // on a real HTTP error and caches the getHeads result, so a faulting board isn't hammered
    // with an uncached probe on every poll. Any other failure passes through unchanged.
    if (await headIsStale(card.ip, req.params.headUuid, e)) return sendHeadStale(res);
    sendPanelErr(res, e);
  }
});

// Board activity states that genuinely CONFLICT with a restore: writes to the storage layer
// and sync. Deliberately an explicit set, not a regex, for two reasons:
//
//  1. 1.13's activity enum also contains TERMINAL failure states (sync-failed, import-failed,
//     load-failed, …) which are not "busy" — a substring match on "sync"/"import" would block
//     restores indefinitely after any failure until the board cleared it.
//  2. READ activities (loading-files, getting-file-preview) are deliberately EXCLUDED. They
//     don't conflict with a restore, and this app causes them itself: GET /snapshots/{uuid}/model
//     IS the get-file-preview operation, and panels fetch it while browsing source heads. If a
//     read state counted as busy, one operator browsing a snapshot on a card could 409 another
//     operator's Load on that same card — a spurious failure for a non-conflicting operation.
const BUSY_ACTIVITIES = new Set([
  'creating-file', 'updating-file', 'deleting-file',
  'exporting-files', 'importing-file', 'syncing',
]);
// Legacy (API 1.10) info.state strings that mean busy. Same principle: match conflict states
// only. 'not enough storage space' is a hard blocker rather than transient, but firing a
// restore into it fails anyway, so surfacing it as "busy" is the clearer operator message.
const BUSY_LEGACY_RE = /import|export|sync|creating|updating|deleting|not enough/i;

// Return a human-readable busy state for a board, or null if idle/unknown.
// API 1.13: activity lives on GET /storage/status. API 1.10: state lives on GET /snapshots.
//
// `info` is an optional, already-fetched GET /snapshots response. Only the 1.10 fallback path
// uses it: without it, a caller that had just fetched /snapshots made this fetch the very same
// (potentially large — it carries every snapshot) response a second time on legacy firmware.
// Pass it whenever you have a fresh one; omit it when the state must be read fresh (the restore
// pre-check), where a stale read is the whole thing being guarded against.
async function readBoardBusyState(ip, info = null) {
  try {
    const st = await getStorageStatus(ip);
    if (st && typeof st.activity === 'string') {
      return BUSY_ACTIVITIES.has(st.activity) ? st.activity : null;
    }
  } catch { /* endpoint absent (older firmware) or unreachable — fall back below */ }
  const legacy = info || await getSnapshotInfo(ip);
  const state = legacy && typeof legacy.state === 'string' && legacy.state !== 'idle' ? legacy.state : null;
  return state && BUSY_LEGACY_RE.test(state) ? state : null;
}


// Extract an operator-facing input NUMBER from a group. Names typically embed a number
// ("IN 12", "Input 12", "12"); we grab the first integer we find. Falls back to null.
function groupNumber(g) {
  const m = (g && typeof g.name === 'string') ? g.name.match(/\d+/) : null;
  return m ? parseInt(m[0], 10) : null;
}

// Input groups available on a head's card, with a parsed number and the stream UUIDs.
app.get('/api/panel/cards/:cardId/heads/:headUuid/groups', async (req, res) => {
  const r = await resolveHeadRequest(req, res);
  if (!r) return;
  const { card } = r;
  try {
    // Groups are per-card (not per-head), so key by IP — every head on a card shares one
    // cached result, further cutting board fetches.
    const groups = await groupsCache.get(card.ip, () => getInputGroups(card.ip));
    // API 1.13 renamed the group stream references from singular (videoUuid) to plural arrays
    // (videoUuids) and added audioChannelMapping. Read either shape so we work on both
    // firmwares. These are pass-through metadata; group selection uses uuid/name/number.
    const first = (arr) => (Array.isArray(arr) && arr.length ? arr[0] : '');
    const out = (groups || []).map((g) => ({
      uuid: g.uuid,
      name: g.name || '',
      number: groupNumber(g),
      videoUuid: g.videoUuid || first(g.videoUuids),
      audioUuid: g.audioUuid || first(g.audioUuids),
      dataUuid: g.dataUuid || first(g.dataUuids),
    }));
    res.json({ groups: out });
  } catch (e) { sendPanelErr(res, e); }
});

// Repoint a window (widget) to a different input group. LIVE EDIT to the on-air board.
// Body: { groupUuid }. Authorized to the specific assigned head.
app.post('/api/panel/cards/:cardId/heads/:headUuid/widgets/:widgetUuid/group', async (req, res) => {
  const r = await resolveHeadRequest(req, res);
  if (!r) return;
  const { card } = r;
  const { groupUuid } = req.body || {};
  if (!groupUuid) return res.status(400).json({ error: 'groupUuid is required' });
  try {
    const result = await setWidgetGroup(card.ip, req.params.headUuid, req.params.widgetUuid, groupUuid);
    // The write changed this head's layout — drop its cached preview so the next poll (and
    // the editor's own refresh) reflects it immediately rather than serving a stale ~3.5s copy.
    previewCache.invalidate(`${card.ip}::${req.params.headUuid}`);
    res.json({ ok: true, result });
  } catch (e) { sendPanelErr(res, e); }
});

// Preview: widget layout stored for a head INSIDE a snapshot.
app.get('/api/panel/cards/:cardId/snapshots/:snapUuid/heads/:headUuid/preview', async (req, res) => {
  const r = await resolveCardRequest(req, res);
  if (!r) return;
  const { card } = r;
  try {
    const { root } = await getSnapshotModelCached(card.ip, req.params.snapUuid);
    const { headWidgets } = buildSnapshotWidgetIndex(root);
    const widgets = headWidgets.get(req.params.headUuid) || [];
    res.json({ widgets, resolved: widgets.length > 0 });
  } catch (e) { sendPanelErr(res, e); }
});

// Preview (batched): widget layouts for ALL heads in a snapshot, in one call. The Source
// step uses this so a single model fetch+parse serves every source-head preview at once.
app.get('/api/panel/cards/:cardId/snapshots/:snapUuid/previews', async (req, res) => {
  const r = await resolveCardRequest(req, res);
  if (!r) return;
  const { card } = r;
  try {
    const { root } = await getSnapshotModelCached(card.ip, req.params.snapUuid);
    const { headWidgets } = buildSnapshotWidgetIndex(root);
    const byHead = {};
    for (const [uuid, widgets] of headWidgets) byHead[uuid] = widgets;
    res.json({ heads: byHead });
  } catch (e) { sendPanelErr(res, e); }
});

// Fire the partial restore. Body: { snapshotHeadUuid, targetHeadUuid }.
// This is the ONLY restore entrypoint and it is structurally partial-only.
app.post('/api/panel/cards/:cardId/snapshots/:snapUuid/restore', async (req, res) => {
  const config = await loadConfig();
  const panel = getPanelByIp(config, clientIp(req));
  const { snapshotHeadUuid, targetHeadUuid, showAll } = req.body || {};
  if (!snapshotHeadUuid || !targetHeadUuid) {
    return res.status(400).json({ error: 'snapshotHeadUuid and targetHeadUuid are required' });
  }
  // Authorize against the exact assigned head being restored onto.
  const panelHead = panel ? getPanelHead(panel, req.params.cardId, targetHeadUuid) : null;
  if (!panelHead) {
    return res.status(403).json({ error: 'This head is no longer assigned to this panel — go back and pick another, or ask an engineer.' });
  }
  const card = getCardById(config, req.params.cardId);
  if (!card) return res.status(404).json({ error: 'That card is no longer available — go back and try again, or ask an engineer.' });

  // Re-check the snapshot is actually permitted for this head before firing.
  // "Show all" bypasses the per-head filter here exactly as it does on the snapshot LIST, and
  // under the same rule: the client must ask for it AND the panel must be configured to allow
  // it (allowShowAll is admin-granted per panel). The two must agree — when only the list
  // honoured the override, an operator could browse to a filtered-out snapshot under "Show all"
  // and then be refused at Load with a bare 403, a dead end with no way forward.
  const showAllOk = showAll === true && panel.allowShowAll === true;
  const allow = showAllOk
    ? null
    : resolveAllowedSnapshots(config, panelHead, req.params.cardId, targetHeadUuid);
  if (allow && !allow.includes(req.params.snapUuid)) {
    return res.status(403).json({ error: 'This snapshot isn’t allowed for this head — go back and pick another, or ask an engineer to allow it.' });
  }

  try {
    // Board-busy pre-check: if the board is mid-import/sync/export, firing into it tends to
    // return a raw 400. A cheap state read lets us reject with a clear, actionable message
    // instead. Tolerate a read failure here (don't let the pre-check itself prevent a
    // legitimate restore).
    //
    // API 1.13 moved board activity OUT of GET /snapshots (info.state) into
    // GET /storage/status (activity). Read the new endpoint first and fall back to the legacy
    // field, so this works on both firmwares.
    try {
      const busy = await readBoardBusyState(card.ip);
      if (busy) {
        return res.status(409).json({ error: `The card is busy (${busy}) — please wait a moment and try again.`, code: 'BOARD_BUSY' });
      }
    } catch { /* state read failed — proceed; the restore itself will surface any real error */ }

    const result = await restorePartial(card.ip, req.params.snapUuid, [
      { snapshotHeadUuid, targetHeadUuid },
    ]);
    // The restore changed the target head — drop its cached preview so panels see the new
    // content on their next poll instead of a stale copy.
    previewCache.invalidate(`${card.ip}::${targetHeadUuid}`);
    // A recall replaces this head's widgets, so any solo capture for it is now stale — the recall
    // wins. Discard it so a later un-solo can't dump the old (captured) windows onto the new layout.
    try { await clearSolo(req.params.cardId, targetHeadUuid); } catch { /* non-fatal */ }
    res.json({ ok: true, result });
  } catch (e) {
    // Same UUID-drift case the preview endpoint handles: if the target head's ID changed on the
    // board, the restore fails on the dead UUID. Surface the clear "re-link heads" message
    // rather than the generic board error — and nothing was applied (the board rejected an
    // unknown head), so this is a clean failure the operator can act on directly.
    if (await headIsStale(card.ip, targetHeadUuid, e)) return sendHeadStale(res);
    sendPanelErr(res, e);
  }
});

// --- Fullscreen ("solo") one window on a head ------------------------------
// Blow up one window to fullscreen, video-only. You cannot HIDE a widget on this firmware (see
// the widget-geometry memory), so we CAPTURE the head's full widget layout, DELETE every other
// widget, and turn the survivor into a full-canvas video-only window. The capture is persisted
// (solostore) so any panel can restore it and a redeploy can't strand an on-air head. The client
// disables source-repointing while soloed, so nothing else changes the survivor meanwhile.

// Run async tasks over `items` with bounded concurrency. Shared by the solo/unsolo widget
// operations AND the snapshot-metadata listings (which pre-declare a results array and have the
// worker fill `results[idx]`, since only the failure COUNT is returned here). An individual
// failure does NOT abort the run — a solo/unsolo shouldn't stop dead because one widget hiccuped
// — but failures ARE counted and returned, so the caller can tell the operator rather than
// report success over a head that is visibly wrong. Far faster than sequential awaits, and
// bounded so a big item list can't stampede a board's fragile storage layer all at once.
// Returns the number of items whose worker threw.
async function runPool(items, worker, concurrency = 16) {
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

app.post('/api/panel/cards/:cardId/heads/:headUuid/solo', async (req, res) => {
  const r = await resolveHeadRequest(req, res);
  if (!r) return;
  const { card } = r;
  const { cardId, headUuid } = req.params;
  const { targetWidgetUuid } = req.body || {};
  if (!targetWidgetUuid) return res.status(400).json({ error: 'targetWidgetUuid is required' });
  try {
    const widgets = await getHeadWidgets(card.ip, headUuid);
    if (!widgets.some((w) => w.uuid === targetWidgetUuid)) {
      return res.status(404).json({ error: 'That window is no longer on this head — please try again.' });
    }
    // A head holds exactly ONE capture, and a new solo replaces it — but only when the old one
    // is dead. Staleness test is the same one un-solo uses: if the captured survivor is gone,
    // the head was rebuilt externally (native GUI, or a recall this app never saw), so the
    // capture can no longer restore anything and the fresh one takes its place.
    //
    // If the survivor IS still there the head really is soloed, and overwriting would capture
    // the single fullscreen window AS the "original" — destroying the real mosaic permanently,
    // since un-solo would then only ever restore the fullscreen. Refuse instead; the client
    // offers restore (not solo) on a soloed head anyway, so this is the backstop for a race.
    const existing = getSolo(cardId, headUuid);
    if (existing && widgets.some((w) => w.uuid === existing.targetUuid)) {
      return res.status(409).json({ error: 'This head is already fullscreen.' });
    }
    // Persist the FULL current layout BEFORE any destructive change, so restore is always
    // possible even across a redeploy. If this throws, nothing has been deleted yet.
    await setSolo(cardId, headUuid, { targetUuid: targetWidgetUuid, widgets, at: Date.now() });
    // Delete the other windows in parallel (bounded). A window whose delete FAILS stays on the
    // head and keeps rendering (you cannot hide one on this firmware), so the operator is looking
    // at a broken fullscreen — count the failures and say so rather than reporting success.
    // Un-solo reconciles against the live head, so holding again still restores cleanly from here.
    const others = widgets.filter((w) => w.uuid !== targetWidgetUuid);
    const failed = await runPool(others, (w) => deleteHeadWidget(card.ip, headUuid, w.uuid));
    try {
      await setWidgetFullscreenVideoOnly(card.ip, headUuid, targetWidgetUuid);
    } catch (e) {
      // The deletes already ran, so the head is showing a partial mosaic — falling through to
      // the generic board error here would tell the operator nothing about how to get it back.
      // The capture was persisted before any delete, so hold-to-restore works: say so, exactly
      // like the failed-deletes case below.
      previewCache.invalidate(`${card.ip}::${headUuid}`);
      return res.status(502).json({
        error: 'Fullscreen incomplete — the other windows were removed but the card rejected the '
          + 'fullscreen change, so the head is showing a partial layout. Press and hold again to '
          + 'restore the layout, then try again.',
        code: 'SOLO_PARTIAL',
      });
    }
    previewCache.invalidate(`${card.ip}::${headUuid}`);
    if (failed) {
      return res.status(502).json({
        error: `Fullscreen incomplete — the card didn’t remove ${failed} of ${others.length} `
          + `window${others.length === 1 ? '' : 's'}, so ${failed === 1 ? 'it is' : 'they are'} `
          + 'still on the head. Press and hold again to restore the layout, then try again.',
        code: 'SOLO_PARTIAL',
      });
    }
    res.json({ ok: true });
  } catch (e) { sendPanelErr(res, e); }
});

app.post('/api/panel/cards/:cardId/heads/:headUuid/unsolo', async (req, res) => {
  const r = await resolveHeadRequest(req, res);
  if (!r) return;
  const { card } = r;
  const { cardId, headUuid } = req.params;
  const cap = getSolo(cardId, headUuid);
  if (!cap) return res.json({ ok: true, restored: false }); // nothing soloed — no-op
  try {
    // Staleness guard: if the survivor widget is gone, the head was recalled/rebuilt externally
    // (e.g. the native GUI). Recreating our captured widgets would DUPLICATE onto the new layout,
    // so drop the stale capture and leave the current layout untouched.
    const live = await getHeadWidgets(card.ip, headUuid);
    if (!live.some((w) => w.uuid === cap.targetUuid)) {
      await clearSolo(cardId, headUuid);
      previewCache.invalidate(`${card.ip}::${headUuid}`);
      return res.json({ ok: true, restored: false, stale: true });
    }
    // Reconcile against the LIVE head rather than assuming every non-target widget was deleted.
    // If a delete failed during solo, that widget is STILL on the head, and blindly recreating it
    // would leave two of it. Present (the target, plus any that survived a failed delete) -> put
    // it back to its captured state; absent -> recreate it. Runs in parallel (bounded), since this
    // is the slow part on a big mosaic and order doesn't matter.
    const liveUuids = new Set(live.map((w) => w.uuid));
    const failed = await runPool(cap.widgets, (w) => liveUuids.has(w.uuid)
      ? setWidgetFull(card.ip, headUuid, w.uuid, w)
      : createHeadWidget(card.ip, headUuid, w));
    // Clear the capture even if some writes failed. The windows we DID recreate carry NEW uuids,
    // so a second un-solo would match none of them against the capture and duplicate the mosaic —
    // a partial restore is a dead end by design, and the operator is pointed at a recall instead.
    await clearSolo(cardId, headUuid);
    previewCache.invalidate(`${card.ip}::${headUuid}`);
    if (failed) {
      return res.status(502).json({
        error: `Restore incomplete — the card didn’t rebuild ${failed} of ${cap.widgets.length} `
          + 'windows, so this head’s layout is wrong. Recall this head’s snapshot to rebuild it.',
        code: 'UNSOLO_PARTIAL',
      });
    }
    res.json({ ok: true, restored: true });
  } catch (e) { sendPanelErr(res, e); }
});

// --- admin auth ------------------------------------------------------------

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

app.post('/api/admin/login', async (req, res) => {
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
  // Always run verification (now async / off-loop) even if the user is wrong, so timing
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

app.post('/api/admin/logout', (req, res) => {
  destroySession(sessionIdFromReq(req));
  clearSessionCookie(res);
  res.json({ ok: true });
});

// Lightweight check the admin page calls on load to confirm the session is still valid.
app.get('/api/admin/session', (req, res) => {
  const s = touchSession(sessionIdFromReq(req));
  if (!s) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ ok: true, user: s.user });
});

// --- admin API -------------------------------------------------------------

app.get('/api/admin/config', requireAdmin, async (_req, res) => {
  const cfg = await loadConfig();
  const { admin, ...safe } = cfg; // never expose the password hash to the client
  res.json(safe);
});

app.put('/api/admin/config', requireAdmin, async (req, res) => {
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

  // These sub-objects are owned separately from the main config page:
  //   admin   -> auth (login), never sent to or accepted from the client
  // We ALWAYS take admin from stored config and ignore whatever the client sent.
  // (`existing` was loaded above for the version check.)
  if (existing.admin) next.admin = existing.admin; else delete next.admin;

  // backup and shareSweep ARE edited inline on the Backups tab now (their standalone Save
  // buttons were removed), so they arrive with the main save. Validate/normalise both, then
  // re-apply their schedulers so changes take effect immediately.
  if (next.backup && typeof next.backup === 'object') {
    const b = next.backup;
    // Reject a bad time rather than silently substituting 03:00. Quietly rewriting it meant a
    // mistyped time saved "successfully" and then backed up at an hour nobody chose, with no
    // warning anywhere. The dedicated /api/admin/backup endpoint already 400s on this; the two
    // save paths must agree.
    if (b.timeHHMM !== undefined && b.timeHHMM !== '' && hhmmToMinutes(b.timeHHMM) === null) {
      return res.status(400).json({ error: `Backup time "${b.timeHHMM}" isn’t a valid 24-hour time (HH:MM).` });
    }
    const hhmm = b.timeHHMM || '03:00';
    next.backup = {
      enabled: !!b.enabled,
      cardId: typeof b.cardId === 'string' ? b.cardId : '',
      timeHHMM: hhmm,
      retentionCount: Math.max(1, Math.min(365, parseInt(b.retentionCount, 10) || parseInt(b.retentionDays, 10) || 30)),
      configRetentionDays: Math.max(1, Math.min(365, parseInt(b.configRetentionDays, 10) || 30)),
    };
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
  // itself (see the handler in admin.js) and must never be reloaded out from under someone.
  // Without this, the other window sits on a stale config until a manual refresh — and its
  // next Save just fails the version check with no idea why. Excludes the window that saved:
  // it already has the new config, and telling it would report its own save as someone else's.
  broadcastControl({ type: 'config-changed', configVersion: next.configVersion }, clientIdOf(req));
  // Hand back the new token so THIS window's next save isn't refused as stale.
  res.json({ ok: true, configVersion: next.configVersion });
});

// Admin: probe a card's board so the operator can label heads while configuring filters.
app.get('/api/admin/cards/:cardId/heads', requireAdmin, async (req, res) => {
  const config = await loadConfig();
  const card = getCardById(config, req.params.cardId);
  if (!card) return res.status(404).json({ error: 'Unknown card' });
  try {
    const heads = await getHeads(card.ip);
    res.json(heads.map((h) => ({ uuid: h.uuid, name: h.name })));
  } catch (e) { sendErr(res, e); }
});

app.get('/api/admin/cards/:cardId/snapshots', requireAdmin, async (req, res) => {
  const config = await loadConfig();
  const card = getCardById(config, req.params.cardId);
  if (!card) return res.status(404).json({ error: 'Unknown card' });
  try {
    const info = await getSnapshotInfo(card.ip);
    const entries = (info.snapshots || [])
      .map(normalizeSnapshotEntry)
      .filter((e) => e.uuid && e.deleted !== true); // hide board-deleted (tombstoned) snapshots
    // Bounded like the panel listing above: on 1.10 every entry is a separate board fetch.
    const metas = new Array(entries.length);
    await runPool(entries, async (e, idx) => {
      if (e.inlineMeta) { metas[idx] = { uuid: e.uuid, name: e.name || e.uuid, path: e.path || '' }; return; }
      try {
        const m = await getSnapshotMeta(card.ip, e.uuid);
        metas[idx] = { uuid: e.uuid, name: m.name || e.uuid, path: m.path || e.path || '' };
      } catch { metas[idx] = { uuid: e.uuid, name: e.uuid, path: e.path || '' }; }
    });
    res.json(metas);
  } catch (e) { sendErr(res, e); }
});

app.get('/api/admin/cards/:cardId/self', requireAdmin, async (req, res) => {
  const config = await loadConfig();
  const card = getCardById(config, req.params.cardId);
  if (!card) return res.status(404).json({ error: 'Unknown card' });
  try { res.json(await getSelf(card.ip)); } catch (e) { sendErr(res, e); }
});

// --- API activity log (admin) ---------------------------------------------

app.get('/api/admin/log', requireAdmin, (req, res) => {
  const since = parseInt(req.query.since, 10) || 0;
  res.json({ entries: getEntries(since) });
});

app.delete('/api/admin/log', requireAdmin, (_req, res) => {
  clearLog();
  res.json({ ok: true });
});

// --- Share sweep (auto-share unshared snapshots) ---------------------------

app.get('/api/admin/sharesweep', requireAdmin, (_req, res) => {
  res.json(shareSweepStatus());
});
app.get('/api/admin/sharesweep/config', requireAdmin, async (_req, res) => {
  const config = await loadConfig();
  res.json(config.shareSweep || { enabled: false, intervalSec: 60, targets: [] });
});
app.put('/api/admin/sharesweep', requireAdmin, async (req, res) => {
  const { enabled, intervalSec, targets } = req.body || {};
  const config = await loadConfig();
  config.shareSweep = {
    enabled: !!enabled,
    intervalSec: Math.max(10, Math.min(3600, parseInt(intervalSec, 10) || 60)),
    targets: Array.isArray(targets) ? targets.filter((t) => typeof t === 'string') : [],
  };
  await saveConfig(config);
  await applyShareSweepConfig(); // apply live without restart
  // Same as the backup endpoint: notify other admin pages, but don't reload operator panels.
  broadcastControl({ type: 'config-changed', configVersion: config.configVersion }, clientIdOf(req));
  // configVersion: every saveConfig bumps the token, so return it or the caller's next main
  // config save would be refused as stale.
  res.json({ ok: true, config: config.shareSweep, configVersion: config.configVersion });
});
app.post('/api/admin/sharesweep/run', requireAdmin, async (_req, res) => {
  res.json(await runShareSweepNow());
});

// --- Scheduled backups -----------------------------------------------------

app.get('/api/admin/backup', requireAdmin, async (_req, res) => {
  const config = await loadConfig();
  res.json({ config: config.backup || {}, status: backupStatus(), files: await listBackups() });
});

app.put('/api/admin/backup', requireAdmin, async (req, res) => {
  const { enabled, cardId, timeHHMM, retentionCount, configRetentionDays } = req.body || {};
  // Validate against the same rule the scheduler fires on, so a time that stores can always run.
  if (timeHHMM && hhmmToMinutes(timeHHMM) === null) {
    return res.status(400).json({ error: `Backup time "${timeHHMM}" isn’t a valid 24-hour time (HH:MM).` });
  }
  const config = await loadConfig();
  const prev = config.backup || {};
  config.backup = {
    enabled: !!enabled,
    cardId: cardId || '',
    timeHHMM: timeHHMM || '03:00',
    // Number of most-recent board backups (full archive + zip) to keep. Falls back to any
    // legacy retentionDays value so existing configs migrate cleanly.
    retentionCount: Math.max(1, Math.min(365, parseInt(retentionCount, 10) || prev.retentionCount || prev.retentionDays || 30)),
    // Calendar-day window for the tiny config snapshots (kept independently of board count).
    configRetentionDays: Math.max(1, Math.min(365, parseInt(configRetentionDays, 10) || prev.configRetentionDays || 30)),
  };
  await saveConfig(config);
  // Other admin pages need to know the token moved. Note: 'config-changed' ONLY — no 'reload'.
  // This endpoint exists precisely so "Back up now" doesn't bounce every operator panel
  // mid-show; broadcasting a reload here would reintroduce exactly that on-air side effect.
  // Excludes the caller: "Back up now" writes through here, so without it the very window that
  // pressed the button reported its own write as another session's change, every single time.
  broadcastControl({ type: 'config-changed', configVersion: config.configVersion }, clientIdOf(req));
  // configVersion: "Back up now" saves through here, and every saveConfig bumps the token — so
  // return it, or that button would leave the page unable to save anything else.
  res.json({ ok: true, config: config.backup, configVersion: config.configVersion });
});

app.post('/api/admin/backup/run', requireAdmin, async (_req, res) => {
  res.json(await runBackupNow());
});

app.get('/api/admin/backup/files', requireAdmin, async (_req, res) => {
  // running/runKey ride along so the page can poll this one endpoint while a backup is in
  // progress: it marks that run's not-yet-written files as in-flight instead of showing the
  // half-finished run as if it were a complete one.
  const st = backupStatus();
  res.json({ files: await listBackups(), running: st.running, runKey: st.runKey });
});

// Download a backup file. Filename validated in backupFilePath to prevent traversal.
app.get('/api/admin/backup/download/:file', requireAdmin, async (req, res) => {
  const path = backupFilePath(req.params.file);
  if (!path || !existsSync(path)) return res.status(404).json({ error: 'Not found' });
  res.download(path, req.params.file);
});

// Delete a single backup file.
app.delete('/api/admin/backup/files/:file', requireAdmin, async (req, res) => {
  const path = backupFilePath(req.params.file);
  if (!path || !existsSync(path)) return res.status(404).json({ error: 'Not found' });
  try { await unlink(path); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Reachability probe: try a lightweight GET against a card's board and report the
// raw outcome (status or connection error code). Does not change anything on the board.
app.get('/api/admin/cards/:cardId/reach', requireAdmin, async (req, res) => {
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

// Per-card snapshot storage usage. Post-firmware the boards report their own total, which
// changed (and no longer matches the old fixed 200 MB assumption), so we trust the board's
// numbers: percentage is computed against the board-reported total ONLY when the board
// actually reports a usable total (> 0). If it doesn't, we return the used bytes alone with
// no percentage and no invented denominator, rather than showing a misleading figure.
app.get('/api/admin/cards/:cardId/storage', requireAdmin, async (req, res) => {
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

    // Board state: on API 1.10 it's on the /snapshots response (info.state); on 1.13 it moved
    // to /v1/storage/status (activity + sync). Try the new endpoint; fall back to the legacy
    // field. A 404 (older firmware without the endpoint) is fine — we just use info.state.
    let activity = null, syncState = null, syncMessage = null;
    try {
      const st = await getStorageStatus(card.ip);
      activity = st.activity; syncState = st.syncState; syncMessage = st.syncMessage;
    } catch { /* endpoint absent on older firmware */ }
    const legacyState = typeof info?.state === 'string' ? info.state : null;
    const legacyErr = typeof info?.lastErrorMessage === 'string' && info.lastErrorMessage ? info.lastErrorMessage : null;

    res.json({
      ok: true,
      usedBytes: hasUsed ? used : null,
      totalBytes: hasTotal ? boardTotal : null,  // board-reported; null if not reported
      percent,                                     // null when total is unknown
      // Prefer the 1.13 activity/sync fields; fall back to the 1.10 state/error fields.
      state: activity || legacyState,
      syncState,
      syncMessage: syncMessage || legacyErr,
    });
  } catch (e) {
    res.json({ ok: false, error: e.code || e.message, detail: e.detail || null });
  }
});
// Sync diagnostics for one card: the board's own sync config + live status + a flag
// breakdown of its snapshots. This is a read-only investigation aid for the post-firmware
// sync failures — it surfaces the board's own failure message and shows whether flags like
// readOnly / shared correlate with what's failing.
app.get('/api/admin/cards/:cardId/sync-diagnostics', requireAdmin, async (req, res) => {
  const config = await loadConfig();
  const card = getCardById(config, req.params.cardId);
  if (!card) return res.status(404).json({ error: 'Unknown card' });
  if (!card.ip) return res.json({ ok: false, error: 'No IP set for this card' });
  const out = { ok: true, cardId: card.id, label: card.label || card.id };

  // Board sync config (may be absent on older firmware).
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
app.post('/api/admin/cards/:cardId/sync-trigger', requireAdmin, async (req, res) => {
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

// hold it for the session so the server can push small JSON messages (currently just
// { type:'reload' } after a config save). The former per-card board fan-out was removed —
// the Neuron boards don't expose a consumable WS endpoint (the handshake returns an HTTP
// page, not a socket), so live preview updates are done by client polling + the server
// read cache instead.

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Panels open a "control" WS on load (ws?control=1) and hold it for the whole session.
// The server broadcasts small JSON messages down it — currently just { type:'reload' }
// after a config save, so panels refresh without anyone touching them.
const controlClients = new Set();

// Identifies the admin window that CAUSED a write, so it isn't told about its own change.
// The page mints an id at boot, sends it on every config-writing request (X-Client-Id) and
// registers it on its control socket (?clientId=). Excluding the originator at SEND time is
// what makes this correct: a client-side "ignore while my own save is pending" guard would
// also swallow a DIFFERENT admin's change that landed during that window — the precise thing
// this feature exists to surface. Panels never send an id, so they are never excluded.
function clientIdOf(req) { return req.get('X-Client-Id') || null; }

function broadcastControl(msg, exceptClientId = null) {
  const data = JSON.stringify(msg);
  let sent = 0;
  let skipped = 0;
  for (const c of controlClients) {
    if (exceptClientId && c.clientId === exceptClientId) { skipped++; continue; }
    if (c.readyState === WebSocket.OPEN) { try { c.send(data); sent++; } catch {} }
  }
  console.log(`[control] broadcast ${JSON.stringify(msg)} to ${sent}/${controlClients.size} client(s)`
    + (skipped ? ` (skipped ${skipped} originator)` : ''));
  return sent;
}

// Keepalive: NAT/switch timeouts can silently drop idle sockets, leaving "zombie"
// connections that look open but would never receive a reload. Ping every 30s and
// terminate any control client that didn't pong since the last round. The client
// auto-reconnects, so this keeps the connected set honest.
const controlKeepalive = setInterval(() => {
  for (const c of controlClients) {
    if (c.isAlive === false) { try { c.terminate(); } catch {} controlClients.delete(c); continue; }
    c.isAlive = false;
    try { c.ping(); } catch {}
  }
}, 30000);
controlKeepalive.unref?.();

wss.on('connection', (client, req) => {
  const url = new URL(req.url, 'http://localhost');
  // Only the control channel is supported. Anything else (e.g. a stale ?card= client) is
  // closed rather than served — there is no board fan-out anymore.
  if (url.searchParams.get('control') !== '1') { client.close(1008, 'Unsupported channel'); return; }
  // Admin pages identify themselves so their own writes aren't announced back to them.
  // Panels send no id and are never excluded from a broadcast.
  client.clientId = url.searchParams.get('clientId') || null;
  client.isAlive = true;
  client.on('pong', () => { client.isAlive = true; });
  controlClients.add(client);
  console.log(`[control] client connected (${controlClients.size} total)`);
  client.on('close', () => {
    controlClients.delete(client);
    console.log(`[control] client disconnected (${controlClients.size} total)`);
  });
});

server.listen(PORT, async () => {
  console.log(`Neuron MV Control listening on :${PORT}`);
  await loadSoloStore(); // load persisted fullscreen state so isSoloed() is correct from boot
  startShareSweep();
  startBackupScheduler();
  console.log(`Config path: ${process.env.CONFIG_PATH || '/data/config.json'}`);
  try {
    const cfg = await loadConfig();
    if (!cfg.admin || !cfg.admin.user || !cfg.admin.passwordHash) {
      console.log('WARNING: no admin credential configured — admin login is unavailable until '
        + 'config.admin.{user,passwordHash} is set. Generate a hash with: node server/auth.js "password"');
    }
    // Catch captures orphaned by a config hand-edit while the container was down (the save-time
    // prune can't see those).
    //
    // ONLY when the config genuinely loaded. loadConfig() falls back to an EMPTY config instead
    // of throwing, and pruning against that would read "no head is assigned anywhere" and delete
    // every capture on the volume — irreversibly, in response to a bad-JSON config that is
    // otherwise fully recoverable by fixing the file and restarting. That is the exact scenario
    // the persisted capture exists for (a redeploy while a head is soloed on air), so the prune
    // must never be the thing that destroys it.
    if (isConfigAuthoritative()) {
      await pruneSolo(assignedHeadKeys(cfg));
    } else {
      console.warn('[solo] skipping orphan prune — the config did not load, so the set of '
        + 'assigned heads is unknown; captures are left untouched.');
    }
  } catch {}
});

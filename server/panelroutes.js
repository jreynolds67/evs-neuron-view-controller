// server/panelroutes.js
// The panel-facing API (mounted at /api/panel). Every endpoint is scoped to the calling
// panel, resolved by its source IP — panels never see board IPs or credentials. This router
// owns the hot-path read caches and the fullscreen ("solo") orchestration.

import express from 'express';
import {
  loadConfig, getCardById, getPanelByIp, getPanelHead, resolveAllowedSnapshots,
} from './config.js';
import {
  getSnapshotInfo, getStorageStatus, getHeads,
  restorePartial, normalizeSnapshotEntry, getHeadWidgets, normalizeWidgetForPreview,
  getSnapshotModelCached, getInputGroups, setWidgetGroup,
  deleteHeadWidget, createHeadWidget, setWidgetFull, setWidgetFullscreenVideoOnly,
} from './board.js';
import { isSoloed, getSolo, setSolo, clearSolo } from './solostore.js';
import { log } from './logger.js';
import { backupStatus } from './backup.js';
import { createTtlCache } from './cache.js';
import { isUuid, runPool, clientIp } from './util.js';

const router = express.Router();
export default router;

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
// the snapshot-scoped preview route it's only ever used as a Map key.
for (const name of ['snapUuid', 'widgetUuid']) {
  router.param(name, (req, res, next, value) => {
    if (!isUuid(value)) {
      return res.status(400).json({ error: 'That item is no longer valid — go back and try again.' });
    }
    return next();
  });
}

// Authorization helper: does this panel have this exact card+head assigned?
function panelAuthorizesHead(panel, cardId, headUuid) {
  return !!getPanelHead(panel, cardId, headUuid);
}

// Resolve panel + card + assigned head for a panel-facing request, or send an error and
// return null. Every operator endpoint is scoped to a specific assigned head.
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

// Who am I? Resolve the calling panel by its source IP and return its assigned heads.
// Cards are not exposed to the operator — the panel presents a flat, curated head list.
// Each head carries its source card+uuid (needed for downstream calls), a display label
// (admin override or board name), and its order.
router.get('/me', async (req, res) => {
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
router.get('/backup-status', async (req, res) => {
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

// --- hot-path read caches --------------------------------------------------
// Short-lived caches for the endpoints panels poll continuously (every ~5s). With many
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

// Board activity states that genuinely CONFLICT with a restore: writes to the storage layer
// and sync. Deliberately an explicit set, not a regex, for two reasons:
//
//  1. The activity enum also contains TERMINAL failure states (sync-failed, import-failed,
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

// Return a human-readable busy state for a board (from GET /storage/status), or null if
// idle/unknown. Throws if the status read itself fails — callers tolerate that, since the
// busy check is advisory.
async function readBoardBusyState(ip) {
  const st = await getStorageStatus(ip);
  if (st && typeof st.activity === 'string') {
    return BUSY_ACTIVITIES.has(st.activity) ? st.activity : null;
  }
  return null;
}

// Snapshots offered for a given card+head, honouring the admin filter.
router.get('/cards/:cardId/heads/:headUuid/snapshots', async (req, res) => {
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
    const allowSet = allow ? new Set(allow) : null;
    const includeDeleted = req.query.includeDeleted === '1';

    let entries = (info.snapshots || [])
      .map(normalizeSnapshotEntry)
      .filter((e) => e.uuid); // drop anything we couldn't resolve a UUID for

    // Hide board-side deleted (tombstoned) snapshots unless explicitly requested.
    if (!includeDeleted) entries = entries.filter((e) => e.deleted !== true);

    if (allowSet) entries = entries.filter((e) => allowSet.has(e.uuid));

    // The firmware returns metadata inline on the list (see normalizeSnapshotEntry), so no
    // per-item fetch is needed. An entry that somehow arrives without a name falls back to
    // its uuid rather than being dropped.
    const metas = entries.map((e) => ({
      uuid: e.uuid,
      name: e.name || e.uuid,
      description: e.description || '',
      timestamp: e.timestamp || 0,
      path: e.path || '',
    }));
    // Sort by folder, then name, for a predictable grouped list.
    metas.sort((a, b) =>
      (a.path || '').localeCompare(b.path || '') || (a.name || '').localeCompare(b.name || ''));
    // Board activity for the panel's "board busy" hint.
    let boardState = null;
    try { boardState = await readBoardBusyState(card.ip); } catch { /* non-fatal */ }
    res.json({ state: boardState, snapshots: metas });
  } catch (e) { sendPanelErr(res, e); }
});

// The heads stored inside a snapshot (candidates for the partial mapping source).
router.get('/cards/:cardId/snapshots/:snapUuid/heads', async (req, res) => {
  const r = await resolveCardRequest(req, res);
  if (!r) return;
  const { card } = r;
  try {
    const modelEntry = await getSnapshotModelCached(card.ip, req.params.snapUuid);
    // The index carries only named heads (unnamed entries aren't selectable).
    const heads = modelEntry.index.heads;

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
    // rebuilt — the strict name/shape check in indexSnapshotModel is the real guard against
    // junk, so no live-board filter is needed.)
    res.json({ heads, parsed: heads.length > 0 });
  } catch (e) { sendPanelErr(res, e); }
});

// Preview: widget layout currently on a LIVE head.
router.get('/cards/:cardId/heads/:headUuid/preview', async (req, res) => {
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

// Extract an operator-facing input NUMBER from a group. Names typically embed a number
// ("IN 12", "Input 12", "12"); we grab the first integer we find. Falls back to null.
function groupNumber(g) {
  const m = (g && typeof g.name === 'string') ? g.name.match(/\d+/) : null;
  return m ? parseInt(m[0], 10) : null;
}

// Input groups available on a head's card, with a parsed number and the stream UUIDs.
router.get('/cards/:cardId/heads/:headUuid/groups', async (req, res) => {
  const r = await resolveHeadRequest(req, res);
  if (!r) return;
  const { card } = r;
  try {
    // Groups are per-card (not per-head), so key by IP — every head on a card shares one
    // cached result, further cutting board fetches.
    const groups = await groupsCache.get(card.ip, () => getInputGroups(card.ip));
    // Stream references are plural arrays (videoUuids etc.); expose the first of each as
    // pass-through metadata. Group selection uses uuid/name/number.
    const first = (arr) => (Array.isArray(arr) && arr.length ? arr[0] : '');
    const out = (groups || []).map((g) => ({
      uuid: g.uuid,
      name: g.name || '',
      number: groupNumber(g),
      videoUuid: first(g.videoUuids),
      audioUuid: first(g.audioUuids),
      dataUuid: first(g.dataUuids),
    }));
    res.json({ groups: out });
  } catch (e) { sendPanelErr(res, e); }
});

// Repoint a window (widget) to a different input group. LIVE EDIT to the on-air board.
// Body: { groupUuid }. Authorized to the specific assigned head.
router.post('/cards/:cardId/heads/:headUuid/widgets/:widgetUuid/group', async (req, res) => {
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
router.get('/cards/:cardId/snapshots/:snapUuid/heads/:headUuid/preview', async (req, res) => {
  const r = await resolveCardRequest(req, res);
  if (!r) return;
  const { card } = r;
  try {
    const { index } = await getSnapshotModelCached(card.ip, req.params.snapUuid);
    const widgets = index.headWidgets.get(req.params.headUuid) || [];
    res.json({ widgets, resolved: widgets.length > 0 });
  } catch (e) { sendPanelErr(res, e); }
});

// Preview (batched): widget layouts for ALL heads in a snapshot, in one call. The Source
// step uses this so a single model fetch+parse serves every source-head preview at once.
router.get('/cards/:cardId/snapshots/:snapUuid/previews', async (req, res) => {
  const r = await resolveCardRequest(req, res);
  if (!r) return;
  const { card } = r;
  try {
    const { index } = await getSnapshotModelCached(card.ip, req.params.snapUuid);
    const byHead = {};
    for (const [uuid, widgets] of index.headWidgets) byHead[uuid] = widgets;
    res.json({ heads: byHead });
  } catch (e) { sendPanelErr(res, e); }
});

// Fire the partial restore. Body: { snapshotHeadUuid, targetHeadUuid }.
// This is the ONLY restore entrypoint and it is structurally partial-only.
router.post('/cards/:cardId/snapshots/:snapUuid/restore', async (req, res) => {
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
    // legitimate restore). Deliberately uncached — a stale read is the thing being guarded
    // against.
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
//
// Widget deletes/recreates run through runPool (bounded parallelism): an individual failure
// does NOT abort the run — a solo/unsolo shouldn't stop dead because one widget hiccuped —
// but failures ARE counted, so the operator is told rather than shown success over a head
// that is visibly wrong.

router.post('/cards/:cardId/heads/:headUuid/solo', async (req, res) => {
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

router.post('/cards/:cardId/heads/:headUuid/unsolo', async (req, res) => {
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

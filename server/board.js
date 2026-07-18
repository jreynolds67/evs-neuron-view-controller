// server/board.js
// Thin client for a single EVS Neuron View board API (firmware 1.13 — see api 1-13.yaml).
// Boards speak HTTPS with a self-signed certificate (default), so we use a scoped
// HTTPS agent that accepts the board's cert WITHOUT weakening TLS for any other
// outbound request in the process.
//
// The ONLY restore path exposed here is a partial, per-head restore. A full restore
// cannot be constructed through this module — every restore flag except the partial
// head map is hard-coded to false.

import { Agent } from 'undici';
import { log, describeError } from './logger.js';
import { isUuid } from './util.js';

// Default timeout for ordinary board API calls (small JSON reads/writes).
const API_TIMEOUT_MS = 8000;
// Whole-board snapshot exports stream up to the card's full storage (hundreds of MB) and can
// take far longer than a normal API call. They get their own generous timeout — otherwise
// backups start failing on storage growth alone, silently degrading to per-folder attempts
// that hit the same wall. Override with BOARD_EXPORT_TIMEOUT_MS if a site needs longer.
const EXPORT_TIMEOUT_MS = parseInt(process.env.BOARD_EXPORT_TIMEOUT_MS, 10) || 10 * 60 * 1000;

// Configurable so this adapts if a site fronts the boards differently.
//   BOARD_SCHEME  : "https" (default) or "http"
//   BOARD_PORT    : default 443 for https, 80 for http; set to override
//   BOARD_TLS_REJECT_UNAUTHORIZED : "true" to enforce cert validation (default false,
//                   because boards ship self-signed certs). Only these board calls are
//                   affected — global TLS is untouched.
const SCHEME = (process.env.BOARD_SCHEME || 'https').toLowerCase();
const PORT = process.env.BOARD_PORT || (SCHEME === 'https' ? '443' : '80');
const REJECT_UNAUTHORIZED = String(process.env.BOARD_TLS_REJECT_UNAUTHORIZED || 'false') === 'true';

// One reusable agent scoped to board requests. For HTTPS with self-signed certs we set
// rejectUnauthorized:false here only — fetch() calls elsewhere use the default agent
// and remain fully validated.
const boardAgent = SCHEME === 'https'
  ? new Agent({ connect: { rejectUnauthorized: REJECT_UNAUTHORIZED } })
  : undefined;

function portSuffix() {
  const isDefault = (SCHEME === 'https' && PORT === '443') || (SCHEME === 'http' && PORT === '80');
  return isDefault ? '' : `:${PORT}`;
}

function boardBase(ip) {
  return `${SCHEME}://${ip}${portSuffix()}/api/v1`;
}

async function boardFetch(ip, path, options = {}) {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || API_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const method = (options.method || 'GET').toUpperCase();
  const url = `${boardBase(ip)}${path}`;
  const started = Date.now();
  const raw = options.raw === true;
  const opts = { ...options };
  delete opts.raw;
  delete opts.diagnostic;
  delete opts.timeoutMs;
  try {
    const res = await fetch(url, {
      ...opts,
      dispatcher: boardAgent,
      signal: controller.signal,
      headers: raw
        ? { ...(opts.headers || {}) }
        : { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    const durationMs = Date.now() - started;

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log({ ip, path, method, url, status: res.status, durationMs, ok: false,
        error: `HTTP ${res.status}`, detail: text.slice(0, 300) });
      const err = new Error(`Board ${ip} ${path} -> ${res.status}`);
      err.status = res.status;
      err.body = text;
      throw err;
    }

    if (raw) {
      const buf = Buffer.from(await res.arrayBuffer());
      const ctype = res.headers.get('content-type') || '';
      const cdisp = res.headers.get('content-disposition') || '';
      const head = buf.slice(0, 16).toString('latin1').replace(/[^\x20-\x7e]/g, '.');
      log({ ip, path, method, url, status: res.status, durationMs, ok: true,
        detail: `${buf.length} bytes · type=${ctype || 'none'} · disp=${cdisp || 'none'} · head="${head}"` });
      // Return bytes plus the transport metadata so the caller can name the file correctly
      // and detect a JSON error masquerading as a download.
      buf.__ctype = ctype;
      buf.__cdisp = cdisp;
      return buf;
    }

    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    // Successful JSON calls: log the response size always, and — if the caller supplied a
    // `diagnostic` summarizer — a short summary of the body. This makes odd board behaviour
    // (weird storage numbers, unexpected states, empty lists) visible in the activity log
    // without dumping whole payloads.
    let detail = `${text.length} bytes`;
    if (typeof options.diagnostic === 'function') {
      try { const d = options.diagnostic(body); if (d) detail += ` · ${d}`; } catch {}
    }
    log({ ip, path, method, url, status: res.status, durationMs, ok: true, detail });
    return body;
  } catch (e) {
    if (e.status === undefined) {
      const durationMs = Date.now() - started;
      const { code, detail } = describeError(e);
      log({ ip, path, method, url, status: null, durationMs, ok: false, error: code, detail });
      const err = new Error(`fetch failed (${code}) for ${ip}${path}`);
      err.status = 502;
      err.code = code;
      err.detail = detail;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function getSelf(ip) {
  return boardFetch(ip, '/self');
}

export async function getSnapshotInfo(ip) {
  // Log a compact summary of the board's own reported storage figures. Board activity/sync
  // state lives on /v1/storage/status (see getStorageStatus); this response carries the
  // snapshot list and storage byte counts.
  return boardFetch(ip, '/snapshots', {
    diagnostic: (b) => {
      if (!b || typeof b !== 'object') return null;
      const used = Number(b.usedStorageBytes);
      const total = Number(b.totalStorageBytes);
      const count = Array.isArray(b.snapshots) ? b.snapshots.length : '?';
      const mb = (n) => Number.isFinite(n) ? (n / 1048576).toFixed(1) + 'MB' : '?';
      return `used=${mb(used)} · total=${mb(total)} · snapshots=${count}`;
    },
  });
}

// Board native card-to-card sync CONFIG (/v1/storage/sync). Separate from this app's
// share-sweep — this is the board replicating shared snapshots to a target on its own.
// { enabled, intervalSeconds, target }
export async function getStorageSync(ip) {
  return boardFetch(ip, '/storage/sync');
}

// Manually kick the board's native sync (POST /v1/storage/sync/trigger). Useful to force a
// sync and then read /storage/status to see whether/why it failed.
export async function triggerStorageSync(ip) {
  return boardFetch(ip, '/storage/sync/trigger', { method: 'POST' });
}

// Board storage/activity status (/v1/storage/status): the board's live activity plus its
// sync state. Returns a normalised shape:
//   { activity, syncState, syncMessage, tasks }  (absent fields => null)
export async function getStorageStatus(ip) {
  const s = await boardFetch(ip, '/storage/status', {
    diagnostic: (b) => {
      if (!b || typeof b !== 'object') return null;
      const sync = b.sync || {};
      const tasks = Array.isArray(b.tasks) ? b.tasks.length : 0;
      return `activity=${b.activity ?? '?'} · sync=${sync.state ?? '?'}`
        + (sync.message ? ` · syncMsg="${String(sync.message).slice(0, 80)}"` : '')
        + ` · tasks=${tasks}`;
    },
  });
  const sync = (s && s.sync) || {};
  return {
    activity: s?.activity ?? null,
    syncState: sync.state ?? null,
    syncMessage: sync.message ?? null,
    tasks: Array.isArray(s?.tasks) ? s.tasks : [],
  };
}

// The published schema says /snapshots returns an array of UUID strings, but the firmware
// returns rich metadata objects. Normalise either to a consistent
// { uuid, name?, description?, timestamp?, path?, deleted, shared, readOnly } shape.
// uuid: null marks an entry we couldn't resolve; callers drop those.
export function normalizeSnapshotEntry(entry) {
  if (typeof entry === 'string') {
    return { uuid: isUuid(entry) ? entry : null };
  }

  if (entry && typeof entry === 'object') {
    // Find the UUID: prefer a field literally named uuid, else any uuid-looking value,
    // handling the case where uuid is itself nested as { uuid: "..." } or similar.
    let uuid = null;
    const candidates = [entry.uuid, entry.id, entry.snapshotUuid, entry.snapshot];
    for (const c of candidates) {
      if (isUuid(c)) { uuid = c; break; }
      if (c && typeof c === 'object' && isUuid(c.uuid)) { uuid = c.uuid; break; }
    }
    if (!uuid) {
      // Last resort: scan all string values for something uuid-shaped.
      for (const v of Object.values(entry)) if (isUuid(v)) { uuid = v; break; }
    }

    return {
      uuid,
      name: entry.name,
      description: entry.description,
      timestamp: entry.updatedAt ?? entry.createdAt ?? undefined,
      path: entry.path,
      // deletedAt is a nullable timestamp; non-null = deleted. 0 is treated as NOT deleted:
      // it's the epoch, so a firmware using 0 as a "never deleted" sentinel must not be read
      // as "deleted in 1970".
      deleted: entry.deletedAt !== undefined && entry.deletedAt !== null && entry.deletedAt !== 0,
      shared: entry.shared,
      readOnly: entry.readOnly === true,
    };
  }
  return { uuid: null };
}

export async function getSnapshotMeta(ip, uuid) {
  const m = await boardFetch(ip, `/snapshots/${uuid}`);
  if (m && typeof m === 'object') {
    // Canonical read fields for callers: timestamp <- updatedAt | createdAt,
    // deleted <- (deletedAt != null).
    m.timestamp = m.updatedAt ?? m.createdAt ?? 0;
    m.deleted = m.deletedAt !== undefined && m.deletedAt !== null && m.deletedAt !== 0;
  }
  return m;
}

// Set a snapshot's `shared` flag via a PUT to its metadata (MetadataChange:
// description/name/path/shared/uuid).
export async function setSnapshotShared(ip, snap, shared = true) {
  // SAFETY: this is a full-object PUT — every field we send REPLACES what's on the board.
  // Building the body from `snap.name || ''` would rename a snapshot to an empty string and
  // move it out of its folder. So: if the entry lacks a name, fetch the real metadata first,
  // and refuse outright rather than PUT a blank name.
  let meta = snap;
  if (typeof snap.name !== 'string' || snap.name === '') {
    meta = await getSnapshotMeta(ip, snap.uuid);
  }
  if (!meta || typeof meta.name !== 'string' || meta.name === '') {
    const err = new Error(`Refusing to update snapshot ${snap.uuid}: no name in metadata `
      + '(a full-object PUT would blank it). Board returned incomplete metadata.');
    err.code = 'META_INCOMPLETE';
    log({
      ip, method: 'GUARD', path: `/snapshots/${snap.uuid}`, status: null, ok: false,
      detail: 'refused metadata PUT — snapshot metadata has no name; would have blanked it',
    });
    throw err;
  }

  const change = {
    description: meta.description || '',
    name: meta.name,
    path: meta.path || '',
    shared,
    uuid: snap.uuid,
  };

  return boardFetch(ip, `/snapshots/${snap.uuid}`, {
    method: 'PUT',
    body: JSON.stringify(change),
    diagnostic: (b) => {
      // Confirm what the board echoed back for the share flag, so whether the PUT actually
      // took is visible in the activity log.
      const echoed = (b && typeof b === 'object' && 'shared' in b) ? `shared=${b.shared}` : 'no-echo';
      return `set shared=${shared} on ${snap.name || snap.uuid} · board ${echoed}`;
    },
  });
}

// Export snapshots as a single binary file. The board requires EXACTLY ONE selector —
// providing both pathWildcard and snapshots is rejected (400). Pass a non-empty
// `snapshots` array to export those specific UUIDs, OR a `pathWildcard` to export by
// folder path. If snapshots is non-empty it wins and pathWildcard is omitted.
export async function exportSnapshots(ip, { pathWildcard, snapshots } = {}) {
  let payload;
  if (Array.isArray(snapshots) && snapshots.length) {
    payload = { snapshots };
  } else if (pathWildcard) {
    payload = { pathWildcard };
  } else {
    payload = { pathWildcard: '*' }; // default: whole board by wildcard
  }
  return boardFetch(ip, '/snapshots/export', {
    method: 'POST',
    body: JSON.stringify(payload),
    raw: true,
    // A whole-board export can be hundreds of MB — never the 8s default.
    timeoutMs: EXPORT_TIMEOUT_MS,
  });
}

// Live heads currently configured on the board (target heads).
export async function getHeads(ip) {
  return boardFetch(ip, '/heads');
}

// Widgets currently placed on a live head — the schematic layout of what's on air.
export async function getHeadWidgets(ip, headUuid) {
  return boardFetch(ip, `/heads/${headUuid}/widgets/`);
}

// Input groups on a board: each group bundles a video/audio/data stream under a name
// (the name typically carries the operator-facing input NUMBER).
export async function getInputGroups(ip) {
  return boardFetch(ip, '/inputs/groups');
}

// One widget's full definition (needed before repointing its group).
async function getHeadWidget(ip, headUuid, widgetUuid) {
  return boardFetch(ip, `/heads/${headUuid}/widgets/${widgetUuid}`);
}

// Reduce a widget (WidgetGet or a captured copy) to the WidgetChange body the board accepts
// on POST/PUT, optionally overriding fields. Every widget write goes through this one shape,
// so a firmware schema change is a single edit.
function toWidgetChange(w, overrides = {}) {
  return {
    elements: w.elements || [],
    geometry: w.geometry,
    groupUuid: w.groupUuid || '',
    name: w.name || '',
    properties: w.properties || { borderColor: '', borderSize: '' },
    ...overrides,
  };
}

// Repoint a widget to a different input group. The board API has no conditional/versioned
// write, so this is inherently a read-modify-write: we must send the whole widget back,
// changing only groupUuid. The risk is a concurrent change (another operator firing a
// restore onto this head, or the native GUI) landing between our read and our write, which
// we'd then clobber with the stale copy.
//
// Mitigation without server support: read the widget TWICE — once to build the change, and
// again immediately before writing. If the preserved fields (elements/geometry/name) differ
// between the two reads, something is actively modifying this widget right now, so we ABORT
// with a conflict rather than overwrite. We always build the PUT from the SECOND (freshest)
// read, so in the common case we write the latest widget with only the group swapped — never
// a stale snapshot of it. Full before/after is logged so any clobber is diagnosable.
function widgetFingerprint(w) {
  // Fields we preserve verbatim. If any changed between reads, a concurrent write is in
  // progress. JSON stringify is fine here — order is stable from the same source object.
  return JSON.stringify({
    elements: w.elements || [],
    geometry: w.geometry || null,
    name: w.name || '',
    properties: w.properties || null,
  });
}

export async function setWidgetGroup(ip, headUuid, widgetUuid, groupUuid) {
  // A concurrent snapshot recall from another panel can either change this widget or replace
  // it entirely (a restore gives widgets new UUIDs). Both mean "the thing you were editing is
  // gone/stale" — surface them as ONE clear, operator-facing message rather than a raw board
  // 404 or a low-level conflict string.
  const recalledErr = () => {
    const e = new Error('Snapshot recalled by another user. Please try your changes again.');
    e.status = 409;
    e.code = 'RECALLED';
    return e;
  };

  let first, fresh;
  try {
    first = await getHeadWidget(ip, headUuid, widgetUuid);
    // Re-read right before writing to catch a concurrent modification in the gap.
    fresh = await getHeadWidget(ip, headUuid, widgetUuid);
  } catch (e) {
    // 404 => the widget UUID no longer exists (replaced by a restore). Treat as a recall.
    if (e && e.status === 404) {
      log({
        ip, method: 'CONFLICT', path: `/heads/${headUuid}/widgets/${widgetUuid}`,
        status: 404, ok: false,
        detail: 'widget no longer exists — replaced by a concurrent snapshot recall; group change aborted',
      });
      throw recalledErr();
    }
    throw e;
  }

  if (widgetFingerprint(first) !== widgetFingerprint(fresh)) {
    log({
      ip, method: 'CONFLICT', path: `/heads/${headUuid}/widgets/${widgetUuid}`,
      status: null, ok: false,
      detail: 'widget changed between reads — concurrent restore or GUI edit; group change aborted to avoid clobber',
    });
    throw recalledErr();
  }

  const before = { groupUuid: fresh.groupUuid || '' };
  // Build the write from the freshest read, changing ONLY the group.
  const change = toWidgetChange(fresh, { groupUuid });
  let result;
  try {
    result = await boardFetch(ip, `/heads/${headUuid}/widgets/${widgetUuid}`, {
      method: 'PUT',
      body: JSON.stringify(change),
    });
  } catch (e) {
    // The widget could vanish in the tiny gap between our read and this write, too.
    if (e && e.status === 404) throw recalledErr();
    throw e;
  }
  log({
    ip, method: 'GROUP', path: `/heads/${headUuid}/widgets/${widgetUuid}`,
    status: null, ok: true,
    detail: `group ${before.groupUuid || '(none)'} -> ${groupUuid}`,
  });
  return result;
}

// --- Fullscreen ("solo") a head's window -----------------------------------
// Investigation (see the widget-geometry memory) proved you cannot HIDE a widget on this
// firmware — only DELETE removes it from the render. So "blow up to fullscreen" is: capture the
// head, delete every other widget, and turn the survivor into a full-canvas VIDEO-ONLY window.
// Restore recreates the deleted widgets and puts the survivor back exactly.

const FULL = { x: 0, y: 0, width: 1, height: 1 };

// Delete one widget from a head. This is the ONLY way to remove a widget from the live render.
export async function deleteHeadWidget(ip, headUuid, widgetUuid) {
  return boardFetch(ip, `/heads/${headUuid}/widgets/${widgetUuid}`, { method: 'DELETE' });
}

// Recreate a widget on a head from a captured WidgetGet. The board assigns a NEW uuid (fine —
// this app never persists widget UUIDs). Body is a WidgetChange (WidgetGet minus uuid).
export async function createHeadWidget(ip, headUuid, widget) {
  return boardFetch(ip, `/heads/${headUuid}/widgets`, {
    method: 'POST', body: JSON.stringify(toWidgetChange(widget)),
  });
}

// PUT a widget's full definition back (keeps its uuid). Used to restore the survivor to its
// captured original (elements, geometry, border, source) when un-soloing.
export async function setWidgetFull(ip, headUuid, widgetUuid, widget) {
  return boardFetch(ip, `/heads/${headUuid}/widgets/${widgetUuid}`, {
    method: 'PUT', body: JSON.stringify(toWidgetChange(widget)),
  });
}

// Turn a widget into a full-canvas, VIDEO-ONLY window: geometry to full, keep only its `pip`
// (video) element(s) filled to the frame, drop UMDs/clocks/audio meters and any border. If the
// widget has no pip element (unexpected for a video window), fall back to keeping its existing
// elements so we never blank the window — just fullscreen it.
export async function setWidgetFullscreenVideoOnly(ip, headUuid, widgetUuid) {
  const cur = await getHeadWidget(ip, headUuid, widgetUuid);
  const pips = (cur.elements || []).filter((el) => el && el.type === 'pip');
  const elements = pips.length
    ? pips.map((el) => ({ ...el, geometry: { ...FULL }, visible: true }))
    : (cur.elements || []);
  const change = toWidgetChange(cur, {
    elements,
    geometry: { ...FULL },
    // Drop any border so it's pure video.
    properties: { borderColor: '', borderSize: '' },
  });
  const result = await boardFetch(ip, `/heads/${headUuid}/widgets/${widgetUuid}`, {
    method: 'PUT', body: JSON.stringify(change),
  });
  log({
    ip, method: 'SOLO', path: `/heads/${headUuid}/widgets/${widgetUuid}`, status: null, ok: true,
    detail: `fullscreen video-only (${pips.length ? `${pips.length} pip` : 'no pip — kept elements'})`,
  });
  return result;
}

// Reduce a raw widget (WidgetGet) to the minimal shape the preview renderer needs:
// its geometry, and its elements' geometry + type + a couple of display hints. Keeps
// the payload small and hides board internals from the browser.
export function normalizeWidgetForPreview(w) {
  const geom = (g) => g && typeof g === 'object'
    ? { x: +g.x || 0, y: +g.y || 0, width: +g.width || 0, height: +g.height || 0 }
    : { x: 0, y: 0, width: 0, height: 0 };

  // Pull a human-ish label and a color out of an element's typed properties. Property
  // values are "type::value" strings (e.g. text::Hello, color::ffffff, protocol::0).
  function elementHints(el) {
    const p = el.properties || {};
    const out = { text: null, color: null, borderColor: null };
    const decode = (v) => {
      if (typeof v !== 'string' || !v.includes('::')) return null;
      const [kind, ...rest] = v.split('::');
      return { kind, value: rest.join('::') };
    };
    // text-bearing fields
    for (const key of ['text']) {
      const d = decode(p[key]);
      if (d) {
        if (d.kind === 'text') out.text = d.value;
        else if (d.kind === 'input') out.text = `‹${d.value}›`;
        else if (d.kind === 'timecode') out.text = d.value === 'realtime' ? '‹clock›' : '‹TC›';
        else if (d.kind === 'reference') out.text = `‹${d.value}›`;
        // protocol:: text is a dynamic UMD/tally label driven by an external protocol source
        // (protocol::0..7). Its live value can't be resolved from the stored model, and the
        // placeholder (‹P0› etc.) is just noise in a schematic preview — so render no label.
        // (input/timecode/reference above still show a marker; only protocol is suppressed.)
      }
    }
    // color fields — only literal color:: values become real colors; dynamic sources
    // (protocol::, reference::) are shown as a neutral marker since we can't resolve them.
    for (const [key, dst] of [['backgroundColor', 'color'], ['borderColor', 'borderColor']]) {
      const d = decode(p[key]);
      if (d && d.kind === 'color') out[dst] = `#${d.value}`;
    }
    return out;
  }

  return {
    uuid: w.uuid,
    name: w.name || '',
    groupUuid: w.groupUuid || '',
    geometry: geom(w.geometry),
    elements: (w.elements || [])
      .filter((el) => el && el.visible !== false)
      .map((el) => ({
        type: el.type || 'box',
        geometry: geom(el.geometry),
        ...elementHints(el),
      })),
  };
}

// Raw stored model blob for a snapshot. Used to enumerate the heads that exist
// INSIDE the snapshot so we can build the partial head map. Shape is board-specific;
// see indexSnapshotModel() for the tolerant parser.
async function getSnapshotModel(ip, uuid) {
  return boardFetch(ip, `/snapshots/${uuid}/model`);
}

// Walk a parsed snapshot model ONCE and index everything the app needs from it:
//
//   heads       — the snapshot's SELECTABLE source heads [{ uuid, name }]. An operator cannot
//                 create an unnamed head/snapshot in the GUI, so a real, selectable head
//                 ALWAYS has a name. That single fact is the whole discriminator: an unnamed
//                 uuid-bearing object (widget, io block, template, nested sub-canvas) is not
//                 selectable anyway, since the operator couldn't tell what they'd be loading.
//   headWidgets — Map of headUuid -> normalized widgets, for EVERY head (named or not), so a
//                 single model fetch+parse serves previews for all source heads at once.
//
// A head is any object under a "heads" collection carrying a uuid and a widgets array; the
// widgets array may hold widget objects inline or string references to widgets defined
// elsewhere in the blob.
export function indexSnapshotModel(root) {
  const isWidgetShape = (n) =>
    n && typeof n === 'object' && isUuid(n.uuid) && Array.isArray(n.elements);

  const headNodes = [];
  const widgetById = new Map();
  (function walk(node, keyHint) {
    if (Array.isArray(node)) { for (const it of node) walk(it, keyHint); return; }
    if (node && typeof node === 'object') {
      if (keyHint === 'heads' && isUuid(node.uuid) && Array.isArray(node.widgets)) {
        headNodes.push(node);
      }
      if (isWidgetShape(node)) widgetById.set(node.uuid, node);
      for (const [k, v] of Object.entries(node)) walk(v, k);
    }
  })(root, null);

  const heads = [];
  const seen = new Set();
  for (const h of headNodes) {
    const named = typeof h.name === 'string' && h.name.trim() !== '' && h.name !== h.uuid;
    if (named && !seen.has(h.uuid)) {
      seen.add(h.uuid);
      heads.push({ uuid: h.uuid, name: h.name });
    }
  }

  const headWidgets = new Map();
  for (const head of headNodes) {
    const refs = head.widgets || [];
    let widgets = [];
    if (refs.length && typeof refs[0] === 'string') {
      widgets = refs.map((id) => widgetById.get(id)).filter(Boolean);
    } else if (refs.length && typeof refs[0] === 'object') {
      widgets = refs.filter(isWidgetShape);
    }
    headWidgets.set(head.uuid, widgets.map(normalizeWidgetForPreview));
  }

  return { heads, headWidgets };
}

// Short-lived cache of fetched snapshot models WITH their parsed index. A saved snapshot is
// immutable, and the heads/preview calls for one snapshot all arrive within a few seconds of
// each other, so caching briefly turns N board fetches + walks (one per source head) into a
// single fetch and a single walk. Entry: { at, root, index: { heads, headWidgets } }.
const _modelCache = new Map(); // key `${ip}::${uuid}`
const MODEL_TTL_MS = 30000;

// model may be { data: "<json string>" } per StorageFilePreview, or already-parsed.
function parseModelRoot(model) {
  let root = model;
  if (model && typeof model.data === 'string') {
    try { root = JSON.parse(model.data); } catch { root = model.data; }
  }
  return root;
}

export async function getSnapshotModelCached(ip, uuid) {
  const key = `${ip}::${uuid}`;
  const hit = _modelCache.get(key);
  if (hit && (Date.now() - hit.at) < MODEL_TTL_MS) return hit;
  const model = await getSnapshotModel(ip, uuid);
  const root = parseModelRoot(model);
  const entry = { at: Date.now(), root, index: indexSnapshotModel(root) };
  _modelCache.set(key, entry);
  if (_modelCache.size > 32) {
    const now = Date.now();
    for (const [k, v] of _modelCache) if (now - v.at >= MODEL_TTL_MS) _modelCache.delete(k);
  }
  return entry;
}

// PARTIAL RESTORE — the only restore this app performs.
// Maps exactly the provided snapshot head UUIDs onto the provided target head UUIDs.
// Every other restore facet is forced off. There is deliberately no code path that
// sets restoreHeads: true or any global/appearance/io flag to true.
export async function restorePartial(ip, snapshotUuid, headMap) {
  if (!Array.isArray(headMap) || headMap.length === 0) {
    const err = new Error('Refusing restore: empty head map (would be a no-op or full restore).');
    err.status = 400;
    throw err;
  }
  for (const m of headMap) {
    if (!m || !m.snapshotHeadUuid || !m.targetHeadUuid) {
      const err = new Error('Refusing restore: malformed head map entry.');
      err.status = 400;
      throw err;
    }
  }

  const body = {
    restoreAppearanceHeadTemplates: false,
    restoreAppearanceProtocol: false,
    restoreAppearanceWidgetTemplates: false,
    restoreGlobalSettings: false,
    restoreHeads: false,            // NEVER true — that would be a full-heads restore
    restoreHeadsPartial: headMap,   // the only thing we actually apply
    restoreImageVideo: false,
    restoreInputs: false,
    restoreNmos: false,
    restoreOutputsIp: false,
    restoreOutputsSdi: false,
    restorePatternGenerator: false,
    restoreReference: false,
    restoreTSL: false,
  };

  return boardFetch(ip, `/snapshots/${snapshotUuid}/restore`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

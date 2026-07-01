// server/board.js
// Thin client for a single EVS Neuron View board API.
// Boards speak HTTPS with a self-signed certificate (default), so we use a scoped
// HTTPS agent that accepts the board's cert WITHOUT weakening TLS for any other
// outbound request in the process.
//
// The ONLY restore path exposed here is a partial, per-head restore. A full restore
// cannot be constructed through this module — every restore flag except the partial
// head map is hard-coded to false.

import { Agent } from 'undici';
import { log, describeError } from './logger.js';

const API_TIMEOUT_MS = 8000;

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
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  const method = (options.method || 'GET').toUpperCase();
  const url = `${boardBase(ip)}${path}`;
  const started = Date.now();
  try {
    const res = await fetch(url, {
      ...options,
      dispatcher: boardAgent,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    const durationMs = Date.now() - started;

    if (!res.ok) {
      log({ ip, path, method, url, status: res.status, durationMs, ok: false,
        error: `HTTP ${res.status}`,
        detail: typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300) });
      const err = new Error(`Board ${ip} ${path} -> ${res.status}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }

    log({ ip, path, method, url, status: res.status, durationMs, ok: true });
    return body;
  } catch (e) {
    // Only log connection-level failures here; HTTP errors were already logged above.
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
  return boardFetch(ip, '/snapshots');
}

// The documented schema says /snapshots returns an array of UUID strings, but some
// firmware returns richer objects. Normalise any entry to { uuid, name?, description?,
// timestamp? }. Pulls the UUID from common key names, and captures inline metadata if
// the board already provides it (so we can skip a per-item metadata fetch).
function looksLikeUuid(v) {
  return typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

export function normalizeSnapshotEntry(entry) {
  if (typeof entry === 'string') {
    return { uuid: looksLikeUuid(entry) ? entry : null, inlineMeta: false };
  }

  if (entry && typeof entry === 'object') {
    // Find the UUID: prefer a field literally named uuid, else any uuid-looking value,
    // handling the case where uuid is itself nested as { uuid: "..." } or similar.
    let uuid = null;
    const candidates = [entry.uuid, entry.id, entry.snapshotUuid, entry.snapshot];
    for (const c of candidates) {
      if (looksLikeUuid(c)) { uuid = c; break; }
      if (c && typeof c === 'object' && looksLikeUuid(c.uuid)) { uuid = c.uuid; break; }
    }
    if (!uuid) {
      // Last resort: scan all string values for something uuid-shaped.
      for (const v of Object.values(entry)) if (looksLikeUuid(v)) { uuid = v; break; }
    }
    const hasMeta = 'name' in entry || 'description' in entry || 'timestamp' in entry;
    return {
      uuid,
      inlineMeta: hasMeta,
      name: entry.name,
      description: entry.description,
      timestamp: entry.timestamp,
      path: entry.path,
      deleted: entry.deleted,
      shared: entry.shared,
    };
  }
  return { uuid: null, inlineMeta: false };
}

export async function getSnapshotMeta(ip, uuid) {
  return boardFetch(ip, `/snapshots/${uuid}`);
}

// Live heads currently configured on the board (target heads).
export async function getHeads(ip) {
  return boardFetch(ip, '/heads');
}

// Widgets currently placed on a live head — the schematic layout of what's on air.
export async function getHeadWidgets(ip, headUuid) {
  return boardFetch(ip, `/heads/${headUuid}/widgets/`);
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
        else if (d.kind === 'protocol') out.text = `‹P${d.value}›`;
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
// see extractSnapshotHeads() for the tolerant parser.
export async function getSnapshotModel(ip, uuid) {
  return boardFetch(ip, `/snapshots/${uuid}/model`);
}

// Extract named head entries from a snapshot model blob. An operator cannot create an
// unnamed head/snapshot in the GUI, so a real, selectable head ALWAYS has a name. That
// single fact is the whole discriminator: collect every object carrying a uuid + a
// non-empty name, and ignore everything else. Unnamed uuid-bearing objects (widgets, io
// blocks, templates, nested sub-canvases) are dropped — they're not selectable anyway,
// since the operator couldn't tell what they'd be loading.
export function extractSnapshotHeads(model) {
  const found = [];
  const seen = new Set();

  function looksLikeUuid(v) {
    return typeof v === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  }

  function isRealName(name, uuid) {
    return typeof name === 'string' && name.trim() !== '' && name !== uuid;
  }

  function walk(node, keyHint) {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, keyHint);
      return;
    }
    if (node && typeof node === 'object') {
      // Only treat as a head if it's under a "heads" collection, has a uuid, a widgets
      // array (heads own widgets), and a real name. The name requirement alone excludes
      // the phantoms; the rest keeps us from picking up named non-head objects.
      if (keyHint === 'heads' &&
          looksLikeUuid(node.uuid) &&
          Array.isArray(node.widgets) &&
          isRealName(node.name, node.uuid) &&
          !seen.has(node.uuid)) {
        seen.add(node.uuid);
        found.push({ uuid: node.uuid, name: node.name });
      }
      for (const [k, v] of Object.entries(node)) walk(v, k);
    }
  }

  // model may be { data: "<json string>" } per StorageFilePreview, or already-parsed.
  let root = model;
  if (model && typeof model.data === 'string') {
    try { root = JSON.parse(model.data); } catch { root = model.data; }
  }
  walk(root, null);
  return found;
}

// Extract the widget layout for ONE head inside a snapshot model, normalized for the
// preview renderer. Heads reference widgets by UUID (HeadGet.widgets is a string array),
// while the full widget definitions live elsewhere in the model — so we build a lookup of
// every widget-shaped object, then resolve the target head's referenced widgets.
// Falls back to any widget objects nested directly under the head if references don't
// resolve. Shape is board-specific and undocumented, so this stays tolerant.
export function extractSnapshotHeadWidgets(model, headUuid) {
  function looksLikeUuid(v) {
    return typeof v === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  }
  const isWidgetShape = (n) =>
    n && typeof n === 'object' && looksLikeUuid(n.uuid) && Array.isArray(n.elements);

  let root = model;
  if (model && typeof model.data === 'string') {
    try { root = JSON.parse(model.data); } catch { root = model.data; }
  }

  // Pass 1: find the target head object and collect a global widget lookup.
  let headNode = null;
  const widgetById = new Map();
  (function walk(node, keyHint) {
    if (Array.isArray(node)) { for (const it of node) walk(it, keyHint); return; }
    if (node && typeof node === 'object') {
      if (keyHint === 'heads' && node.uuid === headUuid && Array.isArray(node.widgets)) {
        headNode = node;
      }
      if (isWidgetShape(node)) widgetById.set(node.uuid, node);
      for (const [k, v] of Object.entries(node)) walk(v, k);
    }
  })(root, null);

  if (!headNode) return { widgets: [], resolved: false };

  const refs = headNode.widgets || [];
  let widgets = [];

  if (refs.length && typeof refs[0] === 'string') {
    // Widgets referenced by UUID — resolve against the global lookup.
    widgets = refs.map((id) => widgetById.get(id)).filter(Boolean);
  } else if (refs.length && typeof refs[0] === 'object') {
    // Widgets embedded directly on the head.
    widgets = refs.filter(isWidgetShape);
  }

  return {
    widgets: widgets.map(normalizeWidgetForPreview),
    resolved: widgets.length > 0,
  };
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

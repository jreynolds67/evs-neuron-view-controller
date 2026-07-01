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

// Raw stored model blob for a snapshot. Used to enumerate the heads that exist
// INSIDE the snapshot so we can build the partial head map. Shape is board-specific;
// see extractSnapshotHeads() for the tolerant parser.
export async function getSnapshotModel(ip, uuid) {
  return boardFetch(ip, `/snapshots/${uuid}/model`);
}

// Best-effort extraction of {uuid, name} head entries from a snapshot model blob.
// The API spec does not formally document the model shape, so this walks the object
// looking for anything that looks like a head. If nothing is found, the caller must
// fall back to using the live board heads and refuse the restore rather than guess.
export function extractSnapshotHeads(model) {
  const found = [];
  const seen = new Set();

  function looksLikeUuid(v) {
    return typeof v === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  }

  function pushHead(uuid, name) {
    if (!looksLikeUuid(uuid) || seen.has(uuid)) return;
    seen.add(uuid);
    found.push({ uuid, name: name || uuid });
  }

  function walk(node, keyHint) {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, keyHint);
      return;
    }
    if (node && typeof node === 'object') {
      // A head object typically has a uuid + name + width/height + widgets.
      const isHeadShape =
        looksLikeUuid(node.uuid) &&
        ('widgets' in node || 'width' in node || 'backgroundMode' in node);
      if (isHeadShape && keyHint === 'heads') {
        pushHead(node.uuid, node.name);
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

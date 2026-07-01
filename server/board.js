// server/board.js
// Thin client for a single EVS Neuron View board API (http://<board_ip>/api/v1/...).
// The ONLY restore path exposed here is a partial, per-head restore. A full restore
// cannot be constructed through this module — every restore flag except the partial
// head map is hard-coded to false.

import { log, describeError } from './logger.js';

const API_TIMEOUT_MS = 8000;

function boardBase(ip) {
  return `http://${ip}/api/v1`;
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

// server/index.js
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  loadConfig, saveConfig, getCardById, getPanelByIp,
  getPanelHead, resolveAllowedSnapshots, getHeadFilter,
} from './config.js';
import {
  getSelf, getSnapshotInfo, getSnapshotMeta, getHeads,
  getSnapshotModel, extractSnapshotHeads, restorePartial,
  normalizeSnapshotEntry, getHeadWidgets, normalizeWidgetForPreview,
  extractSnapshotHeadWidgets, getSnapshotModelCached, buildSnapshotWidgetIndex,
  getInputGroups, setWidgetGroup,
} from './board.js';
import { getEntries, clear as clearLog } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const PORT = process.env.PORT || 8080;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(PUBLIC_DIR));

// --- helpers ---------------------------------------------------------------

// Normalise the requesting panel's IP (strip IPv6-mapped prefix).
function clientIp(req) {
  let ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return next(); // token optional; set ADMIN_TOKEN to enable
  if (req.headers['x-admin-token'] === ADMIN_TOKEN) return next();
  return res.status(401).json({ error: 'Admin token required' });
}

function sendErr(res, e) {
  const status = e.status || 502;
  res.status(status).json({ error: e.message, code: e.code || null, detail: e.detail || e.body || null });
}

// --- panel-facing API ------------------------------------------------------

// Authorization helper: does this panel have this exact card+head assigned?
function panelAuthorizesHead(panel, cardId, headUuid) {
  return !!getPanelHead(panel, cardId, headUuid);
}

// Resolve panel + card + assigned head for a panel-facing request, or send an error and
// return null. Every operator endpoint is scoped to a specific assigned head now.
async function resolveHeadRequest(req, res) {
  const config = await loadConfig();
  const panel = getPanelByIp(config, clientIp(req));
  const { cardId, headUuid } = req.params;
  if (!panel || !panelAuthorizesHead(panel, cardId, headUuid)) {
    res.status(403).json({ error: 'Head not permitted for this panel' });
    return null;
  }
  const card = getCardById(config, cardId);
  if (!card) { res.status(404).json({ error: 'Unknown card' }); return null; }
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
    res.status(403).json({ error: 'Card not permitted for this panel' });
    return null;
  }
  const card = getCardById(config, cardId);
  if (!card) { res.status(404).json({ error: 'Unknown card' }); return null; }
  return { config, panel, card };
}

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
  const heads = (panel.heads || [])
    .filter((h) => getCardById(config, h.cardId)) // drop heads whose card was removed
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((h) => ({
      cardId: h.cardId,
      headUuid: h.headUuid,
      label: h.label || h.boardName || 'Head',
    }));
  res.json({
    ip, label: panel.label, layout: panel.layout || '1080', heads,
    showUuids: config.settings?.showUuids !== false,
  });
});

// Snapshots offered for a given card+head, honouring the admin filter.
app.get('/api/panel/cards/:cardId/heads/:headUuid/snapshots', async (req, res) => {
  const r = await resolveHeadRequest(req, res);
  if (!r) return;
  const { config, card, panelHead } = r;

  try {
    const info = await getSnapshotInfo(card.ip);
    const allow = resolveAllowedSnapshots(config, panelHead, req.params.cardId, req.params.headUuid);
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
    const metas = await Promise.all(entries.map(async (e) => {
      if (e.inlineMeta) {
        return {
          uuid: e.uuid,
          name: e.name || e.uuid,
          description: e.description || '',
          timestamp: e.timestamp || 0,
          path: e.path || '',
        };
      }
      try {
        const m = await getSnapshotMeta(card.ip, e.uuid);
        return { uuid: e.uuid, name: m.name || e.uuid, description: m.description || '', timestamp: m.timestamp || 0, path: m.path || '' };
      } catch {
        return { uuid: e.uuid, name: e.uuid, description: '', timestamp: 0, path: '' };
      }
    }));
    // Sort by folder, then name, for a predictable grouped list.
    metas.sort((a, b) =>
      (a.path || '').localeCompare(b.path || '') || (a.name || '').localeCompare(b.name || ''));
    res.json({ state: info.state, snapshots: metas });
  } catch (e) { sendErr(res, e); }
});

// The heads stored inside a snapshot (candidates for the partial mapping source).
app.get('/api/panel/cards/:cardId/snapshots/:snapUuid/heads', async (req, res) => {
  const r = await resolveCardRequest(req, res);
  if (!r) return;
  const { card } = r;
  try {
    const [modelEntry, liveHeads] = await Promise.all([
      getSnapshotModelCached(card.ip, req.params.snapUuid),
      getHeads(card.ip).catch(() => []),
    ]);
    // Extractor already returns only named heads (unnamed entries aren't selectable).
    let heads = extractSnapshotHeads(modelEntry.model);

    // Light backstop: if the snapshot's head UUIDs line up with live board heads, keep
    // the intersection. If they don't line up at all (e.g. an imported snapshot), keep
    // the named extraction as-is rather than emptying the list.
    const liveUuids = new Set((liveHeads || []).map((h) => h.uuid));
    if (liveUuids.size) {
      const byUuid = heads.filter((h) => liveUuids.has(h.uuid));
      if (byUuid.length) heads = byUuid;
    }

    res.json({ heads, parsed: heads.length > 0 });
  } catch (e) { sendErr(res, e); }
});

// Preview: widget layout currently on a LIVE head.
app.get('/api/panel/cards/:cardId/heads/:headUuid/preview', async (req, res) => {
  const r = await resolveHeadRequest(req, res);
  if (!r) return;
  const { card } = r;
  try {
    const widgets = await getHeadWidgets(card.ip, req.params.headUuid);
    res.json({ widgets: (widgets || []).map(normalizeWidgetForPreview) });
  } catch (e) { sendErr(res, e); }
});

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
    const groups = await getInputGroups(card.ip);
    const out = (groups || []).map((g) => ({
      uuid: g.uuid,
      name: g.name || '',
      number: groupNumber(g),
      videoUuid: g.videoUuid || '',
      audioUuid: g.audioUuid || '',
      dataUuid: g.dataUuid || '',
    }));
    res.json({ groups: out });
  } catch (e) { sendErr(res, e); }
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
    res.json({ ok: true, result });
  } catch (e) { sendErr(res, e); }
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
  } catch (e) { sendErr(res, e); }
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
  } catch (e) { sendErr(res, e); }
});

// Fire the partial restore. Body: { snapshotHeadUuid, targetHeadUuid }.
// This is the ONLY restore entrypoint and it is structurally partial-only.
app.post('/api/panel/cards/:cardId/snapshots/:snapUuid/restore', async (req, res) => {
  const config = await loadConfig();
  const panel = getPanelByIp(config, clientIp(req));
  const { snapshotHeadUuid, targetHeadUuid } = req.body || {};
  if (!snapshotHeadUuid || !targetHeadUuid) {
    return res.status(400).json({ error: 'snapshotHeadUuid and targetHeadUuid are required' });
  }
  // Authorize against the exact assigned head being restored onto.
  const panelHead = panel ? getPanelHead(panel, req.params.cardId, targetHeadUuid) : null;
  if (!panelHead) {
    return res.status(403).json({ error: 'Head not permitted for this panel' });
  }
  const card = getCardById(config, req.params.cardId);
  if (!card) return res.status(404).json({ error: 'Unknown card' });

  // Re-check the snapshot is actually permitted for this head before firing.
  const allow = resolveAllowedSnapshots(config, panelHead, req.params.cardId, targetHeadUuid);
  if (allow && !allow.includes(req.params.snapUuid)) {
    return res.status(403).json({ error: 'Snapshot not permitted for this head on this panel' });
  }

  try {
    const result = await restorePartial(card.ip, req.params.snapUuid, [
      { snapshotHeadUuid, targetHeadUuid },
    ]);
    res.json({ ok: true, result });
  } catch (e) { sendErr(res, e); }
});

// --- admin API -------------------------------------------------------------

app.get('/api/admin/config', requireAdmin, async (_req, res) => {
  res.json(await loadConfig());
});

app.put('/api/admin/config', requireAdmin, async (req, res) => {
  const next = req.body;
  if (!next || !Array.isArray(next.cards) || !Array.isArray(next.panels)) {
    return res.status(400).json({ error: 'Config must have cards[] and panels[]' });
  }
  next.settings = { showUuids: true, ...(next.settings || {}) };
  if (!next.headFilters || typeof next.headFilters !== 'object') next.headFilters = {};
  (next.panels || []).forEach((p) => { if (!Array.isArray(p.heads)) p.heads = []; });
  await saveConfig(next);
  // Tell every connected panel to reload so config changes apply immediately.
  broadcastControl({ type: 'reload' });
  res.json({ ok: true });
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
    const metas = await Promise.all(entries.map(async (e) => {
      if (e.inlineMeta) return { uuid: e.uuid, name: e.name || e.uuid };
      try { const m = await getSnapshotMeta(card.ip, e.uuid); return { uuid: e.uuid, name: m.name || e.uuid }; }
      catch { return { uuid: e.uuid, name: e.uuid }; }
    }));
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

// --- WebSocket fan-out ------------------------------------------------------
// Panels connect to our server (ws://<container>/ws?card=<id>). We open one
// upstream connection per distinct board and relay messages to subscribers.
// This keeps board IPs hidden and avoids each panel hammering the board directly.

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const upstream = new Map(); // cardId -> { ws, subscribers:Set }

// Board WebSocket transport. Defaults to wss (boards using HTTPS also secure the WS)
// with self-signed certs accepted, matching the board API client. Override with:
//   BOARD_WS_SCHEME  : "wss" (default) or "ws"
//   BOARD_WS_PORT    : optional explicit port
const WS_SCHEME = (process.env.BOARD_WS_SCHEME || (process.env.BOARD_SCHEME === 'http' ? 'ws' : 'wss')).toLowerCase();
const WS_PORT = process.env.BOARD_WS_PORT || '';
const WS_REJECT_UNAUTHORIZED = String(process.env.BOARD_TLS_REJECT_UNAUTHORIZED || 'false') === 'true';

function boardWsUrl(ip) {
  const suffix = WS_PORT ? `:${WS_PORT}` : '';
  return `${WS_SCHEME}://${ip}${suffix}`;
}

function ensureUpstream(cardId, boardIp) {
  let entry = upstream.get(cardId);
  if (entry && entry.ws && entry.ws.readyState === WebSocket.OPEN) return entry;
  if (!entry) { entry = { ws: null, subscribers: new Set() }; upstream.set(cardId, entry); }

  // For wss to a self-signed board, disable cert rejection for THIS socket only.
  const wsOpts = WS_SCHEME === 'wss' ? { rejectUnauthorized: WS_REJECT_UNAUTHORIZED } : {};
  const ws = new WebSocket(boardWsUrl(boardIp), wsOpts);
  entry.ws = ws;
  ws.on('message', (data) => {
    for (const sub of entry.subscribers) {
      if (sub.readyState === WebSocket.OPEN) sub.send(data.toString());
    }
  });
  ws.on('close', () => { entry.ws = null; });
  ws.on('error', () => { try { ws.close(); } catch {} entry.ws = null; });
  return entry;
}

// Panels open a "control" WS on load (ws?control=1) and hold it for the whole session.
// The server broadcasts small JSON messages down it — currently just { type:'reload' }
// after a config save, so panels refresh without anyone touching them.
const controlClients = new Set();

function broadcastControl(msg) {
  const data = JSON.stringify(msg);
  let sent = 0;
  for (const c of controlClients) {
    if (c.readyState === WebSocket.OPEN) { try { c.send(data); sent++; } catch {} }
  }
  console.log(`[control] broadcast ${JSON.stringify(msg)} to ${sent}/${controlClients.size} client(s)`);
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

wss.on('connection', async (client, req) => {
  const url = new URL(req.url, 'http://localhost');

  // Control channel: every panel joins this on boot. No card, just broadcast target.
  if (url.searchParams.get('control') === '1') {
    client.isAlive = true;
    client.on('pong', () => { client.isAlive = true; });
    controlClients.add(client);
    console.log(`[control] client connected (${controlClients.size} total)`);
    client.on('close', () => {
      controlClients.delete(client);
      console.log(`[control] client disconnected (${controlClients.size} total)`);
    });
    return;
  }

  const cardId = url.searchParams.get('card');
  const config = await loadConfig();
  const card = getCardById(config, cardId);
  if (!card) { client.close(1008, 'Unknown card'); return; }

  const entry = ensureUpstream(cardId, card.ip);
  entry.subscribers.add(client);
  client.on('close', () => {
    entry.subscribers.delete(client);
    if (entry.subscribers.size === 0 && entry.ws) {
      try { entry.ws.close(); } catch {}
    }
  });
});

server.listen(PORT, () => {
  console.log(`Neuron MV Control listening on :${PORT}`);
  console.log(`Config path: ${process.env.CONFIG_PATH || '/data/config.json'}`);
  if (!ADMIN_TOKEN) console.log('ADMIN_TOKEN not set — admin API is open. Set it for production.');
});

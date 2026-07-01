// server/index.js
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  loadConfig, saveConfig, getCardById, getPanelByIp, allowedSnapshotsFor,
} from './config.js';
import {
  getSelf, getSnapshotInfo, getSnapshotMeta, getHeads,
  getSnapshotModel, extractSnapshotHeads, restorePartial,
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

// Who am I? Resolve the calling panel by its source IP and return its config.
app.get('/api/panel/me', async (req, res) => {
  const config = await loadConfig();
  const ip = clientIp(req);
  const panel = getPanelByIp(config, ip);
  if (!panel) {
    return res.status(404).json({ error: 'Panel not registered', ip });
  }
  const cards = (panel.cardIds || [])
    .map((id) => getCardById(config, id))
    .filter(Boolean)
    .map((c) => ({ id: c.id, label: c.label })); // never leak board IPs to the panel
  res.json({ ip, label: panel.label, layout: panel.layout || '1080', cards });
});

// Heads currently live on a card.
app.get('/api/panel/cards/:cardId/heads', async (req, res) => {
  const config = await loadConfig();
  const panel = getPanelByIp(config, clientIp(req));
  if (!panel || !(panel.cardIds || []).includes(req.params.cardId)) {
    return res.status(403).json({ error: 'Card not permitted for this panel' });
  }
  const card = getCardById(config, req.params.cardId);
  if (!card) return res.status(404).json({ error: 'Unknown card' });
  try {
    const heads = await getHeads(card.ip);
    res.json(heads.map((h) => ({ uuid: h.uuid, name: h.name })));
  } catch (e) { sendErr(res, e); }
});

// Snapshots offered for a given card+head, honouring the admin filter.
app.get('/api/panel/cards/:cardId/heads/:headUuid/snapshots', async (req, res) => {
  const config = await loadConfig();
  const panel = getPanelByIp(config, clientIp(req));
  if (!panel || !(panel.cardIds || []).includes(req.params.cardId)) {
    return res.status(403).json({ error: 'Card not permitted for this panel' });
  }
  const card = getCardById(config, req.params.cardId);
  if (!card) return res.status(404).json({ error: 'Unknown card' });

  try {
    const info = await getSnapshotInfo(card.ip);
    const allow = allowedSnapshotsFor(panel, card.id, req.params.headUuid);
    let uuids = info.snapshots || [];
    if (allow) uuids = uuids.filter((u) => allow.includes(u));

    // Enrich with metadata (name/description/timestamp) for a usable touch list.
    const metas = await Promise.all(uuids.map(async (u) => {
      try {
        const m = await getSnapshotMeta(card.ip, u);
        return { uuid: u, name: m.name || u, description: m.description || '', timestamp: m.timestamp || 0 };
      } catch {
        return { uuid: u, name: u, description: '', timestamp: 0 };
      }
    }));
    metas.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    res.json({ state: info.state, snapshots: metas });
  } catch (e) { sendErr(res, e); }
});

// The heads stored inside a snapshot (candidates for the partial mapping source).
app.get('/api/panel/cards/:cardId/snapshots/:snapUuid/heads', async (req, res) => {
  const config = await loadConfig();
  const panel = getPanelByIp(config, clientIp(req));
  if (!panel || !(panel.cardIds || []).includes(req.params.cardId)) {
    return res.status(403).json({ error: 'Card not permitted for this panel' });
  }
  const card = getCardById(config, req.params.cardId);
  if (!card) return res.status(404).json({ error: 'Unknown card' });
  try {
    const model = await getSnapshotModel(card.ip, req.params.snapUuid);
    const heads = extractSnapshotHeads(model);
    res.json({ heads, parsed: heads.length > 0 });
  } catch (e) { sendErr(res, e); }
});

// Fire the partial restore. Body: { snapshotHeadUuid, targetHeadUuid }.
// This is the ONLY restore entrypoint and it is structurally partial-only.
app.post('/api/panel/cards/:cardId/snapshots/:snapUuid/restore', async (req, res) => {
  const config = await loadConfig();
  const panel = getPanelByIp(config, clientIp(req));
  if (!panel || !(panel.cardIds || []).includes(req.params.cardId)) {
    return res.status(403).json({ error: 'Card not permitted for this panel' });
  }
  const card = getCardById(config, req.params.cardId);
  if (!card) return res.status(404).json({ error: 'Unknown card' });

  const { snapshotHeadUuid, targetHeadUuid } = req.body || {};
  if (!snapshotHeadUuid || !targetHeadUuid) {
    return res.status(400).json({ error: 'snapshotHeadUuid and targetHeadUuid are required' });
  }

  // Re-check the snapshot is actually permitted for this panel+head before firing.
  const allow = allowedSnapshotsFor(panel, card.id, targetHeadUuid);
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
  await saveConfig(next);
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
    const metas = await Promise.all((info.snapshots || []).map(async (u) => {
      try { const m = await getSnapshotMeta(card.ip, u); return { uuid: u, name: m.name || u }; }
      catch { return { uuid: u, name: u }; }
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

function ensureUpstream(cardId, boardIp) {
  let entry = upstream.get(cardId);
  if (entry && entry.ws && entry.ws.readyState === WebSocket.OPEN) return entry;
  if (!entry) { entry = { ws: null, subscribers: new Set() }; upstream.set(cardId, entry); }

  const ws = new WebSocket(`ws://${boardIp}`);
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

wss.on('connection', async (client, req) => {
  const url = new URL(req.url, 'http://localhost');
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

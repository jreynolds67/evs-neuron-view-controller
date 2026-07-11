// server/config.js
// Persists admin configuration to a JSON file on a mounted Docker volume.
// No database. Reads are cached in memory; writes are atomic (temp file + rename).

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

const CONFIG_PATH = process.env.CONFIG_PATH || '/data/config.json';

// Shape of config:
// {
//   cards: [                       // the 12 MV cards
//     { id: "mv1", label: "MV Card 1", ip: "10.10.60.21" }, ...
//   ],
//   panels: [                      // router touch panels, keyed by their fixed IP
//     {
//       ip: "10.10.61.11",
//       label: "PCR 101 Panel",
//       layout: "1080" | "strip",  // 1920x1080 or 1835x291
//       cardIds: ["mv1","mv2","mv3"],
//       // Optional per-head snapshot filter. If a (cardId, headUuid) key is present,
//       // ONLY the listed snapshot UUIDs are offered for that head. Absent = allow all.
//       snapshotFilters: { "mv1::<headUuid>": ["<snapUuid>", ...] }
//     }
//   ]
// }

// Return a FRESH default config each time. A shared object literal would let a later
// mutation of cache.cards/headFilters (on the empty/failed-load path) poison the defaults
// for subsequent loads, so every caller gets its own arrays/objects.
function defaultConfig() {
  return { cards: [], panels: [], headFilters: {}, settings: { showUuids: true } };
}

let cache = null;

async function ensureDir() {
  const dir = dirname(CONFIG_PATH);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
}

export async function loadConfig() {
  if (cache) return cache;
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const base = defaultConfig();
    cache = {
      ...base,
      ...parsed,
      headFilters: parsed.headFilters || {},
      settings: { ...base.settings, ...(parsed.settings || {}) },
    };
    (cache.panels || []).forEach(migratePanel);
    // Discard obsolete per-panel snapshot filters — filtering is global per head now.
    (cache.panels || []).forEach((p) => (p.heads || []).forEach((h) => { delete h.allowedSnapshots; }));
  } catch {
    cache = defaultConfig();
  }
  return cache;
}

export async function saveConfig(next) {
  await ensureDir();
  const tmp = `${CONFIG_PATH}.tmp`;
  const data = JSON.stringify(next, null, 2);
  await writeFile(tmp, data, 'utf8');
  await rename(tmp, CONFIG_PATH);
  cache = next;
  return cache;
}

export function getCardById(config, id) {
  return (config.cards || []).find((c) => c.id === id) || null;
}

export function getPanelByIp(config, ip) {
  return (config.panels || []).find((p) => p.ip === ip) || null;
}

// Panels now assign specific heads directly: panel.heads = [{ cardId, headUuid, label,
// order, allowedSnapshots }]. Older configs used panel.cardIds + panel.snapshotFilters
// keyed by "cardId::headUuid". migratePanel() upgrades the old shape on the fly so
// existing config files keep working — the old fields are preserved but the app reads
// panel.heads. Note: the old model couldn't know a card's individual heads without
// probing the board, so a migrated panel starts with NO heads assigned for its cards and
// the admin re-adds them; any old snapshotFilters are carried into a lookup so they can
// be reattached if the same card::head is re-added.
export function migratePanel(panel) {
  if (Array.isArray(panel.heads)) return panel; // already new shape
  const heads = [];
  // We cannot expand cardIds into heads here (no board access), so leave heads empty and
  // keep legacy fields available for the admin UI to offer a one-click re-assign.
  panel.heads = heads;
  return panel;
}

export function getPanelHead(panel, cardId, headUuid) {
  if (!panel || !Array.isArray(panel.heads)) return null;
  return panel.heads.find((h) => h.cardId === cardId && h.headUuid === headUuid) || null;
}

// Snapshot filtering is GLOBAL per head, keyed by "cardId::headUuid" in config.headFilters.
// (Operators can still temporarily see everything on a panel via the per-panel "Show all"
// override, which is applied at request time — not stored per head.)
//
// Resolution: returns the allowed snapshot UUID list, or null = allow all (no filter defined).
export function resolveAllowedSnapshots(config, panelHead, cardId, headUuid) {
  const filters = config.headFilters || {};
  const list = filters[`${cardId}::${headUuid}`];
  return Array.isArray(list) && list.length ? list : null;
}

// Read/write the global per-head filter list.
export function getHeadFilter(config, cardId, headUuid) {
  const list = (config.headFilters || {})[`${cardId}::${headUuid}`];
  return Array.isArray(list) ? list : null;
}

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

const DEFAULT_CONFIG = { cards: [], panels: [], settings: { showUuids: true } };

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
    cache = {
      ...DEFAULT_CONFIG,
      ...parsed,
      settings: { ...DEFAULT_CONFIG.settings, ...(parsed.settings || {}) },
    };
    (cache.panels || []).forEach(migratePanel);
  } catch {
    cache = { ...DEFAULT_CONFIG, settings: { ...DEFAULT_CONFIG.settings } };
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

// Allowed snapshot UUID list for an assigned head, or null = allow all.
export function allowedSnapshotsForHead(panelHead) {
  if (!panelHead) return null;
  const list = panelHead.allowedSnapshots;
  return Array.isArray(list) && list.length ? list : null;
}

// Legacy support: old per-(card,head) filter lookup, used only during migration display.
export function allowedSnapshotsFor(panel, cardId, headUuid) {
  if (!panel || !panel.snapshotFilters) return null;
  const key = `${cardId}::${headUuid}`;
  const list = panel.snapshotFilters[key];
  return Array.isArray(list) ? list : null;
}

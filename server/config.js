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

// Whether the config in memory actually came from a real file (or a save), rather than the
// EMPTY fallback loadConfig() substitutes when the file is missing or unreadable. loadConfig()
// deliberately never throws — booting with no panels beats not booting — but that means an
// empty config is ambiguous: it can mean "nothing is configured" OR "we couldn't read it".
// Any caller about to DESTROY data on the basis of what's in the config must tell those apart.
let configAuthoritative = false;
export function isConfigAuthoritative() { return configAuthoritative; }

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
    configAuthoritative = true;
  } catch (e) {
    // A missing file is normal on first boot. ANY other failure (malformed JSON, bad
    // permissions) means we're about to boot with an EMPTY config — every panel suddenly
    // "unregistered" and admin login dead. That must never be silent: without a log line,
    // the symptom points nowhere near the cause.
    if (e && e.code === 'ENOENT') {
      console.log(`Config file not found at ${CONFIG_PATH} — starting with defaults.`);
    } else {
      console.error(`[config] FAILED TO LOAD ${CONFIG_PATH}: ${e && e.message}`);
      console.error('[config] Starting with an EMPTY default config — all panels will be '
        + 'unregistered and admin login will be unavailable until this file is valid.');
    }
    // ENOENT included: a missing file is normal on first boot, but it still means we do not
    // KNOW what's configured — and on first boot there is nothing to destroy anyway, so there
    // is no cost to treating every non-load the same way.
    configAuthoritative = false;
    cache = defaultConfig();
  }
  return cache;
}

export async function saveConfig(next) {
  await ensureDir();
  // Optimistic-concurrency token, owned here so EVERY write bumps it — including the targeted
  // backup/shareSweep writes, not just the main config PUT. The admin page holds one whole
  // config object and PUTs all of it, so without this two windows open at once are
  // last-write-wins: the second Save silently reverts everything the first changed, with no
  // sign to either. The config PUT compares the client's token against this and refuses a
  // stale save. Legacy configs have no token (undefined -> 0), so the first save stamps 1.
  next.configVersion = (Number(cache && cache.configVersion) || 0) + 1;
  const tmp = `${CONFIG_PATH}.tmp`;
  const data = JSON.stringify(next, null, 2);
  await writeFile(tmp, data, 'utf8');
  await rename(tmp, CONFIG_PATH);
  cache = next;
  configAuthoritative = true; // a saved config is by definition the real one
  return cache;
}

export function getCardById(config, id) {
  return (config.cards || []).find((c) => c.id === id) || null;
}

export function getPanelByIp(config, ip) {
  return (config.panels || []).find((p) => p.ip === ip) || null;
}

// Panels now assign specific heads directly: panel.heads = [{ cardId, headUuid, label, order }].
// Older configs used panel.cardIds + panel.snapshotFilters keyed by "cardId::headUuid".
// migratePanel() upgrades the old shape on the fly so existing config files keep loading.
//
// The migration cannot expand cardIds into heads — that needs the card's live head list, which
// means board access this module doesn't have. So a migrated panel starts with NO heads and the
// admin re-adds them ("Add all heads" does it in one click). Any old snapshotFilters are simply
// left on the object, unread: head filtering is global per head now (config.headFilters), so
// there is nothing to reattach them to.
export function migratePanel(panel) {
  if (Array.isArray(panel.heads)) return panel; // already new shape
  panel.heads = [];
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

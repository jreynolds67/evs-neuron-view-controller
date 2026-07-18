// server/solostore.js
// Persisted record of which heads are currently "soloed" (one window blown up to fullscreen)
// and the full widget layout captured before the solo, so any panel can restore the mosaic —
// and a container restart can't strand an on-air head with a single fullscreen window.
//
// Shape on disk (/data/solo-state.json):
//   { "<cardId>::<headUuid>": { targetUuid, widgets: [<full WidgetGet>...], at } }
//
// Kept small: written only on solo/unsolo (operator actions), never on the hot poll path.

import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeAtomic, makeWriteChain } from './util.js';

const SOLO_PATH = process.env.SOLO_STATE_PATH || '/data/solo-state.json';

let store = {};        // key -> capture
let loaded = false;

function key(cardId, headUuid) { return `${cardId}::${headUuid}`; }

// Load once at startup. A missing file is normal (nothing soloed). A malformed file is logged
// and treated as empty rather than crashing the app.
export async function loadSoloStore() {
  if (loaded) return;
  try {
    const raw = await readFile(SOLO_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    store = (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (e) {
    if (e && e.code !== 'ENOENT') {
      console.error(`[solo] failed to load ${SOLO_PATH}: ${e.message} — starting with no soloed heads.`);
    }
    store = {};
  }
  loaded = true;
}

// Serialise writes: two panels soloing/un-soloing different heads at the same moment run two
// concurrent persist() calls against ONE shared temp path, and interleaved renames can move a
// half-written file into place. Chaining them fixes that; each chained write snapshots the
// then-current `store`, so the last write in the chain always lands with every mutation.
const enqueuePersist = makeWriteChain();

function persist() {
  return enqueuePersist(async () => {
    const dir = dirname(SOLO_PATH);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    await writeAtomic(SOLO_PATH, JSON.stringify(store, null, 2));
  });
}

// Sync read — safe on the poll path because the store is fully loaded at boot.
export function isSoloed(cardId, headUuid) {
  return !!store[key(cardId, headUuid)];
}

export function getSolo(cardId, headUuid) {
  return store[key(cardId, headUuid)] || null;
}

export async function setSolo(cardId, headUuid, capture) {
  store[key(cardId, headUuid)] = capture;
  await persist();
}

export async function clearSolo(cardId, headUuid) {
  if (store[key(cardId, headUuid)]) {
    delete store[key(cardId, headUuid)];
    await persist();
  }
}

// Drop captures whose head is no longer assigned to any panel (or whose card was removed).
// Un-solo is only reachable from a panel the head is assigned to, so such a capture can never
// be restored — it would sit on the volume forever. Called at boot and after every config save.
// Takes the set of still-valid "<cardId>::<headUuid>" keys rather than the config itself, so
// this module stays free of a config.js import. Returns how many were dropped.
export async function pruneSolo(validKeys) {
  const dead = Object.keys(store).filter((k) => !validKeys.has(k));
  if (!dead.length) return 0;
  for (const k of dead) delete store[k];
  await persist();
  console.log(`[solo] pruned ${dead.length} capture(s) whose head is no longer assigned: ${dead.join(', ')}`);
  return dead.length;
}

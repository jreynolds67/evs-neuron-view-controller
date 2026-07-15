// server/sharesweep.js
// Periodically checks target boards and sets `shared: true` on any snapshot that isn't
// already shared, so newly-created snapshots propagate across boards automatically.
//
// Fully controlled from the admin UI via config.shareSweep:
//   { enabled, intervalSec, targets: [ "mv1", "10.10.60.24", ... ] }
// A target is either a defined card id or a raw board IP. Empty targets = all cards.

import { getSnapshotInfo, normalizeSnapshotEntry, setSnapshotShared, triggerStorageSync } from './board.js';
import { loadConfig, getCardById } from './config.js';

let running = false;
let timer = null;
let currentIntervalSec = null;

// After a sweep shares anything new, we kick the boards' native sync so the freshly-shared
// snapshots propagate now rather than waiting for the next scheduled board sync (the boards are
// run at a long native interval to cut "waiting for sync" noise during recalls). The triggers
// are staggered by this gap so we don't hit every board in the same instant.
const SYNC_TRIGGER_STAGGER_MS = 1000;
// Wait this long after the sweep finishes sharing before firing any sync triggers, so the
// boards have settled from the metadata writes (each PUT is async and leaves a board in
// 'updating-file') before we ask them to sync.
const SYNC_TRIGGER_DELAY_MS = 6000;
const status = { lastRun: null, lastError: null, shared: 0, checked: 0, enabled: false, targets: [] };

function resolveTargets(config) {
  const cfg = config.shareSweep || {};
  const list = Array.isArray(cfg.targets) ? cfg.targets : [];
  if (!list.length) {
    return (config.cards || []).filter((c) => c.ip).map((c) => ({ label: c.label || c.id, ip: c.ip }));
  }
  return list.map((t) => {
    const card = getCardById(config, t);
    if (card && card.ip) return { label: card.label || card.id, ip: card.ip };
    return { label: t, ip: t };
  }).filter((x) => x.ip);
}

async function sweepOnce() {
  if (running) return;
  running = true;
  let shared = 0, checked = 0;
  try {
    const config = await loadConfig();
    const targets = resolveTargets(config);
    status.targets = targets.map((t) => t.label);
    for (const t of targets) {
      let info;
      try { info = await getSnapshotInfo(t.ip); } catch { continue; }
      const entries = (info.snapshots || [])
        .map(normalizeSnapshotEntry)
        // Skip read-only snapshots: 1.13 marks some snapshots readOnly, and a metadata PUT
        // against one will just be rejected — retrying it every cycle forever is pointless
        // load on a storage layer we know is fragile.
        .filter((e) => e.uuid && e.deleted !== true && e.readOnly !== true);
      for (const e of entries) {
        checked++;
        if (e.shared === true) continue;
        try { await setSnapshotShared(t.ip, e, true); shared++; } catch {}
        // Pace the writes. On 1.13 the metadata PUT is async (202) and puts the board into
        // 'updating-file'; firing them back-to-back stacks writes onto a board still
        // processing the previous one. A small gap costs nothing (this is a background
        // sweep) and keeps load off the storage layer.
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    status.lastRun = Date.now();
    status.lastError = null;
    status.shared = shared;
    status.checked = checked;
    if (shared) console.log(`[share-sweep] shared ${shared} snapshot(s) across ${targets.length} target(s)`);

    // Newly shared something → trigger a native sync on EVERY target so the change propagates
    // promptly instead of waiting out the board's (now longer) native sync interval. Staggered
    // ~2s apart for load management; a failure/unreachable board is non-fatal (next sweep, or
    // the board's own schedule, will catch up). Each trigger is logged by boardFetch.
    if (shared > 0) {
      // Let the boards settle from the metadata writes before triggering sync.
      await new Promise((r) => setTimeout(r, SYNC_TRIGGER_DELAY_MS));
      for (let i = 0; i < targets.length; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, SYNC_TRIGGER_STAGGER_MS));
        try { await triggerStorageSync(targets[i].ip); } catch {}
      }
      console.log(`[share-sweep] triggered native sync on ${targets.length} board(s) after sharing`);
    }
  } catch (e) {
    status.lastError = e.message;
  } finally {
    running = false;
  }
}

export async function applyShareSweepConfig() {
  const config = await loadConfig();
  const cfg = config.shareSweep || {};
  status.enabled = !!cfg.enabled;
  const intervalSec = Math.max(10, parseInt(cfg.intervalSec, 10) || 60);

  if (timer && currentIntervalSec !== intervalSec) { clearInterval(timer); timer = null; }
  if (cfg.enabled && !timer) {
    currentIntervalSec = intervalSec;
    timer = setInterval(sweepOnce, intervalSec * 1000);
    timer.unref?.();
    sweepOnce();
    console.log(`[share-sweep] enabled, every ${intervalSec}s`);
  } else if (!cfg.enabled && timer) {
    clearInterval(timer); timer = null; currentIntervalSec = null;
    console.log('[share-sweep] disabled');
  }
}

export function startShareSweep() {
  applyShareSweepConfig();
}

export function shareSweepStatus() {
  return { ...status };
}

export async function runShareSweepNow() {
  await sweepOnce();
  return shareSweepStatus();
}

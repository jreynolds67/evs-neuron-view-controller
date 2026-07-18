// server/backup.js
// Scheduled daily backup of a target board. Exports the board's snapshots to a dated file
// (or per-folder files if the board won't do a single whole-board export) stored on the
// volume, and prunes anything older than the retention window.
//
// Config lives in the main config file under config.backup:
//   { enabled, cardId, timeHHMM: "03:00", retentionCount: 30 }
// (Legacy field names — retentionDays, configRetentionDays, target — are migrated on load by
// config.js, so this module only ever sees the current names.)
//
// Retention is a single COUNT — see prune(): board archives and config snapshots each keep
// their own N most-recent dates, so a long board outage can't age out good board backups.
//
// Files are written to BACKUP_DIR (default /data/backups) as:
//   <stamp>__<cardLabel>__all<ext>          whole-board archive (ext from the board)
//   <stamp>__<cardLabel>__<folder><ext>     per-folder fallback when the whole-board export fails
//   <stamp>__<cardLabel>__individual.zip    per-snapshot bundle
//   <stamp>__config.json                    this app's config, minus the admin credential

import { readdir, mkdir, unlink, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getSnapshotInfo, normalizeSnapshotEntry, exportSnapshots } from './board.js';
import { loadConfig, getCardById } from './config.js';
import { buildZip } from './zip.js';
import { writeAtomic } from './util.js';

const BACKUP_DIR = process.env.BACKUP_DIR || '/data/backups';

let timer = null;
let backupRunning = false; // guards against concurrent runs (manual during scheduled, etc.)
const status = {
  lastRun: null, lastError: null, lastFiles: [], nextCheck: null,
  // Label of the card the last run targeted (or the raw IP if the target wasn't a defined
  // card). Lets error reporting name the card by label instead of leaking its board IP.
  lastTargetLabel: null,
  // Filename stamp of the run in progress (YYYY-MM-DD_HH-MM-SS) — the same key listBackups()
  // reports as runKey. A run writes its files one at a time over several minutes, so the UI
  // needs to know which listed run is still being written and must not be shown as complete.
  runKey: null,
  // Set ONLY by the scheduler (not manual runs) when a scheduled backup fails to produce a
  // board archive. Drives the persistent banner on operator panels. Shape:
  //   { at: <ms>, reason: 'export' | 'empty' | 'target' | 'error', message: <string>,
  //     cardLabel: <string|null> }
  // Cleared to null when a scheduled run produces a board archive.
  scheduledFailure: null,
};

async function ensureDir() {
  if (!existsSync(BACKUP_DIR)) await mkdir(BACKUP_DIR, { recursive: true });
}

// Remove leftover *.tmp files from a backup interrupted mid-write (writeAtomic writes to a
// .tmp then renames). The prune step skips them, so without this they accumulate forever.
async function sweepTmp() {
  try {
    if (!existsSync(BACKUP_DIR)) return;
    const files = await readdir(BACKUP_DIR);
    for (const f of files) {
      if (f.endsWith('.tmp')) {
        try { await unlink(join(BACKUP_DIR, f)); console.log(`[backup] swept stale temp file ${f}`); } catch {}
      }
    }
  } catch {}
}

// "HH:MM" -> minutes-of-day, or null if it isn't a real 24-hour time. Exported so the admin
// endpoints validate with the SAME rule the scheduler fires on. A shape-only check (/^\d{2}:\d{2}$/)
// isn't enough: "29:99" passes it, stores fine, and then the scheduler can never match it — a
// backup that silently never runs.
export function hhmmToMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

function safe(s) {
  return String(s || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'x';
}
function todayStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
// Filename stamp includes time so multiple backups in a day are distinct and sortable:
// YYYY-MM-DD_HH-MM-SS
function fileStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

// Perform one backup of the configured card. Tries a single whole-board export first;
// if that fails, falls back to one file per distinct folder path found on the board.
// Guarded entry point. Prevents two backup runs (e.g. a manual "Run now" landing during the
// scheduled run) from firing concurrent full-board export loops against the same card — a
// real risk given the boards' storage layer can misbehave under load. A second call while
// one is running is rejected with a clear status rather than piling on.
export async function runBackupNow() {
  if (backupRunning) {
    console.log('[backup] run requested but one is already in progress — skipped');
    // `skipped` tells the caller nothing ran — everything else in this object describes the
    // PREVIOUS run. The scheduler must check it: classifying yesterday's lastFiles/lastError
    // as today's outcome would clear (or set) the operator banner for a run that never happened.
    return { ...status, skipped: true, lastError: 'A backup is already running; this request was skipped.' };
  }
  backupRunning = true;
  try {
    return await runBackupInternal();
  } finally {
    backupRunning = false;
    status.runKey = null; // run is over: its files are final, whatever it managed to write
  }
}

async function runBackupInternal() {
  await ensureDir();
  // Reset the per-run fields up front. Without this, a run whose failures are all swallowed
  // (whole-board export threw, every per-folder fallback threw) falls through to the
  // "if (!status.lastError)" default below still holding the PREVIOUS run's message — and the
  // scheduler then classifies this run's banner from last time's error text.
  status.lastError = null;
  status.lastFiles = [];
  status.lastTargetLabel = null;
  const config = await loadConfig();
  const date = fileStamp();
  status.runKey = date; // marks this run in-progress for the UI until runBackupNow() clears it
  const written = [];

  // Write a dated copy of the app config FIRST, before any board contact or early exit.
  // This is purely local and can't fail for board reasons, so it must not be gated behind a
  // reachable board / non-empty snapshot list — on exactly the nights the board is down, a
  // config restore point is the one thing we can still preserve. The admin password hash is
  // stripped, since a backup file is precisely the thing that gets copied elsewhere.
  try {
    const { admin, ...safeConfig } = config;
    const cfgBuf = Buffer.from(JSON.stringify(safeConfig, null, 2), 'utf8');
    const cfgFile = `${date}__config.json`;
    await writeAtomic(join(BACKUP_DIR, cfgFile), cfgBuf);
    written.push({ file: cfgFile, bytes: cfgBuf.length });
  } catch (e) {
    console.log(`[backup] config copy step failed: ${e.message}`);
  }

  const bcfg = config.backup || {};
  const sel = bcfg.cardId || '';
  let ip = null, label = null;
  const card = getCardById(config, sel);
  if (card && card.ip) { ip = card.ip; label = card.label || card.id; }
  else if (sel && /\d+\.\d+\.\d+\.\d+/.test(sel)) { ip = sel; label = sel; }
  if (!ip) {
    status.lastError = 'No valid backup target configured';
    status.lastRun = Date.now();
    status.lastFiles = written.slice();
    return status;
  }
  // Capture the display form BEFORE filename-sanitising: this is what error reporting and the
  // operator banner show, so "MV Card 3" must stay "MV Card 3", not become "MV_Card_3".
  status.lastTargetLabel = label;
  label = safe(label);

  // Detect an export response that's actually JSON (error/manifest) rather than a real
  // snapshot archive, so we don't save a tiny bogus file and call it a backup.
  function looksLikeJson(buf) {
    const head = buf.slice(0, 1).toString('latin1');
    return head === '{' || head === '[';
  }
  // Pick a file extension from the board's Content-Disposition, if any.
  function extFromDisposition(buf) {
    const cd = buf.__cdisp || '';
    const m = cd.match(/filename="?([^"]+)"?/i);
    if (m) {
      const dot = m[1].lastIndexOf('.');
      if (dot > 0) return m[1].slice(dot); // includes leading dot
    }
    return ''; // unknown — leave extensionless rather than fake .bin
  }

  try {
    // Enumerate all live snapshots once; the export needs explicit UUIDs (an empty list
    // makes some firmware return an empty/manifest file — the 1.6 KB symptom).
    const info = await getSnapshotInfo(ip);
    const entries = (info.snapshots || [])
      .map(normalizeSnapshotEntry)
      .filter((e) => e.uuid && e.deleted !== true);
    const allUuids = entries.map((e) => e.uuid);

    if (!allUuids.length) {
      status.lastRun = Date.now();
      status.lastError = 'No snapshots on the board to back up';
      status.lastFiles = written.slice(); // config copy was already written above
      return status;
    }

    // Attempt 1: whole board as a single file, by explicit UUID list (no wildcard —
    // the board rejects sending both).
    let ok = false;
    let vmisExt = '.vmis';
    try {
      const buf = await exportSnapshots(ip, { snapshots: allUuids });
      if (buf && buf.length && !looksLikeJson(buf)) {
        vmisExt = extFromDisposition(buf) || '.vmis';
        const file = `${date}__${label}__all${vmisExt}`;
        await writeAtomic(join(BACKUP_DIR, file), buf);
        written.push({ file, bytes: buf.length });
        ok = true;
      } else if (buf && looksLikeJson(buf)) {
        // Surface what the board actually said instead of silently saving it.
        status.lastError = `Export returned JSON, not a file: ${buf.slice(0, 200).toString('utf8')}`;
      }
    } catch (e) {
      // fall through to per-folder
    }

    // Also build a ZIP of INDIVIDUAL snapshot files, so specific ones can be re-imported
    // without restoring the whole board. Each snapshot is exported on its own and added to
    // the archive named by its snapshot name (deduplicated) with the board's extension.
    if (ok) {
      try {
        const zipEntries = [];
        const usedNames = new Set();
        for (const e of entries) {
          let buf;
          try { buf = await exportSnapshots(ip, { snapshots: [e.uuid] }); }
          catch { continue; }
          if (!buf || !buf.length || looksLikeJson(buf)) continue;
          const ext = extFromDisposition(buf) || vmisExt;
          // Build a unique, filesystem-safe name inside the zip: "<folder> - <name>".
          const base = safe(`${e.path ? e.path + ' - ' : ''}${e.name || e.uuid}`);
          let name = `${base}${ext}`;
          let n = 2;
          while (usedNames.has(name)) { name = `${base} (${n++})${ext}`; }
          usedNames.add(name);
          zipEntries.push({ name, data: buf });
        }
        if (zipEntries.length) {
          const zipBuf = buildZip(zipEntries);
          const zipFile = `${date}__${label}__individual.zip`;
          await writeAtomic(join(BACKUP_DIR, zipFile), zipBuf);
          written.push({ file: zipFile, bytes: zipBuf.length });
          console.log(`[backup] bundled ${zipEntries.length} individual snapshot(s) into ${zipFile}`);
        }
      } catch (e) {
        console.log(`[backup] individual-zip step failed: ${e.message}`);
      }
    }

    // Attempt 2 (fallback): per-folder exports, each by that folder's explicit UUID list.
    if (!ok) {
      const folders = [...new Set(entries.map((e) => e.path || ''))];
      for (const folder of folders) {
        const uuids = entries.filter((e) => (e.path || '') === folder).map((e) => e.uuid);
        if (!uuids.length) continue;
        try {
          const buf = await exportSnapshots(ip, { snapshots: uuids });
          if (buf && buf.length && !looksLikeJson(buf)) {
            const file = `${date}__${label}__${safe(folder || 'root')}${extFromDisposition(buf)}`;
            await writeAtomic(join(BACKUP_DIR, file), buf);
            written.push({ file, bytes: buf.length });
          }
        } catch {
          // skip this folder
        }
      }
    }

    // Only a BOARD archive means the backup worked. The config copy at the top of this run is
    // written unconditionally — even with the board unreachable — so `written` is never empty
    // and must not be what clears the error, or every failed export reports a clean run and
    // discards the reason captured above (the JSON-instead-of-archive message in particular).
    const boardFileWritten = written.some((f) => !f.file.endsWith('__config.json'));

    status.lastRun = Date.now();
    if (boardFileWritten) status.lastError = null;
    else if (!status.lastError) status.lastError = 'Export produced no valid files';
    status.lastFiles = written;
    console.log(`[backup] ${label} ${date}: wrote ${written.length} file(s)`);

    // Retention is gated on a SUCCESSFUL board backup today. Otherwise a board that stays
    // down for longer than the retention window would age out every good board archive one
    // by one until nothing is left — deleting the last valid backup while the board is still
    // offline. So only prune when we actually produced a new board archive this run; the
    // config copy alone does not count. (Config files are pruned as part of the same sweep,
    // which is fine — they're only removed once there's a fresh successful run to age against.)
    if (boardFileWritten) {
      try { await prune(config); } catch (e) { console.log(`[backup] prune failed: ${e.message}`); }
    } else {
      console.log('[backup] skipping retention prune — no valid board backup produced this run');
    }
  } catch (e) {
    // Board-layer errors embed the board IP ("fetch failed (...) for 10.x.x.x/snapshots").
    // This message flows to the scheduled-failure record and out to operator panels, where
    // board IPs are deliberately never shown — name the card by its label instead. (When the
    // target was configured as a raw IP, label IS the IP and this is a no-op; the panel
    // endpoint separately refuses to forward an IP-shaped label.)
    status.lastError = ip
      ? String(e.message || e).split(ip).join(status.lastTargetLabel || label)
      : (e.message || String(e));
    status.lastRun = Date.now();
    // The board part failed, but the config copy at the top succeeded — record it so the
    // run still shows a restore point rather than looking like it produced nothing.
    status.lastFiles = written.slice();
  }
  return status;
}

// A backup file is recognised by its date-prefix name (YYYY-MM-DD, optionally with a
// _HH-MM-SS time), regardless of extension — the board may hand back various file types.
const BACKUP_RE = /^\d{4}-\d{2}-\d{2}(_\d{2}-\d{2}-\d{2})?__.+/;
function isBackupFile(f) { return BACKUP_RE.test(f) && !f.endsWith('.tmp'); }

// Classify a backup filename into a kind and two different grouping keys.
//   kind: 'config'  -> <stamp>__config.json           (app config snapshot)
//         'zip'     -> <stamp>__<label>__individual.zip (per-snapshot bundle)
//         'board'   -> everything else (the full-board archive, incl. per-folder fallbacks)
//
// The two keys are deliberately NOT the same thing:
//   dateKey (YYYY-MM-DD)           — groups a whole DAY. Retention keeps the N most recent
//                                    DATES, so this must stay date-only.
//   runKey  (YYYY-MM-DD_HH-MM-SS)  — identifies ONE run. Filenames carry a time (fileStamp)
//                                    precisely so several backups a day stay distinct, so
//                                    anything presenting files per-run must key on this.
//                                    Grouping the UI by dateKey merged same-day runs into one
//                                    row that could only address one file per kind — leaving
//                                    the newest with no Delete button at all.
// Legacy files with no time component fall back to the date for both.
function classifyBackup(f) {
  const m = f.match(/^(\d{4}-\d{2}-\d{2})(_\d{2}-\d{2}-\d{2})?/);
  const dateKey = m ? m[1] : '';
  const runKey = m ? `${m[1]}${m[2] || ''}` : '';
  let kind = 'board';
  if (f.endsWith('__config.json')) kind = 'config';
  else if (f.endsWith('__individual.zip')) kind = 'zip';
  return { kind, dateKey, runKey };
}

// Retention is a single COUNT (`retentionCount`), applied to board archives and config
// snapshots on their OWN dates:
//   * Board backups (full archive + its snapshot zip) — the N most recent DATES that produced
//     a real board archive. Age is irrelevant, so a long board outage can't age out good
//     backups: after recovery you still have N real ones.
//   * Config snapshots — the N most recent DATES that produced a config snapshot. These are
//     tiny and written every run (even board-down nights, when no board archive is made), so
//     they keep their OWN date set rather than being tied to the board archives' dates — a
//     board-down night's config restore point survives as long as it's within the N most
//     recent config dates.
// (prune() only runs after a SUCCESSFUL board backup — see the runner — so neither set is
// ever thinned while the board is down.)
async function prune(config) {
  const keep = (config.backup && config.backup.retentionCount) || 30;

  let files;
  try { files = await readdir(BACKUP_DIR); } catch { return; }
  const backups = files.filter(isBackupFile);

  // Collect the dates present for each kind, then keep the N most recent of each.
  const boardDates = new Set();
  const configDates = new Set();
  for (const f of backups) {
    const { kind, dateKey } = classifyBackup(f);
    if (!dateKey) continue;
    if (kind === 'config') configDates.add(dateKey);
    else boardDates.add(dateKey); // board or zip
  }
  const mostRecent = (set) => new Set([...set].sort().reverse().slice(0, keep));
  const keptBoardDates = mostRecent(boardDates);
  const keptConfigDates = mostRecent(configDates);

  for (const f of backups) {
    const { kind, dateKey } = classifyBackup(f);
    if (!dateKey) continue;
    const kept = kind === 'config' ? keptConfigDates : keptBoardDates;
    if (kept.has(dateKey)) continue;
    try {
      await unlink(join(BACKUP_DIR, f));
      console.log(`[backup] pruned (retention count) ${f}`);
    } catch {}
  }
}

export async function listBackups() {
  await ensureDir();
  let files;
  try { files = await readdir(BACKUP_DIR); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!isBackupFile(f)) continue;
    try {
      const s = await stat(join(BACKUP_DIR, f));
      const { kind, dateKey, runKey } = classifyBackup(f);
      out.push({ file: f, bytes: s.size, mtime: s.mtimeMs, kind, dateKey, runKey });
    } catch {}
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

export function backupFilePath(file) {
  // Guard against path traversal — allow only safe chars and require the backup name shape.
  if (!/^[a-zA-Z0-9._-]+$/.test(file) || !isBackupFile(file)) return null;
  return join(BACKUP_DIR, file);
}

// Scheduler: checks every minute whether the configured HH:MM has arrived today and the
// backup hasn't run yet today.
let lastRunDate = null;
export function startBackupScheduler() {
  sweepTmp(); // clear any temp files left by a backup interrupted mid-write
  const tick = async () => {
    status.nextCheck = Date.now();
    const config = await loadConfig();
    const bcfg = config.backup || {};
    if (!bcfg.enabled || !bcfg.cardId || !bcfg.timeHHMM) return;
    const target = hhmmToMinutes(bcfg.timeHHMM);
    if (target == null) return;
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const dateStr = todayStamp();
    // Fire when we're at OR PAST the scheduled minute and haven't run yet today. Using
    // "past due" instead of exact equality means a delayed tick (busy event loop, a long
    // prior backup) still triggers today's run instead of silently skipping 24 hours. The
    // per-day guard (lastRunDate) ensures it only runs once.
    if (nowMin >= target && lastRunDate !== dateStr) {
      console.log(`[backup] scheduled trigger (target ${bcfg.timeHHMM}, now ${p2(now)})`);
      const result = await runBackupNow();
      // A skipped run (another backup — likely a manual one — held the guard) is NOT today's
      // scheduled backup: leave lastRunDate unstamped so the next minute tick retries, and
      // don't classify — the result object describes the PREVIOUS run, so judging it here
      // would set or clear the operator banner for a run that never happened. Stamping the
      // day only after a real run also keeps the once-per-day guarantee: a long run spanning
      // several ticks makes each overlapping tick skip harmlessly, and the run that actually
      // executed stamps the day when it finishes.
      if (result.skipped) return;
      lastRunDate = dateStr;
      // Classify the SCHEDULED outcome for the operator-panel banner. A board archive is any
      // produced file that isn't the config snapshot. If one exists, the scheduled backup
      // succeeded — clear any prior failure. Otherwise record why it failed so panels can
      // show a specific message (empty board vs export failure).
      const boardArchive = (result.lastFiles || []).some((f) => f.file && !f.file.endsWith('__config.json'));
      if (boardArchive) {
        status.scheduledFailure = null;
      } else {
        const err = result.lastError || 'Backup failed';
        let reason = 'error';
        if (/no snapshots/i.test(err)) reason = 'empty';
        else if (/no valid backup target/i.test(err)) reason = 'target';
        else if (/no valid files|returned JSON|export/i.test(err)) reason = 'export';
        status.scheduledFailure = { at: Date.now(), reason, message: err, cardLabel: result.lastTargetLabel || null };
        console.warn(`[backup] scheduled backup FAILED (${reason}): ${err}`);
      }
    }
  };
  timer = setInterval(tick, 60000);
  timer.unref?.();

  // On startup, if we're already past today's target time, mark today as done so a redeploy
  // after the scheduled time doesn't immediately fire an unexpected backup. The missed-minute
  // protection still applies going forward (a delayed tick within the same day still fires if
  // the minute was crossed while running). Deployments happen often here, so avoiding a
  // surprise heavy board export on every restart is the safer default.
  (async () => {
    try {
      const cfg = await loadConfig();
      const target = hhmmToMinutes((cfg.backup || {}).timeHHMM);
      const now = new Date();
      if (target != null && (now.getHours() * 60 + now.getMinutes()) >= target) {
        lastRunDate = todayStamp();
      }
    } catch {}
  })();

  console.log('[backup] scheduler started (checks each minute)');
}

function p2(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function backupStatus() {
  // `running` is derived from the live guard rather than stored, so it can never be left
  // stuck true by a run that died between setting and clearing a flag.
  return { ...status, running: backupRunning };
}

// Normalise a backup-config edit into the stored shape. Shared by BOTH admin save paths
// (the main config PUT and the dedicated /api/admin/backup PUT), so the two can't drift.
// Callers validate timeHHMM (via hhmmToMinutes) and 400 on a bad value BEFORE calling this;
// here an empty time just falls back to the default. `prev` supplies fallbacks for fields
// the edit omitted.
const clampCount = (v, fallback) => Math.max(1, Math.min(365, parseInt(v, 10) || fallback || 30));
export function normalizeBackupConfig(b, prev = {}) {
  return {
    enabled: !!b.enabled,
    cardId: typeof b.cardId === 'string' ? b.cardId : '',
    timeHHMM: b.timeHHMM || '03:00',
    // Number of most-recent backup runs to keep — applies to board archives and config
    // snapshots alike (each on its own dates; see prune()).
    retentionCount: clampCount(b.retentionCount, prev.retentionCount),
  };
}

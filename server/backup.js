// server/backup.js
// Scheduled daily backup of a target board. Exports the board's snapshots to a dated file
// (or per-folder files if the board won't do a single whole-board export) stored on the
// volume, and prunes anything older than the retention window.
//
// Config lives in the main config file under config.backup:
//   { enabled, cardId, timeHHMM: "03:00", retentionDays: 30 }
//
// Files are written to BACKUP_DIR (default /data/backups) as:
//   <date>__<cardLabel>__<folder-or-all>.bin

import { readdir, mkdir, writeFile, rename, unlink, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getSnapshotInfo, normalizeSnapshotEntry, exportSnapshots } from './board.js';
import { loadConfig, getCardById } from './config.js';
import { buildZip } from './zip.js';

const BACKUP_DIR = process.env.BACKUP_DIR || '/data/backups';

let timer = null;
let backupRunning = false; // guards against concurrent runs (manual during scheduled, etc.)
const status = {
  lastRun: null, lastError: null, lastFiles: [], nextCheck: null,
  // Set ONLY by the scheduler (not manual runs) when a scheduled backup fails to produce a
  // board archive. Drives the persistent banner on operator panels. Shape:
  //   { at: <ms>, reason: 'export' | 'empty' | 'target' | 'error', message: <string> }
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
    return { ...status, lastError: 'A backup is already running; this request was skipped.' };
  }
  backupRunning = true;
  try {
    return await runBackupInternal();
  } finally {
    backupRunning = false;
  }
}

async function runBackupInternal() {
  await ensureDir();
  const config = await loadConfig();
  const date = fileStamp();
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
  // The UI/endpoint stores the chosen board as `cardId`. Accept legacy `target` too.
  const sel = bcfg.cardId || bcfg.target || '';
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
    status.lastError = e.message;
    status.lastRun = Date.now();
    // The board part failed, but the config copy at the top succeeded — record it so the
    // run still shows a restore point rather than looking like it produced nothing.
    status.lastFiles = written.slice();
  }
  return status;
}

async function writeAtomic(path, buf) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, buf);
  await rename(tmp, path);
}

// A backup file is recognised by its date-prefix name (YYYY-MM-DD, optionally with a
// _HH-MM-SS time), regardless of extension — the board may hand back various file types.
const BACKUP_RE = /^\d{4}-\d{2}-\d{2}(_\d{2}-\d{2}-\d{2})?__.+/;
function isBackupFile(f) { return BACKUP_RE.test(f) && !f.endsWith('.tmp'); }

// Classify a backup filename into a kind and its date key (the YYYY-MM-DD prefix).
//   kind: 'config'  -> <date>__config.json           (app config snapshot)
//         'zip'     -> <date>__<label>__individual.zip (per-snapshot bundle)
//         'board'   -> everything else (the full-board archive, incl. per-folder fallbacks)
// The date key groups all files produced by one nightly run together.
function classifyBackup(f) {
  const m = f.match(/^(\d{4}-\d{2}-\d{2})/);
  const dateKey = m ? m[1] : '';
  let kind = 'board';
  if (f.endsWith('__config.json')) kind = 'config';
  else if (f.endsWith('__individual.zip')) kind = 'zip';
  return { kind, dateKey };
}

// Retention has two independent rules, by design (see the backup runner):
//   * Board backups (full archive + its snapshot zip) are kept by COUNT: the N most recent
//     backup DATES that produced a real board archive. Age is irrelevant, so a long board
//     outage can't age out good backups — after recovery you still have N real ones.
//   * Config snapshots are kept by CALENDAR AGE: the last configRetentionDays days. They're
//     tiny and written even on board-down nights, so a simple age window suits them.
async function prune(config) {
  const keepCount = (config.backup && config.backup.retentionCount)
    || (config.backup && config.backup.retentionDays)   // legacy field name, same intent
    || 30;
  const configDays = (config.backup && config.backup.configRetentionDays) || 30;

  let files;
  try { files = await readdir(BACKUP_DIR); } catch { return; }
  const backups = files.filter(isBackupFile);

  // --- Board rule: keep the N most-recent dates that have a board archive ---
  const boardDates = new Set();
  for (const f of backups) {
    const { kind, dateKey } = classifyBackup(f);
    if (kind === 'board' && dateKey) boardDates.add(dateKey);
  }
  // Most recent first; keep the first keepCount dates, delete board+zip files of the rest.
  const keptDates = new Set([...boardDates].sort().reverse().slice(0, keepCount));

  // --- Config rule: keep the last configDays calendar days ---
  const configCutoff = Date.now() - configDays * 86400000;

  for (const f of backups) {
    const { kind, dateKey } = classifyBackup(f);
    try {
      if (kind === 'config') {
        const s = await stat(join(BACKUP_DIR, f));
        if (s.mtimeMs < configCutoff) { await unlink(join(BACKUP_DIR, f)); console.log(`[backup] pruned (config age) ${f}`); }
      } else {
        // board or zip — governed by the kept-dates set
        if (dateKey && !keptDates.has(dateKey)) { await unlink(join(BACKUP_DIR, f)); console.log(`[backup] pruned (retention count) ${f}`); }
      }
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
      const { kind, dateKey } = classifyBackup(f);
      out.push({ file: f, bytes: s.size, mtime: s.mtimeMs, kind, dateKey });
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
  // Parse "HH:MM" to minutes-of-day; null if malformed.
  const toMinutes = (hhmm) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
    if (!m) return null;
    const h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
  };
  const tick = async () => {
    status.nextCheck = Date.now();
    const config = await loadConfig();
    const bcfg = config.backup || {};
    if (!bcfg.enabled || !(bcfg.cardId || bcfg.target) || !bcfg.timeHHMM) return;
    const target = toMinutes(bcfg.timeHHMM);
    if (target == null) return;
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const dateStr = todayStamp();
    // Fire when we're at OR PAST the scheduled minute and haven't run yet today. Using
    // "past due" instead of exact equality means a delayed tick (busy event loop, a long
    // prior backup) still triggers today's run instead of silently skipping 24 hours. The
    // per-day guard (lastRunDate) ensures it only runs once.
    if (nowMin >= target && lastRunDate !== dateStr) {
      lastRunDate = dateStr;
      console.log(`[backup] scheduled trigger (target ${bcfg.timeHHMM}, now ${p2(now)})`);
      const result = await runBackupNow();
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
        status.scheduledFailure = { at: Date.now(), reason, message: err };
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
      const target = toMinutes((cfg.backup || {}).timeHHMM);
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
  return { ...status };
}

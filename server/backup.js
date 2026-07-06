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
const status = { lastRun: null, lastError: null, lastFiles: [], nextCheck: null };

async function ensureDir() {
  if (!existsSync(BACKUP_DIR)) await mkdir(BACKUP_DIR, { recursive: true });
}

function safe(s) {
  return String(s || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'x';
}
function todayStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Perform one backup of the configured card. Tries a single whole-board export first;
// if that fails, falls back to one file per distinct folder path found on the board.
export async function runBackupNow() {
  await ensureDir();
  const config = await loadConfig();
  const bcfg = config.backup || {};
  // The UI/endpoint stores the chosen board as `cardId`. Accept legacy `target` too.
  const sel = bcfg.cardId || bcfg.target || '';
  let ip = null, label = null;
  const card = getCardById(config, sel);
  if (card && card.ip) { ip = card.ip; label = card.label || card.id; }
  else if (sel && /\d+\.\d+\.\d+\.\d+/.test(sel)) { ip = sel; label = sel; }
  if (!ip) {
    status.lastError = 'No valid backup target configured';
    return status;
  }
  label = safe(label);
  const date = todayStamp();
  const written = [];

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
      status.lastFiles = [];
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

    status.lastRun = Date.now();
    if (written.length) status.lastError = null;
    else if (!status.lastError) status.lastError = 'Export produced no valid files';
    status.lastFiles = written;
    console.log(`[backup] ${label} ${date}: wrote ${written.length} file(s)`);
    await prune(config);
  } catch (e) {
    status.lastError = e.message;
  }
  return status;
}

async function writeAtomic(path, buf) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, buf);
  await rename(tmp, path);
}

// A backup file is recognised by its date-prefix name (YYYY-MM-DD__...), regardless of
// extension — the board may hand back various file types (or none).
const BACKUP_RE = /^\d{4}-\d{2}-\d{2}__.+/;
function isBackupFile(f) { return BACKUP_RE.test(f) && !f.endsWith('.tmp'); }

// Delete backups older than retentionDays (by file mtime).
async function prune(config) {
  const days = (config.backup && config.backup.retentionDays) || 30;
  const cutoff = Date.now() - days * 86400000;
  let files;
  try { files = await readdir(BACKUP_DIR); } catch { return; }
  for (const f of files) {
    if (!isBackupFile(f)) continue;
    try {
      const s = await stat(join(BACKUP_DIR, f));
      if (s.mtimeMs < cutoff) { await unlink(join(BACKUP_DIR, f)); console.log(`[backup] pruned ${f}`); }
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
      out.push({ file: f, bytes: s.size, mtime: s.mtimeMs });
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
  const tick = async () => {
    status.nextCheck = Date.now();
    const config = await loadConfig();
    const bcfg = config.backup || {};
    if (!bcfg.enabled || !(bcfg.cardId || bcfg.target) || !bcfg.timeHHMM) return;
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const hhmm = `${p(now.getHours())}:${p(now.getMinutes())}`;
    const dateStr = todayStamp();
    if (hhmm === bcfg.timeHHMM && lastRunDate !== dateStr) {
      lastRunDate = dateStr;
      console.log(`[backup] scheduled trigger at ${hhmm}`);
      await runBackupNow();
    }
  };
  timer = setInterval(tick, 60000);
  timer.unref?.();
  console.log('[backup] scheduler started (checks each minute)');
}

export function backupStatus() {
  return { ...status };
}

// public/admin-backups.js
// The Backups & sharing tab: the auto-share sweep controls and the scheduled-backup
// settings, run button, and per-run file table. Loaded after admin-core.js.

// ---- Auto-share sweep -----------------------------------------------------
// Edited inline: the Enabled toggle, interval, and card chips mutate config.shareSweep
// directly, and the main "Save config" button persists it. "Run once now" is an action.

async function refreshSweep() {
  try {
    // Only the live status comes from the server; the settings live in the held config.
    const s = await adminFetch('/api/admin/sharesweep', { headers: headers() }).then(r => r.json());
    config.shareSweep ||= { enabled: false, intervalSec: 60, targets: [] };
    $('swEnabled').checked = !!config.shareSweep.enabled;
    $('swInterval').value = config.shareSweep.intervalSec || 60;
    renderSweepCards();
    const when = s.lastRun ? new Date(s.lastRun).toLocaleTimeString() : 'never';
    $('sweepState').textContent = `Last run ${when}` + (s.lastError ? ` · ${s.lastError}`
      : ` · shared ${s.shared || 0}, checked ${s.checked || 0}` + (s.failed ? `, FAILED ${s.failed}` : ''));
  } catch (e) { $('sweepState').textContent = 'Error: ' + e.message; }
}

// Per-card enable chips. Empty targets means "all cards" — represented here by every
// chip being on; toggling any off makes the set explicit.
function renderSweepCards() {
  const host = $('swCards'); host.innerHTML = '';
  const sw = (config.shareSweep ||= { enabled: false, intervalSec: 60, targets: [] });
  const allSelected = (sw.targets || []).length === 0;
  config.cards.filter(c => c.id).forEach((c) => {
    const on = allSelected || sw.targets.includes(c.id);
    const chip = document.createElement('button');
    chip.className = 'chip' + (on ? ' on' : '');
    chip.textContent = c.label || c.id;
    chip.addEventListener('click', () => {
      // Materialize "all" into an explicit list on first toggle.
      let list = (sw.targets || []).length ? [...sw.targets]
        : config.cards.filter(x => x.id).map(x => x.id);
      if (list.includes(c.id)) list = list.filter(x => x !== c.id); else list.push(c.id);
      sw.targets = list;
      renderSweepCards();
    });
    host.appendChild(chip);
  });
}

// Enabled / interval edits update the held config immediately (persisted on main Save).
$('swEnabled').addEventListener('change', (e) => {
  (config.shareSweep ||= {}).enabled = e.target.checked;
});
$('swInterval').addEventListener('input', (e) => {
  (config.shareSweep ||= {}).intervalSec = parseInt(e.target.value, 10) || 60;
});

$('swRun').addEventListener('click', async () => {
  $('sweepState').textContent = 'Running…';
  try {
    const s = await adminFetch('/api/admin/sharesweep/run', { method: 'POST', headers: headers() }).then(r => r.json());
    $('sweepState').textContent = `Shared ${s.shared || 0}, checked ${s.checked || 0}` + (s.failed ? `, FAILED ${s.failed}` : '');
  } catch (e) { $('sweepState').textContent = 'Error: ' + e.message; }
});

// ---- Scheduled backup -----------------------------------------------------

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

// A backup writes its files one at a time (config snapshot first, then the board archive, then
// the individual-snapshot zip) and the whole run can take minutes. While it's in progress the
// listing is a PARTIAL view of that run, so the row is drawn with "Saving…" in the columns whose
// file doesn't exist yet, and re-polled until the server reports the run finished. Without this,
// a page rendered mid-run shows the run as though it were complete with files missing —
// indistinguishable from a backup that genuinely failed to produce them.
let bkPollTimer = null;
function scheduleBackupFilesPoll(delayMs = 1500) {
  clearTimeout(bkPollTimer);
  bkPollTimer = setTimeout(refreshBackupFiles, delayMs);
}

// Refresh ONLY the file list. Deliberately not the whole form (refreshBackup): this runs on a
// timer, and re-rendering the inputs under the admin would fight whatever they're typing.
async function refreshBackupFiles() {
  clearTimeout(bkPollTimer);
  try {
    const d = await adminFetch('/api/admin/backup/files', { headers: headers() }).then(r => r.json());
    renderBackupFiles(d.files || [], d);
    if (d.running) scheduleBackupFilesPoll(); // self-terminating: stops once the run is done
  } catch { /* transient poll failure: leave the list as-is and stop polling */ }
}

async function refreshBackup() {
  try {
    // Settings live in the held config; only the file list + run status come from the server.
    const data = await adminFetch('/api/admin/backup', { headers: headers() }).then(r => r.json());
    const c = (config.backup ||= { enabled: false, cardId: '', timeHHMM: '03:00', retentionCount: 30 });
    $('bkEnabled').checked = !!c.enabled;
    $('bkTime').value = c.timeHHMM || '03:00';
    $('bkRetention').value = c.retentionCount || 30;
    // Populate board dropdown from current cards.
    $('bkCard').innerHTML = '<option value="">— select —</option>' +
      config.cards.filter(x => x.id).map(x => `<option value="${esc(x.id)}"${x.id === c.cardId ? ' selected' : ''}>${esc(x.label || x.id)}</option>`).join('');
    const st = data.status || {};
    renderBackupFiles(data.files || [], st);
    // Page opened while a backup is running (the nightly one, or another admin's) — keep the
    // list live until it finishes rather than leaving a half-written run on screen.
    if (st.running) scheduleBackupFilesPoll();
    if (st.lastRun) $('bkState').textContent = `Last backup ${new Date(st.lastRun).toLocaleString()}` + (st.lastError ? ` · ${st.lastError}` : '');
  } catch (e) { $('bkState').textContent = 'Error: ' + e.message; }
}

// Backup form edits update the held config immediately (persisted on the main Save config).
function wireBackupInputs() {
  const c = () => (config.backup ||= { enabled: false, cardId: '', timeHHMM: '03:00', retentionCount: 30 });
  $('bkEnabled').addEventListener('change', (e) => { c().enabled = e.target.checked; });
  $('bkCard').addEventListener('change', (e) => { c().cardId = e.target.value; });
  $('bkTime').addEventListener('input', (e) => { c().timeHHMM = e.target.value.trim(); });
  $('bkRetention').addEventListener('input', (e) => { c().retentionCount = parseInt(e.target.value, 10) || 30; });
}
wireBackupInputs();

// `run` carries the server's live run state: { running, runKey }. Files belonging to runKey are
// still being written, so that row's empty cells read "Saving…" rather than "—".
function renderBackupFiles(files, run = {}) {
  const activeKey = run && run.running ? (run.runKey || null) : null;
  const tb = $('bkFiles'); tb.innerHTML = '';
  const totalEl = $('bkTotal');
  if (totalEl) {
    const total = files.reduce((sum, f) => sum + (f.bytes || 0), 0);
    totalEl.textContent = files.length
      ? `${files.length} file${files.length === 1 ? '' : 's'} · ${fmtBytes(total)} used on server`
      : '';
  }
  if (!files.length && !activeKey) { tb.innerHTML = '<tr><td colspan="5" class="muted">No backups yet.</td></tr>'; return; }

  // Group files by their RUN (date + time), so each row is one backup run with its board
  // archive, snapshot zip, and config snapshot in separate columns. Keyed on runKey, NOT the
  // date: several runs in a day are distinct files, and grouping them by date merged them into
  // one row whose buttons could only address a single file per kind — the newest silently had
  // no Delete button. (Retention still groups by date; that's a separate key. See backup.js.)
  //
  // Each cell holds a LIST, not one file: a run whose whole-board export failed falls back to
  // one board file PER FOLDER, so several files of the same kind can share a run. Every file on
  // disk must get its own Download/Delete, or it becomes undeletable through the UI.
  const byRun = new Map();
  for (const f of files) {
    const stamp = (f.file.match(/^(\d{4}-\d{2}-\d{2}(?:_\d{2}-\d{2}-\d{2})?)/) || [])[1];
    const key = f.runKey || stamp || f.file;
    if (!byRun.has(key)) {
      byRun.set(key, {
        date: f.dateKey || (stamp || '').slice(0, 10) || key,
        board: [], zip: [], config: [], mtime: f.mtime,
      });
    }
    const row = byRun.get(key);
    if (f.kind === 'zip') row.zip.push(f);
    else if (f.kind === 'config') row.config.push(f);
    else row.board.push(f);
    row.mtime = Math.max(row.mtime, f.mtime);
  }
  // A run that hasn't written its first file yet still deserves a row, so pressing "Back up now"
  // shows something immediately instead of nothing until the config snapshot lands.
  if (activeKey && !byRun.has(activeKey)) {
    byRun.set(activeKey, { date: activeKey.slice(0, 10), board: [], zip: [], config: [], mtime: Date.now() });
  }
  const rows = [...byRun.entries()].map(([key, r]) => ({ ...r, key })).sort((a, b) => b.mtime - a.mtime);

  const cell = (list, saving) => {
    if (!list || !list.length) {
      return saving ? '<span class="bk-saving">Saving…</span>' : '<span class="muted">—</span>';
    }
    return list.map((f) => `<div class="bk-cell">
        <span class="bk-sz muted">${fmtBytes(f.bytes)}</span>
        <a class="btn sm ghost" href="/api/admin/backup/download/${encodeURIComponent(f.file)}" download title="${esc(f.file)}">Download</a>
        <button class="btn sm del" data-file="${esc(f.file)}">Delete</button>
      </div>`).join('');
  };

  rows.forEach((r) => {
    const tr = document.createElement('tr');
    // Only the in-flight run's missing cells are "Saving…". A finished run that produced no zip
    // (whole-board export failed, per-folder fallback used) must still read "—" — that's a real
    // absence, not work in progress.
    const saving = r.key === activeKey;
    const time = r.mtime ? new Date(r.mtime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
    tr.innerHTML = `<td class="bk-date">${esc(r.date)}</td>
      <td class="bk-time">${time}</td>
      <td>${cell(r.board, saving)}</td>
      <td>${cell(r.zip, saving)}</td>
      <td>${cell(r.config, saving)}</td>`;
    tr.querySelectorAll('button[data-file]').forEach((btn) => {
      btn.addEventListener('click', () => deleteBackup(btn.getAttribute('data-file')));
    });
    tb.appendChild(tr);
  });
}

async function deleteBackup(file) {
  if (!confirm(`Delete backup "${file}"? This cannot be undone.`)) return;
  try {
    const r = await adminFetch(`/api/admin/backup/files/${encodeURIComponent(file)}`, { method: 'DELETE', headers: headers() });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
    await refreshBackupFiles();
    $('bkState').textContent = `Deleted ${file}`;
  } catch (e) { $('bkState').textContent = 'Delete failed: ' + e.message; }
}

$('bkRun').addEventListener('click', async () => {
  if (!config.backup || !config.backup.cardId) { $('bkState').textContent = 'Pick a board first.'; return; }
  $('bkState').textContent = 'Saving & backing up… (may take a moment)';
  try {
    // Persist ONLY the backup settings, through their own endpoint, so the run uses exactly
    // what's on screen. Deliberately NOT the main config save: that PUT commits every other
    // unsaved edit on the page and broadcasts a reload to EVERY operator panel — an on-air
    // side effect a maintenance action must never have.
    const r = await adminFetch('/api/admin/backup', {
      method: 'PUT', headers: headers(), body: JSON.stringify(config.backup),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
    // Adopt the server's normalised values (retention clamping, time default) so a later main
    // Save doesn't push the un-normalised screen values back over them.
    const saved = await r.json();
    if (saved && saved.config) config.backup = saved.config;
    // This endpoint writes config too, so it bumps the concurrency token. Adopt it or the next
    // main "Save config" from this window would be refused as stale.
    if (saved && typeof saved.configVersion === 'number') config.configVersion = saved.configVersion;
    // Start the run, then show it progressing rather than freezing the list until it ends —
    // a whole-board export can take minutes.
    const runReq = adminFetch('/api/admin/backup/run', { method: 'POST', headers: headers() });
    scheduleBackupFilesPoll(300);
    const s = await runReq.then(r2 => r2.json());
    $('bkState').textContent = s.lastError ? `Error: ${s.lastError}` : `Wrote ${(s.lastFiles || []).length} file(s)`;
    // Final state, now that the run is over: refresh only the file list, not the whole form,
    // so the selection is preserved.
    await refreshBackupFiles();
  } catch (e) { $('bkState').textContent = 'Error: ' + e.message; }
});

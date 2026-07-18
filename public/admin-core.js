// public/admin-core.js
// Admin page core: shared helpers, config load/save with optimistic concurrency, dirty
// tracking, the live config-sync banner, export/import, tab navigation, and the clock.
// The admin page is plain scripts loaded in order (no build step) sharing top-level scope:
//   shared.js -> admin-core.js -> admin-panels.js -> admin-heads.js -> admin-backups.js
//   -> admin-diag.js (which runs the boot sequence)

let config = { cards: [], panels: [] };
const $ = (id) => document.getElementById(id);

// Shared utilities (shared.js): natural alphanumeric name sort + snapshot folder grouping.
const { byName, groupSnapshotsByFolder } = NV;

// Identifies THIS window to the server for the whole session. The server broadcasts every
// config write to the admin pages; sending this on write calls lets it skip the window that
// caused the change, which would otherwise be told about its own save (see connectConfigWs).
const CLIENT_ID = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
  : `c${Date.now()}-${Math.random().toString(16).slice(2)}`;

// Auth: the admin page is gated by a session cookie (set at login, sent automatically).
// No token/header is needed. headers() remains for JSON content-type on write calls —
// and carries the client id, so every config-writing call is covered by construction.
function headers() {
  return { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID };
}

// Every admin API call goes through this: a 401 means the session expired (30-min idle) or
// was cleared — bounce to the login page. A named wrapper rather than patching window.fetch,
// so only our own admin calls get the redirect behavior.
async function adminFetch(url, opts) {
  const res = await fetch(url, opts);
  if (res.status === 401) window.location.href = '/login.html';
  return res;
}

async function logout() {
  try { await fetch('/api/admin/logout', { method: 'POST' }); } catch {}
  window.location.href = '/login.html';
}

function setLoadState(msg) { const el = $('loadState'); if (el) el.textContent = msg; }

// Escape board- and user-sourced strings before putting them in innerHTML. Board strings
// (snapshot/head names, log detail) and user labels can contain <, >, &, or quotes that
// would otherwise break markup or render wrong (e.g. a snapshot named `A & B <x>`).
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function toast(msg, kind = '') {
  const t = $('toast'); t.textContent = msg; t.className = `toast show ${kind}`;
  clearTimeout(toast._t); toast._t = setTimeout(() => t.className = 'toast', 3000);
}

async function loadConfig() {
  setLoadState('Loading…');
  try {
    const res = await adminFetch('/api/admin/config', { headers: headers() });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
    config = await res.json();
    config.cards ||= []; config.panels ||= [];
    config.headFilters ||= {};
    config.panelGroups ||= [];
    config.settings ||= { showUuids: true };
    config.shareSweep ||= { enabled: false, intervalSec: 60, targets: [] };
    config.backup ||= { enabled: false, cardId: '', timeHHMM: '03:00', retentionCount: 30 };
    // backup and shareSweep are edited inline on the Backups tab and saved WITH the main
    // config, so we keep them in the held config.
    $('showUuids').checked = config.settings.showUuids !== false;
    renderCards(); renderPanels(); renderHeadFilterCards();
    // If a card's head filters are open, re-render their checkboxes against the config we just
    // loaded — otherwise they'd still show the PREVIOUS config's ticks, which a later Save would
    // then write back. Harmless on a manual Reload; actively wrong after a silent refresh.
    if ($('hfCard') && $('hfCard').value) renderGlobalHeadFilters($('hfCard').value);
    // Baseline for dirty-tracking, taken AFTER the render pass: rendering normalises config in
    // place (pads layout grids, renumbers head order), so snapshotting before it would make a
    // freshly-loaded page look edited.
    markClean();
    setLoadState('Loaded');
    refreshBackup();
    refreshSweep();
  } catch (e) { setLoadState('Error: ' + e.message); }
}

async function saveConfig() {
  try {
    const res = await adminFetch('/api/admin/config', {
      method: 'PUT', headers: headers(), body: JSON.stringify(config),
    });
    const body = await res.json().catch(() => ({}));
    // A stale save is refused rather than silently reverting the other session's work. Say so
    // loudly and persistently: a toast disappears in 3s, and this one costs the admin their
    // unsaved edits if they reload without exporting first.
    if (res.status === 409 && body.code === 'CONFIG_STALE') {
      $('saveState').textContent = 'NOT SAVED — another admin session changed the config.';
      toast('Not saved — config changed elsewhere', 'err');
      alert(body.error);
      return;
    }
    if (!res.ok) throw new Error(body.error || res.status);
    // Adopt the new token, or this window's NEXT save would be refused as stale.
    if (typeof body.configVersion === 'number') config.configVersion = body.configVersion;
    // What's on screen is now what's stored — this is the new dirty baseline, and any stale
    // notice is resolved by our own save.
    markClean();
    hideCfgBanner();
    $('saveState').textContent = 'Saved ' + new Date().toLocaleTimeString();
    toast('Configuration saved', 'ok');
  } catch (e) { toast('Save failed: ' + e.message, 'err'); }
}

$('save').addEventListener('click', saveConfig);

// ---- Export / import backup ----------------------------------------------

$('exportBtn').addEventListener('click', () => {
  // Snapshot the current editor state (includes any unsaved edits) as a backup file.
  const data = JSON.stringify(config, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const a = document.createElement('a');
  a.href = url;
  a.download = `neuron-mv-config-${ts}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast('Backup exported', 'ok');
});

$('importBtn').addEventListener('click', () => $('importFile').click());

$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = ''; // allow re-importing the same file later
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    // Validate the essential shape before accepting.
    if (!parsed || !Array.isArray(parsed.cards) || !Array.isArray(parsed.panels)) {
      throw new Error('File is missing cards[] or panels[]');
    }
    if (!confirm('Replace the current editor contents with this backup? '
      + 'Nothing is saved to the server until you click "Save config".')) return;

    // Keep the token from the config THIS page loaded — an import replaces content, not our
    // place in the save sequence. Adopting the exported file's stale token would make the next
    // Save fail as a phantom conflict (or, if it happened to match, defeat the check).
    const currentVersion = config.configVersion;
    config = parsed;
    config.configVersion = currentVersion;
    config.cards ||= []; config.panels ||= [];
    config.headFilters ||= {};
    config.panelGroups ||= [];
    config.settings ||= { showUuids: true };
    // Apply the same defaults loadConfig() does, so an older export missing these keys doesn't
    // leave them undefined in the editor (and get written as such on the next Save).
    config.shareSweep ||= { enabled: false, intervalSec: 60, targets: [] };
    config.backup ||= { enabled: false, cardId: '', timeHHMM: '03:00', retentionCount: 30 };
    $('showUuids').checked = config.settings.showUuids !== false;
    renderCards(); renderPanels(); renderHeadFilterCards();
    // Re-render an open head-filter card, and refresh the Backups tab controls, against the
    // imported config — otherwise those sections keep showing the PREVIOUS config's values
    // while a Save would persist the imported ones.
    if ($('hfCard') && $('hfCard').value) renderGlobalHeadFilters($('hfCard').value);
    refreshBackup();
    refreshSweep();
    $('saveState').textContent = 'Imported — review and Save config to apply';
    toast('Backup loaded into editor. Review, then Save config.', 'ok');
  } catch (err) {
    toast('Import failed: ' + err.message, 'err');
  }
});

// ---- Live config sync between admin windows -------------------------------
// The server broadcasts { type:'config-changed', configVersion } on every config write, so a
// second admin window doesn't sit on a stale copy until someone happens to refresh it — and
// then only discovers it when its Save is refused.
//
// This shares the operator panels' control socket but reacts to a DIFFERENT message. Panels
// reload on 'reload'; this page must NEVER do that unprompted, because it can hold unsaved
// edits that a reload would silently throw away. Hence: refresh only when there's nothing to
// lose, otherwise say so and let the admin decide.

// Serialized config as of the last load/save. Anything edited since makes the live object
// differ. This ONLY gates whether an outside change can be adopted silently, and it errs
// toward "dirty" on purpose: a wrong "dirty" costs a banner, a wrong "clean" destroys someone's
// unsaved work. It has to err that way — the render pass normalises config in place (padding
// layout grids, renumbering head order), which is indistinguishable from a real edit.
let cleanSnapshot = null;
function markClean() {
  try { cleanSnapshot = JSON.stringify(config); } catch { cleanSnapshot = null; }
}
function isDirty() {
  if (cleanSnapshot === null) return true;
  try { return JSON.stringify(config) !== cleanSnapshot; } catch { return true; }
}

// True when the ONLY difference from the clean baseline is the backup block (and the
// server-managed configVersion). "Back up now" persists just the backup settings through its
// own endpoint, so after it runs the page is clean IF nothing else was edited — but the user
// almost always edited the backup fields first, so a plain isDirty() check would read dirty
// and leave the "unsaved changes" banner up forever. This lets that path re-baseline only when
// it's genuinely safe (backup was the sole edit), and stay dirty when other edits remain.
function onlyBackupDirty() {
  if (cleanSnapshot === null) return false;
  try {
    const baseline = JSON.parse(cleanSnapshot);
    const strip = (c) => JSON.stringify({ ...c, backup: null, configVersion: null });
    return strip(config) === strip(baseline);
  } catch { return false; }
}

function showCfgBanner(msg) {
  const el = $('cfgBanner');
  if (!el) return;
  $('cfgBannerMsg').textContent = msg;
  el.classList.add('show');
}
function hideCfgBanner() { const el = $('cfgBanner'); if (el) el.classList.remove('show'); }

function onConfigChangedElsewhere(version) {
  // Already at (or ahead of) that version — nothing new to report. (The server also excludes
  // this window from broadcasts for its OWN writes, via the client id on the socket, so a
  // write made here never arrives as someone else's change in the first place.)
  if (typeof version === 'number' && version <= (Number(config.configVersion) || 0)) return;

  if (isDirty()) {
    showCfgBanner('Another admin session changed the configuration. This page is now showing an '
      + 'older version, and saving from here will be refused. Reload to pick up the current '
      + 'config — unsaved edits on this page will be lost, so use “Export backup” first if you '
      + 'need to keep them.');
    return;
  }
  // Nothing unsaved to protect — just adopt the new config in place.
  hideCfgBanner();
  loadConfig();
  toast('Configuration updated by another admin session');
}

let cfgWs = null;
function connectConfigWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  try {
    // clientId identifies this window so the server can skip it when broadcasting a change
    // this window itself caused (main Save, "Back up now", …). Every config write from this
    // page sends the same id via headers().
    cfgWs = new WebSocket(`${proto}://${location.host}/ws?control=1&clientId=${encodeURIComponent(CLIENT_ID)}`);
  } catch { setTimeout(connectConfigWs, 5000); return; }
  cfgWs.onmessage = (ev) => {
    let msg = null;
    try { msg = JSON.parse(ev.data); } catch { return; }
    // 'reload' is deliberately ignored here — it's the operator panels' message.
    if (msg && msg.type === 'config-changed') onConfigChangedElsewhere(msg.configVersion);
  };
  // Reconnect so this survives a redeploy; without it the window goes quietly stale again.
  cfgWs.onclose = () => setTimeout(connectConfigWs, 5000);
  cfgWs.onerror = () => { try { cfgWs.close(); } catch {} };
}

const cfgReloadBtn = $('cfgBannerReload');
if (cfgReloadBtn) cfgReloadBtn.addEventListener('click', () => {
  if (isDirty() && !confirm('Reload the configuration and discard your unsaved changes on this page?')) return;
  hideCfgBanner();
  loadConfig();
});
const cfgBannerX = $('cfgBannerX');
if (cfgBannerX) cfgBannerX.addEventListener('click', hideCfgBanner);

const logoutBtn = $('logoutBtn');
if (logoutBtn) logoutBtn.addEventListener('click', logout);

// Sub-navigation: switch between admin tab panels. Purely a display grouping — all
// sections stay in the DOM (so their render/refresh logic is unaffected), we just show
// one panel at a time.
document.querySelectorAll('.subnav-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab;
    document.querySelectorAll('.subnav-tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.tabpanel').forEach((p) => {
      p.classList.toggle('active', p.dataset.tabpanel === target);
    });
  });
});

// Container clock in the admin header. Renders the container's wall-clock time in the
// container's own timezone (from /api/time), so it's accurate even if the browser is in a
// different zone. No tz label — just the time.
let clockOffsetMs = 0, clockTz = null, clockFmt = null;
async function syncClock() {
  try {
    const t = await fetch('/api/time').then((r) => r.json());
    clockOffsetMs = t.epochMs - Date.now();
    if (t.tz && t.tz !== clockTz) {
      clockTz = t.tz;
      try {
        clockFmt = new Intl.DateTimeFormat(undefined, {
          hour: '2-digit', minute: '2-digit', second: '2-digit',
          hour12: false, timeZone: clockTz,
        });
      } catch { clockFmt = null; } // invalid tz — fall back to local render
    }
  } catch {}
}
function tickClock() {
  const el = document.getElementById('adminClock');
  if (!el) return;
  const d = new Date(Date.now() + clockOffsetMs);
  if (clockFmt) { el.textContent = clockFmt.format(d); return; }
  const p = (n) => String(n).padStart(2, '0');
  el.textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
tickClock();
setInterval(tickClock, 1000);
syncClock().then(tickClock);
setInterval(syncClock, 5 * 60 * 1000);

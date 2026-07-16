// public/admin.js
let config = { cards: [], panels: [] };
const $ = (id) => document.getElementById(id);

// Natural alphanumeric sort ("2 Boxes" < "9 Boxes" < "10 Boxes").
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const byName = (a, b) => collator.compare(a.name || '', b.name || '');

// Auth: the admin page is gated by a session cookie (set at login, sent automatically).
// No token/header is needed. headers() remains for JSON content-type on write calls.
function headers() {
  return { 'Content-Type': 'application/json' };
}
// Any admin API call that comes back 401 means the session expired (30-min idle) or was
// cleared — bounce to the login page. Wrap fetch once so every call is covered.
const _rawFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const res = await _rawFetch(...args);
  try {
    const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
    if (res.status === 401 && url.startsWith('/api/admin/') && !url.endsWith('/login')) {
      window.location.href = '/login.html';
    }
  } catch {}
  return res;
};
async function logout() {
  try { await _rawFetch('/api/admin/logout', { method: 'POST' }); } catch {}
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
    const res = await fetch('/api/admin/config', { headers: headers() });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
    config = await res.json();
    config.cards ||= []; config.panels ||= [];
    config.headFilters ||= {};
    config.panelGroups ||= [];
    config.settings ||= { showUuids: true };
    config.shareSweep ||= { enabled: false, intervalSec: 60, targets: [] };
    config.backup ||= { enabled: false, cardId: '', timeHHMM: '03:00', retentionCount: 30, configRetentionDays: 30 };
    // backup and shareSweep are now edited inline on the Backups tab and saved WITH the main
    // config (their standalone Save buttons were removed), so we keep them in the held config.
    $('showUuids').checked = config.settings.showUuids !== false;
    renderCards(); renderPanels(); renderHeadFilterCards();
    setLoadState('Loaded');
    if (typeof refreshBackup === 'function') refreshBackup();
    if (typeof refreshSweep === 'function') refreshSweep();
  } catch (e) { setLoadState('Error: ' + e.message); }
}

async function saveConfig() {
  try {
    const res = await fetch('/api/admin/config', {
      method: 'PUT', headers: headers(), body: JSON.stringify(config),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
    $('saveState').textContent = 'Saved ' + new Date().toLocaleTimeString();
    toast('Configuration saved', 'ok');
  } catch (e) { toast('Save failed: ' + e.message, 'err'); }
}

// ---- Cards ----------------------------------------------------------------

function renderCards() {
  const tb = $('cardRows'); tb.innerHTML = '';
  config.cards.forEach((c, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input value="${esc(c.id || '')}" data-i="${i}" data-f="id"></td>
      <td><input value="${esc(c.label || '')}" data-i="${i}" data-f="label"></td>
      <td><input value="${esc(c.ip || '')}" data-i="${i}" data-f="ip" placeholder="10.10.60.x"></td>
      <td><div class="stor" data-stor="${esc(c.id || '')}"><span class="stor-idle muted">—</span></div></td>
      <td><button class="btn sm del" data-del="${i}">Remove</button></td>`;
    tb.appendChild(tr);
  });
  tb.querySelectorAll('input').forEach((inp) => inp.addEventListener('input', (e) => {
    const { i, f } = e.target.dataset; config.cards[+i][f] = e.target.value;
    if (f === 'label' || f === 'id') renderPanels(); // panel checkboxes show labels
  }));
  tb.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', (e) => {
    config.cards.splice(+e.target.dataset.del, 1); renderCards(); renderPanels();
  }));
  if (typeof renderReachRow === 'function') renderReachRow();
  if (typeof renderSyncDiagCards === 'function') renderSyncDiagCards();
  if (typeof renderGeomProbeCards === 'function') renderGeomProbeCards();
  if (typeof renderHeadFilterCards === 'function') renderHeadFilterCards();
  if (typeof loadAllStorage === 'function') loadAllStorage();
}

// Fetch and render snapshot-storage usage for every card with an IP. Post-firmware the boards
// report their own total (which changed), so the percentage is against the BOARD-REPORTED
// total — shown only when the board reports one. When it doesn't, we show the used amount
// alone (no invented denominator). Bar turns amber past 75% and red past 90%. The board's raw
// state string is surfaced too, since the boards are misbehaving after the update.
async function loadAllStorage() {
  for (const c of config.cards) {
    if (!c.id) continue;
    const slot = document.querySelector(`[data-stor="${cssEsc(c.id)}"]`);
    if (!slot) continue;
    if (!c.ip) { slot.innerHTML = '<span class="stor-idle muted">no IP</span>'; continue; }
    slot.innerHTML = '<span class="stor-idle muted">…</span>';
    try {
      const r = await fetch(`/api/admin/cards/${encodeURIComponent(c.id)}/storage`, { headers: headers() });
      const d = await r.json();
      if (!d.ok) { slot.innerHTML = `<span class="stor-err" title="${esc(d.detail || d.error || 'error')}">unreachable</span>`; continue; }

      const mb = (b) => (b / (1024 * 1024)).toFixed(1);
      const usedMB = d.usedBytes != null ? mb(d.usedBytes) : '?';
      // Show the board's activity/state when it's anything other than plain idle, and flag a
      // failed sync prominently (the post-firmware failures show up here).
      const syncBad = d.syncState && /fail/i.test(d.syncState);
      const notes = [];
      if (d.state && d.state !== 'idle') notes.push(`<span class="stor-anom" title="Board activity">${esc(d.state)}</span>`);
      if (syncBad) notes.push(`<span class="stor-anom" title="${esc(d.syncMessage || 'sync failed')}">sync: ${esc(d.syncState)}</span>`);
      const stateNote = notes.length ? ' · ' + notes.join(' · ') : '';

      if (d.percent != null && d.totalBytes != null) {
        // Board reported a usable total — show the bar + percentage against it.
        const pct = d.percent;
        const level = pct >= 90 ? 'crit' : pct >= 75 ? 'warn' : 'ok';
        const totalMB = mb(d.totalBytes);
        slot.innerHTML = `
          <div class="stor-bar" title="${usedMB} MB of ${totalMB} MB used (${pct}%) — total reported by board">
            <div class="stor-fill ${level}" style="width:${Math.min(100, pct)}%"></div>
          </div>
          <span class="stor-pct ${level}">${pct}%</span>
          <span class="stor-bytes muted">${usedMB} / ${totalMB} MB${stateNote}</span>`;
      } else {
        // No total reported by the board — no percentage is possible. Keep the same row shape
        // (empty bar + dash) so this row still lines up with the others in the table.
        slot.innerHTML = `
          <div class="stor-bar" title="Board did not report a total capacity"></div>
          <span class="stor-pct muted">—</span>
          <span class="stor-bytes muted">${usedMB} MB used`
          + ` · <span class="stor-anom" title="The board did not report a total capacity">total not reported</span>${stateNote}</span>`;
      }
    } catch (e) {
      slot.innerHTML = `<span class="stor-err">error</span>`;
    }
  }
}

// Escape a string for use inside a CSS attribute selector (card IDs are user-defined).
function cssEsc(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\\]]/g, '\\$&');
}

$('addCard').addEventListener('click', () => {
  const n = config.cards.length + 1;
  config.cards.push({ id: `mv${n}`, label: `MV Card ${n}`, ip: '' });
  renderCards(); renderPanels();
});

$('showUuids').addEventListener('change', (e) => {
  config.settings ||= {};
  config.settings.showUuids = e.target.checked;
});

// ---- Panels ---------------------------------------------------------------
// Each panel assigns specific heads: p.heads = [{ cardId, headUuid, boardName, label,
// order, allowedSnapshots }]. Cards are only the source you pick heads from.

// Cache of probed board data per card so we don't re-hit boards repeatedly.
const cardHeadsCache = new Map();   // cardId -> [{uuid,name}]
const cardSnapsCache = new Map();   // cardId -> [{uuid,name}]

async function probeCardHeads(cardId) {
  if (cardHeadsCache.has(cardId)) return cardHeadsCache.get(cardId);
  const heads = await fetch(`/api/admin/cards/${encodeURIComponent(cardId)}/heads`, { headers: headers() }).then(r => r.json());
  const list = Array.isArray(heads) ? heads : [];
  cardHeadsCache.set(cardId, list);
  return list;
}
async function probeCardSnaps(cardId) {
  if (cardSnapsCache.has(cardId)) return cardSnapsCache.get(cardId);
  const snaps = await fetch(`/api/admin/cards/${encodeURIComponent(cardId)}/snapshots`, { headers: headers() }).then(r => r.json());
  const list = Array.isArray(snaps) ? snaps : [];
  cardSnapsCache.set(cardId, list);
  return list;
}

// Master-detail: a list of panels on the left, the selected panel's editor on the right.
let selectedPanel = 0;

function renderPanels() {
  const host = $('panelList'); host.innerHTML = '';

  // Clamp selection to a valid index (handles deletes / empty).
  if (selectedPanel >= config.panels.length) selectedPanel = config.panels.length - 1;
  if (selectedPanel < 0) selectedPanel = 0;

  const split = document.createElement('div');
  split.className = 'panel-split';
  split.innerHTML = `
    <div class="panel-list" id="panelListCol"></div>
    <div class="panel-detail" id="panelDetail"></div>`;
  host.appendChild(split);

  const listCol = split.querySelector('#panelListCol');
  renderPanelListInto(listCol);

  renderPanelDetail(selectedPanel);
}

// Ordered list of group names. Persisted so empty groups survive. Panels reference a group
// by name via panel.group; a missing/empty group means "ungrouped".
function panelGroups() {
  if (!Array.isArray(config.panelGroups)) config.panelGroups = [];
  return config.panelGroups;
}

// Transient (not persisted) set of collapsed group names — collapse is a view preference.
const collapsedGroups = new Set();

// Build the grouped, drag-reorderable panel list. Named groups render first (each with a
// collapsible header), then ungrouped panels at the bottom under an "Ungrouped" header.
// Dragging a panel reorders config.panels and, dropped on a header or among a group's
// panels, sets its group.
function renderPanelListInto(listCol) {
  listCol.innerHTML = '';
  if (!config.panels.length) {
    listCol.innerHTML = '<div class="muted" style="padding:10px">No panels yet. Add one above.</div>';
  }

  const groups = panelGroups();
  // Defensive: if any panel references a group not in the list (imported config, etc.),
  // add it so those panels still render under a header rather than vanishing.
  config.panels.forEach((p) => {
    const g = p.group || '';
    if (g && !groups.includes(g)) groups.push(g);
  });
  // Section order: named groups (in stored order) first, then ungrouped ("") at the bottom.
  const sections = [...groups, ''];

  sections.forEach((group) => {
    const isUngrouped = group === '';
    const panelsIn = [];
    config.panels.forEach((p, pi) => { if ((p.group || '') === group) panelsIn.push(pi); });

    // Skip the ungrouped section entirely if there are none, to avoid an empty header.
    if (isUngrouped && !panelsIn.length) return;

    const collapsed = collapsedGroups.has(group);
    const head = document.createElement('div');
    head.className = 'panel-group-head' + (collapsed ? ' collapsed' : '');
    head.dataset.group = group;
    // Named group headers can be dragged to reorder groups. The "Ungrouped" section is
    // pinned to the bottom and isn't draggable.
    head.draggable = !isUngrouped;
    // Ungrouped header has a caret + label + count, but no rename/delete controls.
    const controls = isUngrouped ? '' :
      `<button class="pgh-btn" data-rename title="Rename group" draggable="false">✎</button>
       <button class="pgh-btn" data-delgroup title="Delete group (keeps panels)" draggable="false">✕</button>`;
    head.innerHTML = `<span class="pgh-caret">${collapsed ? '▸' : '▾'}</span>
      <span class="pgh-name"></span>
      <span class="pgh-count muted">${panelsIn.length}</span>
      ${controls}`;
    head.querySelector('.pgh-name').textContent = isUngrouped ? 'Ungrouped' : group;
    // Clicking the header (not its buttons) toggles collapse. A real drag suppresses click.
    head.addEventListener('click', () => {
      if (collapsed) collapsedGroups.delete(group); else collapsedGroups.add(group);
      renderPanels();
    });
    if (!isUngrouped) {
      head.querySelector('[data-rename]').addEventListener('click', (e) => { e.stopPropagation(); renameGroup(group); });
      head.querySelector('[data-delgroup]').addEventListener('click', (e) => { e.stopPropagation(); deleteGroup(group); });
      // Group reordering: emit a group payload on drag.
      head.addEventListener('dragstart', (e) => {
        e.stopPropagation();
        e.dataTransfer.setData('text/plain', JSON.stringify({ kind: 'group', name: group }));
        e.dataTransfer.effectAllowed = 'move';
        currentDragKind = 'group';
        head.classList.add('dragging');
      });
      head.addEventListener('dragend', () => {
        currentDragKind = null;
        head.classList.remove('dragging');
        document.querySelectorAll('.panel-group-head.drop-before,.panel-group-head.drop-after')
          .forEach((el) => el.classList.remove('drop-before', 'drop-after'));
      });
    }
    // The header accepts BOTH a panel drop (move panel into this group) and a group drop
    // (reorder groups). Which one is decided from the drag payload's `kind`.
    head.addEventListener('dragover', (e) => {
      e.preventDefault();
      const kind = dragKind(e);
      if (kind === 'group' && !isUngrouped) {
        const before = isBeforeMidpoint(e, head);
        head.classList.toggle('drop-before', before);
        head.classList.toggle('drop-after', !before);
      } else {
        head.classList.add('over');
      }
    });
    head.addEventListener('dragleave', () => head.classList.remove('over', 'drop-before', 'drop-after'));
    head.addEventListener('drop', (e) => {
      e.preventDefault();
      head.classList.remove('over', 'drop-before', 'drop-after');
      const kind = dragKind(e);
      if (kind === 'group') {
        if (isUngrouped) return; // can't reorder relative to the pinned Ungrouped section
        const from = dragGroupName(e); if (from == null) return;
        const before = isBeforeMidpoint(e, head);
        reorderGroup(from, group, before);
      } else {
        const pi = dragPanelIndex(e); if (pi == null) return;
        collapsedGroups.delete(group);
        movePanelToGroup(pi, group, null);
      }
    });
    listCol.appendChild(head);

    // Panels belonging to this section, hidden when the group is collapsed.
    if (!collapsed) {
      panelsIn.forEach((pi) => listCol.appendChild(buildPanelListItem(config.panels[pi], pi)));
    }
  });

  // "New group" affordance at the bottom.
  const addG = document.createElement('button');
  addG.className = 'panel-group-add';
  addG.textContent = '+ New group';
  addG.addEventListener('click', addGroup);
  listCol.appendChild(addG);
}

function buildPanelListItem(p, pi) {
  const item = document.createElement('button');
  const hasMissing = (p.heads || []).some((h) => h.missing);
  item.className = 'panel-list-item' + (pi === selectedPanel ? ' active' : '')
    + (hasMissing ? ' has-error' : '');
  item.dataset.pi = pi;
  item.draggable = true;
  const name = p.label || p.ip || `Panel ${pi + 1}`;
  const sub = p.ip && p.label ? p.ip : (p.layout === 'strip' ? 'CTP' : '1920×1080');
  item.innerHTML = `<span class="pli-name"></span><span class="pli-sub muted"></span>`
    + (hasMissing ? '<span class="pli-alert" title="One or more assigned heads are missing on the board">⚠</span>' : '');
  item.querySelector('.pli-name').textContent = name;
  item.querySelector('.pli-sub').textContent = sub;
  item.addEventListener('click', () => { selectedPanel = pi; renderPanels(); });

  item.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', JSON.stringify({ kind: 'panel', pi }));
    e.dataTransfer.effectAllowed = 'move';
    currentDragKind = 'panel';
    item.classList.add('dragging');
  });
  item.addEventListener('dragend', () => {
    currentDragKind = null;
    item.classList.remove('dragging');
    document.querySelectorAll('.panel-list-item.drop-before,.panel-list-item.drop-after')
      .forEach((el) => el.classList.remove('drop-before', 'drop-after'));
  });
  item.addEventListener('dragover', (e) => {
    if (currentDragKind === 'group') return; // groups don't drop onto individual panels
    e.preventDefault();
    const before = isBeforeMidpoint(e, item);
    item.classList.toggle('drop-before', before);
    item.classList.toggle('drop-after', !before);
  });
  item.addEventListener('dragleave', () => item.classList.remove('drop-before', 'drop-after'));
  item.addEventListener('drop', (e) => {
    e.preventDefault();
    const before = isBeforeMidpoint(e, item);
    item.classList.remove('drop-before', 'drop-after');
    const from = dragPanelIndex(e); if (from == null) return;
    const targetPi = pi;
    // Move to the dropped panel's group, positioned before/after the target.
    movePanelToGroup(from, config.panels[targetPi].group || '', { targetPi, before });
  });
  return item;
}

// The kind of the in-flight drag ('panel' | 'group' | null). Tracked in a module var
// because dataTransfer.getData() is only readable on `drop`, not during `dragover` — so
// dragover handlers rely on this to decide their behavior.
let currentDragKind = null;

// Parse a panel-drag payload's source index from a drop event.
function dragPanelIndex(e) {
  let payload;
  try { payload = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return null; }
  if (!payload || payload.kind !== 'panel' || typeof payload.pi !== 'number') return null;
  return payload.pi;
}
// Parse a group-drag payload's source name from a drop event.
function dragGroupName(e) {
  let payload;
  try { payload = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return null; }
  if (!payload || payload.kind !== 'group' || typeof payload.name !== 'string') return null;
  return payload.name;
}
function dragKind() { return currentDragKind; }
function isBeforeMidpoint(e, el) {
  const r = el.getBoundingClientRect();
  return (e.clientY - r.top) < r.height / 2;
}

// Reorder group `from` to sit before/after the group at `target` in config.panelGroups.
// Panels keep their group membership; only the section order changes.
function reorderGroup(from, target, before) {
  const groups = panelGroups();
  const fi = groups.indexOf(from);
  const ti = groups.indexOf(target);
  if (fi < 0 || ti < 0 || from === target) return;
  groups.splice(fi, 1);
  let insertAt = groups.indexOf(target);
  if (!before) insertAt += 1;
  insertAt = Math.max(0, Math.min(insertAt, groups.length));
  groups.splice(insertAt, 0, from);
  renderPanels();
}

// Move panel at index `from` into `group`, optionally positioned relative to a target panel.
// When `pos` is null the panel is appended at the end of that group's run.
function movePanelToGroup(from, group, pos) {
  const panel = config.panels[from];
  if (!panel) return;
  // Dropping a panel onto itself with the same group is a no-op — avoid a needless
  // reindex that could visibly "jump" the selection.
  if (pos && pos.targetPi === from && (panel.group || '') === (group || '')) return;
  panel.group = group || '';
  // Pull the panel out, then reinsert at the right spot.
  config.panels.splice(from, 1);

  let insertAt;
  if (pos && typeof pos.targetPi === 'number') {
    // Recompute the target's current index (it may have shifted after the splice).
    let target = pos.targetPi;
    if (from < pos.targetPi) target -= 1;
    insertAt = pos.before ? target : target + 1;
  } else {
    // Append after the last panel currently in this group; if none, after the last panel
    // of the preceding sections so it lands under the right header.
    insertAt = lastIndexOfGroup(group);
    insertAt = insertAt < 0 ? config.panels.length : insertAt + 1;
  }
  insertAt = Math.max(0, Math.min(insertAt, config.panels.length));
  config.panels.splice(insertAt, 0, panel);
  selectedPanel = insertAt;
  collapsedGroups.delete(group || ''); // keep the moved (now selected) panel visible
  renderPanels();
}
function lastIndexOfGroup(group) {
  let idx = -1;
  config.panels.forEach((p, i) => { if ((p.group || '') === group) idx = i; });
  return idx;
}

function addGroup() {
  const name = (prompt('New group name:') || '').trim();
  if (!name) return;
  const groups = panelGroups();
  if (groups.includes(name)) { toast('Group already exists', 'err'); return; }
  groups.push(name);
  renderPanels();
}
function renameGroup(oldName) {
  const name = (prompt('Rename group:', oldName) || '').trim();
  if (!name || name === oldName) return;
  const groups = panelGroups();
  if (groups.includes(name)) { toast('Group already exists', 'err'); return; }
  const i = groups.indexOf(oldName);
  if (i >= 0) groups[i] = name;
  config.panels.forEach((p) => { if ((p.group || '') === oldName) p.group = name; });
  renderPanels();
}
function deleteGroup(name) {
  // Removing a group keeps its panels — they become ungrouped.
  const groups = panelGroups();
  const i = groups.indexOf(name);
  if (i >= 0) groups.splice(i, 1);
  config.panels.forEach((p) => { if ((p.group || '') === name) p.group = ''; });
  renderPanels();
}

function renderPanelDetail(pi) {
  const detail = $('panelDetail');
  if (!detail) return;
  detail.innerHTML = '';
  if (!config.panels.length || pi < 0 || pi >= config.panels.length) {
    detail.innerHTML = '<div class="muted" style="padding:20px">Select a panel on the left, or add one.</div>';
    return;
  }

  const p = config.panels[pi];
  p.heads ||= [];
  const box = document.createElement('div');
  box.innerHTML = `
    <div class="inline" style="gap:12px">
      <div style="flex:1"><label class="muted">Panel IP</label>
        <input value="${esc(p.ip || '')}" data-pi="${pi}" data-f="ip" placeholder="10.10.61.11"></div>
      <div style="flex:1"><label class="muted">Label</label>
        <input value="${esc(p.label || '')}" data-pi="${pi}" data-f="label" placeholder="PCR 101 Panel"></div>
      <div style="width:200px"><label class="muted">Layout</label>
        <select data-pi="${pi}" data-f="layout">
          <option value="1080"${p.layout === '1080' ? ' selected' : ''}>1920 × 1080</option>
          <option value="strip"${p.layout === 'strip' ? ' selected' : ''}>1835 × 291 (CTP)</option>
        </select></div>
      <div style="align-self:flex-end" class="inline">
        <button class="btn sm ghost" data-duppanel="${pi}">Duplicate</button>
        <button class="btn sm del" data-delpanel="${pi}">Remove</button>
      </div>
    </div>
    <div style="margin-top:14px">
      <label class="inline" style="cursor:pointer; gap:8px">
        <input type="checkbox" id="allowShowAll-${pi}" ${p.allowShowAll ? 'checked' : ''} style="width:18px;height:18px">
        <span>Allow operators to temporarily “Show all snapshots” on this panel</span>
      </label>
    </div>
    <div style="margin-top:14px">
      <label class="muted">Heads on this panel (in display order)</label>
      <div id="headList-${pi}" style="margin-top:6px"></div>
      <div class="inline" style="margin-top:8px">
        <button class="btn sm" data-addhead="${pi}">Add head</button>
        <button class="btn sm ghost" data-addallheads="${pi}">Add all heads</button>
        <span class="muted" id="addHeadState-${pi}"></span>
      </div>
      <div id="headPicker-${pi}"></div>
    </div>
    <div style="margin-top:18px">
      <label class="muted">Physical layout — drag heads into the grid to match the monitor wall</label>
      <div id="layoutEditor-${pi}" class="layout-editor"></div>
    </div>`;
  detail.appendChild(box);

  box.querySelectorAll('[data-f]').forEach((el) => el.addEventListener('input', (e) => {
    const field = e.target.dataset.f;
    const prev = config.panels[pi][field];
    const val = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    config.panels[pi][field] = val;
    // The label/IP in the left list should update live as you type.
    if (field === 'label' || field === 'ip') refreshPanelListLabels();
    // Changing the layout type changes the fixed column count (7 ↔ 8). Rather than wiping
    // the arrangement, reshape it row-by-row so existing placements stay put: growing
    // 7→8 appends a blank column, shrinking 8→7 drops the 8th column (any head there
    // becomes unplaced and returns to the tray).
    if (field === 'layout' && val !== prev) {
      reshapeGridColumns(config.panels[pi], prev, val);
      renderLayoutEditor(pi);
    }
  }));
  box.querySelector('[data-delpanel]').addEventListener('click', () => {
    config.panels.splice(pi, 1);
    if (selectedPanel >= pi && selectedPanel > 0) selectedPanel--;
    renderPanels();
  });
  // Dedicated handler for the "allow show all" checkbox — writes directly to config on
  // change (the canonical checkbox event), so the flag reliably persists on Save.
  const showAllCb = box.querySelector(`#allowShowAll-${pi}`);
  if (showAllCb) {
    showAllCb.addEventListener('change', (e) => {
      config.panels[pi].allowShowAll = e.target.checked;
    });
  }
  box.querySelector('[data-duppanel]').addEventListener('click', () => duplicatePanel(pi));
  box.querySelector(`[data-addhead="${pi}"]`).addEventListener('click', () => openHeadPicker(pi));
  box.querySelector(`[data-addallheads="${pi}"]`).addEventListener('click', () => addAllHeads(pi));

  renderHeadList(pi);
  renderLayoutEditor(pi);
}

// Update just the left-list names/subs without a full re-render (so typing doesn't steal
// focus from the input being edited). Items carry data-pi since grouping means DOM order
// no longer matches config.panels index order.
function refreshPanelListLabels() {
  const items = document.querySelectorAll('#panelListCol .panel-list-item');
  items.forEach((item) => {
    const pi = +item.dataset.pi;
    const p = config.panels[pi];
    if (!p) return;
    const name = p.label || p.ip || `Panel ${pi + 1}`;
    const sub = p.ip && p.label ? p.ip : (p.layout === 'strip' ? 'CTP' : '1920×1080');
    item.querySelector('.pli-name').textContent = name;
    item.querySelector('.pli-sub').textContent = sub;
  });
}

function renderHeadList(pi) {
  const p = config.panels[pi];
  const host = $(`headList-${pi}`); host.innerHTML = '';
  if (!p.heads.length) {
    host.innerHTML = '<div class="muted">No heads assigned yet. Use “Add head”.</div>';
    return;
  }
  // keep order field in sync with array position
  p.heads.forEach((h, i) => { h.order = i; });

  const clearDropMarks = () => host.querySelectorAll('.assigned-head.drop-before,.assigned-head.drop-after')
    .forEach((el) => el.classList.remove('drop-before', 'drop-after'));

  p.heads.forEach((h, i) => {
    const card = config.cards.find((c) => c.id === h.cardId);
    const row = document.createElement('div');
    row.className = 'assigned-head';
    row.draggable = true;
    row.dataset.idx = i;
    row.innerHTML = `
      <div class="ah-top">
        <span class="ah-drag" title="Drag to reorder">⋮⋮</span>
        <span class="order-pos">${i + 1}</span>
        <input class="ah-label" placeholder="${esc(h.boardName || 'Display label')}" value="${esc(h.label || '')}">
        <span class="ah-source muted"></span>
        <button class="btn sm del ah-del">Remove</button>
      </div>`;
    row.querySelector('.ah-source').textContent =
      `${card ? (card.label || card.id) : h.cardId + ' (missing card)'} · ${h.boardName || h.headUuid}`;
    if (h.missing) {
      const warn = document.createElement('div');
      warn.className = 'ah-warn';
      warn.textContent = '⚠ This head’s ID no longer exists on the board. This usually means '
        + 'a full board restore was performed from the Neuron web GUI, which replaces every '
        + 'head (and its ID). Re-add this head from the current board heads, then delete this '
        + 'entry — its layout placement and snapshot filter will need to be set again.';
      row.querySelector('.ah-top').after(warn);
    }
    row.querySelector('.ah-label').addEventListener('input', (e) => { h.label = e.target.value; });
    row.querySelector('.ah-del').addEventListener('click', () => {
      p.heads.splice(i, 1); renderHeadList(pi); renderLayoutEditor(pi);
    });

    // Drag-to-reorder within this panel's head list.
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', JSON.stringify({ kind: 'head', idx: i }));
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => { row.classList.remove('dragging'); clearDropMarks(); });
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      const before = isBeforeMidpoint(e, row);
      row.classList.toggle('drop-before', before);
      row.classList.toggle('drop-after', !before);
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      const before = isBeforeMidpoint(e, row);
      clearDropMarks();
      let payload;
      try { payload = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
      if (!payload || payload.kind !== 'head' || typeof payload.idx !== 'number') return;
      reorderHead(pi, payload.idx, i, before);
    });

    host.appendChild(row);
  });
}

// Move a head from index `from` to sit before/after the head currently at `target`.
function reorderHead(pi, from, target, before) {
  const heads = config.panels[pi].heads;
  if (from === target) return;
  const [moved] = heads.splice(from, 1);
  let insertAt = target;
  if (from < target) insertAt -= 1;      // target shifted left after removal
  if (!before) insertAt += 1;            // drop after the target
  insertAt = Math.max(0, Math.min(insertAt, heads.length));
  heads.splice(insertAt, 0, moved);
  renderHeadList(pi);
  renderLayoutEditor(pi);
}

// ---- Per-panel physical layout editor ------------------------------------
// Columns are FIXED (7 for 1080, 8 for strip) to preserve the operator-view scaling.
// The admin defines the number of ROWS and drags heads into a row-major grid. Each slot
// is a head ref or a blank spacer. Stored as panel.layoutGrid = [ slot, ... ] row-major.

function layoutCols(panel) { return panel.layout === 'strip' ? 8 : 7; }

// Column count for a given layout value (the panel's `layout` field, "1080" | "strip").
function colsForLayout(layout) { return layout === 'strip' ? 8 : 7; }

// Re-flow the row-major layoutGrid when the column count changes, keeping every existing
// placement in its row and column. Growing (7→8) appends a blank cell to each row;
// shrinking (8→7) drops the last cell of each row — a head that was there becomes
// unplaced (it stays in panel.heads, so it reappears in the "Unplaced heads" tray).
function reshapeGridColumns(panel, prevLayout, nextLayout) {
  const prevCols = colsForLayout(prevLayout);
  const nextCols = colsForLayout(nextLayout);
  const grid = Array.isArray(panel.layoutGrid) ? panel.layoutGrid : [];
  if (prevCols === nextCols || !grid.length) return; // nothing to reshape

  const out = [];
  for (let start = 0; start < grid.length; start += prevCols) {
    const row = grid.slice(start, start + prevCols);
    if (nextCols > prevCols) {
      // Pad the row up to the new width with blanks.
      while (row.length < nextCols) row.push({ type: 'blank' });
    } else {
      // Truncate the row to the new width (drops the overflow cells / their heads).
      row.length = nextCols;
    }
    for (const cell of row) out.push(cell || { type: 'blank' });
  }
  panel.layoutGrid = out;
}

// Ensure the grid array exists and is sized to a whole number of rows.
function ensureGrid(p) {
  const cols = layoutCols(p);
  if (!Array.isArray(p.layoutGrid)) p.layoutGrid = [];
  // pad to a full row
  while (p.layoutGrid.length % cols !== 0) p.layoutGrid.push({ type: 'blank' });
  if (!p.layoutGrid.length) for (let i = 0; i < cols; i++) p.layoutGrid.push({ type: 'blank' });
  return cols;
}

// Heads assigned to the panel that are NOT yet placed anywhere in the grid.
function unplacedHeads(p) {
  const placed = new Set(
    (p.layoutGrid || []).filter((s) => s && s.type === 'head').map((s) => `${s.cardId}::${s.headUuid}`));
  return (p.heads || []).filter((h) => !placed.has(`${h.cardId}::${h.headUuid}`));
}

function renderLayoutEditor(pi) {
  const p = config.panels[pi];
  const host = $(`layoutEditor-${pi}`);
  if (!host) return;
  host.innerHTML = '';

  if (!p.heads || !p.heads.length) {
    host.innerHTML = '<div class="muted">Add heads above first, then arrange them here.</div>';
    return;
  }

  const cols = ensureGrid(p);
  // Prune grid slots whose head is no longer assigned to the panel (turn them into blanks).
  const assigned = new Set(p.heads.map((h) => `${h.cardId}::${h.headUuid}`));
  p.layoutGrid = p.layoutGrid.map((s) =>
    (s && s.type === 'head' && !assigned.has(`${s.cardId}::${s.headUuid}`)) ? { type: 'blank' } : s);

  const rows = p.layoutGrid.length / cols;

  // Controls: row add/remove + a note.
  const controls = document.createElement('div');
  controls.className = 'inline';
  controls.style.marginBottom = '8px';
  controls.innerHTML = `
    <span class="muted">${cols} columns (fixed) × ${rows} row${rows === 1 ? '' : 's'}</span>
    <button class="btn sm ghost" data-lc-addrow>+ Row</button>
    <button class="btn sm ghost" data-lc-delrow ${rows <= 1 ? 'disabled' : ''}>− Row</button>`;
  host.appendChild(controls);

  controls.querySelector('[data-lc-addrow]').addEventListener('click', () => {
    for (let i = 0; i < cols; i++) p.layoutGrid.push({ type: 'blank' });
    renderLayoutEditor(pi);
  });
  controls.querySelector('[data-lc-delrow]').addEventListener('click', () => {
    if (p.layoutGrid.length <= cols) return;
    // Remove the last row; any heads in it return to the tray automatically (they're just
    // dropped from the grid, still assigned to the panel).
    p.layoutGrid.splice(p.layoutGrid.length - cols, cols);
    renderLayoutEditor(pi);
  });

  // The grid itself.
  const gridEl = document.createElement('div');
  gridEl.className = 'lc-grid' + (p.layout === 'strip' ? ' strip' : '');
  gridEl.style.setProperty('--cols', String(cols));

  p.layoutGrid.forEach((slot, idx) => {
    const cell = document.createElement('div');
    cell.className = 'lc-cell';
    cell.dataset.idx = String(idx);

    if (slot && slot.type === 'head') {
      const h = p.heads.find((x) => x.cardId === slot.cardId && x.headUuid === slot.headUuid);
      cell.classList.add('filled');
      cell.draggable = true;
      cell.textContent = (h && (h.label || h.boardName)) || 'Head';
      cell.title = 'Drag to move · double-click to clear';
      cell.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', JSON.stringify({ from: 'grid', idx }));
      });
      cell.addEventListener('dblclick', () => { p.layoutGrid[idx] = { type: 'blank' }; renderLayoutEditor(pi); });
    } else {
      cell.classList.add('blank');
      cell.textContent = '';
      cell.title = 'Blank spacer · drop a head here';
    }

    // Drop target behavior for every cell.
    cell.addEventListener('dragover', (e) => { e.preventDefault(); cell.classList.add('over'); });
    cell.addEventListener('dragleave', () => cell.classList.remove('over'));
    cell.addEventListener('drop', (e) => {
      e.preventDefault(); cell.classList.remove('over');
      let payload;
      try { payload = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
      placeIntoCell(pi, idx, payload);
    });

    gridEl.appendChild(cell);
  });
  host.appendChild(gridEl);

  // Tray of unplaced heads.
  const unplaced = unplacedHeads(p);
  const tray = document.createElement('div');
  tray.className = 'lc-tray';
  tray.innerHTML = `<div class="muted" style="margin-bottom:6px">Unplaced heads (${unplaced.length}) — drag into the grid</div>`;
  const chips = document.createElement('div');
  chips.className = 'lc-chips';
  if (!unplaced.length) {
    chips.innerHTML = '<span class="muted">All assigned heads are placed.</span>';
  } else {
    unplaced.forEach((h) => {
      const chip = document.createElement('div');
      chip.className = 'lc-chip';
      chip.draggable = true;
      chip.textContent = h.label || h.boardName || h.headUuid;
      chip.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', JSON.stringify({
          from: 'tray', cardId: h.cardId, headUuid: h.headUuid,
        }));
      });
      chips.appendChild(chip);
    });
  }
  tray.appendChild(chips);

  // Dropping a head back onto the tray unplaces it.
  tray.addEventListener('dragover', (e) => { e.preventDefault(); tray.classList.add('over'); });
  tray.addEventListener('dragleave', () => tray.classList.remove('over'));
  tray.addEventListener('drop', (e) => {
    e.preventDefault(); tray.classList.remove('over');
    let payload;
    try { payload = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
    if (payload.from === 'grid') { p.layoutGrid[payload.idx] = { type: 'blank' }; renderLayoutEditor(pi); }
  });
  host.appendChild(tray);
}

// Place a dragged item (from tray or grid) into a target cell index.
function placeIntoCell(pi, targetIdx, payload) {
  const p = config.panels[pi];
  const target = p.layoutGrid[targetIdx];

  if (payload.from === 'tray') {
    // Placing an unplaced head. If target holds a head, that head goes back to the tray.
    p.layoutGrid[targetIdx] = { type: 'head', cardId: payload.cardId, headUuid: payload.headUuid };
  } else if (payload.from === 'grid') {
    const srcIdx = payload.idx;
    if (srcIdx === targetIdx) return;
    // Swap source and target (moving a head onto a blank leaves a blank behind; onto a
    // head swaps the two).
    p.layoutGrid[targetIdx] = p.layoutGrid[srcIdx];
    p.layoutGrid[srcIdx] = target && target.type === 'head' ? target : { type: 'blank' };
  }
  renderLayoutEditor(pi);
}

// Head picker: choose a card, then one of its heads to assign to the panel.
async function openHeadPicker(pi) {
  const host = $(`headPicker-${pi}`);
  const stateEl = $(`addHeadState-${pi}`);
  host.innerHTML = '';
  const picker = document.createElement('div');
  picker.className = 'filterbox';
  picker.style.marginTop = '10px';
  picker.innerHTML = `
    <div class="inline" style="gap:8px; flex-wrap:wrap">
      <label class="muted">Card</label>
      <select class="hp-card"></select>
      <label class="muted">Head</label>
      <select class="hp-head"><option value="">— pick a card first —</option></select>
      <button class="btn sm hp-add" disabled>Add</button>
      <button class="btn sm ghost hp-cancel">Cancel</button>
    </div>`;
  host.appendChild(picker);

  const cardSel = picker.querySelector('.hp-card');
  const headSel = picker.querySelector('.hp-head');
  const addBtn = picker.querySelector('.hp-add');

  cardSel.innerHTML = '<option value="">— select —</option>' +
    config.cards.filter(c => c.id).map(c => `<option value="${esc(c.id)}">${esc(c.label || c.id)}</option>`).join('');

  cardSel.addEventListener('change', async () => {
    const cardId = cardSel.value;
    headSel.innerHTML = '<option value="">Loading…</option>';
    addBtn.disabled = true;
    if (!cardId) { headSel.innerHTML = '<option value="">— pick a card first —</option>'; return; }
    try {
      const heads = (await probeCardHeads(cardId)).slice().sort(byName);
      const p = config.panels[pi];
      const taken = new Set(p.heads.filter(h => h.cardId === cardId).map(h => h.headUuid));
      const avail = heads.filter(h => !taken.has(h.uuid));
      if (!avail.length) { headSel.innerHTML = '<option value="">All heads already added</option>'; return; }
      headSel.innerHTML = '<option value="">— select —</option>' +
        avail.map(h => `<option value="${esc(h.uuid)}">${esc(h.name || h.uuid)}</option>`).join('');
    } catch (e) {
      headSel.innerHTML = `<option value="">Error: ${esc(e.message)}</option>`;
    }
  });

  headSel.addEventListener('change', () => { addBtn.disabled = !headSel.value; });

  addBtn.addEventListener('click', () => {
    const cardId = cardSel.value, headUuid = headSel.value;
    if (!cardId || !headUuid) return;
    const heads = cardHeadsCache.get(cardId) || [];
    const boardName = (heads.find(h => h.uuid === headUuid) || {}).name || '';
    config.panels[pi].heads.push({ cardId, headUuid, boardName, label: '', order: config.panels[pi].heads.length });
    host.innerHTML = '';
    stateEl.textContent = '';
    renderHeadList(pi);
    renderLayoutEditor(pi);
  });

  picker.querySelector('.hp-cancel').addEventListener('click', () => { host.innerHTML = ''; });
}

// Add every validly-named head from all defined cards to this panel in one action — for
// quickly building an engineering panel. Heads that are nameless or whose name is just
// their UUID are skipped, as are heads already assigned to this panel.
async function addAllHeads(pi) {
  const p = config.panels[pi];
  const stateEl = $(`addHeadState-${pi}`);
  const cards = config.cards.filter((c) => c.id);
  if (!cards.length) { stateEl.textContent = 'No cards defined.'; return; }
  stateEl.textContent = 'Loading heads from all cards…';

  let added = 0, skipped = 0;
  const failed = [];
  for (const card of cards) {
    let heads;
    try { heads = await probeCardHeads(card.id); }
    catch { failed.push(card.label || card.id); continue; }

    const taken = new Set(p.heads.filter((h) => h.cardId === card.id).map((h) => h.headUuid));
    for (const h of heads.slice().sort(byName)) {
      const name = (h.name || '').trim();
      // Skip nameless heads and ones whose "name" is just the UUID.
      if (!name || name === h.uuid) { skipped++; continue; }
      if (taken.has(h.uuid)) continue; // already on this panel
      p.heads.push({ cardId: card.id, headUuid: h.uuid, boardName: name, label: '', order: p.heads.length });
      added++;
    }
  }

  renderHeadList(pi);
  renderLayoutEditor(pi);
  stateEl.textContent = `Added ${added} head${added === 1 ? '' : 's'}`
    + (skipped ? `, skipped ${skipped} unnamed` : '')
    + (failed.length ? `, ${failed.length} card(s) unreachable` : '')
    + '. Save config to keep.';
}

$('addPanel').addEventListener('click', () => {
  config.panels.push({ ip: '', label: '', layout: '1080', heads: [] });
  selectedPanel = config.panels.length - 1; // open the new panel
  renderPanels();
});

// Duplicate a panel: deep-copy everything (heads, layout grid, filters, all settings)
// EXCEPT the IP — each panel is keyed by its unique IP, so the copy starts blank for you
// to fill in. The label gets a " (copy)" suffix. Inserted right after the original.
function duplicatePanel(pi) {
  const src = config.panels[pi];
  const copy = JSON.parse(JSON.stringify(src)); // deep clone, safe for plain config data
  copy.ip = '';                                  // must be unique — clear for the new panel
  copy.label = (src.label ? `${src.label} (copy)` : 'Panel (copy)');
  config.panels.splice(pi + 1, 0, copy);         // insert directly after the original
  selectedPanel = pi + 1;                         // open the new copy
  renderPanels();
  // Nudge the user toward the field that needs attention.
  const state = $(`addHeadState-${pi + 1}`);
  if (state) state.textContent = 'Duplicated — set this panel’s IP, then Save config.';
}

// Re-poll every board referenced by any panel head, and update cached board names across
// all panels (matched by UUID, which never changes on rename). Heads whose UUID is no
// longer present are flagged missing. Only touches display-name cache — assignments,
// filters, and ordering are keyed by UUID and untouched.
async function refreshAllHeadNames() {
  const stateEl = $('refreshAllState');
  const cardIds = [...new Set(
    config.panels.flatMap((p) => (p.heads || []).map((h) => h.cardId))
  )];
  if (!cardIds.length) { stateEl.textContent = 'No assigned heads to refresh.'; return; }
  stateEl.textContent = 'Refreshing…';

  // Bypass the probe cache so we read live names.
  cardIds.forEach((id) => cardHeadsCache.delete(id));

  let updated = 0, missing = 0, failedCards = [];
  const missingPanels = new Map(); // panel index -> count, so the summary can name them
  const liveByCard = new Map();
  for (const cardId of cardIds) {
    try {
      const heads = await probeCardHeads(cardId); // repopulates cache fresh
      liveByCard.set(cardId, new Map(heads.map((h) => [h.uuid, h.name || ''])));
    } catch (e) {
      failedCards.push(cardId);
    }
  }

  config.panels.forEach((p, pi) => {
    (p.heads || []).forEach((h) => {
      const live = liveByCard.get(h.cardId);
      if (!live) return; // card poll failed; leave as-is
      if (live.has(h.headUuid)) {
        const name = live.get(h.headUuid);
        if (name && name !== h.boardName) { h.boardName = name; updated++; }
        delete h.missing;
      } else {
        h.missing = true; missing++;
        missingPanels.set(pi, (missingPanels.get(pi) || 0) + 1);
      }
    });
  });

  renderPanels();
  // Refresh the global filter section's shown names too, if a card is selected there.
  if ($('hfCard').value) renderGlobalHeadFilters($('hfCard').value);

  // Name the panels that actually hold missing heads, since their warning rows are only
  // visible when that panel is selected in the master-detail editor.
  let missingText = '';
  if (missing) {
    const names = [...missingPanels.entries()].map(([pi, n]) => {
      const p = config.panels[pi];
      return `${p.label || p.ip || `Panel ${pi + 1}`} (${n})`;
    });
    missingText = `, ${missing} head${missing === 1 ? '' : 's'} missing on: ${names.join(', ')}`
      + ' — a full board restore replaces head IDs. Open each panel to see details.';
  }

  stateEl.textContent = `Updated ${updated} name${updated === 1 ? '' : 's'}`
    + missingText
    + (failedCards.length ? `, ${failedCards.length} card${failedCards.length === 1 ? '' : 's'} unreachable` : '')
    + '. Save config to keep.';
}

$('refreshAllNames').addEventListener('click', refreshAllHeadNames);

// Re-link heads by NAME after a board software update. Updates regenerate every head's UUID
// while KEEPING its name, which orphans all our UUID-keyed bindings at once. This repair
// matches each stored head (by its cached boardName) to the live head of the same name and
// rewrites the stored UUID everywhere it's referenced: the panel head assignment, the layout
// grid slot, and the headFilters key. Names are reliably unique per card in this facility, so
// a name match is safe; anything that can't be matched is left flagged so it's visible, never
// silently guessed.
async function relinkHeadsByName() {
  const stateEl = $('refreshAllState');
  const cardIds = [...new Set(
    config.panels.flatMap((p) => (p.heads || []).map((h) => h.cardId))
  )];
  if (!cardIds.length) { stateEl.textContent = 'No assigned heads to re-link.'; return; }
  if (!confirm('Re-link heads by name?\n\nThis rewrites stored head IDs to match the board\'s '
    + 'current heads by name — use this after a board software update changed the head IDs. '
    + 'Assignments, layout positions, and snapshot filters are preserved and moved to the new IDs.')) return;
  stateEl.textContent = 'Re-linking…';

  cardIds.forEach((id) => cardHeadsCache.delete(id));

  // Build name -> newUuid per card from live heads.
  const liveByCard = new Map();   // cardId -> Map(name -> uuid)
  const failedCards = [];
  for (const cardId of cardIds) {
    try {
      const heads = await probeCardHeads(cardId);
      const byName = new Map();
      for (const h of heads) if (h.name) byName.set(h.name, h.uuid);
      liveByCard.set(cardId, byName);
    } catch { failedCards.push(cardId); }
  }

  let relinked = 0, alreadyOk = 0, unmatched = 0;
  const unmatchedDetail = [];

  config.panels.forEach((p, pi) => {
    (p.heads || []).forEach((h) => {
      const byName = liveByCard.get(h.cardId);
      if (!byName) return; // card unreachable — leave untouched

      // Already valid? (UUID still live under this name) — nothing to do.
      const liveUuidForName = h.boardName ? byName.get(h.boardName) : null;
      if (liveUuidForName && liveUuidForName === h.headUuid) { delete h.missing; alreadyOk++; return; }

      if (!h.boardName || !byName.has(h.boardName)) {
        // No name to match on, or no live head with that name — cannot safely re-link.
        h.missing = true; unmatched++;
        unmatchedDetail.push(`${p.label || p.ip || `Panel ${pi + 1}`}: ${h.boardName || h.headUuid}`);
        return;
      }

      const newUuid = byName.get(h.boardName);
      const oldUuid = h.headUuid;
      if (newUuid === oldUuid) { delete h.missing; alreadyOk++; return; }

      // 1) Rewrite the panel head assignment.
      h.headUuid = newUuid;
      delete h.missing;

      // 2) Rewrite the layout grid slot(s) on THIS panel that referenced the old UUID.
      (p.layoutGrid || []).forEach((slot) => {
        if (slot && slot.type === 'head' && slot.cardId === h.cardId && slot.headUuid === oldUuid) {
          slot.headUuid = newUuid;
        }
      });

      // 3) Re-key the global head filter, if one existed for the old UUID.
      const oldKey = `${h.cardId}::${oldUuid}`;
      const newKey = `${h.cardId}::${newUuid}`;
      if (config.headFilters && Object.prototype.hasOwnProperty.call(config.headFilters, oldKey)) {
        config.headFilters[newKey] = config.headFilters[oldKey];
        delete config.headFilters[oldKey];
      }

      relinked++;
    });
  });

  renderPanels();
  if ($('hfCard').value) renderGlobalHeadFilters($('hfCard').value);

  let msg = `Re-linked ${relinked} head${relinked === 1 ? '' : 's'}`;
  if (alreadyOk) msg += `, ${alreadyOk} already current`;
  if (unmatched) msg += `, ${unmatched} could not be matched by name (${unmatchedDetail.slice(0, 5).join('; ')}${unmatchedDetail.length > 5 ? '…' : ''})`;
  if (failedCards.length) msg += `, ${failedCards.length} card${failedCards.length === 1 ? '' : 's'} unreachable`;
  msg += '. Save config to keep.';
  stateEl.textContent = msg;
}

const relinkBtn = $('relinkHeads');
if (relinkBtn) relinkBtn.addEventListener('click', relinkHeadsByName);

// Widget geometry probe (test tool) controls.
const gpCardSel = $('gpCard');
if (gpCardSel) gpCardSel.addEventListener('change', gpLoadHeads);
const gpLoadBtn = $('gpLoad');
if (gpLoadBtn) gpLoadBtn.addEventListener('click', gpLoadWidgets);
const gpRestoreOrderBtn = $('gpRestoreOrder');
if (gpRestoreOrderBtn) gpRestoreOrderBtn.addEventListener('click', gpRestoreOrder);
const gpRestoreAllBtn = $('gpRestoreAll');
if (gpRestoreAllBtn) gpRestoreAllBtn.addEventListener('click', gpRestoreAllSizes);

// ---- Global per-head snapshot filters -------------------------------------

function renderHeadFilterCards() {
  const sel = $('hfCard');
  const cur = sel.value;
  sel.innerHTML = '<option value="">— select a card —</option>' +
    config.cards.filter(c => c.id).map(c => `<option value="${esc(c.id)}">${esc(c.label || c.id)}</option>`).join('');
  if (cur) sel.value = cur;
}

$('hfCard').addEventListener('change', () => renderGlobalHeadFilters($('hfCard').value));

async function renderGlobalHeadFilters(cardId) {
  const host = $('hfHeads'); host.innerHTML = '';
  const stateEl = $('hfState');
  if (!cardId) { stateEl.textContent = ''; return; }
  stateEl.textContent = 'Loading…';
  config.headFilters ||= {};
  try {
    const [heads, snaps] = await Promise.all([
      probeCardHeads(cardId),
      probeCardSnaps(cardId),
    ]);
    stateEl.textContent = '';
    const sortedHeads = heads.slice().sort(byName);
    const sortedSnaps = snaps.slice().sort(byName);
    if (!sortedHeads.length) { host.innerHTML = '<div class="muted">No heads on this card.</div>'; return; }

    sortedHeads.forEach((h) => {
      const key = `${cardId}::${h.uuid}`;
      const det = document.createElement('details');
      det.className = 'head-filter';
      const sum = document.createElement('summary');
      const countText = () => {
        const arr = config.headFilters[key];
        return arr && arr.length ? `${arr.length} allowed` : 'all allowed';
      };
      sum.innerHTML = `<span class="hf-name">${esc(h.name || h.uuid)}</span> <span class="hf-count muted"></span>`;
      sum.querySelector('.hf-count').textContent = `— ${countText()}`;
      det.appendChild(sum);

      const list = document.createElement('div'); list.className = 'snaplist';

      // Group snapshots by folder (path), matching the operator view: natural-sorted
      // folder headers, blank path bucketed as "Ungrouped" and shown last.
      const groups = new Map();
      sortedSnaps.forEach((s) => {
        const gkey = s.path && s.path.trim() ? s.path : '\uffffUngrouped';
        if (!groups.has(gkey)) groups.set(gkey, []);
        groups.get(gkey).push(s);
      });
      const orderedKeys = [...groups.keys()].sort((a, b) => collator.compare(a, b));

      orderedKeys.forEach((gkey) => {
        const folderLabel = gkey === '\uffffUngrouped' ? 'Ungrouped' : gkey;
        const folderSnaps = groups.get(gkey);

        const fh = document.createElement('div');
        fh.className = 'snap-folder-head';
        fh.innerHTML = `<label class="sfh-all"><input type="checkbox"><span></span></label>`;
        fh.querySelector('span').textContent = folderLabel;
        const folderCb = fh.querySelector('input');
        list.appendChild(fh);

        // Per-snapshot checkboxes, tracked so the header box can drive/reflect them.
        const snapBoxes = [];
        const refreshFolderBox = () => {
          const on = snapBoxes.filter((b) => b.checked).length;
          folderCb.checked = on === snapBoxes.length && on > 0;
          folderCb.indeterminate = on > 0 && on < snapBoxes.length;
        };

        folderSnaps.forEach((s) => {
          const checked = (config.headFilters[key] || []).includes(s.uuid);
          const lab = document.createElement('label');
          lab.innerHTML = `<input type="checkbox" ${checked ? 'checked' : ''}><span>${esc(s.name)}</span>`;
          const cb = lab.querySelector('input');
          cb.dataset.uuid = s.uuid;
          snapBoxes.push(cb);
          cb.addEventListener('change', (e) => {
            let arr = config.headFilters[key] ? [...config.headFilters[key]] : [];
            if (e.target.checked) arr.push(s.uuid); else arr = arr.filter(u => u !== s.uuid);
            if (arr.length) config.headFilters[key] = arr; else delete config.headFilters[key];
            sum.querySelector('.hf-count').textContent = `— ${countText()}`;
            refreshFolderBox();
          });
          list.appendChild(lab);
        });

        // Header checkbox: select/deselect every snapshot in this folder at once.
        folderCb.addEventListener('change', (e) => {
          const want = e.target.checked;
          let arr = config.headFilters[key] ? [...config.headFilters[key]] : [];
          folderSnaps.forEach((s) => {
            const has = arr.includes(s.uuid);
            if (want && !has) arr.push(s.uuid);
            else if (!want && has) arr = arr.filter(u => u !== s.uuid);
          });
          if (arr.length) config.headFilters[key] = arr; else delete config.headFilters[key];
          snapBoxes.forEach((b) => { b.checked = want; });
          sum.querySelector('.hf-count').textContent = `— ${countText()}`;
          refreshFolderBox();
        });

        refreshFolderBox();
      });
      det.appendChild(list);
      host.appendChild(det);
    });
  } catch (e) {
    stateEl.textContent = 'Error: ' + e.message;
  }
}

const reloadBtn = $('reload');
if (reloadBtn) reloadBtn.addEventListener('click', loadConfig);
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

    config = parsed;
    config.cards ||= []; config.panels ||= [];
    config.headFilters ||= {};
    config.panelGroups ||= [];
    config.settings ||= { showUuids: true };
    $('showUuids').checked = config.settings.showUuids !== false;
    renderCards(); renderPanels(); renderHeadFilterCards();
    $('saveState').textContent = 'Imported — review and Save config to apply';
    toast('Backup loaded into editor. Review, then Save config.', 'ok');
  } catch (err) {
    toast('Import failed: ' + err.message, 'err');
  }
});

// ---- Board API activity log ----------------------------------------------

let lastLogId = 0;
let logTimer = null;

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour12: false }) + '.' +
    String(d.getMilliseconds()).padStart(3, '0');
}

async function refreshLog(reset = false) {
  if (reset) { lastLogId = 0; $('logRows').innerHTML = ''; }
  try {
    const res = await fetch(`/api/admin/log?since=${lastLogId}`, { headers: headers() });
    if (!res.ok) throw new Error(res.status);
    const { entries } = await res.json();
    const tb = $('logRows');
    entries.forEach((e) => {
      lastLogId = Math.max(lastLogId, e.id);
      const tr = document.createElement('tr');
      const statusTxt = e.status != null ? e.status : (e.error || 'ERR');
      const statusColor = e.ok ? 'var(--fire)' : 'var(--danger)';
      tr.innerHTML = `
        <td class="mono" style="font-size:12px">${fmtTime(e.ts)}</td>
        <td class="mono">${esc(e.method || '')}</td>
        <td class="mono" style="font-size:12px">${esc((e.ip || '') + (e.path || ''))}</td>
        <td class="mono" style="color:${statusColor}">${esc(statusTxt)}</td>
        <td class="mono">${e.durationMs ?? ''}</td>
        <td style="font-size:12px;color:var(--ink-dim)" title="${esc((e.detail || e.error || '').toString())}">${esc((e.detail || e.error || '').toString().slice(0,300))}</td>`;
      tb.prepend(tr); // newest on top
    });
    // Trim DOM to 200 rows
    while (tb.children.length > 200) tb.removeChild(tb.lastChild);
    $('logState').textContent = `updated ${new Date().toLocaleTimeString([], {hour12:false})}`;
  } catch (e) {
    $('logState').textContent = 'log error: ' + e.message;
  }
}

function startLogAuto() {
  stopLogAuto();
  if ($('logAuto').checked) logTimer = setInterval(refreshLog, 2000);
}
function stopLogAuto() { if (logTimer) { clearInterval(logTimer); logTimer = null; } }

$('logRefresh').addEventListener('click', () => refreshLog());
$('logAuto').addEventListener('change', startLogAuto);
$('logClear').addEventListener('click', async () => {
  await fetch('/api/admin/log', { method: 'DELETE', headers: headers() });
  refreshLog(true);
});

// Per-card reach test buttons (rebuilt whenever cards change).
function renderReachRow() {
  const row = $('reachRow'); row.innerHTML = '';
  config.cards.forEach((c) => {
    if (!c.id) return;
    const b = document.createElement('button');
    b.className = 'btn sm ghost';
    b.textContent = `Test ${c.label || c.id}`;
    b.addEventListener('click', async () => {
      b.textContent = `Testing ${c.label || c.id}…`;
      try {
        const res = await fetch(`/api/admin/cards/${encodeURIComponent(c.id)}/reach`, { headers: headers() });
        const r = await res.json();
        if (r.ok) toast(`${c.label}: reachable (${r.product || 'OK'} ${r.version || ''}, ${r.durationMs}ms)`, 'ok');
        else toast(`${c.label}: ${r.error}${r.detail ? ' — ' + r.detail : ''}`, 'err');
      } catch (e) { toast(`${c.label}: ${e.message}`, 'err'); }
      b.textContent = `Test ${c.label || c.id}`;
      refreshLog();
    });
    row.appendChild(b);
  });
}

// ---- Sync diagnostics -----------------------------------------------------

function renderSyncDiagCards() {
  const row = $('syncDiagCards'); if (!row) return;
  row.innerHTML = '';
  config.cards.forEach((c) => {
    if (!c.id) return;
    const check = document.createElement('button');
    check.className = 'btn sm ghost';
    check.textContent = `Check ${c.label || c.id}`;
    check.addEventListener('click', () => runSyncDiag(c));
    row.appendChild(check);
  });
  // One button to check every card in sequence.
  if (config.cards.some((c) => c.id)) {
    const all = document.createElement('button');
    all.className = 'btn sm';
    all.textContent = 'Check all';
    all.addEventListener('click', async () => {
      $('syncDiagOut').innerHTML = '';
      for (const c of config.cards) if (c.id) await runSyncDiag(c, true);
    });
    row.appendChild(all);
  }
}

async function runSyncDiag(card, append = false) {
  const out = $('syncDiagOut');
  if (!append) out.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'syncdiag-card';
  box.innerHTML = `<div class="syncdiag-title">${esc(card.label || card.id)} — checking…</div>`;
  out.appendChild(box);
  try {
    const d = await fetch(`/api/admin/cards/${encodeURIComponent(card.id)}/sync-diagnostics`, { headers: headers() }).then(r => r.json());
    if (!d.ok) { box.innerHTML = `<div class="syncdiag-title">${esc(card.label || card.id)}</div><div class="stor-err">${esc(d.error || 'error')}</div>`; return; }

    const sc = d.syncConfig || {};
    const syncBad = d.syncState && /fail/i.test(d.syncState);
    const activityBad = d.activity && /fail/i.test(d.activity);
    const fl = d.snapshotFlags || {};
    const rows = [];
    rows.push(`<tr><td>Sync enabled</td><td>${sc.enabled === true ? 'yes' : sc.enabled === false ? 'no' : '?'}${sc.target ? ' → ' + esc(String(sc.target)) : ''}${sc.intervalSeconds ? ' · every ' + esc(String(sc.intervalSeconds)) + 's' : ''}</td></tr>`);
    rows.push(`<tr><td>Activity</td><td class="${activityBad ? 'stor-err' : ''}">${esc(d.activity || '—')}</td></tr>`);
    rows.push(`<tr><td>Sync state</td><td class="${syncBad ? 'stor-err' : ''}">${esc(d.syncState || '—')}${d.syncMessage ? ' · ' + esc(d.syncMessage) : ''}</td></tr>`);
    if (fl.total != null) {
      rows.push(`<tr><td>Snapshots</td><td>${fl.total} total · ${fl.shared} shared · <b>${fl.unshared} unshared</b> · <b>${fl.readOnly} read-only</b> · ${fl.deleted} deleted</td></tr>`);
      if (fl.readOnly > 0) rows.push(`<tr><td>Read-only</td><td class="stor-anom">${esc(fl.readOnlySample.join(', '))}${fl.readOnly > fl.readOnlySample.length ? '…' : ''}</td></tr>`);
      if (fl.unshared > 0) rows.push(`<tr><td>Unshared</td><td class="stor-anom">${esc(fl.unsharedSample.join(', '))}${fl.unshared > fl.unsharedSample.length ? '…' : ''}</td></tr>`);
    }
    if (d.tasks && d.tasks.length) {
      d.tasks.forEach((t) => rows.push(`<tr><td>Task</td><td class="${/fail/i.test(t.state || '') ? 'stor-err' : ''}">${esc(t.name || '')}: ${esc(t.state || '')}${t.message ? ' · ' + esc(t.message) : ''}</td></tr>`));
    }
    box.innerHTML = `<div class="syncdiag-title">${esc(card.label || card.id)}</div>
      <table class="syncdiag-table"><tbody>${rows.join('')}</tbody></table>
      <div class="inline" style="margin-top:8px">
        <button class="btn sm ghost syncdiag-trigger">Trigger sync on this card</button>
        <span class="muted syncdiag-trigmsg"></span>
      </div>`;
    box.querySelector('.syncdiag-trigger').addEventListener('click', async (ev) => {
      const btn = ev.target; const msg = box.querySelector('.syncdiag-trigmsg');
      btn.disabled = true; msg.textContent = 'Triggering…';
      try {
        const r = await fetch(`/api/admin/cards/${encodeURIComponent(card.id)}/sync-trigger`, { method: 'POST', headers: headers() }).then(x => x.json());
        msg.textContent = r.ok ? `activity=${r.activity || '?'} · sync=${r.syncState || '?'}${r.syncMessage ? ' · ' + r.syncMessage : ''}` : `Error: ${r.error || 'failed'}`;
      } catch (e) { msg.textContent = 'Error: ' + e.message; }
      btn.disabled = false;
      refreshLog();
    });
    refreshLog();
  } catch (e) {
    box.innerHTML = `<div class="syncdiag-title">${esc(card.label || card.id)}</div><div class="stor-err">${esc(e.message)}</div>`;
  }
}

// ---- Widget geometry probe (test tool) ------------------------------------
// Fully reversible read-modify-write on one widget's geometry, to learn whether the board
// accepts fullscreen/overlapping/off-canvas geometry the native GUI blocks. Per-widget captured
// "original" geometry (gpSaved) drives the Restore button. Nothing is persisted to config.
const gpSaved = new Map();       // widgetUuid -> previous geometry captured on first apply
const gpSavedOrder = new Map();  // headUuid   -> original widget order captured on first reorder
let gpCtx = { cardId: '', headUuid: '', widgets: [] }; // last-loaded head, for Solo / Restore all

function renderGeomProbeCards() {
  const sel = $('gpCard'); if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">— select a card —</option>' +
    config.cards.filter((c) => c.id && c.ip)
      .map((c) => `<option value="${esc(c.id)}">${esc(c.label || c.id)}</option>`).join('');
  if (cur) sel.value = cur;
}

async function gpLoadHeads() {
  const cardId = $('gpCard').value;
  const headSel = $('gpHead');
  $('gpWidgets').innerHTML = ''; $('gpState').textContent = '';
  const ro = $('gpRestoreOrder'); if (ro) ro.disabled = true;
  headSel.innerHTML = '<option value="">— select a head —</option>';
  if (!cardId) return;
  headSel.innerHTML = '<option value="">Loading…</option>';
  try {
    const heads = await probeCardHeads(cardId); // [{uuid,name}]
    headSel.innerHTML = '<option value="">— select a head —</option>' +
      heads.map((h) => `<option value="${esc(h.uuid)}">${esc(h.name || h.uuid)}</option>`).join('');
  } catch (e) {
    headSel.innerHTML = `<option value="">Error: ${esc(e.message)}</option>`;
  }
}

function gpFmtGeom(g) {
  if (!g) return '—';
  const r = (n) => (typeof n === 'number' ? Math.round(n * 1000) / 1000 : n);
  return `x:${r(g.x)} y:${r(g.y)} w:${r(g.width)} h:${r(g.height)}`;
}
// Geometry equality with a small float tolerance — used to tell "board stored what we sent"
// from "board reverted/clamped it".
function gpGeomEq(a, b) {
  if (!a || !b) return false;
  const close = (x, y) => Math.abs((+x || 0) - (+y || 0)) < 0.0005;
  return close(a.x, b.x) && close(a.y, b.y) && close(a.width, b.width) && close(a.height, b.height);
}

async function gpLoadWidgets() {
  const cardId = $('gpCard').value, headUuid = $('gpHead').value;
  const host = $('gpWidgets'); host.innerHTML = '';
  if (!cardId || !headUuid) { $('gpState').textContent = 'Pick a card and a head first.'; return; }
  $('gpState').textContent = 'Loading widgets…';
  try {
    const widgets = await fetch(
      `/api/admin/cards/${encodeURIComponent(cardId)}/heads/${encodeURIComponent(headUuid)}/widgets`,
      { headers: headers() }).then((r) => r.json());
    if (!Array.isArray(widgets)) throw new Error(widgets.error || 'Failed to load widgets');
    gpCtx = { cardId, headUuid, widgets };
    const ro = $('gpRestoreOrder'); if (ro) ro.disabled = !gpSavedOrder.has(headUuid);
    gpUpdateRestoreAll();
    $('gpState').textContent = `${widgets.length} widget(s) — changes are live and reversible`;
    if (!widgets.length) { host.innerHTML = '<div class="muted">No widgets on this head.</div>'; return; }
    widgets.forEach((w) => host.appendChild(gpWidgetRow(cardId, headUuid, w)));
  } catch (e) { $('gpState').textContent = 'Error: ' + e.message; }
}

function gpWidgetRow(cardId, headUuid, w) {
  const box = document.createElement('div');
  box.className = 'syncdiag-card';
  const kind = w.hasGroup ? '● VIDEO' : '○ graphic';
  const types = (w.elementTypes && w.elementTypes.length) ? ' · ' + esc(w.elementTypes.join(', ')) : '';
  box.innerHTML = `
    <div class="syncdiag-title">${esc(w.name || w.uuid)}
      <span class="muted" style="font-size:11px; font-weight:400">${kind}${types}</span></div>
    <div class="muted mono" style="font-size:12px">current: <span class="gp-cur"></span></div>
    <div class="inline" style="gap:6px; margin-top:8px; flex-wrap:wrap">
      <button class="btn sm gp-solo">Solo (full + hide others)</button>
      <button class="btn sm ghost gp-hideothers">Hide others (keep this)</button>
      <button class="btn sm ghost gp-full">Set fullscreen (0,0,1,1)</button>
      <button class="btn sm ghost gp-hide">Hide (0,0,0,0)</button>
      <button class="btn sm ghost gp-restore" disabled>Restore size</button>
      <span class="inline" style="gap:4px; align-items:center">
        <span class="muted" style="font-size:12px">custom:</span>
        <input class="gp-x" style="width:56px" placeholder="x" inputmode="decimal">
        <input class="gp-y" style="width:56px" placeholder="y" inputmode="decimal">
        <input class="gp-w" style="width:56px" placeholder="w" inputmode="decimal">
        <input class="gp-h" style="width:56px" placeholder="h" inputmode="decimal">
        <button class="btn sm ghost gp-apply">Apply</button>
      </span>
    </div>
    <div class="inline" style="gap:6px; margin-top:6px; flex-wrap:wrap">
      <span class="muted" style="font-size:12px">z-order:</span>
      <button class="btn sm ghost gp-front">Bring to front (end of list)</button>
      <button class="btn sm ghost gp-back">Send to back (start of list)</button>
      <span class="muted" style="font-size:12px; margin-left:8px">contents:</span>
      <button class="btn sm ghost gp-elemoff">Hide (elements off)</button>
      <button class="btn sm ghost gp-elemon">Show (elements on)</button>
    </div>
    <div class="mono gp-out" style="font-size:12px; margin-top:6px; color:var(--ink-dim); word-break:break-word"></div>`;
  const out = box.querySelector('.gp-out');
  const curEl = box.querySelector('.gp-cur');
  const restoreBtn = box.querySelector('.gp-restore');
  curEl.textContent = gpFmtGeom(w.geometry);
  if (gpSaved.has(w.uuid)) restoreBtn.disabled = false; // survived a re-load while blown up

  const apply = async (geometry, label) => {
    out.textContent = `Applying ${label}…`;
    try {
      const r = await fetch(
        `/api/admin/cards/${encodeURIComponent(cardId)}/heads/${encodeURIComponent(headUuid)}/widgets/${encodeURIComponent(w.uuid)}/geometry`,
        { method: 'POST', headers: headers(), body: JSON.stringify({ geometry }) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        out.innerHTML = `<span class="stor-err">REJECTED — HTTP ${r.status}: ${esc(body.error || 'failed')}`
          + `${body.detail ? ' · ' + esc(String(body.detail)) : ''}</span>`;
        refreshLog();
        return false;
      }
      // Capture the original geometry the FIRST time we move this widget, so Restore is exact.
      if (body.previous && !gpSaved.has(w.uuid)) gpSaved.set(w.uuid, body.previous);
      curEl.textContent = gpFmtGeom(body.confirmed || body.applied || geometry);
      restoreBtn.disabled = !gpSaved.has(w.uuid);
      gpUpdateRestoreAll();
      // Compare what we sent to what the board actually stored. A mismatch means the board
      // silently reverted/clamped the write — the key thing to know for feasibility.
      const stuck = gpGeomEq(body.confirmed, geometry);
      if (body.confirmed && !stuck) {
        out.innerHTML = `<span class="stor-anom">STORED DIFFERENTLY — sent ${esc(gpFmtGeom(geometry))}, `
          + `board kept ${esc(gpFmtGeom(body.confirmed))}. The board did NOT accept this geometry.</span>`;
      } else {
        out.innerHTML = `<span style="color:var(--fire)">ACCEPTED — HTTP ${r.status}, board confirms ${esc(gpFmtGeom(body.confirmed || geometry))}. `
          + `Now check the wall: did the window actually move/hide, or does it still render?</span>`;
      }
      refreshLog();
      return true;
    } catch (e) { out.innerHTML = `<span class="stor-err">${esc(e.message)}</span>`; return false; }
  };

  box.querySelector('.gp-full').addEventListener('click',
    () => apply({ x: 0, y: 0, width: 1, height: 1 }, 'fullscreen'));
  box.querySelector('.gp-hide').addEventListener('click',
    () => apply({ x: 0, y: 0, width: 0, height: 0 }, 'hide (zero area)'));
  box.querySelector('.gp-apply').addEventListener('click', () => {
    const val = (cls) => parseFloat(box.querySelector(cls).value);
    const geometry = { x: val('.gp-x'), y: val('.gp-y'), width: val('.gp-w'), height: val('.gp-h') };
    if (Object.values(geometry).some((n) => Number.isNaN(n))) {
      out.innerHTML = '<span class="stor-err">Enter numeric x, y, w, h (fractions 0–1; try &gt;1 or &lt;0 to test off-canvas).</span>';
      return;
    }
    apply(geometry, 'custom');
  });
  restoreBtn.addEventListener('click', async () => {
    const prev = gpSaved.get(w.uuid);
    if (!prev) return;
    const okDone = await apply(prev, 'restore');
    if (okDone) { gpSaved.delete(w.uuid); restoreBtn.disabled = true; }
  });

  const reorder = async (position) => {
    const label = position === 'front' ? 'bring to front' : 'send to back';
    out.textContent = `Reordering (${label})…`;
    try {
      const r = await fetch(
        `/api/admin/cards/${encodeURIComponent(cardId)}/heads/${encodeURIComponent(headUuid)}/widgets/${encodeURIComponent(w.uuid)}/order`,
        { method: 'POST', headers: headers(), body: JSON.stringify({ position }) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        out.innerHTML = `<span class="stor-err">REJECTED — HTTP ${r.status}: ${esc(body.error || 'failed')}`
          + `${body.detail ? ' · ' + esc(String(body.detail)) : ''}</span>`;
        refreshLog();
        return;
      }
      // Capture the original order the FIRST time this head is reordered, for exact restore.
      if (body.previousOrder && !gpSavedOrder.has(headUuid)) gpSavedOrder.set(headUuid, body.previousOrder);
      const ro = $('gpRestoreOrder'); if (ro) ro.disabled = !gpSavedOrder.has(headUuid);
      out.innerHTML = `<span style="color:var(--fire)">ACCEPTED — HTTP ${r.status}, moved to ${position === 'front' ? 'end (front)' : 'start (back)'} of the list. `
        + `Check the wall: did this window's depth change as expected?</span>`;
      refreshLog();
    } catch (e) { out.innerHTML = `<span class="stor-err">${esc(e.message)}</span>`; }
  };
  box.querySelector('.gp-front').addEventListener('click', () => reorder('front'));
  box.querySelector('.gp-back').addEventListener('click', () => reorder('back'));
  box.querySelector('.gp-solo').addEventListener('click', () => gpSolo(w.uuid));
  box.querySelector('.gp-hideothers').addEventListener('click', () => gpHideOthers(w.uuid));

  const setVisible = async (visible) => {
    out.textContent = visible ? 'Showing elements…' : 'Hiding elements…';
    try {
      const r = await fetch(
        `/api/admin/cards/${encodeURIComponent(cardId)}/heads/${encodeURIComponent(headUuid)}/widgets/${encodeURIComponent(w.uuid)}/visible`,
        { method: 'POST', headers: headers(), body: JSON.stringify({ visible }) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        out.innerHTML = `<span class="stor-err">REJECTED — HTTP ${r.status}: ${esc(body.error || 'failed')}`
          + `${body.detail ? ' · ' + esc(String(body.detail)) : ''}</span>`;
        refreshLog();
        return;
      }
      const stored = Array.isArray(body.confirmed) ? `board stored visible=[${esc(body.confirmed.join(','))}]` : 'no read-back';
      out.innerHTML = `<span style="color:var(--fire)">ACCEPTED — elements visible=${visible}, ${stored}. `
        + `Check the wall: did this window ${visible ? 'come back' : 'go transparent (fullscreen behind showing through), or black/bordered'}?</span>`;
      refreshLog();
    } catch (e) { out.innerHTML = `<span class="stor-err">${esc(e.message)}</span>`; }
  };
  box.querySelector('.gp-elemoff').addEventListener('click', () => setVisible(false));
  box.querySelector('.gp-elemon').addEventListener('click', () => setVisible(true));
  return box;
}

// Hide every window EXCEPT the target, leaving the target untouched. Lets you separate the two
// halves of Solo: hide-others first (paced, deliberate), observe, THEN fullscreen the target on
// its own and watch whether the hidden windows come back — the behavior we're chasing.
async function gpHideOthers(keepUuid) {
  const { cardId, headUuid, widgets } = gpCtx;
  if (!cardId || !headUuid || !widgets.length) return;
  $('gpState').textContent = 'Hiding all other windows…';
  let failed = 0;
  for (const w of widgets) {
    if (w.uuid === keepUuid) continue;
    const res = await gpSetGeometry(cardId, headUuid, w.uuid, { x: 0, y: 0, width: 0, height: 0 });
    if (!res.ok) failed++;
  }
  refreshLog();
  $('gpState').textContent = failed
    ? `Hid others with ${failed} error(s) — check the API log.`
    : 'Others hidden (target untouched). Confirm they are gone, THEN fullscreen the target and watch whether the hidden windows reappear.';
  gpLoadWidgets();
}

// Set the flag on the head-level "Restore all sizes" button based on whether any widget on the
// currently-loaded head has a captured original geometry.
function gpUpdateRestoreAll() {
  const btn = $('gpRestoreAll'); if (!btn) return;
  btn.disabled = !gpCtx.widgets.some((w) => gpSaved.has(w.uuid));
}

// One geometry POST helper used by the multi-widget Solo / Restore-all flows. Captures the
// original geometry on the first move so it can be restored exactly. Returns true on success.
async function gpSetGeometry(cardId, headUuid, widgetUuid, geometry) {
  const r = await fetch(
    `/api/admin/cards/${encodeURIComponent(cardId)}/heads/${encodeURIComponent(headUuid)}/widgets/${encodeURIComponent(widgetUuid)}/geometry`,
    { method: 'POST', headers: headers(), body: JSON.stringify({ geometry }) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, status: r.status, error: body.error, detail: body.detail };
  if (body.previous && !gpSaved.has(widgetUuid)) gpSaved.set(widgetUuid, body.previous);
  return { ok: true };
}

// SOLO — the actual proposed mechanism, in prototype: target widget → fullscreen, every other
// widget on the head → zero area (hidden). This is the real test of whether "blow up one window"
// can produce a clean fullscreen despite the fixed z-order. Reversible via "Restore all sizes".
async function gpSolo(targetUuid) {
  const { cardId, headUuid, widgets } = gpCtx;
  if (!cardId || !headUuid || !widgets.length) return;
  $('gpState').textContent = 'Soloing (target → fullscreen, others → hidden)…';
  let failed = 0;
  for (const w of widgets) {
    const geometry = (w.uuid === targetUuid)
      ? { x: 0, y: 0, width: 1, height: 1 }
      : { x: 0, y: 0, width: 0, height: 0 };
    const res = await gpSetGeometry(cardId, headUuid, w.uuid, geometry);
    if (!res.ok) failed++;
  }
  refreshLog();
  $('gpState').textContent = failed
    ? `Solo applied with ${failed} error(s) — check the API log. Then check the wall.`
    : 'Solo applied — is the target now cleanly fullscreen with the others gone? “Restore all sizes” undoes it.';
  gpLoadWidgets(); // refresh rows + button states from the board's new state
}

// Restore every captured original geometry on the currently-loaded head (undo a Solo).
async function gpRestoreAllSizes() {
  const { cardId, headUuid, widgets } = gpCtx;
  if (!cardId || !headUuid) return;
  $('gpState').textContent = 'Restoring all sizes…';
  let failed = 0;
  for (const w of widgets) {
    const prev = gpSaved.get(w.uuid);
    if (!prev) continue;
    const res = await gpSetGeometry(cardId, headUuid, w.uuid, prev);
    if (res.ok) gpSaved.delete(w.uuid); else failed++;
  }
  refreshLog();
  $('gpState').textContent = failed ? `Restore finished with ${failed} error(s) — check the API log.` : 'All sizes restored.';
  gpLoadWidgets();
}

// Restore a head's original widget z-order captured on the first reorder in this session.
async function gpRestoreOrder() {
  const headUuid = $('gpHead').value;
  const order = gpSavedOrder.get(headUuid);
  if (!headUuid || !order) return;
  const cardId = $('gpCard').value;
  $('gpState').textContent = 'Restoring original z-order…';
  try {
    const r = await fetch(`/api/admin/cards/${encodeURIComponent(cardId)}/heads/${encodeURIComponent(headUuid)}/order`,
      { method: 'POST', headers: headers(), body: JSON.stringify({ widgets: order }) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { $('gpState').textContent = `Restore failed: ${body.error || r.status}`; refreshLog(); return; }
    gpSavedOrder.delete(headUuid);
    $('gpRestoreOrder').disabled = true;
    $('gpState').textContent = 'Original z-order restored.';
    refreshLog();
  } catch (e) { $('gpState').textContent = 'Error: ' + e.message; }
}

// Auto-share is now edited inline: the Enabled toggle, interval, and card chips mutate
// config.shareSweep directly, and the main "Save config" button persists it (its own Save
// button was removed to avoid two confusing save buttons). "Run once now" stays as an action.
async function refreshSweep() {
  try {
    // Only the live status comes from the server now; the settings live in the held config.
    const s = await fetch('/api/admin/sharesweep', { headers: headers() }).then(r => r.json());
    config.shareSweep ||= { enabled: false, intervalSec: 60, targets: [] };
    $('swEnabled').checked = !!config.shareSweep.enabled;
    $('swInterval').value = config.shareSweep.intervalSec || 60;
    renderSweepCards();
    const when = s.lastRun ? new Date(s.lastRun).toLocaleTimeString() : 'never';
    $('sweepState').textContent = `Last run ${when}` + (s.lastError ? ` · ${s.lastError}` : ` · shared ${s.shared || 0}, checked ${s.checked || 0}`);
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
    const s = await fetch('/api/admin/sharesweep/run', { method: 'POST', headers: headers() }).then(r => r.json());
    $('sweepState').textContent = `Shared ${s.shared || 0}, checked ${s.checked || 0}`;
  } catch (e) { $('sweepState').textContent = 'Error: ' + e.message; }
});

// ---- Backup ---------------------------------------------------------------

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

async function refreshBackup() {
  try {
    // Settings live in the held config now; only the file list + run status come from server.
    const data = await fetch('/api/admin/backup', { headers: headers() }).then(r => r.json());
    const c = (config.backup ||= { enabled: false, cardId: '', timeHHMM: '03:00', retentionCount: 30, configRetentionDays: 30 });
    $('bkEnabled').checked = !!c.enabled;
    $('bkTime').value = c.timeHHMM || '03:00';
    $('bkRetention').value = c.retentionCount || c.retentionDays || 30;
    $('bkConfigDays').value = c.configRetentionDays || 30;
    // Populate board dropdown from current cards.
    $('bkCard').innerHTML = '<option value="">— select —</option>' +
      config.cards.filter(x => x.id).map(x => `<option value="${esc(x.id)}"${x.id === c.cardId ? ' selected' : ''}>${esc(x.label || x.id)}</option>`).join('');
    renderBackupFiles(data.files || []);
    const st = data.status || {};
    if (st.lastRun) $('bkState').textContent = `Last backup ${new Date(st.lastRun).toLocaleString()}` + (st.lastError ? ` · ${st.lastError}` : '');
  } catch (e) { $('bkState').textContent = 'Error: ' + e.message; }
}

// Backup form edits update the held config immediately (persisted on the main Save config).
function wireBackupInputs() {
  const c = () => (config.backup ||= { enabled: false, cardId: '', timeHHMM: '03:00', retentionCount: 30, configRetentionDays: 30 });
  $('bkEnabled').addEventListener('change', (e) => { c().enabled = e.target.checked; });
  $('bkCard').addEventListener('change', (e) => { c().cardId = e.target.value; });
  $('bkTime').addEventListener('input', (e) => { c().timeHHMM = e.target.value.trim(); });
  $('bkRetention').addEventListener('input', (e) => { c().retentionCount = parseInt(e.target.value, 10) || 30; });
  $('bkConfigDays').addEventListener('input', (e) => { c().configRetentionDays = parseInt(e.target.value, 10) || 30; });
}
wireBackupInputs();

function renderBackupFiles(files) {
  const tb = $('bkFiles'); tb.innerHTML = '';
  const totalEl = $('bkTotal');
  if (totalEl) {
    const total = files.reduce((sum, f) => sum + (f.bytes || 0), 0);
    totalEl.textContent = files.length
      ? `${files.length} file${files.length === 1 ? '' : 's'} · ${fmtBytes(total)} used on server`
      : '';
  }
  if (!files.length) { tb.innerHTML = '<tr><td colspan="5" class="muted">No backups yet.</td></tr>'; return; }

  // Group files by their date key so each row is one nightly run, with the full-board
  // archive, the snapshot zip, and the config snapshot in separate columns.
  const byDate = new Map();
  for (const f of files) {
    const key = f.dateKey || (f.file.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1] || f.file;
    if (!byDate.has(key)) byDate.set(key, { date: key, board: null, zip: null, config: null, mtime: f.mtime });
    const row = byDate.get(key);
    if (f.kind === 'zip') row.zip = f;
    else if (f.kind === 'config') row.config = f;
    else row.board = f;
    row.mtime = Math.max(row.mtime, f.mtime);
  }
  const rows = [...byDate.values()].sort((a, b) => b.mtime - a.mtime);

  const cell = (f) => {
    if (!f) return '<span class="muted">—</span>';
    return `<div class="bk-cell">
        <span class="bk-sz muted">${fmtBytes(f.bytes)}</span>
        <a class="btn sm ghost" href="/api/admin/backup/download/${encodeURIComponent(f.file)}" download title="${esc(f.file)}">Download</a>
        <button class="btn sm del" data-file="${esc(f.file)}">Delete</button>
      </div>`;
  };

  rows.forEach((r) => {
    const tr = document.createElement('tr');
    const time = r.mtime ? new Date(r.mtime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
    tr.innerHTML = `<td class="bk-date">${esc(r.date)}</td>
      <td class="bk-time">${time}</td>
      <td>${cell(r.board)}</td>
      <td>${cell(r.zip)}</td>
      <td>${cell(r.config)}</td>`;
    tr.querySelectorAll('button[data-file]').forEach((btn) => {
      btn.addEventListener('click', () => deleteBackup(btn.getAttribute('data-file')));
    });
    tb.appendChild(tr);
  });
}

async function deleteBackup(file) {
  if (!confirm(`Delete backup "${file}"? This cannot be undone.`)) return;
  try {
    const r = await fetch(`/api/admin/backup/files/${encodeURIComponent(file)}`, { method: 'DELETE', headers: headers() });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
    const files = await fetch('/api/admin/backup/files', { headers: headers() }).then(r => r.json());
    renderBackupFiles(files.files || []);
    $('bkState').textContent = `Deleted ${file}`;
  } catch (e) { $('bkState').textContent = 'Delete failed: ' + e.message; }
}

$('bkRun').addEventListener('click', async () => {
  if (!config.backup || !config.backup.cardId) { $('bkState').textContent = 'Pick a board first.'; return; }
  $('bkState').textContent = 'Saving & backing up… (may take a moment)';
  try {
    // Persist current settings via the main config save so the run uses exactly what's on
    // screen (backup settings are now part of the main config, no separate endpoint).
    await saveConfig();
    const s = await fetch('/api/admin/backup/run', { method: 'POST', headers: headers() }).then(r => r.json());
    $('bkState').textContent = s.lastError ? `Error: ${s.lastError}` : `Wrote ${(s.lastFiles || []).length} file(s)`;
    // Refresh only the file list, not the whole form, so the selection is preserved.
    const files = await fetch('/api/admin/backup/files', { headers: headers() }).then(r => r.json());
    renderBackupFiles(files.files || []);
  } catch (e) { $('bkState').textContent = 'Error: ' + e.message; }
});

const logoutBtn = $('logoutBtn');
if (logoutBtn) logoutBtn.addEventListener('click', logout);

// Verify the session up front. If it's already expired, the fetch wrapper redirects to
// login; otherwise loadConfig() proceeds. (The page load itself is also server-gated.)
fetch('/api/admin/session').then((r) => { if (r.ok) loadConfig(); });
refreshLog(true);
startLogAuto();

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

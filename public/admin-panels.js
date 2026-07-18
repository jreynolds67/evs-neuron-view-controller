// public/admin-panels.js
// The Panels tab (master-detail panel editor, groups, head assignment, layout editor) and
// the Setup tab's cards table with its storage readout. Loaded after admin-core.js.

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
  tb.querySelectorAll('input').forEach((inp) => {
    // Snapshot the id at focus so an id edit can be cascaded from old → new on commit.
    let originalId = inp.dataset.f === 'id' ? inp.value : null;
    inp.addEventListener('focus', (e) => {
      if (e.target.dataset.f === 'id') originalId = e.target.value;
    });
    inp.addEventListener('input', (e) => {
      const { i, f } = e.target.dataset; config.cards[+i][f] = e.target.value;
      // The board-probe caches are keyed by card id, so a changed IP leaves them pointing at
      // the OLD board for the rest of the page's life — drop them so the next probe is fresh.
      if (f === 'ip') {
        cardHeadsCache.delete(config.cards[+i].id);
        cardSnapsCache.delete(config.cards[+i].id);
      }
      if (f === 'label') renderPanels(); // panels show card labels in the head source line
      // NOTE: id changes are handled on 'change' (below), not here — cascading references on
      // every keystroke would chase a half-typed id.
    });
    inp.addEventListener('change', (e) => {
      if (e.target.dataset.f !== 'id') return;
      const newId = config.cards[+e.target.dataset.i].id; // already set by the input handler
      if (newId === originalId) return;
      // Renaming a card id must move every reference with it, or the head assignments, layout
      // slots, head filters, backup target, and sweep targets silently orphan (heads show
      // "(missing card)"; filters/target just stop matching). Cascade, then refresh caches.
      if (originalId && newId) renameCardIdReferences(originalId, newId);
      cardHeadsCache.delete(originalId); cardSnapsCache.delete(originalId);
      cardHeadsCache.delete(newId); cardSnapsCache.delete(newId);
      originalId = newId;
      renderPanels(); renderHeadFilterCards();
    });
  });
  tb.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', (e) => {
    config.cards.splice(+e.target.dataset.del, 1); renderCards(); renderPanels();
  }));
  renderReachRow();
  renderSyncDiagCards();
  renderHeadFilterCards();
  loadAllStorage();
}

// Fetch and render snapshot-storage usage for every card with an IP. The boards report their
// own total, so the percentage is against the BOARD-REPORTED total — shown only when the
// board reports one. When it doesn't, we show the used amount alone (no invented
// denominator). Bar turns amber past 75% and red past 90%. The board's activity/sync state
// is surfaced too.
async function loadAllStorage() {
  for (const c of config.cards) {
    if (!c.id) continue;
    const slot = document.querySelector(`[data-stor="${cssEsc(c.id)}"]`);
    if (!slot) continue;
    if (!c.ip) { slot.innerHTML = '<span class="stor-idle muted">no IP</span>'; continue; }
    slot.innerHTML = '<span class="stor-idle muted">…</span>';
    try {
      const r = await adminFetch(`/api/admin/cards/${encodeURIComponent(c.id)}/storage`, { headers: headers() });
      const d = await r.json();
      if (!d.ok) { slot.innerHTML = `<span class="stor-err" title="${esc(d.detail || d.error || 'error')}">unreachable</span>`; continue; }

      const mb = (b) => (b / (1024 * 1024)).toFixed(1);
      const usedMB = d.usedBytes != null ? mb(d.usedBytes) : '?';
      // Show the board's activity/state when it's anything other than plain idle, and flag a
      // failed sync prominently.
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

// Cascade a card-id rename across everything keyed by card id: panel head assignments, layout
// grid slots, the "cardId::headUuid" head-filter keys, the backup target, and sweep targets.
// Without this, renaming a card id orphans all of them at once — heads render "(missing card)"
// and filters/target quietly stop matching.
function renameCardIdReferences(oldId, newId) {
  (config.panels || []).forEach((p) => {
    (p.heads || []).forEach((h) => { if (h.cardId === oldId) h.cardId = newId; });
    (p.layoutGrid || []).forEach((slot) => {
      if (slot && slot.type === 'head' && slot.cardId === oldId) slot.cardId = newId;
    });
  });
  if (config.headFilters) {
    Object.keys(config.headFilters).forEach((key) => {
      const idx = key.indexOf('::');
      if (idx > 0 && key.slice(0, idx) === oldId) {
        config.headFilters[newId + key.slice(idx)] = config.headFilters[key];
        delete config.headFilters[key];
      }
    });
  }
  if (config.backup && config.backup.cardId === oldId) config.backup.cardId = newId;
  if (config.shareSweep && Array.isArray(config.shareSweep.targets)) {
    config.shareSweep.targets = config.shareSweep.targets.map((t) => (t === oldId ? newId : t));
  }
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
// order }]. Cards are only the source you pick heads from.

// Cache of probed board data per card so we don't re-hit boards repeatedly.
const cardHeadsCache = new Map();   // cardId -> [{uuid,name}]
const cardSnapsCache = new Map();   // cardId -> [{uuid,name}]

// A failed probe MUST throw, never resolve to []. Callers treat an empty list as "the board
// has no such head" — refreshAllHeadNames/relinkHeadsByName flag every head on the card as
// missing, which claims a full board restore replaced the head IDs. An unreachable board would
// otherwise produce that alarm on every head, report zero unreachable cards (nothing threw),
// and persist bogus `missing` flags on the next Save. Failures are also left UNCACHED, so a
// retry re-probes instead of being served the failure for the rest of the page's life.
async function probeCard(cache, cardId, path) {
  if (cache.has(cardId)) return cache.get(cardId);
  const res = await adminFetch(`/api/admin/cards/${encodeURIComponent(cardId)}/${path}`, { headers: headers() });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Card unreachable (HTTP ${res.status})`);
  }
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('Card returned an unexpected response');
  cache.set(cardId, data);
  return data;
}
async function probeCardHeads(cardId) { return probeCard(cardHeadsCache, cardId, 'heads'); }
async function probeCardSnaps(cardId) { return probeCard(cardSnapsCache, cardId, 'snapshots'); }

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
    // (reorder groups). Which one is decided from the drag kind (dataTransfer.getData() is
    // only readable on `drop`, not during `dragover`, hence the module-level tracker).
    head.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (currentDragKind === 'group' && !isUngrouped) {
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
      if (currentDragKind === 'group') {
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

// Column count for a given layout value (the panel's `layout` field, "1080" | "strip").
// The server computes the same mapping for the operator view in /api/panel/me.
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
  const cols = colsForLayout(p.layout);
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

// Duplicate a panel: deep-copy everything (heads, layout grid, all panel settings) EXCEPT
// the IP — each panel is keyed by its unique IP, so the copy starts blank for you to fill in.
// (Snapshot filters aren't panel state — they're global per head in config.headFilters — so
// there's nothing panel-level to copy there.) The label gets a " (copy)" suffix. Inserted
// right after the original.
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
      const byLiveName = new Map();
      for (const h of heads) if (h.name) byLiveName.set(h.name, h.uuid);
      liveByCard.set(cardId, byLiveName);
    } catch { failedCards.push(cardId); }
  }

  let relinked = 0, alreadyOk = 0, unmatched = 0;
  const unmatchedDetail = [];

  config.panels.forEach((p, pi) => {
    (p.heads || []).forEach((h) => {
      const byLiveName = liveByCard.get(h.cardId);
      if (!byLiveName) return; // card unreachable — leave untouched

      // Already valid? (UUID still live under this name) — nothing to do.
      const liveUuidForName = h.boardName ? byLiveName.get(h.boardName) : null;
      if (liveUuidForName && liveUuidForName === h.headUuid) { delete h.missing; alreadyOk++; return; }

      if (!h.boardName || !byLiveName.has(h.boardName)) {
        // No name to match on, or no live head with that name — cannot safely re-link.
        h.missing = true; unmatched++;
        unmatchedDetail.push(`${p.label || p.ip || `Panel ${pi + 1}`}: ${h.boardName || h.headUuid}`);
        return;
      }

      const newUuid = byLiveName.get(h.boardName);
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

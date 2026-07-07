// public/admin.js
let config = { cards: [], panels: [] };
const $ = (id) => document.getElementById(id);

// Natural alphanumeric sort ("2 Boxes" < "9 Boxes" < "10 Boxes").
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const byName = (a, b) => collator.compare(a.name || '', b.name || '');

// Admin token was removed from the UI. These stubs keep the request helpers working
// (no token is ever sent — the server treats a missing token as "open").
function token() { return ''; }
function headers() {
  return { 'Content-Type': 'application/json' };
}
function setLoadState(msg) { const el = $('loadState'); if (el) el.textContent = msg; }
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
    config.settings ||= { showUuids: true };
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
      <td><input value="${c.id || ''}" data-i="${i}" data-f="id"></td>
      <td><input value="${c.label || ''}" data-i="${i}" data-f="label"></td>
      <td><input value="${c.ip || ''}" data-i="${i}" data-f="ip" placeholder="10.10.60.x"></td>
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
  if (typeof renderHeadFilterCards === 'function') renderHeadFilterCards();
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
  const heads = await fetch(`/api/admin/cards/${cardId}/heads`, { headers: headers() }).then(r => r.json());
  const list = Array.isArray(heads) ? heads : [];
  cardHeadsCache.set(cardId, list);
  return list;
}
async function probeCardSnaps(cardId) {
  if (cardSnapsCache.has(cardId)) return cardSnapsCache.get(cardId);
  const snaps = await fetch(`/api/admin/cards/${cardId}/snapshots`, { headers: headers() }).then(r => r.json());
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
  if (!config.panels.length) {
    listCol.innerHTML = '<div class="muted" style="padding:10px">No panels yet. Add one below.</div>';
  }
  config.panels.forEach((p, pi) => {
    const item = document.createElement('button');
    item.className = 'panel-list-item' + (pi === selectedPanel ? ' active' : '');
    const name = p.label || p.ip || `Panel ${pi + 1}`;
    const sub = p.ip && p.label ? p.ip : (p.layout === 'strip' ? 'CTP' : '1920×1080');
    item.innerHTML = `<span class="pli-name"></span><span class="pli-sub muted"></span>`;
    item.querySelector('.pli-name').textContent = name;
    item.querySelector('.pli-sub').textContent = sub;
    item.addEventListener('click', () => { selectedPanel = pi; renderPanels(); });
    listCol.appendChild(item);
  });

  renderPanelDetail(selectedPanel);
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
        <input value="${p.ip || ''}" data-pi="${pi}" data-f="ip" placeholder="10.10.61.11"></div>
      <div style="flex:1"><label class="muted">Label</label>
        <input value="${p.label || ''}" data-pi="${pi}" data-f="label" placeholder="PCR 101 Panel"></div>
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
    // Changing the layout type changes the fixed column count (7 ↔ 8). The old grid was
    // laid out for the previous width, so its rows no longer line up — clear it so the
    // arrangement is rebuilt for the new shape, and re-render the editor.
    if (field === 'layout' && val !== prev) {
      config.panels[pi].layoutGrid = [];
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
// focus from the input being edited).
function refreshPanelListLabels() {
  const items = document.querySelectorAll('#panelListCol .panel-list-item');
  items.forEach((item, pi) => {
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

  p.heads.forEach((h, i) => {
    const card = config.cards.find((c) => c.id === h.cardId);
    const row = document.createElement('div');
    row.className = 'assigned-head';
    row.innerHTML = `
      <div class="ah-top">
        <span class="order-pos">${i + 1}</span>
        <input class="ah-label" placeholder="${h.boardName || 'Display label'}" value="${h.label || ''}">
        <span class="ah-source muted"></span>
        <label class="ah-all" title="Show all snapshots on this panel, ignoring the global head filter">
          <input type="checkbox" class="ah-all-cb" ${h.showAllSnapshots ? 'checked' : ''}>
          <span>All snapshots</span>
        </label>
        <button class="btn sm ghost ah-up" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn sm ghost ah-down" ${i === p.heads.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn sm del ah-del">Remove</button>
      </div>`;
    row.querySelector('.ah-source').textContent =
      `${card ? (card.label || card.id) : h.cardId + ' (missing card)'} · ${h.boardName || h.headUuid}`
      + (h.missing ? ' · ⚠ not found on board' : '');
    row.querySelector('.ah-label').addEventListener('input', (e) => { h.label = e.target.value; });
    row.querySelector('.ah-all-cb').addEventListener('change', (e) => {
      if (e.target.checked) h.showAllSnapshots = true; else delete h.showAllSnapshots;
    });
    row.querySelector('.ah-up').addEventListener('click', () => {
      [p.heads[i - 1], p.heads[i]] = [p.heads[i], p.heads[i - 1]]; renderHeadList(pi);
    });
    row.querySelector('.ah-down').addEventListener('click', () => {
      [p.heads[i + 1], p.heads[i]] = [p.heads[i], p.heads[i + 1]]; renderHeadList(pi);
    });
    row.querySelector('.ah-del').addEventListener('click', () => {
      p.heads.splice(i, 1); renderHeadList(pi); renderLayoutEditor(pi);
    });
    host.appendChild(row);
  });
}

// ---- Per-panel physical layout editor ------------------------------------
// Columns are FIXED (7 for 1080, 8 for strip) to preserve the operator-view scaling.
// The admin defines the number of ROWS and drags heads into a row-major grid. Each slot
// is a head ref or a blank spacer. Stored as panel.layoutGrid = [ slot, ... ] row-major.

function layoutCols(panel) { return panel.layout === 'strip' ? 8 : 7; }

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
    config.cards.filter(c => c.id).map(c => `<option value="${c.id}">${c.label || c.id}</option>`).join('');

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
        avail.map(h => `<option value="${h.uuid}">${h.name || h.uuid}</option>`).join('');
    } catch (e) {
      headSel.innerHTML = `<option value="">Error: ${e.message}</option>`;
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
  const liveByCard = new Map();
  for (const cardId of cardIds) {
    try {
      const heads = await probeCardHeads(cardId); // repopulates cache fresh
      liveByCard.set(cardId, new Map(heads.map((h) => [h.uuid, h.name || ''])));
    } catch (e) {
      failedCards.push(cardId);
    }
  }

  config.panels.forEach((p) => {
    (p.heads || []).forEach((h) => {
      const live = liveByCard.get(h.cardId);
      if (!live) return; // card poll failed; leave as-is
      if (live.has(h.headUuid)) {
        const name = live.get(h.headUuid);
        if (name && name !== h.boardName) { h.boardName = name; updated++; }
        delete h.missing;
      } else {
        h.missing = true; missing++;
      }
    });
  });

  renderPanels();
  // Refresh the global filter section's shown names too, if a card is selected there.
  if ($('hfCard').value) renderGlobalHeadFilters($('hfCard').value);

  stateEl.textContent = `Updated ${updated} name${updated === 1 ? '' : 's'}`
    + (missing ? `, ${missing} head${missing === 1 ? '' : 's'} not found on board` : '')
    + (failedCards.length ? `, ${failedCards.length} card${failedCards.length === 1 ? '' : 's'} unreachable` : '')
    + '. Save config to keep.';
}

$('refreshAllNames').addEventListener('click', refreshAllHeadNames);

// ---- Global per-head snapshot filters -------------------------------------

function renderHeadFilterCards() {
  const sel = $('hfCard');
  const cur = sel.value;
  sel.innerHTML = '<option value="">— select a card —</option>' +
    config.cards.filter(c => c.id).map(c => `<option value="${c.id}">${c.label || c.id}</option>`).join('');
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
      sum.innerHTML = `<span class="hf-name">${h.name || h.uuid}</span> <span class="hf-count muted"></span>`;
      sum.querySelector('.hf-count').textContent = `— ${countText()}`;
      det.appendChild(sum);

      const list = document.createElement('div'); list.className = 'snaplist';
      sortedSnaps.forEach((s) => {
        const checked = (config.headFilters[key] || []).includes(s.uuid);
        const lab = document.createElement('label');
        lab.innerHTML = `<input type="checkbox" ${checked ? 'checked' : ''}><span>${s.name}</span>`;
        lab.querySelector('input').addEventListener('change', (e) => {
          let arr = config.headFilters[key] ? [...config.headFilters[key]] : [];
          if (e.target.checked) arr.push(s.uuid); else arr = arr.filter(u => u !== s.uuid);
          if (arr.length) config.headFilters[key] = arr; else delete config.headFilters[key];
          sum.querySelector('.hf-count').textContent = `— ${countText()}`;
        });
        list.appendChild(lab);
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
        <td class="mono">${e.method || ''}</td>
        <td class="mono" style="font-size:12px">${(e.ip || '') + (e.path || '')}</td>
        <td class="mono" style="color:${statusColor}">${statusTxt}</td>
        <td class="mono">${e.durationMs ?? ''}</td>
        <td style="font-size:12px;color:var(--ink-dim)">${(e.detail || e.error || '').toString().slice(0,160)}</td>`;
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
        const res = await fetch(`/api/admin/cards/${c.id}/reach`, { headers: headers() });
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

// ---- Share sweep ----------------------------------------------------------

let sweepCfg = { enabled: false, intervalSec: 60, targets: [] };

async function refreshSweep() {
  try {
    const [cfg, s] = await Promise.all([
      fetch('/api/admin/sharesweep/config', { headers: headers() }).then(r => r.json()),
      fetch('/api/admin/sharesweep', { headers: headers() }).then(r => r.json()),
    ]);
    sweepCfg = { enabled: !!cfg.enabled, intervalSec: cfg.intervalSec || 60, targets: Array.isArray(cfg.targets) ? cfg.targets : [] };
    $('swEnabled').checked = sweepCfg.enabled;
    $('swInterval').value = sweepCfg.intervalSec;
    renderSweepCards();
    const when = s.lastRun ? new Date(s.lastRun).toLocaleTimeString() : 'never';
    $('sweepState').textContent = `Last run ${when}` + (s.lastError ? ` · ${s.lastError}` : ` · shared ${s.shared || 0}, checked ${s.checked || 0}`);
  } catch (e) { $('sweepState').textContent = 'Error: ' + e.message; }
}

// Per-card enable chips. Empty targets means "all cards" — represented here by every
// chip being on; toggling any off makes the set explicit.
function renderSweepCards() {
  const host = $('swCards'); host.innerHTML = '';
  const allSelected = sweepCfg.targets.length === 0;
  config.cards.filter(c => c.id).forEach((c) => {
    const on = allSelected || sweepCfg.targets.includes(c.id);
    const chip = document.createElement('button');
    chip.className = 'chip' + (on ? ' on' : '');
    chip.textContent = c.label || c.id;
    chip.addEventListener('click', () => {
      // Materialize "all" into an explicit list on first toggle.
      let list = sweepCfg.targets.length ? [...sweepCfg.targets]
        : config.cards.filter(x => x.id).map(x => x.id);
      if (list.includes(c.id)) list = list.filter(x => x !== c.id); else list.push(c.id);
      sweepCfg.targets = list;
      renderSweepCards();
    });
    host.appendChild(chip);
  });
}

$('swSave').addEventListener('click', async () => {
  $('sweepState').textContent = 'Saving…';
  try {
    const body = {
      enabled: $('swEnabled').checked,
      intervalSec: parseInt($('swInterval').value, 10) || 60,
      targets: sweepCfg.targets,
    };
    const r = await fetch('/api/admin/sharesweep', { method: 'PUT', headers: headers(), body: JSON.stringify(body) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
    $('sweepState').textContent = 'Saved' + (body.enabled ? ` · sweeping every ${body.intervalSec}s` : ' · disabled');
  } catch (e) { $('sweepState').textContent = 'Error: ' + e.message; }
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
    const data = await fetch('/api/admin/backup', { headers: headers() }).then(r => r.json());
    const c = data.config || {};
    $('bkEnabled').checked = !!c.enabled;
    $('bkTime').value = c.timeHHMM || '03:00';
    $('bkRetention').value = c.retentionDays || 30;
    // Populate board dropdown from current cards.
    $('bkCard').innerHTML = '<option value="">— select —</option>' +
      config.cards.filter(x => x.id).map(x => `<option value="${x.id}"${x.id === c.cardId ? ' selected' : ''}>${x.label || x.id}</option>`).join('');
    renderBackupFiles(data.files || []);
    const st = data.status || {};
    if (st.lastRun) $('bkState').textContent = `Last backup ${new Date(st.lastRun).toLocaleString()}` + (st.lastError ? ` · ${st.lastError}` : '');
  } catch (e) { $('bkState').textContent = 'Error: ' + e.message; }
}

function renderBackupFiles(files) {
  const tb = $('bkFiles'); tb.innerHTML = '';
  if (!files.length) { tb.innerHTML = '<tr><td colspan="4" class="muted">No backups yet.</td></tr>'; return; }
  files.forEach((f) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="mono" style="font-size:12px">${f.file}</td>
      <td>${fmtBytes(f.bytes)}</td>
      <td>${new Date(f.mtime).toLocaleString()}</td>
      <td class="inline" style="gap:6px">
        <a class="btn sm ghost bk-dl" href="/api/admin/backup/download/${encodeURIComponent(f.file)}" download>Download</a>
        <button class="btn sm del bk-del">Delete</button>
      </td>`;
    // If a token is set, downloads need the header — use a JS handler instead of a bare link.
    if (token()) {
      const a = tr.querySelector('.bk-dl');
      a.removeAttribute('href');
      a.addEventListener('click', () => downloadWithToken(f.file));
    }
    tr.querySelector('.bk-del').addEventListener('click', () => deleteBackup(f.file));
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

async function downloadWithToken(file) {
  const res = await fetch(`/api/admin/backup/download/${encodeURIComponent(file)}`, { headers: headers() });
  if (!res.ok) { toast('Download failed', 'err'); return; }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = file; document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

$('bkSave').addEventListener('click', async () => {
  $('bkState').textContent = 'Saving…';
  try {
    const body = {
      enabled: $('bkEnabled').checked,
      cardId: $('bkCard').value,
      timeHHMM: $('bkTime').value.trim(),
      retentionDays: parseInt($('bkRetention').value, 10) || 30,
    };
    const r = await fetch('/api/admin/backup', { method: 'PUT', headers: headers(), body: JSON.stringify(body) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
    $('bkState').textContent = 'Schedule saved';
  } catch (e) { $('bkState').textContent = 'Error: ' + e.message; }
});

$('bkRun').addEventListener('click', async () => {
  $('bkState').textContent = 'Saving & backing up… (may take a moment)';
  try {
    // Persist the current form selection FIRST, so the run uses exactly what's on screen
    // (avoids "no target" when the user picked a card but hadn't saved the schedule).
    const cfgBody = {
      enabled: $('bkEnabled').checked,
      cardId: $('bkCard').value,
      timeHHMM: $('bkTime').value.trim() || '03:00',
      retentionDays: parseInt($('bkRetention').value, 10) || 30,
    };
    if (!cfgBody.cardId) { $('bkState').textContent = 'Pick a board first.'; return; }
    const put = await fetch('/api/admin/backup', { method: 'PUT', headers: headers(), body: JSON.stringify(cfgBody) });
    if (!put.ok) throw new Error((await put.json().catch(() => ({}))).error || put.status);

    const s = await fetch('/api/admin/backup/run', { method: 'POST', headers: headers() }).then(r => r.json());
    $('bkState').textContent = s.lastError ? `Error: ${s.lastError}` : `Wrote ${(s.lastFiles || []).length} file(s)`;
    // Refresh only the file list, not the whole form, so the selection is preserved.
    const files = await fetch('/api/admin/backup/files', { headers: headers() }).then(r => r.json());
    renderBackupFiles(files.files || []);
  } catch (e) { $('bkState').textContent = 'Error: ' + e.message; }
});

loadConfig();
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

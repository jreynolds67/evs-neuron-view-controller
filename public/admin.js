// public/admin.js
let config = { cards: [], panels: [] };
const $ = (id) => document.getElementById(id);

// Natural alphanumeric sort ("2 Boxes" < "9 Boxes" < "10 Boxes").
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const byName = (a, b) => collator.compare(a.name || '', b.name || '');

function token() { return $('token').value.trim(); }
function headers() {
  const h = { 'Content-Type': 'application/json' };
  if (token()) h['x-admin-token'] = token();
  return h;
}
function toast(msg, kind = '') {
  const t = $('toast'); t.textContent = msg; t.className = `toast show ${kind}`;
  clearTimeout(toast._t); toast._t = setTimeout(() => t.className = 'toast', 3000);
}

async function loadConfig() {
  $('loadState').textContent = 'Loading…';
  try {
    const res = await fetch('/api/admin/config', { headers: headers() });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
    config = await res.json();
    config.cards ||= []; config.panels ||= [];
    config.headFilters ||= {};
    config.settings ||= { showUuids: true };
    $('showUuids').checked = config.settings.showUuids !== false;
    renderCards(); renderPanels(); renderHeadFilterCards();
    $('loadState').textContent = 'Loaded';
  } catch (e) { $('loadState').textContent = 'Error: ' + e.message; }
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

function renderPanels() {
  const host = $('panelList'); host.innerHTML = '';
  config.panels.forEach((p, pi) => {
    p.heads ||= [];
    const box = document.createElement('div');
    box.className = 'section'; box.style.background = 'var(--panel-2)';
    box.innerHTML = `
      <div class="inline" style="gap:12px">
        <div style="flex:1"><label class="muted">Panel IP</label>
          <input value="${p.ip || ''}" data-pi="${pi}" data-f="ip" placeholder="10.10.61.11"></div>
        <div style="flex:1"><label class="muted">Label</label>
          <input value="${p.label || ''}" data-pi="${pi}" data-f="label" placeholder="PCR 101 Panel"></div>
        <div style="width:200px"><label class="muted">Layout</label>
          <select data-pi="${pi}" data-f="layout">
            <option value="1080"${p.layout === '1080' ? ' selected' : ''}>1920 × 1080</option>
            <option value="strip"${p.layout === 'strip' ? ' selected' : ''}>1835 × 291 (strip)</option>
          </select></div>
        <div style="align-self:flex-end"><button class="btn sm del" data-delpanel="${pi}">Remove</button></div>
      </div>
      <div style="margin-top:14px">
        <label class="muted">Heads on this panel (in display order)</label>
        <div id="headList-${pi}" style="margin-top:6px"></div>
        <div class="inline" style="margin-top:8px">
          <button class="btn sm" data-addhead="${pi}">Add head</button>
          <span class="muted" id="addHeadState-${pi}"></span>
        </div>
        <div id="headPicker-${pi}"></div>
      </div>`;
    host.appendChild(box);

    box.querySelectorAll('[data-f]').forEach((el) => el.addEventListener('input', (e) => {
      config.panels[pi][e.target.dataset.f] = e.target.value;
    }));
    box.querySelector('[data-delpanel]').addEventListener('click', () => {
      config.panels.splice(pi, 1); renderPanels();
    });
    box.querySelector(`[data-addhead="${pi}"]`).addEventListener('click', () => openHeadPicker(pi));

    renderHeadList(pi);
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
      p.heads.splice(i, 1); renderHeadList(pi);
    });
    host.appendChild(row);
  });
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
  });

  picker.querySelector('.hp-cancel').addEventListener('click', () => { host.innerHTML = ''; });
}

$('addPanel').addEventListener('click', () => {
  config.panels.push({ ip: '', label: '', layout: '1080', heads: [] });
  renderPanels();
});

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

$('reload').addEventListener('click', loadConfig);
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

loadConfig();
refreshLog(true);
startLogAuto();

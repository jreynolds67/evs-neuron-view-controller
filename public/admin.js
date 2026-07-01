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
    renderCards(); renderPanels();
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
}

$('addCard').addEventListener('click', () => {
  const n = config.cards.length + 1;
  config.cards.push({ id: `mv${n}`, label: `MV Card ${n}`, ip: '' });
  renderCards(); renderPanels();
});

// ---- Panels ---------------------------------------------------------------

function renderPanels() {
  const host = $('panelList'); host.innerHTML = '';
  config.panels.forEach((p, pi) => {
    p.cardIds ||= []; p.snapshotFilters ||= {};
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
      <div style="margin-top:14px"><label class="muted">Cards this panel controls</label>
        <div class="inline" id="cardChips-${pi}" style="margin-top:6px"></div>
      </div>
      <div id="filters-${pi}" style="margin-top:14px"></div>`;
    host.appendChild(box);

    // field bindings
    box.querySelectorAll('[data-f]').forEach((el) => el.addEventListener('input', (e) => {
      config.panels[pi][e.target.dataset.f] = e.target.value;
    }));
    box.querySelector('[data-delpanel]').addEventListener('click', () => {
      config.panels.splice(pi, 1); renderPanels();
    });

    // card chips
    const chips = box.querySelector(`#cardChips-${pi}`);
    config.cards.forEach((c) => {
      if (!c.id) return;
      const on = p.cardIds.includes(c.id);
      const chip = document.createElement('button');
      chip.className = 'chip' + (on ? ' on' : '');
      chip.textContent = c.label || c.id;
      chip.addEventListener('click', () => {
        const idx = p.cardIds.indexOf(c.id);
        if (idx >= 0) p.cardIds.splice(idx, 1); else p.cardIds.push(c.id);
        renderPanels();
      });
      chips.appendChild(chip);
    });

    renderFilters(pi);
  });
}

// Per-head snapshot filters: for each assigned card, probe heads + snapshots,
// then let the admin restrict which snapshots appear for each head on this panel.
function renderFilters(pi) {
  const p = config.panels[pi];
  const host = $(`filters-${pi}`); host.innerHTML = '';
  if (!p.cardIds.length) return;

  const details = document.createElement('details');
  details.innerHTML = `<summary>Per-head snapshot filters (${Object.keys(p.snapshotFilters).length} set)</summary>`;
  const body = document.createElement('div');
  body.className = 'filterbox';
  body.innerHTML = `<div class="muted">Leave a head untouched to allow all its snapshots. Tick snapshots to restrict to only those.</div>
    <div class="inline" style="margin-top:8px">
      <button class="btn sm ghost" data-probe="${pi}">Probe cards (load heads &amp; snapshots)</button>
    </div>
    <div id="probeOut-${pi}" style="margin-top:10px"></div>`;
  details.appendChild(body); host.appendChild(details);

  body.querySelector(`[data-probe="${pi}"]`).addEventListener('click', () => probePanel(pi));
}

async function probePanel(pi) {
  const p = config.panels[pi];
  const out = $(`probeOut-${pi}`); out.innerHTML = 'Probing…';
  const blocks = [];
  for (const cardId of p.cardIds) {
    try {
      const [heads, snaps] = await Promise.all([
        fetch(`/api/admin/cards/${cardId}/heads`, { headers: headers() }).then(r => r.json()),
        fetch(`/api/admin/cards/${cardId}/snapshots`, { headers: headers() }).then(r => r.json()),
      ]);
      blocks.push({ cardId, heads, snaps });
    } catch (e) {
      blocks.push({ cardId, error: e.message });
    }
  }

  out.innerHTML = '';
  blocks.forEach(({ cardId, heads, snaps, error }) => {
    const card = config.cards.find(c => c.id === cardId);
    const wrap = document.createElement('div');
    wrap.style.marginBottom = '16px';
    wrap.innerHTML = `<div style="font-weight:600;margin-bottom:6px">${card?.label || cardId}</div>`;
    if (error) { wrap.innerHTML += `<div class="muted" style="color:var(--danger)">${error}</div>`; out.appendChild(wrap); return; }

    const sortedHeads = heads.slice().sort(byName);
    const sortedSnaps = snaps.slice().sort(byName);

    sortedHeads.forEach((h) => {
      const key = `${cardId}::${h.uuid}`;
      const selected = p.snapshotFilters[key] || null;

      // Collapsible per-head section. Collapsed by default to keep the page readable.
      const det = document.createElement('details');
      det.className = 'head-filter';
      const sum = document.createElement('summary');
      const countText = () => {
        const arr = p.snapshotFilters[key];
        return arr && arr.length ? `${arr.length} allowed` : 'all allowed';
      };
      sum.innerHTML = `<span class="hf-name">${h.name || h.uuid}</span> <span class="hf-count muted"></span>`;
      sum.querySelector('.hf-count').textContent = `— ${countText()}`;
      det.appendChild(sum);

      const list = document.createElement('div'); list.className = 'snaplist';
      sortedSnaps.forEach((s) => {
        const id = `f-${pi}-${cardId}-${h.uuid}-${s.uuid}`;
        const checked = selected ? selected.includes(s.uuid) : false;
        const lab = document.createElement('label');
        lab.innerHTML = `<input type="checkbox" id="${id}" ${checked ? 'checked' : ''}><span>${s.name}</span>`;
        lab.querySelector('input').addEventListener('change', (e) => {
          let arr = p.snapshotFilters[key] ? [...p.snapshotFilters[key]] : [];
          if (e.target.checked) arr.push(s.uuid); else arr = arr.filter(u => u !== s.uuid);
          if (arr.length) p.snapshotFilters[key] = arr; else delete p.snapshotFilters[key];
          sum.querySelector('.hf-count').textContent = `— ${countText()}`;
        });
        list.appendChild(lab);
      });
      det.appendChild(list);
      wrap.appendChild(det);
    });
    out.appendChild(wrap);
  });
}

$('addPanel').addEventListener('click', () => {
  config.panels.push({ ip: '', label: '', layout: '1080', cardIds: [], snapshotFilters: {} });
  renderPanels();
});

$('reload').addEventListener('click', loadConfig);
$('save').addEventListener('click', saveConfig);

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

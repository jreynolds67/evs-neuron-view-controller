// public/app.js
// Operator flow: Card -> live Head (target) -> Snapshot -> pick source head -> Confirm -> fire partial restore.
// The panel is identified server-side by its source IP; this client never sees board IPs.

const state = {
  panel: null,
  step: 'card',
  card: null,     // { id, label }
  head: null,     // target head { uuid, name }
  snap: null,     // { uuid, name, ... }
  srcHead: null,  // snapshot source head { uuid, name }
  showUuids: true,
};

const $ = (id) => document.getElementById(id);
const grid = $('grid');

// Natural alphanumeric sort so "2 Boxes" < "9 Boxes" < "10 Boxes" (not lexical).
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const byName = (a, b) => collator.compare(a.name || '', b.name || '');

function toast(msg, kind = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast show ${kind}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.className = 'toast'; }, 3200);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

function setSteps() {
  const order = ['card', 'head', 'snap', 'source', 'confirm'];
  const idx = order.indexOf(state.step);
  document.querySelectorAll('.step').forEach((el) => {
    const i = order.indexOf(el.dataset.step);
    el.classList.toggle('active', i === idx);
    el.classList.toggle('done', i < idx);
  });
  $('backBtn').disabled = state.step === 'card';
}

function cardEl({ k, v, uuid, onClick, selected }) {
  const b = document.createElement('button');
  b.className = 'card' + (selected ? ' selected' : '');
  const showUuid = uuid && state.showUuids;
  b.innerHTML = `<span class="k"></span>${v ? '<span class="v"></span>' : ''}${showUuid ? '<span class="uuid mono"></span>' : ''}`;
  b.querySelector('.k').textContent = k;
  if (v) b.querySelector('.v').textContent = v;
  if (showUuid) b.querySelector('.uuid').textContent = uuid;
  b.addEventListener('click', onClick);
  return b;
}

// ---- Head/snapshot preview renderer ---------------------------------------
// Draws a schematic of a head from normalized widgets: each widget is a rect placed by
// its fractional geometry on a 16:9 canvas, and its elements are drawn inside, styled by
// type (box/pip/audiobar/clock) with any literal colors and text labels.
const SVGNS = 'http://www.w3.org/2000/svg';
const ELEMENT_STYLE = {
  box:      { fill: 'rgba(63,182,255,0.10)', stroke: 'var(--accent)' },
  pip:      { fill: 'rgba(41,209,124,0.12)', stroke: 'var(--fire)' },
  audiobar: { fill: 'rgba(255,122,26,0.14)', stroke: 'var(--arm)' },
  clock:    { fill: 'rgba(139,152,165,0.14)', stroke: 'var(--ink-dim)' },
};

function buildPreviewSvg(widgets, { w = 320, h = 180 } = {}) {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('class', 'preview-svg');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  // canvas background
  const bg = document.createElementNS(SVGNS, 'rect');
  bg.setAttribute('x', 0); bg.setAttribute('y', 0);
  bg.setAttribute('width', w); bg.setAttribute('height', h);
  bg.setAttribute('class', 'preview-canvas');
  svg.appendChild(bg);

  if (!widgets || !widgets.length) {
    const t = document.createElementNS(SVGNS, 'text');
    t.setAttribute('x', w / 2); t.setAttribute('y', h / 2);
    t.setAttribute('class', 'preview-empty-text');
    t.setAttribute('text-anchor', 'middle');
    t.textContent = 'No widgets';
    svg.appendChild(t);
    return svg;
  }

  const clamp01 = (n) => Math.max(0, Math.min(1, n || 0));
  const rect = (x, y, ww, hh, cls, fill, stroke) => {
    const r = document.createElementNS(SVGNS, 'rect');
    r.setAttribute('x', x); r.setAttribute('y', y);
    r.setAttribute('width', Math.max(1, ww)); r.setAttribute('height', Math.max(1, hh));
    if (cls) r.setAttribute('class', cls);
    if (fill) r.setAttribute('fill', fill);
    if (stroke) r.setAttribute('stroke', stroke);
    return r;
  };

  widgets.forEach((wd) => {
    const g = wd.geometry || {};
    const wx = clamp01(g.x) * w, wy = clamp01(g.y) * h;
    const wW = clamp01(g.width) * w, wH = clamp01(g.height) * h;

    // widget frame
    svg.appendChild(rect(wx, wy, wW, wH, 'preview-widget'));

    (wd.elements || []).forEach((el) => {
      const eg = el.geometry || {};
      // element geometry is relative to the widget
      const ex = wx + clamp01(eg.x) * wW;
      const ey = wy + clamp01(eg.y) * wH;
      const eW = clamp01(eg.width) * wW;
      const eH = clamp01(eg.height) * wH;
      const style = ELEMENT_STYLE[el.type] || ELEMENT_STYLE.box;
      svg.appendChild(rect(ex, ey, eW, eH, 'preview-el', el.color || style.fill, el.borderColor || style.stroke));

      // audiobar: draw a few vertical ticks to suggest meters
      if (el.type === 'audiobar' && eW > 6 && eH > 6) {
        const bars = Math.min(6, Math.max(2, Math.floor(eW / 6)));
        for (let i = 0; i < bars; i++) {
          const bx = ex + 2 + i * ((eW - 4) / bars);
          svg.appendChild(rect(bx, ey + eH * 0.3, Math.max(1, (eW - 4) / bars - 1), eH * 0.6, 'preview-bar'));
        }
      }

      // text label if present and there is room
      if (el.text && eW > 20 && eH > 10) {
        const t = document.createElementNS(SVGNS, 'text');
        t.setAttribute('x', ex + eW / 2); t.setAttribute('y', ey + eH / 2);
        t.setAttribute('class', 'preview-label');
        t.setAttribute('text-anchor', 'middle');
        t.setAttribute('dominant-baseline', 'central');
        t.textContent = el.text.length > 18 ? el.text.slice(0, 17) + '…' : el.text;
        svg.appendChild(t);
      }
    });
  });

  return svg;
}

async function loadPreviewInto(container, url, emptyMsg) {
  container.innerHTML = '<div class="preview-loading">Loading preview…</div>';
  try {
    const data = await api(url);
    container.innerHTML = '';
    const svg = buildPreviewSvg(data.widgets || []);
    container.appendChild(svg);
    if (data.resolved === false) {
      const note = document.createElement('div');
      note.className = 'preview-note';
      note.textContent = 'Snapshot layout could not be fully read on this board.';
      container.appendChild(note);
    }
  } catch (e) {
    container.innerHTML = `<div class="preview-note err">${e.message}</div>`;
  }
}

function showEmpty(msg) {
  grid.innerHTML = '';
  const d = document.createElement('div');
  d.className = 'empty';
  d.textContent = msg;
  grid.appendChild(d);
}

// ---- Steps ----------------------------------------------------------------

async function renderCards() {
  state.step = 'card'; setSteps();
  $('stageTitle').textContent = 'Select a card';
  $('stageHint').textContent = '';
  grid.innerHTML = '';
  if (!state.panel.cards.length) return showEmpty('No cards assigned to this panel. Configure it in the admin page.');
  state.panel.cards.forEach((c) => {
    grid.appendChild(cardEl({
      k: c.label, v: null,
      selected: state.card?.id === c.id,
      onClick: () => { state.card = c; renderHeads(); },
    }));
  });
}

async function renderHeads() {
  state.step = 'head'; setSteps();
  state.head = null; state.snap = null; state.srcHead = null;
  $('stageTitle').textContent = 'Select a head';
  $('stageHint').textContent = state.card.label;
  showEmpty('Loading heads…');
  connectWs(state.card.id);
  try {
    const heads = await api(`/api/panel/cards/${state.card.id}/heads`);
    grid.innerHTML = '';
    if (!heads.length) return showEmpty('No heads reported by this card.');
    heads.sort(byName);
    heads.forEach((h) => {
      const card = document.createElement('button');
      card.className = 'card card-with-preview';
      card.innerHTML = `
        <div class="card-preview" data-prev></div>
        <div class="card-body">
          <span class="k"></span>
          <span class="uuid mono"></span>
        </div>`;
      card.querySelector('.k').textContent = h.name || 'Head';
      if (state.showUuids) card.querySelector('.uuid').textContent = h.uuid;
      else card.querySelector('.uuid').remove();
      card.addEventListener('click', () => { state.head = h; renderSnapshots(); });
      grid.appendChild(card);
      // Lazy-load the live layout thumbnail for this head.
      loadPreviewInto(
        card.querySelector('[data-prev]'),
        `/api/panel/cards/${state.card.id}/heads/${h.uuid}/preview`);
    });
  } catch (e) { showEmpty(e.message); }
}

async function renderSnapshots() {
  state.step = 'snap'; setSteps();
  state.snap = null; state.srcHead = null;
  $('stageTitle').textContent = 'Select a snapshot';
  $('stageHint').textContent = `${state.card.label} · ${state.head.name}`;
  showEmpty('Loading snapshots…');
  try {
    const { snapshots, state: boardState } = await api(
      `/api/panel/cards/${state.card.id}/heads/${state.head.uuid}/snapshots`);
    grid.innerHTML = '';
    if (boardState && boardState !== 'idle') {
      toast(`Board is busy: ${boardState}`, 'err');
    }
    if (!snapshots.length) return showEmpty('No snapshots available for this head.');

    // Group by folder (path). Blank path = "Ungrouped", shown last.
    const groups = new Map();
    snapshots.forEach((s) => {
      const key = s.path && s.path.trim() ? s.path : '\uffffUngrouped';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    });
    // Group keys sorted naturally; keep Ungrouped last via its sentinel prefix.
    const orderedKeys = [...groups.keys()].sort((a, b) => collator.compare(a, b));

    orderedKeys.forEach((key) => {
      const label = key === '\uffffUngrouped' ? 'Ungrouped' : key;
      const header = document.createElement('div');
      header.className = 'group-head';
      header.textContent = label;
      grid.appendChild(header);
      groups.get(key).sort(byName).forEach((s) => {
        const when = s.timestamp ? new Date(s.timestamp * 1000).toLocaleString() : '';
        grid.appendChild(cardEl({
          k: s.name, v: [s.description, when].filter(Boolean).join('  ·  '),
          onClick: () => pickSnapshot(s),
        }));
      });
    });
  } catch (e) { showEmpty(e.message); }
}

// After choosing a snapshot, resolve which source head inside it maps to the target.
async function pickSnapshot(s) {
  state.snap = s;
  state.srcHead = null;
  try {
    const { heads, parsed } = await api(
      `/api/panel/cards/${state.card.id}/snapshots/${s.uuid}/heads`);

    if (parsed && heads.length >= 1) {
      // Always show the Source step, even for a single option — the operator confirms
      // what they're selecting rather than being advanced past a step silently.
      return renderSourceHeads(heads);
    }
    // Could not parse heads from the snapshot model — do NOT guess. Guessing risks
    // mapping the wrong head, and we never fall back to a full restore.
    toast('Cannot read heads from this snapshot on this board. Restore blocked for safety.', 'err');
  } catch (e) { toast(e.message, 'err'); }
}

function renderSourceHeads(heads) {
  state.step = 'source'; setSteps();
  $('stageTitle').textContent = 'Select source head in snapshot';
  $('stageHint').textContent = `${state.snap.name} → ${state.head.name}`;
  grid.innerHTML = '';

  const sorted = heads.slice().sort(byName);
  const previewSlots = new Map(); // headUuid -> preview container

  sorted.forEach((h) => {
    const card = document.createElement('button');
    card.className = 'card card-with-preview' + (state.srcHead?.uuid === h.uuid ? ' selected' : '');
    card.innerHTML = `
      <div class="card-preview" data-prev></div>
      <div class="card-body">
        <span class="k"></span>
        <span class="uuid mono"></span>
      </div>`;
    card.querySelector('.k').textContent = h.name || 'Head';
    if (state.showUuids) card.querySelector('.uuid').textContent = h.uuid;
    else card.querySelector('.uuid').remove();
    card.addEventListener('click', () => { state.srcHead = h; openConfirm(); });
    grid.appendChild(card);
    const slot = card.querySelector('[data-prev]');
    slot.innerHTML = '<div class="preview-loading">Loading preview…</div>';
    previewSlots.set(h.uuid, slot);
  });

  // One batched request for ALL source-head layouts, then render each locally — far
  // faster than a separate model fetch per head.
  api(`/api/panel/cards/${state.card.id}/snapshots/${state.snap.uuid}/previews`)
    .then(({ heads: byHead }) => {
      previewSlots.forEach((slot, uuid) => {
        const widgets = (byHead && byHead[uuid]) || [];
        slot.innerHTML = '';
        slot.appendChild(buildPreviewSvg(widgets));
      });
    })
    .catch((e) => {
      previewSlots.forEach((slot) => {
        slot.innerHTML = `<div class="preview-note err">${e.message}</div>`;
      });
    });
}

// ---- Confirm + fire -------------------------------------------------------

function openConfirm() {
  state.step = 'confirm'; setSteps();
  // Compact one-line summary so the dialog fits the short strip panels.
  $('confirmLines').innerHTML = '<div class="confirm-summary"></div>';
  $('confirmLines').querySelector('.confirm-summary').textContent =
    `Load "${state.srcHead.name || state.srcHead.uuid}" onto ${state.head.name}?`;
  $('overlay').classList.add('show');
}

function closeConfirm() {
  $('overlay').classList.remove('show');
  state.step = 'source'; setSteps();
}

async function fire() {
  const fireBtn = $('fireBtn');
  fireBtn.disabled = true; fireBtn.textContent = 'Loading…';
  try {
    await api(`/api/panel/cards/${state.card.id}/snapshots/${state.snap.uuid}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        snapshotHeadUuid: state.srcHead.uuid,
        targetHeadUuid: state.head.uuid,
      }),
    });
    $('overlay').classList.remove('show');
    toast(`Loaded "${state.snap.name}" onto ${state.head.name}`, 'ok');
    // Return to the snapshot list for the same head so repeat recalls are quick.
    state.srcHead = null;
    renderSnapshots();
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    fireBtn.disabled = false; fireBtn.textContent = 'Load snapshot';
  }
}

// ---- Navigation -----------------------------------------------------------

function back() {
  if (state.step === 'head') return renderCards();
  if (state.step === 'snap') return renderHeads();
  if (state.step === 'source') return renderSnapshots();
  if (state.step === 'confirm') return closeConfirm();
}

function restart() {
  state.card = state.head = state.snap = state.srcHead = null;
  renderCards();
}

// ---- Live status (WebSocket) ----------------------------------------------

let ws = null;
function connectWs(cardId) {
  if (ws) { try { ws.close(); } catch {} ws = null; }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?card=${encodeURIComponent(cardId)}`);
  ws.onopen = () => setLink(true);
  ws.onclose = () => setLink(false);
  ws.onerror = () => setLink(false);
  ws.onmessage = () => { /* board pushed an update; lists refresh on next navigation */ };
}
function setLink(ok) {
  const p = $('linkPill');
  p.textContent = ok ? 'live' : 'offline';
  p.className = 'pill ' + (ok ? 'ok' : 'bad');
}

// ---- Boot -----------------------------------------------------------------

async function boot() {
  $('backBtn').addEventListener('click', back);
  $('restartBtn').addEventListener('click', restart);
  $('cancelBtn').addEventListener('click', closeConfirm);
  $('fireBtn').addEventListener('click', fire);

  try {
    state.panel = await api('/api/panel/me');
    state.showUuids = state.panel.showUuids !== false;
    document.body.classList.toggle('strip', state.panel.layout === 'strip');
    $('panelLabel').textContent = state.panel.label || 'Neuron MV Control';
    $('panelSub').textContent = `${state.panel.ip} · ${state.panel.cards.length} card(s)`;
    renderCards();
  } catch (e) {
    $('panelSub').textContent = 'This panel is not registered.';
    showEmpty(`${e.message}. Add this panel's IP in the admin page.`);
  }
}
boot();

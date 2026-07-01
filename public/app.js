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
};

const $ = (id) => document.getElementById(id);
const grid = $('grid');

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
  b.innerHTML = `<span class="k"></span>${v ? '<span class="v"></span>' : ''}${uuid ? '<span class="uuid mono"></span>' : ''}`;
  b.querySelector('.k').textContent = k;
  if (v) b.querySelector('.v').textContent = v;
  if (uuid) b.querySelector('.uuid').textContent = uuid;
  b.addEventListener('click', onClick);
  return b;
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
    heads.forEach((h) => {
      grid.appendChild(cardEl({
        k: h.name || 'Head', uuid: h.uuid,
        onClick: () => { state.head = h; renderSnapshots(); },
      }));
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
    const orderedKeys = [...groups.keys()].sort();

    orderedKeys.forEach((key) => {
      const label = key === '\uffffUngrouped' ? 'Ungrouped' : key;
      const header = document.createElement('div');
      header.className = 'group-head';
      header.textContent = label;
      grid.appendChild(header);
      groups.get(key).forEach((s) => {
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
  heads.forEach((h) => {
    grid.appendChild(cardEl({
      k: h.name || 'Head', uuid: h.uuid,
      selected: state.srcHead?.uuid === h.uuid,
      onClick: () => { state.srcHead = h; openConfirm(); },
    }));
  });
}

// ---- Confirm + fire -------------------------------------------------------

function openConfirm() {
  state.step = 'confirm'; setSteps();
  const lines = [
    ['Card', state.card.label],
    ['Target head', `${state.head.name}`],
    ['Snapshot', state.snap.name],
    ['Source head', state.srcHead.name || state.srcHead.uuid],
    ['Scope', 'This head only — no other settings change'],
  ];
  $('confirmLines').innerHTML = lines.map(([l, v]) =>
    `<div class="cline"><span class="lbl">${l}</span><span class="val"></span></div>`).join('');
  document.querySelectorAll('#confirmLines .val').forEach((el, i) => { el.textContent = lines[i][1]; });
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

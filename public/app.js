// public/app.js
// Operator flow: Card -> live Head (target) -> Snapshot -> pick source head -> Confirm -> fire partial restore.
// The panel is identified server-side by its source IP; this client never sees board IPs.

const state = {
  panel: null,
  step: 'head',
  head: null,     // assigned head { cardId, headUuid, label }
  snap: null,     // { uuid, name, ... }
  srcHead: null,  // snapshot source head { uuid, name }
  showUuids: true,
  showAllActive: false, // temporary "Show all" override on the snapshot step
};

const $ = (id) => document.getElementById(id);
const grid = $('grid');

// Stale-response guard. Each navigation (step change, Back, restart, picking a head or
// snapshot) bumps navSeq. An async render captures the value before its await and bails if
// navSeq has since moved — meaning the operator navigated away while a slow board fetch was
// in flight. Without this, a response arriving after Back reads a now-null state.snap/head
// and throws, wedging the UI. bumpNav() returns the new token for the caller to capture.
let navSeq = 0;
function bumpNav() { return ++navSeq; }
function navStale(token) { return token !== navSeq; }

// Natural alphanumeric sort so "2 Boxes" < "9 Boxes" < "10 Boxes" (not lexical).
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const byName = (a, b) => collator.compare(a.name || '', b.name || '');

function toast(msg, kind = '') {
  // When the fullscreen input editor is open it covers the page, hiding the normal toast.
  // Route to the overlay's own toast so the operator sees errors without closing the editor.
  const fsOpen = $('fsOverlay') && $('fsOverlay').classList.contains('show');
  const t = fsOpen ? $('fsToast') : $('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = `toast${fsOpen ? ' fs-toast' : ''} show ${kind}`;
  clearTimeout(t._t);
  t._t = setTimeout(() => { t.className = `toast${fsOpen ? ' fs-toast' : ''}`; }, 3200);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `Request failed (${res.status})`);
    err.body = body;        // preserve fields like `ip` for callers
    err.status = res.status;
    err.code = body.code || null; // e.g. 'RECALLED' for a concurrent-recall conflict
    throw err;
  }
  return body;
}

function setSteps() {
  const order = ['head', 'snap', 'source', 'confirm'];
  const idx = order.indexOf(state.step);
  document.querySelectorAll('.step').forEach((el) => {
    const i = order.indexOf(el.dataset.step);
    el.classList.toggle('active', i === idx);
    el.classList.toggle('done', i < idx);
  });
  $('backBtn').disabled = state.step === 'head';
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

async function loadPreviewInto(container, url, { quiet = false } = {}) {
  // On the first load, show a placeholder — there's nothing to display yet. On a background
  // refresh (quiet), leave the existing preview visible and only swap it once the new SVG is
  // built, so a periodic poll doesn't flicker "Loading preview…" every few seconds.
  if (!quiet) container.innerHTML = '<div class="preview-loading">Loading preview…</div>';
  try {
    const data = await api(url);
    const next = document.createDocumentFragment();
    next.appendChild(buildPreviewSvg(data.widgets || []));
    if (data.resolved === false) {
      const note = document.createElement('div');
      note.className = 'preview-note';
      note.textContent = 'Snapshot layout could not be fully read on this board.';
      next.appendChild(note);
    }
    container.replaceChildren(next); // atomic swap — no intermediate empty state
  } catch (e) {
    // On a quiet refresh, keep the last good preview rather than replacing it with an error
    // (a transient poll failure shouldn't blank a working preview). Only surface errors on
    // an explicit load.
    if (!quiet) {
      if (e.code === 'HEAD_STALE') {
        // The head's board UUID changed (typically a board software update). Show a clear,
        // non-technical explanation in the tile instead of a raw board error.
        container.innerHTML = '<div class="preview-note stale">'
          + '<strong>Head ID changed on the board</strong>'
          + '<span>This usually happens after a board software update. '
          + 'Ask an administrator to open Settings and use “Re-link heads by name.”</span>'
          + '</div>';
      } else {
        const n = document.createElement('div');
        n.className = 'preview-note err';
        n.textContent = e.message;
        container.replaceChildren(n);
      }
    }
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

async function renderHeads() {
  bumpNav();
  state.step = 'head'; setSteps();
  state.head = null; state.snap = null; state.srcHead = null;
  state.showAllActive = false; // heads view always starts from the filtered state
  clearShowAllButton();        // the footer toggle only belongs on the snapshot step
  $('stageTitle').textContent = 'Select a head';
  $('stageHint').textContent = '';
  grid.innerHTML = '';

  const slots = state.panel.grid || [];
  const cols = state.panel.cols || (state.panel.layout === 'strip' ? 8 : 7);

  // The operator view is entirely placement-driven: heads appear only where the admin
  // placed them in the panel's layout grid. No layout → nothing to show.
  const hasHead = slots.some((s) => s && s.type === 'head');
  if (!slots.length || !hasHead) {
    grid.classList.remove('head-grid-fixed');
    grid.style.removeProperty('--layout-cols');
    return showEmpty('This panel has no layout yet. Arrange its heads in the admin page.');
  }

  // Fixed-column grid using today's exact cell width (240px / 200px). The column count is
  // fixed (7 or 8); rows grow as needed and the grid scrolls vertically. This preserves
  // the current card scaling exactly — cells are the same size they are today.
  grid.classList.add('head-grid-fixed');
  grid.style.setProperty('--layout-cols', String(cols));

  slots.forEach((slot) => {
    // Blank (or unresolved) slot: occupies one cell, shows nothing.
    if (!slot || slot.type !== 'head') {
      const blank = document.createElement('div');
      blank.className = 'layout-blank';
      grid.appendChild(blank);
      return;
    }

    const h = slot; // { cardId, headUuid, label }
    const card = document.createElement('button');
    card.className = 'card card-with-preview';
    card.innerHTML = `
      <div class="card-preview" data-prev></div>
      <div class="card-body">
        <span class="k"></span>
        <span class="uuid mono"></span>
      </div>
      <button class="expand-btn" title="Full screen inputs" aria-label="Full screen inputs">⤢</button>`;
    card.querySelector('.k').textContent = h.label || 'Head';
    if (state.showUuids) card.querySelector('.uuid').textContent = h.headUuid;
    else card.querySelector('.uuid').remove();
    card.addEventListener('click', () => { state.head = h; state.showAllActive = false; stopPreviewPolling(); renderSnapshots(); });

    // Fullscreen input-group editor is 1920x1080 only — not on the strip.
    const expand = card.querySelector('.expand-btn');
    if (state.panel.layout === 'strip') {
      expand.remove();
    } else {
      expand.addEventListener('click', (e) => {
        e.stopPropagation();
        openFullscreen(h);
      });
    }

    grid.appendChild(card);
    const prevSlot = card.querySelector('[data-prev]');
    const prevUrl = `/api/panel/cards/${h.cardId}/heads/${h.headUuid}/preview`;
    prevSlot.dataset.prevUrl = prevUrl; // remembered so a live board update can refresh it
    loadPreviewInto(prevSlot, prevUrl);
  });

  // Poll to keep these previews current, so a recall from another panel shows up here.
  startPreviewPolling();
}

// Render the "Show all" toggle into the footer slot. Only appears on the snapshot step
// and only when this panel is permitted to show all. Clearing the slot removes it.
function renderShowAllButton() {
  const slot = $('showAllSlot');
  if (!slot) return;
  slot.innerHTML = '';
  if (!state.panel || !state.panel.allowShowAll) return;
  const btn = document.createElement('button');
  btn.className = 'btn ghost showall-btn' + (state.showAllActive ? ' on' : '');
  btn.textContent = state.showAllActive ? 'Showing all — tap to filter' : 'Show all snapshots';
  btn.addEventListener('click', () => { state.showAllActive = !state.showAllActive; renderSnapshots(); });
  slot.appendChild(btn);
}
function clearShowAllButton() {
  const slot = $('showAllSlot');
  if (slot) slot.innerHTML = '';
}

async function renderSnapshots() {
  const token = bumpNav();
  state.step = 'snap'; setSteps();
  state.snap = null; state.srcHead = null;
  $('stageTitle').textContent = 'Select a snapshot';
  $('stageHint').textContent = state.head.label;
  showEmpty('Loading snapshots…');
  try {
    const qs = state.showAllActive ? '?showAll=1' : '';
    const { snapshots, state: boardState } = await api(
      `/api/panel/cards/${state.head.cardId}/heads/${state.head.headUuid}/snapshots${qs}`);
    if (navStale(token)) return; // operator navigated away during the fetch
    grid.innerHTML = '';
    if (boardState && boardState !== 'idle') {
      toast(`Board is busy: ${boardState}`, 'err');
    }

    // "Show all" control lives in the footer action bar (centered), not in the snapshot
    // grid. Only shown when the panel permits it; reverts automatically on navigation away.
    renderShowAllButton();

    if (!snapshots.length) {
      const note = document.createElement('div');
      note.className = 'empty-note';
      note.textContent = 'No snapshots available for this head.';
      grid.appendChild(note);
      return;
    }

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
  const token = bumpNav();
  state.snap = s;
  state.srcHead = null;
  state.showAllActive = false; // clicking into a snapshot reverts the temporary override
  clearShowAllButton();        // leaving the snapshot step hides the footer toggle
  try {
    const { heads, parsed } = await api(
      `/api/panel/cards/${state.head.cardId}/snapshots/${s.uuid}/heads`);
    if (navStale(token)) return; // operator tapped Back (etc.) during the fetch

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
  const token = navSeq; // pickSnapshot already bumped; capture the current value
  state.step = 'source'; setSteps();
  // Defensive: if state was cleared underneath us (e.g. Start Over between the heads
  // fetch resolving and this render), abort rather than dereference a null snap/head.
  if (!state.snap || !state.head) return;
  $('stageTitle').textContent = 'Select source head in snapshot';
  $('stageHint').textContent = `${state.snap.name} → ${state.head.label}`;
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
  api(`/api/panel/cards/${state.head.cardId}/snapshots/${state.snap.uuid}/previews`)
    .then(({ heads: byHead }) => {
      if (navStale(token)) return; // navigated away (Back/Start Over) while previews loaded
      previewSlots.forEach((slot, uuid) => {
        const widgets = (byHead && byHead[uuid]) || [];
        slot.innerHTML = '';
        slot.appendChild(buildPreviewSvg(widgets));
      });
    })
    .catch((e) => {
      if (navStale(token)) return;
      previewSlots.forEach((slot) => {
        // Board-originated text can reach e.message — never interpolate it into HTML.
        const n = document.createElement('div');
        n.className = 'preview-note err';
        n.textContent = e.message;
        slot.replaceChildren(n);
      });
    });
}

// ---- Confirm + fire -------------------------------------------------------

function openConfirm() {
  state.step = 'confirm'; setSteps();
  // Compact one-line summary so the dialog fits the short strip panels.
  $('confirmLines').innerHTML = '<div class="confirm-summary"></div>';
  $('confirmLines').querySelector('.confirm-summary').textContent =
    `Load "${state.srcHead.name || state.srcHead.uuid}" onto ${state.head.label}?`;
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
    await api(`/api/panel/cards/${state.head.cardId}/snapshots/${state.snap.uuid}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        snapshotHeadUuid: state.srcHead.uuid,
        targetHeadUuid: state.head.headUuid,
      }),
    });
    $('overlay').classList.remove('show');
    toast(`Loaded "${state.snap.name}" onto ${state.head.label}`, 'ok');
    // Return to the heads view after a successful load.
    state.head = state.snap = state.srcHead = null;
    renderHeads();
  } catch (e) {
    if (e.code === 'BOARD_BUSY') {
      // Board mid-operation — safe to retry shortly, nothing was applied.
      toast(e.message, 'err');
    } else {
      // Any other failure: the restore MAY have partially applied on the board, so tell the
      // operator to verify rather than implying a clean failure that invites a blind re-fire.
      toast(`${e.message} — the load may not have completed. Check the head before retrying.`, 'err');
    }
  } finally {
    fireBtn.disabled = false; fireBtn.textContent = 'Load snapshot';
  }
}

// ---- Navigation -----------------------------------------------------------

function back() {
  bumpNav(); // invalidate any in-flight fetch from the step we're leaving
  state.showAllActive = false; // any back-navigation reverts the temporary override
  if (state.step === 'snap') return renderHeads();
  if (state.step === 'source') return renderSnapshots();
  if (state.step === 'confirm') return closeConfirm();
}

function restart() {
  state.head = state.snap = state.srcHead = null;
  state.showAllActive = false;
  renderHeads();
}

// ---- Scheduled-backup failure banner (1080 panels only) --------------------
// Polls the server for the most recent SCHEDULED backup failure and shows a persistent,
// dismissible banner. Dismiss is per-failure: we remember the dismissed failure's timestamp,
// so a NEW failure (different `at`) re-shows, but the one the operator dismissed stays hidden.
let bkBannerPollTimer = null;
let bkDismissedAt = null;

function bkFailureText(failure) {
  const when = failure.at ? new Date(failure.at).toLocaleString() : 'recently';
  if (failure.reason === 'empty') {
    return `Scheduled snapshot backup at ${when} found no snapshots on the board to back up.`;
  }
  // export / target / generic error all read as a backup failure to the operator.
  return `Scheduled snapshot backup failed at ${when}.`;
}

function renderBkBanner(failure) {
  const el = $('bkBanner');
  if (!el) return;
  if (!failure || (bkDismissedAt !== null && failure.at === bkDismissedAt)) {
    el.classList.remove('show');
    return;
  }
  $('bkBannerMsg').textContent = bkFailureText(failure);
  el.classList.add('show');
  el._at = failure.at; // remember which failure is showing, so dismiss targets this one
}

async function pollBkBanner() {
  try {
    const { failure } = await api('/api/panel/backup-status');
    renderBkBanner(failure);
  } catch { /* leave current banner state on a transient poll failure */ }
}

function startBkBannerPolling() {
  if (bkBannerPollTimer) return;
  pollBkBanner(); // immediate first check
  bkBannerPollTimer = setInterval(() => { if (!document.hidden) pollBkBanner(); }, 30000);
}

// ---- Live status ----------------------------------------------------------

let previewPollTimer = null;   // interval that refreshes head previews on the heads view
let previewRefreshTimer = null;

// Keep head previews current while the heads view is showing. The Neuron boards don't emit
// a usable WebSocket event on a partial restore, so instead of relying on a live push we
// poll: re-fetch the visible previews on a fixed interval. This is what makes a recall done
// from ANOTHER panel appear here without the operator navigating. Polling only runs on the
// heads view and is cleared the moment we leave it, so it adds no load elsewhere.
// Base interval plus per-cycle random jitter so panels don't all poll in the same instant
// (a config-save reload would otherwise re-synchronize every panel's timer into a herd).
const PREVIEW_POLL_MS = 5000;
const POLL_JITTER_MS = 2000;
function nextPollDelay() { return PREVIEW_POLL_MS + Math.floor(Math.random() * POLL_JITTER_MS); }

function startPreviewPolling() {
  stopPreviewPolling();
  const tick = () => {
    if (state.step !== 'head') { stopPreviewPolling(); return; }
    if (!document.hidden) refreshVisiblePreviews();
    previewPollTimer = setTimeout(tick, nextPollDelay());
  };
  previewPollTimer = setTimeout(tick, nextPollDelay());
}
function stopPreviewPolling() {
  if (previewPollTimer) { clearTimeout(previewPollTimer); previewPollTimer = null; }
}

// Re-fetch every head preview currently on screen (heads view only). Each preview slot
// remembers its URL in data-prev-url; we reload them in place, leaving the rest of the UI
// untouched. Guarded by step so a stray late timer can't redraw a different view.
function refreshVisiblePreviews() {
  if (state.step !== 'head') return;
  document.querySelectorAll('[data-prev][data-prev-url]').forEach((slot) => {
    loadPreviewInto(slot, slot.dataset.prevUrl, { quiet: true });
  });
}

// Persistent control channel, opened on boot and held for the session. The server sends
// { type:'reload' } after a config save so panels refresh immediately. Auto-reconnects
// if the socket drops (e.g. server redeploy), so panels recover on their own.
let controlWs = null;
function connectControlWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws?control=1`;
  console.log('[control] connecting to', url);
  try {
    controlWs = new WebSocket(url);
  } catch (err) {
    console.error('[control] WebSocket construction failed:', err);
    setTimeout(connectControlWs, 3000);
    return;
  }
  controlWs.onopen = () => console.log('[control] connected');
  controlWs.onmessage = (ev) => {
    console.log('[control] message:', ev.data);
    let msg = null;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg && msg.type === 'reload') location.reload();
  };
  controlWs.onclose = () => { console.log('[control] closed, retrying in 3s'); setTimeout(connectControlWs, 3000); };
  controlWs.onerror = (e) => { console.error('[control] error', e); try { controlWs.close(); } catch {} };
}

// ---- Fullscreen input-group editor (1080 layout only) ---------------------
// Shows a head's windows large; each window displays its current input group number and
// is tappable to enter a new number, which repoints that window's widget to the matching
// input group on the live board.

let fsState = null; // { head, widgets, groups }
let fsPollTimer = null;

async function openFullscreen(head) {
  stopPreviewPolling(); // the editor covers the heads grid; don't poll behind it
  const ov = $('fsOverlay');
  ov.classList.add('show');
  $('fsTitle').textContent = head.label || 'Head';
  $('fsBody').innerHTML = '<div class="preview-loading" style="padding:40px">Loading windows…</div>';

  try {
    const [{ widgets }, { groups }] = await Promise.all([
      api(`/api/panel/cards/${head.cardId}/heads/${head.headUuid}/preview`),
      api(`/api/panel/cards/${head.cardId}/heads/${head.headUuid}/groups`),
    ]);
    fsState = { head, widgets: widgets || [], groups: groups || [] };
    renderFullscreen();
    startFullscreenPolling(); // keep the enlarged view live to recalls from other panels
  } catch (e) {
    // Board-originated text can reach e.message — never interpolate it into HTML.
    const n = document.createElement('div');
    n.className = 'preview-note err';
    n.style.padding = '40px';
    n.textContent = e.message;
    $('fsBody').replaceChildren(n);
  }
}

// True while the operator is typing a new input number into a window. Used to skip a live
// refresh so we never yank the field they're editing. Their edit commits on Enter as normal;
// the next poll cycle then reflects reality.
function fsIsEditing() {
  return !!$('fsOverlay').querySelector('.fs-window.editing');
}

// Poll the enlarged view so a snapshot recalled from ANOTHER panel redraws it. This runs even
// while the operator is mid-edit: when no input is open we do a full renderFullscreen(); when
// one IS open we use updateFullscreenPreservingEdit(), which live-updates every OTHER window
// (e.g. a layout recall or a group change another operator made on this same head) while
// leaving the field being typed into untouched.
function startFullscreenPolling() {
  stopFullscreenPolling();
  const tick = async () => {
    if (!fsState) { stopFullscreenPolling(); return; }
    if (!document.hidden) {
      try {
        const head = fsState.head;
        const [{ widgets }, { groups }] = await Promise.all([
          api(`/api/panel/cards/${head.cardId}/heads/${head.headUuid}/preview`),
          api(`/api/panel/cards/${head.cardId}/heads/${head.headUuid}/groups`),
        ]);
        // Guard against a race: the view may have closed or switched heads during the fetch.
        if (fsState && fsState.head === head) {
          if (fsIsEditing()) {
            updateFullscreenPreservingEdit(widgets || [], groups || []);
          } else {
            fsState = { head, widgets: widgets || [], groups: groups || [] };
            renderFullscreen();
          }
        }
      } catch { /* transient poll failure — keep the current view, try again next cycle */ }
    }
    if (fsState) fsPollTimer = setTimeout(tick, nextPollDelay());
  };
  fsPollTimer = setTimeout(tick, nextPollDelay());
}
function stopFullscreenPolling() {
  if (fsPollTimer) { clearTimeout(fsPollTimer); fsPollTimer = null; }
}

// One-shot refresh of the enlarged view (used after a rejected edit, so the operator
// immediately sees the state the other panel's recall produced). Skips if editing.
async function fsRefreshNow() {
  if (!fsState || fsIsEditing()) return;
  try {
    const head = fsState.head;
    const [{ widgets }, { groups }] = await Promise.all([
      api(`/api/panel/cards/${head.cardId}/heads/${head.headUuid}/preview`),
      api(`/api/panel/cards/${head.cardId}/heads/${head.headUuid}/groups`),
    ]);
    if (!fsState || fsState.head !== head || fsIsEditing()) return;
    fsState = { head, widgets: widgets || [], groups: groups || [] };
    renderFullscreen();
  } catch { /* leave current view on failure */ }
}

function closeFullscreen() {
  stopFullscreenPolling();
  $('fsOverlay').classList.remove('show');
  fsState = null;
  if (state.step === 'head') {
    // The grid was frozen while the editor was open, so its previews may be stale (e.g. a
    // recall from another panel landed meanwhile). Refresh now rather than waiting a poll
    // cycle, then resume polling.
    refreshVisiblePreviews();
    startPreviewPolling();
  }
}

function groupByUuid(uuid) {
  return fsState.groups.find((g) => g.uuid === uuid) || null;
}
function groupByNumber(num) {
  return fsState.groups.find((g) => g.number === num) || null;
}

function renderFullscreen() {
  const body = $('fsBody');
  body.innerHTML = '';
  const { widgets } = fsState;

  // 16:9 stage that fills the available space.
  const stage = document.createElement('div');
  stage.className = 'fs-stage';
  body.appendChild(stage);

  if (!widgets.length) {
    stage.innerHTML = '<div class="preview-empty-text" style="display:grid;place-items:center;height:100%">No windows on this head</div>';
    return;
  }

  widgets.forEach((wd) => stage.appendChild(createFsWindow(wd)));
}

// Build one enlarged-view window node: positioned by its fractional geometry, labelled with
// its current input-group number, and wired for tap-to-edit. Extracted from renderFullscreen
// so the live-refresh path can rebuild individual windows WITHOUT disturbing another window
// the operator is currently editing (see updateFullscreenPreservingEdit).
function createFsWindow(wd) {
  const g = wd.geometry || {};
  const win = document.createElement('div');
  win.className = 'fs-window';
  win.dataset.widgetUuid = wd.uuid; // stable key for the reconciling live update
  win.style.left = `${(g.x || 0) * 100}%`;
  win.style.top = `${(g.y || 0) * 100}%`;
  win.style.width = `${(g.width || 0) * 100}%`;
  win.style.height = `${(g.height || 0) * 100}%`;

  const grp = groupByUuid(wd.groupUuid);
  const label = grp
    ? (grp.number != null ? String(grp.number) : (grp.name || '—'))
    : '—';
  win.innerHTML = `
      <span class="fs-win-num"></span>
      <input class="fs-win-input mono" inputmode="numeric" maxlength="4" />
      <span class="fs-win-name"></span>`;
  win.querySelector('.fs-win-num').textContent = label;
  win.querySelector('.fs-win-name').textContent = grp ? (grp.name || '') : 'unassigned';

  const input = win.querySelector('.fs-win-input');

  // Tap/click the window → immediately begin keyboard entry.
  win.addEventListener('click', () => {
    if (win.classList.contains('editing')) return;
    win.classList.add('editing');
    input.value = '';
    input.placeholder = grp && grp.number != null ? String(grp.number) : '';
    input.focus();
  });

  const commit = async () => {
    const raw = input.value.trim();
    win.classList.remove('editing');
    if (raw === '') return; // no change
    const num = parseInt(raw, 10);
    if (Number.isNaN(num)) { toast('Enter a number', 'err'); return; }
    const target = groupByNumber(num);
    if (!target) { toast(`No input group numbered ${num} on this card`, 'err'); return; }
    try {
      await api(`/api/panel/cards/${fsState.head.cardId}/heads/${fsState.head.headUuid}/widgets/${wd.uuid}/group`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupUuid: target.uuid }),
      });
      // Reflect the change in the live model so the immediate re-render shows it — even if a
      // background poll swapped fsState.widgets for a fresh array while we were editing (in
      // which case the closed-over `wd` is no longer the object renderFullscreen reads).
      const cur = (fsState.widgets || []).find((w) => w.uuid === wd.uuid);
      (cur || wd).groupUuid = target.uuid;
      renderFullscreen();
      toast(`Window set to input ${num}${target.name ? ' (' + target.name + ')' : ''}`, 'ok');
    } catch (e) {
      // A concurrent recall from another panel is reported by the server as a RECALLED
      // conflict. Show the clear message in THIS view's toast, then refresh so the operator
      // sees the current (externally changed) state rather than their rejected edit.
      toast(e.message, 'err');
      if (e.code === 'RECALLED' || e.status === 409) {
        fsRefreshNow();
      }
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); win.classList.remove('editing'); }
  });
  input.addEventListener('blur', () => { win.classList.remove('editing'); });

  return win;
}

// Live-refresh the enlarged view WITHOUT disturbing the window the operator is mid-edit on.
// Used when a poll lands while an input is open: another operator may have recalled a layout
// or repointed a different window on this same head, and that should show up live — but the
// field being typed into must be left exactly as-is. Rebuilds every OTHER window from fresh
// data and leaves the editing window's DOM node untouched.
function updateFullscreenPreservingEdit(widgets, groups) {
  const overlay = $('fsOverlay');
  const editingWin = overlay ? overlay.querySelector('.fs-window.editing') : null;
  const editingUuid = editingWin ? editingWin.dataset.widgetUuid : null;

  // If the widget being edited no longer exists in the fresh data, another operator replaced
  // the whole head (a restore gives every widget a new UUID). Don't yank the in-progress edit:
  // leave the view untouched. The operator's commit will hit the RECALLED conflict and refresh
  // then — the same safe path as before.
  if (editingUuid && !widgets.some((w) => w.uuid === editingUuid)) return;

  // Adopt the fresh data as the source of truth (commit() and label lookups read fsState).
  fsState = { head: fsState.head, widgets, groups };

  const stage = $('fsBody').querySelector('.fs-stage');
  if (!stage) { renderFullscreen(); return; }

  const existing = new Map();
  stage.querySelectorAll('.fs-window').forEach((el) => existing.set(el.dataset.widgetUuid, el));

  const seen = new Set();
  widgets.forEach((wd) => {
    seen.add(wd.uuid);
    if (wd.uuid === editingUuid) return; // preserve the field being edited, untouched
    const fresh = createFsWindow(wd);
    const old = existing.get(wd.uuid);
    if (old) stage.replaceChild(fresh, old); else stage.appendChild(fresh);
  });
  // Remove windows that no longer exist (the editing one is guaranteed present by the guard).
  existing.forEach((el, uuid) => { if (!seen.has(uuid) && uuid !== editingUuid) el.remove(); });
}

// ---- Boot -----------------------------------------------------------------

async function boot() {
  $('backBtn').addEventListener('click', back);
  $('restartBtn').addEventListener('click', restart);
  $('fsClose').addEventListener('click', closeFullscreen);
  $('cancelBtn').addEventListener('click', closeConfirm);
  $('fireBtn').addEventListener('click', fire);
  $('bkBannerX').addEventListener('click', () => {
    // Dismiss THIS failure only — record its timestamp so it stays hidden, but a later
    // failure with a new timestamp will re-show.
    bkDismissedAt = $('bkBanner')._at ?? null;
    $('bkBanner').classList.remove('show');
  });

  try {
    state.panel = await api('/api/panel/me');
    state.showUuids = state.panel.showUuids !== false;
    document.body.classList.toggle('strip', state.panel.layout === 'strip');
    $('panelLabel').textContent = state.panel.label || 'Neuron MV Control';
    $('panelSub').textContent = state.panel.ip;
    renderHeads();
    // Backup-failure banner is a 1080-panel feature only.
    if ((state.panel.layout || '1080') === '1080') startBkBannerPolling();
  } catch (e) {
    // Show the client IP even when unregistered — the server returns it in the error body,
    // which is the value to enter in the admin page. Helps troubleshooting.
    const clientIp = e.body && e.body.ip ? e.body.ip : null;
    $('panelSub').textContent = clientIp
      ? `${clientIp} — not registered`
      : 'This panel is not registered.';
    showEmpty(`${e.message}. Add this panel's IP in the admin page.`);
  }
}
// Open the control socket immediately at script load — BEFORE boot() and outside its
// try/scope — so a reload signal works regardless of any error in the rest of startup.
// Guarded so that if it somehow throws, it can't prevent boot() from running.
try { connectControlWs(); } catch (e) { console.error('[control] failed to start:', e); }

boot();

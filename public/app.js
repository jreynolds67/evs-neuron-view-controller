// public/app.js
// Operator flow: pick a Head (target) -> unified per-head menu. The menu's LEFT pane is a
// scrollable list of the snapshots permitted to that head (collapsible; expand a snapshot to
// see its source-head previews); tapping a preview asks to Confirm, then fires a partial
// restore. The RIGHT pane is the always-on live input-group editor for the same head.
// The panel is identified server-side by its source IP; this client never sees board IPs.

const state = {
  panel: null,
  step: 'head',   // 'head' (picker screen) | 'menu' (unified per-head screen)
  head: null,     // assigned head { cardId, headUuid, label }
  snap: null,     // { uuid, name, ... } — the snapshot behind a pending Confirm
  srcHead: null,  // snapshot source head { uuid, name } — the pick behind a pending Confirm
  showUuids: true,
  showAllActive: false, // "Show all" override for the menu's snapshot list
  // Whether the list the pending pick came from was fetched under "Show all". The restore has
  // to tell the server the pick came from "Show all", or the server re-applies the per-head
  // filter and refuses it.
  snapViaShowAll: false,
};

const $ = (id) => document.getElementById(id);
const grid = $('grid');

// Stale-response guard. Each navigation (screen change, Home, picking a head, re-fetching the
// snapshot list) bumps navSeq. An async render captures the value before its await and bails if
// navSeq has since moved — meaning the operator navigated away while a slow board fetch was in
// flight. Without this, a response arriving after Home reads a now-null state and throws,
// wedging the UI. bumpNav() returns the new token for the caller to capture.
let navSeq = 0;
function bumpNav() { return ++navSeq; }
function navStale(token) { return token !== navSeq; }

// Shared utilities (shared.js): natural alphanumeric name sort + snapshot folder grouping.
const { byName, groupSnapshotsByFolder } = NV;

function toast(msg, kind = '') {
  // On the menu screen the right-pane editor has its own toast so an editor error shows next to
  // it; but a Confirm dialog covers the page, so while it's open route back to the main toast.
  const menuOpen = $('screenMenu').classList.contains('show');
  const confirmOpen = $('overlay').classList.contains('show');
  const useFs = menuOpen && !confirmOpen;
  const t = useFs ? $('fsToast') : $('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = `toast${useFs ? ' fs-toast' : ''} show ${kind}`;
  clearTimeout(t._t);
  t._t = setTimeout(() => { t.className = `toast${useFs ? ' fs-toast' : ''}`; }, 3200);
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

// Toggle between the two screens (head picker / unified menu). The floating bottom-right item
// shows the panel name/IP on the head screen and becomes the Home button inside a menu.
function showScreen(name) {
  $('screenHeads').classList.toggle('show', name === 'head');
  $('screenMenu').classList.toggle('show', name === 'menu');
  $('floater').classList.toggle('menu', name === 'menu');
}

// ---- Head/snapshot preview renderer ---------------------------------------
// Draws a schematic of a head from normalized widgets: each widget is a rect placed by
// its fractional geometry on a 16:9 canvas, and its elements are drawn inside, styled by
// type (box/pip/audiobar/clock) with any literal colors and text labels.
const SVGNS = 'http://www.w3.org/2000/svg';
const ELEMENT_STYLE = {
  box:      { fill: 'rgba(63,182,255,0.10)', stroke: 'var(--accent)' },
  // Green (pip = video) matches the enlarged/fullscreen windows: fill mirrors CSS --pip-fill
  // (rgba(41,209,124,0.16)); stroke is var(--fire). Keep this fill value in sync with --pip-fill.
  pip:      { fill: 'rgba(41,209,124,0.16)', stroke: 'var(--fire)' },
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
      note.textContent = 'Preview only partly loaded — you can still load this snapshot.';
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
          + '<strong>Head UUID changed</strong>'
          + '<span>Use the “Re-link heads by name” function in the '
          + 'admin page to correct it.</span>'
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

// ---- Screen A: head picker ------------------------------------------------

async function renderHeads() {
  bumpNav();
  state.step = 'head';
  state.head = null; state.snap = null; state.srcHead = null;
  state.showAllActive = false; // heads view always starts from the filtered state
  state.snapViaShowAll = false;
  showScreen('head');
  grid.innerHTML = '';

  const slots = state.panel.grid || [];
  const cols = state.panel.cols; // fixed column count, computed by the server in /api/panel/me

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
      </div>`;
    card.querySelector('.k').textContent = h.label || 'Head';
    if (state.showUuids) card.querySelector('.uuid').textContent = h.headUuid;
    else card.querySelector('.uuid').remove();
    // Tapping a head opens its unified menu (snapshot list + live editor).
    card.addEventListener('click', () => openMenu(h));

    grid.appendChild(card);
    const prevSlot = card.querySelector('[data-prev]');
    const prevUrl = `/api/panel/cards/${h.cardId}/heads/${h.headUuid}/preview`;
    prevSlot.dataset.prevUrl = prevUrl; // remembered so a live board update can refresh it
    loadPreviewInto(prevSlot, prevUrl);
  });

  // Poll to keep these previews current, so a recall from another panel shows up here.
  startPreviewPolling();
}

// ---- Screen B: unified per-head menu --------------------------------------

// Open the menu for a head: left pane = its snapshot list, right pane = its live editor.
function openMenu(head) {
  bumpNav();
  state.head = head;
  state.step = 'menu';
  state.snap = null; state.srcHead = null;
  state.showAllActive = false;
  state.snapViaShowAll = false;
  stopPreviewPolling(); // the heads grid is hidden now
  showScreen('menu');
  $('menuHeadLabel').textContent = head.label || 'Head';
  renderMenuList();  // left pane
  openEditor(head);  // right pane
}

// The "Show all" toggle lives in the left-pane header. Only shown when the panel is permitted
// to show all; toggling it re-fetches the snapshot list under the override.
function renderShowAllButton() {
  const slot = $('showAllSlot');
  if (!slot) return;
  slot.innerHTML = '';
  if (!state.panel || !state.panel.allowShowAll) return;
  const btn = document.createElement('button');
  btn.className = 'btn ghost showall-btn' + (state.showAllActive ? ' on' : '');
  btn.textContent = state.showAllActive ? 'Showing all' : 'Show all snapshots';
  btn.addEventListener('click', () => { state.showAllActive = !state.showAllActive; renderMenuList(); });
  slot.appendChild(btn);
}
function clearShowAllButton() {
  const slot = $('showAllSlot');
  if (slot) slot.innerHTML = '';
}

function showListMsg(cls, msg) {
  const list = $('snapList');
  list.innerHTML = '';
  const d = document.createElement('div');
  d.className = cls;
  d.textContent = msg;
  list.appendChild(d);
}

// Left pane: a "contact sheet" of the snapshots permitted to this head. Folder names are area
// separators; each snapshot name captions a row of its source-head previews, shown directly
// (no tap-to-expand). Tapping a preview asks to confirm, then loads it.
//
// Previews are NOT polled — a saved snapshot's layout is immutable, so each snapshot's previews
// are fetched once (server caches the model long, shared across panels) and cached client-side.
// To stay cheap when "Show all" pulls in hundreds of snapshots, previews load LAZILY: the whole
// folder/snapshot skeleton renders instantly (just names + a sized placeholder), and each
// snapshot's previews are fetched + drawn only as it scrolls near the viewport (Intersection
// Observer). So a big head is an instant skeleton that fills in as you scroll, and the board is
// hit at most once per snapshot you actually look at.
const snapPreviewCache = new Map(); // snap.uuid -> { parsed, heads, byHead }
let snapObserver = null;            // lazily fills snapshot groups as they near the viewport

function disconnectSnapObserver() {
  if (snapObserver) { snapObserver.disconnect(); snapObserver = null; }
}

async function renderMenuList() {
  const token = bumpNav();
  disconnectSnapObserver();
  snapPreviewCache.clear();
  renderShowAllButton();
  showListMsg('empty', 'Loading snapshots…');
  try {
    const qs = state.showAllActive ? '?showAll=1' : '';
    const { snapshots, state: boardState } = await api(
      `/api/panel/cards/${state.head.cardId}/heads/${state.head.headUuid}/snapshots${qs}`);
    if (navStale(token)) return; // operator navigated away during the fetch
    const list = $('snapList');
    list.innerHTML = '';
    if (boardState && boardState !== 'idle') {
      toast(`Card is busy (${boardState}) — wait a moment and try loading again.`, 'err');
    }
    if (!snapshots.length) {
      return showListMsg('empty-note',
        'No snapshots are available for this head. If you expected some, ask an engineer to allow them for this head.');
    }
    // Fill a snapshot group's previews when it comes into view, then stop watching it. rootMargin
    // preloads a screen or two ahead so small heads feel eager and scrolling stays ahead of the eye.
    snapObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        snapObserver.unobserve(e.target);
        fillSnapGroup(e.target);
      }
    }, { root: list, rootMargin: '600px 0px' });

    // Folder separators (blank path = "Ungrouped", shown last), each snapshot a captioned group.
    groupSnapshotsByFolder(snapshots).forEach(({ label, snapshots: snaps }) => {
      const header = document.createElement('div');
      header.className = 'group-head';
      header.textContent = label;
      list.appendChild(header);
      snaps.slice().sort(byName).forEach((s) => {
        const group = snapGroup(s);
        list.appendChild(group);
        snapObserver.observe(group);
      });
    });
  } catch (e) { showListMsg('empty', e.message); }
}

// A snapshot's skeleton: its name as a caption + a placeholder-sized preview area (so the group
// reserves real height before loading — otherwise every group would sit at the top at once and
// the observer would fire for all of them, defeating the lazy load).
function snapGroup(s) {
  const group = document.createElement('div');
  group.className = 'snap-group';
  group._snap = s; // read back by fillSnapGroup
  const head = document.createElement('div');
  head.className = 'snap-group-head';
  head.textContent = s.name;
  const previews = document.createElement('div');
  previews.className = 'snap-previews';
  previews.innerHTML = '<div class="snap-ph"></div>'; // reserves height until filled
  group.append(head, previews);
  return group;
}

async function fillSnapGroup(group) {
  const s = group._snap;
  const container = group.querySelector('.snap-previews');
  const token = navSeq; // re-rendering the list bumps navSeq and detaches this group
  try {
    const data = await loadSnapFull(s);
    if (navStale(token)) return;
    renderSnapPreviews(container, s, data);
  } catch (e) {
    if (navStale(token)) return;
    container.innerHTML = '';
    const n = document.createElement('div');
    n.className = 'preview-note err'; // board-originated text — never HTML-interpolate
    n.textContent = e.message;
    container.appendChild(n);
  }
}

// One board read per snapshot (the combined /full endpoint), cached for the life of this list.
async function loadSnapFull(s) {
  if (snapPreviewCache.has(s.uuid)) return snapPreviewCache.get(s.uuid);
  const data = await api(`/api/panel/cards/${state.head.cardId}/snapshots/${s.uuid}/full`);
  snapPreviewCache.set(s.uuid, data);
  return data;
}

function renderSnapPreviews(container, s, { parsed, heads, byHead }) {
  container.innerHTML = '';
  if (!parsed || !heads.length) {
    // Couldn't read the snapshot's heads — do NOT guess; block loading for safety.
    const n = document.createElement('div');
    n.className = 'preview-note err';
    n.textContent = 'Couldn’t read this snapshot’s heads on the card, so loading is blocked for safety. Try another snapshot, or ask an engineer to check it.';
    container.appendChild(n);
    return;
  }
  heads.slice().sort(byName).forEach((h) => {
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
    card.querySelector('[data-prev]').appendChild(buildPreviewSvg((byHead && byHead[h.uuid]) || []));
    // Tapping a source-head preview asks to confirm, then loads it onto the target head.
    card.addEventListener('click', () => pickForConfirm(s, h));
    container.appendChild(card);
  });
}

// ---- Confirm + fire -------------------------------------------------------

function pickForConfirm(s, h) {
  state.snap = s;
  state.srcHead = h;
  state.snapViaShowAll = state.showAllActive; // remember how this list was fetched
  openConfirm();
}

function openConfirm() {
  // Compact one-line summary so the dialog fits the short strip panels.
  $('confirmLines').innerHTML = '<div class="confirm-summary"></div>';
  $('confirmLines').querySelector('.confirm-summary').textContent =
    `Load "${state.srcHead.name || state.srcHead.uuid}" onto ${state.head.label}?`;
  $('overlay').classList.add('show');
}

function closeConfirm() {
  $('overlay').classList.remove('show');
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
        showAll: state.snapViaShowAll === true,
      }),
    });
    $('overlay').classList.remove('show');
    toast(`Loaded "${state.snap.name}" onto ${state.head.label}`, 'ok');
    // Stay on the head's menu; the load changed its live layout, so refresh the right-pane editor.
    state.snap = state.srcHead = null;
    fsRefreshNow();
  } catch (e) {
    if (e.code === 'BOARD_BUSY' || e.code === 'HEAD_STALE') {
      // Both are clean failures where nothing was applied: BOARD_BUSY means the board was
      // mid-operation (safe to retry shortly); HEAD_STALE means the target head's ID drifted
      // and the board rejected an unknown head. Each message already names its own next step.
      toast(e.message, 'err');
    } else {
      // Two genuinely different states, so two messages. A per-head restore is synchronous
      // (the board applies it, THEN returns 200) and this app only ever restores ONE head, so
      // there is no "partial" outcome — it's all-or-nothing:
      //  • No confirmation (timeout / unreachable / 5xx): we never got the 200, but a lost
      //    response isn't a lost action — the board may have fully applied it or not at all.
      //    Genuinely ambiguous, so the operator must verify.
      //  • Rejected (4xx): the board refused the command before applying it, so nothing changed.
      const msg = (e.status >= 500 || !e.status)
        ? 'The card didn’t confirm the restore — it may or may not have applied. Please manually confirm the restore worked, or try again.'
        : 'The card rejected the restore, so nothing changed. Please try again.';
      toast(msg, 'err');
    }
  } finally {
    fireBtn.disabled = false; fireBtn.textContent = 'Load snapshot';
  }
}

// ---- Navigation -----------------------------------------------------------

// Home: leave the menu and return to the head picker. (There is no Back — the menu is a single
// screen, so the only navigation out of it is Home.)
function goHome() {
  bumpNav();
  stopEditor();
  disconnectSnapObserver();
  state.head = state.snap = state.srcHead = null;
  state.showAllActive = false;
  clearShowAllButton();
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
  // Name the card by label when the server provided one (it withholds IP-shaped labels).
  const card = failure.cardLabel ? ` of ${failure.cardLabel}` : '';
  if (failure.reason === 'empty') {
    return `Scheduled snapshot backup${card} at ${when} found no snapshots to back up — tell an engineer to check the backup settings.`;
  }
  // export / target / generic error all read as a backup failure to the operator.
  return `Scheduled snapshot backup${card} failed at ${when} — tell an engineer to check the backup settings.`;
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

let fsState = null; // { head, widgets, groups, soloed }
let fsPollTimer = null;
// Generation token for the enlarged view. Any operation that changes the head (solo/unsolo)
// bumps it, so a poll whose fetch STARTED earlier can't land afterwards and repaint stale data
// over the fresh render — the bug where restoring flashed, then snapped back to the fullscreen
// layout until the next poll. `fsBusy` additionally suppresses polling entirely while an
// operation is in flight.
let fsSeq = 0;
let fsBusy = false;
function fsBump() { return ++fsSeq; }
function fsStale(token) { return token !== fsSeq; }

// True only when the head is GENUINELY showing a soloed window: the server says soloed AND the
// head really has just the one survivor. The server persists the capture BEFORE deleting the
// other widgets (for crash safety), so there's a brief window where `soloed` is true while the
// full mosaic is still present — without this check, a poll landing in that window would paint
// the "press and hold to restore" prompt on EVERY pip.
function fsIsSoloView() {
  return !!(fsState && fsState.soloed && (fsState.widgets || []).length === 1);
}

// One round trip for everything the enlarged view needs: the head's live widgets (plus its
// soloed flag) and the card's input groups. Shared by the initial open, the poll tick, and
// the post-operation refresh, so the three can't drift — their differing staleness guards
// stay at the call sites, where they are load-bearing (see REVIEW_NOTES §3).
async function fetchFsData(head) {
  const [preview, { groups }] = await Promise.all([
    api(`/api/panel/cards/${head.cardId}/heads/${head.headUuid}/preview`),
    api(`/api/panel/cards/${head.cardId}/heads/${head.headUuid}/groups`),
  ]);
  return { widgets: preview.widgets || [], groups: groups || [], soloed: !!preview.soloed };
}

// Load the right-pane live editor for a head. Called when the menu opens (and re-used by the
// polling/refresh paths). The editor is always visible on the menu screen — no overlay.
async function openEditor(head) {
  hideKeypad(); // any prior selection is gone once we (re)open the editor
  $('fsStageWrap').innerHTML = '<div class="preview-loading" style="padding:40px">Loading windows…</div>';

  try {
    fsState = { head, ...(await fetchFsData(head)) };
    renderFullscreen();
    startFullscreenPolling(); // keep the editor live to recalls from other panels
  } catch (e) {
    // Board-originated text can reach e.message — never interpolate it into HTML.
    const n = document.createElement('div');
    n.className = 'preview-note err';
    n.style.padding = '40px';
    n.textContent = e.message;
    $('fsStageWrap').replaceChildren(n);
  }
}

// True while the operator is typing a new input number into a window. Used to skip a live
// refresh so we never yank the field they're editing. Their edit commits on Enter as normal;
// the next poll cycle then reflects reality.
function fsIsEditing() {
  return !!$('fsEditor').querySelector('.fs-window.editing');
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
    // Never poll over a solo/unsolo in flight — its own refresh is authoritative.
    if (!document.hidden && !fsBusy) {
      const token = fsSeq;
      try {
        const head = fsState.head;
        const data = await fetchFsData(head);
        // Guard against races: the view may have closed/switched heads during the fetch, or a
        // solo/unsolo may have completed — in which case this response is stale and must NOT
        // repaint over the fresher render.
        if (fsState && fsState.head === head && !fsStale(token) && !fsBusy) {
          if (fsIsEditing()) {
            updateFullscreenPreservingEdit(data.widgets, data.groups, data.soloed);
          } else {
            fsState = { head, ...data };
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
  const token = fsSeq;
  try {
    const head = fsState.head;
    const data = await fetchFsData(head);
    // Bail if the view changed or another operation superseded this refresh mid-fetch.
    if (!fsState || fsState.head !== head || fsIsEditing() || fsStale(token)) return;
    fsState = { head, ...data };
    renderFullscreen();
  } catch { /* leave current view on failure */ }
}

// Tear down the right-pane editor (called on Home). The heads-grid preview polling is resumed
// by renderHeads(), which goHome() calls right after.
function stopEditor() {
  stopFullscreenPolling();
  hideKeypad();
  fsState = null;
}

function groupByUuid(uuid) {
  return fsState.groups.find((g) => g.uuid === uuid) || null;
}
function groupByNumber(num) {
  return fsState.groups.find((g) => g.number === num) || null;
}

function renderFullscreen() {
  const body = $('fsStageWrap');
  body.innerHTML = '';
  hideKeypad(); // a full redraw only happens when nothing is being edited
  const { widgets } = fsState;
  const soloView = fsIsSoloView(); // see fsIsSoloView: requires the head to really have 1 widget
  $('fsEditor').classList.toggle('soloed', soloView);

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

// Press-and-hold detection on a window. Fires once after `ms` if the pointer hasn't moved far,
// and suppresses the click that follows so a hold doesn't also trigger tap-to-edit.
function addLongPress(el, handler, ms = 500) {
  let timer = null, fired = false, sx = 0, sy = 0;
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  el.addEventListener('pointerdown', (e) => {
    fired = false; sx = e.clientX; sy = e.clientY; cancel();
    timer = setTimeout(() => { fired = true; timer = null; handler(); }, ms);
  });
  el.addEventListener('pointermove', (e) => {
    if (timer && (Math.abs(e.clientX - sx) > 12 || Math.abs(e.clientY - sy) > 12)) cancel();
  });
  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointercancel', () => { cancel(); fired = false; });
  el.addEventListener('click', (e) => { if (fired) { e.stopPropagation(); e.preventDefault(); fired = false; } }, true);
}

// A full-editor "working" overlay, shown the INSTANT a hold registers and held until the board
// finishes and the view redraws. It tells the operator the hold took and they can release —
// covering the natural delay while the board rebuilds the layout. It's inside the stage wrap,
// so renderFullscreen() (which clears the wrap) removes it automatically.
function showFsWorking(msg) {
  const body = $('fsStageWrap');
  if (!body) return;
  let el = body.querySelector('.fs-working');
  if (!el) { el = document.createElement('div'); el.className = 'fs-working'; body.appendChild(el); }
  el.querySelector('.fs-working-msg')?.remove();
  const span = document.createElement('span');
  span.className = 'fs-working-msg';
  span.textContent = msg;
  el.appendChild(span);
}
function hideFsWorking() { $('fsStageWrap')?.querySelector('.fs-working')?.remove(); }

// Blow one window up to fullscreen (server captures the head, deletes the others, fullscreens
// this one video-only). Refreshes to the soloed state on success.
async function soloWindow(widgetUuid) {
  if (!fsState || fsBusy) return; // ignore a second hold while one is already running
  fsBusy = true;
  fsBump(); // invalidate any poll fetch already in flight so it can't repaint over us
  const head = fsState.head;
  showFsWorking('Going fullscreen…'); // immediate: release-now + working indication
  try {
    await api(`/api/panel/cards/${head.cardId}/heads/${head.headUuid}/solo`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetWidgetUuid: widgetUuid }),
    });
    await fsRefreshNow(); // re-render clears the working overlay and shows the green fullscreen
  } catch (e) { hideFsWorking(); toast(e.message, 'err'); }
  finally { fsBusy = false; }
}

// Restore the head's original layout (server recreates the deleted windows).
async function unsoloWindow() {
  if (!fsState || fsBusy) return; // ignore a second hold while one is already running
  fsBusy = true;
  fsBump(); // invalidate any poll fetch already in flight so it can't repaint the soloed layout back
  const head = fsState.head;
  showFsWorking('Restoring layout…');
  try {
    await api(`/api/panel/cards/${head.cardId}/heads/${head.headUuid}/unsolo`, { method: 'POST' });
    await fsRefreshNow();
  } catch (e) { hideFsWorking(); toast(e.message, 'err'); }
  finally { fsBusy = false; }
}

// ---- On-screen numeric keypad --------------------------------------------
// The CTP touchscreen has no physical keyboard, so input-group numbers are typed on this
// keypad. It's shown for BOTH layouts (on 1080 the operator can still use a real keyboard).
// The keypad drives whichever window's input is currently open (.fs-window.editing), so it
// needs no per-window wiring — it just targets the live editing field.

function activeFsInput() {
  const win = $('fsEditor').querySelector('.fs-window.editing');
  return win ? win.querySelector('.fs-win-input') : null;
}
function showKeypad() {
  const pad = $('fsKeypad');
  if (pad) { pad.classList.add('show'); pad.setAttribute('aria-hidden', 'false'); }
}
function hideKeypad() {
  const pad = $('fsKeypad');
  if (pad) { pad.classList.remove('show'); pad.setAttribute('aria-hidden', 'true'); }
}

// Apply one keypad press to the open input. Enter is routed through the field's existing
// keydown handler so the exact same commit() path runs (keypad and hardware Enter converge).
function fsKeyPress(key) {
  const input = activeFsInput();
  if (!input) return;
  if (key === 'enter') {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return;
  }
  if (key === 'back') { input.value = input.value.slice(0, -1); return; }
  if (/^[0-9]$/.test(key) && input.value.length < 4) input.value += key;
}

function buildKeypad() {
  const pad = $('fsKeypad');
  if (!pad) return;
  pad.innerHTML = '';
  // A tap in the GAP between keys lands on the board itself — swallow it so it can't blur the
  // input (which would close the editor). Buttons still get their click.
  pad.addEventListener('pointerdown', (e) => e.preventDefault());
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'back', '0', 'enter'].forEach((k) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fs-key' + (k === 'enter' ? ' enter' : k === 'back' ? ' back' : '');
    b.textContent = k === 'back' ? '⌫' : k === 'enter' ? '✓' : k;
    if (k === 'enter') b.setAttribute('aria-label', 'Set input');
    else if (k === 'back') b.setAttribute('aria-label', 'Delete last digit');
    // Don't let a keypad tap move focus off the input — a blur would close the editor.
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('click', () => fsKeyPress(k));
    pad.appendChild(b);
  });
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
  // On the CTP touchscreen there is no hardware keyboard — the on-screen keypad is the only
  // way to type, so make the field read-only there to keep the OS keyboard from popping up.
  // The keypad writes input.value directly, which works regardless of readOnly. On 1080 the
  // field stays editable so a real keyboard still works alongside the keypad.
  if (document.body.classList.contains('strip')) input.readOnly = true;

  // Tap/click the window → begin entry and reveal the keypad. Disabled while soloed: source
  // changes aren't allowed on a fullscreen window (decision), so a tap does nothing there.
  win.addEventListener('click', () => {
    if (fsState && fsState.soloed) return;
    if (win.classList.contains('editing')) return;
    win.classList.add('editing');
    input.value = '';
    input.placeholder = grp && grp.number != null ? String(grp.number) : '';
    input.focus();
    showKeypad();
  });

  const commit = async () => {
    const raw = input.value.trim();
    win.classList.remove('editing');
    hideKeypad();
    if (raw === '') return; // no change
    const num = parseInt(raw, 10);
    if (Number.isNaN(num)) { toast('Enter an input number, then press Enter.', 'err'); return; }
    const target = groupByNumber(num);
    if (!target) { toast(`No input group numbered ${num} on this card — check the number and try again.`, 'err'); return; }
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
    else if (e.key === 'Escape') { e.preventDefault(); win.classList.remove('editing'); hideKeypad(); }
  });
  input.addEventListener('blur', () => {
    win.classList.remove('editing');
    // Defer: if the blur is because the operator tapped a DIFFERENT window (which becomes the
    // new editing field synchronously after this), keep the keypad up rather than flashing it.
    setTimeout(() => { if (!activeFsInput()) hideKeypad(); }, 0);
  });

  // While soloed, replace the (hidden) input-number chrome with a persistent, centered
  // instruction on how to go back — so the "press and hold to restore" guidance stays on screen
  // instead of relying on a toast that disappears.
  if (fsIsSoloView()) {
    const hint = document.createElement('div');
    hint.className = 'fs-restore-hint';
    const icon = document.createElement('span');
    icon.className = 'fs-restore-icon';
    icon.textContent = '⤢';
    const text = document.createElement('span');
    text.textContent = 'Press and hold to restore the layout';
    hint.append(icon, text);
    win.appendChild(hint);
  }

  // Press and hold: blow this window up to fullscreen, or restore the layout if already soloed.
  addLongPress(win, () => ((fsState && fsState.soloed) ? unsoloWindow() : soloWindow(wd.uuid)));

  return win;
}

// Live-refresh the enlarged view WITHOUT disturbing the window the operator is mid-edit on.
// Used when a poll lands while an input is open: another operator may have recalled a layout
// or repointed a different window on this same head, and that should show up live — but the
// field being typed into must be left exactly as-is. Rebuilds every OTHER window from fresh
// data and leaves the editing window's DOM node untouched.
function updateFullscreenPreservingEdit(widgets, groups, soloed) {
  const editor = $('fsEditor');
  const editingWin = editor ? editor.querySelector('.fs-window.editing') : null;
  const editingUuid = editingWin ? editingWin.dataset.widgetUuid : null;

  // If the widget being edited no longer exists in the fresh data, another operator replaced
  // the whole head (a restore gives every widget a new UUID). Don't yank the in-progress edit:
  // leave the view untouched. The operator's commit will hit the RECALLED conflict and refresh
  // then — the same safe path as before.
  if (editingUuid && !widgets.some((w) => w.uuid === editingUuid)) return;

  // Adopt the fresh data as the source of truth (commit() and label lookups read fsState).
  fsState = { head: fsState.head, widgets, groups, soloed: !!soloed };

  const stage = $('fsStageWrap').querySelector('.fs-stage');
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
  $('homeBtn').addEventListener('click', goHome);
  buildKeypad();
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
    // Panel identity is shown on the head-picker header.
    $('panelLabel').textContent = state.panel.label || 'Neuron MV Control';
    $('panelSub').textContent = state.panel.ip;
    renderHeads();
    // Backup-failure banner is a 1080-panel feature only.
    if ((state.panel.layout || '1080') === '1080') startBkBannerPolling();
  } catch (e) {
    // Show the client IP even when unregistered — the server returns it in the error body,
    // which is the value an engineer enters in the admin page. Helps troubleshooting.
    const clientIp = e.body && e.body.ip ? e.body.ip : null;
    $('panelSub').textContent = clientIp
      ? `${clientIp} — not registered`
      : 'This panel is not registered.';
    // Build the empty state so the IP can be shown as its own emphasised line. e.message is
    // server-originated text, so it goes in via textContent — never HTML.
    grid.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'empty';
    const msg = document.createElement('div');
    msg.textContent = `${e.message}. Ask an engineer to add this panel in the admin page.`;
    box.appendChild(msg);
    if (clientIp) {
      const ip = document.createElement('div');
      ip.className = 'empty-ip';
      ip.textContent = `My IP address is: ${clientIp}`;
      box.appendChild(ip);
    }
    grid.appendChild(box);
  }
}
// Open the control socket immediately at script load — BEFORE boot() and outside its
// try/scope — so a reload signal works regardless of any error in the rest of startup.
// Guarded so that if it somehow throws, it can't prevent boot() from running.
try { connectControlWs(); } catch (e) { console.error('[control] failed to start:', e); }

boot();

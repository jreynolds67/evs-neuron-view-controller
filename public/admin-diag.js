// public/admin-diag.js
// The Setup tab's diagnostics: the board API activity log, per-card reach tests, and the
// sync-diagnostics panel. Loaded last, so it also runs the page boot sequence at the bottom.

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
    const res = await adminFetch(`/api/admin/log?since=${lastLogId}`, { headers: headers() });
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
        <td style="font-size:12px;color:var(--ink-dim)" title="${esc((e.detail || e.error || '').toString())}">${esc((e.detail || e.error || '').toString().slice(0, 300))}</td>`;
      tb.prepend(tr); // newest on top
    });
    // Trim DOM to 200 rows
    while (tb.children.length > 200) tb.removeChild(tb.lastChild);
    $('logState').textContent = `updated ${new Date().toLocaleTimeString([], { hour12: false })}`;
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
  await adminFetch('/api/admin/log', { method: 'DELETE', headers: headers() });
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
        const res = await adminFetch(`/api/admin/cards/${encodeURIComponent(c.id)}/reach`, { headers: headers() });
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
    const d = await adminFetch(`/api/admin/cards/${encodeURIComponent(card.id)}/sync-diagnostics`, { headers: headers() }).then(r => r.json());
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
        const r = await adminFetch(`/api/admin/cards/${encodeURIComponent(card.id)}/sync-trigger`, { method: 'POST', headers: headers() }).then(x => x.json());
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

// ---- Boot -----------------------------------------------------------------
// Runs here because this is the last-loaded script: everything above (across all the
// admin-*.js files) is defined by now.

// Verify the session up front. If it's already expired, adminFetch redirects to login;
// otherwise loadConfig() proceeds. (The page load itself is also server-gated.)
adminFetch('/api/admin/session').then((r) => { if (r.ok) loadConfig(); });
refreshLog(true);
startLogAuto();
connectConfigWs(); // keep this window in step with any other admin session

// public/admin-heads.js
// The Heads tab: global per-head snapshot filters, grouped by folder with per-folder
// select-all. Loaded after admin-panels.js (uses its probe caches).

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

      // Group snapshots by folder (path), matching the operator view (shared.js): natural
      // folder order, blank path bucketed as "Ungrouped" and shown last.
      groupSnapshotsByFolder(sortedSnaps).forEach(({ label: folderLabel, snapshots: folderSnaps }) => {
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

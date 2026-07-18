// public/shared.js
// Tiny utilities shared by the operator page (app.js) and the admin page (admin-*.js).
// Loaded as a plain script before them (there is no build step), exposing one global: NV.
const NV = (() => {
  // Natural alphanumeric sort ("2 Boxes" < "9 Boxes" < "10 Boxes", not lexical).
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const byName = (a, b) => collator.compare(a.name || '', b.name || '');

  // Group snapshots by folder (path), matching the board's own organization. Returns
  // [{ label, snapshots }] with folders in natural order; blank-path snapshots are bucketed
  // as "Ungrouped" and always shown last.
  function groupSnapshotsByFolder(snapshots) {
    const UNGROUPED = '\uffffUngrouped'; // sentinel prefix sorts after any real folder name
    const groups = new Map();
    snapshots.forEach((s) => {
      const key = s.path && s.path.trim() ? s.path : UNGROUPED;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    });
    return [...groups.keys()]
      .sort((a, b) => collator.compare(a, b))
      .map((key) => ({
        label: key === UNGROUPED ? 'Ungrouped' : key,
        snapshots: groups.get(key),
      }));
  }

  return { collator, byName, groupSnapshotsByFolder };
})();

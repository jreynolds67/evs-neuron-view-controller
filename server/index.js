// server/index.js
// App assembly: static serving, the authenticated admin-page gate, route mounting, the
// control WebSocket, and boot. The actual APIs live in panelroutes.js and adminroutes.js.

import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadConfig, assignedHeadKeys, isConfigAuthoritative } from './config.js';
import { loadSoloStore, pruneSolo } from './solostore.js';
import { startShareSweep } from './sharesweep.js';
import { startBackupScheduler } from './backup.js';
import { touchSession, sessionIdFromReq } from './auth.js';
import { attachControlWs } from './control.js';
import panelRoutes from './panelroutes.js';
import adminRoutes from './adminroutes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const PRIVATE_DIR = join(__dirname, '..', 'private');
const PORT = process.env.PORT || 8080;

const app = express();
// 5 MB: headFilters can grow large (per-head lists of 36-char UUIDs across 12 cards ×
// ~20 heads × many allowed snapshots). The old 256 KB limit could reject a legitimate
// config save with an opaque 413. Payloads are still small relative to this ceiling.
app.use(express.json({ limit: '5mb' }));

// Serve the admin HTML shell ONLY through this authenticated route. admin.html lives in
// PRIVATE_DIR, outside the static root, so there is no static path for express.static to
// resolve — closing off URL-normalization bypasses (/%61dmin.html, /./admin.html, etc.).
// A valid session serves the file; otherwise redirect to login. (The admin scripts and the
// rest stay static; every admin API is separately session-gated by requireAdmin.)
app.get(['/admin', '/admin.html'], (req, res) => {
  if (!touchSession(sessionIdFromReq(req))) return res.redirect(302, '/login.html');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(join(PRIVATE_DIR, 'admin.html'));
});

// No-cache on static assets: these are operator panels that must pick up a redeploy on
// their next load without any manual cache-clearing. The payloads are tiny, so skipping
// caching costs nothing meaningful and guarantees fresh code (e.g. the control-reload WS).
app.use(express.static(PUBLIC_DIR, {
  etag: false,
  lastModified: false,
  cacheControl: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  },
}));

// Container's local time — lets the admin confirm the container's timezone. Returns the
// epoch plus the container's IANA timezone so the client renders the wall clock the
// container actually runs on (not the browser's local time).
app.get('/api/time', (_req, res) => {
  const now = new Date();
  const tz = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  res.json({
    epochMs: now.getTime(),
    iso: now.toISOString(),
    tz,
  });
});

app.use('/api/panel', panelRoutes);
app.use('/api/admin', adminRoutes);

const server = createServer(app);
attachControlWs(server);

// Load persisted fullscreen ("solo") state BEFORE we start accepting requests, so isSoloed()
// is correct from the very first poll. Loading it inside the listen callback left a brief
// window where a preview request could read the store as empty. loadSoloStore never throws.
await loadSoloStore();

server.listen(PORT, async () => {
  console.log(`Neuron MV Control listening on :${PORT}`);
  startShareSweep();
  startBackupScheduler();
  console.log(`Config path: ${process.env.CONFIG_PATH || '/data/config.json'}`);
  try {
    const cfg = await loadConfig();
    if (!cfg.admin || !cfg.admin.user || !cfg.admin.passwordHash) {
      console.log('WARNING: no admin credential configured — admin login is unavailable until '
        + 'config.admin.{user,passwordHash} is set. Generate a hash with: node server/auth.js "password"');
    }
    // Catch captures orphaned by a config hand-edit while the container was down (the save-time
    // prune can't see those).
    //
    // ONLY when the config genuinely loaded. loadConfig() falls back to an EMPTY config instead
    // of throwing, and pruning against that would read "no head is assigned anywhere" and delete
    // every capture on the volume — irreversibly, in response to a bad-JSON config that is
    // otherwise fully recoverable by fixing the file and restarting. That is the exact scenario
    // the persisted capture exists for (a redeploy while a head is soloed on air), so the prune
    // must never be the thing that destroys it.
    if (isConfigAuthoritative()) {
      await pruneSolo(assignedHeadKeys(cfg));
    } else {
      console.warn('[solo] skipping orphan prune — the config did not load, so the set of '
        + 'assigned heads is unknown; captures are left untouched.');
    }
  } catch {}
});

// server/control.js
// The control WebSocket channel. Panels open a "control" WS on load (ws?control=1) and hold
// it for the whole session; the server broadcasts small JSON messages down it:
//   { type: 'reload' }                       -> operator panels reload immediately
//   { type: 'config-changed', configVersion } -> other ADMIN pages react (see admin-core.js)
// The two messages are deliberately separate: a panel holds no state and can reload on the
// spot; an admin page may hold unsaved edits and must never be reloaded out from under
// someone. (There is no per-board fan-out — the Neuron boards don't expose a consumable WS
// endpoint; live preview updates are client polling + the server read cache instead.)

import { WebSocketServer, WebSocket } from 'ws';

const controlClients = new Set();

// Identifies the admin window that CAUSED a write, so it isn't told about its own change.
// The page mints an id at boot, sends it on every config-writing request (X-Client-Id) and
// registers it on its control socket (?clientId=). Excluding the originator at SEND time is
// what makes this correct: a client-side "ignore while my own save is pending" guard would
// also swallow a DIFFERENT admin's change that landed during that window — the precise thing
// this feature exists to surface. Panels never send an id, so they are never excluded.
export function clientIdOf(req) { return req.get('X-Client-Id') || null; }

export function broadcastControl(msg, exceptClientId = null) {
  const data = JSON.stringify(msg);
  let sent = 0;
  let skipped = 0;
  for (const c of controlClients) {
    if (exceptClientId && c.clientId === exceptClientId) { skipped++; continue; }
    if (c.readyState === WebSocket.OPEN) { try { c.send(data); sent++; } catch {} }
  }
  console.log(`[control] broadcast ${JSON.stringify(msg)} to ${sent}/${controlClients.size} client(s)`
    + (skipped ? ` (skipped ${skipped} originator)` : ''));
  return sent;
}

// Attach the control channel to an http.Server.
export function attachControlWs(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  // Keepalive: NAT/switch timeouts can silently drop idle sockets, leaving "zombie"
  // connections that look open but would never receive a reload. Ping every 30s and
  // terminate any control client that didn't pong since the last round. The client
  // auto-reconnects, so this keeps the connected set honest.
  const keepalive = setInterval(() => {
    for (const c of controlClients) {
      if (c.isAlive === false) { try { c.terminate(); } catch {} controlClients.delete(c); continue; }
      c.isAlive = false;
      try { c.ping(); } catch {}
    }
  }, 30000);
  keepalive.unref?.();

  wss.on('connection', (client, req) => {
    const url = new URL(req.url, 'http://localhost');
    // Only the control channel is supported. Anything else (e.g. a stale ?card= client) is
    // closed rather than served.
    if (url.searchParams.get('control') !== '1') { client.close(1008, 'Unsupported channel'); return; }
    // Admin pages identify themselves so their own writes aren't announced back to them.
    // Panels send no id and are never excluded from a broadcast.
    client.clientId = url.searchParams.get('clientId') || null;
    client.isAlive = true;
    client.on('pong', () => { client.isAlive = true; });
    controlClients.add(client);
    console.log(`[control] client connected (${controlClients.size} total)`);
    client.on('close', () => {
      controlClients.delete(client);
      console.log(`[control] client disconnected (${controlClients.size} total)`);
    });
  });

  return wss;
}

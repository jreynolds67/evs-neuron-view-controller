// server/tsl.js
// TSL UMD Protocol v5.0 receiver. Cerebrum (or any TSL 5.0 source) sends UMD "tally" packets
// here; we parse them and keep the latest display text + tally colour per (screen, index) in
// memory. The panel API reads that store to show a source's UMD name under its input number.
//
// Wire format (all multi-byte fields little-endian):
//   PBC    UInt16   byte count of everything that FOLLOWS this field (so packet = PBC + 2)
//   VER    UInt8    protocol version, 0x00 for v5.0
//   FLAGS  UInt8    bit0 = text is UTF-16LE (Unicode) when set, else ASCII/UTF-8
//   SCREEN UInt16   screen index (we map this -> card)
//   then one or more display messages until PBC is consumed:
//     INDEX   UInt16   display index (we map this -> input number)
//     CONTROL UInt16   tally/brightness bits; bit15 set => binary control data, not text
//     LENGTH  UInt16   number of TEXT bytes that follow
//     TEXT    LENGTH bytes
//
// CONTROL tally colour fields (2 bits each: 0 off, 1 red, 2 green, 3 amber):
//   bits 0-1 right tally, bits 2-3 text tally, bits 4-5 left tally, bits 6-7 brightness.
//
// No external dependencies — Node's dgram (UDP) and net (TCP) only. UDP delivers one message
// per datagram; TCP is a byte stream, so we buffer and frame on PBC.

import dgram from 'node:dgram';
import net from 'node:net';

// key `${screen}:${index}` -> { screen, index, text, tally, brightness, updatedAt }
const store = new Map();

const TALLY_NAMES = ['off', 'red', 'green', 'amber'];

const stats = {
  enabled: false,
  port: null,
  udp: false,
  tcp: false,
  udpBound: false,
  tcpBound: false,
  packets: 0,
  displays: 0,
  lastPacketAt: 0,
  lastError: null,
};

let udpSocket = null;
let tcpServer = null;
const tcpSockets = new Set();
let currentKey = null; // signature of the settings the running listeners were started with

function decodeTally(control) {
  return {
    right: TALLY_NAMES[control & 0b11],
    text: TALLY_NAMES[(control >> 2) & 0b11],
    left: TALLY_NAMES[(control >> 4) & 0b11],
  };
}

// Parse ONE complete v5.0 message out of `buf` starting at offset 0. `buf` must be exactly the
// message (UDP) or at least a full framed message (the TCP path slices to length first). Returns
// the number of displays stored, or 0 if the buffer isn't a sane v5.0 message.
function parseMessage(buf) {
  if (buf.length < 6) return 0;
  const pbc = buf.readUInt16LE(0);
  // Total declared message size. Tolerate a datagram that is exactly the body (some senders omit
  // a correct PBC) by falling back to the buffer length when PBC looks wrong.
  let end = pbc + 2;
  if (end > buf.length || end < 6) end = buf.length;

  const flags = buf.readUInt8(3);
  const unicode = (flags & 0x01) !== 0;
  const screen = buf.readUInt16LE(4);

  let off = 6;
  let stored = 0;
  while (off + 6 <= end) {
    const index = buf.readUInt16LE(off);
    const control = buf.readUInt16LE(off + 2);
    const length = buf.readUInt16LE(off + 4);
    off += 6;
    if (off + length > end) break; // truncated / malformed — stop rather than read past
    const isControlData = (control & 0x8000) !== 0; // bit15: binary control payload, not UMD text
    if (!isControlData) {
      const raw = buf.subarray(off, off + length);
      // Trim the NUL padding TSL sources often send in fixed-width label fields.
      const text = raw.toString(unicode ? 'utf16le' : 'utf8').replace(/\0+$/, '').trim();
      store.set(`${screen}:${index}`, {
        screen,
        index,
        text,
        tally: decodeTally(control),
        brightness: (control >> 6) & 0b11,
        updatedAt: Date.now(),
      });
      stored++;
    }
    off += length;
  }
  return stored;
}

function handleDatagram(buf) {
  try {
    const n = parseMessage(buf);
    if (n > 0) {
      stats.packets++;
      stats.displays += n;
      stats.lastPacketAt = Date.now();
    }
  } catch (e) {
    stats.lastError = e.message;
  }
}

// A TCP peer can dribble bytes and pipeline messages, so buffer per-socket and pull off every
// complete PBC-framed message we have.
function attachTcpSocket(sock) {
  tcpSockets.add(sock);
  let acc = Buffer.alloc(0);
  sock.on('data', (chunk) => {
    acc = acc.length ? Buffer.concat([acc, chunk]) : chunk;
    // Guard against a wedged/garbage stream growing without bound.
    if (acc.length > 65535) acc = acc.subarray(acc.length - 65535);
    while (acc.length >= 2) {
      const pbc = acc.readUInt16LE(0);
      const total = pbc + 2;
      if (total < 6 || total > 65535) { acc = Buffer.alloc(0); break; } // resync on nonsense
      if (acc.length < total) break; // wait for the rest of this message
      handleDatagram(acc.subarray(0, total));
      acc = acc.subarray(total);
    }
  });
  sock.on('error', () => {});
  sock.on('close', () => tcpSockets.delete(sock));
}

// Merge config (settings.tsl) with env overrides, then normalise. Env wins so ports can be set
// in docker-compose without touching the config file.
function resolveSettings(cfg) {
  const t = (cfg && cfg.settings && cfg.settings.tsl) || {};
  const envBool = (v, d) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
  const port = Number(process.env.TSL_PORT || t.port || 5728);
  return {
    enabled: envBool(process.env.TSL_ENABLED, t.enabled === true),
    udp: envBool(process.env.TSL_UDP, t.udp !== false), // UDP on by default when TSL is enabled
    tcp: envBool(process.env.TSL_TCP, t.tcp === true),
    port: Number.isFinite(port) ? port : 5728,
    // input number = display index + indexOffset (Cerebrum usually sends the input number
    // directly, so 0; set 1 if it sends 0-based indices).
    indexOffset: Number.isFinite(Number(t.indexOffset)) ? Number(t.indexOffset) : 0,
    // TSL is a latch protocol: a received name stays valid until replaced, so names are NEVER
    // dimmed on their own age (a source may only refresh once per full round-robin, which is
    // minutes with hundreds of displays). Instead, staleness is a WHOLE-FEED signal: senders like
    // Cerebrum emit ~1 packet/sec across all displays, so if NOTHING arrives for this long the
    // feed itself is down (sender stopped / link lost) and every name is dimmed together.
    feedTimeoutMs: Number.isFinite(Number(t.feedTimeoutMs)) ? Number(t.feedTimeoutMs) : 15000,
  };
}

// True when the receiver has gone silent long enough that the whole feed is considered down.
// Never true purely because an individual name is old — see feedTimeoutMs above.
export function feedDown() {
  return !stats.lastPacketAt || (Date.now() - stats.lastPacketAt) > resolved.feedTimeoutMs;
}

let resolved = resolveSettings(null);
export function tslSettings() { return resolved; }

function keyOf(s) { return `${s.enabled}|${s.udp}|${s.tcp}|${s.port}`; }

// Start (or restart) the listeners to match the current config. Idempotent: if the transport
// settings are unchanged, the running sockets are left in place; only enable/port/transport
// changes rebind. Safe to call at boot and again after every config save.
export function startTsl(cfg) {
  resolved = resolveSettings(cfg);
  stats.enabled = resolved.enabled;
  stats.port = resolved.port;
  stats.udp = resolved.udp;
  stats.tcp = resolved.tcp;

  const nextKey = keyOf(resolved);
  if (nextKey === currentKey) return; // nothing that affects the sockets changed
  stopListeners();
  currentKey = nextKey;

  if (!resolved.enabled) {
    console.log('[tsl] disabled');
    return;
  }

  if (resolved.udp) {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('message', (msg) => handleDatagram(msg));
    sock.on('error', (e) => {
      stats.lastError = e.message;
      stats.udpBound = false;
      console.error(`[tsl] UDP error on :${resolved.port} — ${e.message}`);
      try { sock.close(); } catch {}
      if (udpSocket === sock) udpSocket = null;
    });
    sock.on('listening', () => {
      stats.udpBound = true;
      console.log(`[tsl] listening UDP :${resolved.port}`);
    });
    try { sock.bind(resolved.port); udpSocket = sock; }
    catch (e) { stats.lastError = e.message; console.error(`[tsl] UDP bind failed — ${e.message}`); }
  }

  if (resolved.tcp) {
    const srv = net.createServer((sock) => attachTcpSocket(sock));
    srv.on('error', (e) => {
      stats.lastError = e.message;
      stats.tcpBound = false;
      console.error(`[tsl] TCP error on :${resolved.port} — ${e.message}`);
    });
    srv.on('listening', () => {
      stats.tcpBound = true;
      console.log(`[tsl] listening TCP :${resolved.port}`);
    });
    try { srv.listen(resolved.port); tcpServer = srv; }
    catch (e) { stats.lastError = e.message; console.error(`[tsl] TCP listen failed — ${e.message}`); }
  }
}

function stopListeners() {
  if (udpSocket) { try { udpSocket.close(); } catch {} udpSocket = null; stats.udpBound = false; }
  if (tcpServer) { try { tcpServer.close(); } catch {} tcpServer = null; stats.tcpBound = false; }
  for (const s of tcpSockets) { try { s.destroy(); } catch {} }
  tcpSockets.clear();
}

export function stopTsl() { stopListeners(); currentKey = null; }

// Latest UMD entries for a screen, keyed by INPUT NUMBER (index + indexOffset). Names latch, so
// `stale` reflects the WHOLE FEED being down (not a name's own age) — every entry shares it, so
// the UI dims them together only when the sender has actually stopped.
export function getTallyForScreen(screen) {
  const out = {};
  if (screen == null || Number.isNaN(Number(screen))) return out;
  const now = Date.now();
  const down = feedDown();
  for (const e of store.values()) {
    if (e.screen !== Number(screen)) continue;
    const inputNumber = e.index + resolved.indexOffset;
    out[inputNumber] = {
      text: e.text,
      tally: e.tally,
      brightness: e.brightness,
      ageMs: now - e.updatedAt,
      stale: down,
    };
  }
  return out;
}

// Diagnostics snapshot for the admin page / logs. Includes a sample of the actual received
// entries (screen, raw index, resulting input number, text) so an operator can confirm the
// screen/index mapping lines up with the pip numbers without guessing.
export function tslStatus() {
  const now = Date.now();
  const received = [...store.values()]
    .sort((a, b) => a.screen - b.screen || a.index - b.index)
    .slice(0, 100)
    .map((e) => ({
      screen: e.screen,
      index: e.index,
      inputNumber: e.index + resolved.indexOffset,
      text: e.text,
      ageMs: now - e.updatedAt,
    }));
  return {
    ...stats,
    indexOffset: resolved.indexOffset,
    feedTimeoutMs: resolved.feedTimeoutMs,
    feedDown: feedDown(),
    feedAgeMs: stats.lastPacketAt ? now - stats.lastPacketAt : null,
    entries: store.size,
    received,
  };
}

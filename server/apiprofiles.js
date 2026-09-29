// server/apiprofiles.js
// Board API version profiles — what differs between the Neuron View API versions this app
// can talk to, and how to tell which one a card is running.
//
// The design rule is "tolerant reads, shaped writes":
//   - READS never consult a profile. Every reader in board.js accepts the shape of every known
//     version (6- or 8-digit colors, justification present or absent), so a preview or listing
//     works no matter what the card runs or what we think it runs.
//   - WRITES (widget PUT/POST) are shaped to the card's profile by shapeWidget(). Shaping only
//     touches the KNOWN deltas listed on each profile; every other field is passed through
//     verbatim from what the board gave us. So a future minor API release that only adds
//     fields round-trips untouched with no code change — a new profile is only needed when a
//     release changes the meaning or format of a field we write.
//
// Which profile a card uses is resolved in board.js (profileFor): an admin pin on the card
// (config cards[].apiVersion) wins; otherwise the card is auto-detected from GET /v1/self using
// each profile's `detect` signature, newest first.
//
// ADDING A VERSION: append a profile below with its detect() signature and its deltas, then
// teach shapeWidget() about any new delta flag. Keep the list ordered oldest -> newest.

// 8-digit color layout on API 2.0+. The published spec only shows `color::ffffffff`, which
// doesn't reveal the byte order. We assume RRGGBBAA (alpha trailing, the CSS convention).
// If previews show wrong hues on 2.0 cards, flip this to 'leading' (AARRGGBB) — it's the one
// place that encodes the assumption, for both preview decoding and 6<->8 digit conversion.
export const COLOR_ALPHA_POSITION = 'trailing';

const PROFILES = [
  {
    version: '1.13',
    spec: 'api 1-13.yaml',
    colorDigits: 6,          // color::rrggbb
    boxJustification: false, // box elements have no `justification` — must not be sent
    licensing: false,        // no /v1/misc/licensing
    // Baseline: anything that doesn't match a newer signature.
    detect: () => true,
  },
  {
    version: '2.0',
    spec: 'api 2-0.yml',
    // The 2.0 spec shows `color::ffffffff`, but real 2.0 firmware stores and returns 6-digit
    // colors (verified on hardware 2026-09-29). It ACCEPTS 8 digits without error and stores
    // them verbatim, so writing the spec's format silently corrupts widgets — which is how
    // un-solo came to restore every window with 8-digit colors. Stay on 6 digits; any 8-digit
    // value already on a card (from that bug) is narrowed back on its next write.
    colorDigits: 6,
    boxJustification: true,  // box elements REQUIRE `justification`
    licensing: true,         // GET /v1/misc/licensing
    // 2.0 added App.productDate to /v1/self as a required (nullable) field. Structural, so it
    // doesn't depend on how productVersion strings are formatted.
    detect: (self) => !!(self && self.app && typeof self.app === 'object' && 'productDate' in self.app),
  },
];

const BY_VERSION = new Map(PROFILES.map((p) => [p.version, p]));

// Versions an admin may pin a card to, oldest -> newest.
export const API_VERSIONS = PROFILES.map((p) => p.version);

// Used when a card can't be detected (e.g. /self failed) and isn't pinned. Newest, because
// that's what the fleet is being moved to; a write rejected under it triggers a re-detect.
export const FALLBACK_VERSION = PROFILES[PROFILES.length - 1].version;

export function getProfile(version) {
  return BY_VERSION.get(version) || null;
}

export function isKnownVersion(version) {
  return BY_VERSION.has(version);
}

// Newest profile whose signature matches a /v1/self response.
export function detectProfile(self) {
  for (let i = PROFILES.length - 1; i >= 0; i--) {
    if (PROFILES[i].detect(self)) return PROFILES[i];
  }
  return PROFILES[0];
}

// --- Colors ----------------------------------------------------------------

const COLOR_RE = /^color::([0-9a-f]{6}|[0-9a-f]{8})$/i;

// Split a 6- or 8-digit board color into { rgb, alpha } (alpha as 2 hex digits).
function splitColor(hex) {
  if (hex.length === 6) return { rgb: hex, alpha: 'ff' };
  return COLOR_ALPHA_POSITION === 'leading'
    ? { rgb: hex.slice(2), alpha: hex.slice(0, 2) }
    : { rgb: hex.slice(0, 6), alpha: hex.slice(6) };
}

// Board color digits (either width) -> CSS color, for previews. Opaque colors stay #rrggbb.
export function colorToCss(hex) {
  if (typeof hex !== 'string' || !/^([0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex)) return null;
  const { rgb, alpha } = splitColor(hex);
  return alpha.toLowerCase() === 'ff' ? `#${rgb}` : `#${rgb}${alpha}`;
}

// Re-encode a `color::...` value for a profile's width. Non-color values (protocol::, '',
// reference::) and already-correct widths are returned unchanged. Going 8 -> 6 drops alpha,
// which 1.13 can't represent.
function colorForProfile(value, profile) {
  const m = typeof value === 'string' ? COLOR_RE.exec(value) : null;
  if (!m || m[1].length === profile.colorDigits) return value;
  const { rgb, alpha } = splitColor(m[1]);
  if (profile.colorDigits === 6) return `color::${rgb}`;
  return `color::${COLOR_ALPHA_POSITION === 'leading' ? alpha + rgb : rgb + alpha}`;
}

function recolorProps(props, profile) {
  if (!props || typeof props !== 'object') return props;
  const out = { ...props };
  for (const [k, v] of Object.entries(out)) out[k] = colorForProfile(v, profile);
  return out;
}

// --- Widget shaping --------------------------------------------------------

// Shape a WidgetChange body for the given profile. Returns a new object; never mutates the
// input (callers pass persisted solo captures). Only known deltas are touched.
export function shapeWidget(change, profile) {
  const elements = (change.elements || []).map((el) => {
    if (!el || typeof el !== 'object') return el;
    let props = recolorProps(el.properties, profile);
    if (props && el.type === 'box') {
      if (profile.boxJustification) {
        // Required on 2.0. '' = board default, which is what a widget authored on 1.13 had.
        if (typeof props.justification !== 'string') props = { ...props, justification: '' };
      } else if ('justification' in props) {
        const { justification, ...rest } = props;
        props = rest;
      }
    }
    return props === el.properties ? el : { ...el, properties: props };
  });
  return { ...change, elements, properties: recolorProps(change.properties, profile) };
}

// --- Justification (preview) ------------------------------------------------

// 'justification::topleft' -> { h: 'left', v: 'top' }. Unknown/empty -> null (centered).
export function parseJustification(value) {
  const m = typeof value === 'string'
    && /^justification::(top|center|bottom)(left|center|right)$/.exec(value);
  return m ? { v: m[1], h: m[2] } : null;
}

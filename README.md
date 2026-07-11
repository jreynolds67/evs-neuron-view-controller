# Neuron MV Snapshot Control

A touch-first web controller for **EVS Neuron View** multiviewer cards, deployed as a
single Docker container and served to **EVS Cerebrum** router touch panels by IP.

Its one job: let an operator recall a saved snapshot onto **one multiviewer head**,
using the Neuron API's **partial (per-head) restore**. It **never** performs a full
snapshot restore — that path does not exist in the code.

## Operator flow

`Card → Head → Snapshot → (source head if ambiguous) → Confirm → Load`

Each panel is identified automatically by its **source IP**, so a given Cerebrum panel
only ever sees the cards it's assigned. No login, no keyboard — large touch targets and
a mandatory confirm sheet before anything fires.

## Why a backend (not browser-direct)

The panels talk to this container; the container talks to the boards. This is deliberate:

- Neuron boards almost certainly don't send CORS headers, so a browser couldn't call
  them directly anyway.
- It's the single choke point that enforces **partials-only**.
- Board IPs stay hidden from the panels.
- One upstream WebSocket per board is fanned out to all subscribed panels.

## Partials-only guarantee

Every restore goes through `restorePartial()` in `server/board.js`, which hard-codes
every `SnapshotRestore` flag to `false` except `restoreHeadsPartial`. `restoreHeads`
(the full-heads restore) is always `false`. An empty head map is refused rather than
sent. There is no code path that sets any full-restore flag to `true`.

If the app can't read the head list out of a snapshot's stored model on a given board,
it **blocks the restore** rather than guessing a mapping or falling back to a full
restore.

## Layouts

Panels are `1920 × 1080` (`layout: "1080"`) or `1835 × 291` (`layout: "strip"`). The
strip layout hides the stepper and compacts everything to fit the short height.

## Configuration

All admin config is a single JSON file on a Docker volume (`/data/config.json`). No
database. Edit it through the **admin page** (`/admin.html`) — define the 12 cards
(id / label / board IP), then each panel (its IP, layout, assigned cards, and optional
per-head snapshot filters).

See `config/config.example.json` for the shape.

### Per-head snapshot filters

In the admin page, expand a panel, click **Probe cards**, and tick which snapshots are
allowed for each head. Untouched heads allow all snapshots. Filters are enforced again
server-side at restore time.

### Snapshot list behavior

The board's `/v1/snapshots` returns full metadata objects (not just UUIDs, despite the
published spec). The app normalizes these and:

- **Hides board-deleted snapshots** (`deleted: true`) by default. On this firmware the
  `deleted` flag is accurate — tombstoned snapshots stay in the list but shouldn't be
  offered for recall, and hiding them also removes confusing name duplicates where a live
  and a deleted snapshot share a name. To include them for troubleshooting, append
  `?includeDeleted=1` to the panel snapshots request.
- **Groups by folder** using the snapshot `path` field (e.g. "Layout Presets",
  "Position Specific"), matching the board's own organization. Folders whose entries are
  all deleted disappear from the list automatically.

## Local development

```bash
npm install
CONFIG_PATH=./config/config.json npm start
# open http://localhost:8080/admin.html to configure
# open http://localhost:8080/ to use the panel (you'll be "unregistered" unless your
# machine's IP matches a configured panel IP)
```

## Deploy in Portainer

**Option A — Git stack (recommended):**
1. Push this repo to GitHub.
2. Portainer → Stacks → Add stack → *Repository*, point at the repo, compose path
   `docker-compose.yml`.
3. Set an admin credential in `config.json` (see **Admin login** below).
4. Deploy. The app is on port `8080`; config persists in the `neuron_config` volume.

**Option B — Prebuilt image:** build and push to a registry (e.g. GHCR), then set
`image:` in `docker-compose.yml` instead of `build:`.

### Admin login

Admin access requires a username/password stored in `config.json` under
`admin: { user, passwordHash }`. The password is stored as a salted scrypt hash, never
plaintext. Generate a hash and paste it into config:

```bash
node server/auth.js "yourpassword"
# -> scrypt$<salt>$<hash>   (copy this whole string into admin.passwordHash)
```

Example config block:

```json
"admin": { "user": "operator", "passwordHash": "scrypt$ab12…$cd34…" }
```

Signing in sets a session cookie that ends when the browser session closes or after 30
minutes of inactivity; there is no persistent "remember me." Loading the admin page
without a valid session redirects to the login screen. The panel-facing API is always
scoped by source IP regardless of admin login.

## Notes / things to verify on hardware

- **Snapshot model shape.** `extractSnapshotHeads()` parses the blob from
  `/v1/snapshots/{uuid}/model` to find head UUIDs. The API spec doesn't formally document
  that blob, so confirm heads are enumerated correctly on your firmware. If not, the
  parser in `server/board.js` is the one place to adjust — everything else is stable.
- **WebSocket messages.** The board's `ws://<ip>` stream is relayed to panels but the UI
  currently just uses it as a liveness signal; lists refresh on navigation. If you want
  live auto-refresh of snapshot lists, wire `ws.onmessage` in `public/app.js` to the
  relevant board event.

## Layout of the repo

```
server/
  index.js    Express app, panel + admin APIs, WebSocket fan-out
  board.js    Neuron board client; partials-only restore lives here
  config.js   JSON-on-volume config store
public/
  index.html  Operator touch UI
  app.js       ""      flow logic
  admin.html  Admin page
  admin.js      ""    logic
  style.css   Shared styling (dark broadcast control aesthetic, two layouts)
Dockerfile
docker-compose.yml
```

# Neuron MV Snapshot Control

A touch-first web controller for **EVS Neuron View** multiviewer cards, deployed as a
single Docker container and served to **EVS Cerebrum** router touch panels by IP.

Its one job: let an operator recall a saved snapshot onto **one multiviewer head**, using
the Neuron API's **partial (per-head) restore**. It **never** performs a full snapshot
restore — that path does not exist in the code.

---

## Table of contents

- [What it is and why](#what-it-is-and-why)
- [Architecture](#architecture)
- [Operator experience](#operator-experience)
- [Admin experience](#admin-experience)
- [The partials-only guarantee](#the-partials-only-guarantee)
- [Live preview refresh & caching](#live-preview-refresh--caching)
- [Fullscreen ("solo") a window](#fullscreen-solo-a-window)
- [Configuration reference](#configuration-reference)
- [Admin login](#admin-login)
- [Install & deploy](#install--deploy)
- [Networking (ipvlan / macvlan)](#networking-ipvlan--macvlan)
- [Environment variables](#environment-variables)
- [Local development](#local-development)
- [Operational notes & hardware quirks](#operational-notes--hardware-quirks)
- [Repository layout](#repository-layout)

---

## What it is and why

The native Neuron GUI can restore an entire snapshot to a whole card at once. In a live
broadcast environment that is dangerous: a **full board restore** replaces every head
simultaneously **and changes every head's internal UUID**, which breaks any system that
references heads by ID. This app exists to make **per-head recall the only operation an
operator can perform** — recall one saved head's layout onto one target head, nothing
else. Full snapshot restore is deliberately impossible through this interface.

Panels are EVS Cerebrum touch surfaces (IP-authenticated browsers). Each is identified by
its **source IP**, so a given panel only ever sees the cards and heads it's assigned. No
per-operator login on the panel side, no keyboard — large touch targets and a mandatory
confirm step before anything fires.

## Architecture

```
 Cerebrum touch panels                Neuron View cards (boards)
 (IP-authenticated browsers)          (HTTPS REST API, self-signed cert)
          |                                        ^
          |  HTTP (this container)                 |  HTTPS + partials-only restore
          v                                        |
 +-------------------------------------------------+----------+
 |  Neuron MV Control  (Node.js / Express, single container)  |
 |                                                            |
 |  - Enforces partials-only restore (the choke point)        |
 |  - Hides board IPs/credentials from panels                 |
 |  - Works around CORS and the boards' self-signed certs     |
 |  - Serves the operator UI and the admin UI                 |
 |  - Caches hot board reads; polls for live preview updates   |
 +------------------------------------------------------------+
```

The panels talk only to this container; the container talks to the boards. This is
deliberate:

- Neuron boards don't send CORS headers, so a browser couldn't call them directly.
- The container is the single choke point that enforces **partials-only**.
- Board IPs and the self-signed-cert handling stay hidden from the panels.

**Stack:** Node.js 20 / Express, vanilla-JS frontend (no build step). Config is a single
JSON file on a Docker volume — no database. Runtime dependencies are `express`, `undici`
(board HTTP with a scoped self-signed-cert agent), and `ws`.

## Operator experience

Flow: **Head → Snapshot → (source head if ambiguous) → Confirm → Load**.

- **Head grid** — the panel's assigned heads, laid out on a fixed-column grid (7 columns
  for 1080, 8 for strip/CTP) with a live preview thumbnail per head.
- **Snapshot list** — grouped by folder (e.g. "Layout Presets", "Position Specific"),
  matching the board's own organization. Restricted per head to an admin-defined allow-list
  unless the panel has the optional "Show all snapshots" override enabled.
- **Source head** — if the snapshot contains several named heads, the operator picks which
  one to copy from; each option shows a rendered preview of that head's layout.
- **Confirm** — a mandatory confirm sheet before the restore fires.
- **Enlarged (input-group) editor** — 1080 heads can be opened full-screen to repoint
  individual windows (PiPs) to different input groups by number.
- **Fullscreen a window ("solo")** — in the enlarged editor, **press and hold** a window to blow
  it up to fill the head, video-only (its UMD/clock/audio-meter overlays are stripped for a clean
  full-frame source); **press and hold again** to restore the original mosaic. A held gesture shows
  a "working" spinner the moment it registers, so the operator knows to let go while the board
  redraws. The soloed view turns green, and a centered on-screen prompt
  (not a disappearing toast) shows how to go back. Source-repointing is disabled while soloed.
  This is a **live, shared** change — every panel viewing that head sees it, any panel can
  restore it, and the state **persists** (see below) so a redeploy can't strand an on-air head.

Panels that aren't registered show their own client IP in the footer, so an admin can see
exactly what to enter in the admin page.

## Admin experience

The admin page (`/admin.html`, login-gated) has four tabs:

- **Panels** — master/detail list. Panels can be organized into named, collapsible,
  drag-reorderable **groups**; ungrouped panels sit at the bottom. Panels with a missing
  head show a red warning badge. Per panel: assign heads (drag to reorder), lay them out on
  the physical grid, toggle "Allow show all", duplicate.
- **Heads** — per head, choose which snapshots operators may recall, grouped by folder with
  a per-folder select-all checkbox.
- **Backups & sharing** — scheduled daily backups (dual output: a whole-board archive plus
  a per-snapshot ZIP) and the auto-share sweep.
- **Setup** — the card definitions (id / label / board IP) with an inline **storage
  readout** per card (used vs. the board-reported capacity — ~500 MB ceiling — amber at 75%,
  red at 90%), plus a live
  board-activity log.

## The partials-only guarantee

Every restore goes through `restorePartial()` in `server/board.js`, which hard-codes every
`SnapshotRestore` flag to `false` except `restoreHeadsPartial`. `restoreHeads` (the
full-heads restore) is always `false`. An empty head map is refused rather than sent. There
is no code path that sets any full-restore flag to `true`.

If the app can't read the head list out of a snapshot's stored model on a given board, the
operator UI **blocks the restore** rather than guessing a mapping — it will not offer a
source head it couldn't parse. Note this particular block is client-side: the restore
endpoint doesn't re-check `snapshotHeadUuid` against the parsed model. That is not a hole in
the partials-only guarantee, which is structural and server-side (above) — an unparseable or
bogus source head is simply rejected by the board. The per-head **snapshot filter**, by
contrast, *is* re-enforced server-side at restore time — including its one exception: a restore
may bypass the filter only when the client asks for the "Show all" override **and** the panel
has `allowShowAll` set. Both halves are checked server-side against stored config, so a panel
can't grant itself the override.

**Heads are bound by UUID** everywhere (panel assignments, layout grid, snapshot filters).
This is rename-safe — renaming a head on the board keeps every binding intact. The tradeoff
is that a **full board restore performed from the native GUI** changes all head UUIDs and
orphans those bindings; the app detects this (the "Refresh head names" action flags the
affected panels with a clear explanation) rather than silently healing it. Full restores
should be prevented by operator training and by restricting native-GUI access.

## Live preview refresh & caching

Head previews update live so a recall performed on **another panel** appears without
navigating:

- The heads grid and the enlarged editor **poll** the board (~5 s interval, with 0–2 s
  jitter so panels don't synchronize into a herd). The enlarged editor skips a refresh
  cycle while an operator is mid-edit, and refreshes immediately on close.
- This replaced an earlier WebSocket approach: the Neuron boards answer the WS handshake
  with a plain HTTP page rather than a socket upgrade, so a usable board WS endpoint isn't
  available on this firmware.
- Preview and input-group reads are **cached server-side** (~3.5 s TTL) with **in-flight
  coalescing**, so N panels polling the same head collapse into **one** board fetch per
  cycle. Board load therefore scales with the number of distinct heads being viewed, not
  with panel count. A group change or a restore invalidates the affected head's cache so the
  operator sees their own change immediately.

## Fullscreen ("solo") a window

Press-and-hold a window in the enlarged editor to blow it up to fill the head, then hold again
to restore the mosaic. The implementation is non-obvious because of a **hard firmware limit**
this project proved by testing (documented in the code and dev notes): on Neuron View you
**cannot hide or move a widget out of the way** — geometry is clamped on-canvas, there's no
z-order control, a minimum render size, and off-screen/zero geometry is stored but not rendered.
The **only** way to get a clean single-window fullscreen is to have a head that contains *just
that one widget*.

So "solo" works by **capture → delete → recreate**, all on the live head via `server/solostore.js`
and the widget CRUD in `server/board.js`:

1. **Capture** the head's full widget layout (every widget's complete definition) and persist it
   to the volume (`SOLO_STATE_PATH`, default `/data/solo-state.json`).
2. **Delete** every widget except the target, and set the target to full-canvas, **video-only**
   (keep its `pip` element filled to the frame; drop UMD/clock/audio-meter overlays and border).
3. **Restore** recreates the deleted widgets from the capture and puts the target back exactly.
   Recreated widgets get new UUIDs — fine, because the app never persists widget UUIDs. Ordering
   doesn't matter since these heads never overlap. The delete and recreate board calls run with
   bounded parallelism so a large mosaic restores quickly.

Because the capture is **persisted on the volume**, a soloed head survives a container redeploy
and any panel can restore it — the state is the head's, not a browser session's. A **snapshot
recall** to a soloed head wins and discards the capture; un-solo has a **staleness guard** so if
the head was rebuilt externally (e.g. the native GUI) it drops the stale capture instead of
duplicating windows onto the new layout. Solo/restore invalidate the head's preview cache so the
change shows immediately.

A head holds **exactly one capture**, and its lifecycle is closed on both ends:

- A **new solo replaces** an existing capture only when that capture is stale (its survivor
  widget is gone from the head). If the head is genuinely soloed, solo is refused — overwriting
  would capture the single fullscreen window *as* the original and lose the real mosaic for good.
- Captures whose head is **no longer assigned to any panel** (or whose card was removed) are
  **pruned** on config save and at boot. Un-solo is only reachable from a panel the head is
  assigned to, so such a capture could never be restored and would otherwise sit on the volume
  forever.

## Configuration reference

All config is a single JSON file on the Docker volume at `/data/config.json`. No database.
Most of it is edited through the admin page and applied immediately; only hand-edits to the
file require a container restart (the config is cached at startup). See
`config/config.example.json` for a working shape.

Top-level keys (all siblings):

| Key | Purpose |
| --- | --- |
| `admin` | `{ user, passwordHash }` — admin login credential (hashed). See below. |
| `configVersion` | **Server-managed.** Bumped on every save; used to detect two admin sessions saving over each other. Don't hand-edit it. |
| `cards` | Array of `{ id, label, ip }` — the multiviewer cards. IPs never reach panels. |
| `panels` | Array of panel definitions (IP, label, layout, assigned heads, grid, group, `allowShowAll`). |
| `panelGroups` | Ordered array of group names for the admin panel list. |
| `headFilters` | Map of `"cardId::headUuid"` → allowed snapshot UUIDs. Empty = all allowed. |
| `settings` | Misc UI settings (e.g. `showUuids`). |
| `backup` | Scheduled backup config: `{ enabled, cardId, timeHHMM, retentionCount, configRetentionDays }`. Managed on its own tab. (`retentionDays` is a legacy name still read as a fallback for `retentionCount`.) |
| `shareSweep` | Auto-share sweep config. Managed on its own tab. |

`admin` is **server-authoritative**: it is never sent to the client and never accepted from
it, so no config save can read or overwrite the credential.

`backup` and `shareSweep` are **not** — they are edited inline on the Backups tab and arrive
with the main config save, which validates and normalises them (and re-applies the sweep
schedule immediately). The admin page is a single page with one config object and one Save,
so its tabs can't clobber each other.

The save is a **whole-config replace**, guarded by `configVersion`: the page sends the version
it loaded, and the server refuses the save if the stored version has moved on. So two admin
windows open at once no longer silently last-write-win — the second Save is **rejected** with a
clear message instead of reverting the first. Every write bumps the version, including "Back up
now" (which saves through its own endpoint), so those paths hand the new version back to the page.

Admin windows also **stay in step live**. Every config write broadcasts `config-changed` on the
same control WebSocket the panels use, and any other open admin page reacts:

- **No unsaved edits** → it re-loads the config silently, so the change just appears (a backup
  time edited in one window shows up in the other without a refresh).
- **Unsaved edits** → it does **not** touch them. A sticky banner says the config moved and
  offers *Reload config*; reloading discards local edits, so **Export backup** first if you need
  them. Dismissing the banner leaves the page stale, and its next Save is refused as above.

Note `config-changed` is deliberately separate from the panels' `reload` message: a panel holds
no state and can reload instantly, an admin page may hold unsaved work and must never be
reloaded out from under someone. "Back up now" sends `config-changed` **only** — it must not
bounce operator panels mid-show.

### Per-head snapshot filters

In the admin **Heads** tab, pick a card and expand a head, then tick which snapshots are
allowed — grouped by folder, with a per-folder select-all. Untouched heads allow all
snapshots. Filters are enforced again server-side at restore time, not just in the UI.

A panel with **"Allow show all"** enabled can toggle the filter off for the snapshot step and
recall anything on the card — the override covers browsing *and* loading. It reverts on any
navigation, so it never sticks. Panels without the flag can't request it: the server checks
`allowShowAll` against stored config on both the list and the restore.

### Snapshot list behavior

The board's `/v1/snapshots` returns full metadata objects (not just UUIDs, despite the
published spec). The app normalizes these and:

- **Hides board-deleted snapshots** (`deleted: true`) by default. Append
  `?includeDeleted=1` to the panel snapshots request to include them for troubleshooting.
- **Groups by folder** using the snapshot `path` field, matching the board's organization.
  Folders whose entries are all deleted disappear automatically.

## Admin login

Admin access requires a username/password stored in `config.json` under
`admin: { user, passwordHash }`. The password is a **salted scrypt hash**, never plaintext.
A signed-in session is a cookie that ends when the browser session closes or after **30
minutes** of inactivity — there is no persistent "remember me". Loading the admin page
without a valid session redirects to the login screen. (The panel-facing API is always
scoped by source IP regardless of admin login.)

Generate a hash on any machine that has the repo:

```bash
node server/auth.js "your-real-password"
# -> scrypt$<salt>$<hash>   (copy the whole string)
```

> **Never copy the `admin` block out of `config/config.example.json`.** That file is a
> committed reference template, so its `passwordHash` is public — it hashes the password
> **`changeme`**. Copying it into a live config gives your admin page a password that anyone
> with repo access already knows. Always generate a fresh hash with the command above.

**Edit the live config, not the example.** The server reads only `/data/config.json` on the
Docker volume; `config/config.example.json` is a reference template and is never read at
runtime. To set the credential on a running deployment:

1. Generate the hash (above).
2. Open a shell in the container (Alpine, so `/bin/sh`) and edit the live file:

   ```sh
   vi /data/config.json
   ```

   Add the `admin` block as a **top-level** key — a sibling of `cards`, `panels`, etc.,
   right after the opening `{`:

   ```json
   "admin": { "user": "operator", "passwordHash": "scrypt$…your hash…" },
   ```

   (Or edit the volume on the host directly, typically at
   `/var/lib/docker/volumes/neuron_config/_data/config.json`.)

3. **Restart the container** — the config cache loads once at startup, so a hand-edit only
   takes effect after a restart.

Watch for valid JSON (no trailing comma, matched quotes) — a malformed file fails to load.
If no credential is configured, the server logs a warning on boot and admin login is
unavailable until one is set.

## Install & deploy

Runs as a single container. Config persists on the `neuron_config` Docker volume.

**Option A — Git-backed Portainer stack (recommended):**

1. Push this repo to your Git host.
2. Portainer → Stacks → Add stack → *Repository*, point at the repo, compose path
   `docker-compose.yml`.
3. Ensure the external macvlan network exists (see [Networking](#networking-macvlan)).
4. Deploy, then set an admin credential in `config.json` and restart (see
   [Admin login](#admin-login)).

**Option B — Prebuilt image:** build and push to a registry (e.g. GHCR), then set `image:`
in `docker-compose.yml` instead of `build:`.

The image is pinned to `node:20.19-alpine` (≥ 20.15 is required — `server/zip.js` imports
`crc32` from `node:zlib`, added in 20.15; ESM validates that import at load, so an older
base would crash the whole app at startup, not just backups).

**Change types and what they need:**

- **Frontend-only change** (`public/*`) → redeploy the stack, then hard-refresh open panels
  (Ctrl+Shift+R). Panels cache aggressively; a panel opened before a redeploy keeps running
  the old JS until hard-refreshed. Static assets are served no-cache, so a fresh load always
  gets current code.
- **Backend change** (`server/*`, Dockerfile, compose) → rebuild the container (full stack
  redeploy), then hard-refresh panels.

## Networking (ipvlan / macvlan)

The container attaches directly to an existing external L2 network so it has its own LAN
address, rather than being published behind the host:

```yaml
services:
  neuron-mv-control:
    networks:
      neuron_net:
        ipv4_address: 10.10.251.90
    environment:
      PORT: "80"
# ...
networks:
  # Local alias -> the ACTUAL external network name. Portainer prefixes stack networks with
  # the stack name, so a Companion stack's `companion_net` is typically `companion_companion_net`.
  # Confirm the real name under Portainer -> Networks.
  neuron_net:
    external: true
    name: companion_companion_net
```

- The network is `external: true` — it must already exist (created outside this stack). The
  compose `name:` must match the real Docker network name, which may be stack-name-prefixed.
- The container has its own IP and is reached **directly** — there is **no host port
  mapping**. It serves on port 80 (`PORT: "80"`), so panels point at plain
  **`http://10.10.251.90`** (no port suffix), and the admin page is at
  **`http://10.10.251.90/admin`**.
- No custom hostname or MAC is pinned; Docker assigns the interface MAC automatically.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` (compose sets `80`) | Port the app listens on. |
| `TZ` | (compose sets a zone) | Container timezone. Sets what the backup "time" field means and how timestamps read. Without it the container runs in UTC. |
| `CONFIG_PATH` | `/data/config.json` | Path to the config file on the volume. |
| `BACKUP_DIR` | `/data/backups` | Where scheduled backups are written. |
| `SOLO_STATE_PATH` | `/data/solo-state.json` | Where fullscreen ("solo") state is persisted, so a soloed head survives a redeploy and any panel can restore it. On the volume by default; no compose change needed. |
| `BOARD_SCHEME` | `https` | `http` or `https` for the board REST API. |
| `BOARD_PORT` | (scheme default) | Override the board API port. |
| `BOARD_TLS_REJECT_UNAUTHORIZED` | `false` | Set `true` only if boards present a CA-trusted cert (rare on broadcast gear). |
| `BOARD_EXPORT_TIMEOUT_MS` | `600000` (10 min) | Timeout for whole-board snapshot exports (backups). Separate from the 8s default used for ordinary API calls, since an export streams the card's full snapshot storage. |
| `TRUST_PROXY` | (off) | Set `1` **only** if a trusted reverse proxy sits in front and sets `X-Forwarded-For`. Off by default so the header can't be forged to impersonate a panel on a flat network. |

## Local development

```bash
npm install
CONFIG_PATH=./config/config.json npm start
# admin:  http://localhost:8080/admin.html   (needs an admin credential in the config)
# panel:  http://localhost:8080/             (you'll be "unregistered" unless your
#                                              machine's IP matches a configured panel IP)
```

There is no build step — the frontend is plain HTML/CSS/JS served straight from `public/`, and
no webfonts are fetched (system font stack), so the UI renders fully on a closed network.

`npm install` writes `node_modules/` into the checkout. This repo is **deployed from Git**, so
that must never be committed — `.gitignore` covers it (along with `.DS_Store` and any local
config/state). Check `git status` is clean of it before committing.

## Operational notes & hardware quirks

- **Snapshot model shape.** `extractSnapshotHeads()` parses the blob from
  `/v1/snapshots/{uuid}/model` to find head UUIDs, and requires each head to have a real
  name to be selectable (an unnamed head is skipped — that's expected). The API spec doesn't
  formally document that blob, so if heads aren't enumerated correctly on your firmware, the
  parser in `server/board.js` is the one place to adjust.
- **Storage ceiling.** Neuron cards cap snapshot storage at ~500 MB and can corrupt their
  storage layer if overfilled. The Setup tab shows per-card usage against that ceiling; keep
  an eye on cards trending toward the red threshold.
- **Full board restore drifts UUIDs.** A full restore from the native GUI replaces heads
  and their UUIDs, orphaning this app's bindings. "Refresh head names" detects and flags the
  affected panels; re-add the affected heads from the current board heads rather than
  expecting auto-repair.
- **Config edits need a restart.** Hand-edits to `/data/config.json` only take effect after
  the container restarts (config is cached at startup). Changes via the admin page apply
  immediately.
- **Concurrent input-group edits are guarded.** Repointing a window is a read-modify-write
  against a board API with no conditional writes, so `setWidgetGroup()` reads the widget
  twice and aborts if it changed in between (or vanished) — the operator gets "Snapshot
  recalled by another user" instead of a silent clobber. This covers the realistic case: one
  panel recalling a snapshot while another edits input groups on the same head.
- **Solo/un-solo is NOT guarded.** There is no per-head lock anywhere in the solo path, so
  two panels press-and-holding the *same* head within the same operation can race — losing a
  capture, or duplicating the mosaic. Judged outside real operating patterns and accepted
  rather than fixed; see `REVIEW_NOTES.md` §6 for the exact windows and the ~10-line fix if
  duplicated windows ever show up in the wild.

## Repository layout

```
server/
  index.js      Express app, panel + admin APIs, control WebSocket, caching
  board.js      Neuron board client; partials-only restore lives here
  config.js     JSON-on-volume config store (cached, atomic writes)
  auth.js       Admin login: scrypt hashing, sessions, cookies
  cache.js      TTL cache with in-flight coalescing for hot board reads
  backup.js     Scheduled daily backups + retention pruning
  sharesweep.js Auto-share sweep
  zip.js        Dependency-free ZIP writer (for the per-snapshot backup bundle)
  logger.js     In-memory ring buffer of board API activity (admin log)
  solostore.js  Persisted per-head fullscreen ("solo") capture (JSON on the volume)
public/
  index.html    Operator touch UI
  app.js          ""      flow logic, live-preview polling, enlarged editor
  admin.js      Admin page logic (panels, heads, groups, backups, storage)
  login.html    Admin login screen
  style.css     Shared operator styling (dark broadcast-control aesthetic)
private/
  admin.html    Admin page shell — served only via the authenticated route, not
                as a static file, so there's no static path to bypass the login gate
config/
  config.example.json   Reference config shape
api 1-10.yaml           Neuron View API spec, firmware 1.10
api 1-13.yaml           Neuron View API spec, firmware 1.13 (what the boards run now)
REVIEW_NOTES.md         Reviewer context for the fullscreen ("solo") feature — read before
                        judging its capture/delete/recreate design
Dockerfile
docker-compose.yml
.gitignore              Keeps node_modules out of the Git-backed deploy (see Local development)
```

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
- [Configuration reference](#configuration-reference)
- [Admin login](#admin-login)
- [Install & deploy](#install--deploy)
- [Networking (macvlan)](#networking-macvlan)
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
  readout** per card (used vs. the 200 MB ceiling, amber at 75%, red at 90%), plus a live
  board-activity log.

## The partials-only guarantee

Every restore goes through `restorePartial()` in `server/board.js`, which hard-codes every
`SnapshotRestore` flag to `false` except `restoreHeadsPartial`. `restoreHeads` (the
full-heads restore) is always `false`. An empty head map is refused rather than sent. There
is no code path that sets any full-restore flag to `true`.

If the app can't read the head list out of a snapshot's stored model on a given board, it
**blocks the restore** rather than guessing a mapping or falling back to a full restore.

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

## Configuration reference

All config is a single JSON file on the Docker volume at `/data/config.json`. No database.
Most of it is edited through the admin page and applied immediately; only hand-edits to the
file require a container restart (the config is cached at startup). See
`config/config.example.json` for a working shape.

Top-level keys (all siblings):

| Key | Purpose |
| --- | --- |
| `admin` | `{ user, passwordHash }` — admin login credential (hashed). See below. |
| `cards` | Array of `{ id, label, ip }` — the multiviewer cards. IPs never reach panels. |
| `panels` | Array of panel definitions (IP, label, layout, assigned heads, grid, group, `allowShowAll`). |
| `panelGroups` | Ordered array of group names for the admin panel list. |
| `headFilters` | Map of `"cardId::headUuid"` → allowed snapshot UUIDs. Empty = all allowed. |
| `settings` | Misc UI settings (e.g. `showUuids`). |
| `backup` | Scheduled backup config: `{ enabled, cardId, timeHHMM, retentionDays }`. Managed on its own tab. |
| `shareSweep` | Auto-share sweep config. Managed on its own tab. |

`admin`, `backup`, and `shareSweep` are **server-authoritative**: the main config save
never overwrites them (they have their own endpoints), so saving the main page can't clobber
a backup time you set on another tab.

### Per-head snapshot filters

In the admin **Heads** tab, pick a card and expand a head, then tick which snapshots are
allowed — grouped by folder, with a per-folder select-all. Untouched heads allow all
snapshots. Filters are enforced again server-side at restore time, not just in the UI.

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

## Networking (macvlan)

The container attaches directly to an existing external macvlan so it has its own LAN
address, rather than being published behind the host:

```yaml
networks:
  companion_companion_net:
    ipv4_address: 10.10.251.90
# ...
networks:
  companion_companion_net:
    external: true
```

- The network is `external: true` — it must already exist (created outside this stack).
- On macvlan the container has its own IP and is reached directly at
  **`10.10.251.90:8080`** — there is **no host port mapping**. If your panels were pointed at
  a host IP on `:80` under an older bridge setup, repoint them to `10.10.251.90:8080` (or set
  `PORT: "80"` to serve on the standard port).
- No custom hostname or MAC is pinned; Docker assigns the interface MAC automatically.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | Port the app listens on. |
| `CONFIG_PATH` | `/data/config.json` | Path to the config file on the volume. |
| `BACKUP_DIR` | `/data/backups` | Where scheduled backups are written. |
| `BOARD_SCHEME` | `https` | `http` or `https` for the board REST API. |
| `BOARD_PORT` | (scheme default) | Override the board API port. |
| `BOARD_TLS_REJECT_UNAUTHORIZED` | `false` | Set `true` only if boards present a CA-trusted cert (rare on broadcast gear). |
| `TRUST_PROXY` | (off) | Set `1` **only** if a trusted reverse proxy sits in front and sets `X-Forwarded-For`. Off by default so the header can't be forged to impersonate a panel on a flat network. |

## Local development

```bash
npm install
CONFIG_PATH=./config/config.json npm start
# admin:  http://localhost:8080/admin.html   (needs an admin credential in the config)
# panel:  http://localhost:8080/             (you'll be "unregistered" unless your
#                                              machine's IP matches a configured panel IP)
```

There is no build step — the frontend is plain HTML/CSS/JS served straight from `public/`.

## Operational notes & hardware quirks

- **Snapshot model shape.** `extractSnapshotHeads()` parses the blob from
  `/v1/snapshots/{uuid}/model` to find head UUIDs, and requires each head to have a real
  name to be selectable (an unnamed head is skipped — that's expected). The API spec doesn't
  formally document that blob, so if heads aren't enumerated correctly on your firmware, the
  parser in `server/board.js` is the one place to adjust.
- **Storage ceiling.** Neuron cards cap snapshot storage at ~200 MB and can corrupt their
  storage layer if overfilled. The Setup tab shows per-card usage against that ceiling; keep
  an eye on cards trending toward the red threshold.
- **Full board restore drifts UUIDs.** A full restore from the native GUI replaces heads
  and their UUIDs, orphaning this app's bindings. "Refresh head names" detects and flags the
  affected panels; re-add the affected heads from the current board heads rather than
  expecting auto-repair.
- **Config edits need a restart.** Hand-edits to `/data/config.json` only take effect after
  the container restarts (config is cached at startup). Changes via the admin page apply
  immediately.
- **Concurrent edits are guarded.** If two panels touch the same head at once (e.g. one
  recalls a snapshot while another is editing input groups), the second write is rejected
  cleanly with "Snapshot recalled by another user" rather than silently clobbering.

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
Dockerfile
docker-compose.yml
```

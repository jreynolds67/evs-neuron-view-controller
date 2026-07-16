# Reviewer notes

Context for reviewing the fullscreen ("solo") feature and the error-message rework
(commits `19b45c4` → `80cb222`). Written to save a reviewer the archaeology, and to be
honest about what has and hasn't been proven on hardware.

---

## 1. Read this before judging the solo design

The solo feature works by **capturing every widget on a head, deleting all but one,
blowing that one up, and recreating the rest on restore**. On first read this looks
reckless — the obvious implementation is "just resize the target to full-frame and hide
the others."

**That implementation is impossible on this firmware.** It was attempted first, and every
avenue was tested against a real board (10.10.70.11) before the delete/recreate approach
was written:

| Attempted | Result on hardware |
| --- | --- |
| Move a widget off-canvas | **Rejected** — HTTP 400 `"x + width should be in [0, 1]"` |
| Shrink a widget to 0 (or anything < ~0.09) | **Accepted and stored, but not rendered** — the board keeps drawing it at its last valid geometry. A read-back shows `0,0,0,0` while the window is still visibly full-size on air. |
| Set the widget's elements `visible: false` | Same failure class — stored, not rendered |
| Reorder the head's `widgets` array (z-order) | **No visual effect whatsoever** — there is no z-index/layer field |

The live render only responds to **valid in-bounds geometry** (≥ ~0.09) and **`groupUuid`
source changes**. You can rearrange and re-source a widget on air; **you cannot make one
vanish.** The only way to get a clean single-window fullscreen is a head that contains
*just that one widget* — hence delete/recreate.

None of this is in the API spec; it was all established empirically. If a future firmware
adds z-order or honors sub-minimum geometry, this whole feature collapses into something
far simpler and should be rewritten.

Recreated widgets get **new UUIDs**, which is safe *only* because this app never persists
widget UUIDs (heads are bound by UUID; widgets are not). If that ever changes, solo breaks.

## 2. What to scrutinize

### `runPool` is best-effort, and that used to hide a real bug (`server/index.js:573`)

`runPool` does not abort the run when one widget's write fails — one hiccuping widget
shouldn't stop a whole solo/restore. That part is deliberate and unchanged. But until
recently it *swallowed* those failures entirely, which produced a genuine defect:

> A failed delete during solo was silent. Solo returned `{ ok: true }` with the widget
> still on the head, and a later un-solo called `createHeadWidget` on a widget that had
> never been deleted — duplicating it.

Fixed in two parts, both worth reviewing:

1. `runPool` now **returns a failure count**, and solo/un-solo report a partial failure to
   the operator (`SOLO_PARTIAL` / `UNSOLO_PARTIAL`) instead of claiming success over a head
   that is visibly wrong.
2. Un-solo **reconciles against the live widget list** rather than assuming every non-target
   widget was deleted: present → PUT it back to its captured state, absent → recreate. It
   already fetched `live` for the staleness guard, so this costs nothing.

This was reproduced and the fix confirmed against the real server (see §4), but there is
**no regression test in the repo** — the project has no test infrastructure.

**Note the deliberate asymmetry:** un-solo clears the capture *even when writes failed*.
That looks like a bug and isn't. Recreated widgets carry **new UUIDs**, so a second un-solo
would match none of them against the capture and duplicate the mosaic. Partial restore is a
dead end by design; the operator is told to recall a snapshot. Don't "fix" this by making
un-solo retryable without solving the UUID problem first.

### The capture is persisted *before* the deletes (`server/index.js:599`)

Deliberate, for crash safety: if the process dies mid-solo, the layout is recoverable. The
cost is a **transient state where the store says `soloed: true` but the head still holds
the full mosaic**, which a poll can observe. This caused a real bug (every pip showing the
restore prompt for a moment). See §3.

### The video-only strip assumes video == a `pip` element (`server/board.js`)

`setWidgetFullscreenVideoOnly` keeps only `pip` elements and drops UMD/clock/audio-meter
overlays. If a window's video ever isn't a `pip`, that assumption is wrong — hence the
fallback that keeps all elements rather than blanking the window. Verify on hardware
against a variety of window types.

### Recall wins over solo (by design)

A snapshot restore to a soloed head **discards the capture**. The pre-solo mosaic is then
unrecoverable via un-solo — correct per the operator model (the recall is the newer intent),
but worth confirming that's still what's wanted.

## 3. The UI/server split on `soloed` is intentional

Two different consumers, deliberately keyed off different things (`public/app.js`):

- **Visuals** (restore prompt, green/thick border) use `fsIsSoloView()` — requires
  `soloed === true` **and** exactly one widget on the head. This is what a soloed head *is*,
  so the inconsistent intermediate state from §2 can never paint the prompt. It protects
  **every** panel, including ones that didn't initiate the solo.
- **The long-press action and tap-disable** use the raw server `soloed` flag — authoritative
  for "does a capture exist?". So if a solo partially fails and leaves 2 widgets with a
  capture on file, holding still correctly *restores* rather than trying to solo again.

Don't "simplify" these to one flag; the split is load-bearing.

`fsSeq`/`fsBusy` guard against stale in-flight poll responses repainting a superseded
layout — same generation-token pattern as `navSeq` in the main flow.

## 4. Verification status — read this honestly

**The solo feature's core mechanism is hardware-proven** (capture → delete → fullscreen →
recreate; confirmed working on a real board).

**The partial-failure fix in §2 was verified against the real server**, using a throwaway
harness: a fake Neuron board (in-memory widget store) with the real server booted against it
and one DELETE rigged to fail. On the pre-fix code it reproduced the duplication exactly —
the head ended up with input groups `["g1","g2","g3","g3","g4"]`, group 3 twice — and the
fixed code came back clean. **That harness was not kept** (this project has no test
infrastructure and adding it wasn't in scope), so this is a recorded result, not a test you
can re-run. Rebuilding it is maybe 100 lines if this feature grows and someone wants the
regression coverage.

**Not verified — needs a hardware pass:**

- The **two timing fixes** (`b6a5a3f`) — race conditions, only reproducible live.
- **16-way parallelism** (`7c5e1ae`) — performance and board stability under 16 concurrent
  widget writes is unmeasured.
- The **`pip`-element assumption** for video-only (see §2).
- The **unified green** at small preview-tile size, and the **enlarge-button size bump**
  (`80cb222`).

**On running this locally:** the app needs Node **≥ 20.15** (`server/zip.js` imports `crc32`
from `node:zlib`, added in 20.15; ESM validates that import at load, so an older runtime
crashes the whole app at startup, not just backups). The `node` on this machine's PATH is
nvm's **v18** and will not boot the app — but there is a **v24 at `/opt/homebrew/bin/node`**
that runs it fine. If you hit `ERR_MODULE_NOT_FOUND` or a `crc32` error, you're on the wrong
Node, not looking at a real failure.

## 5. Loose end worth fixing

`package.json` declares `"engines": { "node": ">=20" }`, but the true floor is **20.15**
(see above). The Dockerfile pins `node:20.19-alpine` so deployments are fine — but the
declared engine range would happily accept a 20.0–20.14 runtime that crashes on boot.
`>=20.15` would be honest.

## 6. Deliberately not addressed

The following were reviewed and **consciously declined** by the project owner — they aren't
oversights:

- **Panel auth is IP-only** — intentional. Cerebrum panels have no login and no keyboard.
- **The control WebSocket is unauthenticated** — accepted risk on a flat broadcast LAN.
- **Backups held in memory** during export — fine at the ~500 MB card storage ceiling.
- **Solo/un-solo has no per-head lock.** There is no mutex anywhere in the solo path, so
  concurrent operations on the *same head* can race. The realistic one: un-solo reads the
  capture at `index.js:615` and doesn't clear it until after every recreate finishes
  (`index.js:632`) — seconds on a big mosaic. A second panel entering un-solo in that window
  gets the same capture, passes the same staleness guard, and recreates the whole mosaic
  again. There's also a narrower solo/solo race that can lose a capture outright.
  **Declined:** the owner has tested multi-user conflicts without observing problems, and
  judges two operators hold-to-restoring the same head within the same restore to be outside
  real operating patterns. Worth knowing the window is real if duplicated windows ever show
  up in the wild — a per-head promise-chain lock (~10 lines, wrapping both handlers with the
  `isSoloed` check moved inside) is the fix, and it's independent of everything in §2.

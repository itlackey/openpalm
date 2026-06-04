# UI Distribution & Auto-Update — Gap Analysis

**Date:** 2026-06-04
**Scope:** OpenPalm's Electron-shell + SvelteKit (`adapter-node`) UI distribution and update path, measured against the "Simplified SvelteKit Node Updater Plan."

This compares the recommended reference architecture (GitHub Releases as index/host, hash-verified self-contained Node bundle, Electron-owned lifecycle, pointer-swap promotion with health-gated rollback) to what this repo actually ships today.

## TL;DR

OpenPalm already implements the **core of the recommended architecture**: Electron is the native shell that owns the local Node (SvelteKit `adapter-node`) server lifecycle; GitHub Releases is the update index and asset host; the UI ships as a self-contained `ui-build.tar.gz`; downloads are SHA-256 verified; and the server is bound to loopback only. The largest *intentional* divergence is that we treat the bundled-in-app UI as the primary source of truth and `data/ui` as an optional newer overlay (version-stamp arbitrated), rather than a `current.json`/`previous.json` pointer model in `userData`.

The real **gaps** worth closing are: (1) no health-gated automatic **rollback** after an update, (2) checksum verification is **best-effort** (silently skipped if the checksums asset is missing), (3) no **compatibility manifest** gating UI-vs-shell/Node version skew, and (4) the privileged-boundary recommendation (minimal env to the server) is **not** met — the UI server inherits the full parent environment.

---

## Architecture mapping (what plays each role)

| Reference role | OpenPalm implementation | File |
|---|---|---|
| Electron shell owns updater | `checkForElectronUpdate` (app), `checkAndUpdateUiBuild` (UI) run at launch | `packages/electron/src/update-check.ts`, `packages/lib/src/control-plane/ui-assets.ts` |
| Electron owns verification | SHA-256 vs `checksums-sha256.txt` in `seedUiBuild` | `ui-assets.ts:seedUiBuild` |
| Electron owns Node process lifecycle | `startUIServer`/`stopUIServer`: spawn `node build/index.js`, PID file, stale-server reaping, group-kill of subtree | `packages/electron/src/main.ts` |
| Electron starts current bundle | `resolveUiBuildDir()` → `spawn('node', [join(dir,'index.js')])` | `main.ts:startUIServer` |
| GitHub Releases = index + host | `releases/latest` API + `releases/download/<tag>/ui-build.tar.gz` | `ui-assets.ts`, `update-check.ts` |
| `sveltekit-node-bundle.tar.gz` | `ui-build.tar.gz` (tar of `packages/ui/build`, includes server, client, `package.json`, `.openpalm-ui-version`) | `.github/workflows/release.yml` "Build UI artifact" |
| `sveltekit-node-bundle.sha256` | `checksums-sha256.txt` (sha256sum of all release assets, one shared file) | release.yml "Generate checksums" |
| `update-manifest.json` | **absent** — replaced by `.openpalm-ui-version` stamp + GitHub tag | — |
| Pointer files (`current.json`/`previous.json`) | **absent** — single `data/ui` dir + bundled fallback, arbitrated by version stamp | `ui-assets.ts:resolveUiBuildDir` |
| `userData/versions/<v>/` retention | **absent** — one live `data/ui`; previous build moved to `data/backups/ui-<ts>` | `ui-assets.ts:checkAndUpdateUiBuild` |
| Health check `/__health` | `/health` (accepts 200 **or** 401), 60s `waitForReady` | `main.ts:waitForReady` |
| Loopback bind | `HOST=127.0.0.1`, `ORIGIN=http://127.0.0.1:<port>` | `main.ts:buildUIServerEnv` |

---

## Where we MEET or IMPROVE on the recommendation

### 1. Self-contained bundle, no on-device install (MEETS, recommendation §6/§7)
`ui-build.tar.gz` is the `adapter-node` output and is run directly with `node build/index.js`. No `npm/bun install` and no build step on the user's machine — exactly the "boring artifact" the plan asks for. The runtime dependency story is even simpler than the reference: SvelteKit's `adapter-node` output bundles its server deps via Rollup, so we don't even ship a `node_modules/` in the tarball.

### 2. Dual-channel version-stamp arbitration > single pointer file (IMPROVEMENT, recommendation §9/§10)
The reference keeps the active version in `userData` and selects it with `current.json`. We ship the UI **inside the app** (`extraResources: ui-build`) *and* allow an operator-updatable `data/ui`, and `resolveUiBuildDir()` picks whichever is **strictly newer** by the `.openpalm-ui-version` stamp (`compareVersionTags`). Why this is better for our shape:

- **A reinstall/downgrade of the app is self-healing.** With a pure `current.json` pointer in `userData`, installing an *older* shell still runs the *newer* (possibly incompatible) UI that the pointer references. Our rule — "an unstamped or older `data/ui` never shadows the bundled build" — means the app always falls back to a UI it was actually built and tested with. This is the exact bug we shipped and fixed in rc.2 (a stale `data/ui` shadowing the bundled UI); the version-aware selector is the durable fix.
- **It still supports "update the UI without shipping a new app"** (recommendation's stated goal D5): seed a newer-stamped build into `data/ui` and it's picked up on next launch — no pointer bookkeeping.

The stamp travels with the build everywhere (bundled into the AppImage, and inside the tarball), so the comparison is always available wherever the build lands.

### 3. Two independent update tracks already exist (PARTIAL IMPROVEMENT, recommendation §3)
The plan wants the *web* update stream decoupled from the *shell* update stream. We don't use `web-v*`/`shell-v*` tags, but we **do** have two independent runtime updaters:
- **App/shell**: `checkForElectronUpdate` (notify-only — surfaces a banner, user downloads a new AppImage/dmg/exe).
- **UI bundle**: `checkAndUpdateUiBuild` (auto-downloads `ui-build.tar.gz` into `data/ui`).

So a UI fix can reach users **without a full app reinstall** even though both share one release tag. (See gap G5 for the cost of sharing the tag.)

### 4. Robust process lifecycle beyond the reference (IMPROVEMENT, recommendation §8)
`main.ts` goes further than "spawn a child":
- Detached process group + `killProcessTree` so the UI server's *own* children (e.g. the wizard's `opencode serve`) are reaped, not orphaned.
- PID file + `killStaleUIServer` to reap a server left by a previously crashed Electron instance.
- Stderr ring buffer (200 lines) surfaced in the "failed to start" dialog — real diagnostics, not a silent hang.

### 5. Non-fatal update failures (MEETS, recommendation §11)
`checkAndUpdateUiBuild` returns `{updated:false,error}` on any network/extract failure and the app proceeds with the on-disk build. Offline / missing-asset / API-error all keep the current UI running — matching the plan's "do not roll back on update-check failure."

---

## GAPS (recommendation features we do NOT implement)

### G1 — No health-gated automatic rollback (HIGH, recommendation §10/§11)
**Reference:** start new bundle → health check → if it fails, repoint to `previous.json` and restart.
**Us:** `waitForReady` polls `/health` for 60s; on failure we show an error box and **`app.quit()`**. There is no automatic fallback to the previous build.

This is the most material gap. The risk is real because `checkAndUpdateUiBuild` runs *before* `startUIServer` and **mutates `data/ui` in place** (it `rm`s `data/ui` then extracts the new tarball; the previous build is moved to `data/backups/ui-<ts>` first). So a bad UI release can leave the app unable to start, and the only recovery is the version-stamp fallback to the *bundled* UI — which only helps if the bundled build is present and not older. The backup in `data/backups/` exists but is **never automatically restored**.

**Recommended fix:** after `waitForReady` fails, if a `data/backups/ui-<ts>` (or the bundled build) is available, restore it and re-`startUIServer` once before giving up. Record the failed version so the next launch doesn't re-download it (see G4).

### G2 — Checksum verification is best-effort, not enforced (✅ CLOSED 2026-06-04)
**Closed** by moving UI distribution to npm (see `ui-independent-versioning-investigation.md`). `downloadNpmUiBundle` now verifies the registry `dist.integrity` (sha512) **fail-closed** — a present-but-wrong hash throws before the existing build is touched. (Original finding retained below for history.)


`seedUiBuild` only verifies SHA-256 **if** `checksums-sha256.txt` downloads *and* contains a `ui-build.tar.gz` entry. If the checksums fetch fails (`.catch(() => null)`) or the entry is absent, extraction proceeds unverified. The plan treats the downloaded bundle as **privileged executable code** and makes hash verification a hard gate.

**Recommended fix:** make a missing/unmatched checksum **fail closed** for the release path (keep best-effort only for local-source seeding, which isn't downloaded). At minimum, log loudly when verification is skipped.

### G3 — No compatibility manifest (UI ↔ shell ↔ Node) (MEDIUM, recommendation §4/§16)
There is no `update-manifest.json` and no `requires.shellVersion` / `requires.node` gate. `checkAndUpdateUiBuild` will pull *any* newer-tagged `ui-build.tar.gz` regardless of whether that UI needs IPC/Node features the installed shell lacks. Today this is low-impact because the UI server talks to the shell over HTTP/env (not a versioned `desktop` IPC bridge), so there's little API surface to skew — but the moment we add a real preload IPC contract, an auto-updated UI could call a method an older shell doesn't expose.

**Recommended fix:** publish a small `ui-manifest.json` asset with `version` + `requires.shellVersion`/`requires.node`, and have `checkAndUpdateUiBuild` refuse a bundle whose `requires` the current shell doesn't satisfy. This is cheap insurance to add **before** the first real IPC method ships.

### G4 — No updater state / downgrade guard / failed-version memory (LOW–MEDIUM, recommendation §14)
No `state.json` tracking `currentVersion`/`previousVersion`/`lastHealthyVersion`/`failedVersions`/`minimumSeenVersion`. Consequences:
- A bad release is **re-downloaded every launch** (no `failedVersions`).
- No explicit downgrade floor (`minimumSeenVersion`). The version-stamp comparison gives us *implicit* downgrade protection between channels, but nothing stops `checkAndUpdateUiBuild` from following `releases/latest` down if a release is yanked/re-pointed.

**Recommended fix:** a tiny `data/ui-updater-state.json` recording `lastHealthyVersion` + a `failedVersions` set; consult it in `checkAndUpdateUiBuild` before downloading.

### G5 — Single shared release tag for all artifacts (LOW — deliberate, recommendation §3)
All artifacts (Docker images, CLI, Electron, UI) share one `vX.Y.Z` tag. The plan recommends separate `web-v*`/`shell-v*` streams. **Justified divergence:** OpenPalm is a *coordinated multi-service platform* (guardian/assistant/channel images are versioned in lockstep via `OP_IMAGE_TAG`), not a thin shell around a web app. A single tag is the correct unit of release for the platform as a whole, and we still get independent *delivery* of the UI via the out-of-band `data/ui` path (Improvement #3). The cost we accept: a UI-only fix forces a full release tag, and `checkAndUpdateUiBuild` keys off the *platform* version, so the UI can't advance independently of the platform version number. Acceptable given the lockstep image contract.

### G6 — UI server gets the full parent environment, not a minimal scoped set (MEDIUM, recommendation §18)
The plan's strongest security point: with `adapter-node` the server is **downloaded executable code**, so pass it only `PORT`/`HOST`/scoped data path — never broad env or secrets. `buildUIServerEnv` does the opposite: `{ ...process.env, ... }`. The SvelteKit server therefore inherits whatever was in the Electron process environment.

**Partial mitigations already present:** the server is loopback-only; secrets live in `OP_HOME/knowledge/secrets/` as 0600 files granted to *containers* via Compose, not injected into the UI process; and the comment in `buildUIServerEnv` shows we already think carefully about env precedence (it deliberately refuses to set `OP_IMAGE_TAG`). But "inherit everything" is still wider than the reference wants.

**Caveat (why this is less severe than for a generic web app):** OpenPalm's UI server is **not** a pure renderer — by design it *is* a privileged control-plane host (it talks to the Docker socket on the host, reads/writes `OP_HOME`). Our threat model already trusts the UI server with host orchestration (see `core-principles.md`: "Host CLI or UI is the orchestrator"). So the reference's "SvelteKit server must not own credentials" boundary is intentionally **not** our model. Still, narrowing the inherited env to an explicit allowlist would reduce accidental leakage (e.g. a stray `GROQ_API_KEY` in the launching shell) for near-zero cost.

### G7 — No staging-dir + atomic promote; in-place replace (LOW, recommendation §10)
`seedUiBuild` does `rm -rf data/ui` then extracts the new tarball into `data/ui`. The reference extracts to `versions/<v>.staging`, validates required files, then renames. Our window between `rm` and successful extract is where a crash leaves `data/ui` empty (the bundled-UI fallback covers this in Electron, but the CLI host-install path has no bundled fallback). Low severity because of the backup-move-first ordering in `checkAndUpdateUiBuild`, but the raw `seedUiBuild` download path (used on first install) has no staging.

**Recommended fix:** extract to `data/ui.staging`, verify `index.js` exists, then `rename` over `data/ui`.

---

## Priority recommendations

1. **G1 (rollback)** — highest user-visible risk: a bad UI release can brick startup with no auto-recovery. Restore the just-made backup (or bundled build) on `waitForReady` failure.
2. **G2 (enforce checksum)** — fail closed on the download path; cheap, security-relevant.
3. **G6 (scope env)** — allowlist the env passed to the UI server; cheap, reduces leakage.
4. **G3 + G4 (manifest + state)** — do these together **before** the first real preload IPC contract ships; until then they're low-impact.
5. **G7 (staging promote)** — fold into the G1 work (staging + atomic rename + rollback are one coherent change).

## What NOT to change

- The **dual-channel version-stamp model** (don't replace with `current.json` pointers — it's strictly better for our reinstall/downgrade story).
- The **single platform release tag** (correct unit for a lockstep multi-service platform).
- The **"UI server is a trusted control-plane host"** posture (this is an architectural decision in `core-principles.md`, not an oversight — only *narrow* the env, don't try to de-privilege the server).

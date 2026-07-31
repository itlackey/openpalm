# Onboarding & Setup — End-to-End Review

**Date:** 2026-07-31
**Revision reviewed:** `e22063e` (main, v0.13.0-beta.15)
**Scope:** the complete new-user journey — finding the project, downloading it, installing (desktop app and CLI paths), the setup wizard, first stack deploy, and the first chat message — plus the code quality of everything that supports that journey.

**Method:** seven parallel deep-dives (docs accuracy, shell installers, CLI bootstrap, Electron first launch, wizard UI/API, skeleton seeding + stack startup, post-setup → first chat), each requiring file:line evidence per finding, followed by an independent verification pass on the highest-impact claims (every spot-checked claim reproduced). Published GitHub releases were checked against the docs via the API. Findings below are deduplicated across the seven reviews; each carries the evidence needed to reproduce it.

**Severity scale:**

- **Critical** — breaks or dead-ends the primary onboarding path for a large class of users
- **High** — a first-run user hits a wall, a misleading failure, or a security hole
- **Medium** — real friction, wrong messaging, or a maintainability trap
- **Low** — polish, copy drift, minor hygiene

**Totals:** 4 Critical · 20 High · ~45 Medium · ~35 Low.

---

## The journey at a glance

| Stage | Verdict |
|---|---|
| 1. Discover & download | **Broken today** — the recommended download does not exist in the latest stable release |
| 2. Shell installers | Solid core (checksum, retries, PATH) with sharp edges on failure paths and Windows/fish |
| 3. CLI bootstrap | One ordering bug poisons every early failure into a scary dead end |
| 4. Electron first launch | Good recovery routing; tray/lifecycle and window-security gaps |
| 5. Setup wizard | Polished visuals; the provider step is broken on a genuinely fresh host, and three deploy-screen bugs can each strand the user |
| 6. Stack deploy | Disciplined architecture; the longest wait of onboarding looks like a hang |
| 7. Login & first chat | Auto-login works; a cookie clash and error-message blackouts spoil the first minutes |

The codebase shows heavy, recent investment in setup quality (deploy journal with pid-liveness resume, fail-closed project-collision detection, health-gated setup completion, localhost-only wizard, auto-login on completion, password-manager-friendly login). Most remaining problems are not architectural — they are **contract mismatches**: one side declares a phase/status/field that the other side never produces, and nothing tests the pair together.

---

## Stage 1 — Discovering & downloading

### D1. CRITICAL — The recommended download path dead-ends: the latest stable release contains no desktop app

`README.md` step 2 ("Download the OpenPalm desktop app — **Recommended for most users**") and "Where things stand" ("Use the latest published release") point at GitHub releases. Verified via the GitHub API: the latest stable release (`0.12.52`, what `releases/latest` resolves to) contains **only** CLI binaries, `checksums-sha256.txt`, and a deploy bundle — zero desktop artifacts. The desktop app exists only in the `0.13.0-beta.15` **prerelease**. A new user following the recommended path finds nothing matching the README's table.

Related release-hygiene gap: `scripts/validate-release-assets.mjs` gates only the five CLI binaries — desktop artifacts are in neither the completeness gate nor `checksums-sha256.txt`, which is how a stable release with no desktop app shipped silently.

### D2. HIGH — Every filename in the README download table is wrong; the Intel-mac case actively misleads

README lists `OpenPalm-arm64-mac.zip`, `OpenPalm-x64-mac.zip`, `OpenPalm-win.zip`, `OpenPalm.AppImage`. `packages/electron/electron-builder.yml` sets no `artifactName`, so actual assets are versioned: `OpenPalm-0.13.0-beta.15-arm64-mac.zip`, `OpenPalm-0.13.0-beta.15-mac.zip`, `-win.zip`, `.AppImage`, `-arm64.AppImage` (verified on the live release). Two traps:

- The Intel build is the zip with **no arch token at all** (`…-mac.zip`); README's promised `x64` marker never exists, so an Intel user pattern-matching "take the labeled one" downloads the arm64 build.
- The table omits the Linux arm64 AppImage that `electron-builder.yml:89-92` builds.

### D3. HIGH — Docs on `main` describe 0.13-only behavior, but the documented installer installs 0.12.52 — where the headless `access` spec is silently ignored

`docs/setup-guide.md:46-48,60-70` and `docs/operations/manual-headless-install.md` document the flat `access.networkAccess` / `assistantDirect` / `guardianNetwork` / `guardianOpenaiApi` booleans, validated on main by `packages/lib/src/control-plane/setup-validation.ts:40-60`. But `scripts/setup.sh:80` / `setup.ps1:178` deliberately resolve the latest **stable** release — 0.12.52 today — whose `setup-validation.ts` (checked at the tag) has no `validateAccess` at all: an `access` object passes validation and is **silently dropped**, so the user's declared network exposure never applies, with no error. 0.12.52 also requires `security.uiLoginPassword` unconditionally, contradicting the rerun-optional docs.

### D4. MEDIUM — README's Windows row opts users out of auto-updates; the auto-update it references hasn't shipped

`README.md` offers only the portable `OpenPalm-win.zip` ("portable, no install"), while `docs/managing-openpalm.md:239-247` and `electron-builder.yml:94-105` document the NSIS `.exe` as the only self-updating Windows install. Additionally, no release yet contains an NSIS installer or the electron-updater feed files (`beta.yml` / `latest*.yml`) — the updater work (`f79751e`, PR #593) postdates `0.13.0-beta.15` — so the "Desktop app updates" docs describe not-yet-shipped behavior. Flip side, verified in `packages/electron/src/updater.ts:145-148`: `isAutoUpdateSupported` returns true for **any** packaged win32 run with no portable detection, so once feeds ship, portable-zip users will get a live "download update" flow whose `quitAndInstall` runs the NSIS installer into `%LOCALAPPDATA%\Programs`, leaving two divergent copies of the app.

### D5. MEDIUM — The "Advanced / headless install (CLI)" README section is not headless

`README.md:72-83` labels the `curl | bash` one-liner as the path "for servers", but that flow runs the interactive browser wizard bound to loopback only (`packages/cli/src/commands/install.ts:365-406` — admin mode pins the bind, prints `http://127.0.0.1:3880/setup`). On an SSH-only server the wizard is unreachable and no SSH-tunnel hint is printed or documented (see C5). The genuinely headless `openpalm install --file` path is never shown in README.

### D6. MEDIUM — `docs/installation.md` is an orphaned near-duplicate of `docs/setup-guide.md`

Linked from nowhere in `README.md` or `docs/README.md` (sole inbound link: `manual-compose-runbook.md:225`), it repeats the same prerequisites, one-liners, headless spec, and layout table. Two unindexed parallel install documents will drift.

### D7. MEDIUM — The documented Windows CLI-only flow fails under the default execution policy

`docs/operations/manual-headless-install.md:24-27` says to save the script and run `./setup.ps1 --cli-only`; stock Windows execution policy (`Restricted`, and `RemoteSigned` for MOTW-tagged files) blocks saved unsigned scripts. No `-ExecutionPolicy Bypass` / `Unblock-File` guidance is given — and this is the only way to pass args on Windows, because `$args` is empty under `irm | iex` (see S6).

### D8. MEDIUM — `system-requirements.md` legitimizes the skeleton-copy install every other doc forbids

`docs/system-requirements.md:14` ("Needed if you clone the repo to copy `packages/skeleton/`") directly contradicts `installation.md:7`, `setup-guide.md:8-10`, and `manual-compose-runbook.md:5-6`, which all state a raw skeleton copy is not a working install.

### D9. MEDIUM — The manual-Compose "fixed four-file list" silently drops active overlays

`manual-compose-runbook.md:20,56-64` hardcodes core/services/portals/custom, but the control plane conditionally appends `voice.compose.lan.yml` and CDI/rootless overlays (`packages/lib/src/control-plane/config-persistence.ts:444-469`, consumed by `deploy.ts:299`) — `troubleshooting.md:186-197` even documents the voice overlay joining the set. A power user with voice LAN access enabled who follows the runbook reverts the network topology the settings UI configured. The "three managed Compose files" phrasing repeated in `setup-guide.md`, `installation.md`, and `how-it-works.md` has the same blind spot (`packages/skeleton/system/stack/` ships six).

### D10. MEDIUM — Core jargon is used before (or without ever) being defined

"AKM" appears throughout README and the wizard-config docs and is never expanded anywhere in the repo's docs (only an external repo link). "Principal" is used in README and troubleshooting with no getting-started definition. `troubleshooting.md:195-196` cites internal invariant labels ("`S.6b / D3(b)`") at first-time users.

### D11. LOW — macOS first-launch guidance is stale for macOS 15

`README.md:70` and `electron-builder.yml` both advise "right-click → Open"; Sequoia removed that bypass for unsigned apps (approval moved to System Settings → Privacy & Security → "Open Anyway"). The `xattr` fallback still works.

### D12. LOW — Assorted stale content

- `docs/README.md:16` "Top 10 common problems" — the doc has 13 sections.
- README's main docs table gives the 0.10→0.11 upgrade guide second-row prominence two major versions later (setup-guide correctly demotes it to "historical").
- `README.md` has no H1 title (opens with a bare `<p><strong>` tagline).
- `packages/cli/src/commands/install.ts:422` tells users to "See example.spec.yaml for the format" — no such file exists anywhere in the repo (verified).

### D13. LOW — AppImage FUSE dependency unaddressed

electron-builder AppImages need libfuse2, absent by default on Ubuntu 22.04+/Fedora; README says only "chmod +x → run". Zero repo mentions of libfuse or `--appimage-extract-and-run` (verified by grep). Affected users get a cryptic `dlopen(): error loading libfuse.so.2` before any OpenPalm code runs.

### D14. LOW — Installer knobs and uninstall are undocumented

`OP_VERSION`, `OP_INSTALL_DIR`, `OP_NO_ALIAS`, `OP_ARCH`, and the scripts' `--version` flag appear nowhere under `docs/` (only `--cli-only` does). `openpalm uninstall --purge` never removes the CLI binary, PATH export, or `op` alias the installer wrote, and no doc explains how to — the profile mutations are permanent with no advertised undo.

---

## Stage 2 — Shell installers (`setup.sh` / `setup.ps1`)

The core is genuinely good: fail-closed SHA-256 verification before install, retries with backoff, manifest identity checking, careful REG_EXPAND_SZ-preserving PATH writes on Windows, mktemp + EXIT-trap hygiene on the sh side. The findings are the edges.

### S1. MEDIUM — Two failure paths die silently; their friendly error messages are dead code

`scripts/setup.sh:83-84` and `:117-118`: under `set -euo pipefail`, `manifest_version` (a `grep | sed` pipeline) and the checksum-extraction pipeline make the enclosing assignment fail when grep finds nothing, so `set -e` exits **before** the `die "Release manifest does not declare a version"` / `die "No checksum found…"` lines can run. Verified by repro: exit 1 with zero output. A malformed manifest exits the one-liner printing nothing at all.

Compounding: `scripts/setup-sh-latest-resolver.test.ts:52-54` asserts the "empty string → fails closed" behavior by running the extracted function **without** the script's own shell options — the test pins semantics that don't ship, and running it under `set -euo pipefail` would have caught this.

### S2. MEDIUM — `curl | bash -s -- --force` performs the destructive backup-reinstall with no confirmation

`packages/cli/src/commands/install.ts:220-232`: the confirmation is skipped when stdin is not a TTY — and under `curl | bash`, stdin is the pipe. The documented invocation is precisely the one that never asks. Consider gating on stdout-TTY or reading from `/dev/tty`.

### S3. MEDIUM — fish users get broken PATH persistence and an erroring `source` instruction

`setup.sh:171-174,178-179,214-215`: the non-bash/zsh fallback appends POSIX `export`/`alias` syntax to `~/.profile`, which fish neither reads nor parses; the printed "Run 'source ~/.profile'" then errors in fish. No warning is emitted — the user just gets `command not found` in every new terminal.

### S4. MEDIUM — `setup.ps1` under `irm | iex`: `exit` closes the user's terminal, and args are dead

- `setup.ps1:163-164` (unsupported arch) and `:274` use `exit`, which under `iex` terminates the caller's PowerShell session — the window closes before the error can be read. The arch path is realistically reachable: a 32-bit PowerShell host on 64-bit Windows reports `x86` and gets a **false** "unsupported" verdict.
- `$args` is empty under `irm | iex`, so `--version/--arch/--cli-only` silently do nothing in the one-liner form; the env-var workarounds (`OP_VERSION`, `OP_ARCH`) are undocumented (D14), and the save-then-run alternative is blocked by execution policy (D7).

### S5. LOW — Fragile checksum grep, unguarded main download, temp-file and exit-code gaps

- Unanchored `grep "${BINARY}"` (`setup.sh:117`, `setup.ps1:244`): any future release asset sharing a name prefix (e.g. `openpalm-cli-linux-x64.sig`) makes `EXPECTED` multiline → guaranteed "Checksum mismatch". The release workflow itself already uses the anchored form (`release.yml:523`); the installers should match it.
- The main binary download (`setup.sh:110`) is `set -e`-only with `--retry-all-errors`, so a typo'd `--version` 404 retries five times (~20s) then dumps raw curl errors; the checksum fetch right below has a proper `|| die`.
- `setup.ps1` leaves `openpalm.exe.tmp` behind when the download throws (cleanup exists only on checksum phases) and uses a fixed temp name (concurrent-run collision).
- `setup.ps1` never propagates the CLI's exit code (`& $Dest install …` then end; native non-zero exits don't trip `$ErrorActionPreference`), so CI wrappers can't detect failure. No TLS 1.2 forcing for old Win10 .NET defaults. `Move-Item -Force` onto a running `openpalm.exe` fails with a raw locked-file error.
- `op` alias guard: correct for the 1Password-on-PATH case, but the second condition (`command -v op` equals the openpalm path) is unsatisfiable dead code, and an `op` provided only via the user's rc files is invisible to this non-interactive shell — the alias then shadows 1Password in interactive shells.

### S6. LOW — Four copies of the platform/asset table

`setup.sh`, `setup.ps1`, `.github/workflows/release.yml:518-523`, and `packages/cli/bin/openpalm.js` each carry the binary-name table; only string-contains tests watch them. Adding an asset requires four coordinated edits.

---

## Stage 3 — CLI bootstrap (`openpalm install`)

### C1. CRITICAL — OP_HOME is materialized before the Docker preflight, so any early failure or Ctrl-C turns a fresh machine into a convincing "already installed" state with no working recovery

The ordering in `bootstrapInstall` (`packages/cli/src/commands/install.ts`): the already-installed check reads at line 206, `prepareInstallFiles` seeds at 260, and `requireDocker()` runs only at 396 (wizard) or 464 (file install). `prepareInstallFiles` writes `state/stack.env` (`writeSystemEnv`) **and** mints both guardian tokens (`initializeStateSecrets` → `ensureSecrets`, `secrets.ts:147-148`) before the user has answered a single wizard question. Three downstream traps, each verified:

1. **The "already installed" trap.** Docker missing is the most likely first-run failure. The user installs Docker and re-runs the documented one-liner → `hasAnyStackEnvFile` is now true → *"OpenPalm appears to already be installed. Re-run install with --force to continue."* — false, scary, and `--force` then takes the destructive-backup path (whose prompt offers to back up an install that never existed). Ctrl-C during the wizard produces the same state.
2. **The bare-`openpalm` dead end.** `classifyLocalInstall` (`packages/lib/src/control-plane/launch-status.ts:178-193`) treats compose-file + both guardian tokens as **installed** — an assumption ("only performSetup mints them", per its own comment) that pre-wizard minting has silently falsified. After an interrupted wizard, bare `openpalm` therefore `compose up`s a never-configured stack and serves a **non-admin** UI that cannot serve `/setup` (`hooks.server.ts:223` deliberately refuses the redirect without the capability) and has no login password — a dead end with no message pointing at `openpalm install --force`.
3. **Competing predicates.** `install` uses `hasAnyStackEnvFile || hasMaterializedLocalInstall` while `uninstall`/`start` use `classifyLocalInstall` — a home with only a stray `stack.env` is "already installed" to install but "not installed" to uninstall, so the natural cleanup command refuses to run on exactly the partial states install refuses to overwrite.

**Fix direction:** run the Docker preflight before any disk mutation; stop minting guardian tokens before setup actually runs (or change the classifier's fallback evidence); make the "already installed" error name `openpalm update` and `openpalm uninstall`.

### C2. HIGH — `install --file --no-start` + `openpalm start` never marks setup complete

`performSetup` intentionally defers `OP_SETUP_COMPLETE` to the deploy callback (`setup.ts:494-499`); install's own `--no-start` instruction says "Run `openpalm start`" (`install.ts:461-462`), but `runStartAction` never writes the stamp (verified: zero references in `start.ts`). Result: a healthy, fully configured stack whose home is forever `setup_incomplete` — `openpalm admin` bounces the operator into the setup wizard over their finished config. This is the same bug class the R9 comment at `install.ts:152-157` fixed for the deploy path, reintroduced by the `--no-start` handoff.

### C3. MEDIUM — Install's Docker probe is worse than the lib's own, and misses the Compose `--wait` floor

`requireDocker` (`install.ts:135-148`): merges daemon-stopped and socket-permission-denied into one message while `mapDockerError` (`compose-errors.ts:73-97`) already distinguishes them with actionable copy (day-2 `start` uses it; install doesn't); treats any non-zero `docker info` as fatal where `checkDocker` tolerates warning-only exits; has **no timeout** (a wedged daemon hangs install forever, silently); and its bare `docker compose version` check passes Compose < 2.14, which then fails the final deploy on the `--wait-timeout` flag — the exact end-of-wizard failure the preflight's own comment says it exists to prevent (`checkDockerCompose` at `docker.ts:246-260` enforces the floor; install never calls it). Four divergent Docker probes exist overall (`requireDocker`, `checkDocker`, `ensureDockerReady`, `detectHostInfo`'s inline probe).

### C4. MEDIUM — Host-UI port conflicts surface as a 60-second timeout and a suggestion to use a flag that doesn't exist

Install never probes ports up front (the probe exists in lib and is wired only into `doctor` and the wizard's system-check). A foreign process on 3880 → identity probe says `absent` → child dies of EADDRINUSE → "UI server did not become ready in time." with no port mention. An OpenPalm-instance mismatch says "choose a different --port" — `openpalm install` has no `--port` flag; the real recovery (`OP_HOST_UI_PORT`) is unmentioned.

### C5. MEDIUM — Remote/headless servers: loopback-only wizard with no tunnel hint, and a browser-open line that lies

Correct security posture (admin wizard always loopback; `OP_ALLOW_REMOTE_SETUP` neutralized; SEC-4 rejects non-localhost clients). But a user who SSH'd into a NAS sees "Opening http://127.0.0.1:3880/setup in your browser..." (`browser.ts:5`) even though `xdg-open` failed silently, and neither the CLI output nor any doc mentions `ssh -L 3880:127.0.0.1:3880` — which works (the tunneled request arrives from 127.0.0.1). One printed hint line would close this.

### C6. MEDIUM — `--file` installs are silent for up to ~90 minutes

`runFileInstall` → `runDeploy` uses the capturing exec runner, passes no journal/onUpdate, and prints nothing between "Setup complete." and the final JSON — through a pull budget of 60 min plus up 30 min. Headless users (the audience for `--file`) watch a dead terminal.

### C7. MEDIUM — `--version` is mislabeled, skew-silent, and typo-tolerant

Help says "Install specific repository ref" but host assets (UI + skeleton) are always the binary's embedded PLATFORM_VERSION — the version parameter of `prepareInstallFiles` is literally named `_version` and unused. So `--version 0.14.0` from a 0.13 binary silently runs 0.14 images against 0.13 compose contracts with no same-release check or warning. And `--version banana` doesn't error — `resolveRequestedImageTag` returns null and the install silently proceeds on the default pin.

### C8. MEDIUM — A typo'd subcommand runs the state-changing default flow

`main.ts:159-187`: any unrecognized first token falls through to `autoRun` — `openpalm statsu` starts the stack and blocks serving the UI; `openpalm isntall` on a fresh machine starts an install. No "unknown command" error is possible for positional typos.

### C9. LOW — Smaller first-run edges

- Bare `openpalm` stalls up to 10s on a GitHub lookup whose result is discarded (`main.ts:59-62` → the unused `_version`); offline machines feel it worst.
- The `--force` backup prompt says the "existing OpenPalm install" is backed up, but `backupOpenPalmHome` excludes `data/` (`backup.ts:225-231`) — which holds the OpenCode session DB, i.e. all chat history. Nothing is deleted in place, but the consented-to backup is materially partial versus its description.
- `isAssistantHealthy` reads `OP_ASSISTANT_PORT` from live env only (`main.ts:32`) while file installs persist custom ports to stack.env — bare `openpalm` then probes the wrong port, concludes "down", and force-recreates needlessly.
- Ctrl-C during the wizard's deploy leaves the install lock held for up to 30 minutes; the `install_in_progress` message does name `openpalm unlock` (recoverable, but jargon at a first-run user).
- Declining the `--force` confirmation exits 0; `openpalm doctor` exits 0 even on Docker FAIL — both limit scripting.

### C10. Maintainer notes (CLI)

- **Dead code:** the entire "update mode" branch (`install.ts:276-283`, incl. `deployServices('update', false)`) is unreachable given the guard at 207-211; `deployServices`' `pull` parameter is cosmetic; the `'main'` fallback in `resolveDefaultInstallRef` can't fire.
- `status.ts:6-23` re-implements the compose-ps parse whose lib original is documented as the single source of truth — and misses the JSON-array output shape, so a running stack can classify as `installed_offline`.
- `doctor`'s port probe reads live env only (misses persisted ports), hardcodes the `openpalm-` container-name prefix (a custom `OP_PROJECT_NAME` makes the user's own stack report as CONFLICT), and flags the running host UI's own 3880 as a conflict.
- The backup/seed phase of `bootstrapInstall` runs outside the install lock; two concurrent `--force -y` runs can interleave.
- `install.ts:457` passes raw `process.env.OP_HOME` where every other site uses the resolved path — a relative `OP_HOME` (which `.env.example` itself demonstrates) lands the write against cwd.
- **Test gaps:** nothing covers requireDocker-vs-seeding ordering, the already-installed error, declined `--force`, re-run after interrupt, the EADDRINUSE path, or `--version` garbage. The unreachable update-mode branch would have been flagged by any test that tried to reach it.

---

## Stage 4 — Electron desktop first launch

Genuinely good: recovery routing on second launch (stopped stack → `/host`, broken → diagnostics, pinned by tests), silent throttled update checks that can't collide with first-run, immediate surfacing of spawn ENOENT instead of a 60s spin, splash hints at 15s/40s, stderr ring buffer + log path in failure dialogs.

### E1. HIGH — Close-to-tray with no reachable tray (stock GNOME) leaves the app running and unreachable; no single-instance lock compounds it

`main.ts:607-613` unconditionally hides on close; `window-all-closed` keeps running "on all platforms"; `TrayController.create()` silently no-ops if tray support is absent (`tray.ts:76-79`) — and vanilla GNOME has no StatusNotifier support. A Fedora AppImage user closes the window and has no way to reopen or quit. Separately, there is **no `requestSingleInstanceLock`** (verified: zero hits): a second launch attaches to the first instance's UI server; quitting the first kills the shared server and strands the second instance's window on a dead server with no recovery (see E4). Hide-to-tray should be conditional on the tray actually existing, and a single-instance lock added.

### E2. HIGH (security) — No `will-navigate` guard; any-loopback-port URLs open in the privileged window; half the IPC surface is unguarded

Verified: zero `will-navigate`/`did-fail-load` handlers in `packages/electron/src`. Only popups go through `setWindowOpenHandler`; plain in-page navigation can take the window — with `preload.cjs` and `window.openpalm` attached — to any origin. `isAllowedInAppWindowUrl` (`main.ts:542-550`) accepts **any port** on 127.0.0.1/localhost, so an assistant-rendered link to another local service loads inside the trusted window rather than the external browser. The updater IPC is exemplarily origin-gated (`main.ts:798-809`), but `restart-app`, `open-local-app`, `launch-on-login-status/set`, `notify`, `set-tray-mic-recording`, and `request-mic-permission` accept any sender — off-origin content can toggle login-item persistence, forge OS notifications, or pop the mic TCC prompt.

### E3. MEDIUM — The app silently grabs Ctrl+Shift+M system-wide with no opt-out

`main.ts:117,642-657`: registered on first window open, held while the app lives in the tray. This is Teams' mute chord; a first-run user permanently loses it in every other app with no setting, no prompt, and failure only console-logged.

### E4. MEDIUM — Stuck-splash and dead-window states have no watchdog

`main.ts:586-592`: the always-on-top splash closes only on `ready-to-show`; `loadURL` is un-awaited with no rejection handler, no `did-fail-load`, no timeout. If the UI child passes `/health` then dies before page load (or an attached CLI-owned server is Ctrl-C'd), the splash spins forever on top of everything; later server death shows Chromium's raw error page with no reload affordance. Related: a spawn failure fires **two** error dialogs (the `error` handler and the not-ready branch both trigger, `main.ts:473-485` + `404-419`), and `startUIServer`'s failure paths return normally so the boot continuation races `app.exit` (`main.ts:748-750`).

### E5. MEDIUM — Quit mid-install kills the deploy with zero warning; the safe alternative is uncommunicated; the "we'll let you know" tip is a false promise

Tray Quit → `before-quit` → immediate SIGTERM+SIGKILL of the process group — `docker compose` dies mid-flight with no "setup is still running" confirmation (recovery exists via the deploy journal, but the user isn't told). Closing the window is actually safe (deploy continues server-side) but nothing says so — except `DeployStep.svelte:188`, which promises "You can leave this window — we'll let you know when it's ready", and **no code path sends a completion notification** (verified: `window.openpalm.notify` is wired only to chat replies/errors and the updates tab, and is a localStorage opt-in besides).

### E6. LOW — Assorted lifecycle/hygiene

- Foreign process on 3880 → misleading "did not respond within 60 seconds" dialog with the EADDRINUSE buried in stderr excerpt and no remediation hint (mirrors C4).
- Tray click is deliberately a no-op (#427) while Windows convention is click-to-open; combined with silent hide-to-tray, users think the app closed and the icon "doesn't work".
- "Check for prerelease versions" is inert on macOS (updater unsupported) yet toggleable; each toggle also builds a new `DesktopUpdater` over the singleton `autoUpdater` without removing the old listeners — N toggles = N duplicate listeners pushing conflicting state.
- `autoInstallOnAppQuit` is set, but the only quit path ends in `app.exit(0)` inside `before-quit`, which skips the lifecycle electron-updater's install-on-quit hook depends on — staged updates may only ever install via the explicit button. Needs a runtime check.
- The `before-quit` doc-comment describes a five-step plan (detached graceful stop, 500ms safety net) that the code — sync cleanup + immediate `app.exit(0)` — does not implement. Stale.
- `main.log` grows unbounded (append, no rotation, tees full child stdout/stderr) in an always-on tray app.
- `admin-tools/dist` is built and shipped in extraResources but referenced by nothing at runtime (its consumer was removed) — dead payload riding every release.
- `UiSupervisor.adopt()` exists in lib specifically for Electron, and the CLI fully adopted the shared class; `main.ts` still hand-rolls spawn/ready/stop, keeping the acknowledged divergence alive.

---

## Stage 5 — Setup wizard

The visual design, safe-by-default access toggles, and keep-existing-credential semantics are strong. But the provider step — the heart of the wizard — is broken on a genuinely fresh host, and the deploy screen has three independent ways to strand the user. A theme runs through most of these: **the UI is written against server behavior that doesn't exist** (phases never emitted, a status never produced, fields never assigned), and no test exercises producer and consumer together.

### W1. CRITICAL — On a fresh host, the wizard's provider catalog and OAuth target an OpenCode that isn't running; the dedicated instance it spawns is an orphan

`POST /api/setup/opencode/ensure` spawns `opencode serve --port=0` and returns `{ok, url, started}` — but the client type drops `url` (`setup-api.ts:83`), the store reads only `ensured?.ok`, the route never sets `OP_OPENCODE_URL` (its own vitest asserts env is untouched), and no harness sets it either. Meanwhile `/api/setup/opencode/providers`, `/status`, and both OAuth routes resolve `getAssistantOpencodeTarget()` — i.e. `127.0.0.1:3810`, where **nothing listens before the first deploy**. Net effect on a real fresh machine: `opencodeAvailable=true` but the provider catalog fetch fails → the cloud sign-in list is empty and OAuth cannot work at all. The e2e suites run against an already-deployed stack on 3810, which is exactly why this never trips in CI.

Compounding (W1a, HIGH): the empty list renders *"Nothing more to add — you're all connected."* (`ProviderOAuthList.svelte:64-65`) — a first-run user with zero providers is told they're done. Unreachable-service and all-connected must be distinguished.

### W2. HIGH — OAuth sign-in: the client waits 10 minutes; the server proxy aborts at 30 seconds

The client long-poll allows 10 minutes (`setup-state.svelte.ts:708-745`), but the callback route proxies with the default `AbortSignal.timeout(30_000)` (`opencode-client.ts:53-57`). Any user who takes more than 30 seconds in the provider's browser tab — nearly everyone — gets "OAuth callback failed" while still typing their password. Also, `method:'code'` providers show instructions but the wizard has no code input — they spin forever.

### W3. HIGH — The system check auto-advances past its own results: blocking port conflicts, GPU detection, and "Ollama is running" rows are unseeable

`SystemCheckStep.svelte:94`: `if (data.docker.ok && data.compose.ok) onpass();` navigates to step 1 on the same tick the results render, ignoring `hasBlockingConflict`. The Continue-button gate on blocking conflicts (`allRequiredPassed`, lines 71-73/232) is unreachable when Docker is healthy — the exact user it exists for (another app on 3800/3810) sails through the whole wizard and hits an opaque compose bind error at deploy time. The check screen's GPU and detected-provider rows are equally unseeable. One condition fixes it.

### W4. HIGH — Host-credential import is timing-dependent and silently skipped, producing "verified" providers with no keys

The only auto-import trigger is gated on `currentStep === 1 || isRerun` (`setup-state.svelte.ts:958`) and evaluated once at init — when the user is still on step 0 — so it typically never fires; the recommendation's import action fires only when *no* cloud credentials exist. Providers can still show as verified (OpenCode `connected` marking), the payload ships `apiKey:''`, and nothing copies host `auth.json` at install time (`performSetup` verified). Result: green "already connected" banner, successful deploy, assistant with no credentials — the failure surfaces as an inscrutable first-chat error (see F3). Related: the `connect-manually` recommendation tells users to click an "Import from host OpenCode" button that doesn't exist (`CloudAttachPanel.svelte` hardcodes its host branch unreachable), and `handleHostImport` fires empty-key verification requests at every static cloud provider, littering the sign-in list with spurious `role="alert"` errors.

### W5. HIGH — An optional-service failure sends the wizard into an infinite spinner; the "with warnings" UI is dead code

When only optional services fail (voice, discord, slack), `runDeploy` marks rows `status:'error'`, sets `imageWarning` and `setupComplete:true`, and returns with no `deployError` (`deploy.ts:449-460`). The client stops polling only on: deployError, all-running, or all-remaining-rows-`'warning'` (`setup-state.svelte.ts:836-857`). **Nothing ever produces `'warning'`** (verified: the only occurrence in the control plane is the type declaration) — so the wizard polls every 2.5s forever on "Starting Services…" while the install actually succeeded; the `imageWarning` banner is gated on `deployDone` and unreachable. Feeding this: portal credentials are validated nowhere (`required: true` in constants is enforced by no layer), so an enabled Discord with a blank token reliably manufactures this exact hang.

### W6. HIGH — Retry after a failed deploy freezes the screen: polling is never restarted

`handleDeployRetry()` (`setup-state.svelte.ts:895-909`) calls `pollDeployStatus()` once instead of `startDeployPolling()` — the interval was already cleared on error detection. After a successful retry kick-off, exactly one poll runs and the screen never updates again, even when the deploy succeeds. Only F5 recovers (init's deploy pickup restarts polling). One line.

### W7. HIGH — The longest wait of onboarding looks like a hang: pull phases are declared, rendered for, and never emitted

`DeployPhase` declares `'pulling-images'` and `'starting-voice'`; `DeployStep.svelte:80-107` carries full copy for them ("Downloading Images (incl. Voice ~2.4 GB)… 10–30 minutes… the wizard will wait"). `runDeploy` emits only `writing-config` → `starting` → `ready` (`deploy.ts:345,396,458,481`); the discrete `compose pull` (60-minute budget) runs inside the `starting` phase, and `refreshDeployStatus` runs only once at the very end — so for the entire multi-GB pull the user sees "Starting Services… 0 of N services running", a 0% bar, and spinners, then everything flips at once. Four of the seven review legs independently converged on this finding. Also related: `runDeploy` forces `pull: 'always'` for every non-dev deploy, so a **redeploy with all images already present fails hard when the registry is unreachable** (pullFailed is terminal before `up --pull never` ever runs) — offline retry of a previously working install refuses and rolls back.

### W8. MEDIUM — Switching local → cloud leaves in-stack Ollama enabled; the cloud row also vanishes so users often can't switch back

`handleConnectModeChange('local')` sets `ollamaEnabled = true`; the `'cloud'` branch never clears it — a user who toggled "Run on this computer" once and went back silently gets a multi-GB Ollama container + model pull. And `detectedCloudConn`, the field whose entire purpose is keeping the detected-cloud row visible after switching, is **never assigned anywhere in production code** (verified by grep) — the row disappears and the `savedCloudLlm` restore path is unreachable.

### W9. MEDIUM — Apple Silicon "install Ollama, then click Re-check" is a no-op; CPU-only local is undiscoverable; no API-key entry exists

Re-check calls `fetchAndApplyRecommendation()`, which early-returns once applied — nothing re-probes host providers, so the documented mac flow's button does nothing; worse, selecting the local row pre-install enables in-stack **CPU** Ollama, the exact configuration the recommendation logic exists to prevent on macOS. The local row is hard-disabled below 8 GB VRAM even though a CPU profile exists. And the wizard has no API-key input at all (by design), while recommendation copy tells users to "add a custom OpenAI-compatible endpoint and key" — impossible in the wizard.

### W10. MEDIUM — On Linux, a detected host Ollama is written into container config as `localhost:11434`

The probe's last fallback is `localhost:11434`, which on Linux (no Docker Desktop alias) is the only one that succeeds on the host — and that URL flows unmodified into the assistant container's config (`setup.ts:230-245`), where `localhost` is the container itself. No host→container URL translation exists in `performSetup` (verified). Works by accident on macOS/Windows only.

### W11. MEDIUM — No disk or RAM check anywhere the user can see

The system-check endpoint checks docker/compose/GPU/providers/ports only. `checkDiskHeadroom` exists (5 GiB/1 GiB thresholds, written after a disk-full incident) but runs server-side as a **log warning only** during apply — it never reaches the journal or browser, and blocks only with `OP_DISK_HARD_BLOCK=1`. A user with 2 GB free starts a 5-10 GB pull with zero warning and fails mid-extraction (with a rollback re-`up` that can itself fail on the full disk).

### W12. MEDIUM — Password lifecycle: no input, no recovery pointer, premature copy, and F5 regenerates it

- There is no password field anywhere — fresh installs get a generated hex value (reveal/copy on Review — fine as a default), but the entire explicit-rotation machinery (`uiLoginPasswordDirty`, `keepExistingUiLoginPassword`, the server-side live-env sync) is dead UI-side: no component ever sets the dirty flag.
- `openpalm reset-password` exists but is mentioned by neither the Review copy ("keep a copy somewhere safe") nor `/login` — a lost password has no discoverable recovery, and Electron-only users don't even have the CLI installed (see F6).
- Review says the password is "already saved on this computer" **before** install has written anything — at that moment it exists only in page memory; refresh and it silently regenerates (all wizard state is reset on every mount; nothing persists to sessionStorage — portal tokens, toggles, and step position all vanish on F5 too).

### W13. MEDIUM — Re-entering the wizard on a deploy error dead-ends navigation, and the Review warning banner lies

Re-opening `/setup` with a failed deploy shows DeployStep immediately; SystemCheck never mounts, so `systemCheckPassed` stays false. "Back to Review" sets `currentStep = 3` directly (bypassing the gate), landing on a Review where every "Change"/"Back" button calls `goToStep(1|2)` — which silently no-ops on the unpassed gate — over freshly-reset state (original selections gone). The banner "Install is disabled until Docker is confirmed" is also false: the Install button is gated only on `canComplete`.

### W14. LOW — Copy and polish

- "Save configuration" downloads the full payload — plaintext password, API keys, portal tokens — with no secrets warning (`ReviewStep.svelte:86-94`).
- Aside copy drift: "Click **Install OpenPalm**" (button says "Install"); "first launch pulls a few files — this takes a minute or two" (contradicts the deploy screen's own 3-8/10-30 min estimates); "open your browser, sign in with that password" (the same window transitions and the user is already auto-logged-in).
- The deploy success screen offers an unlabeled "OpenCode UI" button (raw `:3810`) to a first-run user, jargon with different auth semantics, beside "Open Chat".
- The empty-AI confirmation is a native `window.confirm`; step-1 rows are `role="radio"` buttons without arrow-key navigation; the deploy title/progress has no `aria-live`, so screen-reader users get no deploy announcements; the step-2 aside always shows Discord/Slack setup links even when neither is enabled.

### W15. Maintainer notes (wizard)

- **API error contract is inconsistent across `/api/setup/*`:** machine-code + message, prose-only, message-only, no envelope, and failures returned as HTTP 200 (`opencode/ensure`) all coexist; `requestId` appears only in the global shape. Concrete casualty: a 500 from `/api/setup/models/:provider` surfaces to the user as the literal string `model_fetch_failed` while the human message is dropped.
- **Dead code:** `ProgressBar.svelte` (imported nowhere), `step0Error`/`autoModeImporting` (never written), the `'warning'` handling + `deployHasWarnings` UI (W5), both dead phases (W7), `detectedCloudConn` (W8), CloudAttachPanel's host branch (W4).
- `DeployData` is typed twice with different fields (the store's copy lacks `phase`/`imageWarning` that DeployStep reads — works only because the object passes through untyped); `MIN_LOCAL_GPU_VRAM_MB` and provider-label maps are duplicated; password policy (≥8) exists server-side only.
- **Test gaps:** e2e explicitly stops before clicking Install; nothing exercises poll-terminal conditions (W5), retry polling (W6), OAuth timeouts (W2), fresh-host OpenCode targeting (W1), auto-advance vs port conflicts (W3), or phase emission vs consumption (W7). Every one of the wizard's Critical/High findings lives precisely in that untested seam.

---

## Stage 6 — Skeleton seeding & stack startup

The architecture here is unusually disciplined (single tree definition, atomic managed-tree swaps with backup, health-gated completion stamp, fail-closed project-collision detection, PID-based locking with an escape hatch, digest-pinned third-party images, careful rootless/ownership engineering). Findings are operational.

### K1. HIGH — Covered as W7: dead pull phases + `pull: 'always'` hard-failing offline redeploys.

### K2. MEDIUM — Voice floats a `latest-*` tag inside an otherwise exact-pinned stack

`setup.ts:428/432` deliberately re-pins voice to `latest` while everything else pins the exact release. Combined with force-pull-always, every deploy can silently swap the voice runtime for whatever was last published — the exact supply-chain rationale the skeleton guardrail test gives for digest-pinning Ollama. A heavier newly-published image can also blow the 180s `start_period` inside the fixed 300s `--wait-timeout`, flipping working installs into the warning path (which W5 turns into an infinite spinner) on unrelated redeploys.

### K3. MEDIUM — Seeded `knowledge/env/user.env` is world-readable, against its own documented contract

Verified: the skeleton ships it 0644; `applyHomeSeed`'s copy preserves the mode; `ensureAkmUserEnv` early-returns on existing files without chmod while its docstring promises 0600. This is the documented home for user-set provider keys, in a 0755 directory, on what the project pitches as multi-user-friendly Linux hosts. One `chmodSync` fixes it.

### K4. MEDIUM — The empty-string bundled-asset fallback can materialize empty compose overlays that poison every subsequent merge

`readBundledStackAsset` degrades to `''` by design; `writeRuntimeFiles`' seed-if-missing then writes empty `services.compose.yml`/`portals.compose.yml`, and `discoverStackOverlays` includes any file that exists — an empty file is invalid compose input, so every later `docker compose` invocation fails, and seed-if-missing never repairs it (the file now exists). Reachable exactly in the packaged-UI first-run environment the fallback was written for.

### K5. LOW — Assorted startup edges

- A missing `op_ui_login_password` secret fails `compose up` with guidance ("Run `openpalm update` to repair") that cannot fix it — no ensure path creates that secret; only setup or `reset-password` do.
- Portal healthchecks have no `start_period` (10s × 3 retries), so a cold-start >30s marks an optional portal "did not start correctly" spuriously (guardian/voice get 180s, assistant 30s).
- The project-collision probe uses `docker ps` without `-a` — a **stopped** foreign stack named `openpalm` is invisible and gets adopted/clobbered by `--force-recreate --remove-orphans`; and a persistent Docker error produces fail-closed but factually wrong copy.
- `writeSecret` is a non-atomic write — a kill mid-write can leave a partial wizard-supplied UI password that then locks the operator out until reset-password (generated randoms are unaffected).
- `ensureComposeVolumeTargets` runs only on apply paths — an addon enabled by hand-editing stack.env + `openpalm start` lets Docker create the bind source root-owned mid-`up`.
- Docker Hub anonymous rate-limit errors are classified (`toomanyrequests`) but the message offers no `docker login`/retry-after guidance.

### K6. Maintainer notes (stack)

- Healthcheck logic is duplicated between Dockerfiles and compose and has already drifted (assistant: 15s/3 vs 30s/5, env- vs file-based password; guardian: 120s vs 180s start_period); only comments enforce the mirroring.
- Two generators exist for a fresh `stack.env`; the fully-commented template (`generateFallbackSystemEnv`) is effectively dead because the minimal stub always runs first.
- `knowledge/skills/**` is release-authored content seeded once with no update channel — a fixed skill bug ships only to fresh homes; nothing documents the asymmetry against the always-overwritten system tree.
- Dead: `resolveImageTag`'s retired `OP_IMAGE_TAG` fallback; the per-install GitHub lookup feeding the unused `_version` (C9).
- **Test gaps:** nothing asserts the journal ever reaches `pulling-images` (would have caught W7); no test pins seeded file modes (K3); no cross-check that every compose-declared secret has a producer (K5); no Dockerfile-vs-compose healthcheck parity test.

---

## Stage 7 — Landing, login, first chat

Solid foundations: `/api/setup/complete` auto-logs the user in with a real session cookie; the same-origin `/oc` proxy eliminates the CORS/second-password class entirely; the login form is password-manager-friendly; IME composition, touch targets, and reduced-motion are handled.

### F1. HIGH — The admin UI (:3880) and assistant UI (:3800) fight over one `op_session` cookie: forced re-logins and cross-tab breakage forever

Cookies are host-scoped, not port-scoped; both UIs on `127.0.0.1` share one `op_session` jar entry, but each server signs tokens with its **own** per-process signing key (host `private/secrets` vs a key generated inside the container — `containers/assistant/entrypoint.sh:334-345`), so tokens are mutually invalid across surfaces. The wizard's own success screen presents both surfaces side by side: click "Assistant Chat" → rejected cookie → `/login` → re-enter the password just set; logging in there overwrites the shared cookie and logs the user out of 3880. With both tabs open, the **sliding renewal re-issues the cookie on every request**, so activity in one tab silently 401s the other's `/oc` fetches — which renders as a dead-end "Sign-in required." (see F5). Fix direction: per-surface cookie names, or shared signing material.

### F2. HIGH (security) — `/api/auth/session` bypasses the login throttle

Verified: it verifies the same password and mints the same cookie as `/api/auth/login` but imports no throttle; `checkLoginThrottle` is called only by `/api/auth/login`. The brute-force protection the throttle exists for ("the login wall is the ONLY credential boundary", per its own comment) is nullified by the alias. Throttle it identically or delete it. Its docstring is also stale ("random UUID session token").

### F3. HIGH — First-message failures discard the real error at three layers; users see "HTTP 400", "(no response)", or generic advice

- `transport/direct.ts:190-192` throws `Error('HTTP ' + status)`, discarding the response body — including the `/oc` proxy's carefully written friendly envelope ("The assistant is not responding — it may still be starting."), which therefore **never reaches a user**.
- `assistant-error.ts:37-45` maps only 502/503/401 — a bad model id surfaces as the literal banner "HTTP 400".
- `session.error` SSE events (exactly what an invalid/revoked/quota-exhausted API key produces at first-message time) are collapsed to "The assistant session ended unexpectedly… check activity" — `properties.error` is never read; the non-streaming fallback shows "(no response)".

Combined with W4 (silently keyless installs), the most likely first-chat failure mode has the least helpful message in the product. One structured client error type (status + code + message + requestId — the proxy already stamps `x-request-id`, which currently dies at the transport) fixes this whole class.

### F4. HIGH — A fixed 150-second turn timeout kills slow-but-progressing turns, wipes pending permission prompts, and desyncs client from server

`STREAM_TURN_TIMEOUT_MS` (`chat-state.svelte.ts:76`, armed at send, never reset on streaming activity, not paused while a `permission.asked` card waits): (a) a cold local model whose first token exceeds 150s — plausible on first-run Ollama — is failed as "timed out" while working; (b) a user who steps away from a permission prompt >150s has it wiped; (c) the server turn is **not** aborted yet `_pendingTurn` is nulled, so the rest of the reply exists in OpenCode but never renders until a session reload, and a re-send races the still-running turn. The `/oc` proxy deliberately removed its own 30s cap for exactly this bug class; the client re-introduces it at 150s. Timeout should be idle-based and permission-aware.

### F5. MEDIUM — Cold start renders a silent empty chat, and auth expiry mid-chat masquerades as an outage

Landing on `/chat` while the assistant is still warming (the deploy screen's warnings path explicitly invites this): session-load failures land in `sessionsError`, rendered **only inside the closed conversations drawer** — the main surface is an empty thread with a live composer; typing yields "Failed to start conversation: HTTP 502". No readiness polling or recovery loop exists (retry only on tab-visibility or a manual banner button that isn't shown in this state; SSE reconnect flips the green dot but doesn't reload sessions). Separately, a 401 mid-chat maps to "Assistant is not reachable. Try reconnecting." / dead-end "Sign-in required." — the banner's buttons can never fix auth; only a manual full reload reaches `/login`. With F1, this fires routinely.

### F6. MEDIUM — Login-page gaps: 429 reported as "Invalid password", no recovery hint, no logout anywhere

`login/+page.svelte:25-28` maps every non-503 failure to "Invalid password." — after backoff engages, the **correct** password is reported as invalid with no "wait N seconds" (the server sends `retryAfterSec`; it's discarded). No forgot-password hint exists (`openpalm reset-password` is never surfaced — and Electron-only users don't have the CLI at all). `POST /api/auth/logout` exists but **no UI control calls it** (verified repo-wide) — on a shared/family machine, the stated product context, a 14-day sliding session cannot be ended from the UI.

### F7. LOW — First-run chat polish

- Empty session renders nothing: no welcome, no suggested prompts, no indication of which model will answer, no pointer to settings when unconfigured.
- Discovery adds a duplicate "Local assistant" entry beside the locked `/oc` connection (same OpenCode, two rows), which starts erroring if direct auth is later enabled.
- `/start` shows its "Checking this browser…" spinner (up to ~3s of probe timeouts) even when a healthy connection exists; on the container UI every `/` navigation detours through it.
- Landing resolution runs `docker compose ps` pre-auth on HTML-navigation cache misses (minor perf + install-state disclosure to anonymous LAN callers).
- SSE: immediate-close servers are retried at 2 req/s forever with no backoff escalation; any disconnect fails the pending turn as "may have run"; a failed `/event` response body is never cancelled (connection leak).
- Streaming re-parses the entire accumulated markdown reply on every delta (O(n²) per turn).

### F8. Maintainer notes (chat path)

- `hooks.server.ts`'s `handle()` is a 215-line monolith of interacting guard lanes with route-prefix lists maintained in three places — well-commented and well-tested, but every new lane multiplies path count; extract ordered named guards.
- `chat-state.svelte.ts` is a ~1300-line store with four hand-rolled generation counters and the "check generation after every await" pattern repeated 20+ times; the invariants live in reviewers' heads.
- **Test gaps:** no test exercises the turn timeout; e2e deliberately never sends a chat message and stops the install flow before Install — the wizard→chat handoff (cookie, DeployStep links, landing) has zero e2e coverage. F1 and W-series deploy bugs would have been caught by a test that clicks "Assistant Chat" / "Install".

---

## Cross-cutting themes

1. **Contract mismatches between producer and consumer are the dominant defect class.** Dead phases (`pulling-images`/`starting-voice`), a status nothing produces (`'warning'`), fields nothing assigns (`detectedCloudConn`, `uiLoginPasswordDirty`, `step0Error`), an endpoint whose return value is dropped (`opencode/ensure`'s `url`), copy promising notifications that are never sent. Each is invisible to unit tests that mock the other side. **Recommendation:** contract tests that drive `runDeploy` and assert the journal states the UI switches on; an e2e that actually clicks Install and lands in chat.
2. **The "is this installed?" state machine has competing definitions and a seed-before-validate ordering** (C1) that converts the most common first-run failures into the worst error messages. One predicate, and no durable state written before prerequisites pass, would eliminate the whole class.
3. **Error-shape inconsistency at every layer** (setup API envelopes, oc-proxy envelope vs transport stripping, CLI exit codes) means well-written friendly messages exist and are systematically discarded before reaching users.
4. **Copy drift and promises the code doesn't keep** — README filenames, "we'll let you know", "already saved on this computer", "Import from host OpenCode", "See example.spec.yaml", the before-quit comment. Worth a periodic docs-vs-code sweep; several would be caught by asserting UI strings against the behaviors they describe.
5. **Duplicated implementations that have already drifted:** four Docker probes, two compose-ps parsers (one documented as SSOT), two supervisors, two stack.env generators, two healthcheck definitions, four asset-name tables, triplicated provider labels.
6. **Failure paths are the least-tested part of the funnel** — every Critical/High finding above sits on an untested path, while happy paths are well covered.
7. **Released-stable vs main docs skew** (D1/D3/D4): docs on main describe behavior the installer's resolved release doesn't have. Consider versioned docs links from README, or gating "recommended path" claims on what the latest stable actually contains.

---

## Prioritized action list

**Unblock the funnel (small, surgical):**

1. Publish desktop assets in a stable release (or point README at the beta explicitly) and add desktop artifacts + updater feeds to the release-completeness gate (D1/D4). Fix the README download table (D2).
2. Run the Docker preflight before any OP_HOME mutation; stop minting guardian tokens pre-setup; make the "already installed" error name `openpalm update`/`uninstall` (C1, S-path re-runs).
3. Fix the fresh-host OpenCode targeting so provider list + OAuth use the wizard-spawned instance (W1); distinguish "service unavailable" from "all connected" (W1a); raise the OAuth callback proxy timeout (W2).
4. Emit `'pulling-images'` (and ideally periodic `compose ps` refreshes) from `runDeploy` (W7); produce `'warning'` for failed-optional rows or teach the client that `error+setupComplete` is terminal (W5); make `handleDeployRetry` restart polling — one line (W6).
5. Include `!hasBlockingConflict` in the system-check auto-advance condition — one condition (W3).
6. Throttle `/api/auth/session` or delete the alias (F2).
7. Split the session cookie per surface or share signing material (F1).
8. Mark setup complete from `openpalm start` when config is valid (C2).

**Make failures speak (medium):**

9. One structured client-side error type carrying the proxy envelope + requestId through the transport (F3); read `session.error.properties.error`; make the turn timeout idle-based and permission-aware (F4).
10. Surface disk headroom in the wizard system check (W11); validate portal credentials at Install (W5-feeder); add an SSH-tunnel hint beside the printed wizard URL (C5); stream or at least heartbeat `--file` deploys (C6).
11. Fix login 429 messaging, surface `openpalm reset-password` on `/login` and Review, and add a logout control (F6, W12).
12. Electron: `will-navigate` guard, pin `isAllowedInAppWindowUrl` to the UI port, origin-gate the remaining IPC, `requestSingleInstanceLock`, tray-existence-conditional hide-to-close (E1/E2).

**Pay down the drift (ongoing):**

13. Delete verified dead code (update-mode branch, dead phases/status consumers, `ProgressBar.svelte`, `detectedCloudConn`, CloudAttachPanel host branch, admin-tools payload, `resolveDefaultInstallRef` network call).
14. Consolidate: one Docker probe, one compose-ps parser, one supervisor, one stack.env generator, one asset table; add the missing contract/e2e tests (install → chat).
15. Docs sweep: kill `installation.md` or index it; fix skeleton-copy contradiction, four-file-list claim, jargon-before-definition, macOS 15 guidance, headless-section labeling; document the installer env knobs and uninstall of the installer's own artifacts.

---

*Reviewed by Claude Code. Every Critical and High finding was verified against code (file:line) or live release data; spot-checks of agent-reported findings reproduced in all cases. Line numbers reference revision `e22063e`.*

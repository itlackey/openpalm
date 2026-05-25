# Release Blockers — 0.11.0

Pre-release audit findings. Agents should close these before the 0.11.0 tag is pushed to `latest`.

---

## Hard Blockers

### B1 — Asset download defaults to `main` branch
**File:** `packages/lib/src/control-plane/core-assets.ts:83`
`const VERSION = process.env.OP_ASSET_VERSION ?? "main"` — every `openpalm update` on a released build silently fetches assets from `main`, not the release tag. Fix: default to `v${packageVersion}` read from the lib `package.json`.

### B2 — `refreshCoreAssets()` overwrites user-edited assistant config
**File:** `packages/lib/src/control-plane/core-assets.ts:87–91`
`config/assistant/openpalm.md` and `config/assistant/system.md` are in `MANAGED_ASSETS` and are unconditionally overwritten (after backup) when the remote content differs. These are user-customizable persona files — they belong in "seed only" (never overwrite if exists), not "managed" (overwrite on update). `config/stack/core.compose.yml` and `config/assistant/opencode.jsonc` can remain managed.

### B3 — `writeRuntimeFiles()` unconditionally overwrites `core.compose.yml`
**File:** `packages/lib/src/control-plane/config-persistence.ts:318`
`writeRuntimeFiles()` is called on every `applyInstall` and `applyUpdate`. It writes `state.artifacts.compose` (the repo-local copy) directly to `config/stack/core.compose.yml` with no existence or content check. Operator port-binding customizations are silently clobbered on every update. Fix: only write if the file does not already exist (seed semantics); the `refreshCoreAssets()` upgrade path handles version updates with backup.

### B4 — Stale docs reference deleted auth system
Multiple docs still describe `OP_UI_TOKEN`, `OP_ASSISTANT_TOKEN`, and `x-admin-token` header — all removed in the 0.11.0 auth refactor. New users following these docs configure the wrong variables.
- `docs/password-management.md:52–111`
- `docs/installation.md:73–76`
- `docs/technical/foundations.md:150,258`
- `docs/channels/discord-setup.md:11`, `slack-setup.md:11`
- `docs/technical/registry.md:102`

### B5 — Wizard walkthrough describes a wizard that no longer exists
**Files:** `docs/setup-walkthrough.md:29`, `docs/setup-guide.md:41`
Describes a Welcome step with "Admin Token" (required), "Your Name" (required), "Email" (required) fields — all removed in commit `3694f2c9`. The current wizard auto-generates a password with no name/email fields.

---

## Security

### S1 — Session cookie IS the plaintext admin password
**Files:** `packages/ui/src/routes/admin/auth/login/+server.ts:55`, `session/+server.ts:50`
`set-cookie: op_session=${password}`. Intercepted cookie = stolen credential. Fix: generate a random UUID session token, keep a server-side `Map<token, expiresAt>`, store only the token in the cookie.

### S2 — Setup wizard `POST /api/setup/complete` is unauthenticated post-install
**File:** `packages/ui/src/routes/api/setup/complete/+server.ts`
No auth check. On a running installed instance, any machine that can reach the HTTP port can POST a `SetupSpec` and reset the admin password. The `Host: localhost` check is bypassed by `curl -H "Host: localhost:8100"`. Fix: if `isSetupComplete()`, require a valid session before allowing re-setup.

### S3 — `/api/setup/current-config` returns plaintext admin password in body
**File:** `packages/ui/src/routes/api/setup/current-config/+server.ts:82`
`uiLoginPassword: getUiLoginPassword()` is in the JSON response. Any XSS or server-side response log exposes the raw password. Fix: return `hasPassword: true` (boolean) instead of the value.

### S4 — `.dockerignore` excludes old vault paths, not current ones
**File:** `.dockerignore:27–31`
Excludes `.openpalm/vault/**` which no longer exists. Current secrets live at `config/stack/stack.env`, `config/stack/guardian.env`, `stash/vaults/user.env`. A local `docker build` after install bakes live secrets into the build context.

---

## Packaging

### P1 — `AKM_CLI_VERSION=^0.8.0-rc2` caret range on pre-release
**Files:** `core/assistant/Dockerfile:16`, `core/guardian/Dockerfile:14`
Caret range on a pre-release accepts future rc versions silently. Pin exactly: `AKM_CLI_VERSION=0.8.0-rc2`.

### P2 — `ollama/ollama:latest` unpinned third-party image
**File:** `.openpalm/state/registry/addons/ollama/compose.yml:6`
`latest` will pull a breaking Ollama version silently on any `docker compose pull`. Pin to a specific version.

### P3 — npm packages have no `engines` field
**Files:** `packages/lib/package.json`, `packages/channels-sdk/package.json`, channel adapter `package.json` files
No `engines: { bun: ">=1.0.0" }`. Non-Bun consumers get opaque TypeScript parse errors at import time.

### P4 — YAML indentation bug in `publish-assistant-tools.yml`
**File:** `.github/workflows/publish-assistant-tools.yml:10–14`
Blank line between `workflow_dispatch:` and `inputs:` causes `inputs` to be parsed as a sibling key rather than a child. The `version` input is silently ignored and the version override feature doesn't work.

### P5 — Channel adapter packages have no `files` whitelist
**Files:** `packages/channel-discord/package.json`, `packages/channel-slack/package.json`, `packages/channel-api/package.json`, `packages/channel-voice/package.json`, `packages/channels-sdk/package.json`
No `files` field → npm publish includes the entire source tree (test files, any dev fixtures, `bun.lock`).

---

## UX Rough Edges

### U1 — Port conflict detection masks the wizard's own port
**File:** `packages/ui/src/routes/api/setup/system-check/+server.ts:96`
`if (t.port === selfPort) return { ...t, available: true }` — the wizard's own port is forced-"available" which masks real conflicts that will break the post-install admin UI on that port.

### U2 — Embedding dimension `0` propagates silently into config
**File:** `packages/ui/src/routes/setup/+page.svelte:398–405`
If the selected embedding model is not in `KNOWN_EMB_DIMS`, `dims` is `0`, which writes `"dimension": 0` into `config/akm/config.json`. The memory system fails at runtime with no install-time warning.

### U3 — Provider detection has no timeout; "Use defaults" button stays disabled indefinitely
**File:** `packages/ui/src/routes/setup/steps/WelcomeStep.svelte:34–38`
If `checkOpenCodeAndInit()` or `detectProviders()` hangs, `detectionReady` never becomes `true` and the primary CTA is permanently disabled. Fix: add a 10-second timeout that sets `detectionReady = true` regardless.

### U4 — `setup.sh` version is hardcoded; breaks `curl | bash` between releases
**File:** `scripts/setup.sh:9`
`SCRIPT_VERSION="0.11.0-beta.3"` — `curl | bash` from `main` between releases downloads a non-existent binary tag. This version string needs to be updated as part of every release, or derived dynamically.

### U5 — Host header check returns bare `400 invalid_host` with no guidance
**File:** `packages/ui/src/lib/server/helpers.ts:209`
LAN clients get `400 invalid_host` with no explanation of how to expose the UI for remote access. The error body should include a pointer to `OP_ADMIN_BIND_ADDRESS`.

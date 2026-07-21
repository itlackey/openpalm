# Legacy Cleanup Tracking — pre-0.11.0 Artifacts

> HISTORICAL: shipped in 0.12.0; kept as a design record. Current behavior is
> authoritative in
> [`core-principles.md`](../technical/core-principles.md).

**Status:** Findings captured 2026-06-02. No fixes applied yet — this is a tracking checklist.
**Method:** Four parallel read-only review agents (app source, compose/infra, docs, scripts/CI), findings cross-corroborated and spot-verified against the working tree.
**Scope:** Residue from the pre-0.11.0 Docker-based "admin container" architecture and other pre-0.11.0 concepts (capabilities, vault, mem0, registry catalog).

## Context

The 0.11.0 architectural migration is **complete** in shipped code. Verified absent from all tracked
non-roadmap files:

- No `admin` container/service in any compose file (admin UI is now a host process)
- No `docker-socket-proxy`, no Caddy / reverse-proxy config
- No `OP_CAP_*` capability env vars; `stack.yml` is `version: 2` only
- No mem0 / Python memory service; no `/etc/vault/` mounts
- `packages/admin/` → `packages/ui/` rename complete; `packages/assistant-tools/` deleted

What remains is **residue**: dead exports, stale comments, orphaned skeleton dirs, env-var naming
drift, two functional bugs, and a large bucket of stale documentation.

---

## Bugs (functional — fix first)

- [ ] **`lifecycle.ts:190` — update detection queries a retired Docker repo.**
      `updateStackEnvToLatestImageTag()` fetches `registry.hub.docker.com/v2/repositories/${namespace}/admin/tags`
      to pick the newest `OP_IMAGE_TAG`, and is called from `lifecycle.ts:265` (update flow).
      Release CI publishes `openpalm/{assistant,channel,guardian,voice,channels-sdk,lib,data}` but **not
      `openpalm/admin`** (verified in `.github/workflows/release.yml`). Update detection therefore targets a
      repo CI no longer pushes → stale/failed version detection.
      **Action:** point the query at a canonical published image (e.g. `assistant`), or whatever image now
      carries the platform version. Update `lifecycle.vitest.ts:247–286` accordingly.
      File: `packages/lib/src/control-plane/lifecycle.ts:190`

- [ ] **`scripts/dev-e2e-test.sh` — authenticates via the removed `x-admin-token` header.**
      Lines 248, 256, 267 call `/admin/*` with `-H "x-admin-token: $UI_TOKEN"`. That fallback was removed in
      Phase 2 of the auth/proxy refactor (`packages/ui/src/lib/server/helpers.ts:94`; asserted gone in
      `helpers.vitest.ts:139`) → requests now 401. The dev e2e suite is broken against current auth.
      **Action:** refactor to the cookie-login flow (`POST /admin/auth/login` → `op_session` cookie →
      `-b cookie.jar`). `release-e2e-test.sh:561–570` already does this correctly.

- [ ] **`docs/installation.md` — instructs users to put provider secrets in `stack.env`.**
      Lines 61–72 list `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `OP_UI_LOGIN_PASSWORD` as `stack.env`
      contents. This contradicts the secret boundary: provider keys live in `knowledge/secrets/auth.json`,
      and `OP_UI_LOGIN_PASSWORD` in `knowledge/secrets/op_ui_login_password`. A user following this guide
      mis-places secrets. **Action:** rewrite (see Documentation section).

---

## Theme 1 — Dead code & unused exports (HIGH confidence, safe)

- [ ] `migration0110LogPath` — exported, zero callers (verified). `packages/lib/src/control-plane/paths.ts:71` → remove
- [ ] `adminServiceDir` — exported, zero callers (verified). `packages/lib/src/control-plane/paths.ts:77` → remove
- [ ] `SPEC_DEFAULTS.ports.guardian = 3899` — never read (`OP_GUARDIAN_PORT` no longer emitted; test asserts absence). `packages/lib/src/control-plane/stack-spec.ts:31` → remove
- [ ] `buildSystemSecretsFromSetup` unused `_existingSystemEnv` param — comment says "can be removed in a follow-up cleanup". `packages/lib/src/control-plane/setup.ts:136–141` (call site ~228) → remove param
- [ ] `ensureDirectoryTree()` — 3 ignored `_`-prefixed params; creates `config/assistant/{tools,plugins,skills}/` dirs not in the skeleton (assistant-tools is gone). `packages/cli/src/lib/io.ts:18–55` → trim params + dead dirs; align with `home.ts`
- [ ] Endpoints lazy-migration from `dataDir/admin/endpoints.json` runs every startup. `packages/ui/src/lib/server/endpoints.ts:62–97,150–163` → verify install age, then drop (`legacyEndpointsPath`, `maybeMigrateLegacyEndpointsFile`)

## Theme 2 — Orphaned skeleton / mount artifacts (HIGH)

> ⚠️ **Safety:** only the git-tracked repo skeleton + code below is in scope. Do **NOT** delete any
> runtime `~/.openpalm/data/admin/` or `.dev/data/admin/` — those are untracked user data.

- [ ] `data/admin/` skeleton + creation sites — nothing mounts it. Remove `.openpalm/data/admin/.gitkeep`, creation in `home.ts:97` ("admin home bind mount"), `dev-setup.sh:145`, `io.ts:44`; update assertion `install-flow.test.ts:247`. **Do after** the endpoints-migration item above (it reads from `dataDir/admin/`).
- [ ] `.dockerignore:9–20,33–34` — dead entries: root `channels/ api/ admin/ guardian/` (all gone) and `.openpalm/vault/**` (vault retired). Remove. **Also verify** `knowledge/secrets/` has an ignore entry (possible new gap).
- [ ] `core/channel/Dockerfile:5` — `CHANNEL_FILE` "legacy file-based channels" fallback comment; not implemented anywhere → remove comment.

## Theme 3 — Env-var naming drift: `OP_ADMIN_*` → `OP_HOST_UI_*` (MEDIUM)

Kept alive only by a backward-compat shim. Coordinated rename + removal once the compat window closes:

- [ ] `OP_ADMIN_PORT` emitted into `stack.env`: `spec-to-env.ts:45`, `config-persistence.ts:134`, `SPEC_DEFAULTS` in `stack-spec.ts`; fallback read in `system-check/+server.ts:97`; seeded by `dev-setup.sh:231` and `dev-e2e-test.sh:128`
- [ ] `OP_ADMIN_OPENCODE_PORT` — emitted (`spec-to-env.ts:46`, `config-persistence.ts:135`, `stack-spec.ts:30`) but appears **never read**; verify against `packages/electron/` then remove
- [ ] `ADMIN_PORT` constant defaults to legacy `8100` (UI default is `3880`). `packages/ui/src/lib/server/helpers.ts:258` → rename to `UI_PORT`, default `3880`
- [ ] `package.json:20` `ui:dev:isolated` uses legacy `PORT=8100`

## Theme 4 — "admin token" → "password" migration left half-done (HIGH)

- [ ] UI copy still says "Admin Token": `AuthGate.svelte:37,42,48`; error strings `'Invalid admin token.'` in `admin/+page.svelte:156,157,221,242` and `api.ts:339` → change to "password"
- [ ] Login client still sends `{ token }`; server keeps `body.token` fallback (`auth/login/+server.ts:28–32`, `auth/session/+server.ts:26`). Update client (`admin/+page.svelte:169`) to send `{ password }`, then drop the fallback
- [ ] (dev e2e auth fix — see Bugs)

## Theme 5 — Stale documentation (HIGH)

- [ ] `docs/README.md` — broken/wrong links: CONTRIBUTING.md path (lives at `.github/`), `packages/admin/` → `packages/ui/` (L47), nonexistent `technical/undocumented-details.md` (L39) & `technical/prd.md` (L64), mislinked `community-channels.md` (L63, lives under `channels/`)
- [ ] `docs/technical/bunjs-rules.md:5` — `packages/admin/` → `packages/ui/`
- [ ] **Addons-as-file-drop → Compose profiles.** Nonexistent `addons/<name>/compose.yml` pattern + wrong `~/.openpalm/stack` dir across: `installation.md:96–98,33`, `troubleshooting.md:93,204`, `backup-restore.md:41,86`, `channels/discord-setup.md:52–58`, `channels/slack-setup.md:70–76`. Rewrite to `~/.openpalm/config/stack` + `--profile addon.<name>` (custom services → `custom.compose.yml`)
- [ ] `installation.md:61–72` — secrets in `stack.env` (see Bugs)
- [ ] **`stack.yml capabilities` / "runtime capability values"** terminology: `AGENTS.md:250`, `backup-restore.md:20`, `setup-walkthrough.md:99`, `.openpalm/config/stack/README.md:68`, `paths.ts:27` comment → "version marker + enabled addon names"
- [ ] `AGENTS.md:41` & `core/assistant/README.md:29–55,67` — `packages/assistant-tools/` listed as live; `OP_ASSISTANT_TOKEN` referenced → rewrite
- [ ] `AGENTS.md:37` — scheduler reads `config/automations/` → `knowledge/tasks/`
- [ ] `AGENTS.md:42,238` & `core-principles.md:294` & `how-it-works.md:151–155` — `stack/addons/<name>/` file-drop + "registry catalog" (both removed) → describe `custom.compose.yml` + profiles
- [ ] `password-management.md:74` — "admin addon | full bind mount" → admin is a host process (no mount)
- [ ] `design-intent.md:39` — "admin token storage (localStorage)" contradicts security invariant (session cookie, no localStorage) → fix
- [ ] `setup-guide.md:41` — wizard "pick an admin token, name, email"; wizard now auto-generates a password, no name/email → align with `setup-walkthrough.md`
- [ ] `auth-and-proxy-refactor-plan.md` — header "PROPOSED" but Phase 2 has landed; `openpalm-voice-addon.md:228,486,545` references removed `enabled-addons.json` / `data/registry/` → add "design doc" status headers or rewrite
- [ ] `how-it-works.md:133` `x-admin-token` example; `environment-and-mounts.md:241` `OP_ADMIN_OPENCODE_BIND_ADDRESS/PORT`; `managing-openpalm.md:345` & `core-principles.md:142` `data/admin-opencode/log/` — verify against source, drop if removed
- [ ] Comment anachronisms (low): `opencode-client.ts:5` "admin (container)", `home.ts:8` "vaults", `akm-user-env.ts:59` "assistant/admin containers", `health-check.ts:2` "assistant-tools", `channels.ts:61` GUARDIAN_URL note, `automations/+server.ts:5` cron-in-container, `SecretsTab.svelte:51,96` / `user-env/+server.ts:57` "recreate the assistant container" (Docker-only wording), `DeployStep.svelte:44,49` guardian port never populated, scattered "Phase N of the auth/proxy refactor" notes
- [ ] `.env.example` — remove `OP_ADMIN_*` (22–23), `OP_MEMORY_*` + `MEMORY_USER_ID` (28–29,46–47), `OP_WORK_DIR` active assignment (14–15, also in root `.env`); fix `vault/` header comments (4,8,12) → `knowledge/secrets/` + `knowledge/env/user.env`; `OP_VOICE_PORT` (35) should be `OP_VOICE_PORT_HOST=8880`
- [ ] `.openpalm/config/stack/README.md:55` voice port `3810->8186` stale → `${OP_VOICE_PORT_HOST:-8880}:8880`; `.openpalm/README.md:~21` lists `auth.json` under `config/stack/` but compose mounts `knowledge/secrets/auth.json`

## Theme 6 — Scripts / CI loose ends (MEDIUM/LOW)

- [ ] `.github/workflows/ci.yml:103` — `ADMIN_TOKEN: ci-placeholder` env unused by `docker compose config` → remove
- [ ] `package.json:51–52` — `dev:stack`/`dev:build` hardcode a 4-file compose list diverging from CLI overlay discovery → simplify or document as intentional
- [ ] `scripts/README.md:56` — dangling `scripts/iso/README.md` reference (dir doesn't exist) → remove
- [ ] `scripts/upgrade-test.sh:4–18` — header comment references v0.8.x + port 8100 → update
- [ ] `scripts/validate-registry.sh:59` — `vaults`/`/vault` in secret-path guard (legacy backend) → narrow to `knowledge/(secrets|env)` once confirmed
- [x] `core/assistant/Dockerfile` `AKM_CLI_VERSION` pinned to stable `0.8.0` (was `next`); guardian no longer installs akm-cli. DONE.
- [ ] `.github/workflows/release.yml:449` — Electron job pins Node 22 vs Node 24 elsewhere; verify intentional (electron-builder compat) + add comment

---

## Confirmed clean (no action)

docker-socket-proxy, Caddy, `packages/admin`, `OP_CAP_*`, `/etc/vault`, mem0/Python memory, standalone
`assistant-tools` npm/CI workflow, `.yml.disabled` files, `if: false` jobs. `packages/electron/admin-tools`
(`@openpalm/admin-tools-plugin`) is current and actively built — not legacy.

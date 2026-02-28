# Documentation Review — Issues & Inconsistencies

Cross-referenced all 12 docs in `docs/` against actual implementation.
Grouped by severity: **High** = implementation contradicts docs, **Medium** =
docs incomplete or stale, **Low** = cosmetic or minor.

---

## HIGH — Implementation contradicts documentation

### 1. `ANTHROPIC_API_KEY` missing from docker-compose.yml

**Affected docs:** `api-spec.md`, `environment-and-mounts.md`, `how-it-works.md`, `managing-openpalm.md`, `opencode-configuration.md`

All docs list `ANTHROPIC_API_KEY` as a pass-through LLM provider key alongside
`OPENAI_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, `GOOGLE_API_KEY`.

`assets/docker-compose.yml` assistant service (lines 110-113) passes through
only four keys — `ANTHROPIC_API_KEY` is **not present**:

```yaml
OPENAI_API_KEY: ${OPENAI_API_KEY:-}
GROQ_API_KEY: ${GROQ_API_KEY:-}
MISTRAL_API_KEY: ${MISTRAL_API_KEY:-}
GOOGLE_API_KEY: ${GOOGLE_API_KEY:-}
```

The admin connections API (`control-plane.ts:1003`) and UI do reference
`ANTHROPIC_API_KEY`, so the user can set it — but the compose file never
injects it into the assistant container.

**Fix:** Either add `ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}` to the
assistant environment in `assets/docker-compose.yml`, or remove it from all
docs and the connections API.

---

### 2. Guardian secret discovery docs are wrong in `directory-structure.md`

**Affected docs:** `directory-structure.md` (lines 134-136)

Doc says:
> "The guardian receives channel secrets via environment variables (from
> `secrets.env`), not via file mounts. The `discoverSecrets()` function reads
> only from `CHANNEL_*_SECRET` env vars."

Reality:
- The function is `loadChannelSecrets()` (server.ts:54), not `discoverSecrets()`
- Guardian **does** use a file mount: `stack.env` is bind-mounted at
  `/app/secrets/stack.env:ro` (compose line 156)
- `GUARDIAN_SECRETS_PATH` env var points to that mount (compose line 147)
- Guardian reads secrets from the file **first**, falling back to env vars
  (server.ts:55-73)

**Fix:** Rewrite the guardian section of `directory-structure.md` to match
actual behavior: file-based discovery via `GUARDIAN_SECRETS_PATH` with env-var
fallback.

---

### 3. `environment-and-mounts.md` says guardian loads `secrets.env` — actually `stack.env`

**Affected docs:** `environment-and-mounts.md` (lines 91-93)

Doc says:
> "Channel HMAC secrets are injected via the staged
> `STATE_HOME/artifacts/secrets.env` (loaded by the guardian's `env_file:`
> directive)."

Reality: The guardian's `env_file:` loads `STATE_HOME/artifacts/stack.env`
(compose line 151), **not** `secrets.env`. Channel HMAC secrets
(`CHANNEL_*_SECRET`) are written into `stack.env` by the admin, not into
`secrets.env`.

**Fix:** Change "secrets.env" to "stack.env" in the guardian section.

---

### 4. `OPENCODE_TIMEOUT_MS` value mismatch between docs, compose, and code

**Affected docs:** `environment-and-mounts.md` (line 179)

Doc says `OPENCODE_TIMEOUT_MS: 15000` (15 seconds). Compose sets `"15000"`.
But in guardian code (server.ts:137):

```typescript
const MESSAGE_TIMEOUT = Number(Bun.env.OPENCODE_TIMEOUT_MS ?? 120_000);
```

This env var controls the **LLM message timeout** — the maximum wait time for
the assistant to respond. The code default is 120 seconds; compose overrides
it to 15 seconds, which may be too aggressive for LLM inference calls. The
variable name suggests a general "timeout" but it specifically gates the
assistant message POST.

**Fix:** Raise the compose value to something larger like 6000s to account for slower local models. Also clarify that this
controls the assistant message timeout specifically.

---

### 5. Guardian uses `node:fs` and `node:path` — violates Bun rules

**Affected docs:** `bunjs-rules.md` (sections 1, D, F)

`bunjs-rules.md` says:
> "Prefer Bun and Web Platform built-ins before adding third-party runtime
> dependencies."
> "Use `Bun.file(path)` for file reads, `Bun.write(path, data)` for writes."

Guardian (`core/guardian/src/server.ts` lines 17-19) imports:
```typescript
import { mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname } from "node:path";
```

These are used for audit logging. `Bun.write()` or `Bun.file().writer()` should
be used instead per the stated rules.

**Fix:** Update guardian to use Bun APIs for file operations

---

### 6. `dev:stack` script missing `--env-file stack.env`

**Affected docs:** `CLAUDE.md` (Docker local build section)

CLAUDE.md documents compose invocation with two env files:
```
--env-file .dev/state/artifacts/stack.env \
--env-file .dev/state/artifacts/secrets.env \
```

But `package.json` `dev:stack` script uses only one:
```json
"dev:stack": "docker compose -f .dev/state/artifacts/docker-compose.yml --env-file .dev/config/secrets.env up -d"
```

Missing `--env-file .dev/state/artifacts/stack.env`. Also uses
`.dev/config/secrets.env` (CONFIG tier) not `.dev/state/artifacts/secrets.env`
(STATE tier staged copy), which contradicts the file-assembly model where
Docker reads from STATE only.

**Fix:** Update the script to include both env files from STATE.

---

## MEDIUM — Docs incomplete or stale

### 7. `channels/base` and BaseChannel SDK completely undocumented

Root `package.json` includes `channels/base` in workspaces. `packages/lib`
exports `channel-base.ts` (BaseChannel abstract class) and
`channel-entrypoint.ts` (dynamic loader). `channels/base/` contains a
Dockerfile, example channel, and tests.

This is a significant feature — a community channel SDK that lets developers
create channels by extending `BaseChannel` — but no doc mentions it. Not in
`how-it-works.md`, `directory-structure.md`, `core-principles.md`, or
`CLAUDE.md`.

**Fix:** Add a dedicated
`community-channels.md` documenting BaseChannel, the entrypoint loader, and
the `channels/base` Docker image.

---

### 8. `BaseChannel.log()` doesn't use `createLogger`

**Affected docs:** `bunjs-rules.md` (section 4)

Doc says:
> "All Bun services must use `createLogger` from
> `packages/lib/src/shared/logger.ts` for structured JSON output."

`BaseChannel` in `packages/lib/src/shared/channel-base.ts` (lines 67-76) uses
its own inline `log()` method with direct `console.log`/`console.error` calls
instead of `createLogger`. Any community channel using BaseChannel will bypass
the documented logging contract.

**Fix:** Update BaseChannel to use `createLogger`

---

### 9. Caddy access control architecture unclear across docs

**Affected docs:** `how-it-works.md`, `managing-openpalm.md`, `core-principles.md`, `directory-structure.md`

Multiple docs reference `@denied not remote_ip ...` as the access control
mechanism (e.g., `how-it-works.md:199`). The bundled `assets/Caddyfile` uses a
`(lan_only)` snippet pattern with `import lan_only` in route blocks. The
system-managed Caddyfile at `DATA_HOME/caddy/Caddyfile` is a separate copy
that admin modifies for access-scope changes.

The relationship between these three artifacts is unclear:
- `assets/Caddyfile` — bundled template (uses `import lan_only`)
- `DATA_HOME/caddy/Caddyfile` — system-managed source of truth (admin mutates
  `@denied` lines here)
- `STATE_HOME/Caddyfile` — staged runtime copy

No doc clearly explains that `DATA_HOME/caddy/Caddyfile` is the mutable copy
while `assets/Caddyfile` is the immutable bundled original.

**Fix:** Add a clear explanation of the Caddyfile lifecycle to `how-it-works.md`.

---

### 10. `how-it-works.md` diagram shows confusing port overlap

**Affected docs:** `how-it-works.md` (lines 15-28)

The architecture diagram shows both "Caddy :8080" and "Guardian :8080". In
reality:
- Caddy listens on port 80 internally, mapped to 8080 on the host
- Guardian listens on port 8080 internally, not exposed on host
- They are on different Docker networks

The diagram implies both services listen on the same port, which is confusing.

**Fix:** Show Caddy as `:80 (→ host:8080)` and Guardian as `:8080 (internal)`
to disambiguate and/or update the default ports for core container to be easier to recall and less ambiguous

---

### 11. `prd.md` is stale and incomplete

**Affected docs:** `prd.md`

- No mention of: connections API, gallery/extensions system, containers/pull,
  BaseChannel SDK, community channels
- "Not implemented" section (line 61-62) lists endpoints that now exist
  (gallery routes are implemented)
- Acceptance criteria are minimal (5 items) and don't cover current features
- Missing: connections management, extension gallery, pull/recreate workflow

**Fix:** Update the PRD to reflect current state and mark it v0.5.0.

---

### 12. `CLAUDE.md` route inventory is incomplete

**Affected docs:** `CLAUDE.md` (Key Files section)

Lists routes as:
> install, update, uninstall, containers/\*, channels, channels/install,
> channels/uninstall, artifacts, audit, access-scope, connections

Missing from the list:
- `containers/pull`
- `gallery/*` (7 endpoints)
- `installed`
- `connections/status`
- `guardian/health` (proxy endpoint)

**Fix:** Reference `api-spec.md` instead of
maintaining a duplicate list.

---

### 13. `prd.md` and `managing-openpalm.md` mention "host vars" in secrets.env

**Affected docs:** `prd.md` (line 45), `managing-openpalm.md` (line 23)

Both say `CONFIG_HOME/secrets.env` contains "host vars" alongside
`ADMIN_TOKEN` and LLM keys. But `core-principles.md` (line 43) says:

> "No paths, UID/GID, or infra config belongs here."

The term "host vars" is vague and contradicts the strict secrets.env scope.

**Fix:** Remove "host vars" from `prd.md` and `managing-openpalm.md` to align
with `core-principles.md`.

---

### 14. `api-spec.md` access-scope "custom" behavior underdocumented

**Affected docs:** `api-spec.md` (lines 185-216)

GET may return `"custom"` when the Caddyfile has user-edited IP ranges. POST
only accepts `"host"` or `"lan"` — not `"custom"`. The doc doesn't explain
what happens if the current scope is "custom" and a POST changes it to "host"
or "lan" (the custom ranges are overwritten).

**Fix:** Document the "custom" detection behavior and the one-way nature of
POST (custom ranges cannot be restored via API after being overwritten).

---

### 15. Registry channels include stubs with no implementations

**Affected docs:** Not documented anywhere

`registry/` contains `telegram.yml`, `telegram.caddy`, and `voice.yml` but
no actual Telegram or voice channel implementations exist in `channels/`.
Installing these via the API would create Docker services referencing images
that don't exist.

**Fix:** Either remove the stubs

---

### 16. `opencode-configuration.md` missing `ANTHROPIC_API_KEY` in provider table

**Affected docs:** `opencode-configuration.md` (lines 133-139)

LLM provider pass-through table lists 4 keys but omits `ANTHROPIC_API_KEY`.
This is consistent with the compose file omission (issue #1) but inconsistent
with the connections API which does manage `ANTHROPIC_API_KEY`.

**Fix:** Add `ANTHROPIC_API_KEY` to the table (and fix the compose file).

---

## LOW — Minor inconsistencies or cosmetic issues

### 17. Kiosk doc uses non-XDG paths without explanation

**Affected docs:** `debian13-kiosk-iso.md` (lines 82-85)

Uses `/var/lib/openpalm/{config,state,data,work}` instead of XDG-compliant
paths. While intentional for an appliance, this deviates from the XDG contract
in `core-principles.md` without explanation.

**Fix:** Add a note explaining the kiosk intentionally overrides XDG defaults
for appliance use.

---

### 18. `how-it-works.md` file assembly diagram says "merge+sanitize"

**Affected docs:** `how-it-works.md` (line 185)

```
CONFIG_HOME/secrets.env  ──merge+sanitize──▶  STATE_HOME/artifacts/secrets.env
```

The word "merge" implies combining multiple sources. The word "sanitize"
implies stripping `CHANNEL_*_SECRET` lines. The actual operation may be a
simpler copy with system-managed secrets appended from `stack.env`, not merged
into `secrets.env`. The terminology is imprecise.

**Fix:** Clarify the staged `secrets.env` is a verbatim copy 
---

### 19. Admin `node:crypto` usage — technically outside bunjs-rules scope

**Affected docs:** `bunjs-rules.md`

`bunjs-rules.md` targets "guardian + channel services" per its header. Admin
is a SvelteKit/Node app. Admin uses `node:crypto` for:
- `createHash` / `randomBytes` (control-plane.ts:25) — artifact hashing,
  password generation
- `timingSafeEqual` (helpers.ts:5) — admin token comparison

This is architecturally sound (admin runs on Node, not Bun) but may confuse
contributors who read bunjs-rules.md as a project-wide policy.

**Fix:** Clarify that `bunjs-rules.md` applies to Bun services only (guardian,
channels, lib). Admin follows SvelteKit/Node conventions.

---

### 20. Cross-doc duplicate maintenance burden

Several facts are repeated across 3-5 docs (port numbers, env vars, volume
mounts, security invariants). This creates a maintenance burden where a single
change requires updating multiple files. Notable duplicates:

| Fact | Repeated In |
|------|------------|
| 8 core services list | core-principles, prd, directory-structure, environment-and-mounts, how-it-works |
| Volume mount tables | directory-structure, environment-and-mounts |
| LLM provider keys | api-spec, environment-and-mounts, opencode-configuration, managing-openpalm |
| Security invariants | core-principles, prd, how-it-works, CLAUDE.md |

**Fix:** Canonicalize these facts in one doc and cross-reference
from others

---

## Summary

| Severity | Count | Key Themes |
|----------|-------|-----------|
| **High** | 6 | Missing env var, wrong secret discovery docs, timeout mismatch, Bun API violations, broken dev script |
| **Medium** | 10 | Undocumented BaseChannel SDK, stale PRD, incomplete route lists, ambiguous Caddyfile lifecycle |
| **Low** | 4 | Non-XDG kiosk paths, imprecise terminology, doc duplication |
| **Total** | **20** | |

### Recommended priority

1. Fix `ANTHROPIC_API_KEY` in compose + docs (#1, #16) — user-facing bug
2. Fix guardian secret discovery docs (#2, #3) — security-critical documentation
3. Fix `dev:stack` script (#6) — dev workflow broken
4. Document BaseChannel SDK (#7) — important undocumented feature
5. Update `prd.md` (#11) — stale source of truth
6. Clarify Caddyfile lifecycle (#9) — confusing architecture

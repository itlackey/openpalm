# Configuration & DevOps Critical Review

**Date:** 2026-03-24
**Branch:** release/0.10.0
**Reviewer:** Configuration & DevOps Agent

---

## Executive Summary

The OpenPalm infrastructure shows strong architectural thinking -- the multi-file compose approach, vault/config boundary, and varlock secret redaction are well-designed. However, there are several security issues, a broken release workflow, inconsistent base image pinning, and some unnecessary complexity in the Docker builds. The dev experience is solid once set up but has a few rough edges.

**Critical issues:** 2
**High severity:** 7
**Medium severity:** 11
**Low severity:** 9

---

## 1. Docker Compose Files

### 1.1 Core Compose (`/.openpalm/stack/core.compose.yml`)

**CRITICAL -- Scheduler mounts all of `data/` read-write (line 167)**

The scheduler has `${OP_HOME}/data:/openpalm/data` mounted rw. This gives the scheduler write access to ALL service data: `data/memory/`, `data/assistant/`, `data/guardian/`, `data/admin/`. The scheduler only needs `data/automations/` (if even that). This violates the principle of least privilege.

```yaml
volumes:
  - ${OP_HOME}/config:/openpalm/config:ro   # Good: read-only
  - ${OP_HOME}/logs:/openpalm/logs           # Acceptable
  - ${OP_HOME}/data:/openpalm/data           # BAD: full data/ rw
```

**Recommendation:** Mount only the specific subdirectories the scheduler needs, not the entire `data/` tree.

**HIGH -- Scheduler receives OP_ADMIN_TOKEN (line 158)**

The scheduler has `OP_ADMIN_TOKEN` in its environment. This means a compromised scheduler has admin-level access. The scheduler documentation says "NO docker socket" but giving it the admin token is equally dangerous since the admin API controls the stack.

**Recommendation:** Create a separate scheduler-scoped token with reduced privileges, or remove admin token access entirely if the scheduler doesn't need it.

**HIGH -- Guardian receives OP_ADMIN_TOKEN (line 131)**

The guardian also has `OP_ADMIN_TOKEN` in its environment. The guardian's job is HMAC verification -- it should not need admin API access.

**Recommendation:** Remove `OP_ADMIN_TOKEN` from guardian unless there is a documented reason it needs it.

**MEDIUM -- Network isolation is incomplete**

The `channel_lan` and `channel_public` networks are defined but have no actual isolation configuration. Docker Compose networks are all bridged by default. There are no `internal: true` markers, no driver options, no subnet restrictions. The names suggest different security zones but the implementation provides no actual security boundary.

```yaml
networks:
  channel_lan:       # No internal: true
  channel_public:    # No driver_opts
  assistant_net:     # No isolation
```

**Recommendation:** At minimum, set `internal: true` on `assistant_net` so containers on that network cannot reach the internet directly.

**LOW -- Memory healthcheck uses `bun -e` with inline JS (line 48)**

This works but is fragile compared to a simple `curl -sf` healthcheck. The guardian and scheduler use the same pattern. If Bun crashes or has issues, the healthcheck itself fails ambiguously.

### 1.2 Admin Addon (`/.openpalm/stack/addons/admin/compose.yml`)

**HIGH -- Admin mounts full `${OP_HOME}` as `/openpalm` (line 62)**

The admin container mounts the entire `${OP_HOME}` directory tree including vault secrets. While the architectural docs say "Only admin mounts full vault/", mounting the entire home directory is broader than vault alone -- it includes `data/`, `config/`, `logs/`, and `stack/`.

**Recommendation:** Mount only the specific subdirectories admin needs rather than the entire OP_HOME.

**MEDIUM -- GPG socket bind mount with `create_host_path: true` (line 68-71)**

```yaml
- type: bind
  source: ${GNUPGHOME:-${HOME}/.gnupg}
  target: /home/node/.gnupg
  read_only: true
  bind:
    create_host_path: true
```

This creates `~/.gnupg` on the host if it doesn't exist (owned by the Docker daemon), which may be unexpected. On systems where GPG is not used, this silently creates an empty directory.

**MEDIUM -- Docker socket proxy has POST enabled**

```yaml
POST: 1
```

POST access to the Docker socket allows creating/starting/stopping containers. While this is needed for admin operations, it represents significant attack surface. The `EXEC: 0` is good (prevents exec into containers).

### 1.3 Compose.dev.yaml

**LOW -- Voice channel dev override mounts all three env files**

The `channel-voice` service in `compose.dev.yaml` mounts `stack.env`, `user.env`, and `guardian.env` as env_files. Voice channels should only receive their own HMAC secret, not the full stack env. This is a dev-only issue but sets a bad pattern.

### 1.4 Channel Addons (chat, discord, api, slack, voice)

**Good:** All channel addons properly use `channel_lan` network only, run as non-root via `${OP_UID}:${OP_GID}`, have healthchecks, and don't mount vault directories. Clean, consistent patterns.

### 1.5 Ollama Addon

**LOW -- Uses `ollama/ollama:latest` without digest pinning**

The ollama image tag is `:latest` which makes builds non-reproducible. Other images in the stack properly use `${OP_IMAGE_TAG}` for versioning.

---

## 2. Dockerfiles

### 2.1 Assistant Dockerfile (`/core/assistant/Dockerfile`)

**HIGH -- Runs as USER root with no final USER step (line 85)**

```dockerfile
USER root
WORKDIR /work
...
# No final USER directive before CMD
```

The assistant container runs as root. The entrypoint.sh does `gosu` to drop privileges at runtime, but if gosu fails or is bypassed, the container runs as root. The comment about "OpenCode with OpenPalm extensions" running as root is a significant security concern, especially since this container handles LLM responses and tool execution.

**Recommendation:** Add a final `USER node` or `USER opencode` directive. Have the entrypoint only escalate when needed (e.g., for SSH setup), then drop back.

**HIGH -- Uses `node:lts-trixie` (full, not slim) base image**

```dockerfile
FROM node:lts-trixie
```

The full `node:lts-trixie` image is ~1GB and includes build tools, compilers, and many unnecessary packages. The admin properly uses `node:lts-trixie-slim`. The assistant image bloats further with python3, pip, azure-cli, gh, ripgrep, jq, openssh-server, and more.

**Recommendation:** Use `node:lts-trixie-slim` and install only what's strictly needed. Consider whether azure-cli, huggingface-hub, and apprise really belong in the base image.

**MEDIUM -- `chmod 777 /home/opencode` (line 75)**

```dockerfile
&& chmod 777 /home/opencode /home/opencode/.cache /home/opencode/.akm \
```

World-writable home directory is a security anti-pattern. Any process in the container can write to the home directory. Use `755` or `700` instead.

**MEDIUM -- Multiple `curl | bash` install patterns (lines 71, 84, 92, 101)**

Four separate `curl | bash` installations (OpenCode, Bun, uv, agentikit). While versions are pinned via ARGs, the install scripts themselves are not integrity-verified. Only agentikit's install script mentions SHA-256 verification.

**Recommendation:** Where possible, download binaries directly and verify checksums rather than piping to bash.

**MEDIUM -- `pip install --break-system-packages` (line 67)**

```dockerfile
RUN pip install --break-system-packages azure-cli huggingface-hub[cli] apprise
```

This modifies system-level Python packages. The `--break-system-packages` flag exists specifically because this is a bad practice. Use `uv` (which is installed in the same Dockerfile) or a venv instead.

### 2.2 Varlock Fetch Stage Duplication

**MEDIUM -- Identical varlock-fetch stage duplicated in 5 Dockerfiles**

The exact same 20-line varlock-fetch stage appears in:
- `core/admin/Dockerfile`
- `core/guardian/Dockerfile`
- `core/assistant/Dockerfile`
- `core/channel/Dockerfile`
- `core/memory/Dockerfile`

The scheduler (`core/scheduler/Dockerfile`) is the only one that does NOT include varlock.

**Recommendation:** Extract this into a shared base image or use Docker `COPY --from=` referencing a single build stage. The duplication means version bumps require editing 5 files.

### 2.3 Admin Dockerfile (`/core/admin/Dockerfile`)

**Good:** Multi-stage build, uses slim images, runs as `USER node`, properly strips workspace refs before npm install. The varlock binary is fetched and SHA-verified.

**MEDIUM -- Bun install sets `BUN_INSTALL=/tmp/.bun` for runtime (line 85-87)**

```dockerfile
ENV BUN_INSTALL=/tmp/.bun
ENV BUN_INSTALL_CACHE_DIR=/tmp/.cache/bun/install
```

Using `/tmp/` for Bun's install location means Bun's global binaries and cache go to the tmp directory. This is world-writable and may be cleared by the OS. While this is a workaround for running as `node` user, a better approach would be a user-writable directory under `/home/node`.

### 2.4 Guardian, Channel, Memory Dockerfiles

**Good:** All use slim Bun images, run as `bun` user, properly follow the Docker dependency resolution pattern (copy SDK source, install deps after copy). The `bun install --production` and lockfile removal pattern is correct for the monorepo constraint.

### 2.5 Scheduler Dockerfile

**HIGH -- Missing varlock (no secret redaction in logs)**

The scheduler is the ONLY Dockerfile without varlock. It has access to `OP_ADMIN_TOKEN`, `OP_MEMORY_TOKEN`, and `OP_OPENCODE_PASSWORD` in its environment, but none of these are redacted from container logs.

**Recommendation:** Add varlock to the scheduler Dockerfile, same as all other services.

### 2.6 Base Image Consistency

| Image | Base | Version Pin |
|-------|------|-------------|
| Admin (build) | `node:lts-trixie-slim` | LTS floating |
| Admin (runtime) | `node:lts-trixie-slim` | LTS floating |
| Assistant | `node:lts-trixie` | LTS floating (full image!) |
| Guardian | `oven/bun:1.3-slim` | 1.3 minor floating |
| Channel | `oven/bun:1.3-slim` | 1.3 minor floating |
| Memory | `oven/bun:1-debian` | 1.x major floating |
| Scheduler | `oven/bun:1.3-slim` | 1.3 minor floating |

**MEDIUM -- Inconsistent Bun version pinning**

Memory uses `oven/bun:1-debian` (major version only) while guardian/channel/scheduler use `oven/bun:1.3-slim`. The memory service could unexpectedly get a Bun 2.x upgrade.

**LOW -- No image digest pinning for base images**

Only the docker-socket-proxy image uses `@sha256:` digest pinning. All other base images use floating tags. For production reproducibility, digest pinning is recommended.

---

## 3. Environment Variable Handling & Security

### 3.1 Secret Leakage Vectors

**CRITICAL -- `DISCORD_BOT_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` missing from redaction schema**

File: `/.openpalm/vault/redact.env.schema`

The varlock redaction schema covers channel HMAC secrets and LLM API keys, but completely misses:
- `DISCORD_BOT_TOKEN` (Discord bot credential)
- `DISCORD_APPLICATION_ID` (not sensitive but related)
- `SLACK_BOT_TOKEN` (Slack bot credential)
- `SLACK_APP_TOKEN` (Slack app-level credential)
- `STT_API_KEY` (voice channel STT key)
- `TTS_API_KEY` (voice channel TTS key)
- `VLM_API_KEY` (OpenViking VLM key)

These sensitive tokens will appear in plaintext in Docker container logs if they are ever printed.

**Recommendation:** Add all `@sensitive`-annotated variables from addon `.env.schema` files to `redact.env.schema`.

### 3.2 Vault/Config Boundary

**Good:** The `.gitignore` correctly excludes `stack.env` and `user.env` from version control. The template files (`.env.schema`) are tracked but contain no actual secrets. File permissions on the vault files are `600` (owner-only read/write).

**Good:** The pre-commit hook provides two layers of protection: varlock scan (when available) and regex pattern matching as fallback.

### 3.3 Secret Generation

**Good:** `dev-setup.sh` generates tokens using `openssl rand -hex 32` (256-bit entropy for tokens) and `openssl rand -hex 16` (128-bit for HMAC secrets). The HMAC secrets are shorter but adequate for their purpose.

**LOW -- `dev-admin-token` hardcoded in dev setup**

```bash
OP_ADMIN_TOKEN=dev-admin-token
```

This is intentional for dev, but the string "dev-admin-token" appears in multiple test scripts, making it easy for a developer to accidentally use it in production. The dev-setup script should print a warning when seeding this value.

### 3.4 user.env vs stack.env Split

**MEDIUM -- Confusion between user.env and stack.env ownership**

The `user.env` file in `.openpalm/vault/user/user.env` template contains API keys:
```
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GROQ_API_KEY=
...
```

But the `stack.env.schema` in `.openpalm/vault/stack/stack.env.schema` also declares these same keys:
```
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GROQ_API_KEY=
...
```

Both files are loaded via `--env-file`. Docker Compose will use the LAST `--env-file` value. Depending on the order `--env-file` flags are specified, one will silently shadow the other. The `dev:build` and `dev:stack` scripts in package.json use different env file orders, which could cause inconsistent behavior.

In `package.json`:
- `dev:stack`: `--env-file .dev/vault/stack/stack.env --env-file .dev/vault/stack/services/memory/managed.env --env-file .dev/vault/user/user.env`
- `dev:build`: same order

In `dev-e2e-test.sh`:
- `--env-file .dev/vault/stack/stack.env --env-file .dev/vault/user/user.env --env-file .dev/vault/stack/guardian.env`

The `dev:stack` script includes `managed.env` but the `dev:build` also does. The E2E test includes `guardian.env`. These different orderings could lead to different variable resolution.

---

## 4. Build Processes

### 4.1 Root package.json Scripts

**MEDIUM -- Overly complex inline shell scripts in package.json**

The `admin:test:e2e` and related scripts contain complex inline shell commands:
```json
"admin:test:e2e": "cd packages/admin && export MEMORY_AUTH_TOKEN=$(grep -E '^OP_MEMORY_TOKEN=' ../../.dev/vault/stack/stack.env 2>/dev/null | cut -d= -f2-); export ADMIN_TOKEN=$(grep -E '^OP_ADMIN_TOKEN=' ../../.dev/vault/stack/stack.env 2>/dev/null | cut -d= -f2-); RUN_DOCKER_STACK_TESTS=1 RUN_LLM_TESTS=1 PW_ENFORCE_NO_SKIP=1 npm run test:e2e"
```

This is hard to read, hard to maintain, and duplicated across `admin:test:e2e`, `admin:test:stack`, and `admin:test:llm`. The token extraction logic is repeated three times.

**Recommendation:** Extract the token-loading logic into a small shell script or use the `test-tier.sh` script consistently.

**LOW -- `dev:stack` and `dev:build` include `managed.env` in --env-file but test scripts don't**

The `dev:stack` script loads `vault/stack/services/memory/managed.env` but the E2E test script and `test-tier.sh` do not. This means the memory service may get different environment variables when run via `bun run dev:stack` vs the test scripts.

### 4.2 Build Reproducibility

**Good:** Bun lockfile (`bun.lock`) is committed and CI uses `--frozen-lockfile`. Versions for external tools (OpenCode, Bun, agentikit, varlock) are pinned via Dockerfile ARGs.

**LOW -- `node:lts-trixie` and `node:lts-trixie-slim` are floating tags**

`lts-trixie` resolves to whatever the current LTS version is at build time. A build today might use Node 22.x, but months later it could be Node 24.x. For reproducibility, pin to `node:22-trixie-slim`.

---

## 5. CI/CD

### 5.1 CI Workflow (`.github/workflows/ci.yml`)

**Good:** The CI pipeline runs on PRs and pushes to main/release branches. It includes:
- API key leak scanning (pattern-based)
- Bun + Node setup
- Type checking (svelte-check)
- Unit tests (SDK, guardian, channels)
- Docker Compose manifest validation
- Addon validation
- Deleted script assertions

**MEDIUM -- No admin unit tests in CI**

The CI runs `bun run test` (which covers SDK, guardian, channels, cli, lib) but does NOT run `bun run admin:test:unit`. The CLAUDE.md indicates 592 admin unit tests exist but they are not verified in CI.

**Recommendation:** Add `bun run admin:test:unit` to the CI pipeline.

**LOW -- No Playwright tests in CI**

Neither mocked browser tests nor integration tests run in CI. The 69 mocked Playwright tests and 45 integration tests are only run locally. At minimum, the mocked tests (which don't need a running stack) should run in CI.

### 5.2 Release Workflow (`.github/workflows/release.yml`)

**CRITICAL -- Release bundle references non-existent directories**

```yaml
tar -czf dist/openpalm-${{ needs.prepare-tag.outputs.version }}-deploy-bundle.tar.gz \
  assets \       # DOES NOT EXIST
  core \
  packages \
  registry \     # DOES NOT EXIST
  scripts \
  README.md
```

The `assets` and `registry` directories do not exist in the repository. This `tar` command will fail during a release, breaking the entire release pipeline. The deploy bundle will not be created, and the GitHub release will be missing this artifact.

**Recommendation:** Update the tar command to reference `.openpalm/` instead of `assets` and `registry`. These appear to be holdovers from a previous directory structure.

**Good:** Docker builds use QEMU + Buildx for multi-arch (linux/amd64, linux/arm64). GHA cache is used properly. Image metadata includes proper tags. CLI binaries are built cross-platform.

### 5.3 npm Publish Workflow

**Good:** Uses npm trusted publishing (provenance). Handles version bumping correctly. Retry logic for concurrent publishes. Lockfile sync after version bump.

---

## 6. Scripts

### 6.1 `scripts/dev-setup.sh`

**Good:** Well-structured, uses `set -euo pipefail`, proper argument parsing, idempotent file creation with write-once semantics. Docker socket auto-detection is a nice touch.

**LOW -- Submodule init runs even if .gitmodules doesn't exist**

The check `if [ -f "$ROOT_DIR/.gitmodules" ]` is correct, but the depth-1 clone may not be enough for all submodules. This is a minor robustness concern.

### 6.2 `scripts/release.sh`

**MEDIUM -- Pushes directly to main**

```bash
git push origin main
```

The release script pushes directly to `main` without branch protection checks. If branch protection is enabled on GitHub, this will fail. If it's not, this bypasses review.

**Recommendation:** Create a release branch, push that, then tag from there. Or document that branch protection must allow direct pushes for releases.

### 6.3 `scripts/dev-e2e-test.sh`

**Good:** Comprehensive 15-step test script covering clean state, build, stack health, environment verification, memory provisioning, setup completion, and pipeline verification. Well-structured with pass/fail counting.

**LOW -- Uses `python3 -c` for JSON parsing**

Multiple scripts use `python3 -c "import sys,json; ..."` for JSON parsing. This is a Python dependency in what are otherwise pure bash scripts. The `release-e2e-test.sh` properly abstracts this with a `json_get` helper that falls back to `jq`.

### 6.4 `scripts/upgrade-test.sh`

**Good:** Thorough upgrade path testing that verifies user data preservation, secret persistence, and service health across re-runs.

### 6.5 `scripts/validate-registry.sh`

**MEDIUM -- Vault mount detection regex is fragile (line 72)**

```bash
if grep -qE '^\s*-\s+.*vault(/?)"\s*:' "$compose_file" || grep -qE '^\s*-\s+.*vault(/?)\s*:/' "$compose_file"; then
```

This regex tries to catch broad vault mounts but would miss patterns like `${OP_HOME}/vault:/some/path` (the common pattern used in the actual compose files). The admin addon mounts `${OP_HOME}:/openpalm` which includes vault, but this check wouldn't catch it.

### 6.6 `scripts/setup.sh` (Install Script)

**Good:** Cross-platform (Linux, macOS), proper architecture detection, semver validation, codesign for macOS, PATH warning if install dir isn't on PATH.

**LOW -- No checksum verification for CLI binary download**

The setup script downloads the CLI binary but doesn't verify its SHA-256 checksum. The release workflow generates `checksums-sha256.txt`, but the install script doesn't use it.

---

## 7. Dev Setup Experience

### 7.1 Clone-to-Running Steps

To go from clone to a running dev stack:

1. `git clone` (1 step)
2. `bun install` (1 step)
3. `./scripts/dev-setup.sh --seed-env` (1 step)
4. Ensure Ollama is running with models pulled (manual, undocumented dependency)
5. `bun run admin:build` (1 step, required before dev:build)
6. `bun run dev:build` (1 step)

**Minimum 5 steps, plus the Ollama prerequisite.** The Ollama requirement is documented in MEMORY.md (personal notes) but not in CLAUDE.md or any README visible to new contributors.

**MEDIUM -- Undocumented Ollama prerequisite for dev**

The dev setup defaults to Ollama for LLM and embeddings, but there's no check that Ollama is running or that required models are pulled. `dev-setup.sh` doesn't warn about this. The `dev-e2e-test.sh` does check, but that's a test script, not the setup path.

**Recommendation:** Add an Ollama check to `dev-setup.sh` (with a clear warning, not a hard failure).

### 7.2 `.dev/` Directory Pattern

**Good:** Clean separation of dev state from production. The `.dev/` pattern mirrors the production `~/.openpalm/` structure exactly. Properly gitignored.

**LOW -- Multiple `.dev-*` directories accumulate**

The `.gitignore` has entries for `.dev-0.9.0/`, `.dev-tmp/`, `.dev-tmp*`. The glob shows `.dev-0.9.0/` and `.dev-tmp3/` exist on disk. These are leftover test artifacts that should be cleaned.

---

## 8. Dependency Management

### 8.1 Workspace Configuration

**Good:** Proper Bun workspace configuration in root `package.json` covering all 15 packages. Single lockfile at root (`bun.lock`). The `test` script properly filters to non-admin directories.

### 8.2 Admin Dependencies

**Good:** Admin uses `workspace:*` for `@openpalm/lib` dependency. DevDependencies include proper Svelte toolchain, Playwright, Vitest, and ESLint.

**LOW -- Root `devDependencies` only has `@vitest/coverage-v8`**

The root package.json has a single devDependency. This seems like an artifact -- coverage should be a devDependency in the admin package, not the root.

### 8.3 Channel Voice `.env`

**LOW -- `packages/channel-voice/.env` checked into repo**

While it contains no actual secrets (all values are empty or localhost defaults), `.env` files should generally not be tracked. The `.env.example` convention is already followed (`.env.example` exists alongside it).

---

## 9. Specific Security Findings Summary

| Severity | Finding | Location |
|----------|---------|----------|
| CRITICAL | Scheduler mounts all `data/` rw | `core.compose.yml:167` |
| CRITICAL | Redaction schema missing Discord/Slack/Voice tokens | `vault/redact.env.schema` |
| HIGH | Assistant container runs as root | `core/assistant/Dockerfile:85` |
| HIGH | Scheduler has OP_ADMIN_TOKEN | `core.compose.yml:158` |
| HIGH | Guardian has OP_ADMIN_TOKEN | `core.compose.yml:131` |
| HIGH | Admin mounts entire OP_HOME | `addons/admin/compose.yml:62` |
| HIGH | Scheduler missing varlock | `core/scheduler/Dockerfile` |
| HIGH | Assistant uses full node image (not slim) | `core/assistant/Dockerfile:30` |
| MEDIUM | chmod 777 on home directory | `core/assistant/Dockerfile:75` |
| MEDIUM | Network isolation not enforced | `core.compose.yml:181-184` |
| MEDIUM | Docker socket proxy has POST access | `addons/admin/compose.yml:13` |
| MEDIUM | user.env and stack.env key overlap | Multiple files |
| MEDIUM | pip --break-system-packages | `core/assistant/Dockerfile:67` |
| MEDIUM | Varlock fetch duplicated in 5 Dockerfiles | All Dockerfiles |
| MEDIUM | Inconsistent Bun version pinning | Memory vs other Dockerfiles |
| MEDIUM | No admin unit tests in CI | `.github/workflows/ci.yml` |
| MEDIUM | Undocumented Ollama prerequisite | Dev setup documentation |
| MEDIUM | release.sh pushes directly to main | `scripts/release.sh:55` |
| LOW | Ollama addon uses `:latest` tag | `addons/ollama/compose.yml:3` |
| LOW | Dev admin token "dev-admin-token" in many files | Multiple scripts |
| LOW | Setup script doesn't verify CLI binary checksum | `scripts/setup.sh` |
| LOW | BUN_INSTALL=/tmp in admin runtime | `core/admin/Dockerfile:85-87` |
| LOW | channel-voice .env tracked in repo | `packages/channel-voice/.env` |

---

## 10. Release Pipeline Bug

**CRITICAL -- Release workflow will fail on next release attempt**

The release workflow at `.github/workflows/release.yml` line 283-289 creates a deploy bundle that references `assets` and `registry` directories:

```yaml
tar -czf dist/openpalm-${{ needs.prepare-tag.outputs.version }}-deploy-bundle.tar.gz \
  assets \
  core \
  packages \
  registry \
  scripts \
  README.md
```

Neither `assets/` nor `registry/` exist in the repository. This was likely correct before the v0.10.0 restructure that consolidated into `.openpalm/`. The `tar` command will fail with "No such file or directory", causing the entire release job to fail.

**Fix:** Update to reference `.openpalm/` or remove the deploy bundle entirely if it's no longer needed.

---

## 11. Recommendations (Priority Ordered)

1. **Fix release workflow** -- Update tar bundle paths from `assets`/`registry` to `.openpalm/` (or remove the bundle). This is blocking any release.

2. **Add missing tokens to redaction schema** -- Add `DISCORD_BOT_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `STT_API_KEY`, `TTS_API_KEY`, `VLM_API_KEY` to `vault/redact.env.schema`.

3. **Restrict scheduler volumes** -- Replace `${OP_HOME}/data:/openpalm/data` with specific subdirectory mounts.

4. **Remove OP_ADMIN_TOKEN from guardian** -- Guardian doesn't need admin API access.

5. **Add varlock to scheduler** -- All services that handle secrets should have log redaction.

6. **Fix assistant Dockerfile security** -- Switch to slim base, remove `chmod 777`, add final `USER` directive.

7. **Add admin unit tests to CI** -- The 592 unit tests should run on every PR.

8. **Consolidate varlock-fetch stage** -- Extract to a shared image or build arg pattern to reduce duplication.

9. **Set `internal: true` on `assistant_net`** -- Prevent containers on the internal network from reaching the internet.

10. **Document Ollama prerequisite** -- Add a check or warning to dev-setup.sh and update CLAUDE.md.

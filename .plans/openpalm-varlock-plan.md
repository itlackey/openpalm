# Varlock Integration — Implementation Plan

**Target:** OpenPalm `0.9.0-rc10` (commit `bfee671`, 2026-03-11)
**Branch from:** `main` after the `core/` → `packages/` refactor

---

## Context

The rc10 release just landed a major structural refactor moving `core/admin` → `packages/admin` and stabilizing the e2e test flow. The secrets model is mature but entirely plaintext: `CONFIG_HOME/secrets.env` (user-owned, ADMIN_TOKEN + LLM keys) and `DATA_HOME/stack.env` (system-managed, paths/HMAC keys), both staged to `STATE_HOME/artifacts/` and passed via `--env-file` to `docker compose`.

Varlock replaces the `.env.example` → `.env` copy-and-fill pattern with a `.env.schema` that provides type validation, sensitivity annotations, and optional secret-provider resolution — all via decorator comments in a standard `.env`-shaped file. The schema is safe to commit and gives AI agents (including the OpenPalm assistant itself) full configuration context without exposing secret values.

### Why now

The rc10 refactor is a natural insertion point. The `packages/` layout is settled, the admin secrets module (`packages/admin/src/lib/server/secrets.ts`) is stable, and the two-file env model (`secrets.env` + `stack.env`) is well-defined. Adding Varlock before the 0.9.0 GA freeze means early adopters get schema validation from day one.

### Compatibility with core principles

| Principle | Compatibility |
|---|---|
| **File assembly, not rendering** | `.env.schema` is a static file — no template expansion. Varlock resolves values at runtime or via CLI, it doesn't generate config files. |
| **No string interpolation** | The schema uses decorator comments (`# @type=port`), not interpolation. Actual values stay in `.env` files. |
| **CONFIG_HOME is user-owned** | The `.env.schema` lives in the repo/assets, not CONFIG_HOME. User's `secrets.env` is untouched. |
| **Admin is sole orchestrator** | Validation runs in the admin container or at install time. No other container needs Varlock. |
| **Non-destructive lifecycle** | Varlock validates existing files; it doesn't overwrite them. |

---

## Phase 1 — Schema files (no runtime dependency)

**Effort:** ~2 hours · **Risk:** None · **Branch:** `feat/varlock-schema`

### 1.1 Create `assets/secrets.env.schema`

This replaces the current `assets/secrets.env` as the canonical schema reference. The actual `secrets.env` template (seeded by `setup.sh` and `ensureSecrets()`) remains unchanged — users still get a plain `.env` file.

```env
# OpenPalm — User Secrets Schema
# This file documents every variable in CONFIG_HOME/secrets.env.
# Safe to commit — contains no secret values.
#
# @defaultSensitive=true
# @defaultRequired=infer
# ---

# Admin API authentication token — set by the setup wizard on first boot.
# Must be at least 16 characters once configured.
# @type=string(minLength=16) @required
ADMIN_TOKEN=

# ── LLM Provider Keys ───────────────────────────────────────────────
# At least one provider key is recommended for the assistant and
# required for the memory service (embedding generation).

# @type=string(startsWith=sk-) @sensitive
OPENAI_API_KEY=

# Custom OpenAI-compatible base URL (e.g. for local Ollama/LiteLLM).
# @type=url @sensitive=false
OPENAI_BASE_URL=

# @type=string @sensitive
ANTHROPIC_API_KEY=

# @type=string @sensitive
GROQ_API_KEY=

# @type=string @sensitive
MISTRAL_API_KEY=

# @type=string @sensitive
GOOGLE_API_KEY=

# ── System LLM Configuration ────────────────────────────────────────

# Provider for system-level LLM calls (memory categorization, etc.).
# @type=enum(openai, anthropic, groq, mistral, google, ollama, litellm) @sensitive=false
SYSTEM_LLM_PROVIDER=

# Base URL for system LLM provider (if different from OPENAI_BASE_URL).
# @type=url @sensitive=false
SYSTEM_LLM_BASE_URL=

# Model name for system LLM calls.
# @type=string @sensitive=false
SYSTEM_LLM_MODEL=

# ── Embedding Configuration ─────────────────────────────────────────

# Embedding model name (e.g. text-embedding-3-small).
# @type=string @sensitive=false
EMBEDDING_MODEL=

# Embedding dimensions (must match the model).
# @type=integer(min=64, max=4096) @sensitive=false
EMBEDDING_DIMS=

# ── Memory ──────────────────────────────────────────────────────────

# User identifier for memory service. Defaults to OS username at install.
# @type=string @sensitive=false
MEMORY_USER_ID=default_user

# Auth token for memory service API. Auto-generated on first install.
# @type=string(minLength=32) @required @sensitive
MEMORY_AUTH_TOKEN=

# ── Service Auth ────────────────────────────────────────────────────

# OpenCode server password for assistant container. Auto-generated.
# @type=string(minLength=32) @required @sensitive
OPENCODE_SERVER_PASSWORD=

# ── Owner Info ──────────────────────────────────────────────────────

# @type=string @sensitive=false
OWNER_NAME=

# @type=email @sensitive=false
OWNER_EMAIL=
```

### 1.2 Create `assets/stack.env.schema`

Documents the system-managed variables in `DATA_HOME/stack.env`:

```env
# OpenPalm — Stack Environment Schema (system-managed)
# Auto-generated by the admin. Do not edit manually.
#
# @defaultSensitive=false
# @defaultRequired=true
# ---

# ── XDG Paths ───────────────────────────────────────────────────────

# @type=string(startsWith=/)
OPENPALM_CONFIG_HOME=

# @type=string(startsWith=/)
OPENPALM_DATA_HOME=

# @type=string(startsWith=/)
OPENPALM_STATE_HOME=

# @type=string(startsWith=/)
OPENPALM_WORK_DIR=

# ── Runtime Identity ────────────────────────────────────────────────

# @type=integer(min=0, max=65534)
OPENPALM_UID=1000

# @type=integer(min=0, max=65534)
OPENPALM_GID=1000

# ── Docker ──────────────────────────────────────────────────────────

# @type=string
OPENPALM_DOCKER_SOCK=/var/run/docker.sock

# ── Image Configuration ─────────────────────────────────────────────

# @type=string @sensitive=false
OPENPALM_IMAGE_NAMESPACE=openpalm

# @type=string @sensitive=false
OPENPALM_IMAGE_TAG=latest

# ── Channel HMAC Secrets ────────────────────────────────────────────
# Dynamic keys: CHANNEL_<n>_SECRET are generated per installed channel.
# @type=string(minLength=32) @sensitive
# CHANNEL_*_SECRET=
```

### 1.3 Update `assets/secrets.env`

Add a reference comment pointing to the schema:

```diff
 # OpenPalm — User Secrets
 #
+# Schema: see secrets.env.schema for variable types and validation rules.
+#
 # Place this file at CONFIG_HOME/secrets.env ...
```

### 1.4 Files touched

| File | Change |
|---|---|
| `assets/secrets.env.schema` | **New** — schema for user secrets |
| `assets/stack.env.schema` | **New** — schema for system-managed env |
| `assets/secrets.env` | Add schema reference comment |
| `docs/environment-and-mounts.md` | Add "Schema Reference" section linking to schema files |

### 1.5 Tests

No code changes — validate schemas parse correctly:

```bash
# Verify schemas are valid env-spec (once varlock is available in Phase 2)
varlock load --schema assets/secrets.env.schema --dry-run
```

---

## Phase 2A — CLI-centric validation

**Effort:** ~4 hours · **Risk:** Low · **Branch:** `feat/varlock-validate`
**Depends on:** Phase 1
**Addresses:** Part of [#206](https://github.com/itlackey/openpalm/issues/206)

### Rationale: why CLI, not setup.sh

The CLI (`packages/cli/src/main.ts`) already reimplements ~90% of `setup.sh` in its `bootstrapInstall()` function — directory creation, asset download, secrets generation, stack env, OpenCode config, Docker Compose lifecycle, health checks, and browser open. Issue #206 calls for `setup.sh` and `setup.ps1` to become thin wrappers that download the CLI binary and run `openpalm install`. Adding varlock to setup.sh now would mean writing bash + PowerShell validation blocks only to delete them when #206 lands. Instead, we add validation directly to the CLI, and the thin wrappers (Phase 2B) get it for free.

### 2A.1 Download and cache the Varlock binary

Add a `ensureVarlock()` function to the CLI that downloads and caches the varlock binary in `STATE_HOME/bin/`. This follows the same pattern the CLI already uses for fetching compose assets (`fetchAsset()` at `main.ts:176-191`).

```typescript
async function ensureVarlock(stateHome: string): Promise<string> {
  const binDir = join(stateHome, 'bin');
  const varlockBin = join(binDir, 'varlock');

  if (await Bun.file(varlockBin).exists()) {
    return varlockBin;
  }

  await mkdir(binDir, { recursive: true });
  const proc = Bun.spawn(
    ['sh', '-c', 'curl -sSfL https://varlock.dev/install.sh | sh -s -- --force-no-brew'],
    { env: { ...process.env, VARLOCK_INSTALL_DIR: binDir }, stdout: 'pipe', stderr: 'pipe' }
  );
  if ((await proc.exited) !== 0) {
    throw new Error('Failed to install varlock CLI');
  }

  return varlockBin;
}
```

**Key design decisions:**

- Varlock binary lives in `STATE_HOME/bin/` — it's a system tool, not user config, and can be overwritten on updates.
- Downloaded once, reused on subsequent installs/updates.
- Uses subprocess (`Bun.spawn`) with argument arrays, consistent with how the CLI already calls `docker compose`.

### 2A.2 Add `openpalm validate` command

Add a new `validate` command to the CLI that runs `varlock load` against the user's env files:

```typescript
async function runValidate(): Promise<void> {
  const stateHome = defaultStateHome();
  const configHome = defaultConfigHome();
  const varlockBin = await ensureVarlock(stateHome);

  const schemaPath = join(stateHome, 'artifacts', 'secrets.env.schema');
  const envPath = join(configHome, 'secrets.env');

  const proc = Bun.spawn(
    [varlockBin, 'load', '--schema', schemaPath, '--env-file', envPath],
    { stdout: 'inherit', stderr: 'inherit' }
  );
  const code = await proc.exited;
  if (code !== 0) {
    console.error('Validation found issues. See output above.');
    process.exit(code);
  }
  console.log('Configuration validated successfully.');
}
```

This gives users a standalone `openpalm validate` command they can run any time.

### 2A.3 Integrate validation into `bootstrapInstall()`

In the CLI's `bootstrapInstall()` flow, call validation after `ensureSecrets()` — **non-fatal** on first install (the setup wizard hasn't run yet, so `ADMIN_TOKEN` is intentionally blank):

```typescript
// After ensureSecrets(configHome) and ensureStackEnv(...)
try {
  const varlockBin = await ensureVarlock(stateHome);
  const proc = Bun.spawn(
    [varlockBin, 'load', '--schema', join(stateHome, 'artifacts', 'secrets.env.schema'),
     '--env-file', join(configHome, 'secrets.env'), '--quiet'],
    { stdout: 'pipe', stderr: 'pipe' }
  );
  if ((await proc.exited) === 0) {
    console.log('Configuration validated.');
  } else {
    console.warn('Configuration has validation warnings (non-fatal on first install).');
  }
} catch {
  // Varlock install may fail on some systems — non-blocking
}
```

### 2A.4 Stage schema files alongside other assets

In `bootstrapInstall()`, download and stage the `.env.schema` files to `STATE_HOME/artifacts/` using the existing `fetchAsset()` pattern:

```typescript
// After downloading docker-compose.yml and Caddyfile
const secretsSchema = await fetchAsset(options.version, 'secrets.env.schema');
const stackSchema = await fetchAsset(options.version, 'stack.env.schema');
await Bun.write(join(stateHome, 'artifacts', 'secrets.env.schema'), secretsSchema);
await Bun.write(join(stateHome, 'artifacts', 'stack.env.schema'), stackSchema);
```

Also add the schemas to `core-assets.ts` so the admin stages them during apply:

In `packages/admin/src/lib/server/core-assets.ts`, add the two `.env.schema` files to the `MANAGED_ASSETS` list and add Vite raw imports for the bundled schemas.

### 2A.5 Files touched

| File | Change |
|---|---|
| `packages/cli/src/main.ts` | Add `ensureVarlock()`, `runValidate()`, integrate into `bootstrapInstall()`, stage schema assets |
| `packages/cli/src/main.test.ts` | Tests for validate command and schema staging |
| `packages/admin/src/lib/server/core-assets.ts` | Add `.env.schema` files to `MANAGED_ASSETS` + Vite imports |

### 2A.6 Tests

- CLI unit test: `openpalm validate` with valid fixture → exit 0
- CLI unit test: `openpalm validate` with missing required var → exit non-zero
- CLI unit test: `openpalm install --no-start` stages schema files to `STATE_HOME/artifacts/`
- `scripts/dev-e2e-test.sh` — verify validation runs in the install flow

---

## Phase 2B — CLI binary distribution and thin wrapper migration

**Effort:** ~6 hours · **Risk:** Low · **Branch:** `feat/cli-binary`
**Depends on:** Phase 2A
**Closes:** [#206](https://github.com/itlackey/openpalm/issues/206)

### Rationale

Issue #206 calls for `setup.sh` and `setup.ps1` to become thin wrappers that download the CLI binary and run `openpalm install`. This eliminates the duplicated install logic between the shell scripts and the CLI, and gives all platforms a single code path with varlock validation built in (Phase 2A).

The CLI is already Bun-based. Bun's `bun build --compile` produces self-contained, zero-dependency executables for Linux (x64, arm64), macOS (x64, arm64), and Windows (x64). Users don't need Bun installed — the binary is all they need.

### 2B.1 Add CI build step for standalone binaries

Add a GitHub Actions workflow (or extend the existing release workflow) that compiles platform-specific binaries:

```yaml
# .github/workflows/cli-release.yml
name: CLI Release
on:
  push:
    tags: ['v*']

jobs:
  build:
    strategy:
      matrix:
        include:
          - os: ubuntu-latest
            target: bun-linux-x64
            artifact: openpalm-linux-x64
          - os: ubuntu-latest
            target: bun-linux-arm64
            artifact: openpalm-linux-arm64
          - os: macos-latest
            target: bun-darwin-x64
            artifact: openpalm-darwin-x64
          - os: macos-latest
            target: bun-darwin-arm64
            artifact: openpalm-darwin-arm64
          - os: windows-latest
            target: bun-windows-x64
            artifact: openpalm-windows-x64.exe
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun build --compile --target=${{ matrix.target }} packages/cli/src/main.ts --outfile ${{ matrix.artifact }}
      - uses: softprops/action-gh-release@v2
        with:
          files: ${{ matrix.artifact }}
```

### 2B.2 Refactor `scripts/setup.sh` to thin wrapper

Replace the ~430-line `setup.sh` with a thin wrapper (~40 lines) that:
1. Detects platform and architecture
2. Downloads the correct `openpalm` binary from GitHub releases
3. Makes it executable and places it in `STATE_HOME/bin/` (or `~/.local/bin/`)
4. Runs `openpalm install "$@"` (passing through all flags)

```bash
#!/usr/bin/env bash
# OpenPalm — Setup Script (thin wrapper)
# Downloads the openpalm CLI binary and runs `openpalm install`.
set -euo pipefail

VERSION="${OPENPALM_VERSION:-v0.9.0-rc12}"
REPO="itlackey/openpalm"
INSTALL_DIR="${OPENPALM_INSTALL_DIR:-${HOME}/.local/bin}"

die() { printf '\033[0;31m✗\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[0;34m▸\033[0m %s\n' "$*"; }

# ── Platform detection ────────────────────────────────────────────
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)   BINARY="openpalm-linux-x64" ;;
  Linux-aarch64)  BINARY="openpalm-linux-arm64" ;;
  Darwin-x86_64)  BINARY="openpalm-darwin-x64" ;;
  Darwin-arm64)   BINARY="openpalm-darwin-arm64" ;;
  *) die "Unsupported platform: $(uname -s) $(uname -m)" ;;
esac

# ── Download CLI binary ──────────────────────────────────────────
DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${VERSION}/${BINARY}"
mkdir -p "$INSTALL_DIR"
info "Downloading openpalm CLI (${VERSION})..."
curl -fsSL --retry 2 -o "${INSTALL_DIR}/openpalm" "$DOWNLOAD_URL" \
  || die "Failed to download CLI binary. Check network and version."
chmod +x "${INSTALL_DIR}/openpalm"

# ── Run install ──────────────────────────────────────────────────
info "Running openpalm install..."
exec "${INSTALL_DIR}/openpalm" install "$@"
```

### 2B.3 Refactor `scripts/setup.ps1` to thin wrapper

Same pattern in PowerShell — download the Windows binary and run `openpalm install`.

### 2B.4 Add host system detection to the CLI

Per issue #206, extend the CLI installer to gather host system info and export to `DATA_HOME/host.json`:

```typescript
interface HostInfo {
  platform: string;
  arch: string;
  docker: { installed: boolean; running: boolean; modelRunner?: boolean };
  ollama: { running: boolean; url?: string };
  lmstudio: { running: boolean; url?: string };
  llamacpp: { running: boolean; url?: string };
  timestamp: string;
}

async function detectHostInfo(): Promise<HostInfo> {
  // Detect Docker
  const dockerInstalled = !!Bun.which('docker');
  const dockerRunning = dockerInstalled && (await Bun.spawn(['docker', 'info'], { stdout: 'ignore', stderr: 'ignore' }).exited) === 0;

  // Detect Ollama — probe http://localhost:11434/api/tags
  let ollamaRunning = false;
  try {
    const res = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(2000) });
    ollamaRunning = res.ok;
  } catch {}

  // Detect LM Studio — probe http://localhost:1234/v1/models
  let lmstudioRunning = false;
  try {
    const res = await fetch('http://localhost:1234/v1/models', { signal: AbortSignal.timeout(2000) });
    lmstudioRunning = res.ok;
  } catch {}

  // Detect llama.cpp — probe http://localhost:8080/health
  let llamacppRunning = false;
  try {
    const res = await fetch('http://localhost:8080/health', { signal: AbortSignal.timeout(2000) });
    llamacppRunning = res.ok;
  } catch {}

  return {
    platform: process.platform,
    arch: process.arch,
    docker: { installed: dockerInstalled, running: dockerRunning },
    ollama: { running: ollamaRunning, url: ollamaRunning ? 'http://localhost:11434' : undefined },
    lmstudio: { running: lmstudioRunning, url: lmstudioRunning ? 'http://localhost:1234' : undefined },
    llamacpp: { running: llamacppRunning, url: llamacppRunning ? 'http://localhost:8080' : undefined },
    timestamp: new Date().toISOString(),
  };
}
```

Call `detectHostInfo()` during `bootstrapInstall()` and write the result to `DATA_HOME/host.json`. The admin/setup wizard can read this to present model runner options.

### 2B.5 Files touched

| File | Change |
|---|---|
| `.github/workflows/cli-release.yml` | **New** — CI workflow to compile and publish CLI binaries |
| `scripts/setup.sh` | **Rewrite** — thin wrapper (~40 lines, was ~430) |
| `scripts/setup.ps1` | **Rewrite** — thin wrapper (PowerShell equivalent) |
| `packages/cli/src/main.ts` | Add `detectHostInfo()`, write `host.json` during install |
| `packages/cli/src/main.test.ts` | Tests for host detection |
| `docs/installation.md` | Update install instructions for CLI-first flow |

### 2B.6 Tests

- CI: verify binaries compile for all platform targets
- CI: verify `openpalm install --no-start` on a fresh runner produces correct directory tree + `host.json`
- Unit test: `detectHostInfo()` returns valid structure (mock fetch for service probes)
- Manual: run thin-wrapper `setup.sh` on clean Linux/macOS, verify full install completes

---

## Phase 3 — Admin-side runtime validation

**Effort:** ~6 hours · **Risk:** Low-Medium · **Branch:** `feat/varlock-admin`
**Depends on:** Phase 2A

### 3.1 Install Varlock in the admin Docker image

In `core/admin/Dockerfile`, add a build stage that downloads the Varlock binary:

```dockerfile
# ── Varlock CLI ─────────────────────────────────────────────────────
RUN curl -sSfL https://varlock.dev/install.sh | sh -s -- --force-no-brew \
    && ln -s /root/.varlock/bin/varlock /usr/local/bin/varlock
```

This is the **only** container that gets Varlock. Per the principle that admin is the sole orchestrator, the admin validates config on behalf of the stack.

### 3.2 Add validation to the admin startup/apply flow

In the admin's lifecycle module (`packages/admin/src/lib/server/lifecycle.ts`), add a `validateEnvironment()` step that runs during apply:

```typescript
import { execFile } from 'node:child_process';

export async function validateEnvironment(state: ControlPlaneState): Promise<{
  ok: boolean;
  errors: string[];
  warnings: string[];
}> {
  const schemaPath = `${state.stateDir}/artifacts/secrets.env.schema`;
  const envPath = `${state.configDir}/secrets.env`;

  // Run varlock load in quiet mode and capture output
  return new Promise((resolve) => {
    execFile('varlock', ['load', '--schema', schemaPath, '--env-file', envPath], 
      { timeout: 10000 },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ ok: true, errors: [], warnings: [] });
        } else {
          // Parse varlock's structured error output
          const lines = stderr.split('\n').filter(Boolean);
          resolve({
            ok: false,
            errors: lines.filter(l => l.includes('ERROR')),
            warnings: lines.filter(l => l.includes('WARN')),
          });
        }
      });
  });
}
```

**Note:** Uses `execFile` with argument arrays per AGENTS.md ("No shell interpolation").

### 3.3 Surface validation in the admin API

Add a `GET /admin/config/validate` endpoint that returns the validation result. The admin UI can call this to show config health:

```typescript
// packages/admin/src/routes/admin/config/validate/+server.ts
export const GET: RequestHandler = async (event) => {
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const result = await validateEnvironment(getState());
  return json(result);
};
```

### 3.4 Add validation to health check cron

In the system maintenance cron (which already runs health checks and auto-restarts), add a `varlock load --quiet` step. If validation fails, log a warning to the audit trail but don't block services.

### 3.5 Files touched

| File | Change |
|---|---|
| `core/admin/Dockerfile` | Add Varlock binary install |
| `packages/admin/src/lib/server/lifecycle.ts` | Add `validateEnvironment()` |
| `packages/admin/src/routes/admin/config/validate/+server.ts` | **New** — validation API endpoint |
| `docs/api-spec.md` | Document new endpoint |
| `assets/cleanup-data.yml` or system cron | Add periodic validation check |

### 3.6 Tests

- Unit test for `validateEnvironment()` with valid/invalid env fixtures
- E2E: hit `GET /admin/config/validate` with a valid config → `{ ok: true }`
- E2E: hit with missing `ADMIN_TOKEN` → `{ ok: false, errors: [...] }`

---

## Phase 4 — AI-safe config for the assistant

**Effort:** ~2 hours · **Risk:** None · **Branch:** `feat/varlock-ai-safe`
**Depends on:** Phase 1

### 4.1 Make schema readable by the assistant

The assistant already has read access to `CONFIG_HOME/assistant/` for user extensions. Add the `.env.schema` file to the assistant's readable context so the OpenCode agent can reason about configuration without seeing secret values.

In `assets/opencode.jsonc` (the baked-in OpenCode config), add a context rule or skill that references the schema:

```jsonc
{
  // existing config...
  "context": {
    "include": [
      // ... existing patterns
      "/etc/opencode/env-schema/**"
    ]
  }
}
```

Then in the admin apply flow, copy the schema files to `DATA_HOME/assistant/env-schema/`:

```
DATA_HOME/assistant/env-schema/secrets.env.schema
DATA_HOME/assistant/env-schema/stack.env.schema
```

The assistant can now read `# @type=string(startsWith=sk-) @sensitive OPENAI_API_KEY=` and understand the configuration structure without ever seeing `sk-proj-abc123...`.

### 4.2 Add an assistant skill for config diagnostics

Create a skill in `core/assistant/` (the baked-in skills directory) that teaches the assistant to use `varlock load` output for troubleshooting:

```markdown
# Config Diagnostics Skill

When a user asks about configuration issues, connection problems, or
missing API keys, use the admin API to check config health:

1. Call GET /admin/config/validate to get validation results
2. Read the .env.schema files for variable descriptions and types
3. Never read, echo, or expose actual .env file contents
4. Guide the user to fix issues via the admin UI or direct file edits
```

### 4.3 Files touched

| File | Change |
|---|---|
| `assets/opencode.jsonc` | Add env-schema context include |
| `packages/admin/src/lib/server/staging.ts` | Stage schema files to `DATA_HOME/assistant/env-schema/` |
| `core/assistant/skills/config-diagnostics.md` | **New** — assistant skill for config troubleshooting |

---

## Phase 5 — Leak scanning (pre-commit)

**Effort:** ~2 hours · **Risk:** None · **Branch:** `feat/varlock-scan`
**Depends on:** Phase 1

### 5.1 Add `varlock scan` to the contributor workflow

In `.github/workflows/ci.yml`, add a step that runs `varlock scan` against the repo to catch any accidentally committed secrets:

```yaml
- name: Scan for leaked secrets
  run: |
    curl -sSfL https://varlock.dev/install.sh | sh -s -- --force-no-brew
    ~/.varlock/bin/varlock scan --schema assets/secrets.env.schema
```

### 5.2 Document pre-commit hook setup

In `docs/CONTRIBUTING.md`, add instructions for contributors to set up local pre-commit scanning:

```bash
# Install varlock
curl -sSfL https://varlock.dev/install.sh | sh -s
# Set up pre-commit hook
varlock scan --setup-hook
```

### 5.3 Files touched

| File | Change |
|---|---|
| `.github/workflows/ci.yml` | Add `varlock scan` step |
| `docs/CONTRIBUTING.md` | Add pre-commit hook setup instructions |

---

## Phase 6 — Optional secret provider plugins (future)

**Effort:** ~8 hours · **Risk:** Medium · **Branch:** `feat/varlock-providers`
**Depends on:** Phase 3

This phase is **post-GA** and opt-in only. It enables advanced users to pull secrets from external providers instead of plaintext `.env` files.

### 6.1 Azure Key Vault integration

For your own deployments and Azure-savvy users, the Varlock Azure Key Vault plugin resolves secrets at boot time:

```env
# @plugin(@varlock/azure-keyvault-plugin)
# @initAzure(vaultUrl=$AZURE_VAULT_URL)
# ---
ADMIN_TOKEN=azSecret("openpalm-admin-token")
OPENAI_API_KEY=azSecret("openpalm-openai-key")
```

**Integration point:** The admin container already runs `varlock` (Phase 3). To enable provider resolution, the admin would run `varlock run -- <apply-command>` instead of the plain apply, injecting resolved secrets into the compose environment.

**Critical constraint:** Provider authentication (e.g., Azure CLI login, service principal credentials) happens host-side or via a single bootstrap env var (`AZURE_VAULT_URL`). The admin container gets this one credential; everything else comes from the vault. This preserves the "secrets never in plaintext on disk" property.

### 6.2 1Password / Bitwarden support

Same pattern — self-hosters who use 1Password or Bitwarden install the respective plugin and reference secrets by vault path. The admin resolves them at apply time.

### 6.3 Documentation

A new `docs/secret-providers.md` guide explaining how to migrate from plaintext `.env` to provider-backed secrets, with concrete examples for Azure Key Vault and 1Password.

---

## Implementation order and milestones

```
Phase 1 ──────────► Phase 4 (AI-safe config)
   │
   │                Phase 5 (leak scanning)
   │
   ▼
Phase 2A ─────────► Phase 3 ──────────► Phase 6 (post-GA)
(CLI validation)    (admin runtime)      (provider plugins)
   │
   ▼
Phase 2B
(CLI binary +
 thin wrappers +
 host detection)
 Closes #206
```

**Phases 1, 4, 5** are independent and can land in parallel — they're schema-only changes with zero runtime impact.

**Phase 2A** adds the first runtime dependency (varlock binary in the CLI's install flow). Validation lives in one place (TypeScript) instead of being duplicated across bash and PowerShell.

**Phase 2B** compiles the CLI to standalone binaries via `bun build --compile`, rewrites the setup scripts as thin wrappers, and adds host system detection per [#206](https://github.com/itlackey/openpalm/issues/206). This is a prerequisite for GA — end users should not need Bun installed to run `openpalm install`.

**Phase 3** is the meatiest change (varlock in admin container + validation API).

**Phase 6** is post-GA and entirely opt-in.

### Suggested merge targets

| Phase | Target milestone | Blocking? |
|---|---|---|
| 1 — Schema files | `0.9.0-rc11` | No — documentation only |
| 4 — AI-safe config | `0.9.0-rc11` | No — assistant DX improvement |
| 5 — Leak scanning | `0.9.0-rc11` | No — CI improvement |
| 2A — CLI validation | `0.9.0-rc12` | No — non-fatal warnings only |
| 2B — CLI binary + thin wrappers | `0.9.0-rc12` | **Yes — prerequisite for GA** (users need standalone binary) |
| 3 — Admin validation | `0.9.0` GA | No — defense-in-depth |
| 6 — Provider plugins | `0.10.0` | No — opt-in power feature |

---

## What this does NOT change

- The `secrets.env` + `stack.env` two-file model stays exactly as is.
- The CLI still generates plaintext credentials into `secrets.env` (same logic, now in one place instead of duplicated between bash and TypeScript).
- Docker Compose still receives env files via `--env-file` flags.
- No containers other than admin get Varlock.
- No Varlock binary is required for end users unless they opt into provider plugins.
- The "file assembly, not rendering" principle is preserved throughout.

The schema files are additive documentation that happen to be machine-parseable. The validation is defense-in-depth that catches misconfigurations early. The AI-safe config is a natural extension of the existing "secret protection" security layer. Everything is backward-compatible — a user on rc10 can upgrade to a varlock-enabled version with zero changes to their existing `secrets.env`.

## What this DOES change beyond the original Varlock scope

Phase 2B incorporates [#206](https://github.com/itlackey/openpalm/issues/206) (CLI-first installation). This is a natural companion because:

1. **No wasted work.** Adding varlock to `setup.sh` only to rewrite the script a release later would double the effort.
2. **Single code path.** All install logic (directory creation, asset download, secrets generation, varlock validation, host detection) lives in `packages/cli/src/main.ts`. No bash/PowerShell/TypeScript triplication.
3. **Standalone binary.** `bun build --compile` produces zero-dependency executables for Linux, macOS, and Windows. Users don't need Bun, Node, or any runtime — just the binary.
4. **Host detection.** The CLI probes for Docker, Ollama, LM Studio, and llama.cpp, writing `DATA_HOME/host.json` so the admin/setup wizard can present model runner options intelligently.

The thin-wrapper `setup.sh` drops from ~430 lines to ~40 lines: detect platform, download binary, run `openpalm install`.

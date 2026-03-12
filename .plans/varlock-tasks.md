# Varlock + CLI Migration — Task Breakdown

> Derived from [openpalm-varlock-plan.md](./openpalm-varlock-plan.md)
> Each task is self-contained and assignable to an agent.
> Tasks within the same phase can run in parallel unless noted.

---

## Legend

| Field | Meaning |
|---|---|
| **Status** | `pending` · `in_progress` · `completed` · `blocked` |
| **Depends** | Task IDs that must complete first |
| **Agent** | Suggested agent type or skill set |
| **Branch** | Git branch to work on |

---

## Phase 1 — Schema files (no runtime dependency)

**Branch:** `feat/varlock-schema` · **Milestone:** `0.9.0-rc11`

These three tasks have no dependencies and can run in parallel.

### P1-T1: Create `assets/secrets.env.schema`

| | |
|---|---|
| **Status** | `pending` |
| **Depends** | None |
| **Agent** | general-purpose |
| **Files** | `assets/secrets.env.schema` (new) |

**Description:**
Create the Varlock schema file for user secrets (`CONFIG_HOME/secrets.env`). The schema documents every variable with `# @type`, `# @sensitive`, and `# @required` decorator comments. Contains no secret values — safe to commit.

**Acceptance criteria:**
- File exists at `assets/secrets.env.schema`
- Covers all variables currently in `assets/secrets.env`: `ADMIN_TOKEN`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, `GOOGLE_API_KEY`, `SYSTEM_LLM_PROVIDER`, `SYSTEM_LLM_BASE_URL`, `SYSTEM_LLM_MODEL`, `EMBEDDING_MODEL`, `EMBEDDING_DIMS`, `MEMORY_USER_ID`, `MEMORY_AUTH_TOKEN`, `OPENCODE_SERVER_PASSWORD`, `OWNER_NAME`, `OWNER_EMAIL`
- File header includes `# @defaultSensitive=true` and `# @defaultRequired=infer`
- Each variable has appropriate `@type`, `@sensitive`, and `@required` annotations
- Content matches the schema spec in the plan (section 1.1)

---

### P1-T2: Create `assets/stack.env.schema`

| | |
|---|---|
| **Status** | `pending` |
| **Depends** | None |
| **Agent** | general-purpose |
| **Files** | `assets/stack.env.schema` (new) |

**Description:**
Create the Varlock schema file for system-managed environment (`DATA_HOME/stack.env`). Documents XDG paths, runtime identity, Docker socket, image configuration, and channel HMAC secrets.

**Acceptance criteria:**
- File exists at `assets/stack.env.schema`
- Covers: `OPENPALM_CONFIG_HOME`, `OPENPALM_DATA_HOME`, `OPENPALM_STATE_HOME`, `OPENPALM_WORK_DIR`, `OPENPALM_UID`, `OPENPALM_GID`, `OPENPALM_DOCKER_SOCK`, `OPENPALM_IMAGE_NAMESPACE`, `OPENPALM_IMAGE_TAG`, `CHANNEL_*_SECRET`
- File header includes `# @defaultSensitive=false` and `# @defaultRequired=true`
- Content matches the schema spec in the plan (section 1.2)

---

### P1-T3: Update `assets/secrets.env` with schema reference

| | |
|---|---|
| **Status** | `pending` |
| **Depends** | None |
| **Agent** | general-purpose |
| **Files** | `assets/secrets.env` (edit) |

**Description:**
Add a comment to `assets/secrets.env` pointing users to the schema file for variable types and validation rules.

**Acceptance criteria:**
- `assets/secrets.env` contains a comment line: `# Schema: see secrets.env.schema for variable types and validation rules.`
- No other changes to the file
- Existing variable definitions and comments are untouched

---

### P1-T4: Update environment documentation

| | |
|---|---|
| **Status** | `pending` |
| **Depends** | P1-T1, P1-T2 |
| **Agent** | documentation-writer |
| **Files** | `docs/environment-and-mounts.md` (edit) |

**Description:**
Add a "Schema Reference" section to `docs/environment-and-mounts.md` linking to the two `.env.schema` files and explaining their purpose (machine-parseable documentation, safe to commit, used by Varlock for validation).

**Acceptance criteria:**
- New section titled "Schema Reference" exists in the doc
- Links to `assets/secrets.env.schema` and `assets/stack.env.schema`
- Brief explanation of Varlock decorator syntax (`@type`, `@sensitive`, `@required`)
- Does not duplicate the full schema content (links only)

---

## Phase 2A — CLI-centric validation

**Branch:** `feat/varlock-validate` · **Milestone:** `0.9.0-rc12`

### P2A-T1: Add `ensureVarlock()` to CLI

| | |
|---|---|
| **Status** | `pending` |
| **Depends** | P1-T1 |
| **Agent** | bunjs-typescript-coder |
| **Files** | `packages/cli/src/main.ts` (edit) |

**Description:**
Add an `ensureVarlock()` function that downloads and caches the varlock binary in `STATE_HOME/bin/`. Uses `Bun.spawn` to run the varlock install script with `VARLOCK_INSTALL_DIR` set to the target directory. Returns the path to the cached binary. Skips download if binary already exists.

**Acceptance criteria:**
- `ensureVarlock(stateHome: string): Promise<string>` function exists
- Downloads varlock via `curl -sSfL https://varlock.dev/install.sh | sh -s -- --force-no-brew`
- Caches binary at `STATE_HOME/bin/varlock`
- Returns path to binary
- Skips download if `STATE_HOME/bin/varlock` already exists
- Uses `Bun.spawn` with argument arrays (no shell string interpolation)
- Throws descriptive error on download failure

---

### P2A-T2: Add `openpalm validate` command

| | |
|---|---|
| **Status** | `pending` |
| **Depends** | P2A-T1 |
| **Agent** | bunjs-typescript-coder |
| **Files** | `packages/cli/src/main.ts` (edit) |

**Description:**
Add a `validate` command to the CLI that runs `varlock load --schema <schema> --env-file <env>` and surfaces results. Register it in the `COMMANDS` array, `printUsage()`, and the main command dispatch.

**Acceptance criteria:**
- `openpalm validate` runs varlock validation against `secrets.env`
- Exits 0 on valid config, non-zero on validation errors
- Prints human-readable output (inherits stdout/stderr from varlock)
- Registered in `COMMANDS` type, `printUsage()`, and `main()` dispatch
- Calls `ensureVarlock()` to ensure binary is available

---

### P2A-T3: Integrate validation into `bootstrapInstall()`

| | |
|---|---|
| **Status** | `pending` |
| **Depends** | P2A-T1 |
| **Agent** | bunjs-typescript-coder |
| **Files** | `packages/cli/src/main.ts` (edit) |

**Description:**
In `bootstrapInstall()`, after `ensureSecrets()` and `ensureStackEnv()`, call varlock validation in **non-fatal** mode. Wrap in try/catch so varlock install failures don't block the install flow.

**Acceptance criteria:**
- Validation runs after secrets and stack env are generated
- Uses `--quiet` flag for non-verbose output
- Success prints: `Configuration validated.`
- Failure prints warning: `Configuration has validation warnings (non-fatal on first install).`
- Varlock download/execution failures are caught and silently ignored
- Install flow is never blocked by validation failures

---

### P2A-T4: Stage `.env.schema` files in CLI install

| | |
|---|---|
| **Status** | `pending` |
| **Depends** | P1-T1, P1-T2 |
| **Agent** | bunjs-typescript-coder |
| **Files** | `packages/cli/src/main.ts` (edit) |

**Description:**
In `bootstrapInstall()`, download `secrets.env.schema` and `stack.env.schema` via `fetchAsset()` and write them to `STATE_HOME/artifacts/` alongside the existing compose and env files.

**Acceptance criteria:**
- `secrets.env.schema` downloaded and written to `STATE_HOME/artifacts/secrets.env.schema`
- `stack.env.schema` downloaded and written to `STATE_HOME/artifacts/stack.env.schema`
- Uses existing `fetchAsset()` function (tries release URL, falls back to raw)
- Downloads happen alongside existing `docker-compose.yml` and `Caddyfile` downloads

---

### P2A-T5: Add schemas to admin `core-assets.ts`

| | |
|---|---|
| **Status** | `pending` |
| **Depends** | P1-T1, P1-T2 |
| **Agent** | bunjs-typescript-coder |
| **Files** | `packages/admin/src/lib/server/core-assets.ts` (edit) |

**Description:**
Add Vite raw imports for `secrets.env.schema` and `stack.env.schema` from `$assets/`. Add them to the `MANAGED_ASSETS` array so the admin stages them to `DATA_HOME` during `refreshCoreAssets()`. Also create `ensureSchema()` functions following the same pattern as `ensureCoreCaddyfile()`.

**Acceptance criteria:**
- Two new `$assets/` imports: `secretsSchemaAsset` and `stackSchemaAsset`
- Both added to `MANAGED_ASSETS` with `dataRelPath` and `githubFilename`
- Schema files are staged to `DATA_HOME` during `refreshCoreAssets()`
- Follows existing write-if-changed + backup pattern

---

### P2A-T6: CLI validation tests

| | |
|---|---|
| **Status** | `pending` |
| **Depends** | P2A-T2, P2A-T3, P2A-T4 |
| **Agent** | bunjs-typescript-coder |
| **Files** | `packages/cli/src/main.test.ts` (edit) |

**Description:**
Add tests for the validate command, schema staging, and install-time validation.

**Acceptance criteria:**
- Test: `openpalm validate` with valid env fixture exits 0
- Test: `openpalm validate` with missing required var exits non-zero
- Test: `bootstrapInstall()` with `--no-start` stages `.env.schema` files to artifacts
- Tests mock `Bun.spawn` for varlock calls (don't require actual varlock binary)
- All tests pass with `bun test packages/cli/`

---

## Phase 2B — CLI binary distribution and thin wrapper migration

**Branch:** `feat/cli-binary` · **Milestone:** `0.9.0-rc12`

### P2B-T1: Create CLI release workflow

| | |
|---|---|
| **Status** | `pending` |
| **Depends** | P2A-T2 |
| **Agent** | general-purpose |
| **Files** | `.github/workflows/cli-release.yml` (new) |

**Description:**
Create a GitHub Actions workflow that compiles the CLI to standalone binaries for all supported platforms using `bun build --compile`. Trigger on version tags (`v*`). Upload binaries to the GitHub release.

**Target platforms:**

| OS | Arch | Binary name | Bun target |
|---|---|---|---|
| Linux | x64 | `openpalm-linux-x64` | `bun-linux-x64` |
| Linux | arm64 | `openpalm-linux-arm64` | `bun-linux-arm64` |
| macOS | x64 | `openpalm-darwin-x64` | `bun-darwin-x64` |
| macOS | arm64 | `openpalm-darwin-arm64` | `bun-darwin-arm64` |
| Windows | x64 | `openpalm-windows-x64.exe` | `bun-windows-x64` |

**Acceptance criteria:**
- Workflow file at `.github/workflows/cli-release.yml`
- Triggers on `push.tags: ['v*']`
- Uses `oven-sh/setup-bun@v2` action
- Compiles with `bun build --compile --target=<target> packages/cli/src/main.ts --outfile <artifact>`
- Uploads all binaries to GitHub release using `softprops/action-gh-release@v2`
- Matrix strategy covers all 5 platform/arch combinations

---

### P2B-T2: Add `detectHostInfo()` to CLI

| | |
|---|---|
| **Status** | `pending` |
| **Depends** | None (can start immediately) |
| **Agent** | bunjs-typescript-coder |
| **Files** | `packages/cli/src/main.ts` (edit) |

**Description:**
Add host system detection per issue #206. Probes for Docker, Ollama, LM Studio, and llama.cpp. Returns a `HostInfo` object.

**Detection targets:**
- Docker: `Bun.which('docker')` + `docker info` exit code
- Ollama: HTTP probe `http://localhost:11434/api/tags` (2s timeout)
- LM Studio: HTTP probe `http://localhost:1234/v1/models` (2s timeout)
- llama.cpp: HTTP probe `http://localhost:8080/health` (2s timeout)

**Acceptance criteria:**
- `HostInfo` interface defined with `platform`, `arch`, `docker`, `ollama`, `lmstudio`, `llamacpp`, `timestamp`
- `detectHostInfo(): Promise<HostInfo>` function implemented
- All HTTP probes use `AbortSignal.timeout(2000)` and catch failures silently
- Docker detection uses `Bun.which` + `Bun.spawn` (no shell strings)

---

### P2B-T3: Write `host.json` during install

| | |
|---|---|
| **Status** | `pending` |
| **Depends** | P2B-T2 |
| **Agent** | bunjs-typescript-coder |
| **Files** | `packages/cli/src/main.ts` (edit) |

**Description:**
Call `detectHostInfo()` during `bootstrapInstall()` and write the result to `DATA_HOME/host.json`. This file is read by the admin/setup wizard to present model runner options.

**Acceptance criteria:**
- `detectHostInfo()` called during `bootstrapInstall()` (after directory creation, before Docker Compose)
- Result written to `DATA_HOME/host.json` as formatted JSON
- File is overwritten on every install/update (it captures current system state)
- Non-fatal: if detection fails, install continues without `host.json`

---

### P2B-T4: Rewrite `scripts/setup.sh` as thin wrapper

| | |
|---|---|
| **Status** | `pending` |
| **Depends** | P2B-T1 |
| **Agent** | general-purpose |
| **Files** | `scripts/setup.sh` (rewrite) |

**Description:**
Replace the ~430-line `setup.sh` with a ~40-line thin wrapper that: detects platform/arch, downloads the correct `openpalm` binary from GitHub releases, makes it executable, and runs `openpalm install "$@"`.

**Acceptance criteria:**
- Script detects OS (`uname -s`) and arch (`uname -m`)
- Maps to correct binary name (e.g., `Linux-x86_64` → `openpalm-linux-x64`)
- Downloads from `https://github.com/itlackey/openpalm/releases/download/${VERSION}/${BINARY}`
- Installs binary to `${OPENPALM_INSTALL_DIR:-${HOME}/.local/bin}/openpalm`
- Passes through all arguments to `openpalm install`
- Uses `exec` for the final command (replaces shell process)
- Supports `OPENPALM_VERSION` env var override (default: latest release tag)
- Error messages use colored output matching current style
- Script is under 50 lines

---

### P2B-T5: Rewrite `scripts/setup.ps1` as thin wrapper

| | |
|---|---|
| **Status** | `pending` |
| **Depends** | P2B-T1 |
| **Agent** | general-purpose |
| **Files** | `scripts/setup.ps1` (rewrite) |

**Description:**
Same pattern as the bash wrapper but in PowerShell. Downloads the Windows binary and runs `openpalm install`.

**Acceptance criteria:**
- Detects Windows x64 architecture
- Downloads `openpalm-windows-x64.exe` from GitHub releases
- Places binary in `$env:LOCALAPPDATA\openpalm\bin\` (or user-configurable path)
- Passes through all arguments to `openpalm install`
- Supports `$env:OPENPALM_VERSION` override
- Error handling with descriptive messages

---

### P2B-T6: Host detection tests

| | |
|---|---|
| **Status** | `pending` |
| **Depends** | P2B-T2, P2B-T3 |
| **Agent** | bunjs-typescript-coder |
| **Files** | `packages/cli/src/main.test.ts` (edit) |

**Description:**
Add tests for `detectHostInfo()` and `host.json` generation.

**Acceptance criteria:**
- Test: `detectHostInfo()` returns valid `HostInfo` structure
- Test: `platform` and `arch` match `process.platform` and `process.arch`
- Test: HTTP probes handle connection refused gracefully (set `running: false`)
- Test: `host.json` is written during `bootstrapInstall()` with `--no-start`
- Tests mock `fetch` and `Bun.spawn` for service probes
- All tests pass with `bun test packages/cli/`

---

### P2B-T7: Update installation documentation

| | |
|---|---|
| **Status** | `pending` |
| **Depends** | P2B-T4, P2B-T5 |
| **Agent** | documentation-writer |
| **Files** | `docs/installation.md` (edit or new) |

**Description:**
Update installation docs to reflect the CLI-first flow. The one-liner curl install stays the same from the user's perspective, but the docs should explain that the script downloads a standalone binary.

**Acceptance criteria:**
- One-liner install command documented (curl pipe to bash)
- Explains that no Bun/Node runtime is needed
- Documents `OPENPALM_VERSION` env var for version pinning
- Documents `OPENPALM_INSTALL_DIR` for custom binary location
- Documents `openpalm validate` command
- Documents `host.json` output and what the admin reads from it

---

## Phase 3 — Admin-side runtime validation

**Branch:** `feat/varlock-admin` · **Milestone:** `0.9.0` GA

### P3-T1: Install Varlock in admin Docker image

| | |
|---|---|
| **Status** | `pending` |
| **Depends** | P2A-T5 |
| **Agent** | general-purpose |
| **Files** | `core/admin/Dockerfile` (edit) |

**Description:**
Add a `RUN` step to the admin Dockerfile that downloads the Varlock binary and symlinks it to `/usr/local/bin/varlock`. This is the **only** container that gets Varlock.

**Acceptance criteria:**
- `RUN curl -sSfL https://varlock.dev/install.sh | sh -s -- --force-no-brew && ln -s /root/.varlock/bin/varlock /usr/local/bin/varlock`
- `varlock --version` works inside the built container
- No other Dockerfiles are modified
- Build still succeeds: `docker compose build admin`

---

### P3-T2: Add `validateEnvironment()` to lifecycle module

| | |
|---|---|
| **Status** | `pending` |
| **Depends** | P3-T1, P2A-T5 |
| **Agent** | bunjs-typescript-coder |
| **Files** | `packages/admin/src/lib/server/lifecycle.ts` (edit) |

**Description:**
Add a `validateEnvironment()` function that shells out to `varlock load` with the schema and env file paths. Uses `execFile` with argument arrays (no shell interpolation). Returns `{ ok, errors, warnings }`.

**Acceptance criteria:**
- Function signature: `validateEnvironment(state: ControlPlaneState): Promise<{ ok: boolean; errors: string[]; warnings: string[] }>`
- Uses `execFile` from `node:child_process` (not `exec`)
- Arguments passed as array, not shell string
- 10-second timeout
- Parses stderr for ERROR/WARN lines on failure
- Returns `{ ok: true, errors: [], warnings: [] }` on success

---

### P3-T3: Create validation API endpoint

| | |
|---|---|
| **Status** | `pending` |
| **Depends** | P3-T2 |
| **Agent** | svelte5-expert-dev |
| **Files** | `packages/admin/src/routes/admin/config/validate/+server.ts` (new) |

**Description:**
Add a `GET /admin/config/validate` endpoint that returns the validation result. Requires admin authentication.

**Acceptance criteria:**
- Route file at `packages/admin/src/routes/admin/config/validate/+server.ts`
- `GET` handler calls `validateEnvironment(getState())`
- Returns JSON: `{ ok: boolean, errors: string[], warnings: string[] }`
- Requires admin auth (uses `requireAdmin()`)
- Returns 401 on missing/invalid token

---

### P3-T4: Add validation to maintenance cron

| | |
|---|---|
| **Status** | `pending` |
| **Depends** | P3-T2 |
| **Agent** | bunjs-typescript-coder |
| **Files** | `assets/cleanup-data.yml` or relevant cron module (edit) |

**Description:**
Add a periodic `varlock load --quiet` check to the system maintenance flow. Log warnings to the audit trail on failure but don't block services.

**Acceptance criteria:**
- Validation runs on the existing maintenance schedule
- Failures are logged as warnings (not errors) to the audit trail
- Services are never blocked by validation failures
- Uses the same `validateEnvironment()` function from P3-T2

---

### P3-T5: Document validation API endpoint

| | |
|---|---|
| **Status** | `pending` |
| **Depends** | P3-T3 |
| **Agent** | documentation-writer |
| **Files** | `docs/api-spec.md` (edit) |

**Description:**
Add documentation for `GET /admin/config/validate` to the API spec.

**Acceptance criteria:**
- Endpoint documented with method, path, auth requirements
- Request/response examples included
- Error response format documented

---

### P3-T6: Admin validation tests

| | |
|---|---|
| **Status** | `pending` |
| **Depends** | P3-T2, P3-T3 |
| **Agent** | bunjs-typescript-coder |
| **Files** | `packages/admin/src/lib/server/lifecycle.test.ts` (edit), new e2e test file |

**Description:**
Add unit tests for `validateEnvironment()` and e2e tests for the validation endpoint.

**Acceptance criteria:**
- Unit test: valid env fixture returns `{ ok: true }`
- Unit test: missing required var returns `{ ok: false, errors: [...] }`
- Unit test: `execFile` timeout is handled gracefully
- E2E test: `GET /admin/config/validate` with valid config returns 200 + `{ ok: true }`
- E2E test: `GET /admin/config/validate` without auth returns 401
- Tests pass with `bun run admin:test:unit`

---

## Phase 4 — AI-safe config for the assistant

**Branch:** `feat/varlock-ai-safe` · **Milestone:** `0.9.0-rc11`

### P4-T1: Stage schemas to assistant-readable path

| | |
|---|---|
| **Status** | `completed` |
| **Depends** | P1-T1, P1-T2 |
| **Agent** | bunjs-typescript-coder |
| **Files** | `packages/admin/src/lib/server/staging.ts` (edit) |

**Description:**
During the admin apply flow, copy schema files to `DATA_HOME/assistant/env-schema/` so the assistant container can read them.

**Acceptance criteria:**
- `secrets.env.schema` staged to `DATA_HOME/assistant/env-schema/secrets.env.schema`
- `stack.env.schema` staged to `DATA_HOME/assistant/env-schema/stack.env.schema`
- Directory `DATA_HOME/assistant/env-schema/` created if it doesn't exist
- Follows existing staging patterns in the file

---

### P4-T2: Update OpenCode config to include schema context

| | |
|---|---|
| **Status** | `completed` |
| **Depends** | P4-T1 |
| **Agent** | general-purpose |
| **Files** | `assets/opencode.jsonc` (edit) |

**Description:**
Add `/etc/opencode/env-schema/**` to the context include patterns in the baked-in OpenCode config, so the assistant can read schema files for configuration reasoning.

**Acceptance criteria:**
- `assets/opencode.jsonc` includes an env-schema context pattern
- Assistant can read schema files but never sees actual `.env` values
- File is valid JSONC after edit

---

### P4-T3: Create config diagnostics skill

| | |
|---|---|
| **Status** | `completed` |
| **Depends** | P4-T1 |
| **Agent** | general-purpose |
| **Files** | `core/assistant/skills/config-diagnostics.md` (new) |

**Description:**
Create a skill file that teaches the assistant to use the validation API and schema files for troubleshooting configuration issues. The skill must explicitly instruct the assistant to never read or expose actual `.env` file contents.

**Acceptance criteria:**
- File at `core/assistant/skills/config-diagnostics.md`
- Instructs assistant to call `GET /admin/config/validate`
- Instructs assistant to read `.env.schema` files for variable descriptions
- Explicitly prohibits reading/echoing actual `.env` values
- Guides users to fix issues via admin UI or direct file edits

---

## Phase 5 — Leak scanning (pre-commit)

**Branch:** `feat/varlock-scan` · **Milestone:** `0.9.0-rc11`

### P5-T1: Add `varlock scan` to CI workflow

| | |
|---|---|
| **Status** | `pending` |
| **Depends** | P1-T1 |
| **Agent** | general-purpose |
| **Files** | `.github/workflows/ci.yml` (edit) |

**Description:**
Add a CI step that installs varlock and runs `varlock scan --schema assets/secrets.env.schema` to catch accidentally committed secrets.

**Acceptance criteria:**
- New step in CI workflow: "Scan for leaked secrets"
- Installs varlock via curl install script
- Runs `varlock scan --schema assets/secrets.env.schema`
- Step runs after checkout, before tests
- CI fails if secrets are detected in committed files

---

### P5-T2: Document pre-commit hook setup

| | |
|---|---|
| **Status** | `pending` |
| **Depends** | P1-T1 |
| **Agent** | documentation-writer |
| **Files** | `docs/CONTRIBUTING.md` (edit or new) |

**Description:**
Add instructions for contributors to install varlock locally and set up pre-commit scanning.

**Acceptance criteria:**
- Instructions for installing varlock CLI
- Instructions for running `varlock scan --setup-hook`
- Explains what the hook does (scans staged files for secret patterns matching the schema)
- Placed in contributor-facing documentation

---

## Phase 6 — Optional secret provider plugins (post-GA)

**Branch:** `feat/varlock-providers` · **Milestone:** `0.10.0`

> These tasks are post-GA and should not be started until Phase 3 is complete.

### P6-T1: Document Azure Key Vault integration

| | |
|---|---|
| **Status** | `pending` |
| **Depends** | P3-T2 |
| **Agent** | documentation-writer |
| **Files** | `docs/secret-providers.md` (new) |

**Description:**
Create documentation for migrating from plaintext `.env` to Azure Key Vault-backed secrets via the `@varlock/azure-keyvault-plugin`.

**Acceptance criteria:**
- New file at `docs/secret-providers.md`
- Explains the `.env.schema` plugin annotation syntax
- Concrete example showing Azure Key Vault configuration
- Documents the bootstrap credential flow (single `AZURE_VAULT_URL` env var)
- Notes that admin container is the only one that resolves secrets

---

### P6-T2: Document 1Password / Bitwarden integration

| | |
|---|---|
| **Status** | `pending` |
| **Depends** | P3-T2 |
| **Agent** | documentation-writer |
| **Files** | `docs/secret-providers.md` (edit) |

**Description:**
Add 1Password and Bitwarden examples to the secret providers documentation.

**Acceptance criteria:**
- 1Password and Bitwarden sections added to `docs/secret-providers.md`
- Concrete examples showing vault path references
- Same bootstrap credential pattern as Azure

---

### P6-T3: Add provider resolution to admin apply flow

| | |
|---|---|
| **Status** | `pending` |
| **Depends** | P3-T2, P6-T1 |
| **Agent** | bunjs-typescript-coder |
| **Files** | `packages/admin/src/lib/server/lifecycle.ts` (edit) |

**Description:**
When provider plugins are configured in the schema, run `varlock run -- <apply-command>` instead of the plain apply to inject resolved secrets into the compose environment.

**Acceptance criteria:**
- Detects provider plugin annotations in the schema file
- Uses `varlock run` to resolve secrets at apply time
- Falls back to plain apply when no providers are configured
- Provider auth credentials come from environment (not disk)

---

## Dependency Graph (Summary)

```
P1-T1 ─┬─► P2A-T1 ──► P2A-T2 ──┐
       │   P2A-T4 ◄─┘           │
P1-T2 ─┤                        ├─► P2A-T6
       │   P2A-T3 ◄── P2A-T1    │
P1-T3  │                        │
       ├─► P2A-T5 ──────────────┼─► P3-T1 ──► P3-T2 ──► P3-T3 ──► P3-T6
       │                        │              P3-T4 ◄─┘  P3-T5
P1-T4 ◄┘                        │
                                │
P2B-T2 ──► P2B-T3               │
P2B-T1 ──► P2B-T4               │
           P2B-T5               │
P2B-T6 ◄── P2B-T2, P2B-T3      │
P2B-T7 ◄── P2B-T4, P2B-T5      │
                                │
P4-T1 ◄── P1-T1, P1-T2         │
P4-T2 ◄── P4-T1                │
P4-T3 ◄── P4-T1                │
                                │
P5-T1 ◄── P1-T1                │
P5-T2 ◄── P1-T1                │
                                │
P6-T1 ◄── P3-T2                │
P6-T2 ◄── P3-T2                │
P6-T3 ◄── P3-T2, P6-T1         │
```

## Parallelism Opportunities

These task groups can run concurrently:

**Wave 1** (no dependencies):
- P1-T1, P1-T2, P1-T3, P2B-T2

**Wave 2** (after Wave 1):
- P1-T4, P2A-T1, P2A-T4, P2A-T5, P4-T1, P5-T1, P5-T2, P2B-T3

**Wave 3** (after Wave 2):
- P2A-T2, P2A-T3, P4-T2, P4-T3, P2B-T1

**Wave 4** (after Wave 3):
- P2A-T6, P2B-T4, P2B-T5, P3-T1

**Wave 5** (after Wave 4):
- P2B-T6, P2B-T7, P3-T2

**Wave 6** (after Wave 5):
- P3-T3, P3-T4, P3-T5

**Wave 7** (after Wave 6):
- P3-T6

**Post-GA:**
- P6-T1, P6-T2, P6-T3

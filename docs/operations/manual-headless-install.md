# Manual and Headless Install

Two ways to get an OpenPalm home directory (`OP_HOME`, default `~/.openpalm/`)
into existence without walking through the interactive setup wizard:

1. **Hand-build it** — copy the skeleton, create the files `performSetup`
   would have created, and run `docker compose up -d` yourself.
2. **Headless CLI install** — run `openpalm install --file <spec>` with a
   config file that answers every wizard question up front. This is the
   supported, tested path for scripted/CI installs.

Both are legitimate. This page documents what OpenPalm actually checks for on
disk so a hand-built install is recognized, and the `--file` config shape for
a scripted install.

---

## What "installed" means on disk

`ensureHomeDirs()` (`packages/lib/src/control-plane/home.ts`) is the complete
list of directories a fresh `OP_HOME` needs:

```
config/{assistant,guardian,akm,stack}
data/assistant/{.cache,.config/opencode,.local/bin,.local/share/opencode,.local/state/opencode,tools}
data/guardian/{.config/opencode,.local/share/opencode,.local/state/opencode,tools}
data/{akm/cache,akm/data,akm/empty-host-stash,logs,backups,rollback}
knowledge/{env,secrets,tasks}
workspace/
system/{stack,assistant,guardian}
state/
```

It also touches two empty `auth.json` placeholders (below) if they don't
already exist:

```
data/assistant/.local/share/opencode/auth.json
data/guardian/.local/share/opencode/auth.json
```

Copying `packages/skeleton/` to `OP_HOME` (see [installation.md](../installation.md))
gives you this tree plus the shipped compose files under `system/stack/` and an
empty `config/stack/custom.compose.yml` overlay. From there, a hand-built
install needs three more things before `docker compose up -d` produces a stack
OpenPalm's own tooling (CLI/UI) recognizes as installed:

### 1. The two guardian tokens

`ensureSecrets()` (`packages/lib/src/control-plane/secrets.ts`) mints two
random tokens the guardian container and its clients (UI admin proxy, MCP
clients) must share:

| File (under `knowledge/secrets/`, mode `0600`) | Used by |
|---|---|
| `op_guardian_admin_token` | Guardian's `/admin/*` principal-management endpoints (`GUARDIAN_ADMIN_TOKEN_FILE`) |
| `op_guardian_mcp_token` | Guardian's MCP endpoint (`GUARDIAN_MCP_TOKEN_FILE`) |

Each is a 32-character lowercase hex string — `ensureSecrets` generates them
with `crypto.randomUUID().replace(/-/g, '')`, which is equivalent to:

```bash
mkdir -p ~/.openpalm/knowledge/secrets
chmod 700 ~/.openpalm/knowledge/secrets
openssl rand -hex 16 > ~/.openpalm/knowledge/secrets/op_guardian_admin_token
openssl rand -hex 16 > ~/.openpalm/knowledge/secrets/op_guardian_mcp_token
chmod 600 ~/.openpalm/knowledge/secrets/op_guardian_admin_token \
          ~/.openpalm/knowledge/secrets/op_guardian_mcp_token
```

Both files are consumed by the guardian container as Compose `secrets:`
mounts (`portals.compose.yml`) — not as plain env vars.

### 2. `auth.json`

`knowledge/secrets/auth.json` holds OpenCode provider credentials, bind-mounted
read/write into both the assistant and guardian containers. A fresh install
starts with an empty object:

```json
{}
```

Adding a provider key merges an entry keyed by provider ID, using OpenCode's
own api-key auth schema:

```json
{
  "openai": { "type": "api", "key": "sk-..." }
}
```

Multiple providers add multiple top-level keys. An empty/missing file is
treated the same as `{}`.

### 3. The `OP_SETUP_COMPLETE` stamp

`markSetupComplete()` writes one line to `state/stack.env`:

```
OP_SETUP_COMPLETE=true
```

(`state/` is an app-owned record tree — see
[core-principles.md](../technical/core-principles.md) — not something you're
expected to hand-edit routinely, but for a manual install this is the whole
contract: one file, one line.)

---

## What happens if you skip the stamp

If you build the tree above (including both guardian tokens) and run
`docker compose up -d` **without** writing the `OP_SETUP_COMPLETE` line,
OpenPalm still recognizes the install:

- **Runtime health is never stamp-gated.** `deriveLocalStackState()`
  (`packages/lib/src/control-plane/launch-status.ts`) rescues a
  `setup_incomplete` classification to `running` the moment Compose reports a
  running or starting service — a hand-built stack that is actually up is
  never stuck behind the stamp at the health layer.
- **Installedness itself is also derived, not stamp-only.**
  `classifyLocalInstall()` treats `system/stack/core.compose.yml` present
  **and** both guardian token files present as sufficient evidence of a real
  install, even with no stamp. This is a cheap, existsSync-only check — no
  Docker call — so it costs nothing on every status check.

Writing the stamp is still the simplest and most explicit option (one line,
matches exactly what `performSetup` does), but omitting it no longer strands a
correctly hand-built, running stack in the setup wizard.

If `core.compose.yml` is missing, or only one of the two guardian tokens
exists, the install still classifies as `setup_incomplete` and routes to the
splash/wizard screen — a half-assembled tree is deliberately NOT treated as
installed.

---

## Headless CLI install: `openpalm install --file`

`openpalm install --file <path>` (`packages/cli/src/commands/install.ts`) is
the supported way to script an install with no interactive prompts. It reads
a JSON or YAML `SetupSpec` and runs the exact same `performSetup` path the
wizard drives.

### Minimal `SetupSpec`

```yaml
version: 2
llm:
  provider: openai
  model: gpt-4o
  baseUrl: https://api.openai.com/v1
embedding:
  provider: openai
  model: text-embedding-3-small
  dims: 1536
  baseUrl: https://api.openai.com/v1
security:
  uiLoginPassword: change-me-please # min 8 characters
connections:
  - id: openai
    name: OpenAI
    provider: openai
    baseUrl: https://api.openai.com/v1
    apiKey: sk-...
```

Everything else is optional:

```yaml
version: 2
llm:
  provider: openai
  model: gpt-4o
embedding:
  provider: openai
  model: text-embedding-3-small
  dims: 1536
security:
  uiLoginPassword: change-me-please
owner:
  name: Jane Operator
  email: jane@example.com
connections:
  - id: openai
    name: OpenAI
    provider: openai
    baseUrl: https://api.openai.com/v1
    apiKey: sk-...
addons:
  chat: true
# #563 — network access preset. Absent means "leave network config
# untouched" (backward compatible with every spec above). One of the four
# literals: this-pc | home-password | home-open | shared-guardian.
# opencodePassword (min 8 chars) is REQUIRED for home-password and REJECTED
# for every other preset.
network:
  preset: home-password
  opencodePassword: change-me-too-please
```

The full field set and validation rules live in
`packages/lib/src/control-plane/setup.ts` (`SetupSpec` type) and
`packages/lib/src/control-plane/setup-validation.ts` (`validateSetupSpec`).

### Running it

```bash
openpalm install --file ./setup-spec.yaml --no-start   # write config, don't start the stack
openpalm install --file ./setup-spec.yaml               # write config and start core services
```

`--no-start` is the option to reach for in CI or any scripted context where
you want to assert the config was assembled correctly without needing a
Docker daemon to bring services up.

### Persisting isolated runtime overrides

When scripting an isolated install, set runtime overrides in the install shell.
The CLI now persists the following non-secret overrides into
`state/stack.env` so a later `openpalm start` reuses the same isolated
project and port layout automatically:

- `OP_PROJECT_NAME`
- `OP_ASSISTANT_PORT`
- `OP_UI_PORT`
- `OP_HOST_UI_PORT`

Example:

```bash
OP_HOME="$PWD/.tmp-openpalm-install/home" \
OP_PROJECT_NAME=openpalm-test-install \
OP_ASSISTANT_PORT=4802 \
OP_UI_PORT=4801 \
OP_HOST_UI_PORT=9302 \
openpalm install --file ./setup-spec.yaml --no-start

# Later, the same install can be started without re-specifying those overrides:
OP_HOME="$PWD/.tmp-openpalm-install/home" openpalm start
```

Without those persisted overrides, a later `openpalm start` falls back to the
default project name and default ports, which can collide with a live local
stack.

### Test coverage (the CI exercise)

`packages/cli/src/main.test.ts` exercises `install --no-start --file <spec>`
on every run of `bun run test` (root `package.json`), which CI's
`quality-gates` job (`.github/workflows/ci.yml`, "Test (sdk + guardian +
portals)" step) runs on every PR and push to `main`/`release/**`. Coverage
includes:

- a real subprocess run (`Bun.spawn(['bun', mainPath, 'install', ...])`) that
  exercises the `import.meta.main` entrypoint path in-process tests can't
  reach, asserting the process actually produces output;
- in-process runs asserting the expected directories/files land under a
  temporary `OP_HOME` (`system/stack/services.compose.yml`,
  `config/stack/custom.compose.yml`, `knowledge/tasks/akm-improve.yml`, …);
- `--version` / no-`--version` pin behavior (`OP_*_VERSION` tracks `latest`
  unless a version is explicit);
- the `--force` backup path, proving pre-existing config is snapshotted
  before being overwritten.

No separate CI job is needed for this — it is already a required, running
check on every PR.

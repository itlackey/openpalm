# Plan: Bun Single-Executable CLI Tool for OpenPalm

Addresses [#58](https://github.com/itlackey/openpalm/issues/58) and [#53](https://github.com/itlackey/openpalm/issues/53).

## Goal

Replace the current `install.sh`, `uninstall.sh`, and `install.ps1`/`uninstall.ps1` bash/PowerShell scripts with a single **Bun-compiled binary** (`openpalm`) that serves as both the installer and the ongoing stack management CLI. The binary is cross-platform (Linux, macOS; Windows stretch goal) and has zero runtime dependencies beyond a container runtime (Docker/Podman/OrbStack).

---

## Architecture

```
cli/
├── package.json              # Workspace package ("openpalm-cli")
├── tsconfig.json             # Inherits root tsconfig
├── src/
│   ├── main.ts               # Entry point — arg parser, command dispatch
│   ├── commands/
│   │   ├── install.ts        # `openpalm install` (replaces install.sh)
│   │   ├── uninstall.ts      # `openpalm uninstall` (replaces uninstall.sh)
│   │   ├── update.ts         # `openpalm update` — pull latest images
│   │   ├── start.ts          # `openpalm start` — start the stack
│   │   ├── stop.ts           # `openpalm stop` — stop the stack
│   │   ├── restart.ts        # `openpalm restart` — restart the stack
│   │   ├── logs.ts           # `openpalm logs` — tail container logs
│   │   ├── status.ts         # `openpalm status` — show container status
│   │   └── extensions.ts     # `openpalm extensions` — install/uninstall/list
│   ├── lib/
│   │   ├── compose.ts        # Compose command builder & executor
│   │   ├── runtime.ts        # Container runtime detection (Docker/Podman/OrbStack)
│   │   ├── env.ts            # .env generation, reading, upsert
│   │   ├── paths.ts          # XDG base directory resolution
│   │   ├── assets.ts         # Asset bootstrapping (download tarball or use local)
│   │   ├── detect-providers.ts  # Auto-detect AI providers (#53)
│   │   ├── tokens.ts         # Secure token generation
│   │   └── ui.ts             # Terminal output helpers (colors, spinners, prompts)
│   └── types.ts              # Shared CLI types
└── test/
    ├── runtime.test.ts
    ├── env.test.ts
    ├── paths.test.ts
    ├── detect-providers.test.ts
    └── compose.test.ts
```

The `cli` workspace is added to the root `package.json` workspaces array. The build produces a single executable via `bun build --compile --target=bun-linux-x64` (and other targets for cross-compilation).

---

## Commands

### `openpalm install` (replaces `install.sh`)

Ports all logic from the current `install.sh` into TypeScript:

1. **Detect OS and CPU arch** — `process.platform`, `process.arch` (Bun provides these)
2. **Detect container runtime** — check for OrbStack socket (macOS), Docker, Podman in order
3. **Bootstrap assets** — if running from a standalone binary (no local repo), download the assets tarball from GitHub; otherwise use local `assets/` directory
4. **Generate `.env`** — copy `system.env` template, generate secure random tokens via `crypto.getRandomValues()`
5. **Resolve XDG paths** — use `$XDG_DATA_HOME`, `$XDG_CONFIG_HOME`, `$XDG_STATE_HOME` with standard fallbacks
6. **Create directory trees** — data, config, state directories
7. **Seed config files** — Caddyfile, channel envs, secrets.env, user.env (skip if already exist)
8. **Auto-detect providers** (#53) — probe for Ollama, LM Studio, read env vars for Anthropic/OpenAI keys
9. **Seed detected providers** (#53) — write provider data to admin seed file so the setup wizard pre-populates
10. **Start Caddy + Admin first** (#53) — bring up just these two services initially
11. **Open browser to setup wizard** (#53) — launch `http://localhost/admin` immediately
12. **Pull remaining images in background** (#53) — `docker compose pull` for remaining services while user completes wizard
13. **Start remaining services** — bring up the full stack after pull completes
14. **Install CLI to PATH** — copy the binary to `~/.local/bin/openpalm` (or `/usr/local/bin/` if writable) and print PATH instructions if needed

CLI flags: `--runtime docker|podman|orbstack`, `--no-open`, `--help`

### `openpalm update`

1. Read `.env` from state home to get compose config
2. `docker compose pull` to fetch latest images
3. `docker compose up -d` to recreate containers with new images
4. Print summary of updated services

### `openpalm restart`

1. Load compose config from state home
2. `docker compose restart`
3. Print status

### `openpalm logs [service]`

1. If a service name is provided, `docker compose logs -f --tail=50 <service>`
2. Otherwise, `docker compose logs -f --tail=50` for all services

### `openpalm stop`

1. `docker compose stop` (stops without removing)

### `openpalm start`

1. `docker compose up -d` (starts previously stopped stack)

### `openpalm status`

1. `docker compose ps -a`
2. Format output in a readable table

### `openpalm uninstall` (replaces `uninstall.sh`)

Ports all logic from `uninstall.sh`:

1. Load config from `.env` / state home
2. Confirmation prompt (skip with `--yes`)
3. `docker compose down --remove-orphans`
4. Optional `--remove-images` to also `--rmi all`
5. Optional `--remove-all` to delete XDG data/config/state directories
6. Remove the CLI binary from PATH location

### `openpalm extensions <install|uninstall|list>`

Ports the existing `extensions-cli.ts` logic into the CLI.

---

## Provider Auto-Detection (#53)

`lib/detect-providers.ts` implements:

| Provider | Detection Method |
|----------|-----------------|
| Ollama | HTTP probe `http://localhost:11434/api/tags` — if reachable, parse model list |
| LM Studio | HTTP probe `http://localhost:1234/v1/models` — if reachable, parse model list |
| Anthropic | Check `ANTHROPIC_API_KEY` env var existence |
| OpenAI | Check `OPENAI_API_KEY` env var existence |
| Existing opencode config | Scan `~/.config/opencode/`, `~/.opencode/`, `./opencode.jsonc` for existing config files with provider settings |

Results are written to `$OPENPALM_DATA_HOME/admin/detected-providers.json` which the admin service reads during setup wizard to pre-populate provider configuration.

The install command prints a summary of what was detected and, if multiple providers have small models available, prompts the user to select one for the `OPENPALM_SMALL_MODEL` setting.

---

## Enhanced Install Flow (#53)

The install command implements a staged startup:

```
Phase 1: Setup infrastructure
  → Generate .env, create directories, seed configs
  → Detect AI providers, write seed data

Phase 2: Early UI access
  → Start caddy + admin + postgres (minimal dependencies)
  → Wait for admin health check
  → Open browser to setup wizard

Phase 3: Background pull
  → Pull remaining images (opencode-core, gateway, openmemory, channels, etc.)
  → User completes setup wizard while images download

Phase 4: Full stack
  → Start all remaining services
  → Print final status summary
```

---

## Build & Distribution

### Build script (in root `package.json`)

```json
{
  "cli:build": "bun build cli/src/main.ts --compile --outfile dist/openpalm",
  "cli:build:linux-x64": "bun build cli/src/main.ts --compile --target=bun-linux-x64 --outfile dist/openpalm-linux-x64",
  "cli:build:linux-arm64": "bun build cli/src/main.ts --compile --target=bun-linux-arm64 --outfile dist/openpalm-linux-arm64",
  "cli:build:darwin-x64": "bun build cli/src/main.ts --compile --target=bun-darwin-x64 --outfile dist/openpalm-darwin-x64",
  "cli:build:darwin-arm64": "bun build cli/src/main.ts --compile --target=bun-darwin-arm64 --outfile dist/openpalm-darwin-arm64"
}
```

### Distribution via GitHub Releases

Compiled binaries are attached to GitHub releases. The one-liner install becomes:

```bash
curl -fsSL https://github.com/itlackey/openpalm/releases/latest/download/openpalm-$(uname -s | tr A-Z a-z)-$(uname -m) -o /tmp/openpalm && chmod +x /tmp/openpalm && /tmp/openpalm install
```

### PATH installation

During `openpalm install`, the binary copies itself to `~/.local/bin/openpalm` and prints a message if `~/.local/bin` is not in `$PATH`. On subsequent runs, the user just types `openpalm <command>`.

---

## Implementation Steps

### Step 1: Scaffold the CLI workspace
- Create `cli/` directory with `package.json`, `tsconfig.json`
- Add `cli` to root `package.json` workspaces
- Set up the entry point `cli/src/main.ts` with argument parsing and command routing

### Step 2: Implement shared library modules
- `lib/ui.ts` — colored output, spinner, confirmation prompts (no external deps)
- `lib/runtime.ts` — container runtime detection (port from install.sh logic)
- `lib/paths.ts` — XDG directory resolution
- `lib/env.ts` — .env file read/write/upsert
- `lib/tokens.ts` — secure token generation using Web Crypto API
- `lib/compose.ts` — compose command builder wrapping Bun.spawn
- `lib/assets.ts` — asset bootstrapping (tarball download or local detection)

### Step 3: Implement the `install` command
- Port all install.sh logic to `commands/install.ts`
- Add PATH installation (copy binary to `~/.local/bin/`)
- Add tests for key logic (env generation, path resolution, runtime detection)

### Step 4: Implement provider auto-detection (#53)
- `lib/detect-providers.ts` — HTTP probes for Ollama/LM Studio, env var checks
- Integrate into install command
- Write detected providers to admin seed file

### Step 5: Implement staged install flow (#53)
- Phase 1-4 startup sequence in install command
- Start caddy+admin first, open browser, pull remaining in background

### Step 6: Implement management commands (#58)
- `commands/update.ts` — pull + recreate
- `commands/restart.ts` — restart
- `commands/logs.ts` — tail logs
- `commands/stop.ts` — stop
- `commands/start.ts` — start
- `commands/status.ts` — ps
- `commands/uninstall.ts` — port from uninstall.sh
- `commands/extensions.ts` — port from extensions-cli.ts

### Step 7: Add build scripts and update root package.json
- Add `cli:build` and cross-platform build scripts
- Add `cli:dev` for local development
- Update tsconfig.json to include `cli/src`

### Step 8: Write tests
- Unit tests for library modules (runtime detection, env parsing, path resolution, provider detection)
- Integration tests for command execution (mocked compose)

### Step 9: Update documentation
- Update README.md with new CLI usage
- Update AGENTS.md with new development commands

---

## Files Modified

| File | Change |
|------|--------|
| `package.json` | Add `cli` to workspaces, add `cli:*` scripts |
| `tsconfig.json` | Add `cli/src` to includes |
| `cli/` (new directory) | Entire CLI workspace |
| `assets/state/scripts/install.sh` | Keep for backwards compat (thin wrapper that downloads + runs the binary) |

## Files NOT Removed

The existing bash scripts (`install.sh`, `uninstall.sh`, `install.ps1`, `uninstall.ps1`) are kept as fallback/bootstrap scripts. The `install.sh` can be simplified to a thin wrapper that downloads the compiled binary and runs `openpalm install`. This preserves the existing `curl | bash` one-liner while routing through the new CLI.

# scripts

Utility scripts for installing, updating, and developing OpenPalm.

## Production scripts

### `setup.sh` / `setup.ps1`

One-liner installer for Mac/Linux and Windows respectively.

```bash
# Mac / Linux
curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.sh | bash

# Windows (PowerShell)
irm https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.ps1 | iex
```

Re-run to update — secrets are never overwritten. Options:

| Flag | Effect |
|---|---|
| `--force` | Skip confirmation prompts |
| `--version TAG` | Install a specific release tag (default: `main`) |
| `--no-start` | Set up files but don't start Docker services |
| `--no-open` | Don't open the admin UI after install |

### `install.sh`

Installs the compiled OpenPalm CLI binary from GitHub Releases into `~/.local/bin/openpalm` by default.

```bash
curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/install.sh | bash
```

Options:

| Flag | Effect |
|---|---|
| `--version TAG` | Install a specific release tag (default: `latest`) |
| `--install-dir PATH` | Install to a custom directory |

### `release.sh`

Bumps platform package versions, runs tests, commits, pushes, and tags a release. The tag triggers the Release workflow (Docker images, CLI binaries, GitHub release). npm packages are **not** bumped — they are versioned independently via per-package publish workflows.

```bash
./scripts/release.sh 0.7.2        # stable release
./scripts/release.sh 0.8.0-rc1    # prerelease
```

Aborts if the working tree is dirty or the tag already exists.

### `bump-platform.sh`

Updates platform `package.json` files (root, `core/admin`, `core/guardian`, `core/cli`) to a new semver version. Does not touch npm packages or dependency cross-references.

```bash
./scripts/bump-platform.sh 1.2.3
```

npm packages (`packages/channels-sdk`, `packages/channel-*`, `packages/assistant-tools`) are versioned independently via their own GitHub Actions publish workflows.

## Development scripts

### `dev-setup.sh`

Creates `.dev/` XDG directories and optionally seeds config files for local development.

```bash
./scripts/dev-setup.sh --seed-env        # Seed configs (non-destructive)
./scripts/dev-setup.sh --seed-env --force # Overwrite existing configs
```

Sets `OPENPALM_*_HOME` to absolute `.dev/` paths so the admin dev server picks them up without additional environment setup.

When `--seed-env` is used, this script also:
- Seeds `ADMIN_TOKEN=dev-admin-token` in `secrets.env` (matches test expectations)
- Seeds OpenMemory `default_config.json` with Ollama via `host.docker.internal:11434` and `nomic-embed-text` (768 dims)

## iso/

Scripts and config files for building a Debian 13 kiosk ISO that auto-starts the OpenPalm stack. See [`iso/README.md`](iso/README.md).

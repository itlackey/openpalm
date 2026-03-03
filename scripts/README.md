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

### `bump-versions.sh`

Updates all workspace `package.json` files to a new semver version for coordinated/manual versioning.

```bash
./scripts/bump-versions.sh 1.2.3
```

For npm package publishing, this repo now uses Changesets via `.changeset/` and
the `npm-release` GitHub workflow.

## Development scripts

### `dev-setup.sh`

Creates `.dev/` XDG directories and optionally seeds config files for local development.

```bash
./scripts/dev-setup.sh --seed-env
```

Sets `OPENPALM_*_HOME` to absolute `.dev/` paths so the admin dev server picks them up without additional environment setup.

## iso/

Scripts and config files for building a Debian 13 kiosk ISO that auto-starts the OpenPalm stack. See [`iso/README.md`](iso/README.md).

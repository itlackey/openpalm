# scripts

Utility scripts for installing, testing, and developing OpenPalm.
The platform model is compose-first and manual-first; these scripts help seed or package that flow, but they do not replace Docker Compose as deployment truth.

## Install and release helpers

### `setup.sh` / `setup.ps1`

Convenience installers that download and verify the CLI, then run the generated
OpenPalm install flow. The repository does not contain a complete `.openpalm/`
runtime bundle to copy by hand.

Both scripts support `--cli-only` to install or refresh just the CLI binary without running `openpalm install` or touching the existing stack files under `OP_HOME`.

Release preparation and publication are orchestrated by
`.github/workflows/release.yml`; `bump-unit.mjs` is its canonical version stamper.

## Development helpers

### `dev-setup.sh`

Creates a local `.dev/` OpenPalm home for development.

- Mirrors the current `packages/skeleton/` runtime assets into `.dev/`
- Seeds `.dev/knowledge/env/user.env` and `.dev/state/stack.env` when `--seed-env` is used
- Updates `.dev/state/stack.env` `OP_ENABLED_ADDONS` when `--enable-addon <name>` is used
- Seeds provider `auth.json`, delegated development secrets, and required mount targets

Examples:

```bash
./scripts/dev-setup.sh --seed-env
./scripts/dev-setup.sh --seed-env --force
./scripts/dev-setup.sh --seed-env --enable-addon voice
```

Notes:

- This is a dev-only current-layout home, not the recommended user-facing install flow
- Enabled addons live in `.dev/state/stack.env` as `OP_ENABLED_ADDONS`

## Test and misc helpers

- `test-tier.sh` - tiers 1-5, from type checks through isolated stack integration
- `dev-e2e-test.sh` - isolated current-layout stack smoke and Playwright flow
- `install-hooks.sh` - git hook setup

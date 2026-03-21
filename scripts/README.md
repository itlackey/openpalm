# scripts

Utility scripts for installing, testing, and developing OpenPalm.
The platform model is compose-first and manual-first; these scripts help seed or package that flow, but they do not replace Docker Compose as deployment truth.

## Install and release helpers

### `setup.sh` / `setup.ps1`

Convenience installers for users who want a guided bootstrap instead of copying the repo's `.openpalm/` bundle by hand.

### `release.sh`

Bumps platform versions, runs release checks, and creates a tagged release.

### `bump-platform.sh`

Updates platform package versions without touching independently versioned npm packages.

## Development helpers

### `dev-setup.sh`

Creates a local `.dev/` OpenPalm home for development.

- Seeds `.dev/vault/user/user.env` and `.dev/vault/stack/stack.env` when `--seed-env` is used
- Copies the repo's compose assets into `.dev/stack/`
- Seeds a local OpenCode config and memory `default_config.json`
- Can initialize the optional `pass` backend

Examples:

```bash
./scripts/dev-setup.sh --seed-env
./scripts/dev-setup.sh --seed-env --force
./scripts/dev-setup.sh --seed-env --pass --gpg-id <key>
```

Notes:

- This is a dev-only compatibility layout, not the recommended user-facing manual setup flow
- Current seeded tokens include `OP_ADMIN_TOKEN=dev-admin-token` and `ADMIN_TOKEN=dev-admin-token` for compatibility with existing tests

## Test and misc helpers

- `dev-e2e-test.sh` - local dev-stack test flow
- `release-e2e-test.sh` - release validation flow
- `upgrade-test.sh` - upgrade scenario checks
- `validate-registry.sh` - registry validation
- `install-hooks.sh` - git hook setup
- `pass-init.sh` - pass backend bootstrap

## ISO helper

See `scripts/iso/README.md` for the kiosk ISO builder.

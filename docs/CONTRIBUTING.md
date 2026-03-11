# Contributing to OpenPalm

---

## Dev Environment Setup

See [CLAUDE.md](../CLAUDE.md) for the full list of build and test commands, architecture rules, and the delivery checklist that every change must satisfy before merging.

Quick reference:

```bash
# Clone and bootstrap
git clone https://github.com/itlackey/openpalm.git
cd openpalm

# Admin UI
cd packages/admin && npm install && npm run dev

# Guardian
cd core/guardian && bun install && bun run src/server.ts

# Dev stack (pull images)
bun run dev:setup   # create .dev/ dirs, seed configs
bun run dev:stack   # start the full stack
```

---

## Pre-commit Secret Scanning

OpenPalm uses [varlock](https://varlock.dev) to scan staged files for secrets before each commit. The schema at `assets/secrets.env.schema` defines the patterns to detect.

### Install varlock

```bash
curl -fsSL https://varlock.dev/install.sh | sh
```

### Set up the pre-commit hook

```bash
varlock scan --setup-hook --schema assets/secrets.env.schema
```

This writes a `.git/hooks/pre-commit` script that runs before every `git commit`. The hook scans all staged files against the patterns defined in `assets/secrets.env.schema` — variable types marked `@sensitive=true` (or governed by `@defaultSensitive=true`) are used to build the detection patterns. If any staged file contains a value matching a sensitive variable pattern, the commit is aborted and the offending file and line are reported.

The hook runs locally only. The same scan also runs in CI (see `.github/workflows/ci.yml`) as a second line of defence.

### Why this matters

`CONFIG_HOME/secrets.env` holds API keys and auth tokens. The `.env.schema` files are safe to commit (they contain no values), but an accidental `git add secrets.env` or a key pasted into source code would be caught by the hook before reaching the remote.

---

## Architecture Rules

All contributions must comply with [`docs/technical/core-principles.md`](technical/core-principles.md). Key invariants:

- Admin is the sole Docker orchestrator. No other component gets the Docker socket.
- All channel traffic enters through the guardian (HMAC, replay protection).
- `CONFIG_HOME` is user-owned. Lifecycle operations only seed missing defaults — never overwrite.
- No shell interpolation in Docker commands. Use `execFile` with argument arrays.
- Follow the Docker dependency resolution pattern in [`docs/technical/docker-dependency-resolution.md`](technical/docker-dependency-resolution.md).

## Delivery Checklist

Before opening a pull request:

- [ ] `cd packages/admin && npm run check` passes
- [ ] `cd core/guardian && bun test` passes
- [ ] No new dependency duplicates a built-in Bun or platform capability
- [ ] Filesystem, guardian ingress, and assistant-isolation rules remain intact
- [ ] Errors and logs are structured and include request identifiers where applicable
- [ ] No secrets leak through client bundles or logs
- [ ] Docker builds follow the dependency resolution pattern

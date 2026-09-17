# OpenPalm CLI

The CLI is the primary host-side orchestrator for the lean stack.

```bash
openpalm install
openpalm update
openpalm addon list
openpalm addon enable gateway
openpalm config show
openpalm config assistant --bind 127.0.0.1 --port 3810
openpalm config gateway --bind 127.0.0.1 --port 3830
openpalm credential add automation read
openpalm credential set-policy automation full
openpalm config portal discord --credential automation
openpalm doctor
openpalm start
openpalm restart
openpalm stop
openpalm status
openpalm logs
```

It materializes a small allowlist of Skeleton files, maintains
`state/stack.json`, derives non-secret Compose input, creates file secrets,
validates the resolved project, and invokes Docker without a shell.

The compiled binary embeds only the active Skeleton archive. It has no browser
wizard, web server, UI assets, updater, addon catalog, purge command, or
per-service lifecycle bypass.

## Development

```bash
bun run --cwd packages/cli typecheck
bun run --cwd packages/cli test
bun run --cwd packages/cli build
bun run packages/cli/src/main-lean.ts install --no-start
```

Set `OP_HOME` for isolated testing and `OPENPALM_REPO_ROOT` when running
directly from source.

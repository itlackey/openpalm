# OpenPalm CLI

The CLI is the primary host-side orchestrator for the stack.

```bash
openpalm install
openpalm setup
openpalm provider list
openpalm provider login anthropic
openpalm provider test
openpalm remote enable claude
openpalm remote enable codex --sandbox workspace-write
openpalm remote disable claude
openpalm connect opencode
openpalm connect claude --credential owner
openpalm backup --to /path/to/empty-backup
openpalm import --from /path/to/old-home --dry-run
openpalm import --from /path/to/old-home --apply --acknowledge-unrestored
openpalm task create morning-news --schedule '0 8 * * 1-5' --prompt 'Summarize project news'
openpalm task history morning-news
openpalm update
openpalm addon list
openpalm addon enable gateway
openpalm config show
openpalm config assistant --bind 127.0.0.1 --port 3810
openpalm config assistant --timezone America/Chicago --memory on
openpalm config gateway --bind 127.0.0.1 --port 3830
openpalm credential add automation read
openpalm credential set-policy automation full
openpalm config portal discord --credential automation
openpalm credential map discord 123456789012345678 automation
openpalm credential mappings discord
openpalm portal token discord --bot-token-file -
openpalm portal access discord --users 123456789012345678 --no-apply
openpalm config oauth --resource https://agent.example/mcp --issuer https://id.example/ --jwks-url https://id.example/jwks.json --no-apply
openpalm credential map oauth https://id.example/ subject-123 automation
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
chat, web server, UI assets, updater, addon catalog, purge command, or
per-service lifecycle bypass.

Install delegates OAuth, device interaction, and provider discovery to
OpenCode, then verifies a real no-tool response before marking setup complete.
The dry-run-first importer copies an explicit allowlist into a fresh 0.14 home;
it never performs an in-place legacy-home migration. Recurring tasks use one
restricted Assistant helper and durable AKM history rather than a second
scheduler API.

Portable backup/import does not restore native conversations or external runtime
sources. Its preview and private receipt show that scope explicitly. When
runtime data or skipped links are detected, applying requires acknowledging
separate preservation or deferred recovery.

Native history has a separate same-instance path, usable with a stopped fresh
or initialized target. It uses private WAL-inclusive SQLite snapshots and
plugin-free offline native export/import, not legacy database replacement:

```bash
openpalm history export --from /path/to/old-home --image <exact-old-assistant-image> --to /private/new-history
openpalm stop
openpalm history restore --from /private/new-history --directory-map /private/directories.json
openpalm history restore --from /private/new-history --directory-map /private/directories.json --apply --same-instance
openpalm start
```

Every old directory requires a reviewed mapping to an existing `/work` context.
Keep old originals and full physical-source backups until acceptance. See the
[migration guide](../../docs/operations/migration-to-0.14.md) for linked runtime
selection, collision handling, retry, limitations and verification.

`openpalm update` pulls the versioned release images and recreates the enabled
containers so managed configuration changes take effect. User configuration,
knowledge, workspace, and credentials are preserved. Use `--no-pull` for locally
built images or `--no-start` to refresh files without changing running services;
then run `openpalm restart` when ready. Ordinary `start` never forces an update.

## Development

```bash
bun run --cwd packages/cli typecheck
bun run --cwd packages/cli test
bun run --cwd packages/cli build
bun run packages/cli/src/main.ts install --no-start
```

Set `OP_HOME` for isolated testing and `OPENPALM_REPO_ROOT` when running
directly from source.

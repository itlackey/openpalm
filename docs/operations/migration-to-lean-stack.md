# Migrating to the lean stack

The lean migration is deliberately additive on disk and subtractive at runtime.
It writes the new managed files and intent, but it does not delete a legacy
file, secret, database, model, volume, backup, or operator configuration.

## Before migrating

1. Stop making configuration changes through the old UI.
2. Back up `config/`, `knowledge/`, `workspace/`, `state/`, and any needed
   `data/` paths.
3. Record the current Compose project name and non-default image pins.
4. Review `config/stack/custom.compose.yml`. Remove retired service definitions
   from that file yourself only after backing it up.

The activation audit refuses known retired service names in the custom overlay;
this prevents a preserved `voice`, `ui`, `ollama`, `paperclip`, `api`, `remote`,
`tailscale`, or `workspace` block from silently reactivating legacy runtime.

## Migrate without starting

Install the refactored CLI, point it at the existing `OP_HOME`, and run:

```bash
openpalm update --no-start
openpalm config show
openpalm doctor
```

`doctor` may report that Docker is unavailable when the daemon is intentionally
stopped; the file, permission, and config results remain useful.

## Intent mapping

When `state/stack.json` does not exist, migration reads the existing
`state/stack.env` once:

| Legacy intent | Lean result |
|---|---|
| Assistant bind and port | Native OpenCode bind and port |
| `gateway` enabled | Gateway enabled |
| `api` or old Guardian/OpenAI access toggle enabled | Gateway enabled |
| `discord` enabled | Discord and Gateway enabled |
| `slack` enabled | Slack and Gateway enabled |
| Voice, Ollama, Paperclip, remote/VPN, UI, workspace, model, or hardware variants | Dropped |

Existing `GUARDIAN_OWNER_POLICY`, `GUARDIAN_DISCORD_POLICY`, and
`GUARDIAN_SLACK_POLICY` values become policies on the initial `owner`,
`discord`, and `slack` named credentials when valid. Existing
`op_guardian_mcp_token`, `portal_discord_secret`, and `portal_slack_secret`
values are copied into their named key stores. Otherwise strong keys are
generated, owner defaults to `full`, and portal credentials default to `chat`.
Legacy secret files are preserved but no longer mounted.

The result becomes versioned `state/stack.json`. `state/stack.env` is then
derived from that document while preserving unrelated image, port, and project
pins. Unsupported settings never enter the new intent schema.

Both released and interim lean V1 documents from this refactor branch are
upgraded to StackConfigV2 named credentials. Migration applies only to known
old shapes; unknown keys still fail validation.

## What changes

- `system/stack/stack.compose.yml` becomes the only managed Compose file.
- Assistant becomes the only default service.
- Guardian, Discord, and Slack become the only profiles.
- Guardian ingress becomes MCP-only.
- the old browser/Admin server and chat UI are no longer started.
- a subsequent `start` uses `--remove-orphans`, so containers no longer declared
  by the lean project are removed without deleting their bind-mounted data or
  named volumes.

## What is preserved

- all operator-owned config, knowledge, tasks, provider auth, and workspace;
- all old managed files not on the lean overwrite allowlist;
- all old delegated secret files;
- service data, model files, databases, logs, backups, and Docker volumes; and
- the existing custom Compose file.

Preservation is not continued support. Legacy paths are inert unless the custom
overlay explicitly references them.

## Start and verify

```bash
openpalm start
openpalm status
openpalm logs
```

Verify a native OpenCode client first. Then enable and verify Gateway and each
portal independently. Do not expose either native OpenCode or Guardian beyond
loopback until its authentication, network boundary, TLS termination, and any
browser Origin allowlist are configured.

## Cleanup phase

Repository cleanup and an installed-home cleanup are separate operations.

- Repository candidates are listed in
  [deletion-manifest.md](../technical/deletion-manifest.md).
- Installed-home paths are machine-specific and must be inventoried from that
  exact `OP_HOME`.

Neither list grants deletion authority. Review each exact path, confirm the
backup, and approve it explicitly before removal.

## Rollback

Before cleanup, rollback remains possible because the old Compose/config files
and data are preserved. Restore the backed-up `state/stack.env`, use the prior
CLI/release, and validate its old Compose project before starting it. Do not run
old and lean projects against the same writable data directories at the same
time.

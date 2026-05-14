# @openpalm/assistant-tools

OpenCode plugin that registers the small set of OpenPalm-specific assistant tools that are not provided by the akm stash. Published to npm and loaded by the assistant container at startup.

## What it provides

- **`load_vault`** — load user-managed secrets from `/etc/vault/user.env`
- **`health-check`** — quick reachability check for the guardian (used by the assistant during diagnostics)

Persistent memory, lessons, skills, commands, workflows, wikis, and shared agent dispatch are all served by the akm-cli stash that ships in the assistant container (see `core/assistant/README.md`). That makes the assistant-tools surface intentionally tiny.

Admin operations tools (containers, channels, lifecycle, config, connections, artifacts, automations, audit) are in the separate [`@openpalm/admin-tools`](../admin-tools/README.md) package, loaded only when the admin container is present.

## Structure

```
src/index.ts              # Plugin entry — registers the load_vault and health-check tools
opencode/tools/           # One file per tool (load_vault.ts, health-check.ts)
AGENTS.md                 # Assistant persona and behavioral guidelines
```

## How it loads

The assistant's `opencode.jsonc` lists this package in its `"plugin"` array. OpenCode installs it from npm on startup (offline fallback at `/etc/opencode/node_modules/`). See [`core/assistant/README.md`](../../core/assistant/README.md) for the full plugin architecture.

## Building

```bash
bun build src/index.ts --outdir dist --format esm --target node
```

## Dependencies

`@opencode-ai/plugin` — OpenCode plugin interface. No admin or memory-service dependency.

See [`AGENTS.md`](AGENTS.md) for the assistant persona, [`docs/core-principles.md`](../../docs/technical/core-principles.md) for architectural rules.

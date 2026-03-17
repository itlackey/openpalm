# @openpalm/assistant-tools

OpenCode plugin that registers all tools, hooks, and skills for the OpenPalm assistant. Published to npm and loaded by the assistant container at startup.

## What it provides

- **15 memory tools** — search, add, update, delete, get, list, stats, apps, feedback, exports, events, and health check
- **Memory hooks** — `MemoryContextPlugin` injects scoped memories (personal/project/stack/global), feeds back outcomes, and exports memory env vars
- **Skills** — reference guide for memory usage (`opencode/skills/`)

Admin operations tools (containers, channels, lifecycle, config, connections, artifacts, automations, audit) are in the separate [`@openpalm/admin-tools`](../admin-tools/README.md) package, loaded only when the admin container is present.

## Structure

```
src/index.ts              # Plugin entry — registers all tools + memory hooks
opencode/tools/           # One file per tool (memory-search.ts, memory-add.ts, health-check.ts, etc.)
opencode/plugins/         # memory-context.ts — automatic memory integration
opencode/skills/          # SKILL.md reference guides
AGENTS.md                 # Assistant persona and behavioral guidelines
```

## How it loads

The assistant's `opencode.jsonc` lists this package in its `"plugin"` array. OpenCode installs it from npm on startup (offline fallback at `/etc/opencode/node_modules/`). See [`core/assistant/README.md`](../../core/assistant/README.md) for the full plugin architecture.

## Building

```bash
bun build src/index.ts --outdir dist --format esm --target node
```

## Dependencies

`@opencode-ai/plugin` — OpenCode plugin interface. Memory tools call the memory API via standard `fetch`; no admin dependency.

See [`AGENTS.md`](AGENTS.md) for the assistant persona, [`docs/core-principles.md`](../../docs/technical/core-principles.md) for architectural rules.

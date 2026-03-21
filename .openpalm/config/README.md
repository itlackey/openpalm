# config/

User-editable, non-secret configuration. Files here are safe to inspect,
version-control, and share. The CLI and admin seed defaults but never
overwrite existing user files.

## Files

| File | Purpose |
|------|---------|
| `stack.yaml` | **Primary configuration file.** Connections, model assignments, memory config, and enabled addons. Read by `@openpalm/lib` for all stack operations. |
| `host.yaml` | Host environment snapshot (platform, Docker status, local LLM availability). Written at install time by the CLI. Not committed to the repo. |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `assistant/` | OpenCode user config (`opencode.json`), plugins, skills, and tools. Mounted into the assistant container at `/home/opencode/.config/opencode`. |
| `automations/` | Scheduler automation definitions (YAML). Core automations (cleanup, validation) are seeded at install; optional ones can be added from the catalog or written by hand. |
| `guardian/` | Guardian-specific configuration. |
| `components/` | Compose overlays installed at runtime. The CLI writes `core.yml` here; channel and addon overlays are added during setup. |

## stack.yaml

This is the single source of truth for stack configuration. It replaces
the previous `openpalm.yaml`, `profiles.json`, and per-feature flags.

```yaml
version: 1

connections:          # LLM provider connections
  - id: openai
    name: OpenAI
    kind: openai_compatible_remote
    provider: openai
    baseUrl: https://api.openai.com
    auth:
      mode: api_key
      apiKeySecretRef: "env:OPENAI_API_KEY"

assignments:          # Which connection + model to use for each capability
  llm:
    connectionId: openai
    model: gpt-4o
  embeddings:
    connectionId: openai
    model: text-embedding-3-small
    embeddingDims: 1536
  memory:             # Memory service config (drives data/memory/default_config.json)
    llm: { connectionId: openai, model: gpt-4o }
    embeddings: { connectionId: openai, model: text-embedding-3-small }
    vectorStore: { provider: sqlite-vec, collectionName: memory, dbPath: /data/memory.db }

addons:               # Enabled addon services
  - admin
  - chat
  - ollama
```

# config/

User-editable, non-secret configuration. Files here are safe to inspect,
version-control, and share. The CLI and admin seed defaults but never
overwrite existing user files.

## Files

| File | Purpose |
|------|---------|
| `stack.yml` | Optional capability metadata. Connections and model assignments for helper tooling. |
| `host.yaml` | Host environment snapshot (platform, Docker status, local LLM availability). Written at install time by the CLI. Not committed to the repo. |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `assistant/` | OpenCode user config (`opencode.json`), plugins, skills, and tools. Mounted into the assistant container at `/home/opencode/.config/opencode`. |
| `automations/` | Scheduler automation definitions (YAML). Core automations (cleanup, validation) are seeded at install; optional ones can be added from the catalog or written by hand. |
| `guardian/` | Guardian-specific configuration. |

## stack.yml

This file is optional. It can describe capability settings,
but the runtime stack is still defined by the compose files in
`~/.openpalm/stack/`. If `stack.yml` disagrees with an explicit compose
command, the explicit compose command wins.

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
  memory:             # Preferred memory settings for helper tooling
    llm: { connectionId: openai, model: gpt-4o }
    embeddings: { connectionId: openai, model: text-embedding-3-small }
    vectorStore: { provider: sqlite-vec, collectionName: memory, dbPath: /data/memory.db }

addons:               # Enabled addon services
  - admin
  - chat
  - ollama
```

Select addons by adding their compose files as `-f` flags to `docker compose`.
See the [Manual Compose Runbook](../../docs/operations/manual-compose-runbook.md)
for the full command reference.

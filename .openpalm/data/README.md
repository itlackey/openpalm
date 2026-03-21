# data/

Service-managed persistent data. Each service gets its own subdirectory,
typically mounted as the container's `$HOME` or data volume. Do not edit
files here unless you know what you're doing — services own this data.

## Subdirectories

| Directory | Mounted as | Purpose |
|-----------|------------|---------|
| `admin/` | `/state` | Admin UI state (setup status, cached data) |
| `assistant/` | `/home/opencode/.opencode` | OpenCode project data, conversation history, tool state |
| `guardian/` | `/app/data` | Guardian runtime data (nonce cache, rate limit state) |
| `memory/` | `/data` | Memory database (SQLite), embeddings, and generated config |
| `stash/` | `/home/opencode/.akm` | AgentiKit stash directory (shared tools and knowledge) |

## Memory config

`memory/default_config.json` is generated from `config/stack.yaml`
assignments. It configures the memory service's LLM provider, embedding
model, and vector store. The CLI and admin regenerate this file when
connections or assignments change.

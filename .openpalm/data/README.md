# data/

Durable service-owned data lives here. These directories survive restarts and
reinstalls, but they are not the main user configuration surface.

## Subdirectories

| Directory | Mounted as | Purpose |
|---|---|---|
| `admin/` | `/home/node` | Admin runtime home |
| `akm-cache/` | `/akm-cache` | Shared AKM cache (assistant + admin) — registry index, downloaded artifacts |
| `assistant/` | `/home/opencode` | Assistant home and local runtime state |
| `guardian/` | `/app/data` | Guardian nonce and rate-limit state |
| `guardian-cache/` | `/akm-cache` | Operator-only AKM cache (guardian only) |
| `guardian-stash/` | `/akm-guardian` | Operator-only AKM stash (guardian only) |
| `memory/` | `/data` | Memory database, mem0 compatibility data, generated config |
| `stash/` | `/akm` | Shared AKM stash (assistant + admin) |
| `workspace/` | `/work` | Shared workspace mounted into assistant and admin |

## Notes

- `memory/` is the only shipped persistent mount for the memory service.
- `workspace/` is durable and intentionally shared; it is not a secret store.
- User-editable configuration belongs in `config/`, not here.

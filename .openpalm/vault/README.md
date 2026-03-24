# vault/

Secrets boundary. This directory contains sensitive environment files that
are passed to Docker Compose via `--env-file` flags. The separation between
`stack/` and `user/` enforces different ownership and access policies.

## Structure

```
vault/
    stack/
      stack.env           System-managed runtime env and secrets
      stack.env.schema    Varlock validation schema for stack.env
      auth.json           OpenCode auth state mounted into assistant
  user/
    user.env            User-managed secrets (LLM API keys, owner info)
    user.env.schema     Varlock validation schema for user.env
  redact.env.schema     Log redaction rules (used by varlock in containers)
```

## Ownership

| File | Owner | Who writes | Who reads |
|------|-------|------------|-----------|
| `stack/stack.env` | System | CLI install, admin API | Docker Compose and service env wiring |
| `stack/auth.json` | System-managed runtime auth | CLI/admin | Assistant file mount |
| `user/user.env` | User | User directly, admin UI/API | Docker Compose, assistant (read-only mount) |
| `*.env.schema` | System | CLI install, admin upgrade | Varlock (validation + redaction) |

## Security rules

- **Only admin mounts full `vault/` (read-write).** This is required for the
  admin API to manage stack secrets and channel HMAC keys.
- **Assistant mounts only `vault/user/user.env` (read-only).** The assistant
  never sees stack secrets like admin tokens or HMAC keys.
- **No other container mounts vault.** Guardian, scheduler, and memory receive
  secrets via Compose env loading and service environment blocks.
- **Never commit `stack.env` or `user.env` to version control.** The
  `.gitignore` excludes them. Only the `.env.schema` files are tracked.

## Environment variable reference

The `.env.schema` files document every supported variable with type
annotations, defaults, and sensitivity flags. Use them as templates:

```bash
# Create env files from schemas
cp vault/stack/stack.env.schema vault/stack/stack.env
cp vault/user/user.env.schema  vault/user/user.env

# Edit with your values
$EDITOR vault/stack/stack.env
$EDITOR vault/user/user.env
```

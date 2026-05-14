# vault/

Secrets boundary. This directory contains sensitive environment files that
are passed to Docker Compose via `--env-file` flags. The separation between
`stack/` and `user/` enforces different ownership and access policies.

## Structure

```
vault/
  stack/
    stack.env       System-managed runtime env and secrets
    guardian.env    Channel HMAC secrets (loaded by guardian)
    auth.json       OpenCode auth state mounted into assistant
  user/
    user.env        User extension file (custom vars, LLM provider keys)
```

The four `.env.schema` files that used to live here (`stack.env.schema`,
`guardian.env.schema`, `user.env.schema`, `redact.env.schema`) were retired
in #391 along with the varlock binary. Secret hygiene now flows through
`akm vault`; log redaction is enforced in-process by the shared logger
(`packages/lib/src/logger.ts`), which masks any value whose key matches
`_TOKEN | _SECRET | _KEY | _PASSWORD`.

## Ownership

| File | Owner | Who writes | Who reads |
|------|-------|------------|-----------|
| `stack/stack.env` | System | CLI install, admin API | Docker Compose and service env wiring |
| `stack/guardian.env` | System | CLI install, admin API (channel add/remove) | Guardian (env_file + GUARDIAN_SECRETS_PATH), Docker Compose. Not shipped in the bundle; created by the CLI installer when the first channel is installed. Compose marks it `required: false`. |
| `stack/auth.json` | System-managed runtime auth | CLI/admin | Assistant file mount |
| `user/user.env` | User | User directly (custom extensions only) | Docker Compose, assistant (read-only mount) |

## Security rules

- **Only admin mounts full `vault/` (read-write).** This is required for the
  admin API to manage stack secrets and channel HMAC keys.
- **Assistant mounts `vault/user/` (the directory, rw).** The assistant
  never sees stack secrets like admin tokens or HMAC keys.
- **No other container mounts vault.** Guardian and memory receive secrets
  via Compose env loading and service environment blocks. The scheduler is
  not a separate container — it runs as a co-process inside the assistant
  and inherits the assistant's environment posture.
- **Never commit `stack.env` or `user.env` to version control.** The
  `.gitignore` excludes them.

## Editing env files

The runtime `.env` files are operator-managed. Edit them directly:

```bash
$EDITOR vault/stack/stack.env
$EDITOR vault/user/user.env
```

For programmatic key/value storage that flows through the akm secret store,
use `akm vault set <ref> <key>` (or the admin UI).

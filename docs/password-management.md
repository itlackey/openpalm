# Password & Secret Management

OpenPalm uses a layered secret management system built around a `vault/` directory boundary, pluggable backends, and strict container isolation. Secrets are never returned over the API and are redacted from container logs at runtime.

## Vault Layout

All secrets live under `~/.openpalm/vault/` (or `$OP_HOME/vault/`):

```
~/.openpalm/vault/
  user.env            # User-editable secrets (LLM API keys, provider URLs)
  user.env.schema     # Varlock schema for user.env
  system.env          # System-managed secrets (tokens, HMAC, paths)
  system.env.schema   # Varlock schema for system.env
```

The vault directory is created with `0700` permissions. All files inside are `0600`. Only the file owner can read or write them.

## Two-File Environment Model

Secrets are split across two files based on who owns them:

### vault/user.env (User-Editable)

Contains LLM API keys, provider configuration, and owner info. This file is:

- **Hot-reloadable** -- the assistant picks up changes within seconds
- **Never overwritten** by automatic lifecycle operations (install, update, startup)
- **Mounted read-only** into the assistant container as a single file

| Key | Sensitive | Notes |
|-----|-----------|-------|
| `OPENAI_API_KEY` | Yes | OpenAI provider key |
| `ANTHROPIC_API_KEY` | Yes | Anthropic provider key |
| `GROQ_API_KEY` | Yes | Groq provider key |
| `MISTRAL_API_KEY` | Yes | Mistral provider key |
| `GOOGLE_API_KEY` | Yes | Google AI provider key |
| `MCP_API_KEY` | Yes | MCP service key |
| `EMBEDDING_API_KEY` | Yes | Embedding provider key |
| `OPENVIKING_API_KEY` | Yes | OpenViking integration key |
| `SYSTEM_LLM_PROVIDER` | No | LLM provider name |
| `SYSTEM_LLM_BASE_URL` | No | LLM provider base URL |
| `SYSTEM_LLM_MODEL` | No | Default model name |
| `EMBEDDING_MODEL` | No | Embedding model name |
| `EMBEDDING_DIMS` | No | Embedding dimensions |
| `MEMORY_USER_ID` | No | Memory system user ID |
| `OWNER_NAME` | No | Operator display name |
| `OWNER_EMAIL` | No | Operator email |

### vault/system.env (System-Managed)

Contains tokens, service auth credentials, port bindings, and runtime paths. This file is:

- **Written only by the CLI or admin** during install, setup, or upgrade
- **Not hot-reloadable** -- changes require a stack restart
- **Never mounted directly** into non-admin containers (values are injected via compose `${VAR}` substitution)

| Key | Sensitive | Notes |
|-----|-----------|-------|
| `OP_ADMIN_TOKEN` | Yes | Admin API authentication |
| `ASSISTANT_TOKEN` | Yes | Assistant/scheduler API authentication |
| `MEMORY_AUTH_TOKEN` | Yes | Memory service authentication |
| `OPENCODE_SERVER_PASSWORD` | Yes | OpenCode web UI password |
| `OP_HOME` | No | OpenPalm root directory path |
| `OP_ASSISTANT_PORT` | No | Assistant port (default 3800) |
| `OP_ADMIN_PORT` | No | Admin port (default 3880) |
| `OP_GUARDIAN_PORT` | No | Guardian port (default 3899) |
| `OP_MEMORY_PORT` | No | Memory port (default 3898) |
| `CHANNEL_*_SECRET` | Yes | Per-channel HMAC secrets |

## Container Mount Contract

The vault boundary is enforced through Docker Compose volume mounts:

| Container | Vault Access | Mount |
|-----------|-------------|-------|
| **Admin** | Full vault (rw) | `${OP_HOME}:/openpalm` |
| **Assistant** | `user.env` only (ro) | `vault/user/user.env:/etc/openpalm-vault/user.env:ro` |
| **Guardian** | None | Receives secrets via `env_file` at startup |
| **Memory** | None | Receives secrets via `${VAR}` substitution |
| **Scheduler** | None | Receives secrets via `${VAR}` substitution |

Only the admin container has write access to the vault. The assistant can read `user.env` but cannot see system secrets like `OP_ADMIN_TOKEN`.

## Authentication Tokens

OpenPalm uses two distinct authentication tokens:

### OP_ADMIN_TOKEN

- Set during initial setup (user-provided or generated)
- Required for privileged operations: secrets management, install/uninstall, connections, upgrade
- Sent via the `x-admin-token` HTTP header

### ASSISTANT_TOKEN

- Auto-generated during install (32 random hex characters)
- Used by the assistant and scheduler for operational API calls
- Grants access to non-privileged endpoints: container management, logs, registry, automations
- Also sent via the `x-admin-token` header (same header, different credential)

Token comparison uses SHA-256 hashing with `timingSafeEqual` to prevent timing attacks.

### Route Authorization

Admin routes are classified into two tiers:

| Auth Level | Endpoints | Who Can Call |
|-----------|-----------|-------------|
| `requireAdmin` | `/admin/secrets/*`, `/admin/connections/*`, `/admin/install`, `/admin/uninstall`, `/admin/upgrade` | Admin token only |
| `requireAuth` | `/admin/containers/*`, `/admin/channels/*`, `/admin/logs`, `/admin/registry/*`, `/admin/automations`, `/admin/audit` | Admin or assistant token |

## Secret Backends

OpenPalm supports pluggable secret backends through the `SecretBackend` interface. The active backend is detected automatically.

### PlaintextBackend (Default)

The default backend stores secrets directly in `vault/user.env` and `vault/system.env`. No additional setup is required.

Secrets are routed to the correct file based on scope:
- **User scope** (API keys, custom secrets) go to `vault/user.env`
- **System scope** (tokens, component secrets) go to `vault/system.env`

For component and custom secrets that don't have a predefined env var name, the backend generates a deterministic key: `OP_SECRET_<SHA256-HASH>`.

### PassBackend (Encrypted)

The `pass` backend stores secrets in a GPG-encrypted password store. It requires:
- GPG key pair available in the admin container's keyring
- The `pass` CLI (installed in the admin Docker image)

#### Setting Up Encrypted Secrets

1. **Generate or import a GPG key** on your host:
   ```bash
   gpg --gen-key
   ```

2. **Initialize the pass store:**
   ```bash
   ./scripts/pass-init.sh --gpg-id your-email@example.com
   ```

   This creates:
   - `~/.openpalm/data/secrets/pass-store/` -- the encrypted store
   - `~/.openpalm/data/secrets/provider.json` -- backend configuration

3. **Restart the stack** to pick up the new backend.

The pass store is scoped to the OpenPalm installation. Entry names follow a canonical hierarchy:

```
openpalm/admin-token
openpalm/assistant-token
openpalm/openai/api-key
openpalm/component/<instance-id>/<field-name>
openpalm/custom/<user-defined-key>
```

Entry names are validated to prevent path traversal -- only lowercase alphanumeric characters, dots, hyphens, and forward slashes are allowed.

#### Provider Configuration

The backend selection is stored in `~/.openpalm/data/secrets/provider.json`:

```json
{
  "provider": "pass",
  "passwordStoreDir": "/home/user/.openpalm/data/secrets/pass-store",
  "passPrefix": "openpalm"
}
```

If this file doesn't exist, the plaintext backend is used.

## Secrets API

The admin exposes four endpoints for secret management. All require the admin token and never return secret values.

### List Secrets

```
GET /admin/secrets?prefix=openpalm/
```

Returns metadata for all secrets:
```json
{
  "provider": "plaintext",
  "capabilities": { "generate": true, "remove": true, "rename": false },
  "entries": [
    {
      "key": "openpalm/openai/api-key",
      "scope": "user",
      "kind": "core",
      "provider": "plaintext",
      "present": true,
      "envKey": "OPENAI_API_KEY"
    }
  ]
}
```

### Write a Secret

```
POST /admin/secrets
Content-Type: application/json

{ "key": "openpalm/custom/my-service-token", "value": "sk-..." }
```

### Generate a Random Secret

```
POST /admin/secrets/generate
Content-Type: application/json

{ "key": "openpalm/custom/webhook-secret", "length": 64 }
```

Generates a cryptographically random hex value (length 16-4096, default 32).

### Remove a Secret

```
DELETE /admin/secrets?key=openpalm/custom/my-service-token
```

All operations are audit-logged to `~/.openpalm/logs/admin-audit.jsonl` with actor attribution (admin vs assistant), action type, and request ID.

## Secret Key Hierarchy

Secrets are organized into three scopes:

| Scope | Key Pattern | File (Plaintext) | Example |
|-------|-------------|-------------------|---------|
| **Core** | `openpalm/<name>` | user.env or system.env | `openpalm/openai/api-key` |
| **Component** | `openpalm/component/<instance>/<field>` | system.env | `openpalm/component/my-discord/bot-token` |
| **Custom** | `openpalm/custom/<name>` | user.env | `openpalm/custom/webhook-secret` |

Core mappings are static (12 predefined keys). Component mappings are derived from `.env.schema` files with `@sensitive` annotations. Custom mappings are user-created via the API.

## Component Sensitive Fields

When a component's `.env.schema` marks a field as `@sensitive`, the secret backend manages it automatically:

```ini
# --- Discord Configuration ---
# Discord bot token
# @type=string @required @sensitive
DISCORD_BOT_TOKEN=
```

The lifecycle is:
1. **On instance creation** -- sensitive fields are registered with the secret backend under `openpalm/component/<instance-id>/<field-name>`
2. **On configuration** -- values for sensitive fields are written through the backend, not stored in the instance `.env` file
3. **On instance deletion** -- sensitive field registrations are removed and backend entries cleaned up

Registrations are tracked in `~/.openpalm/data/secrets/component-secrets.json`.

## Runtime Log Redaction

Varlock wraps container processes to prevent secrets from leaking into Docker logs. The `assets/redact.env.schema` file lists all sensitive env vars. Any matching values in stdout/stderr output are replaced with `[REDACTED]`.

The redact schema is regenerated during configuration persistence to stay in sync with `@sensitive` declarations in the vault schemas.

## Dev Environment

For local development with the plaintext backend:

```bash
./scripts/dev-setup.sh --seed-env
```

This seeds `vault/user.env` and `vault/system.env` with dev-safe defaults including `dev-admin-token`.

For development with encrypted secrets:

```bash
./scripts/dev-setup.sh --seed-env --pass --gpg-id your-key@example.com
```

This initializes a pass store under `.dev/data/secrets/pass-store/` and seeds test entries.

## Upgrading from v0.9.x

Older installs used `secrets.env` and `stack.env` under XDG directories. The migration path:

1. Run `openpalm migrate` to move files into the `~/.openpalm/` layout
2. The migrate command splits `secrets.env` into `vault/user.env` (API keys) and `vault/system.env` (tokens)
3. If `ASSISTANT_TOKEN` is missing, it is auto-generated and written to `vault/system.env`
4. Old files are preserved until `openpalm migrate --cleanup` is run

The admin UI shows a migration banner when a legacy installation is detected.

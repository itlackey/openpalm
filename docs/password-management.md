# Password & Secret Management

OpenPalm keeps secrets in two separate locations: user secrets under `~/.openpalm/stash/vaults/`
and stack secrets under `~/.openpalm/config/stack/`.
The current model is simple: one user-managed override env, one stack env,
and one guardian secret env.

---

## Secret layout

```text
~/.openpalm/
  config/stack/
    stack.env
    guardian.env
  stash/vaults/
    user.env
```

- `stash/vaults/user.env` is the recommended user-managed override file for addon and operator values.
- `config/stack/stack.env` is system-managed runtime env + secrets.
- `config/stack/guardian.env` holds channel HMAC secrets.
- Compose is run with both files, usually as:
  `--env-file ../config/stack/stack.env --env-file ../stash/vaults/user.env`.

---

## `stash/vaults/user.env`

This file is for user-managed addon overrides, operator values, and custom preferences.
It starts empty and is never overwritten by normal lifecycle operations.

Behavior:

- safe to edit directly on the host
- mounted into the assistant via the `stash/vaults/` directory mount
- also passed as container environment via Compose
- not overwritten by normal lifecycle operations

---

## `config/stack/stack.env`

This file is for stack-level tokens, host paths, ports, API keys, provider
configuration, and other runtime settings used by Compose.

Important keys include:

| Key | Notes |
|---|---|
| `OP_UI_TOKEN` | Admin UI/API authentication token |
| `OP_ASSISTANT_TOKEN` | Assistant auth token for admin API access (also used by the scheduler co-process inside the assistant container) |
| `OP_HOME` | OpenPalm home directory |
| `OP_UID` / `OP_GID` | Host user/group mapping |
| `OP_IMAGE_NAMESPACE` / `OP_IMAGE_TAG` | Image source and tag |
| `OP_ASSISTANT_PORT` | Assistant host port, default `3800` |
| `OP_ADMIN_PORT` | Admin host port, default `3880` |
| `OP_CHAT_PORT` | Chat addon host port, default `3820` |
| `OP_API_PORT` | API addon host port, default `3821` |
| `OP_VOICE_PORT` | Voice addon host port, default `3810` |
| `OP_ASSISTANT_SSH_PORT` | Optional assistant SSH port, default `2222` |
| `OWNER_NAME` | Operator display name |
| `OWNER_EMAIL` | Operator email |
| `OPENAI_API_KEY` | OpenAI-compatible provider key |
| `OPENAI_BASE_URL` | Alternate OpenAI-compatible endpoint |
| `ANTHROPIC_API_KEY` | Anthropic key |
| `GROQ_API_KEY` | Groq key |
| `MISTRAL_API_KEY` | Mistral key |
| `GOOGLE_API_KEY` | Google AI key |

> **Note:** LLM and embedding configuration lives in `config/akm/config.json`, not in `stack.env`. The `OP_CAP_*` capability variables were removed in v0.11.0.

Behavior:

- read directly by Docker Compose
- normally written by CLI/admin tooling, but still plain text on the host
- changes usually require recreating containers to take effect

---

## Container access rules

| Container | Secret access | Notes |
|---|---|---|
| `admin` addon | full `~/.openpalm/` bind mount | Only service with broad visibility |
| `assistant` | `stash/vaults/` only | Directory mount plus env injection |
| `guardian` | no vault mount | Reads needed values from Compose env |

The scheduler is not a separate container — it runs as a co-process inside the
assistant container and inherits the assistant's environment and mounts.

The assistant does not mount the full `config/stack/` directory and does not get broad
access to stack secrets by filesystem path.

---

## Authentication tokens

### `OP_UI_TOKEN`

- primary admin credential
- used for privileged admin UI/API operations
- sent in the `x-admin-token` header

### `OP_ASSISTANT_TOKEN`

- separate operational token for the assistant (and the scheduler co-process that runs inside it)
- exposed inside the assistant as `OP_ASSISTANT_TOKEN`
- also sent in the `x-admin-token` header when assistant tooling or the scheduler calls the admin API

OpenPalm does not use `Authorization: Bearer` for these admin endpoints.

---

## Optional encrypted backend

The default backend stores values in the two env files above. OpenPalm also has
an optional `pass` backend for encrypted storage.

When enabled, related metadata lives under `~/.openpalm/data/secrets/`, such as:

- `~/.openpalm/data/secrets/provider.json`
- `~/.openpalm/data/secrets/pass-store/`

If you are not explicitly using `pass`, assume the env files are the active
source of truth.

---

## Practical guidance

- Edit `~/.openpalm/config/stack/stack.env` when changing API keys, provider
  settings, ports, paths, or stack-level tokens.
- Edit `~/.openpalm/stash/vaults/user.env` for optional user-managed extension
  settings and custom preferences.
- Back up the whole `~/.openpalm/stash/vaults/` and `~/.openpalm/config/stack/` trees.
- Never commit real env values from either file.

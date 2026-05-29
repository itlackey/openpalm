# Password & Secret Management

OpenPalm keeps user secrets under `~/.openpalm/stash/vaults/` and system-managed
service secrets under `~/.openpalm/config/stack/secrets/`. `stack.env` is
non-secret runtime configuration only.

---

## Secret layout

```text
~/.openpalm/
  config/stack/
    stack.env
    secrets/
  stash/vaults/
    user.env
```

- `stash/vaults/user.env` is the AKM vault backing file for user-managed secrets.
- `config/stack/stack.env` is system-managed non-secret runtime env.
- `config/stack/secrets/` holds system-managed secret files; directory mode is `0700`, files are `0600`.
- Compose is run with `--env-file ../config/stack/stack.env` for non-secret substitution only.

---

## `stash/vaults/user.env`

This file is for the AKM user vault. It starts empty and is never overwritten by normal lifecycle operations.

Behavior:

- safe to edit directly on the host
- available to the assistant through the `/akm` stash mount and `akm vault:user`
- never passed as container environment via Compose
- not overwritten by normal lifecycle operations

---

## `config/stack/stack.env`

This file is for host paths, ports, image tags, profiles, and other non-secret
runtime settings used by Compose.

Important keys include:

| Key | Notes |
|---|---|
| `OP_HOME` | OpenPalm home directory |
| `OP_UID` / `OP_GID` | Host user/group mapping |
| `OP_IMAGE_NAMESPACE` / `OP_IMAGE_TAG` | Image source and tag |
| `OP_ASSISTANT_PORT` | Assistant host port, default `3800` |
| `OP_ADMIN_PORT` | Admin host port, default `3880` |
| `OP_CHAT_PORT` | Chat addon host port, default `3820` |
| `OP_API_PORT` | API addon host port, default `3821` |
| `OP_VOICE_PORT` | Voice addon host port, default `3810` |
| `OP_ASSISTANT_SSH_PORT` | Optional assistant SSH port, default `2222` |
| `OPENAI_BASE_URL` | Alternate OpenAI-compatible endpoint |

> **Note:** LLM and embedding configuration lives in `config/akm/config.json`, not in `stack.env`.

Behavior:

- read directly by Docker Compose for non-secret substitution
- normally written by CLI/admin tooling
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

## Authentication

### `OP_UI_LOGIN_PASSWORD`

- single password for the admin UI
- set during setup; a secure value is auto-generated if you do not supply one
- used to log in at the admin UI; the session is maintained via a cookie

The admin UI does not use token headers for browser sessions. The assistant
communicates with the admin API internally and does not require a separate
user-facing credential.

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

# Password & Secret Management

OpenPalm keeps user-managed env config under `~/.openpalm/knowledge/env/` and
system-managed service secrets under `~/.openpalm/knowledge/secrets/`. `stack.env`
is non-secret runtime configuration only.

---

## Secret layout

```text
~/.openpalm/
  knowledge/env/
    stack.env        # system-managed, non-secret (Compose --env-file)
    user.env         # user-managed env
  knowledge/secrets/ # system-managed secret files (auth.json, op_ui_login_password, …)
  config/stack/      # compose assembly only (no secrets/env)
```

- `knowledge/env/user.env` is the AKM env backing file for user-managed secrets.
- `state/stack.env` is system-managed non-secret runtime env.
- `knowledge/secrets/` holds system-managed secret files; directory mode is `0700`, files are `0600`.
- Compose is run with `--env-file ../../state/stack.env` from `config/stack/` for non-secret substitution only.

---

## `knowledge/env/user.env`

This file is for the AKM user env. It starts empty and is never overwritten by normal lifecycle operations.

Behavior:

- safe to edit directly on the host
- available to the assistant through the `/stash` mount and `akm env:user`
- never passed as container environment via Compose
- not overwritten by normal lifecycle operations

---

## `state/stack.env`

This file is for host paths, ports, image tags, profiles, and other non-secret
runtime settings used by Compose.

Important keys include:

| Key | Notes |
|---|---|
| `OP_HOME` | OpenPalm home directory |
| `OP_UID` / `OP_GID` | Host user/group mapping |
| `OP_IMAGE_NAMESPACE` / `OP_IMAGE_TAG` | Image source and tag |
| `OP_UI_PORT` | Assistant chat UI host port, default `3800` |
| `OP_ASSISTANT_PORT` | Assistant OpenCode host port, default `3810` |
| `OP_HOST_UI_PORT` | Admin UI host port, default `3880` |
| `OP_CHAT_PORT` | Chat addon host port, default `3820` |
| `OP_API_PORT` | API addon host port, default `3821` |
| `OP_VOICE_PORT_HOST` | Voice addon host port, default `8880` |
| `OPENAI_BASE_URL` | Alternate OpenAI-compatible endpoint |

> **Note:** LLM and embedding configuration lives in `config/akm/config.json`, not in `stack.env`.

Behavior:

- read directly by Docker Compose for non-secret substitution
- normally written by CLI/admin tooling
- changes usually require recreating containers to take effect

---

## Container access rules

| Component | Secret access | Notes |
|---|---|---|
| Admin UI (host process) | direct host filesystem access | Runs on the host as `openpalm ui serve`; no container or bind mount needed |
| `assistant` | `knowledge/` (`/stash`) only | Stash mount plus `akm env:user` injection |
| `guardian` | no secret-dir mount | Reads needed values from Compose secrets |

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

- Edit `~/.openpalm/state/stack.env` for **non-secret** settings only —
  ports, host paths, image tags. Provider **API keys** go in
  `~/.openpalm/knowledge/secrets/auth.json` (via the Connections tab), and the
  UI login password in `~/.openpalm/knowledge/secrets/op_ui_login_password` —
  never in `stack.env`.
- Edit `~/.openpalm/knowledge/env/user.env` for optional user-managed extension
  settings and custom preferences.
- Back up the whole `~/.openpalm/knowledge/env/`, `~/.openpalm/knowledge/secrets/`, and `~/.openpalm/config/stack/` trees.
- Never commit real env values from either file.

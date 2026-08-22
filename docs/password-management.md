# Password & Secret Management

OpenPalm separates assistant-readable provider auth from credentials delegated
to host, Guardian, API, portal, and bot processes.

## Secret Layout

```text
~/.openpalm/
  state/
    stack.env                 # sole Compose env file; non-secret
    secrets/                  # delegated service secrets; never mounted as a tree
  knowledge/
    secrets/
      auth.json               # assistant-readable OpenCode provider auth only
    env/
      user.env                # AKM user env, loaded on demand
```

Directories are created with mode `0700` and secret files with mode `0600`.

## Delegated Secrets

`state/secrets/` contains credentials that the assistant must not read:

- `op_ui_login_password`
- `op_opencode_password`
- `op_guardian_admin_token`
- `op_guardian_mcp_token`
- `op_api_key`
- `portal_<id>_secret`
- Discord and Slack bot/app tokens

Compose grants each service only its required files and exposes their paths
through `*_FILE` variables. The assistant does not receive a bind mount of
`state/secrets/`.

`knowledge/secrets/auth.json` is the exception because the assistant's OpenCode
runtime needs provider credentials. Guardian receives the same file through a
narrow Compose secret grant rather than a `knowledge/` tree mount.

## `knowledge/env/user.env`

This is the AKM user env backing file. It is:

- safe to edit directly on the host
- available to assistant tools through `akm env run user -- <command>`
- loaded only on demand in the tool subprocess that needs it
- not sourced by the assistant entrypoint
- never passed to Docker Compose or inherited by the OpenCode server process
- preserved by normal lifecycle operations

## `state/stack.env`

`state/stack.env` is the sole Compose `--env-file`. It contains only
non-secret runtime values and app records, including:

- `OP_HOME`, `OP_UID`, `OP_GID`, and `OP_PROJECT_NAME`
- image version pins
- host ports
- flat listener bind addresses
- `OP_ENABLED_ADDONS` and hardware profile selections
- `OP_SETUP_COMPLETE`

Do not place passwords, tokens, API keys, or credential JSON in this file.

## UI Authentication

The UI login password is stored at:

```text
~/.openpalm/state/secrets/op_ui_login_password
```

Browser login uses `POST /api/auth/login`. A successful login issues the
`op_session` cookie with `HttpOnly` and `SameSite=Lax`; browser sessions do not
use a bearer token or `localStorage` credential.

Reset a lost password from the host:

```bash
openpalm reset-password
# or
openpalm reset-password --password 'a-new-password'
```

The assistant has no admin credential and no network path to the host admin
process. It does not authenticate to or call the host API on the operator's
behalf.

## Provider Credentials

Use the provider flow in the UI, or maintain OpenCode's auth file directly:

```text
~/.openpalm/knowledge/secrets/auth.json
```

Its shape is owned by OpenCode. A basic API-key entry looks like:

```json
{
  "openai": {
    "type": "api",
    "key": "sk-..."
  }
}
```

Recreate OpenCode processes after changing provider auth if they have already
cached the old credentials.

## Rotation

Use OpenPalm's setup/admin flows where available. For a delegated file under
`state/secrets/`, a manual rotation should:

1. Write a temporary replacement with mode `0600`, then atomically rename it over the old file.
2. Recreate every service that reads that secret at startup.
3. For a portal principal, replace its one shared host file and recreate both Guardian and that portal.

`docker compose restart` does not recreate secret mounts. Use the same full
Compose file/profile set with `up -d --force-recreate` when a startup-only
secret changes.

`knowledge/secrets/auth.json` is a bind-mounted file. Prefer the provider UI;
if editing it directly, update the file in place and then recreate OpenCode
processes so a bind mount is not left on a replaced inode.

## Backups

Back up `state/`, `knowledge/`, `config/`, and `system/` together.
A full `OP_HOME` archive naturally includes both secret trees. See
[Backup & Restore](backup-restore.md).

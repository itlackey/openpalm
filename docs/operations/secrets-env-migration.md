# Secrets & Env Layout Migration (manual)

OpenPalm reorganized where env files and secrets live under `OP_HOME`
(`~/.openpalm` by default) to align with the akm `env` + `secret` asset model
and to keep **`config/stack/` free of secrets and env files**. There is **no
automated migration** — move your files by hand using the steps below, then
recreate the stack.

> Stop the stack before migrating so nothing reads the old paths mid-move:
> `openpalm down` (or `docker compose … down`).

## What moved

| Old location | New location | akm asset |
|---|---|---|
| `knowledge/vaults/user.env` | `knowledge/env/user.env` | `env:user` |
| `knowledge/vaults/secrets/<name>` | `knowledge/secrets/<name>` | `secret:<name>` |
| `knowledge/vaults/.gws/` | `knowledge/secrets/.gws/` | (gws-setup creds) |
| `config/stack/stack.env` | `knowledge/env/stack.env` | `env:stack` |
| `config/stack/auth.json` | `knowledge/secrets/auth.json` | (OpenCode auth store) |

After migrating, `config/stack/` contains only the compose assembly
(`core.compose.yml`, `services.compose.yml`, `channels.compose.yml`,
`custom.compose.yml`, `stack.yml`) — no `stack.env`, no `auth.json`, no secrets.

## Steps

Run from your `OP_HOME` (e.g. `cd ~/.openpalm`).

```sh
# 1. Create the new directories with correct permissions.
mkdir -p knowledge/env knowledge/secrets
chmod 700 knowledge/env knowledge/secrets

# 2. User env (vault:user → env:user).
[ -f knowledge/vaults/user.env ] && mv knowledge/vaults/user.env knowledge/env/user.env
chmod 600 knowledge/env/user.env 2>/dev/null || true

# 3. Stack env (config/stack/stack.env → knowledge/env/stack.env).
[ -f config/stack/stack.env ] && mv config/stack/stack.env knowledge/env/stack.env
chmod 600 knowledge/env/stack.env 2>/dev/null || true

# 4. OpenCode auth store (config/stack/auth.json → knowledge/secrets/auth.json).
[ -f config/stack/auth.json ] && mv config/stack/auth.json knowledge/secrets/auth.json
chmod 600 knowledge/secrets/auth.json 2>/dev/null || true

# 5. Stack secret files (knowledge/vaults/secrets/* → knowledge/secrets/).
if [ -d knowledge/vaults/secrets ]; then
  mv knowledge/vaults/secrets/* knowledge/secrets/ 2>/dev/null || true
fi
chmod 600 knowledge/secrets/* 2>/dev/null || true

# 6. gws-setup credentials, if you use them (knowledge/vaults/.gws → knowledge/secrets/.gws).
[ -d knowledge/vaults/.gws ] && mv knowledge/vaults/.gws knowledge/secrets/.gws

# 7. Remove the now-empty legacy directory.
rmdir knowledge/vaults/secrets knowledge/vaults 2>/dev/null || true
```

> If you keep other files under the old `knowledge/vaults/` that aren't listed
> here, move them somewhere you'll remember before removing the directory —
> step 7 only removes it when empty.

## Verify

```sh
# New files exist with 0600 perms:
ls -l knowledge/env/user.env knowledge/env/stack.env knowledge/secrets/auth.json

# config/stack/ holds only compose assembly (no stack.env / auth.json / secrets):
ls -l config/stack/

# akm resolves the env/secret refs (akm >= the env-enabled prerelease):
akm env path env:user
akm env path env:stack
akm secret list
```

Then bring the stack back up:

```sh
openpalm up        # or your usual docker compose … up -d
```

The CLI/admin UI reads these new locations directly; the compose files mount
`knowledge/secrets/auth.json` into the assistant and guardian, and use
`knowledge/env/stack.env` as the Compose `--env-file`. The assistant entrypoint
sources `knowledge/env/user.env` at startup.

## Notes

- **Provider credentials** live in `knowledge/secrets/auth.json` (OpenCode's
  native auth store). It is bind-mounted into both OpenCode containers and is
  the only credential file that lives under `knowledge/secrets/` as a JSON
  document rather than a single-value secret file.
- **`stack.env` is non-secret** (ports, paths, image tags, profiles). Secret-like
  keys are rejected from it — keep tokens/passwords/keys in `knowledge/secrets/`.
- Because `knowledge/` is the assistant's read-write `/stash` mount, the
  assistant can read `knowledge/env/stack.env`. It contains no secrets, so this
  is intentional.

# Troubleshooting

Common problems and their fixes for the current compose-first OpenPalm model.

When in doubt, inspect the exact compose file set you started from
`~/.openpalm/config/stack/` and rerun that same file set explicitly.

> **Upgrading from 0.10.x?** Many post-upgrade issues (missing secrets, wrong UI
> port, stale addon state, wrong env paths) come from the changed file layout. See the
> [0.10.x → 0.11.0 upgrade guide](operations/upgrade-0.10-to-0.11.md).

---

## 1. Docker not found or daemon unavailable

**Symptoms:** `docker: command not found`, `Cannot connect to the Docker daemon`,
or Compose commands fail immediately.

**Fix:**

```bash
docker info
```

If that fails:

- install Docker Engine or Docker Desktop
- start the Docker daemon/Desktop app
- on Linux, add your user to the `docker` group if needed

```bash
sudo usermod -aG docker $USER
```

Then log out and back in.

---

## 2. Port conflicts

**Symptoms:** Compose reports `address already in use`.

Common defaults:

- `3800` assistant
- `3880` admin
- `3820` chat addon
- `3821` API addon
- `3810` voice addon

**Fix:** find the conflicting process:

```bash
lsof -i :3880
```

Then either stop that process or change the matching `OP_*_PORT` value in
`~/.openpalm/knowledge/env/stack.env`, then recreate the stack with the same
compose file set.

---

## 3. Admin UI will not load

**Symptoms:** `http://localhost:3880/` refuses the connection.

**Common causes:**

- the `openpalm` host process is not running
- `OP_HOST_UI_PORT` was changed in `stack.env`

**Fix:**

```bash
# Check if the host admin process is running
lsof -i :3880 || ss -tlnp | grep 3880

# Restart the admin process
openpalm
```

---

## 4. Wrong services started

**Symptoms:** an expected addon is missing, or an unexpected stack shape is
running.

**Cause:** Docker Compose only deploys the files you pass with `-f`.

**Fix:** rerun the stack with the correct profile set. Example:

```bash
cd "$HOME/.openpalm/config/stack"
docker compose \
  -f core.compose.yml \
  -f portals.compose.yml \
  --profile addon.chat \
  --env-file ../../knowledge/env/stack.env \
  up -d
```

The enabled addon names in `OP_ENABLED_ADDONS` inside `~/.openpalm/knowledge/env/stack.env` are used by OpenPalm
tooling to build the `--profile` arguments. Manual invocations must pass them
explicitly.

---

## 5. Assistant not responding

**Symptoms:** channels accept requests, but no reply comes back.

**Fix:**

1. check the assistant container status and logs
2. verify at least one provider is configured in OpenCode auth state or `~/.openpalm/knowledge/secrets/`
3. confirm the provider endpoint is reachable from Docker if you use a local model server

Useful checks:

```bash
ls ~/.openpalm/knowledge/secrets
grep -E 'BASE_URL' ~/.openpalm/knowledge/env/stack.env
```

```bash
cd "$HOME/.openpalm/config/stack"
docker compose \
  -f core.compose.yml \
  --env-file ../../knowledge/env/stack.env \
  logs assistant
```

---

## 6. Ollama or another local model endpoint is not reachable

**Symptoms:** the host service works locally, but containers cannot reach it.

**Cause:** containers cannot use the host's `localhost`.

**Fix:** use `host.docker.internal` from inside containers. Example:

```env
OPENAI_BASE_URL=http://host.docker.internal:11434/v1
```

Then recreate any services that depend on that value.

---

## 7. Portal auth or guardian ingress errors

**Symptoms:** portal containers return `401`, `403`, or guardian authorization errors.

**Fix:**

- verify the portal addon is part of the compose file set you started
- check `~/.openpalm/knowledge/secrets/` for the relevant principal secret file and verify the service has a matching `PRINCIPAL_SECRET_FILE` grant
- recreate the affected portal and guardian services after changing secrets

There is no separate staging/artifacts file to inspect in the current model; the
live non-secret values come straight from `knowledge/env/stack.env`; service secrets come from `knowledge/secrets/`.

---

## 8. Permission denied on mounted files

**Symptoms:** containers cannot write to `~/.openpalm/`, or files end up owned by
the wrong user.

**Fix:** verify ownership and the UID/GID values in
`~/.openpalm/knowledge/env/stack.env`:

```bash
grep -E 'OP_UID|OP_GID' ~/.openpalm/knowledge/env/stack.env
id -u
id -g
sudo chown -R $(id -u):$(id -g) ~/.openpalm
```

Then recreate containers.

---

## 9. Services will not start after updating bundle files

**Symptoms:** after copying newer `.openpalm/` files, Compose fails or services
restart-loop.

**Fix:**

- compare your current `~/.openpalm/knowledge/env/stack.env` with the newer schema
- make sure any newly required variables are present
- rerun `docker compose pull` and then `docker compose up -d` with the same file set

There is no XDG staging or artifacts directory to clear. The live deployment is
the compose files under `~/.openpalm/config/stack/`, non-secret `stack.env`, and file-based secrets under `knowledge/secrets/`.

---

## 10. Factory reset

**Warning:** destructive.

```bash
cd "$HOME/.openpalm/config/stack"
docker compose \
  -f core.compose.yml \
  -f portals.compose.yml \
  --profile addon.chat \
  --env-file ../../knowledge/env/stack.env \
  down -v

rm -rf "$HOME/.openpalm"
```

Then copy a fresh `.openpalm/` bundle and start again.

If you are not sure which addons were running, prefer backing up `~/.openpalm/`
first and then removing it. See [backup-restore.md](backup-restore.md).

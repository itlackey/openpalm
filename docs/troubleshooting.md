# Troubleshooting

Common problems and their fixes for the current compose-first OpenPalm model.

When in doubt, inspect the exact compose file set you started from
`~/.openpalm/stack/` and rerun that same file set explicitly.

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
- `3881` admin OpenCode
- `3898` memory
- `3820` chat addon
- `3821` API addon
- `3810` voice addon

**Fix:** find the conflicting process:

```bash
lsof -i :3880
```

Then either stop that process or change the matching `OP_*_PORT` value in
`~/.openpalm/vault/stack/stack.env`, then recreate the stack with the same
compose file set.

---

## 3. Admin UI will not load

**Symptoms:** `http://localhost:3880/` refuses the connection.

**Common causes:**

- you did not include `addons/admin/compose.yml`
- the admin container is still starting
- `OP_ADMIN_PORT` was changed in `stack.env`

**Fix:**

```bash
cd "$HOME/.openpalm/stack"
docker compose \
  -f core.compose.yml \
  -f addons/admin/compose.yml \
  --env-file ../vault/stack/stack.env \
  --env-file ../vault/user/user.env \
  ps
```

Then inspect logs if needed:

```bash
docker compose \
  -f core.compose.yml \
  -f addons/admin/compose.yml \
  --env-file ../vault/stack/stack.env \
  --env-file ../vault/user/user.env \
  logs admin
```

---

## 4. Wrong services started

**Symptoms:** an expected addon is missing, or an unexpected stack shape is
running.

**Cause:** Docker Compose only deploys the files you pass with `-f`.

**Fix:** rerun the exact file set you want. Example:

```bash
cd "$HOME/.openpalm/stack"
docker compose \
  -f core.compose.yml \
  -f addons/admin/compose.yml \
  -f addons/chat/compose.yml \
  --env-file ../vault/stack/stack.env \
  --env-file ../vault/user/user.env \
  up -d
```

`~/.openpalm/config/stack.yml` does nothing by itself unless a helper script is
reading it.

---

## 5. Assistant not responding

**Symptoms:** channels accept requests, but no reply comes back.

**Fix:**

1. check the assistant container status and logs
2. verify at least one provider is configured in `~/.openpalm/vault/stack/stack.env`
3. confirm the provider endpoint is reachable from Docker if you use a local model server

Useful checks:

```bash
grep -E 'API_KEY|BASE_URL|OP_CAP_LLM_' ~/.openpalm/vault/stack/stack.env
```

```bash
cd "$HOME/.openpalm/stack"
docker compose \
  -f core.compose.yml \
  --env-file ../vault/stack/stack.env \
  --env-file ../vault/user/user.env \
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

## 7. Channel HMAC or auth errors

**Symptoms:** channel containers return `401`, `403`, or guardian verification errors.

**Fix:**

- verify the channel addon is part of the compose file set you started
- check `~/.openpalm/vault/stack/guardian.env` for the relevant `CHANNEL_*_SECRET`
- recreate the affected channel and guardian services after changing secrets

There is no separate staging/artifacts file to inspect in the current model; the
live values come straight from `vault/stack/stack.env`.

---

## 8. Permission denied on mounted files

**Symptoms:** containers cannot write to `~/.openpalm/`, or files end up owned by
the wrong user.

**Fix:** verify ownership and the UID/GID values in
`~/.openpalm/vault/stack/stack.env`:

```bash
grep -E 'OP_UID|OP_GID' ~/.openpalm/vault/stack/stack.env
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

- compare your current `~/.openpalm/vault/stack/stack.env` with the newer schema
- make sure any newly required variables are present
- rerun `docker compose pull` and then `docker compose up -d` with the same file set

There is no XDG staging or artifacts directory to clear. The live deployment is
the compose files under `~/.openpalm/stack/` plus the two vault env files.

---

## 10. Factory reset

**Warning:** destructive.

```bash
cd "$HOME/.openpalm/stack"
docker compose \
  -f core.compose.yml \
  -f addons/admin/compose.yml \
  -f addons/chat/compose.yml \
  --env-file ../vault/stack/stack.env \
  --env-file ../vault/user/user.env \
  down -v

rm -rf "$HOME/.openpalm"
```

Then copy a fresh `.openpalm/` bundle and start again.

If you are not sure which addons were running, prefer backing up `~/.openpalm/`
first and then removing it. See [backup-restore.md](backup-restore.md).

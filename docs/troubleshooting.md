# Troubleshooting

Common problems and their solutions. For setup-specific issues, see
also the troubleshooting section of [setup-guide.md](setup-guide.md).

---

## 1. Docker not found

**Symptoms:** Installer exits with "docker: command not found" or
"Cannot connect to the Docker daemon."

**Cause:** Docker Engine (Linux) or Docker Desktop (Mac/Windows) is not
installed or not running.

**Solution:**

```bash
# Verify Docker is running
docker info

# Linux: install Docker Engine
curl -fsSL https://get.docker.com | sh

# Linux: fix permission denied
sudo usermod -aG docker $USER
# Log out and back in for group change to take effect
```

On Mac/Windows, open Docker Desktop and wait for the green "Running" indicator
before retrying.

---

## 2. Port conflicts

**Symptoms:** Container exits immediately or `docker compose up` reports
"address already in use." Common ports: 8080 (Caddy ingress), 8100 (admin),
8765 (memory), 4096 (assistant).

**Cause:** Another process is already bound to the port.

**Solution:**

```bash
# Find what is using the port (example: 8080)
lsof -i :8080
# or
ss -tlnp | grep 8080
```

Either stop the conflicting process, or change the OpenPalm bind port by
editing `DATA_HOME/stack.env`:

```env
OPENPALM_INGRESS_PORT=9090
```

Then restart the stack:

```bash
docker compose down && docker compose up -d
```

The default Caddy ingress port is `8080` (see `OPENPALM_INGRESS_PORT` in
`docker-compose.yml`).

---

## 3. Setup wizard won't load

**Symptoms:** Browser shows connection refused or a blank page at
`http://localhost:8080/` after install.

**Cause:** The admin container is still starting (pulling images on first
boot can take several minutes) or the admin healthcheck hasn't passed yet.

**Solution:**

1. Check admin container status:
   ```bash
   docker logs openpalm-admin-1 --tail 50
   ```
2. If the admin is healthy but Caddy isn't routing, access the admin directly
   at `http://localhost:8100/setup`.
3. Wait up to 60 seconds on first boot for image pulls and healthcheck
   stabilization.

---

## 4. Memory service failures

**Symptoms:** Memory API returns 500 errors, assistant reports "memory
unavailable," or the memory container restart-loops.

**Cause:** Usually one of: sqlite-vec native module load failure, incorrect
Ollama URL, or embedding dimension mismatch.

**Solution:**

Check memory container logs:

```bash
docker logs openpalm-memory-1 --tail 50
```

Common fixes:

- **sqlite-vec load error:** The memory image requires glibc (it uses
  `oven/bun:1-debian`, not Alpine). If you are building locally, verify the
  base image.

- **Ollama URL:** When Ollama runs on the host (not in Docker), containers
  must reach it at `http://host.docker.internal:11434`, not `localhost`. Set
  this in `DATA_HOME/memory/default_config.json`:
  ```json
  {
    "llm": { "config": { "ollama_base_url": "http://host.docker.internal:11434" } },
    "embedder": { "config": { "ollama_base_url": "http://host.docker.internal:11434" } }
  }
  ```

- **Embedding dimension mismatch:** The configured `embedding_model_dims`
  must match the model. `nomic-embed-text` uses 768 dimensions. Mismatched
  dims cause silent vector storage failures.

---

## 5. Ollama not detected

**Symptoms:** Setup wizard or connection test reports "Ollama not available"
despite Ollama running on the host.

**Cause:** Containers cannot reach `localhost` on the host. Docker requires
the special hostname `host.docker.internal`.

**Solution:**

1. Verify Ollama is running on the host:
   ```bash
   curl http://localhost:11434/api/tags
   ```
2. Verify the container can reach it:
   ```bash
   docker exec openpalm-admin-1 curl http://host.docker.internal:11434/api/tags
   ```
3. Set the Ollama base URL to `http://host.docker.internal:11434` in the
   admin UI Connections page, or in `secrets.env`:
   ```env
   OPENAI_BASE_URL=http://host.docker.internal:11434/v1
   ```

The compose file includes `extra_hosts: host.docker.internal:host-gateway`
on relevant services.

---

## 6. Channel not connecting (HMAC errors)

**Symptoms:** Channel container logs show "401 Unauthorized" or "HMAC
verification failed" when sending messages to the guardian.

**Cause:** The channel's HMAC secret does not match what the guardian expects.
Secrets are auto-generated during channel install and stored in
`DATA_HOME/stack.env`.

**Solution:**

1. Verify the channel secret exists in `DATA_HOME/stack.env`:
   ```bash
   grep CHANNEL_ ~/.local/share/openpalm/stack.env
   ```
2. If missing, reinstall the channel via the admin API:
   ```bash
   curl -X POST http://localhost:8100/admin/channels/install \
     -H "x-admin-token: $ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"name": "chat"}'
   ```
3. After install, the admin runs an apply step that stages secrets to
   `STATE_HOME/artifacts/stack.env`. Verify the guardian can read the
   staged file:
   ```bash
   docker exec openpalm-guardian-1 cat /app/secrets/stack.env | grep CHANNEL_
   ```

---

## 7. Assistant not responding

**Symptoms:** Messages sent through a channel never receive a reply. The
guardian logs show the request was forwarded, but the assistant does not
respond.

**Cause:** The assistant container may be unhealthy, missing an LLM API key,
or unable to reach the configured provider.

**Solution:**

1. Check assistant health:
   ```bash
   docker inspect openpalm-assistant-1 --format '{{.State.Health.Status}}'
   ```
2. Check assistant logs:
   ```bash
   docker logs openpalm-assistant-1 --tail 50
   ```
3. Verify at least one LLM provider key is set in `CONFIG_HOME/secrets.env`:
   ```bash
   grep -E 'API_KEY|BASE_URL' ~/.config/openpalm/secrets.env
   ```
4. If using Ollama, confirm the model is pulled:
   ```bash
   curl http://localhost:11434/api/tags
   ```

---

## 8. Permission denied errors

**Symptoms:** Containers fail to start with "permission denied" on volume
mounts, or files created by containers are owned by root and cannot be
edited.

**Cause:** UID/GID mismatch between the host user and the container user.
Containers run as `OPENPALM_UID:OPENPALM_GID` (default 1000:1000).

**Solution:**

1. Fix ownership of OpenPalm directories:
   ```bash
   sudo chown -R $(id -u):$(id -g) \
     ~/.config/openpalm \
     ~/.local/share/openpalm \
     ~/.local/state/openpalm
   ```
2. Verify UID/GID in `DATA_HOME/stack.env` matches your host user:
   ```bash
   grep OPENPALM_UID ~/.local/share/openpalm/stack.env
   id -u
   ```
3. After fixing ownership, recreate containers (do NOT use `docker restart`
   -- it does not re-read env_file changes):
   ```bash
   docker compose up -d --force-recreate
   ```

---

## 9. Services won't start after update

**Symptoms:** After running the installer to update, containers fail to
start or enter a restart loop.

**Cause:** Stale staged artifacts in STATE_HOME, or a compose file version
mismatch between the new admin image and the old staged files.

**Solution:**

1. Check container logs for the specific error:
   ```bash
   docker compose logs --tail 20
   ```
2. Re-run the apply step by restarting the admin container (apply runs on
   startup):
   ```bash
   docker compose up -d --force-recreate admin
   ```
3. If the admin itself won't start, clear and re-stage artifacts manually:
   ```bash
   rm -rf ~/.local/state/openpalm/artifacts
   # Re-run the installer
   curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/v0.9.0-rc5/scripts/setup.sh | bash
   ```
4. Pull the latest images explicitly:
   ```bash
   docker compose pull
   docker compose up -d
   ```

---

## 10. Factory reset

**Symptoms:** Nothing else works, or you want a clean slate.

**Cause:** Corrupted state, incompatible config from a previous version, or
experimental changes that need reverting.

**Solution:**

Stop and remove all containers and volumes, then delete all OpenPalm
directories:

```bash
# Stop the stack and remove volumes
docker compose down -v

# Remove all OpenPalm data (DESTRUCTIVE)
rm -rf ~/.config/openpalm ~/.local/share/openpalm ~/.local/state/openpalm

# Re-run the installer
curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/v0.9.0-rc5/scripts/setup.sh | bash
```

On Windows (PowerShell):

```powershell
docker compose down -v
Remove-Item -Recurse -Force "$env:USERPROFILE\.config\openpalm", `
  "$env:USERPROFILE\.local\share\openpalm", `
  "$env:USERPROFILE\.local\state\openpalm"
irm https://raw.githubusercontent.com/itlackey/openpalm/v0.9.0-rc5/scripts/setup.ps1 | iex
```

This removes all configuration, data, and state. Back up CONFIG_HOME and
DATA_HOME first if you have data worth preserving. See
[backup-restore.md](backup-restore.md) for backup procedures.

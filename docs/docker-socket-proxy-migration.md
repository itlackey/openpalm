# Migrating to a Docker Socket Proxy

This document outlines how to replace the direct Docker socket mount in the
admin container with a [Docker socket proxy](https://github.com/Tecnativa/docker-socket-proxy),
and why that simplifies the current privilege-handling approach.

---

## Why consider a socket proxy?

The admin container currently mounts the Docker socket directly and uses an
entrypoint script (`docker-entrypoint.sh`) to handle a cross-runtime
compatibility issue: different Docker runtimes (Docker Desktop, OrbStack,
Colima) present the socket with different ownership inside containers. The
entrypoint starts as root, detects the socket's actual GID, creates a user
with the correct group membership, then drops privileges via gosu.

A socket proxy eliminates this entire class of problems:

| Concern | Direct socket mount | Socket proxy |
|---|---|---|
| Socket GID varies by runtime | Entrypoint must detect GID + create group + drop privileges | Not applicable — admin talks HTTP over TCP |
| Container runs as root (briefly) | Yes, for entrypoint setup | No — admin runs as non-root (`user:`) |
| gosu dependency | Required | Not needed |
| Docker API attack surface | Full API access | Allowlisted endpoints only |
| Compose complexity | Entrypoint + env vars for UID/GID/Docker GID | One extra service, simpler admin definition |

---

## What changes

### 1. Add a socket proxy service

```yaml
# docker-compose.yml — add before the admin service
docker-socket-proxy:
  image: tecnativa/docker-socket-proxy:latest
  restart: unless-stopped
  environment:
    # Static allowlist — covers all compose operations for any channel.
    # These are API endpoint categories, not per-container rules, so
    # adding/removing channels never requires changes here.
    CONTAINERS: 1
    NETWORKS: 1
    SERVICES: 1
    TASKS: 1
    INFO: 1
    VERSION: 1
    # Everything else denied by default (exec, volumes, images, etc.)
  volumes:
    - /var/run/docker.sock:/var/run/docker.sock:ro
  networks: [assistant_net]
```

The proxy container is the **only** container that mounts the socket. It runs
as root internally (required to read the socket) but only exposes a filtered
HTTP API on port 2375 within the `assistant_net` network.

### 2. Simplify the admin service

```yaml
admin:
  image: ${OPENPALM_IMAGE_NAMESPACE:-openpalm}/admin:${OPENPALM_IMAGE_TAG:-latest}
  restart: unless-stopped
  ports:
    - "127.0.0.1:8100:8100"
  environment:
    PORT: "8100"
    ADMIN_TOKEN: ${ADMIN_TOKEN:-}
    GUARDIAN_URL: http://guardian:8080
    OPENPALM_ASSISTANT_URL: http://assistant:4096
    OPENPALM_CONFIG_HOME: ${OPENPALM_CONFIG_HOME:-${HOME}/.config/openpalm}
    OPENPALM_STATE_HOME: ${OPENPALM_STATE_HOME:-${HOME}/.local/state/openpalm}
    OPENPALM_DATA_HOME: ${OPENPALM_DATA_HOME:-${HOME}/.local/share/openpalm}
    # Point Docker client at the proxy instead of a local socket
    DOCKER_HOST: tcp://docker-socket-proxy:2375
  env_file:
    - path: ${OPENPALM_STATE_HOME:-${HOME}/.local/state/openpalm}/artifacts/stack.env
      required: false
    - path: ${OPENPALM_STATE_HOME:-${HOME}/.local/state/openpalm}/artifacts/secrets.env
      required: false
  volumes:
    - ${OPENPALM_CONFIG_HOME:-${HOME}/.config/openpalm}:${OPENPALM_CONFIG_HOME:-${HOME}/.config/openpalm}
    - ${OPENPALM_STATE_HOME:-${HOME}/.local/state/openpalm}:${OPENPALM_STATE_HOME:-${HOME}/.local/state/openpalm}
    - ${OPENPALM_DATA_HOME:-${HOME}/.local/share/openpalm}:${OPENPALM_DATA_HOME:-${HOME}/.local/share/openpalm}
    # No Docker socket mount
  user: "${OPENPALM_UID:-1000}:${OPENPALM_GID:-1000}"
  networks: [assistant_net]
  depends_on: [docker-socket-proxy]
```

Key differences from the current definition:

- **`DOCKER_HOST`** points at the proxy over TCP — no socket mount needed
- **`user:`** is back — the admin runs as non-root with no entrypoint tricks
- **No `group_add:`** — no socket GID to worry about
- **No socket volume mount** — removed entirely

### 3. Remove the entrypoint

The Dockerfile reverts to a simple `CMD` with no `ENTRYPOINT`:

```dockerfile
# Remove these lines:
# COPY core/admin/docker-entrypoint.sh /usr/local/bin/
# ENTRYPOINT ["docker-entrypoint.sh"]

# Remove gosu from apt-get install

CMD ["node", "build/index.js"]
```

`docker-entrypoint.sh` and the `gosu` dependency can be deleted.

### 4. Update docker.ts to support DOCKER_HOST

The admin's Docker shell-out wrapper (`core/admin/src/lib/server/docker.ts`)
uses `execFile` to call `docker compose`. The Docker CLI reads `DOCKER_HOST`
from the environment automatically — no code changes needed if docker.ts
already passes the environment through (the default for `execFile`).

Verify that `docker.ts` does **not** pass `--host` or `-H` flags that would
override the environment variable.

### 5. Update setup scripts

- **`scripts/setup.sh`** — Remove Docker GID detection (no longer needed).
  Remove `OPENPALM_DOCKER_GID` and `OPENPALM_DOCKER_SOCK` from stack.env
  generation.
- **`scripts/dev-setup.sh`** — Same: remove Docker GID/socket detection.
- **`control-plane.ts`** — Remove `OPENPALM_DOCKER_GID` and
  `OPENPALM_DOCKER_SOCK` from `generateFallbackStackEnv()`.

---

## Why the allowlist is static (no file-based config needed)

A common concern is whether adding or removing channels at runtime requires
updating the proxy's allowlist. It does not.

The Tecnativa proxy filters by **Docker API endpoint category** — broad groups
like "containers", "networks", "images". It does _not_ filter by individual
container name, service name, or compose project. Every channel operation
(`docker compose -f ... up -d`, `docker compose ... down`) hits the same
API categories regardless of which channel is being installed or removed.

```
Channel install (discord):  POST /containers/create  ──┐
Channel install (slack):    POST /containers/create  ──┤  Same API category: CONTAINERS=1
Channel remove  (discord):  DELETE /containers/{id}  ──┘
```

This means:
- The allowlist is **set once** and never changes.
- No config file, no runtime reload, no proxy restart when channels change.
- The proxy is configured entirely via static environment variables in compose.

The Tecnativa proxy is HAProxy-based and only supports environment variables
(no file-based configuration). This is not a limitation for OpenPalm because
the allowlist never needs to change — it covers the fixed set of Docker API
categories that `docker compose` uses.

---

## What the proxy endpoint allowlist controls

The Tecnativa proxy uses environment variables to toggle Docker API endpoint
groups. The admin currently needs:

| Endpoint group | Used for | Required |
|---|---|---|
| `CONTAINERS` | `docker compose up/down/restart`, container inspection | Yes |
| `NETWORKS` | Network creation for channel overlays | Yes |
| `SERVICES` | Service listing and status | Yes |
| `INFO` / `VERSION` | Docker daemon info for diagnostics | Yes |
| `IMAGES` | Image pulls (if admin triggers pulls) | Maybe |
| `EXEC` | Not used by admin | No |
| `VOLUMES` | Not used (bind mounts only) | No |

Start restrictive and add endpoints as needed. The proxy denies everything
not explicitly enabled.

---

## Trade-offs

**Advantages:**
- Eliminates all socket permission/GID/runtime-specific handling
- Admin never runs as root, even briefly
- Reduces Docker API attack surface (allowlisted endpoints only)
- Simpler Dockerfile (no gosu, no entrypoint)
- Works identically on Docker Desktop, OrbStack, Colima, Podman, etc.

**Disadvantages:**
- One additional container in the stack (lightweight — ~10 MB, minimal CPU)
- Slight latency on Docker API calls (HTTP proxy hop vs direct socket)
- The proxy itself still needs direct socket access (runs as root internally)
- Initial allowlist must be validated against the full set of compose operations
  (but it is static — once correct, it never changes)

---

## Migration checklist

- [ ] Add `docker-socket-proxy` service to `assets/docker-compose.yml`
- [ ] Remove socket mount, `group_add`, entrypoint comment from admin service
- [ ] Restore `user:` directive to admin service
- [ ] Add `DOCKER_HOST: tcp://docker-socket-proxy:2375` to admin environment
- [ ] Add `depends_on: [docker-socket-proxy]` to admin service
- [ ] Remove `gosu` from Dockerfile apt-get install
- [ ] Remove `COPY docker-entrypoint.sh` and `ENTRYPOINT` from Dockerfile
- [ ] Delete `core/admin/docker-entrypoint.sh`
- [ ] Remove Docker GID detection from `setup.sh`, `dev-setup.sh`
- [ ] Remove `OPENPALM_DOCKER_GID` from `generateFallbackStackEnv()` in control-plane.ts
- [ ] Test: `docker compose up/down/restart` from admin API
- [ ] Test: channel install/uninstall (compose overlay operations)
- [ ] Test: on Docker Desktop, OrbStack, and Linux to confirm cross-runtime parity
- [ ] Update `docs/environment-and-mounts.md` — remove socket proxy docs, simplify admin section

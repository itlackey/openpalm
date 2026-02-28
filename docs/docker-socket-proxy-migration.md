# Docker Socket Proxy

OpenPalm uses a [Docker socket proxy](https://github.com/Tecnativa/docker-socket-proxy)
(Tecnativa) to mediate access to the Docker daemon. This document explains
the design, the allowlist, and the rationale.

---

## Why a socket proxy?

Different Docker runtimes (Docker Desktop, OrbStack, Colima) present the
Docker socket with different ownership inside containers. For example,
OrbStack remaps the socket to `root:root`, making it inaccessible to
non-root users regardless of `group_add` configuration.

A socket proxy eliminates this entire class of problems:

| Concern | Direct socket mount | Socket proxy |
|---|---|---|
| Socket GID varies by runtime | Requires root entrypoint + privilege dropping | Not applicable — admin talks HTTP over TCP |
| Container runs as root (briefly) | Yes, for entrypoint setup | No — admin runs as non-root (`user:`) |
| gosu dependency | Required | Not needed |
| Docker API attack surface | Full API access | Allowlisted endpoints only |
| Compose complexity | Entrypoint + env vars for UID/GID/Docker GID | One extra service, simpler admin definition |

---

## How it works

The `docker-socket-proxy` service is the **only** container that mounts the
Docker socket (read-only). It exposes a filtered HTTP API on port 2375 within
the isolated `admin_docker_net` network — a dedicated network shared only with
the admin service. No other service (assistant, guardian, channels) can reach
the proxy.

The admin container sets `DOCKER_HOST=tcp://docker-socket-proxy:2375`. The
Docker CLI and `docker compose` read this variable automatically — no code
changes were needed in `docker.ts` because `execFile` passes `process.env`
through to child processes.

The admin runs as `${OPENPALM_UID}:${OPENPALM_GID}` (the standard non-root
`user:` directive). No entrypoint, no gosu, no group manipulation.

---

## Why the allowlist is static

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

## Endpoint allowlist

The proxy allowlist is defined in the `docker-socket-proxy` service's
`environment:` block in `assets/docker-compose.yml`.

| Endpoint group | Used for | Enabled |
|---|---|---|
| `CONTAINERS` | `docker compose up/down/restart/ps/logs`, container lifecycle | Yes |
| `IMAGES` | Image pulls (`docker compose pull`, implicit in `up -d`) | Yes |
| `NETWORKS` | Network creation for channel overlays | Yes |
| `EXEC` | Caddy config reload (`docker compose exec caddy ...`) | Yes |
| `POST` | Write operations (create, start, stop, remove, etc.) | Yes |
| `INFO` | `docker info` for daemon diagnostics | Yes |
| `PING` | Healthcheck (`/_ping`) | Yes (default) |
| `VERSION` | `docker version` | Yes (default) |
| `VOLUMES` | Not used (bind mounts only) | No |
| `SERVICES` / `TASKS` | Swarm-only (not used) | No |
| `SECRETS` / `CONFIGS` | Swarm-only (not used) | No |
| `BUILD` | Not used (pre-built images only) | No |

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

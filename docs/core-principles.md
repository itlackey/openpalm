## Core goals

The filesystem and volume-mount contract exists to guarantee:

1. **Add containers and routes by file-drop** into known host locations (no code changes required).
2. **Add assistant extensions by copying OpenCode assets** into known host locations.
3. **Core container and routing configuration is stored on the host** for advanced users.
4. **Leverage Docker Compose, Caddy, and OpenCode configuration features** to avoid custom config/orchestration implementations.
5. **No template rendering** — manage configuration by copying whole files, not by string interpolation or code generation.
6. **Never overwrite or remove user-modified files.**
7. **All persistent container data lives on the host** for backup/restore.
8. **All host-stored container files are user-accessible** (ownership/permissions contract).
9. **Core assistant extensions are baked into the assistant container** and loaded from a fixed OpenCode config directory to ensure core extensions take precedence.

For (9), OpenCode supports a custom config directory via `OPENCODE_CONFIG_DIR`; it is searched like a standard `.opencode` directory for agents/commands/tools/skills/plugins. ([OpenCode][1])

---

## Security invariants

These are hard constraints that must never be violated during development:

1. **Admin is the sole orchestrator.** Only the admin container has Docker socket access (via the proxy). No other container may mount or access the Docker socket.
2. **Guardian-only ingress.** All channel traffic enters through the guardian, which enforces HMAC verification, timestamp skew rejection, replay detection, and rate limiting. No channel may communicate directly with the assistant.
3. **Assistant isolation.** The assistant has no Docker socket, no host filesystem access beyond its designated mounts (`DATA_HOME/assistant`, `CONFIG_HOME/opencode`, `WORK_DIR`), and interacts with the stack exclusively through the admin API.
4. **LAN-first by default.** Admin interfaces, dashboards, and channels are LAN-restricted by default. Nothing is publicly exposed without explicit user opt-in.

## Security principles

These principles govern all security-relevant decisions and must be followed by all contributors.

### Authentication and authorization

5. **No endpoint may be unauthenticated unless explicitly designed as public.** Every API endpoint that performs state changes or returns sensitive data must validate the admin token via `requireAdmin`. Exceptions (health checks, initial setup) must be explicitly documented and minimized in surface area.
6. **Empty credentials must always be rejected.** Token comparison functions must reject empty strings before performing constant-time comparison. `safeTokenCompare("", "")` must return `false`. All auth functions must include an explicit `if (!a || !b) return false;` guard.
7. **Admin tokens must meet minimum strength requirements.** Enforce a minimum length of 16 characters for admin tokens set via the setup wizard or API. Consider auto-generating strong tokens.
8. **Session tokens must not be exposed via unauthenticated endpoints.** Setup tokens, bootstrap tokens, and other ephemeral credentials must never be returned in API responses accessible without authentication. Use out-of-band delivery (terminal output, QR code) instead.
9. **All secret comparisons must use constant-time algorithms.** Use `timingSafeEqual` or the project's `safeTokenCompare` for all secret comparisons — admin tokens, API keys, HMAC signatures, setup tokens. Never use `===` or `!==` for secrets.
10. **Rate limiting is mandatory on authentication endpoints.** Implement per-IP rate limiting with progressive backoff on all endpoints that accept authentication credentials.

### Secrets management

11. **Secrets must never be committed to version control.** Template files containing secret placeholders must use a `.example` or `.template` suffix and be listed in `.gitignore`. Actual secrets files must always be gitignored.
12. **Secrets must be stored with restrictive filesystem permissions.** All files containing secrets (`secrets.env`, `stack.env`) must be created with `0600` permissions. Directory permissions must be `0700`.
13. **Secrets must not appear in process arguments.** Never pass tokens or keys via command-line arguments (visible in `/proc/*/cmdline`). Use environment variables, stdin, or temp files with restricted permissions instead.
14. **Error responses must not leak internal details.** Return generic error messages to API clients. Log detailed errors (stack traces, filesystem paths, Docker stderr) server-side only. Never return `err.message` or `String(err)` to the client.

### Supply chain and dependencies

15. **Docker base images must be pinned by SHA256 digest.** Never use floating tags (`latest`, `1-slim`, `22-slim`) for base images in production Dockerfiles. Pin every base image by its `@sha256:` digest.
16. **Lock files must never be deleted in Dockerfiles.** Use `--frozen-lockfile` to ensure reproducible builds. If a lock file is incompatible with the build environment, fix the lock file — do not delete it.
17. **Remote scripts must never be piped to bash without integrity verification.** Any `curl | bash` pattern must include checksum verification or be replaced with a pinned binary download with signature validation.
18. **Dependencies must be audited regularly.** Run `npm audit` / `bun audit` as part of CI. New dependencies must be reviewed for known vulnerabilities before merging.
19. **Only one package manager lock file should exist.** Remove stale lock files from other package managers to prevent accidental use.

### Container and infrastructure security

20. **Docker socket proxy must use minimum required permissions.** Only enable the API categories strictly needed. `EXEC` must not be enabled unless there is no alternative. Document the justification for each enabled API category.
21. **Containers must not run as root unless absolutely necessary.** Use `USER` directives in Dockerfiles. If root is needed at startup (e.g., for cron), drop privileges immediately and document why root was needed.
22. **All containers must define resource limits.** Set `mem_limit`, `cpus`, and `pids_limit` for every service to prevent resource exhaustion DoS.
23. **Container root filesystems should be read-only where feasible.** Use `read_only: true` with explicit `tmpfs` mounts for writable paths.
24. **All containers must use `no-new-privileges: true`.** Prevent privilege escalation via setuid/setgid binaries.

### Network and transport security

25. **TLS must be enforced for any deployment beyond localhost.** Document the requirement for HTTPS. Provide Caddy auto-TLS configuration for production. Add HSTS headers.
26. **Security headers must be configured on the reverse proxy.** At minimum: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy`, `Referrer-Policy: strict-origin-when-cross-origin`.
27. **All reverse-proxy routes must have explicit access control.** Every `handle` / `handle_path` block in the Caddyfile must include either `import lan_only` or `import public_access`. Never leave a route without an explicit access policy.
28. **CORS must be explicitly configured.** Add a CORS policy that restricts allowed origins. Never rely on implicit browser behavior.

### Input validation and injection prevention

29. **All user input must be validated at API boundaries.** Validate type, format, length, and allowed values for every request parameter. Reject unknown keys. Enforce maximum body sizes.
30. **Request body size must be limited.** Enforce a maximum JSON body size (e.g., 1MB) on all endpoints to prevent memory exhaustion.
31. **Channel user identity must be derived from authentication, not from request bodies.** Never trust a client-supplied `user` or `userId` field for identity — derive it from the authenticated credential.
32. **Prompt injection defenses must be implemented for LLM interactions.** Treat all user-supplied text as untrusted. Memory content injected into LLM context must be sandboxed with clear delimiters. Document the risk of prompt injection in channel AGENTS.md files.

### Audit and observability

33. **Audit logs must be bounded.** Implement log rotation with a maximum size (e.g., 10MB) and retention policy (e.g., 3 rotated files). Never allow unbounded log growth on disk.
34. **Client-supplied metadata (request IDs, caller types) must be sanitized.** Validate format and length before including in audit logs or response headers.

---

## Filesystem contract (file assembly, not rendering)

Configuration is managed by **copying whole files** between tiers — never by string interpolation, template expansion, or dynamic code generation. The admin acts as a **file assembler**: it stages user files (from CONFIG) and system defaults into STATE, and Docker/Caddy read from STATE at runtime. OpenCode core config is image-baked at `/opt/opencode`, with user extensions mounted from CONFIG.

### 1) Config (authoritative, user-edited)

**Location:** `$XDG_CONFIG_HOME/openpalm` (default `~/.config/openpalm`). ([Freedesktop Specifications][2])
**Purpose:** all files here are meant to be edited by users. This is the single user touchpoint.

Minimum required subtrees:

* `channels/` — channel definitions: compose overlays (`.yml`) and optional Caddy routes (`.caddy`)
* `opencode/` — user OpenCode config + user extensions/assets
* `secrets.env` — user secrets only: `ADMIN_TOKEN` and LLM provider keys. No paths, UID/GID, or infra config belongs here.

**Rule:** the stack must not rewrite user-edited files in this tree after creating missing defaults once. The only exception is user-requested channel install/uninstall actions, which add/remove channel files under `channels/`.

### 2) Data (durable, backup/restore)

**Location:** `$XDG_DATA_HOME/openpalm` (default `~/.local/share/openpalm`). ([Freedesktop Specifications][2])
**Purpose:** all persistent data for every container that must survive reinstall.

**Rule:** every persistence-requiring container path is a bind mount into this tree.

**Exception (system-managed policy):** `DATA_HOME/caddy/Caddyfile` and
`DATA_HOME/docker-compose.yml` are treated as system-owned policy state (source
of truth for base Caddy access rules and core compose definition, respectively).
Admin seeds these files from bundled assets if missing.

### 3) State (assembled runtime)

**Location:** `$XDG_STATE_HOME/openpalm` (default `~/.local/state/openpalm`). ([Freedesktop Specifications][2])
**Purpose:** the assembled runtime consumed by Docker, Caddy, and OpenCode. Also holds logs and operational records (audit trail, history).

The admin copies system defaults (bundled compose, Caddyfile) and user-provided files (channel configs, secrets) into this directory. Services read their configuration from STATE at runtime. Files here are overwritten on install/update — they are not user-edited.

**Rule:** STATE is system-writable. The admin may overwrite files here freely when applying changes.

---

## Volume-mount contract

### A) Compose: modular by native multi-file composition

The stack is defined by combining a base Compose file with channel overlays using Compose’s native multi-file mechanisms (merge rules and/or `include`). ([Docker Documentation][3])
**Implication:** adding a channel is dropping a `.yml` compose overlay into `config/channels/`, then running an explicit apply action that stages that file into `state/` and uses the staged files for Compose execution.

### B) Caddy: modular by native `import`

Caddy loads a stable root Caddyfile that uses `import` (with globs) to include snippets from `channels/`. ([Caddy Web Server][4])
**Implication:** adding an HTTP route for a channel is dropping a `.caddy` snippet into `config/channels/`, then running an explicit apply action that stages snippets into `state/` and reloads Caddy from staged files. If no `.caddy` file is present, the channel has no HTTP route and is only accessible on the Docker network.

### C) OpenCode: core precedence via baked-in `/opt/opencode`

* The assistant container includes core extensions/config at **`/opt/opencode`**.
* The assistant container sets **`OPENCODE_CONFIG_DIR=/opt/opencode`** so OpenCode discovers core agents/commands/tools/skills/plugins from that directory. ([OpenCode][1])
* Advanced users *may* bind-mount a host directory over `/opt/opencode` to override core behavior, but this is discouraged because bind-mounting replaces/obscures the container’s original contents. ([Docker Documentation][5])

### D) “Never overwrite” is enforced by tier boundaries

To guarantee the stack never overwrites user-modified files:

* **CONFIG_HOME is write-protected by contract.** The admin seeds default files once (on first install) and never overwrites user-edited files. Runtime assembly writes go to STATE_HOME. Channel install/uninstall actions may add/remove files in `CONFIG_HOME/channels/`.
* **STATE_HOME is system-writable.** The admin freely overwrites files here when assembling the runtime (install, update, access-scope changes).
* **DATA_HOME is mostly service-writable.** Containers own durable data; the admin manages `DATA_HOME/caddy/Caddyfile` and `DATA_HOME/docker-compose.yml` as system policy state. ([Freedesktop Specifications][2])

### E) Host authority rule for mounts

Bind-mounting a host path over a container path **obscures** pre-existing container files at that path; therefore, any bind-mounted path must be considered authoritative from the host perspective. ([Docker Documentation][5])

### F) User accessibility

All host-mounted directories must remain readable/writable by the host user (ownership/permissions policy is part of the contract). The purpose is to allow users to easily view logs, edit files, and backup and restore these files.

---

## Docker build dependency contract

Docker builds run outside the Bun workspace — the monorepo's hoisted `node_modules` is not available. Each Dockerfile must resolve `packages/lib` dependencies explicitly. **This pattern is mandatory; do not deviate.** See [`docker-dependency-resolution.md`](docker-dependency-resolution.md) for full rationale.

### Admin (SvelteKit/Node build)

The admin Dockerfile uses **plain `npm install`** (not Bun) at a workspace root directory so `node_modules/` lands at a common ancestor of both `core/admin/` and `packages/lib/`. This gives standard Node module resolution a real directory tree with no symlinks. The build output is a self-contained SvelteKit adapter-node bundle — no runtime `node_modules` needed.

**Rules:**
* Never use Bun to install dependencies in the admin Docker build — Bun's symlink-based `node_modules` layout is fragile under Node/Vite resolution.
* `node_modules` must be at a common ancestor of all source directories that Vite resolves (admin source, lib source, assets, registry).
* `PATH` must include `node_modules/.bin` so build tool binaries (svelte-kit, vite) are available from subdirectories.

### Guardian + Channels (Bun runtime)

These Dockerfiles copy `packages/lib` source into `/app/node_modules/@openpalm/lib` and install lib's declared dependencies afterward:

```dockerfile
RUN cd /app/node_modules/@openpalm/lib && bun install --production
```

This ensures lib's transitive dependencies (e.g. dotenv) are available at runtime. Since these services run on Bun (which created the install), there is no cross-tool resolution concern.

**Rules:**
* Every Dockerfile that copies `packages/lib` must run `bun install --production` inside the copied lib directory.
* If `packages/lib/package.json` gains new dependencies, all service Dockerfiles automatically pick them up — no per-service changes needed.

---

## Operational behavior (file assembly)

* **Add a channel:** drop a `.yml` compose overlay (required) and optional `.caddy` route snippet into `config/channels/`. The `.yml` defines the channel service; the `.caddy` file, if present, gives it an HTTP route through Caddy. Without a `.caddy` file, the channel is only accessible on the Docker network. ([Docker Documentation][3], [Caddy Web Server][4])
* **Add an extension (user):** copy OpenCode assets into `config/opencode/...` following OpenCode’s directory structure. ([OpenCode][1])
* **Core precedence:** core extensions live in `/opt/opencode` inside the assistant container and are loaded via `OPENCODE_CONFIG_DIR`. ([OpenCode][1])
* **Apply changes (required):** runtime components never consume channel source files directly from CONFIG_HOME. The admin applies configuration by copying files from CONFIG_HOME (user) plus system-managed sources (`assets/` and `DATA_HOME/caddy/Caddyfile`) into STATE_HOME, then runs `docker compose` and reloads/restarts services from STATE_HOME as needed. This apply logic runs automatically during admin startup and is also executed by lifecycle endpoints (`/admin/install`, `/admin/update`, channel install/uninstall, access-scope changes). No string interpolation or template expansion — just whole-file copies and Compose native `--env-file` substitution. Compose is always invoked with two staged env files: `STATE_HOME/artifacts/stack.env` (system-managed config: paths, UID/GID, image tags, networking, OpenMemory URLs, database password, and channel HMAC secrets) and `STATE_HOME/artifacts/secrets.env` (a staged copy of the user's `CONFIG_HOME/secrets.env`, conventionally `ADMIN_TOKEN` and LLM provider keys).
* **Backup/restore:** archive `config/` + `data/` (and optionally `state/` for logs/history) per XDG semantics. ([Freedesktop Specifications][2])

[1]: https://opencode.ai/docs/config/?utm_source=chatgpt.com "Config"
[2]: https://specifications.freedesktop.org/basedir/latest/?utm_source=chatgpt.com "XDG Base Directory Specification"
[3]: https://docs.docker.com/reference/compose-file/merge/?utm_source=chatgpt.com "Merge | Docker Docs"
[4]: https://caddyserver.com/docs/caddyfile/directives/import?utm_source=chatgpt.com "import (Caddyfile directive)"
[5]: https://docs.docker.com/engine/storage/bind-mounts/?utm_source=chatgpt.com "Bind mounts"

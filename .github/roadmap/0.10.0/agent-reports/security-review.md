# Security Review — v0.10.0 Milestone

## Summary

The 0.10.0 milestone introduces significant new attack surface through the component system, brokered admin OpenCode instance, unified secret management, and Azure deployment model. The most security-critical decisions — the ADMIN_TOKEN grant to the brokered instance (#304) and the unified secret manager design (#300) — are architecturally sound but require tighter implementation constraints to prevent privilege escalation and secret leakage. The component system (#301/#13) introduces the largest new trust boundary: arbitrary community-authored compose definitions running inside the stack network.

## Issues Assessment

### #315 — Azure Container Apps Deployment with Key Vault Integration

**Security implications:** This is a well-designed deployment-layer addition. The Key Vault integration using managed identity and `keyVaultUrl` references is the correct approach — secrets never appear in ARM templates, CLI history, or `az containerapp show` output. The admin exclusion is appropriate (ACA has no Docker socket) and the inter-service FQDN model preserves the existing communication pattern.

**Concerns:**
- The ACA deployment exposes `channel-chat` with external ingress (scaling 0-5 replicas). Guardian remains internal-only, which is correct, but the plan does not specify whether ACA's built-in TLS termination provides equivalent protection to the Caddy LAN-first default. In ACA, the channel endpoint is publicly routable by default.
- The deployment script stores secrets as ACA secrets before the Key Vault migration step. During this interim window, secrets are visible via `az containerapp show`. The script should create Key Vault first, then deploy containers — never use inline secrets as an intermediate step.
- The `ADMIN_TOKEN` is injected into guardian and assistant. In the self-hosted model, only the admin container needs `ADMIN_TOKEN`. The ACA deployment gives `ADMIN_TOKEN` to the assistant (line: "ADMIN_TOKEN: ${OPENPALM_ADMIN_TOKEN}"), which violates the planned ADMIN_TOKEN/ASSISTANT_TOKEN split from the pass plan.

**Recommendation: KEEP with modifications.** Fix the token assignment to use ASSISTANT_TOKEN for the assistant container. Eliminate the inline-secrets interim step. Document that ACA deployments are publicly accessible by default (not LAN-first).

### #304 — Brokered Admin-Authorized OpenCode Instance

**Security implications:** This is the highest-risk feature in the milestone. An OpenCode instance with ADMIN_TOKEN has the ability to: write secrets, manage the stack lifecycle (install/uninstall/upgrade), modify connections, and access all admin API endpoints. The issue correctly identifies that this is an "admin agent, not the assistant" but the implementation must enforce this distinction rigorously.

**Concerns:**
- The admin container already exposes port 4097 for the admin OpenCode instance (visible in the current `admin.yml`). This port is bound to `127.0.0.1` by default, which is correct, but it means the OpenCode API on 4097 is reachable from the host without authentication (OPENCODE_AUTH is "false"). Anyone with host access can send messages to the admin-privileged OpenCode instance directly.
- The assistant can call the brokered instance via admin API routes (`POST /admin/elevated/session/:id/message`). This creates an indirect privilege escalation path: assistant (ASSISTANT_TOKEN) -> admin API -> brokered instance (ADMIN_TOKEN) -> admin API (as admin). The access control on the elevated endpoints must validate that the assistant's request is appropriate before proxying to the admin-level instance.
- The brokered instance runs inside the admin container, which has access to `admin_docker_net` and therefore to the Docker socket proxy. While the issue states "no direct Docker/socket usage by the new runtime," the process has the network access to reach `docker-socket-proxy:2375`. Process-level isolation within a container is weaker than container-level isolation.
- Audit attribution is critical. Every action taken by the brokered instance must be logged with the original initiator (user vs. assistant) and the specific session/request that triggered it.

**Recommendation: KEEP with mandatory guardrails.** (1) Set `OPENCODE_AUTH: "true"` for the admin OpenCode instance on port 4097, or bind to a Unix socket only. (2) Implement a request-level allowlist on the elevated proxy endpoints — the assistant should not be able to trigger arbitrary admin actions through the broker. (3) Add rate limiting on elevated session creation. (4) Require explicit user confirmation for destructive operations (uninstall, upgrade, secret deletion) initiated through the broker.

### #302 — TTS/STT Setup and Admin Interface

**Security implications:** Low risk. Voice interfaces introduce no new trust boundaries if they operate through the existing admin API authentication model.

**Concerns:**
- If TTS/STT runs as a component, it needs access to audio data which may contain sensitive information. Ensure audio streams are not logged or persisted beyond the session.
- If a cloud STT service is used, audio leaves the LAN — violating LAN-first unless explicitly opted in.

**Recommendation: KEEP.** Ensure cloud STT/TTS providers require explicit user opt-in and that audio data is not persisted or logged.

### #301 — Configurable Services (Component System)

**Security implications:** The component system is the largest new trust boundary in 0.10.0. Any component's `compose.yml` can define arbitrary Docker services, volume mounts, environment variables, and network attachments. A malicious or poorly-written component could:
- Mount host paths not intended for containers (e.g., `${HOME}/.ssh`)
- Join `admin_docker_net` and access the Docker socket proxy
- Join `assistant_net` and directly communicate with the assistant (bypassing guardian)
- Declare `privileged: true` or add Linux capabilities
- Use `env_file` to read secrets from arbitrary paths

**Concerns:**
- The component plan has no compose validation or sandboxing. There is no mechanism to restrict what a component's `compose.yml` can declare. The CI validation for registry submissions is mentioned but not specified.
- The `openpalm-${INSTANCE_ID}` naming convention prevents service name collisions with core services, but does not prevent a component from adding extra services without the prefix.
- The dynamic allowlist (`buildAllowlist()`) only controls which containers the admin can manage. It does not control what networks, volumes, or capabilities a component's compose overlay requests.
- Community-submitted components in the registry have no trust differentiation beyond the `curated: true` flag. There is no signing, no hash verification, and no sandboxing.

**Recommendation: KEEP with mandatory security controls.** (1) Add a compose linter/validator that rejects: `privileged`, `cap_add`, `security_opt`, `pid: host`, `network_mode: host`, `volumes` that reference paths outside `INSTANCE_DIR`/`INSTANCE_STATE_DIR`/`DATA_HOME`, network declarations for `admin_docker_net`. (2) Restrict component compose overlays to a whitelist of allowed networks (`assistant_net`, `channel_lan`, `channel_public`). (3) Require compose schema validation in the registry CI. (4) Add a warning in the admin UI when installing non-curated components.

### #300 — Password Manager (Varlock Improvements)

**Security implications:** This is the most security-critical infrastructure change. The unified secret manager design is architecturally sound — the write-only `SecretBackend` interface (no read/decrypt method), the ADMIN_TOKEN/ASSISTANT_TOKEN split, and the provider-agnostic design via Varlock schema swapping are all strong design choices.

**Concerns:**
- The `PlaintextBackend` stores all secrets in a single file (`CONFIG_HOME/secrets.env`) with `0o600` permissions. This is the default for all existing and new installations unless the user explicitly opts in to encryption. While this preserves backward compatibility, it means secrets are one `cat` away from exposure if an attacker gains the user's filesystem access.
- The `PassBackend` shells out to the `pass` CLI via `execFile`. The `validateEntryName()` function is a good defense against path traversal, but the regex `ENTRY_NAME_RE = /^[a-z0-9][a-z0-9\-\/]*[a-z0-9]$/` allows forward slashes, which are meaningful in `pass` store paths. An attacker who can control the key parameter could write to paths outside the `openpalm/` prefix (e.g., `a/../../other/path`). The `..` check helps but the regex should be tightened.
- The GPG agent socket mount (`S.gpg-agent:ro`) gives the admin container the ability to decrypt any GPG-encrypted content the host user can decrypt. This is acknowledged in the plan's security appendix but deserves more prominent documentation and operator acknowledgment.
- The `pass-init.sh` script uses `eval "$generator"` to generate secrets. This is a shell injection vector if the generator variable is ever influenced by external input. In the current plan it is hardcoded (`"openssl rand -hex 16"`), but the pattern is fragile.
- Component secret registration (`registerComponentSecrets`) uses the env var name as the key in a global map. Two different components that use the same env var name (e.g., both use `API_KEY`) would collide. The registration should be namespaced by instance ID.

**Recommendation: KEEP with hardening.** (1) Tighten `validateEntryName()` to reject any key not prefixed with `openpalm/`. (2) Replace `eval "$generator"` with direct command invocation. (3) Namespace component secret registrations by instance ID in the `ENV_TO_SECRET_KEY` map. (4) Require operator acknowledgment of GPG agent scope during `pass` setup. (5) Apply `0o600` to `stack.env` as noted in the review report.

### #298 — Add OpenViking Integration

**Security implications:** Moderate risk. OpenViking runs as an optional component on `assistant_net`, which is correct. The security concern is primarily around the `OPENVIKING_API_KEY` — a root-level API key for the Viking instance.

**Concerns:**
- The `OPENVIKING_API_KEY` is injected into both the OpenViking container and the assistant's environment. If the assistant is compromised, the attacker gains full read/write access to the knowledge store.
- The Viking component's `ov.conf` contains `root_api_key` in plaintext. While stored in `DATA_HOME` (not CONFIG_HOME), this file is readable by the host user and any process with DATA_HOME access.
- The `viking-add-resource` tool allows the assistant to ingest arbitrary URLs. This could be used to SSRF internal services if the Viking container has broader network access than intended.

**Recommendation: KEEP.** (1) Consider scoped API keys (read-only for assistant, read-write for admin) if OpenViking supports them. (2) Ensure the Viking component's compose overlay does NOT join `channel_lan` or `channel_public`. (3) Validate URLs passed to `viking-add-resource` against an allowlist or at minimum reject `http://localhost`, `http://127.0.0.1`, and Docker internal hostnames.

### #13 — Advanced Channel Configuration Support

**Security implications:** This issue is largely subsumed by the component system (#301). The per-channel OpenCode configuration and multiple-instance support are now handled by the component model. The security concerns mirror those of #301.

**Concerns:**
- Per-channel OpenCode configuration could allow a channel to override the assistant's core behavior, tools, or system prompt. This is a feature but also a vector for misconfiguration.
- The issue mentions custom config UIs served from channel containers. If these UIs are rendered in the admin dashboard (e.g., via iframe), a malicious channel could execute JavaScript in the admin's browser context.

**Recommendation: KEEP.** (1) Ensure per-channel OpenCode configs cannot override core security-critical settings. (2) Never render channel-provided HTML in the admin UI's trust context — use sandboxed iframes with `sandbox` attribute if custom UIs are supported.

---

## Secret Management Analysis

### Varlock/pass Integration

The unified secret manager architecture is the strongest security improvement in 0.10.0. The key design decisions are sound:

**Strengths:**
- Write-only `SecretBackend` interface — no method returns decrypted values
- No API endpoint returns decrypted secrets — the read path is exclusively through Varlock at boot time (`varlock run` injects into `process.env`)
- Audit logging on every write/generate/delete operation
- ADMIN_TOKEN/ASSISTANT_TOKEN split with deterministic actor identification (`identifyCallerByToken` uses token comparison, not self-reported headers)
- Provider-agnostic design — swapping from plaintext to pass to Azure Key Vault is a schema file swap

**Weaknesses and gaps:**

1. **Secret resolution at compose-up time.** The plan states sensitive values are "resolved at compose-up time, not stored as plaintext in the instance `.env` file." However, the exact mechanism is undefined. Docker Compose `env_file` reads literal key=value pairs. If secrets are resolved by Varlock into a staged `.env` file before compose-up, that staged file contains plaintext secrets. If secrets are resolved inside the container at boot via `varlock run`, the component's `compose.yml` must include Varlock as a dependency. This resolution path needs explicit specification.

2. **Secret rotation.** No rotation mechanism is defined. The `SecretBackend` interface supports `write()` and `generate()` but there is no lifecycle for: (a) rotating `ADMIN_TOKEN` or `ASSISTANT_TOKEN` and propagating to running containers, (b) rotating component secrets (e.g., Discord bot token) and restarting the affected container, (c) detecting stale or compromised secrets. This should be a documented future-work item at minimum.

3. **Backup/restore with encrypted backend.** After migrating to `pass`, restoring a backup requires the GPG private key. If the key is lost, all secrets are irrecoverable. The plan acknowledges this but does not integrate GPG key backup into the regular backup workflow. The admin UI should warn operators about this requirement.

4. **Component secret collision.** The `registerComponentSecrets()` function maps env var names to `openpalm/component/{instanceId}/{entryName}`. But the `ENV_TO_SECRET_KEY` map is global and keyed by env var name. If `discord-main` and `discord-gaming` both declare `DISCORD_BOT_TOKEN` as `@sensitive`, the second registration overwrites the first. The env var name needs to be scoped: `DISCORD_BOT_TOKEN_discord-main` or the map needs to be instance-aware.

### Azure Key Vault Integration (#315)

The Key Vault design is clean:
- Managed identity with RBAC (no shared access policies)
- `keyVaultUrl` references instead of inline values
- Secrets never in ARM templates or CLI history

**Gap:** The ACA deployment does not integrate with the Varlock schema model. The self-hosted stack resolves secrets via `varlock run` from a `.env.schema`. The ACA stack injects secrets via ACA's native secret mechanism. These are two separate secret management paths that need to be documented as such. It would be cleaner if the ACA deployment also used `@varlock/azure-key-vault-plugin` so the same schema format works in both environments.

---

## Isolation Boundary Analysis

### Brokered Admin Instance (#304)

The review-decisions.md (Q4) grants the brokered instance full ADMIN_TOKEN access. This is the most consequential security decision in the milestone.

**Why it is defensible:** The brokered instance is embedded inside the admin container, which already has Docker socket proxy access, CONFIG_HOME/DATA_HOME/STATE_HOME mounts, and ADMIN_TOKEN. The admin container is already the most privileged component in the stack. Adding an OpenCode runtime inside it does not expand the trust boundary — it provides a structured interface to existing capabilities.

**Why it is dangerous:** The OpenCode runtime is an LLM agent that interprets natural language. It can be tricked, manipulated, or confused by adversarial input. The assistant can send messages to the brokered instance (`POST /admin/elevated/session/:id/message`). If the assistant is compromised (via prompt injection from a channel message), it could instruct the brokered instance to: delete secrets, uninstall services, modify the stack configuration, or exfiltrate data through admin API responses.

**Mitigation requirements:**

1. **Action classification.** Admin API endpoints must be classified as read-only (GET) or mutating (POST/PUT/DELETE). The brokered instance should require explicit confirmation (from the user, not the assistant) for all mutating operations when the request originates from the assistant.

2. **Session origin tracking.** Every brokered session must record whether it was initiated by the user (direct admin UI interaction) or by the assistant (via elevated proxy). Assistant-originated sessions should have a reduced privilege scope.

3. **Rate limiting.** The assistant should be limited in how many elevated sessions or messages it can create per time window. A compromised assistant performing rapid-fire admin operations is a clear abuse signal.

4. **No shell access.** The plan states "no unrestricted shell access" but the OpenCode runtime has `shell` tool capabilities by default. The admin-side OpenCode config must explicitly disable shell/terminal tools and restrict to admin API tools only.

### Assistant Isolation

The current assistant isolation is well-maintained:
- No Docker socket
- Limited filesystem mounts (DATA_HOME/assistant, CONFIG_HOME/assistant, STATE_HOME/opencode, WORK_DIR)
- Communicates with admin via HTTP API with ASSISTANT_TOKEN (after the token split)

The 0.10.0 changes preserve this isolation. The assistant cannot directly access secrets (ASSISTANT_TOKEN is rejected by `/admin/secrets`). The assistant can request actions through the brokered instance, but this is mediated by the admin API.

**Risk:** The assistant currently receives `OPENPALM_ADMIN_TOKEN` (line 59 in docker-compose.yml: `OPENPALM_ADMIN_TOKEN: ${OPENPALM_ADMIN_TOKEN:-${ADMIN_TOKEN:-}}`). After the Phase 1 auth refactor, this changes to `OPENPALM_ASSISTANT_TOKEN`. This migration must be atomic — if only the admin side is updated but the compose file still passes `ADMIN_TOKEN` to the assistant, the assistant retains admin-level access.

### Component Isolation

Components run as Docker containers on user-specified networks. The compose overlay mechanism gives components significant latitude:

- **Network access:** A component joining `assistant_net` can directly communicate with the assistant, memory, and guardian — bypassing the intended channel->guardian->assistant flow. The component system must restrict which networks a component can join.
- **Volume access:** Components define their own volume mounts. There is no mechanism to prevent a component from mounting `CONFIG_HOME/secrets.env` or `DATA_HOME/secrets/pass-store/`.
- **Environment access:** Components can use `env_file` to read any file accessible to Docker. If a component's compose overlay includes `env_file: ${CONFIG_HOME}/secrets.env`, it gets all core secrets.

---

## Attack Surface Assessment

### New attack surfaces introduced by 0.10.0:

1. **Malicious component definitions.** A community-submitted component in the registry could contain a compose overlay that mounts sensitive host paths, joins restricted networks, or declares privileged capabilities. There is no validation or sandboxing beyond the `curated` flag.

2. **Brokered instance prompt injection chain.** An attacker sends a crafted message through a channel -> guardian -> assistant. The assistant, manipulated by prompt injection, calls the elevated broker API to instruct the admin OpenCode instance to delete services or exfiltrate secrets. This is a multi-hop prompt injection attack that crosses isolation boundaries.

3. **Component `.env` file as secret sink.** The component plan proposes that `@sensitive` fields are managed through the unified secret manager. But the resolution path (how secrets get from the backend into the running container's environment) is under-specified. If the staging pipeline writes resolved secrets into the component's `.env` file on disk, those secrets are in plaintext at `DATA_HOME/components/{instance}/.env`.

4. **MCP server as credential relay.** The MCP component receives `OPENPALM_ADMIN_TOKEN` in its environment. Any MCP client that connects can invoke admin-level operations through the MCP tools. The `MCP_API_KEY` provides authentication for the MCP endpoint, but if it is compromised, the attacker gains admin API access.

5. **OpenViking SSRF.** The `viking-add-resource` tool allows the assistant to ingest URLs. If OpenViking's resource ingestion follows redirects or resolves DNS internally, an attacker could use this to probe internal services on the Docker network.

6. **GPG agent socket exposure.** The admin container mounts the host's GPG agent socket. A vulnerability in the admin container (e.g., an SSRF or RCE in the SvelteKit app) could be used to decrypt arbitrary GPG-encrypted content.

7. **Scheduler shell action type.** The knowledge roadmap proposes eval and maintenance scripts executed via the `shell` automation action type. The scheduler container has `OPENPALM_ADMIN_TOKEN` in its environment. If an attacker can write to the automations directory (STATE_HOME/automations), they can execute arbitrary shell commands with admin token access.

8. **Port 4097 without authentication.** The admin OpenCode instance on port 4097 has `OPENCODE_AUTH: "false"`. While bound to `127.0.0.1`, any process on the host or any container that can reach the admin container can send messages to the admin-privileged OpenCode instance.

---

## Recommendations

1. **ADD: Compose overlay validator for components.** Implement a validation step that rejects component compose overlays containing: `privileged: true`, `cap_add`, `security_opt`, `pid: host`, `network_mode: host`, `ipc: host`, `userns_mode: host`, volumes referencing paths outside the instance's `INSTANCE_DIR`/`INSTANCE_STATE_DIR`, network declarations for `admin_docker_net`, `env_file` referencing paths outside the instance directory. This must run both at registry CI time and at component install time.

2. **ADD: Network allowlist for components.** Restrict component compose overlays to a whitelist of allowed networks: `assistant_net` (for components that need to talk to core services), `channel_lan`, and `channel_public`. No component may join `admin_docker_net`.

3. **UPDATE: Enable authentication on admin OpenCode instance.** Change `OPENCODE_AUTH` from `"false"` to `"true"` for the port 4097 instance, or bind to a Unix socket instead of a TCP port. The current configuration allows unauthenticated access to an admin-privileged AI agent from any process on the host.

4. **UPDATE: Fix ADMIN_TOKEN leakage in ACA deployment.** The ACA deployment script currently passes `ADMIN_TOKEN` to the assistant container. After the ADMIN_TOKEN/ASSISTANT_TOKEN split, the assistant must receive only `ASSISTANT_TOKEN`. Update the ACA deployment script to match.

5. **ADD: Action classification for brokered instance.** Classify admin API endpoints as read-only vs. mutating. When the brokered instance receives a request that originated from the assistant (not direct user interaction), require explicit user confirmation for mutating operations (secrets write/delete, stack lifecycle, component install/uninstall).

6. **ADD: Rate limiting on elevated broker endpoints.** Limit the assistant to a configurable maximum number of elevated session creations and messages per time window (e.g., 5 sessions/hour, 20 messages/hour). Log and alert when limits are approached.

7. **UPDATE: Tighten PassBackend entry name validation.** Change `validateEntryName()` to additionally require that all keys start with `openpalm/`. This prevents write operations to paths outside the OpenPalm namespace in the pass store.

8. **UPDATE: Replace `eval` in pass-init.sh.** Replace `eval "$generator" | pass insert -m "$PREFIX/$entry"` with direct command execution (e.g., `openssl rand -hex 16 | pass insert -m "$PREFIX/$entry"`). The `eval` pattern is a shell injection risk even if currently hardcoded.

9. **UPDATE: Fix component secret registration collision.** Namespace the `ENV_TO_SECRET_KEY` map by instance ID. Two instances of the same component type (e.g., `discord-main`, `discord-gaming`) both declaring `DISCORD_BOT_TOKEN` must not collide. Use a composite key like `{instanceId}:{envVarName}` or separate maps per instance.

10. **ADD: Explicit secret resolution path for components.** Document and implement the exact mechanism by which `@sensitive` values in a component's `.env.schema` are resolved into the running container's environment. If the resolution writes plaintext to the instance `.env` file, that file must have `0o600` permissions and the plan must acknowledge this as a plaintext-at-rest concern.

11. **UPDATE: Disable shell/terminal tools in admin OpenCode config.** The admin-side OpenCode instance must have shell and terminal tools explicitly disabled in its dedicated config. Its capabilities should be restricted to admin API tools only, preventing it from being used as a general-purpose shell.

12. **ADD: SSRF protection for OpenViking resource ingestion.** Validate URLs passed to the `viking-add-resource` tool. Reject private IP ranges (RFC 1918), link-local addresses, Docker internal DNS names, and localhost variants. This prevents the assistant from using Viking as an SSRF proxy.

13. **ADD: Scheduler automations directory integrity.** The `STATE_HOME/automations/` directory is mounted read-only into the scheduler container (confirmed in compose). Ensure that no 0.10.0 change modifies this to read-write. The admin should be the sole writer of automation definitions.

14. **UPDATE: Document the two-path secret management model.** The self-hosted stack uses Varlock + `SecretBackend`. The ACA deployment uses native Azure Key Vault references. These are fundamentally different secret management paths. Document this divergence and specify which path is authoritative. Ideally, the ACA deployment should also use `@varlock/azure-key-vault-plugin` so there is a single secret resolution model.

15. **ADD: Security warning for non-curated components.** The admin UI should display a clear warning when a user installs a non-curated component from the registry, explaining that the compose definition has not been reviewed by the OpenPalm team and may request broad permissions.

16. **UPDATE: Apply `0o600` permissions to `DATA_HOME/stack.env`.** As noted in the review report (M9), `stack.env` contains channel HMAC secrets and should not be world-readable. Add `mode: 0o600` to the `writeFileSync` call for `stack.env`.

17. **ADD: Secret rotation procedure.** Define and document a secret rotation procedure for: ADMIN_TOKEN, ASSISTANT_TOKEN, MEMORY_AUTH_TOKEN, and channel HMAC secrets. Include the propagation steps (restage, restart affected containers) and verification steps. This does not need to be automated in 0.10.0 but must be documented.

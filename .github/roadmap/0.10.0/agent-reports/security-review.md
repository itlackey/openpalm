# Security Review — v0.10.0 Milestone

## Summary

The 0.10.0 milestone introduces significant new attack surface through the component system, brokered admin OpenCode instance, unified secret management, and Azure deployment model. The most security-critical decisions — the ADMIN_TOKEN grant to the brokered instance (#304) and the unified secret manager design (#300) — are architecturally sound but require tighter implementation constraints to prevent privilege escalation and secret leakage. The component system (#301/#13) introduces the largest new trust boundary: arbitrary community-authored compose definitions running inside the stack network.

## Issues Assessment

### #315 — Azure Container Apps Deployment with Key Vault Integration

**Security implications:** This is a well-designed deployment-layer addition. The Key Vault integration using managed identity and `keyVaultUrl` references is the correct approach — secrets never appear in ARM templates, CLI history, or `az containerapp show` output. The admin exclusion is appropriate (ACA has no Docker socket) and the inter-service FQDN model preserves the existing communication pattern.

**Concerns:**
- The ACA deployment exposes `channel-chat` with external ingress (scaling 0-5 replicas). Guardian remains internal-only, which is correct, but the plan does not specify whether ACA's built-in TLS termination provides equivalent protection to the Caddy LAN-first default. In ACA, the channel endpoint is publicly routable by default.
- The deployment script stores secrets as ACA secrets before the Key Vault migration step. During this interim window, secrets are visible via `az containerapp show`. The script should create Key Vault first, then deploy containers — never use inline secrets as an intermediate step.
- The `ADMIN_TOKEN` is injected into guardian and assistant. In the self-hosted model, only the admin container needs `ADMIN_TOKEN`. The ACA deployment gives `ADMIN_TOKEN` to the assistant (line: "ADMIN_TOKEN: ${OP_ADMIN_TOKEN}"), which violates the planned ADMIN_TOKEN/ASSISTANT_TOKEN split from the pass plan.

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

**Risk:** The assistant currently receives `OP_ADMIN_TOKEN` (line 59 in docker-compose.yml: `OP_ADMIN_TOKEN: ${OP_ADMIN_TOKEN:-${ADMIN_TOKEN:-}}`). After the Phase 1 auth refactor, this changes to `OP_ASSISTANT_TOKEN`. This migration must be atomic — if only the admin side is updated but the compose file still passes `ADMIN_TOKEN` to the assistant, the assistant retains admin-level access.

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

4. **MCP server as credential relay.** The MCP component receives `OP_ADMIN_TOKEN` in its environment. Any MCP client that connects can invoke admin-level operations through the MCP tools. The `MCP_API_KEY` provides authentication for the MCP endpoint, but if it is compromised, the attacker gains admin API access.

5. **OpenViking SSRF.** The `viking-add-resource` tool allows the assistant to ingest URLs. If OpenViking's resource ingestion follows redirects or resolves DNS internally, an attacker could use this to probe internal services on the Docker network.

6. **GPG agent socket exposure.** The admin container mounts the host's GPG agent socket. A vulnerability in the admin container (e.g., an SSRF or RCE in the SvelteKit app) could be used to decrypt arbitrary GPG-encrypted content.

7. **Scheduler shell action type.** The knowledge roadmap proposes eval and maintenance scripts executed via the `shell` automation action type. The scheduler container has `OP_ADMIN_TOKEN` in its environment. If an attacker can write to the automations directory (STATE_HOME/automations), they can execute arbitrary shell commands with admin token access.

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

---

## Addendum: Filesystem & Mounts Refactor Security Review (2026-03-19)

### Summary

The proposed filesystem and mounts refactor (`fs-mounts-refactor.md`) replaces the 3-tier XDG layout with a single `~/.openpalm/` root, introduces a `vault/` directory as a hard security boundary for secrets, eliminates the staging tier in favor of validate-in-place with snapshot rollback, and adds a hot-reload file watcher for `user.env`. The security properties are **strictly better** than the current model for secret isolation: the current design bulk-injects all secrets into guardian and admin via `env_file:`, while the proposed design gives each container only the secrets it needs through explicit `${VAR}` substitution and targeted file mounts. However, the rollback directory, the hot-reload watcher, and the pass plan compatibility require careful handling to avoid introducing new weaknesses.

### Vault Boundary Analysis

The `vault/` directory model is a meaningful and substantial security improvement over the current state. Here is a detailed comparison:

**Current model (broken down by container):**

| Container | Secret access mechanism | What it receives |
|-----------|----------------------|------------------|
| guardian | `env_file: stack.env` + bind mount of `artifacts/` | ALL of stack.env: paths, UID/GID, image tags, CHANNEL_*_SECRET, AND ADMIN_TOKEN (via env block). Also mounts the full `artifacts/` directory read-only, which contains both `stack.env` and `secrets.env` |
| admin | `env_file: stack.env` + `env_file: secrets.env` + full tree mounts | Everything. Both staged env files via env_file, plus explicit environment block with LLM keys, plus CONFIG_HOME/DATA_HOME/STATE_HOME mounts giving filesystem access to the raw `secrets.env` |
| assistant | explicit `environment:` block | ADMIN_TOKEN, MEMORY_AUTH_TOKEN, all 5 LLM API keys, MEMORY_USER_ID — each explicitly listed |
| memory | explicit `environment:` block | MEMORY_AUTH_TOKEN, OPENAI_API_KEY, OPENAI_BASE_URL |
| scheduler | explicit `environment:` block + `env_file` (artifacts ro mount) | ADMIN_TOKEN, OPENCODE_SERVER_PASSWORD, plus read-only access to the full `artifacts/` directory |

**Proposed model:**

| Container | Secret access mechanism | What it receives |
|-----------|----------------------|------------------|
| guardian | `${VAR}` substitution only, no file mounts | OP_ADMIN_TOKEN, CHANNEL_*_SECRET only. No access to LLM keys, no mounted secrets files |
| admin | `vault/` mount (rw) + `${VAR}` substitution | Full vault access — this is appropriate since admin is the secret manager |
| assistant | `vault/user.env` mount (ro) + `${VAR}` substitution for MEMORY_AUTH_TOKEN | LLM keys via mounted file, MEMORY_AUTH_TOKEN via env. No access to system.env, ADMIN_TOKEN, HMAC secrets |
| memory | `${VAR}` substitution only | MEMORY_AUTH_TOKEN, OPENAI_API_KEY, OPENAI_BASE_URL only |
| scheduler | `${VAR}` substitution only | OP_ADMIN_TOKEN only |
| caddy | nothing | No secrets at all |

**Assessment:** The vault model eliminates three specific weaknesses in the current design:

1. **Guardian no longer receives LLM API keys.** Currently, `env_file: stack.env` combined with the `artifacts/` bind mount gives the guardian access to `secrets.env` (which contains ADMIN_TOKEN and LLM keys) even though guardian never uses these values. The proposed model eliminates this entirely — guardian gets only HMAC secrets and ADMIN_TOKEN via `${VAR}` substitution.

2. **Scheduler no longer has filesystem access to secrets files.** Currently, the scheduler mounts `artifacts/:ro` which includes `stack.env` and `secrets.env`. The proposed model gives it only `OP_ADMIN_TOKEN` via substitution and removes the artifacts mount.

3. **Assistant loses access to ADMIN_TOKEN.** Currently, the assistant receives `OP_ADMIN_TOKEN` (line 59 of docker-compose.yml). The proposed model gives the assistant only `user.env` (LLM keys) and `MEMORY_AUTH_TOKEN`. This aligns with the Phase 1 auth refactor (ADMIN_TOKEN/ASSISTANT_TOKEN split) from the pass plan.

**One concern:** The admin mounts `vault/` at `/etc/openpalm/vault/` read-write, and also mounts `config/` at `/etc/openpalm` read-write. Since `vault/` is a subdirectory of the host's `~/.openpalm/` but is mounted at a separate container path (`/etc/openpalm/vault/`), these are independent mounts. This is correct. However, the proposal should explicitly state that `config/` and `vault/` are separate host-to-container mount points and that the `config/` mount does NOT include `vault/` (since `vault/` is a sibling of `config/` in the host filesystem, not a child). This is already implicit in the layout but should be documented as a security-critical invariant.

**Verdict: The vault boundary is a clear security improvement. APPROVE.**

### Hot-Reload Security

The file watcher on `vault/user.env` introduces a new attack surface where user-editable content is parsed at runtime by the assistant process.

**The watcher code (from the proposal):**

```typescript
const ALLOWED_KEYS = new Set([
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY',
  'GROQ_API_KEY', 'MISTRAL_API_KEY', 'GOOGLE_API_KEY',
  'SYSTEM_LLM_PROVIDER', 'SYSTEM_LLM_BASE_URL', 'SYSTEM_LLM_MODEL',
  'EMBEDDING_MODEL', 'EMBEDDING_DIMS',
]);

function loadUserEnv() {
  const content = readFileSync('/etc/openpalm/user.env', 'utf-8');
  for (const line of content.split('\n')) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match && ALLOWED_KEYS.has(match[1])) {
      process.env[match[1]] = match[2];
    }
  }
}
```

**Attack surface analysis:**

1. **Key injection via malformed lines.** The regex `^([A-Z_]+)=(.*)$` only matches lines starting with uppercase letters/underscores followed by `=`. A line like `PATH=/malicious` would match the regex pattern, but would be rejected by the `ALLOWED_KEYS` set check. The allowlist is the primary defense and it is correctly applied.

2. **Value injection.** A user could write `OPENAI_API_KEY=anything\nPATH=/evil` into user.env, but the regex anchors to `^...$` per line (after splitting on `\n`), so multi-line injection via the value field is not possible. The `(.*)$` capture group would grab everything after `=` on a single line, which is the correct behavior for env file parsing.

3. **Symlink attack.** If an attacker could replace `user.env` with a symlink to another file (e.g., `/etc/passwd`), the watcher would read that file. However, the file is mounted read-only into the container, and the mount point is a specific file path (`vault/user.env` to `/etc/openpalm/user.env`), not a directory mount. Docker bind mounts of specific files follow the inode, so replacing the file on the host creates a new inode and the container mount would go stale — the watcher would see the old content or a read error. If the mount were a directory mount of `vault/` instead, symlink attacks would be more concerning. **The proposal should clarify that this MUST remain a file-level mount, not a directory mount of vault/ into the assistant.**

4. **Denial of service via large file.** A malicious or corrupted `user.env` could be very large. The `readFileSync` call would block the event loop. This is low-risk (the user is the one editing the file) but the watcher should add a size check (e.g., reject files > 64KB).

5. **Race condition.** The `fs.watch` API fires on every write, including partial writes. If the user saves a file with an editor that does write-then-truncate or atomic rename, the watcher might read a partially-written file. The `loadUserEnv` function should add a short debounce (e.g., 500ms) to coalesce rapid file events.

6. **Process.env pollution scope.** The `ALLOWED_KEYS` set contains 11 entries, all LLM-related. None of these keys have special meaning to Node.js, Bun, or the OS runtime (unlike `PATH`, `LD_PRELOAD`, `NODE_OPTIONS`, etc.). The allowlist is appropriately scoped.

**Verdict: The hot-reload attack surface is limited and well-mitigated by the ALLOWED_KEYS set. APPROVE with minor hardening (see recommendations).**

### Rollback Security

The rollback directory at `~/.cache/openpalm/rollback/` stores previous known-good copies of configuration files, including `system.env`.

**What `system.env` contains:**
- `OP_ADMIN_TOKEN` — the admin authentication credential
- `MEMORY_AUTH_TOKEN` — memory service authentication
- `OPENCODE_SERVER_PASSWORD` — OpenCode server authentication
- `CHANNEL_*_SECRET` — HMAC secrets for all installed channels
- Infrastructure values (paths, UID/GID, image tags)

**Security concerns:**

1. **Stale secrets linger in the rollback directory.** After a secret rotation (e.g., admin token change), the old admin token remains in `~/.cache/openpalm/rollback/system.env`. If an attacker gains read access to the cache directory, they get a valid (old) admin token. The rollback mechanism should either: (a) encrypt the rollback snapshot, (b) redact secrets from rollback copies (replacing values with `REDACTED` and relying on the live file for restore), or (c) set a short TTL on rollback files (e.g., delete after 1 hour or after the next successful health check).

2. **File permissions.** The proposal does not specify permissions for `~/.cache/openpalm/rollback/`. Since it contains `system.env` with all system secrets, the rollback directory must have `0o700` and the `system.env` copy must have `0o600`. The proposal should explicitly state this.

3. **XDG cache semantics.** The proposal correctly notes that `~/.cache` is for regenerable data. However, `system.env` contains secrets that are NOT regenerable (they are specific values that must match what running containers expect). If the rollback directory is deleted (as XDG cache semantics permit), rollback would fail silently. This is acceptable (rollback is best-effort) but should be documented.

4. **Multi-user systems.** On shared-host systems, `~/.cache/` has the same ownership as `~/`. Other users cannot read it unless the directory permissions are wrong. This is standard XDG behavior and not a new concern, but the implementation should verify permissions at snapshot time.

5. **Scope of rollback.** The proposal lists files in rollback: `user.env`, `system.env`, `openpalm.yml`, `core.yml`, `admin.yml`, `Caddyfile`. The `user.env` also contains secrets (LLM API keys). Both env files in the rollback directory need `0o600` permissions.

**Verdict: The rollback location is acceptable but requires explicit permission hardening and a stale-secret cleanup mechanism. CONDITIONAL APPROVE.**

### Secret Isolation Comparison

A per-container comparison of secret exposure between current and proposed designs:

**Guardian:**
- Current: Receives ALL of `stack.env` via `env_file:` (includes CHANNEL_*_SECRET, but also all OP_* infrastructure vars). Bind-mounts the full `artifacts/` directory read-only, which contains both `stack.env` AND `secrets.env` (LLM keys, ADMIN_TOKEN). Also gets `ADMIN_TOKEN` via explicit `environment:` block.
- Proposed: Receives only `OP_ADMIN_TOKEN` and `CHANNEL_*_SECRET` via `${VAR}` substitution. No file mounts of any secrets file. No access to LLM keys.
- **Improvement: Significant.** Guardian's access reduced from "everything" to "only what it needs."

**Admin:**
- Current: `env_file` of both staged files, explicit `environment:` block with all LLM keys, plus full filesystem mounts of CONFIG_HOME (containing raw `secrets.env`), DATA_HOME, and STATE_HOME (containing staged copies).
- Proposed: Mounts `vault/` read-write (containing `user.env` + `system.env`), plus `${VAR}` substitution. Also mounts `config/` read-write.
- **Improvement: Marginal but cleaner.** Admin is inherently the most privileged container and needs broad access. The proposed model makes the access explicit and scoped to `vault/` rather than three full XDG trees.

**Assistant:**
- Current: `OP_ADMIN_TOKEN` (line 59), `MEMORY_AUTH_TOKEN`, all 5 LLM API keys via explicit `environment:` block. No secrets file mounts but has the token that grants admin-level API access.
- Proposed: `vault/user.env` mounted read-only (LLM keys only), `MEMORY_AUTH_TOKEN` via `${VAR}` substitution. No ADMIN_TOKEN. No access to system.env.
- **Improvement: Significant.** The most important change is removing `OP_ADMIN_TOKEN` from the assistant. This aligns with the Phase 1 auth refactor and eliminates the assistant's ability to call admin-only endpoints directly.

**Memory:**
- Current: `MEMORY_AUTH_TOKEN`, `OPENAI_API_KEY`, `OPENAI_BASE_URL` via `environment:` block. Two volume mounts (data directory + config file).
- Proposed: Same three values via `${VAR}` substitution. One volume mount (data directory only).
- **Improvement: Minor.** Same secret access, slightly cleaner mount structure.

**Scheduler:**
- Current: `OP_ADMIN_TOKEN`, `OPENCODE_SERVER_PASSWORD` via `environment:` block. Read-only mount of `artifacts/` directory (which contains `stack.env` and `secrets.env`).
- Proposed: `OP_ADMIN_TOKEN` via `${VAR}` substitution only. No file mounts of secrets. No `artifacts/` mount.
- **Improvement: Moderate.** Scheduler loses filesystem access to the staged secrets files. It still needs ADMIN_TOKEN to call the admin API, which is appropriate.

**Caddy:**
- Current: No secrets. Mounts Caddyfile, channels directory, and Caddy data/config from STATE_HOME/DATA_HOME.
- Proposed: No secrets. Mounts Caddyfile, channels directory, and Caddy data from `data/caddy/`.
- **Improvement: No change in security posture.** Caddy correctly has no secret access in either model.

**Overall assessment: The proposed model is strictly better for secret isolation.** The most impactful changes are: (1) guardian loses access to all secrets files and LLM keys, (2) assistant loses ADMIN_TOKEN, and (3) scheduler loses filesystem access to secrets files. No container loses access to secrets it legitimately needs.

**One gap to address:** The proposal table (Section 3.2) shows memory receiving `OPENAI_API_KEY` and `OPENAI_BASE_URL` via `${VAR}` from `user.env`. Docker Compose `--env-file` reads the file host-side for variable substitution, so ALL variables in both `user.env` and `system.env` are available for `${VAR}` resolution in compose files. This means a component compose overlay could reference `${OP_ADMIN_TOKEN}` and it would be resolved from `system.env`, injecting the admin token into an arbitrary container. The per-container allowlist is enforced by the compose `environment:` block (only listed variables are injected), but component overlays write their own `environment:` blocks. The compose overlay validator (recommendation #1 from the initial review) must also validate that component `environment:` blocks do not reference system-secret variables (`OP_ADMIN_TOKEN`, `MEMORY_AUTH_TOKEN`, `OPENCODE_SERVER_PASSWORD`, `CHANNEL_*_SECRET`).

### Pass Plan Impact

The pass plan (`openpalm-pass-impl-v3.md`) was designed around a single `secrets.env` + `secrets.env.schema` model. The filesystem refactor splits this into two files with different access rules. Here is the impact on each phase:

**Phase 0 (Varlock Hardening):** Minimal impact. The file permissions fix (`0o600`) applies to both `user.env` and `system.env` instead of a single `secrets.env`. The `redact.env.schema` generation would need to parse both schema files.

**Phase 1 (Auth Refactor):** The ADMIN_TOKEN/ASSISTANT_TOKEN split benefits directly from the two-file model. `ADMIN_TOKEN` moves cleanly into `system.env` (system-managed, never user-edited), and the assistant never sees it because `system.env` is not mounted into the assistant. This is an improvement over the original plan where both tokens lived in a single `secrets.env` that had to be carefully access-controlled.

**Phase 2 (Secret Backend Abstraction):** The `SecretBackend` interface and `ENV_TO_SECRET_KEY` map need to be aware of the two-file split. Currently, the `PlaintextBackend` reads/writes a single `secrets.env`. With the refactor, it would need to: (a) read/write `user.env` for user-facing secrets (LLM keys), and (b) read/write `system.env` for system-managed secrets (tokens, HMAC secrets). The `ENV_TO_SECRET_KEY` map should include a target-file indicator so the backend knows which file to modify. Alternatively, the backend could maintain two file handles.

**Phase 3 (pass Provider):** The pass backend is file-agnostic — it reads from and writes to the pass store regardless of which env file the variable originated from. However, the Varlock schema setup changes: instead of one `secrets.env.schema`, there would be `user.env.schema` and `system.env.schema`. The `@plugin` declaration and `@initPass` directive would need to appear in both schemas, or there would need to be a shared schema include mechanism. The `varlock run` invocation at container boot would need to process the appropriate schema (assistant processes `user.env.schema`, admin processes both).

**Phase 4 (Secrets API Routes):** No significant impact. The API routes are backend-agnostic and use `SecretBackend.write()` which abstracts the storage location.

**Phase 5 (Password Manager UI):** No impact. The UI interacts with the API, not the files directly.

**Phase 6 (Connections Endpoint Refactor):** The `patchConnections` function currently writes to a single `secrets.env`. With two files, it must route writes to the correct file based on whether the key is a user-facing secret (LLM key -> `user.env`) or a system secret (token -> `system.env`). The `SECRET_KEYS` set should be split into `USER_SECRET_KEYS` and `SYSTEM_SECRET_KEYS`.

**Phase 7 (Migration Tooling):** The migration script must split the current single `secrets.env` into two files during upgrade. User-facing keys go to `user.env`, system keys go to `system.env`. This is a one-time migration that should be automated in the upgrade path.

**Verdict: The two-file model is compatible with the pass plan and improves it by giving the ADMIN_TOKEN/ASSISTANT_TOKEN split a clean filesystem boundary. However, the PlaintextBackend, Varlock schema setup, and migration tooling all need design updates to handle two files instead of one.**

### Channel HMAC Without Bind Mount

The proposal removes the guardian's bind mount of the secrets file and relies exclusively on `${VAR}` substitution at container creation time. This means:

1. **Guardian reads HMAC secrets only at container start.** If a channel is installed mid-operation, the guardian must be recreated to pick up the new HMAC secret. The proposal acknowledges this and says it takes ~2 seconds.

2. **Running guardian cannot detect revoked secrets.** If an HMAC secret is rotated in `system.env`, the running guardian continues to accept the OLD secret until recreated. This creates a window where a revoked secret is still valid.

3. **This is acceptable because:** (a) secret rotation is a rare, operator-initiated action, (b) the operator is expected to restart affected services after rotation (this is true in the current model too — `env_file` is only read at container creation), and (c) the current model's "runtime re-read" via `GUARDIAN_SECRETS_PATH` bind mount was the exception, not the rule. Removing it actually simplifies the security model by making all secret propagation follow the same path: write to file, recreate container.

4. **The tradeoff is favorable.** Losing the guardian's real-time secret file re-read eliminates a bind mount that gave guardian read access to the entire `artifacts/` directory (which contains `secrets.env` alongside `stack.env`). The security gain (removing guardian's access to LLM keys and ADMIN_TOKEN via the filesystem) outweighs the convenience loss (must recreate guardian to pick up new HMAC secrets).

**Verdict: Acceptable. APPROVE.**

### Recommendations

18. **ADD: Explicit file-level mount constraint for assistant's user.env.** The assistant MUST mount `vault/user.env` as a specific file-level bind mount, NOT a directory mount of `vault/`. A directory mount would give the assistant read access to `system.env`, defeating the vault boundary. Document this as a security-critical invariant in the mount contract.

19. **ADD: Rollback directory permissions.** The `~/.cache/openpalm/rollback/` directory must be created with `0o700` permissions. All env files within it (`user.env`, `system.env`) must be written with `0o600` permissions. Add these constraints to the apply flow specification.

20. **ADD: Stale secret cleanup in rollback.** After a successful deploy (health checks pass), the rollback snapshot should either: (a) be deleted entirely (simplest — rollback is only useful during the deploy window), or (b) have secret values in env files redacted (replaced with a placeholder like `ROLLBACK_REDACTED`), retaining only non-secret configuration for manual recovery. Option (a) is recommended for simplicity.

21. **ADD: Hot-reload watcher hardening.** The `loadUserEnv()` function should: (a) check file size before reading (reject > 64KB), (b) debounce file change events by 500ms to avoid reading partially-written files, (c) log when keys are updated (without logging values) for audit traceability.

22. **UPDATE: PlaintextBackend for two-file model.** The `PlaintextBackend` implementation from the pass plan must be updated to handle two separate files (`user.env` and `system.env`). Add a file-routing layer that maps each secret key to its target file based on whether it is a user-facing or system-managed secret. The `CORE_ENV_TO_SECRET_KEY` map should include a `targetFile: 'user' | 'system'` attribute.

23. **ADD: Compose overlay variable reference validation.** Extend the compose overlay validator (recommendation #1 from initial review) to reject component `environment:` blocks that reference system-secret variables via `${VAR}` substitution. Specifically, block references to `OP_ADMIN_TOKEN`, `ASSISTANT_TOKEN`, `MEMORY_AUTH_TOKEN`, `OPENCODE_SERVER_PASSWORD`, and `CHANNEL_*_SECRET` in component overlays. These variables are available for substitution (because Docker Compose reads both env files host-side) but should not be exposed to arbitrary components.

24. **UPDATE: Varlock schema split for pass backend.** The pass plan's Phase 3 schema (`secrets.env.schema`) must be split into `user.env.schema` and `system.env.schema`, each with their own `@plugin` declaration. Document the Varlock invocation pattern for containers that need both schemas (admin) versus containers that need only one (assistant: `user.env.schema` only).

25. **ADD: Migration path for existing installations.** The upgrade from the current 3-tier XDG model to the single-root `~/.openpalm/` model requires a migration script that: (a) moves `CONFIG_HOME/secrets.env` contents into `vault/user.env` + `vault/system.env`, (b) sets `0o600` on both vault env files, (c) sets `0o700` on the `vault/` directory, (d) does NOT delete the old XDG directories until the user confirms the migration succeeded. The migration must be atomic (either fully complete or fully rolled back) to avoid a half-migrated state where neither the old nor new paths work.

26. **UPDATE: Document vault/ directory permissions.** The `vault/` directory itself should have `0o700` permissions (owner-only access) since it contains all secrets. Both `user.env` and `system.env` should have `0o600`. The `*.schema` files can have `0o644` since they contain no secret values (only resolver declarations). Add these permissions to the filesystem contract.

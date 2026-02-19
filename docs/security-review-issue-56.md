# Security Review: Issue #56 — Consolidate Channels Into a Single Container

**Issue:** [#56 — Refactor channels: host all in single container, enable plugin directory DX](https://github.com/itlackey/openpalm/issues/56)
**Date:** 2026-02-19
**Scope:** Security implications of merging per-channel containers into one unified channels container with a plugin-based architecture.

---

## Executive Summary

Issue #56 proposes consolidating the five channel adapters (chat, telegram, voice, discord, webhook) from separate Docker containers into a single container where each channel is a plugin loaded at runtime. While this improves developer experience and reduces infrastructure complexity, it **eliminates the secret isolation boundary** that currently exists between channels. This is the most significant security regression: a vulnerability in any single channel plugin would expose every channel's signing keys and platform credentials.

The proposal also introduces a **dynamic plugin loading mechanism** that creates a new code execution surface requiring careful design. Below is a detailed analysis of what changes, what stays the same, and recommendations for mitigating the risks.

---

## 1. Current Architecture: Security Properties

### 1.1 Container-Level Secret Isolation

Each channel adapter currently runs in its own container and receives **only** its own secrets via Docker environment variable injection:

| Container | Signing Key | Platform Credential |
|---|---|---|
| `channel-chat` | `CHANNEL_CHAT_SECRET` | `CHAT_INBOUND_TOKEN` |
| `channel-telegram` | `CHANNEL_TELEGRAM_SECRET` | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` |
| `channel-voice` | `CHANNEL_VOICE_SECRET` | *(none)* |
| `channel-discord` | `CHANNEL_DISCORD_SECRET` | `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY` |
| `channel-webhook` | `CHANNEL_WEBHOOK_SECRET` | `WEBHOOK_INBOUND_TOKEN` |

No channel can read another channel's secrets. This is enforced by Docker's process isolation — each container has its own `/proc/1/environ`.

### 1.2 Blast Radius Containment

If `channel-telegram` is compromised (e.g., via a code injection through a crafted Telegram update), the attacker gains:
- `CHANNEL_TELEGRAM_SECRET` (can forge gateway requests as the Telegram channel)
- `TELEGRAM_BOT_TOKEN` (can impersonate the Telegram bot)

They do **not** gain: Discord's bot token, the chat signing key, or any other channel's credentials.

### 1.3 Fault Isolation

A crash, OOM, or infinite loop in one channel adapter does not affect others. Each container can be independently restarted, rate-limited with cgroup resource constraints, and monitored.

### 1.4 Properties That Do NOT Currently Provide Isolation

These pre-existing weaknesses are **unaffected** by the consolidation:

- **Single flat network:** All services share `assistant_net` with no segmentation. Any container can reach any other container by hostname.
- **Root user inside containers:** No `USER` directive in channel Dockerfiles.
- **No replay protection:** The gateway validates HMAC signatures but does not track nonces or enforce timestamp windows.
- **Voice channel has no inbound authentication:** Any process on `assistant_net` can submit voice transcriptions.
- **Discord adapter does not verify Ed25519 signatures:** Discord's standard interaction verification is not implemented.
- **Webhook channel is dead-ended:** `webhook` is not in the gateway's `ALLOWED_CHANNELS` set and has no corresponding secret in the gateway's `CHANNEL_SHARED_SECRETS` map.

---

## 2. What Changes With Consolidation

### 2.1 CRITICAL: Secret Isolation Is Eliminated

**Risk: HIGH**

In a single container, all channel secrets must be injected into one process environment. Every channel plugin's code runs in the same Bun/Node.js process and can access `process.env` or `Bun.env` to read all secrets:

```
# All of these become available to ALL channel plugins:
CHANNEL_CHAT_SECRET, CHANNEL_TELEGRAM_SECRET, CHANNEL_VOICE_SECRET,
CHANNEL_DISCORD_SECRET, CHANNEL_WEBHOOK_SECRET,
TELEGRAM_BOT_TOKEN, DISCORD_BOT_TOKEN, DISCORD_PUBLIC_KEY,
CHAT_INBOUND_TOKEN, WEBHOOK_INBOUND_TOKEN, TELEGRAM_WEBHOOK_SECRET
```

**Impact:** A vulnerability in any single channel plugin (including community-contributed plugins loaded from the `channels/` directory) exposes **every** channel's signing keys and platform credentials. This converts a single-channel compromise into a full-channel-layer compromise.

**Specific concern:** The Discord adapter currently has an unauthenticated `/discord/webhook` endpoint (no Ed25519 verification, no inbound token). Co-locating this unauthenticated attack surface with all channel secrets in one process means any exploit through this endpoint gains access to all secrets.

### 2.2 CRITICAL: Dynamic Plugin Loading Creates a Code Execution Surface

**Risk: HIGH**

The proposal calls for channels to be loadable plugins where "adding a channel = adding a directory with a valid `index.ts`." This implies runtime dynamic `import()` of user-provided TypeScript/JavaScript modules.

Security implications:
- **Arbitrary code execution:** Any file placed in the channels directory runs with full process privileges, including access to all environment variables, the filesystem, and network.
- **Supply chain risk:** If community plugins are installed (similar to the existing gallery extension mechanism), a malicious plugin has access to all channel secrets and can exfiltrate them or forge gateway requests.
- **No sandboxing in Bun/Node.js:** Unlike Deno, there is no built-in permission system. A dynamically imported module has the same capabilities as the host process.

### 2.3 HIGH: Shared Failure Domain

**Risk: HIGH**

All channels share a single process. Consequences:
- An unhandled exception in one channel plugin crashes all channels.
- A memory leak in the Telegram handler degrades Discord, chat, voice, and webhook.
- A CPU-intensive operation in one plugin blocks the event loop for all others.
- Resource limits (memory, CPU) via cgroup/Docker can no longer be applied per-channel.

### 2.4 MEDIUM: Audit and Observability Degradation

**Risk: MEDIUM**

Currently, Docker logs are naturally separated per container (`docker logs channel-telegram`). In a consolidated container, all channel logs are interleaved. Without explicit and consistent channel tagging in every log line, incident investigation becomes harder. Log volume from a noisy channel (e.g., a chatbot under heavy use) can drown out signals from other channels.

### 2.5 MEDIUM: Independent Deployment Lost

**Risk: MEDIUM**

Currently, updating the Discord adapter does not require restarting the Telegram adapter. In a consolidated model, any plugin update requires restarting the entire channels container, causing brief downtime for all channels simultaneously.

---

## 3. Pre-Existing Issues Surfaced by This Review

These are not caused by the consolidation but are relevant to the security posture of the channel layer:

| # | Finding | Severity | Location |
|---|---|---|---|
| 1 | **No replay protection** — nonces are not tracked, timestamps are not validated | High | `gateway/src/server.ts:35-48` |
| 2 | **Discord Ed25519 verification missing** — interactions accepted without signature check | High | `channels/discord/server.ts:48-76` |
| 3 | **Voice channel has no inbound authentication** | Medium | `channels/voice/server.ts` |
| 4 | **Webhook channel is dead-ended at gateway** — not in `ALLOWED_CHANNELS` | Low | `gateway/src/server.ts` |
| 5 | **Admin token comparison is not timing-safe** | Medium | `admin/src/server.ts:70-72` |
| 6 | **Admin CORS is wildcard (`*`)** on all endpoints including authenticated ones | Medium | `admin/src/server.ts:63-68` |
| 7 | **OpenMemory API bound to `0.0.0.0` without authentication** | High | `assets/state/docker-compose.yml` |
| 8 | **Setup wizard endpoints bypass auth before setup completion** | Medium | `admin/src/server.ts:377-469` |
| 9 | **Empty HMAC secrets produce valid, forgeable signatures** | Medium | `gateway/src/channel-security.ts` |
| 10 | **Unpinned `latest` tags on third-party Docker images** (openmemory, qdrant) | Medium | `assets/state/docker-compose.yml` |

---

## 4. Recommendations

### 4.1 If Proceeding With Consolidation

These mitigations should be considered mandatory to avoid security regressions:

1. **Inject secrets per-plugin, not via process environment.** Pass each channel plugin only its own signing key and platform credentials through function arguments or a scoped config object — never expose the full `process.env`. While this does not prevent a determined attacker (the process still has access to env vars), it prevents accidental cross-channel secret leakage and makes the blast radius of a naive exploit smaller.

2. **Validate plugin interfaces at load time.** When dynamically importing a channel plugin, verify it exports exactly the expected interface (e.g., `{ name, handleInbound, healthCheck }`). Reject plugins that export unexpected properties or attempt to access restricted APIs.

3. **Run each plugin in a separate worker thread or subprocess.** Bun supports `Worker` threads. Running each channel plugin in its own worker with only its own secrets passed via `workerData` provides process-level secret isolation within a single container. This preserves most of the DX benefits while maintaining the security boundary. A crash in one worker would not bring down others.

4. **Implement a plugin allowlist.** Only load channel plugins explicitly registered in a configuration file (similar to how `opencode.json` manages extensions). Do not auto-discover and load all directories.

5. **Add structured logging with mandatory channel tags.** Every log entry from a channel plugin must include the channel name for auditability.

6. **Implement health checks per plugin.** If one channel plugin is unhealthy, report it independently rather than marking the entire container as unhealthy.

### 4.2 Regardless of Consolidation Decision

These should be addressed independently:

1. **Add replay protection to the gateway.** Track nonces with a TTL-based set and reject messages with timestamps older than a configurable window (e.g., 5 minutes). This is the highest-impact pre-existing vulnerability.

2. **Implement Discord Ed25519 signature verification.** This is required by Discord's API terms and is the standard defense against spoofed interactions.

3. **Add inbound authentication to the voice channel.** Currently any process on the Docker network can submit transcriptions.

4. **Use timing-safe comparison for all token checks** — admin token, controller token, chat inbound token, and Telegram webhook secret.

5. **Bind OpenMemory to `127.0.0.1` by default** or add authentication.

6. **Pin all third-party Docker image tags** to specific versions or digests.

### 4.3 Alternative: Consolidate Codebase, Keep Separate Containers

A middle-ground approach: maintain the plugin-based code organization and shared `index.ts` interface for developer experience, but continue deploying each channel as a separate container built from the same base image with different entrypoints. This preserves secret isolation and fault isolation while achieving the DX goals of the proposal.

```yaml
# Each channel uses the same image but different entrypoint
channel-chat:
  image: openpalm-channels:latest
  command: ["bun", "run", "channels/chat/index.ts"]
  environment:
    - CHANNEL_CHAT_SECRET=${CHANNEL_CHAT_SECRET}
  env_file:
    - ${OPENPALM_CONFIG_HOME}/channels/chat.env

channel-telegram:
  image: openpalm-channels:latest
  command: ["bun", "run", "channels/telegram/index.ts"]
  environment:
    - CHANNEL_TELEGRAM_SECRET=${CHANNEL_TELEGRAM_SECRET}
  env_file:
    - ${OPENPALM_CONFIG_HOME}/channels/telegram.env
```

This achieves:
- Unified codebase with standard plugin interface
- Shared base image (reduced build complexity)
- Per-channel secret isolation (maintained)
- Per-channel fault isolation (maintained)
- Per-channel resource limits (maintained)
- Easy plugin authoring DX (achieved)

---

## 5. Risk Summary Matrix

| Risk | Current | After Consolidation | After Consolidation + Worker Isolation |
|---|---|---|---|
| Single-channel secret exposure | Channel-scoped | **All channels exposed** | Channel-scoped (via worker) |
| Cross-channel credential theft | Not possible | **Trivial** | Requires worker escape |
| Single-channel crash blast radius | Channel-scoped | **All channels down** | Channel-scoped (worker crash) |
| Malicious plugin impact | N/A (no plugin system) | **Full process access** | Worker-scoped |
| Resource exhaustion propagation | Channel-scoped | **All channels affected** | Partially mitigated |
| Audit log clarity | Natural per-container | **Interleaved** | Interleaved (needs tagging) |

---

## 6. Conclusion

The consolidation proposed in Issue #56 achieves legitimate goals around developer experience and infrastructure simplification. However, it introduces a meaningful security regression by collapsing the secret isolation boundary between channels. The current per-container model — while imperfect in other ways (flat network, no replay protection, missing auth on some channels) — does provide genuine value in limiting the blast radius of a single-channel compromise.

**Recommended path forward:** Adopt the plugin-based code organization for DX benefits, but either (a) maintain separate containers with a shared base image, or (b) implement worker-thread isolation with per-worker secret injection if a single container is required. Address the pre-existing findings (replay protection, Discord Ed25519, voice auth, timing-safe token comparisons) as part of this refactor since the channel layer is already being restructured.

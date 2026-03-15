---
name: stack-troubleshooting
description: Diagnostic decision tree for troubleshooting the OpenPalm stack — symptoms, diagnosis, and fixes
license: MIT
compatibility: opencode
metadata:
  audience: assistant
  workflow: diagnostics
---

# Stack Troubleshooting

This skill provides a systematic approach to diagnosing and resolving issues in the OpenPalm stack. Follow the decision trees below to move from symptom to root cause to fix.

## Overview

### Stack Services

The OpenPalm stack runs 6 core services:

| Service | Role | Health endpoint |
|---------|------|-----------------|
| **caddy** | Reverse proxy, TLS termination, access control | curl http://localhost:80 |
| **admin** | Control plane API (sole Docker socket access) | curl http://localhost:8100/ |
| **guardian** | HMAC-verified message ingress, rate limiting, replay detection | http://localhost:8080/health |
| **assistant** | OpenCode runtime (no Docker socket) | TCP check on port 4096 |
| **memory** | Semantic memory service (sqlite-vec + embeddings) | http://localhost:8765/health |
| **docker-socket-proxy** | Filtered Docker API proxy (admin-only access) | http://localhost:2375/_ping |

### Service Communication

```
External clients -> Caddy -> Guardian (HMAC/validate) -> Assistant
                                                          |
                                                          v
                                                        Memory (semantic search)
                                                          |
                                                          v
                                                   Embedding model (Ollama/cloud)

Assistant -> Admin API (stack operations, authenticated)
Admin -> Docker Socket Proxy -> Docker daemon
```

Networks:
- `assistant_net` — admin, memory, assistant, guardian (internal communication)
- `channel_lan` — caddy, guardian, LAN-accessible channels
- `channel_public` — caddy, guardian, publicly accessible channels
- `admin_docker_net` — admin, docker-socket-proxy only (isolated)

### Diagnostic Tools Available

| Tool | Purpose |
|------|---------|
| `stack-diagnostics` | Full snapshot of all services, health, and config |
| `health-check` | Quick probe of core services (guardian, memory, admin) |
| `admin-containers_list` | List all containers with status |
| `admin-containers_up` | Start a specific service |
| `admin-containers_down` | Stop a specific service |
| `admin-containers_restart` | Restart a specific service |
| `admin-logs` | Read Docker service logs |
| `admin-guardian_audit` | Read guardian audit log (JSONL) |
| `admin-guardian_stats` | Guardian statistics and rate limit status |
| `admin-audit` | Read admin audit trail |
| `admin-config_validate` | Validate stack configuration |
| `admin-connections_status` | Check external API connection status |
| `admin-connections_test` | Test connectivity to LLM providers |
| `admin-providers_local` | Detect local LLM providers (Ollama, LMStudio) |
| `admin-artifacts_get` | Inspect generated config files (compose, caddyfile) |
| `message-trace` | Trace a request across services by requestId |

## Diagnostic Workflow

**Always start here:**

1. Run `stack-diagnostics` to get a full snapshot of all services, health, and config.
2. Identify which services are unhealthy or stopped.
3. Match the symptoms below and follow the relevant decision tree.
4. After applying a fix, re-run `health-check` to verify resolution.

## Symptom Decision Trees

---

### "Channel not responding" (user sends message, nothing happens)

1. **Check health:** `health-check` — is guardian healthy?
   - No -> guardian is down. Run `admin-containers_list`, then `admin-containers_up` for guardian.
   - Yes -> continue.

2. **Check guardian audit:** `admin-guardian_audit` — any `invalid_signature` errors?
   - Yes -> HMAC secret mismatch between the channel and the guardian. This typically happens after a channel is installed or secrets are rotated.
   - **Fix:** Run `admin-lifecycle_update` to regenerate secrets and sync them. If that does not resolve it, uninstall and reinstall the channel.

3. **Check guardian audit:** any `rate_limited` entries?
   - Yes -> user or channel hit rate limits (120 req/min per user, 200 req/min per channel).
   - **Fix:** Check for bot loops (a channel replying to itself). Wait for the rate window to reset (1 minute).

4. **Check guardian audit:** any `assistant_unavailable` errors?
   - Yes -> assistant container is down or unreachable.
   - **Fix:** Run `admin-containers_list` to check assistant status, then `admin-containers_up` for assistant.

5. **Check channel logs:** `admin-logs` for the specific channel service — any errors?
   - Connection errors -> check the channel's configuration and environment variables.
   - Auth errors -> verify the channel's API token or credentials.

6. **Check Caddy routing:** `admin-artifacts_get` artifact=caddy — does the channel have a route?
   - No route -> the channel has no `.caddy` file. It may be docker-network only, or the caddy config needs regeneration via `admin-lifecycle_update`.

---

### "Memory not working" (assistant cannot search or add memories)

1. **Health check memory:** `health-check services=memory`
   - Unreachable -> continue to step 2.
   - Healthy -> skip to step 4.

2. **Check container:** `admin-containers_list` — is memory running?
   - No -> `admin-containers_up service=memory`
   - Yes but unhealthy -> continue to step 3.

3. **Check logs:** `admin-logs service=memory`
   - Look for error messages related to startup, database, or embedding model.

4. **Check memory stats:** `memory-stats` — does it return data?
   - Yes -> memory service is operational. The problem may be query-specific.
   - No -> memory service is up but not functioning correctly.

5. **Common issues and fixes:**

   | Symptom | Cause | Fix |
   |---------|-------|-----|
   | Embedding errors | Model not available | Run `admin-memory_models` to verify. Ensure Ollama is running with the model pulled. |
   | Dimension mismatch | Wrong `embedding_model_dims` | nomic-embed-text = 768 dims. Check and correct the memory config. |
   | User ID mismatch | MEMORY_USER_ID differs between services | Check MEMORY_USER_ID in connections — must be consistent. |
   | Connection refused to Ollama | Wrong URL from container | Must use `http://host.docker.internal:11434` from containers, not `localhost`. |
   | SQLite lock errors | Concurrent access issue | Restart memory service: `admin-containers_restart service=memory` |

---

### "Assistant is slow or timing out"

1. **Check container resources:** `admin-containers_list` — is assistant using high CPU/memory?
   - OOM or high resource usage -> the model or workload may be too heavy. Check logs for OOM kills.

2. **Check LLM provider:** `admin-connections_test` — is the provider reachable?
   - No -> provider may be down or API key expired. See "Can't connect to LLM provider" below.

3. **Check local providers:** `admin-providers_local` — is Ollama/LMStudio running?
   - Not detected -> start Ollama on the host machine.

4. **Check logs:** `admin-logs service=assistant` — any timeout or error messages?
   - Timeout errors -> the `OPENCODE_TIMEOUT_MS` default is 120s. If the model is very slow, this may need to be increased.
   - socat errors -> LLM proxy setup failed. Check the assistant entrypoint configuration.

5. **Check guardian stats:** `admin-guardian_stats` — are rate limits being hit?
   - Yes -> requests are being throttled before reaching the assistant. See rate limiting notes above.

---

### "Stack won't start / containers keep restarting"

1. **Check all containers:** `admin-containers_list` — which services are stopped or restarting?
   - Note the dependency chain: docker-socket-proxy -> admin, memory -> assistant -> guardian.

2. **Check logs for failing service:** `admin-logs service=<name>`
   - Look for startup errors, missing environment variables, or configuration issues.

3. **Check Docker events:** `admin-containers_events` — OOM kills? Health check failures?
   - OOM -> increase container memory limits or reduce model size.
   - Health check failure -> the service starts but fails its health probe. Check the health endpoint directly.

4. **Validate config:** `admin-config_validate` — missing env vars? Invalid values?
   - Fix any reported issues in the configuration.

5. **Check connections:** `admin-connections_status` — is an LLM provider configured?
   - Missing connections may prevent the assistant from starting correctly.

6. **Common causes:**

   | Symptom | Cause | Fix |
   |---------|-------|-----|
   | All containers fail | Docker daemon not running | Check Docker service on host |
   | Admin won't start | docker-socket-proxy unhealthy | Check Docker socket path (`OPENPALM_DOCKER_SOCK`) |
   | Assistant restart loop | Memory service unhealthy | Assistant depends on memory health. Fix memory first. |
   | Guardian restart loop | Assistant unhealthy | Guardian depends on assistant health. Fix assistant first. |
   | Port conflict errors | Another service on the same port | Check ports 8080, 8100, 4096, 8765 for conflicts |
   | Permission denied | UID/GID mismatch | Check `OPENPALM_UID`/`OPENPALM_GID` match volume ownership |

---

### "Authentication / security errors"

1. **Check guardian audit:** `admin-guardian_audit` — what error codes?

   | Error Code | Meaning | Investigation |
   |------------|---------|---------------|
   | `invalid_signature` | HMAC verification failed | Secret mismatch between channel and guardian. Was the channel recently installed? Were secrets rotated? |
   | `replay_detected` | Nonce already seen | Duplicate message or replay attack. Check for duplicate sends. Verify timestamps (5-minute clock skew tolerance). |
   | `invalid_json` | Request body not valid JSON | Malformed request from channel adapter. Check channel logs. |
   | `invalid_payload` | JSON valid but missing/invalid fields | Channel sending incomplete data. Check required fields: userId, channel, text, nonce, timestamp. |
   | `payload_too_large` | Body exceeds 100KB | Message or attachment too large. Reduce payload size. |
   | `rate_limited` | Too many requests | 120/min per user, 200/min per channel. Check for bot loops. |

2. **Check admin audit:** `admin-audit` — unauthorized attempts?
   - Look for `ok: false` entries indicating failed operations.
   - Check the `actor` and `callerType` fields to identify who attempted the action.

3. **Trace specific request:** `message-trace requestId=<id>`
   - Use the requestId from error responses to trace the full request path across guardian and admin.

---

### "Can't connect to LLM provider"

1. **Check connection status:** `admin-connections_status` — what is missing?
   - Lists required keys and which are present.

2. **Test connectivity:** `admin-connections_test` with the provider URL.
   - Verifies network reachability and authentication.

3. **Detect local providers:** `admin-providers_local`
   - Checks for Ollama and LMStudio on the host.

4. **Check logs:** `admin-logs service=assistant` — connection errors?
   - Look for connection refused, timeout, or authentication failures.

5. **Common fixes:**

   | Problem | Fix |
   |---------|-----|
   | API key expired/invalid | Update via `admin-connections_set` |
   | Ollama not running | Start Ollama on the host machine |
   | Wrong Ollama URL from container | Must use `http://host.docker.internal:11434` |
   | LMStudio not detected | LMStudio must be running with API server enabled |
   | Cloud provider unreachable | Check network connectivity and firewall rules |

## Service Dependency Chain

Understanding dependencies is critical for diagnosing cascade failures:

```
docker-socket-proxy  (no deps — starts first)
       |
       v
     admin  (depends on: docker-socket-proxy healthy)

     memory  (no compose deps — starts independently)
       |
       v
   assistant  (depends on: memory healthy)
       |
       v
    guardian  (depends on: assistant healthy)
       |
       v
     caddy  (no compose deps — routes to guardian and admin)
```

**Cascade failure pattern:** If memory goes down, assistant becomes unhealthy, which causes guardian to become unhealthy, which causes all channels to stop receiving messages. Fix memory first, then wait for the chain to recover.

## Environment Variables Reference

Key environment variables that affect diagnostics:

| Variable | Service | Purpose |
|----------|---------|---------|
| `ADMIN_TOKEN` | admin, guardian | Admin API authentication token |
| `MEMORY_API_URL` | assistant | Memory service endpoint (default: `http://memory:8765`) |
| `MEMORY_AUTH_TOKEN` | admin, memory | Memory service authentication |
| `MEMORY_USER_ID` | assistant | Memory user identity |
| `OPENPALM_ADMIN_API_URL` | assistant | Admin API from assistant (default: `http://admin:8100`) |
| `OPENPALM_ADMIN_TOKEN` | assistant | Admin API token for assistant |
| `GUARDIAN_AUDIT_PATH` | guardian | Audit log file location |
| `GUARDIAN_SECRETS_PATH` | guardian | Channel secrets file path |
| `OPENCODE_TIMEOUT_MS` | guardian | Message forwarding timeout (default: 120000ms) |
| `OPENPALM_INGRESS_PORT` | caddy | External ingress port (default: 8080) |
| `OPENPALM_DOCKER_SOCK` | docker-socket-proxy | Docker socket path |
| `SYSTEM_LLM_PROVIDER` | assistant | LLM provider configuration |
| `SYSTEM_LLM_MODEL` | assistant | LLM model selection |

## When to Use This Skill

Load this skill when:
- A user reports something is not working and you need to diagnose the issue
- Services are unhealthy or containers are restarting
- Messages are not being delivered through channels
- The assistant is slow, timing out, or producing errors
- You need to understand how services depend on each other
- You want a systematic approach rather than guessing at the problem

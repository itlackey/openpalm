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

The OpenPalm stack runs two core services:

| Service | Role | Health endpoint |
|---------|------|-----------------|
| **assistant** | OpenCode runtime (no Docker socket). Hosts the scheduler co-process and the shared akm stash. | TCP check on port 3800 |
| **guardian** | HMAC-verified message ingress, rate limiting, replay detection | http://localhost:3899/health |

Optional addons (enabled by copying from the registry catalog into `stack/addons/`):
| **admin** | Control plane API (Docker socket access via docker-socket-proxy) | http://localhost:3880/ |

Persistent memory, lessons, skills, commands, and workflows live in the shared akm stash that the assistant and admin containers bind-mount from `~/.openpalm/data/stash/`.

### Service Communication

```
External clients -> Guardian (HMAC/validate) -> Assistant -> akm stash (memories, skills, lessons)

Assistant -> Admin API (stack operations, authenticated)
Admin -> Docker Socket Proxy -> Docker daemon
```

Networks:
- `assistant_net` — admin, assistant, guardian (internal communication)
- `admin_docker_net` — admin, docker-socket-proxy only (isolated)

### Diagnostic Tools Available

| Tool | Purpose |
|------|---------|
| `stack-diagnostics` | Full snapshot of all services, health, and config |
| `health-check` | Quick probe of core services (guardian, admin) |
| `admin-containers-list` | List all containers with status |
| `admin-containers-up` | Start a specific service |
| `admin-containers-down` | Stop a specific service |
| `admin-containers-restart` | Restart a specific service |
| `admin-logs` | Read Docker service logs |
| `admin-guardian-audit` | Read guardian audit log (JSONL) |
| `admin-guardian-stats` | Guardian statistics and rate limit status |
| `admin-audit` | Read admin audit trail |
| `admin-config-validate` | Validate stack configuration |
| `admin-connections-status` | Check external API connection status |
| `admin-connections-test` | Test connectivity to LLM providers |
| `admin-providers-local` | Detect local LLM providers (Ollama, LMStudio) |
| `admin-artifacts-get` | Inspect generated config files (compose) |
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
   - No -> guardian is down. Run `admin-containers-list`, then `admin-containers-up` for guardian.
   - Yes -> continue.

2. **Check guardian audit:** `admin-guardian-audit` — any `invalid_signature` errors?
   - Yes -> HMAC secret mismatch between the channel and the guardian. This typically happens after a channel is installed or secrets are rotated.
   - **Fix:** Run `admin-lifecycle-update` to regenerate secrets and sync them. If that does not resolve it, uninstall and reinstall the channel.

3. **Check guardian audit:** any `rate_limited` entries?
   - Yes -> user or channel hit rate limits (120 req/min per user, 200 req/min per channel).
   - **Fix:** Check for bot loops (a channel replying to itself). Wait for the rate window to reset (1 minute).

4. **Check guardian audit:** any `assistant_unavailable` errors?
   - Yes -> assistant container is down or unreachable.
   - **Fix:** Run `admin-containers-list` to check assistant status, then `admin-containers-up` for assistant.

5. **Check channel logs:** `admin-logs` for the specific channel service — any errors?
   - Connection errors -> check the channel's configuration and environment variables.
   - Auth errors -> verify the channel's API token or credentials.

6. **Check channel addon:** Verify the channel has an enabled runtime overlay under `stack/addons/<name>/`.
   - Not enabled -> enable the addon via `admin-addons` or the admin UI.

---

### "Memory / akm stash not working" (assistant cannot search or add memories)

Memory is now served by the akm stash bind-mounted into the assistant container. There is no longer a separate memory service.

1. **Check the stash mount:** `admin-containers-inspect service=assistant` — is `/akm` mounted?
   - Missing -> the install/upgrade did not create the bind mount. Re-run `admin-lifecycle-update`.

2. **Check akm health from the assistant container:** ask the assistant to run `akm doctor` (or `akm-help`) and report its output. Common failures:

   | Symptom | Cause | Fix |
   |---------|-------|-----|
   | `AKM_STASH_DIR not writable` | Bind mount owned by wrong UID | Re-run `admin-lifecycle-update`; verify `OP_UID`/`OP_GID` match the host. |
   | `index out of date` | Stash files added outside akm | Ask the assistant to run `akm index` to rebuild the local index. |
   | Embedding errors | Configured embedding provider unavailable | Check `admin-providers-local` and the `OP_CAP_EMBEDDINGS_*` env vars on the assistant. |

3. **Inspect the stash directly:** the shared root is `~/.openpalm/data/stash/` on the host. Use `admin-logs service=assistant` to look for errors emitted by the akm CLI.

---

### "Assistant is slow or timing out"

1. **Check container resources:** `admin-containers-list` — is assistant using high CPU/memory?
   - OOM or high resource usage -> the model or workload may be too heavy. Check logs for OOM kills.

2. **Check LLM provider:** `admin-connections-test` — is the provider reachable?
   - No -> provider may be down or API key expired. See "Can't connect to LLM provider" below.

3. **Check local providers:** `admin-providers-local` — is Ollama/LMStudio running?
   - Not detected -> start Ollama on the host machine.

4. **Check logs:** `admin-logs service=assistant` — any timeout or error messages?
   - Timeout errors -> the `OPENCODE_TIMEOUT_MS` default is 120s. If the model is very slow, this may need to be increased.
   - socat errors -> LLM proxy setup failed. Check the assistant entrypoint configuration.

5. **Check guardian stats:** `admin-guardian-stats` — are rate limits being hit?
   - Yes -> requests are being throttled before reaching the assistant. See rate limiting notes above.

---

### "Stack won't start / containers keep restarting"

1. **Check all containers:** `admin-containers-list` — which services are stopped or restarting?
   - Note the dependency chain: assistant -> guardian. Admin addon: docker-socket-proxy -> admin.

2. **Check logs for failing service:** `admin-logs service=<name>`
   - Look for startup errors, missing environment variables, or configuration issues.

3. **Check Docker events:** `admin-containers-events` — OOM kills? Health check failures?
   - OOM -> increase container memory limits or reduce model size.
   - Health check failure -> the service starts but fails its health probe. Check the health endpoint directly.

4. **Validate config:** `admin-config-validate` — missing env vars? Invalid values?
   - Fix any reported issues in the configuration.

5. **Check connections:** `admin-connections-status` — is an LLM provider configured?
   - Missing connections may prevent the assistant from starting correctly.

6. **Common causes:**

   | Symptom | Cause | Fix |
   |---------|-------|-----|
   | All containers fail | Docker daemon not running | Check Docker service on host |
   | Admin addon won't start | docker-socket-proxy unhealthy | Check Docker socket path (`OP_DOCKER_SOCK`) |
   | Guardian restart loop | Assistant unhealthy | Guardian depends on assistant health. Fix assistant first. |
   | Port conflict errors | Another service on the same port | Check ports 8080, 8100, 4096 for conflicts |
   | Permission denied | UID/GID mismatch | Check `OP_UID`/`OP_GID` match volume ownership |

---

### "Authentication / security errors"

1. **Check guardian audit:** `admin-guardian-audit` — what error codes?

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

1. **Check connection status:** `admin-connections-status` — what is missing?
   - Lists required keys and which are present.

2. **Test connectivity:** `admin-connections-test` with the provider URL.
   - Verifies network reachability and authentication.

3. **Detect local providers:** `admin-providers-local`
   - Checks for Ollama and LMStudio on the host.

4. **Check logs:** `admin-logs service=assistant` — connection errors?
   - Look for connection refused, timeout, or authentication failures.

5. **Common fixes:**

   | Problem | Fix |
   |---------|-----|
   | API key expired/invalid | Update via `admin-connections-set` |
   | Ollama not running | Start Ollama on the host machine |
   | Wrong Ollama URL from container | Must use `http://host.docker.internal:11434` |
   | LMStudio not detected | LMStudio must be running with API server enabled |
   | Cloud provider unreachable | Check network connectivity and firewall rules |

## Service Dependency Chain

Understanding dependencies is critical for diagnosing cascade failures:

```
   assistant  (depends on: init service completed; hosts scheduler co-process)
       |
       v
    guardian  (depends on: assistant healthy)

Optional (admin addon):
  docker-socket-proxy  (no deps — starts first)
       |
       v
     admin  (depends on: docker-socket-proxy healthy)
```

**Cascade failure pattern:** If the assistant becomes unhealthy the guardian also goes unhealthy and all channels stop receiving messages. Fix the assistant first, then wait for the chain to recover.

## Environment Variables Reference

Key environment variables that affect diagnostics:

| Variable | Service | Purpose |
|----------|---------|---------|
| `ADMIN_TOKEN` | admin, guardian | Admin API authentication token |
| `AKM_STASH_DIR` | assistant, admin | Shared akm stash mount (default: `/akm` inside the container) |
| `OP_ADMIN_API_URL` | assistant | Admin API from assistant (default: `http://admin:8100`) |
| `OP_ASSISTANT_TOKEN` | assistant | Admin API token for assistant |
| `GUARDIAN_AUDIT_PATH` | guardian | Audit log file location |
| `GUARDIAN_SECRETS_PATH` | guardian | Channel secrets file path |
| `OPENCODE_TIMEOUT_MS` | guardian | Message forwarding timeout (default: 120000ms) |
| `OP_DOCKER_SOCK` | docker-socket-proxy | Docker socket path |
| `OP_CAP_LLM_PROVIDER` | assistant | Resolved LLM provider id (drives entrypoint key-scoping) |
| `OP_CAP_LLM_MODEL` | assistant | Resolved primary LLM model id |

## When to Use This Skill

Load this skill when:
- A user reports something is not working and you need to diagnose the issue
- Services are unhealthy or containers are restarting
- Messages are not being delivered through channels
- The assistant is slow, timing out, or producing errors
- You need to understand how services depend on each other
- You want a systematic approach rather than guessing at the problem

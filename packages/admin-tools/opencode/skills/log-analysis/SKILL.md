---
name: log-analysis
description: Guide for reading, interpreting, and correlating logs across OpenPalm stack services
license: MIT
compatibility: opencode
metadata:
  audience: assistant
  workflow: diagnostics
---

# Log Analysis

This skill teaches you how to read and interpret logs from across the OpenPalm stack. Logs are your primary window into what happened, when, and why.

## Log Sources

### 1. Docker Service Logs

Accessed via the `admin-logs` tool.

Each service writes to stdout/stderr, captured by Docker's logging driver. You can filter by service name and control the number of lines returned.

```
admin-logs                         # All services, recent logs
admin-logs service=guardian        # Specific service
admin-logs service=memory tail=100 # Last 100 lines
```

### 2. Guardian Audit Log

Accessed via the `admin-guardian-audit` tool.

**Format:** JSONL (one JSON object per line)
**Location:** `STATE_HOME/audit/guardian-audit.log`

Each entry contains:

| Field | Type | Description |
|-------|------|-------------|
| `ts` | string | ISO 8601 timestamp |
| `requestId` | string | Unique request identifier (UUID) |
| `sessionId` | string | Assistant session ID (present on successful forwards) |
| `action` | string | `inbound` (message received) or `forward` (sent to assistant) |
| `status` | string | `ok`, `denied`, or `error` |
| `reason` | string | Error code when status is `denied` |
| `error` | string | Error description when status is `error` |
| `channel` | string | Channel identifier |
| `userId` | string | Sender's user ID |

### 3. Admin Audit Log

Accessed via the `admin-audit` tool.

**Format:** JSONL (one JSON object per line)
**Location:** `STATE_HOME/audit/admin-audit.jsonl`
**In-memory buffer:** Last 1000 entries (most recent operations always available)

Each entry contains:

| Field | Type | Description |
|-------|------|-------------|
| `at` | string | ISO 8601 timestamp |
| `requestId` | string | Request identifier |
| `actor` | string | Who performed the action (e.g., `assistant`, `admin`, user identity) |
| `callerType` | string | Type of caller (e.g., `assistant`, `admin-ui`, `unknown`) |
| `action` | string | Operation performed (e.g., `containers.list`, `lifecycle.update`) |
| `args` | object | Arguments passed to the operation |
| `ok` | boolean | Whether the operation succeeded |

## Guardian Error Codes

| Code | HTTP Status | Meaning | Common Cause | Fix |
|------|-------------|---------|-------------|-----|
| `invalid_json` | 400 | Request body is not valid JSON | Malformed channel message | Check channel adapter code and logs |
| `invalid_payload` | 400 | JSON valid but required fields missing or malformed | Channel sending incomplete data | Verify payload has userId, channel, text, nonce, timestamp |
| `payload_too_large` | 413 | Request body exceeds 100KB | Large file attachment or message | Reduce payload size |
| `invalid_signature` | 403 | HMAC-SHA256 verification failed | Secret mismatch between channel and guardian | Reinstall channel or run `admin-lifecycle-update` to sync secrets |
| `rate_limited` | 429 | Too many requests in window | Bot loop or flood (120/min user, 200/min channel) | Check for loops, wait for 1-minute window reset |
| `replay_detected` | 409 | Nonce already seen within 5-minute window | Duplicate message send or replay attack | Check for duplicate sends, verify clock sync (5-min skew tolerance) |
| `assistant_unavailable` | 502 | Cannot reach assistant service | Container down, unhealthy, or timeout | Check assistant container status and logs |
| `not_found` | 404 | Unknown endpoint | Request to wrong path | Only POST /channel/inbound is accepted |

## Log Patterns by Service

### Admin Logs

| Pattern | Meaning | Action |
|---------|---------|--------|
| `"setup complete"` | Stack initialization finished | Normal — no action needed |
| `"compose up"` / `"compose down"` | Container lifecycle operation | Check if expected; verify with `admin-audit` |
| `"channel installed"` / `"channel uninstalled"` | Channel management | Verify channel appears in `admin-channels-list` |
| `"ENOENT"` | File or path not found | Check volume mounts and file paths |
| `"EACCES"` | Permission denied | Check UID/GID settings and volume ownership |
| `"ECONNREFUSED"` | Cannot connect to Docker daemon | Docker socket proxy may be down |

### Guardian Logs

| Pattern | Meaning | Action |
|---------|---------|--------|
| `"inbound ok"` | Message successfully forwarded to assistant | Normal — healthy message flow |
| `"signature mismatch"` | HMAC verification failed | Check secret sync between channel and guardian |
| `"rate limit exceeded"` | Throttling active | Identify the throttled user/channel; check for loops |
| `"assistant unreachable"` | Cannot forward to assistant | Check assistant container health |
| `"secrets_file_unreadable"` | Cannot read secrets path | Verify GUARDIAN_SECRETS_PATH and file permissions |
| `"started"` with port | Guardian server started | Normal startup message |

### Memory Logs

| Pattern | Meaning | Action |
|---------|---------|--------|
| `"embedding"` errors | Embedding model not available or failed | Verify Ollama is running and model is pulled |
| `"sqlite"` errors | Database corruption or lock | Restart memory service; check data directory |
| `"connection refused"` to Ollama | Embedding service unreachable | Ollama must be at `http://host.docker.internal:11434` |
| `"dimension"` mismatch | Vector dimensions wrong | nomic-embed-text = 768 dims; check config |
| Health check pass | Memory service healthy | Normal |

### Assistant Logs

| Pattern | Meaning | Action |
|---------|---------|--------|
| `"socat"` messages | LLM proxy setup (lmstudio workaround) | Normal for local model setups |
| `"timeout"` | LLM response took too long | Check model performance; consider faster model |
| `"OPENCODE"` | OpenCode runtime messages | Context-dependent; check for errors |
| `"varlock"` | Secret redaction active in output | Normal security behavior |
| Connection errors to admin API | Cannot reach admin | Check OP_ADMIN_API_URL and admin container |

### Caddy Logs

| Pattern | Meaning | Action |
|---------|---------|--------|
| `"dial"` errors | Cannot connect to upstream service | Upstream service is down or wrong address |
| `"tls"` messages | Certificate-related | Check TLS configuration if using HTTPS |
| `"502"` responses | Bad gateway — upstream unavailable | Check the target service (guardian or admin) |
| `"503"` responses | Service unavailable | Service may be starting up or overloaded |
| `"reverse_proxy"` | Proxy operation logged | Normal — check status code for issues |

## Cross-Service Correlation

### Using requestId

The `requestId` is the primary correlation key across services:

1. **Guardian** assigns a requestId on every inbound request (from `x-request-id` header or auto-generated UUID).
2. **Guardian audit** logs the requestId with the action and outcome.
3. **Admin** logs the requestId on all API actions triggered by the request.
4. The `message-trace` tool automates this correlation — provide a requestId and it traces the full path.

### Correlation workflow

```
1. Find the error in one service's logs
2. Extract the requestId
3. Run: message-trace requestId=<id>
4. Review the full request path across all services
5. Identify where the request failed or changed
```

## Reading Logs Effectively

Follow this progression from broad to narrow:

1. **Start broad:** `admin-logs tail=50` — all services, most recent entries. Scan for ERROR or WARN levels.
2. **Identify the failing service:** Look for which service is generating errors.
3. **Narrow down:** `admin-logs service=<name> tail=100` — focus on the specific service.
4. **Check audit logs:** `admin-guardian-audit limit=20` or `admin-audit` — see what actions were taken and their outcomes.
5. **Correlate by requestId:** `message-trace requestId=<id>` — trace a specific failing request end-to-end.
6. **Check config:** `admin-config-validate` — verify the configuration is valid after identifying the problem area.

## Common Multi-Service Failure Patterns

### Cascade Failure
**Symptom:** Multiple services unhealthy, channel messages failing.
**Pattern:** Memory goes down -> assistant health check fails -> guardian cannot forward -> all channels stop.
**Diagnosis:** Check which service failed *first* by looking at timestamps. The root cause is the first service to report errors.
**Fix:** Fix the root service. The dependency chain will recover automatically (guardian retries assistant, assistant retries memory).

### Config Drift
**Symptom:** `invalid_signature` errors in guardian audit after a config change.
**Pattern:** `secrets.env` was updated but containers were not recreated. Guardian reads secrets from a file at runtime, but channels may have cached old secrets.
**Diagnosis:** Compare the guardian's loaded secrets (check startup logs) with the channel's configured secret.
**Fix:** Run `admin-lifecycle-update` to sync all configuration. If a specific channel is affected, reinstall it.

### Resource Exhaustion
**Symptom:** `assistant_unavailable` in guardian audit, assistant container restarting.
**Pattern:** Assistant runs out of memory (OOM) processing a large model response -> health check fails -> guardian returns 502.
**Diagnosis:** Check `admin-containers-events` for OOM kill events. Check `admin-logs service=assistant` for memory-related errors.
**Fix:** Use a smaller model, increase container memory limits, or reduce concurrent sessions.

### Network Partition
**Symptom:** All inter-service calls fail simultaneously.
**Pattern:** Docker network issue causes services to lose connectivity to each other.
**Diagnosis:** All services show "connection refused" or "dial" errors at approximately the same timestamp.
**Fix:** Run `admin-lifecycle-update` to recreate networks and containers. In severe cases, `admin-containers-down` then `admin-containers-up` for the full stack.

## When to Use This Skill

Load this skill when:
- You need to understand what happened in the stack at a specific time
- You are diagnosing an error and need to read logs from multiple services
- You want to trace a specific request across the system using requestId
- You see error codes in guardian audit and need to understand their meaning
- You need to correlate events across admin audit and guardian audit
- A multi-service failure is occurring and you need to identify the root cause

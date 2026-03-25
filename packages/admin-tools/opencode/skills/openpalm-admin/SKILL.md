---
name: openpalm-admin
description: Reference guide for administering the OpenPalm platform via the admin API tools
---

# OpenPalm Admin API Reference

You have access to tools that call the OpenPalm admin API. All operations are authenticated and audited. Use these tools to manage the platform on behalf of the user.

## Architecture

OpenPalm runs as a Docker Compose stack with 4 core services plus optional addons:

| Service | Role |
|---------|------|
| **memory** | Memory service - Bun-based OpenPalm memory API backed by SQLite and `sqlite-vec` |
| **assistant** | This OpenCode instance (you) |
| **guardian** | Message routing with HMAC verification |
| **scheduler** | Lightweight automation sidecar: cron jobs, http/shell/assistant/api actions |

Optional addons (enabled via stack.yml):
| **admin** | Control plane API (protects Docker socket) |
| **chat** | OpenAI-compatible chat channel |

## Available Tool Groups

### `admin-containers` (list, up, down, restart)
Manage individual service containers. Use `list` first to see current status before making changes.

### `admin-config` (get_access_scope, set_access_scope)
View and modify the network access scope.
- **Access scope**: `host` = localhost only, `lan` = local network access

### `admin-addons` (list, enable, disable)
List, enable, or disable addons via the registry/stack addon directories.
- Shows all addons from `registry/addons/` with their enabled state from `stack/addons/`
- Enable/disable copies/removes addon directories and manages HMAC secrets for channels

### `admin-automations` (list)
List configured automations (name, schedule, enabled, action type). For live scheduler status and execution logs, query the scheduler sidecar at `http://scheduler:8090/automations`.

### `admin-artifacts` (list, manifest, get)
Inspect the generated configuration files:
- `compose` = docker-compose.yml

### `admin-connections` (get, set, status)
View and manage external API connections (secrets stored in `vault/stack/stack.env`):
- **get** (`GET /admin/connections`) = return all known connection keys with their values masked (e.g., `sk-...****`). Use this to see which keys are configured without exposing the actual values.
- **set** (`POST /admin/connections`) = patch `vault/stack/stack.env` with new API key values. Accepts a map of key/value pairs. Use this when the user needs to add or rotate an API key.
- **status** (`GET /admin/connections/status`) = returns `{ complete: boolean, missing: string[] }`. Use this to quickly check whether all required connection keys are present before starting operations that depend on them.

### `admin-audit`
View the audit trail. Every admin action is logged with timestamp, actor, action, arguments, and success/failure status. Always check the audit log when investigating issues.

### `admin-lifecycle` (install, update, uninstall, installed, upgrade)
Heavy operations that affect the entire stack:
- `install` = full stack setup (creates dirs, generates secrets, starts containers)
- `update` = regenerate config and restart containers
- `uninstall` = stop everything and tear down
- `installed` = list installed extensions and service statuses
- `upgrade` = download fresh assets from upstream, back up changed files, pull latest Docker images, and recreate all containers. Use this to apply upstream updates without a full reinstall.

### `health-check`
Quick health probe of core services (guardian, memory, admin).

## Diagnostics

These tools help investigate and troubleshoot issues across the stack.

### `admin-logs`
Read Docker logs from service containers. Filter by service name, number of lines, and time window. Use this as the first step when a service is misbehaving or returning errors.

### `admin-guardian-audit`
Read the guardian's security audit log. Shows HMAC verification results, rate limiting events, and replay detection. Use this when investigating authentication failures or suspicious channel traffic.

### `admin-config-validate`
Validate the current stack configuration. Returns errors and warnings about missing files, invalid settings, or configuration drift. Use before applying changes or when troubleshooting startup failures.

### `admin-connections-test`
Test connectivity to an LLM provider endpoint. Verifies the URL is reachable and optionally tests an API key. Use this before saving new connection settings to confirm they work.

### `admin-providers-local`
Detect local LLM providers (Ollama, Docker Model Runner, LM Studio) on the host. Use during initial setup to discover what's available without manual configuration.

### `admin-memory-models`
Check the memory service embedding model configuration and availability. Use this when memory search returns unexpected results or embedding errors appear in logs.

### `admin-containers-inspect`
Get container resource usage: CPU%, memory, network I/O, and PID count per container. Use to identify resource-hungry or leaking containers.

### `admin-containers-events`
Get recent Docker container lifecycle events: starts, stops, restarts, OOM kills, health check failures. Use to spot crash loops or unexpected restarts.

### `admin-guardian-stats`
Get internal metrics directly from the guardian: rate limiter state, nonce cache size, session count, per-channel request counts. Use to understand traffic patterns and rate limiting behavior.

### `admin-network-check`
Test inter-service network connectivity. Returns a connectivity matrix with latency. Use to diagnose DNS resolution failures or network isolation issues between containers.

### `stack-diagnostics`
Run a comprehensive diagnostic check across all services in parallel. Checks health, container status, config validation, connection status, security events, and guardian metrics. Pass `verbose: "true"` for full details; default shows only issues. **Use this as the first tool when the user reports a problem.**

### `message-trace`
Trace a request through the pipeline by its request ID. Searches both guardian and admin audit logs and returns a timeline showing how the request flowed through the system. Use to debug message delivery issues or understand request processing.

## Guidelines

1. **Always check status before acting.** Use `admin-containers-list` or `health-check` before restarting or stopping services.
2. **Explain what you're about to do** before making changes. The user should understand the impact.
3. **Check the audit log** when diagnosing issues — it shows what changed and when.
4. **Never restart the admin service** unless the user explicitly asks — it's the control plane.
5. **Be careful with lifecycle operations.** `uninstall` stops everything. `install` is idempotent but heavyweight.
6. **Access scope changes affect security.** Switching from `host` to `lan` exposes services to the local network. Always confirm with the user.
7. **Channel routing is addon-based.** Channels are installed as addons with a compose overlay in `stack/addons/<name>/`. Network access is controlled by the compose overlay's network configuration.
8. **Check connections status before operations that need external APIs.** Use `admin-connections-status` to confirm all required keys are present. Use `admin-connections-get` to see which keys are configured. Never log or expose unmasked secret values.
9. **Use `admin-lifecycle-upgrade` to apply upstream updates** without reinstalling. This downloads fresh assets, pulls latest images, and recreates containers in place.

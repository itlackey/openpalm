---
name: openpalm-admin
description: Reference guide for administering the OpenPalm platform via the admin API tools
---

# OpenPalm Admin API Reference

You have access to tools that call the OpenPalm admin API. All operations are authenticated and audited. Use these tools to manage the platform on behalf of the user.

## Architecture

OpenPalm runs as a Docker Compose stack with these services:

| Service | Role |
|---------|------|
| **caddy** | Reverse proxy, TLS termination, access control |
| **openmemory** | Memory service — lightweight mem0 SDK wrapper with embedded Qdrant |
| **assistant** | This OpenCode instance (you) |
| **guardian** | Message routing with HMAC verification |
| **admin** | Control plane API (protects Docker socket) |
| **channel-chat** | OpenAI-compatible chat API |

## Available Tool Groups

### `admin-containers` (list, up, down, restart)
Manage individual service containers. Use `list` first to see current status before making changes.

### `admin-config` (get_access_scope, set_access_scope)
View and modify the network access scope.
- **Access scope**: `host` = localhost only, `lan` = local network access

### `admin-channels` (list, install, uninstall)
List installed and available channels, install from registry, or uninstall.
- Shows installed channels and available registry channels not yet installed
- Reports whether each channel has a Caddy HTTP route (`.caddy` file) or is docker-network only
- Channel access is controlled by the `.caddy` file content, not by an API toggle

### `admin-automations` (list)
Inspect configured automations, scheduler status, and recent execution logs.

### `admin-artifacts` (list, manifest, get)
Inspect the generated configuration files:
- `compose` = docker-compose.yml
- `caddy` = caddy.json (reverse proxy config)
- `env` = secrets.env (environment variables)

### `admin-connections` (get, set, status)
View and manage external API connections (secrets stored in `secrets.env`):
- **get** (`GET /admin/connections`) = return all known connection keys with their values masked (e.g., `sk-...****`). Use this to see which keys are configured without exposing the actual values.
- **set** (`POST /admin/connections`) = patch `secrets.env` with new API key values. Accepts a map of key/value pairs. Use this when the user needs to add or rotate an API key.
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
Quick health probe of core services (guardian, openmemory, admin).

## Guidelines

1. **Always check status before acting.** Use `admin-containers_list` or `health-check` before restarting or stopping services.
2. **Explain what you're about to do** before making changes. The user should understand the impact.
3. **Check the audit log** when diagnosing issues — it shows what changed and when.
4. **Never restart the admin service** unless the user explicitly asks — it's the control plane.
5. **Be careful with lifecycle operations.** `uninstall` stops everything. `install` is idempotent but heavyweight.
6. **Access scope changes affect security.** Switching from `host` to `lan` exposes services to the local network. Always confirm with the user.
7. **Channel routing is file-based.** Channels with a `.caddy` file get HTTP routing; those without are docker-network only. Access levels (LAN vs public) are controlled by the `.caddy` file content, not by an API call.
8. **Check connections status before operations that need external APIs.** Use `admin-connections_status` to confirm all required keys are present. Use `admin-connections_get` to see which keys are configured. Never log or expose unmasked secret values.
9. **Use `admin-lifecycle_upgrade` to apply upstream updates** without reinstalling. This downloads fresh assets, pulls latest images, and recreates containers in place.

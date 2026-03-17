# @openpalm/admin-tools

OpenCode plugin that provides tools for managing the OpenPalm stack through the admin API. These tools require a running admin container and are loaded only when `OPENPALM_ADMIN_API_URL` is available.

This package is separate from `@openpalm/assistant-tools`, which contains memory-only tools that work without admin.

## Tools (35 total)

### Containers & Logs
- `health-check` -- Platform health overview
- `admin-containers_list` / `_up` / `_down` / `_restart` -- Container lifecycle
- `admin-containers_inspect` -- Detailed container inspection
- `admin-containers_events` -- Recent Docker events
- `admin-logs` -- Service log retrieval

### Configuration & Connections
- `admin-config_get_access_scope` / `_set_access_scope` -- LAN/public access control
- `admin-config_validate` -- Configuration validation
- `admin-connections_get` / `_set` / `_status` -- Connection profile management
- `admin-connections_test` -- Test provider connectivity
- `admin-providers_local` -- Detect local LLM providers (Ollama, LM Studio, etc.)
- `admin-memory_models` -- List available embedding models

### Channels
- `admin-channels_list` / `_install` / `_uninstall` -- Channel management

### Lifecycle
- `admin-lifecycle_install` / `_update` / `_uninstall` / `_upgrade` / `_installed` -- Stack lifecycle

### Automations
- `admin-automations_list` -- List loaded automations

### Diagnostics
- `admin-audit` -- Audit log review
- `admin-guardian_audit` / `_stats` -- Guardian ingress audit and stats
- `admin-network_check` -- Inter-service network connectivity
- `admin-artifacts_list` / `_manifest` / `_get` -- Staged artifact inspection
- `stack-diagnostics` -- Full stack diagnostic report
- `message-trace` -- Trace a message through the pipeline

## Skills

| Skill | Purpose |
|---|---|
| `openpalm-admin` | Admin API reference and tool documentation |
| `log-analysis` | Reading and interpreting logs across the stack |
| `stack-troubleshooting` | Diagnostic decision trees for common failures |

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `OPENPALM_ADMIN_API_URL` | `http://admin:8100` | Admin API endpoint |
| `OPENPALM_ADMIN_TOKEN` | (required) | Authentication token |

All requests use `x-admin-token` header authentication and are audit-logged with the `assistant` identity.

## Plugin Loading

The assistant container loads OpenCode plugins. Which plugins are active depends on whether admin is running:

- **Without admin**: assistant loads `@openpalm/assistant-tools` only (memory tools, health check)
- **With admin**: assistant loads both `@openpalm/admin-tools` and `@openpalm/assistant-tools` (full tool suite)

Skills (in `opencode/skills/`) are discovered by OpenCode from the package's filesystem, not registered in the plugin entry point.

## Development

```bash
cd packages/admin-tools
bun run build       # Build to dist/
bun test            # Run tests
```

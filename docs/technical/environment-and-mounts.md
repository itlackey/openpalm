# Environment, mounts, and networks

This document describes the active lean runtime. The executable source is
`packages/skeleton/system/stack/stack.compose.yml`.

## Host layout

`OP_HOME` defaults to `~/.openpalm`.

| Host path | Owner | Purpose |
|---|---|---|
| `system/` | OpenPalm release | Exact managed OpenCode and Compose files |
| `config/` | Operator | Seed-once OpenCode, AKM, and Compose settings |
| `knowledge/` | Operator and AKM | Knowledge, task sources, scoped user environment, provider auth |
| `workspace/` | Operator | Trusted local agent workspace |
| `state/stack.json` | Control plane | Versioned stack intent |
| `state/stack.env` | Control plane | Non-secret values derived from intent plus operator image pins |
| `state/credentials/` | Control plane/operator | Named Guardian key directories plus derived key-free registry |
| `state/portal-credentials/` | Control plane | Derived, adapter-scoped runtime keyrings |
| `config/guardian/oauth.json` | Operator | OAuth resource-server settings; disabled by default |
| `config/guardian/oauth-identities.json` | Operator | Exact OAuth issuer/subject to credential maps |
| `state/secrets/` | Control plane/operator | File-backed runtime credentials |
| `data/` | Containers | Assistant home, AKM state, portal SQLite files, audit logs |

Updates replace only the allowlisted managed files in `lean-seed.ts`. They seed
operator files only when absent and never synchronize or delete whole directories.

## Host-side Compose variables

The control plane writes or preserves these non-secret values in
`state/stack.env`:

| Variable | Meaning |
|---|---|
| `OP_HOME` | Absolute stack home |
| `OP_UID`, `OP_GID` | Non-root container identity |
| `OP_IMAGE_NAMESPACE` | Image namespace; default `openpalm` |
| `OP_PROJECT_NAME` | Optional Compose project name; default `openpalm` |
| `OP_STACK_CONFIG_VERSION` | Derived intent schema version |
| `OP_ENABLED_ADDONS` | Derived profiles: `gateway,discord,slack` |
| `OP_ASSISTANT_BIND_ADDRESS` | Derived native OpenCode host bind |
| `OP_ASSISTANT_PORT` | Derived native OpenCode host port |
| `OP_GUARDIAN_BIND_ADDRESS` | Derived Guardian host bind |
| `OP_GUARDIAN_PORT` | Derived Guardian host port |
| `OP_HOST_ENABLED` | Marks this home as a hosted stack |
| `OP_SETUP_COMPLETE` | Install completion marker |

Optional operator pins are `OP_ASSISTANT_VERSION`, `OP_GUARDIAN_VERSION`, and
`OP_PORTAL_VERSION`. Image defaults are stamped in the managed Compose file.

`GUARDIAN_ALLOWED_ORIGINS`, `GUARDIAN_MODERATION_TIMEOUT_MS`, and
`GUARDIAN_ASSISTANT_TIMEOUT_MS` are advanced Guardian settings. They may be
passed to the host command or preserved in
`stack.env`; neither may contain a credential. The escalation threshold is a
managed security value and cannot be raised through the user overlay.

Only OpenPalm, Guardian, Discord, and Slack interpolation keys from
`stack.env` are copied into the Docker client process. Process-control values
such as `DOCKER_HOST`, `PATH`, and `COMPOSE_FILE` are never trusted from that
file. The same sanitized environment is used for preflight and activation.

## File secrets

| Host file under `state/secrets/` | Consumers |
|---|---|
| `op_opencode_password` | Assistant, Guardian |
| `op_guardian_handle_key` | Guardian handle encryption and ownership proofs |
| `discord_bot_token` | Discord adapter |
| `slack_bot_token` | Slack adapter |
| `slack_app_token` | Slack adapter |

Named Guardian keys live at `state/credentials/<username>/key`; generated keys
contain 32 random bytes encoded as base64url. Guardian mounts the complete
credential store read-only. Each portal mounts only its generated keyring,
containing the fallback and credentials referenced by that portal's
`config/portal/<adapter>/credentials.json` user map. Bot-token files are
created empty and must be filled by the operator before their portal is enabled.
Other secrets are mounted through Compose `secrets`; no secret value belongs
in an environment variable.

Provider credentials are the deliberate exception to the `state/secrets`
location. OpenCode owns `knowledge/secrets/auth.json`; Assistant reads it
through its normal knowledge tree and OpenCode auth path, while Guardian receives
only a read-only file mount for moderation.

## Assistant

Assistant joins only `agent_net` and publishes the native OpenCode server as
`${OP_ASSISTANT_BIND_ADDRESS:-127.0.0.1}:${OP_ASSISTANT_PORT:-3810}:4096`.
The values are derived from StackConfig and may not be changed by the custom
Compose overlay. Any non-loopback bind is an explicit operator choice and
bypasses Guardian.

| Host source | Container target | Mode |
|---|---|---|
| `data/assistant` | `/home/opencode` | read/write |
| `config/assistant` | `/home/opencode/.config/opencode` | read-only |
| `knowledge/secrets/auth.json` | OpenCode auth path | read/write |
| `system/assistant` | `/etc/opencode` | read-only |
| `config/akm` | `/etc/akm` | read-only |
| `knowledge` | `/stash` | read/write |
| `data/akm/cache` | `/opt/akm/cache` | read/write |
| `data/akm/data` | `/opt/akm/data` | read/write |
| `workspace` | `/work` | read/write |

Assistant receives only the OpenCode server password. It receives no Guardian,
portal, bot, Docker, or host-admin credential.

## Guardian

Guardian joins `agent_net` and `ingress_net`. It publishes
`${OP_GUARDIAN_BIND_ADDRESS:-127.0.0.1}:${OP_GUARDIAN_PORT:-3830}:8080` only
when an ingress profile is enabled.

| Host source | Container target | Mode |
|---|---|---|
| `data/logs` | `/opt/openpalm/logs` | read/write |
| `system/guardian` | `/opt/openpalm/moderator-config` | read-only |
| `config/guardian` | Guardian OpenCode user config | read-only |
| `knowledge/secrets/auth.json` | Guardian OpenCode auth path | read-only |
| `workspace` | `/work` | read-only |
| `state/credentials` | `/run/openpalm-credentials` | read-only |

Guardian receives the named credential store, handle-signing key, and upstream
OpenCode password. It has no persistent application database or writable copy
of provider credentials. Each registry record selects a fixed managed Assistant
agent profile. Guardian reads files
through its own read-only workspace mount so MCP workspace access can reject
canonical paths and file descriptors that escape `/work`; it never delegates
that authorization decision to OpenCode's native file API.

The read-only `config/guardian` mount also carries `oauth.json` and
`oauth-identities.json`. Both are mode `0600` operator files. They contain
public identity-provider metadata and identity-to-credential names, never an
OAuth token or client secret. Guardian reads identity mappings per request;
resource-server configuration changes require a restart.

## Portal adapters

Discord and Slack join only `ingress_net`, publish no host ports, and call
`http://guardian:8080/mcp`. Each gets only its generated named-credential
keyring, platform credential files, and one adapter-specific
`data/portal/<adapter>` volume containing SQLite continuity state.

## Container hardening

All four managed services:

- run as the resolved non-root UID/GID;
- enable an init process;
- drop all Linux capabilities; and
- set `no-new-privileges:true`.

Before start or restart, the control plane resolves the complete managed file
plus user overlay and rejects boundary expansion: replaced core images or
commands, changed mounts, secrets, networks, health commands, logging, runtime
users or published ports beyond the StackConfig choices, plaintext secret-like environment values, custom
managed-secret grants or access to `agent_net`, privileged containers, added
capabilities, host namespaces/devices, and container-runtime mounts.

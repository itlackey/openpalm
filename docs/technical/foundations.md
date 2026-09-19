# Runtime foundations

This document records implementation details beneath the
[0.14 core principles](core-principles.md). It does not define additional
product scope.

## Filesystem

Everything persistent lives under `OP_HOME`, normally `~/.openpalm`:

```text
config/       operator choices and integration maps
knowledge/    AKM knowledge, skills, schedules, and OpenCode provider auth
workspace/    user working files
data/         runtime databases, caches, logs, and run history
state/        generated stack intent, derived values, and delegated secrets
system/       reproducible release-managed files
```

Lifecycle operations preserve `config/`, `knowledge/`, and `workspace/`, never
put secrets in `state/stack.env`, and never delete user data. Provider auth is
the one intentional Assistant-readable credential inside `knowledge/`;
Guardian, portal, and stack credentials remain under `state/`.

## Services

Assistant is the only default service. It provides authenticated OpenCode,
AKM-backed persistent knowledge, and scheduled AKM tasks. Its principal mounts
are `/stash` for knowledge and `/work` for working files.

Guardian is enabled by the `gateway`, `discord`, or `slack` profile. It is the
only managed service on both `agent_net` and `ingress_net` and the only path
from a portal to Assistant. It serves MCP plus health and optional OAuth
resource metadata; it has no admin, chat-compatibility, or raw OpenCode proxy.

Portal is one image configured as either the Discord or Slack adapter. Adapters
publish no host port and enforce an independent default-deny allowlist.

No managed container receives the Docker socket. The host CLI and optional
local Admin are the only Compose orchestrators.

## Credentials

- OpenCode provider auth: `knowledge/secrets/auth.json`
- OpenCode server password and platform tokens: `state/secrets/`
- Guardian named keys: `state/credentials/<username>/key`
- OAuth settings and identity maps: `config/guardian/`
- portal user maps: `config/portal/<adapter>/credentials.json`

Assistant receives only provider auth and its server password. Guardian
receives the named registry and its own secrets. Each portal receives a derived
keyring containing only referenced identities.

## Scheduling

AKM task sources live under `knowledge/tasks/`. Assistant reconciles them at
startup and periodically, while supercronic performs recurring execution.
Invalid sources fail independently and do not prevent OpenCode from starting.

The managed `openpalm-task` helper creates and manages prompt tasks through
AKM, while Assistant instructions translate ordinary-language schedule
requests into that interface. Prompt tasks use the `scheduled` OpenCode engine
and restricted scheduled-agent profile. Results persist in AKM task history;
optional reports live under `knowledge/inbox/<task-id>/`. The scheduler remains
internal and does not become a network service.

## Migration

Only user-owned, allowlisted files are portable into 0.14. `system/`, `state/`,
`data/`, legacy Compose files, and retired feature configuration are never
used to reconstruct the new control plane. See the
[0.14 transition contract](../operations/migration-to-lean-stack.md).

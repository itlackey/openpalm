# OpenCode configuration

OpenPalm uses OpenCode directly; it does not maintain a parallel agent/session abstraction.

## Assistant configuration layers

| Layer | Host path | Purpose |
|---|---|---|
| managed directory | `system/assistant` | server settings, global instructions, three Guardian profiles, restricted scheduled profile, local AKM plugin wrapper |
| user config | `config/assistant/` | operator model/provider preferences, persona, and user profile |
| provider auth | `knowledge/secrets/auth.json` | OpenCode credential store |
| workspace | `workspace` | trusted local worktree |

`OPENCODE_CONFIG_DIR=/etc/opencode` points at the managed directory. Both loaded
config directories contain a pre-seeded `.gitignore` and are mounted read-only,
so OpenCode does not bootstrap package metadata or fetch its plugin SDK at
startup. OpenCode discovers the image-baked local plugin at `plugins/akm.js`.

Project configuration, Claude compatibility discovery, external skill
discovery, and OpenCode's embedded browser UI are disabled in the hosted
process. This prevents a checked-out workspace from introducing startup code or
silently widening the managed agent surface. Workspace files remain available
to a trusted local session through normal tools.

The plugin wrapper imports the exact package baked at:

```text
/opt/openpalm/tools/node_modules/akm-opencode/dist/index.js
```

## Trusted native sessions

A client connecting to the configured Assistant endpoint uses the native
OpenCode server and normal Assistant configuration. OpenCode Basic
authentication is always enabled through the file-backed server password. The
bind defaults to `127.0.0.1:3810`; StackConfig may explicitly select another
host address and port.

The [OpenCode TUI](https://opencode.ai/docs/cli/) can connect with
`opencode attach <url>` and the `--username` and `--password` options or
corresponding environment variables. Direct native sessions do not pass
through Guardian moderation.

## Remote sessions

Guardian selects one fixed agent name from the authenticated credential's
configured policy on every message:

- `chat` -> `remote`, with `"*": deny`;
- `read` -> `remote-read`, with wildcard denial followed by explicit read,
  glob, list, `/stash`, and `/work` allowances, plus explicit denials for
  managed knowledge secrets, knowledge environment files, and `.env` reads; and
- `full` -> `remote-full`, with no profile permission override, so the global
  Assistant permission configuration remains authoritative.

All profiles treat input and retrieved content as untrusted and forbid secret
or unrelated-data disclosure. Wildcard denial in `chat` and `read` means a
newly installed tool is denied without needing an OpenPalm update.

## Guardian moderator

Guardian starts a separate OpenCode server on container loopback port 4097. It uses:

- managed config from `system/guardian`;
- operator model selection from `config/guardian/opencode.json`; and
- the same provider `auth.json` through a read-only file mount.

The moderator managed configuration denies every tool. It creates an ephemeral session per escalated input and deletes it after classification. Moderator unavailability blocks the suspicious message.

The moderator uses the same read-only, pre-seeded config-directory contract as
Assistant. Its process performs no package installation at boot.

## Scheduler

Supercronic runs inside Assistant. AKM task source files live in
`knowledge/tasks/*.yml`. `config/akm/config.json` defines a `scheduled` engine
that attaches to the already-running authenticated OpenCode server and selects
the restricted `scheduled` profile. At startup and every 60 seconds:

```bash
akm task sync --rebind
```

Invalid tasks are reported without preventing OpenCode from starting. OpenPalm
seeds no default tasks in a fresh installation. The 0.14 importer stages
allowlisted legacy task definitions as disabled until the user reviews their
schedule, policy, tools, secrets, and result destination.

The image-baked `openpalm-task` helper is the single mutation boundary for both
Assistant-created and host-CLI task operations. It prepends hostile-content
guidance, validates task IDs and AKM sources, reconciles the scheduler, and
preserves removed definitions under `knowledge/disabled-tasks/`. Editing task
files is an advanced interface, not the primary product experience.

## Credentials

The Assistant entrypoint never sources `knowledge/env/user.env` into its own process. User commands that need those values should explicitly use AKM's scoped environment execution. Provider credentials use OpenCode's `auth.json` rather than Compose environment variables.

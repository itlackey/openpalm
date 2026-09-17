# Managing OpenPalm

## Lifecycle

```bash
openpalm start
openpalm restart
openpalm stop
openpalm status
openpalm logs
openpalm doctor
openpalm update
```

Start and restart validate the fully resolved Compose project before changing
containers. Stop uses `docker compose down` without `--volumes`. The lean CLI
has no uninstall or purge command.

## Stack intent

The sole intent document is `state/stack.json`:

```json
{
  "version": 2,
  "assistant": {
    "bindAddress": "127.0.0.1",
    "port": 3810
  },
  "gateway": {
    "enabled": false,
    "bindAddress": "127.0.0.1",
    "port": 3830
  },
  "credentials": {
    "owner": { "id": "owner", "policy": "full" },
    "discord": { "id": "discord", "policy": "chat" },
    "slack": { "id": "slack", "policy": "chat" }
  },
  "portals": {
    "discord": { "enabled": false, "credential": "discord" },
    "slack": { "enabled": false, "credential": "slack" }
  }
}
```

Inspect or update it through the CLI:

```bash
openpalm config show
openpalm config path
openpalm config assistant --bind 127.0.0.1 --port 3810
openpalm config gateway --bind 127.0.0.1 --port 3830
openpalm credential add automation read
openpalm credential set-policy automation full
openpalm credential rotate automation
openpalm config portal discord --credential automation
openpalm addon list
openpalm addon enable gateway
openpalm addon disable gateway
```

Discord or Slack implies Gateway. Disable both portals before disabling their
Gateway. Unknown JSON keys are rejected.

## Interfaces

Trusted tools can use the native OpenCode API. It defaults to loopback, but the
Assistant bind can be set to an exact IPv4 or IPv6 address. Native access uses
OpenCode Basic authentication and bypasses Guardian screening.

Guarded tools use MCP Streamable HTTP at Guardian's `/mcp` route with an
Authorization bearer header. Guardian exposes a policy-filtered agent catalog;
start with `openpalm.catalog.get` and `openpalm.agent.run`. See
[the MCP contract](technical/api-spec.md).

Each named Guardian credential has one policy:

| Policy | Assistant profile | Capability |
|---|---|---|
| `chat` | `remote` | No tools |
| `read` | `remote-read` | Read/list `/stash` and `/work`, excluding managed secret/env paths |
| `full` | `remote-full` | Inherit Assistant OpenCode permissions |

Moderation, authentication, rate limits, encrypted handles, and session
ownership checks apply to all three policies. Pending OpenCode questions and
permissions are returned as opaque interactions. `full` clients may answer
`ask` decisions explicitly; `chat` and `read` clients can only reject a
permission.

`read` is a confidentiality grant as well as a no-write policy. Managed
knowledge secrets, knowledge environment files, and `.env` reads are denied,
but other readable workspace and knowledge content is visible to that
credential. Keep additional credentials outside those trees or use `chat`.

OpenPalm does not operate a chat UI. Any standards-compliant MCP client can be
the user interface.

## Secrets

Named Guardian keys are individual files at
`state/credentials/<username>/key`. Credential and key files are mode 0600 and
their directories are mode 0700. Other runtime credentials remain under
`state/secrets/`. Fill platform bot token files directly on the host before
enabling their portal.

Provider credentials remain in `knowledge/secrets/auth.json`. That file is
Assistant-readable by design; delegated Guardian and platform credentials are
not.

Never put credentials in:

- `state/stack.env`;
- `state/stack.json`;
- Compose `environment`;
- command arguments; or
- logs.

## Custom Compose

The only operator overlay is:

```text
~/.openpalm/config/stack/custom.compose.yml
```

It is seeded once and never overwritten. It can add a separate integration
service or apply a deliberate local override. OpenPalm rejects overlays that
weaken core grants, networks, non-root hardening, the configured Assistant
publication, secret boundaries, or container-runtime isolation. Change the
native bind through StackConfig rather than a Compose override.

Use one network per trust side. A custom external adapter belongs on
`ingress_net` and should call Guardian MCP. It must not join `agent_net`.

## Scheduled tasks and knowledge

AKM state is under `knowledge/`; scheduled task sources live in
`knowledge/tasks/*.yml`. Assistant runs `akm task sync --rebind` at startup
and every 60 seconds. Invalid task sources are reported without preventing
Assistant from starting.

`knowledge/env/user.env` is scoped AKM environment state. Assistant does not
source it at boot.

## Optional Admin

OpenPalm Admin is a static Electron utility that calls the same lean library as
the CLI. It can show status, edit StackConfigV2, apply lifecycle operations, and
read recent logs. It contains no web server, chat client, updater, tray process,
or second control plane.

## Backup

Back up `config/`, `knowledge/`, `workspace/`, `state/`, and any needed
`data/` directories while the stack is stopped. Never restore a
`state/secrets/` tree into a less trusted machine. The `system/` tree can be
recreated by `openpalm update --no-start`.

# OpenPalm

OpenPalm is a small self-hosted agent stack built around OpenCode.

The default installation is one container: **Assistant**. It exposes the native, authenticated OpenCode server on host loopback and includes AKM-backed knowledge plus scheduled tasks. Add the optional **Guardian** for screened MCP access. Guardian authenticates every request, screens hostile input, and applies the authenticated named credential's `chat`, `read`, or `full` policy.

There is no bundled chat application. Use any client that speaks MCP or the native OpenCode API. A static desktop admin utility is available as an optional stack-management aid; it is not part of the runtime.

## Runtime

```text
trusted OpenCode client ── native OpenCode HTTP ─────────────> Assistant

MCP client ── bearer auth ──> Guardian ── policy-scoped call ──> Assistant
Discord/Slack ── unified Portal MCP client ──┘
```

| Component | Default | Purpose |
|---|---:|---|
| Assistant | on | OpenCode, AKM knowledge, and the task scheduler |
| Guardian | off | Authenticated MCP ingress and malicious-input screening |
| Discord adapter | off | Default-deny Discord bridge through Guardian MCP |
| Slack adapter | off | Default-deny Slack bridge through Guardian MCP |
| Admin desktop app | separate | Optional local stack editor and lifecycle control |

OpenPalm deliberately does not ship a chat UI, OpenAI-compatible API, Anthropic-compatible API, A2A server, model server, voice stack, VPN, service catalog, or containerized admin plane.

## Install

Requirements:

- Docker Engine with Docker Compose v2
- Linux, macOS, or Windows with a supported Docker environment
- a provider configured through OpenCode

From a release:

```bash
npm install --global openpalm
openpalm install
```

From this repository:

```bash
bun install
bun run packages/cli/src/main-lean.ts install
```

The install creates `~/.openpalm` by default. Set `OP_HOME` to use another absolute location. The Assistant endpoint defaults to:

```text
http://127.0.0.1:3810
```

Attach an OpenCode TUI or another native client and authenticate as `opencode`
with the password stored at:

```text
~/.openpalm/state/secrets/op_opencode_password
```

For example, load the password without placing it in the command arguments:

```bash
IFS= read -r OPENCODE_SERVER_PASSWORD < ~/.openpalm/state/secrets/op_opencode_password
export OPENCODE_SERVER_PASSWORD
opencode attach http://127.0.0.1:3810
unset OPENCODE_SERVER_PASSWORD
```

To allow a client on a trusted network to connect directly:

```bash
openpalm config assistant --bind 192.168.1.10 --port 3810
```

This bypasses Guardian by design. OpenCode Basic authentication remains
mandatory, but the native server is plain HTTP; use a private network or
operator-managed TLS and do not publish it directly to the internet.

Provider authentication remains in OpenCode's standard `auth.json`, mounted from:

```text
~/.openpalm/knowledge/secrets/auth.json
```

## Enable MCP ingress

```bash
openpalm addon enable gateway
```

Guardian defaults to loopback at `http://127.0.0.1:3830/mcp`. Install creates `owner`, `discord`, and `slack` credentials. Their keys live under:

```text
~/.openpalm/state/credentials/<username>/key
```

Guardian publishes a curated MCP agent catalog rather than a chat shim or raw
OpenCode proxy. Every client can use tools for guarded agent runs, resumable
jobs, owned sessions (including messages, diffs, and todos), and human-input responses. `read` and `full` policies add
bounded workspace search/read; `full` adds session mutation and explicit
permission decisions. Richer clients also receive session/job/workspace
resources and workflow prompts.

Session, message, job, and interaction values are encrypted, expiring,
principal-scoped handles. Clients never receive upstream OpenCode IDs. Start
with `openpalm.catalog.get` to inspect the authenticated catalog and
`openpalm.agent.run` to do work. The same endpoint negotiates modern MCP and
supports stateless 2025-era clients.

Credentials are reusable across direct MCP clients and portals. Create and manage them by username:

```bash
openpalm credential list
openpalm credential add automation read
openpalm credential set-policy automation full
openpalm credential rotate automation
openpalm credential show automation --show-key
```

`add` and `rotate` generate a strong key by default. Use `--key-file <path>` or
`--key-file -` to supply one without putting it in process arguments. Keys must
contain 32–512 printable non-whitespace ASCII characters. Credential metadata
and portal assignments live in `state/stack.json`; raw keys do not.

- `chat` denies every Assistant tool.
- `read` gives the managed agent read/list access to non-secret `/stash` and
  `/work` content and exposes bounded non-secret `/work` search/read operations
  to the MCP client. It permits no writes, shell commands, or network tools.
  Treat every other readable file in those allowed trees as visible to that
  credential.
- `full` adds no Guardian-specific tool denial; the Assistant's OpenCode
  permission configuration remains authoritative.

### Use Guardian from OpenCode

The bundled OpenCode version can consume Guardian as a remote MCP server. Keep
the bearer token in the client process environment, not in project config:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "openpalm": {
      "type": "remote",
      "url": "http://127.0.0.1:3830/mcp",
      "oauth": false,
      "headers": {
        "Authorization": "Bearer {env:OPENPALM_MCP_TOKEN}"
      },
      "timeout": 45000
    }
  }
}
```

Then load the desired named credential before starting that client:

```bash
IFS= read -r OPENPALM_MCP_TOKEN < ~/.openpalm/state/credentials/owner/key
export OPENPALM_MCP_TOKEN
opencode
unset OPENPALM_MCP_TOKEN
```

OpenCode receives the same policy-filtered tools as any other MCP client; it is
not limited to a chat operation. See the upstream
[remote MCP configuration](https://opencode.ai/v2/docs/mcp-servers) when using
a newer OpenCode release whose config layout differs from the bundled version.

To bind Guardian to a specific LAN address:

```bash
openpalm config gateway --bind 192.168.1.10 --port 3830
```

Do not publish Guardian directly to the public internet without a properly configured TLS reverse proxy and an explicit origin allowlist.

## Optional portals

```bash
openpalm addon enable discord
openpalm addon enable slack
```

Enabling either adapter also enables Guardian. Assign any named credential to a portal:

```bash
openpalm config portal discord --credential support-bot
openpalm config portal slack --credential support-bot
```

That credential is the portal fallback. Map individual platform users to any
other named credential and policy:

```bash
openpalm credential map discord 123456789012345678 support-read
openpalm credential map slack U012ABCDEF automation-full
openpalm credential mappings discord
openpalm credential unmap discord 123456789012345678
```

Direct MCP clients authenticate with the key of the credential whose policy
they should receive. For portals, the sender's exact platform user ID selects
the mapped credential; an unmapped allowed user receives the portal fallback.
All portal allowlists still apply first. The control plane generates a separate
least-privilege keyring for each portal containing only its fallback and mapped
credentials; Assistant receives none of them. Bot credentials remain in
`state/secrets/`. OAuth identity mapping remains a future layer over the same
named registry.

## Day-two commands

```bash
openpalm status
openpalm doctor
openpalm logs
openpalm start
openpalm restart
openpalm stop
openpalm config show
openpalm addon list
openpalm update
```

`stop` removes containers and networks but never volumes or operator data. OpenPalm has no purge command in the lean CLI.

## Upgrade from 0.13

Run:

```bash
openpalm update --no-start
openpalm config show
openpalm start
```

The migration derives `state/stack.json` from existing intent, activates only Guardian/Discord/Slack settings that still exist, and preserves all legacy files and data. It does not automatically delete retired UI, voice, model, VPN, Paperclip, or old portal state. See [migration-to-lean-stack.md](docs/operations/migration-to-lean-stack.md) and [deletion-manifest.md](docs/technical/deletion-manifest.md).

## Development

```bash
bun install
bun run check
bun run test
bun run lint

./scripts/dev-setup.sh --seed-env
bun run dev:build
```

The authoritative architecture and security rules are in [core-principles.md](docs/technical/core-principles.md). The active document map is [docs/README.md](docs/README.md).

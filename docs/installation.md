# Installation

## Requirements

- Docker Engine with Docker Compose v2
- a non-root operator account
- outbound access to the chosen model provider
- an OpenCode-compatible local client, or an MCP client when Guardian is enabled

## Install a release

```bash
npm install --global openpalm
openpalm install
```

Set `OP_HOME` before the command to use a location other than
`~/.openpalm`. The installer writes a lean home, creates strong file secrets,
and starts only Assistant. It does not launch a browser or install a chat UI.

To prepare files without starting Docker:

```bash
openpalm install --no-start
```

For a declarative install, pass a complete
[StackConfigV2](technical/architecture.md#control-plane):

```bash
openpalm install --config ./stack.json --no-start
```

## Configure the model provider

OpenCode provider credentials live at:

```text
~/.openpalm/knowledge/secrets/auth.json
```

Use OpenCode's normal provider authentication flow. Do not place provider keys
in `state/stack.env`, Compose environment variables, or the custom overlay.

## Connect locally

Assistant publishes the native authenticated OpenCode API on:

```text
http://127.0.0.1:3810
```

The server password is:

```text
~/.openpalm/state/secrets/op_opencode_password
```

Load the password into the environment and attach the OpenCode TUI:

```bash
IFS= read -r OPENCODE_SERVER_PASSWORD < ~/.openpalm/state/secrets/op_opencode_password
export OPENCODE_SERVER_PASSWORD
opencode attach http://127.0.0.1:3810
unset OPENCODE_SERVER_PASSWORD
```

[OpenCode's `attach` command](https://opencode.ai/docs/cli/) supports a
Basic-authenticated remote server. The username defaults to `opencode`; the
[server authentication contract](https://opencode.ai/docs/server/) is owned by
OpenCode rather than reimplemented by OpenPalm.

Loopback is the secure default. A trusted network client can connect directly
after an explicit bind change:

```bash
openpalm config assistant --bind 192.168.1.10 --port 3810
```

Direct access bypasses Guardian moderation and is plain HTTP. Keep it on a
private network or terminate TLS in operator-managed infrastructure. Use
Guardian for screened untrusted input.

## Optional MCP gateway

```bash
openpalm addon enable gateway
```

Guardian listens on `http://127.0.0.1:3830/mcp` and accepts every configured
named bearer credential. The initial owner key is stored at:

```text
~/.openpalm/state/credentials/owner/key
```

Configure a LAN bind only with explicit intent:

```bash
openpalm config gateway --bind 192.168.1.10 --port 3830
```

Terminate TLS in a separately managed reverse proxy before exposing Guardian
outside a trusted network.

The initial owner credential defaults to `full`; Discord and Slack default to
`chat`. Add credentials and assign them to portals with:

```bash
openpalm credential add automation read
openpalm credential set-policy automation full
openpalm config portal discord --credential automation
```

## Verify

```bash
openpalm doctor
openpalm status
openpalm logs
```

`doctor` checks permissions, credentials, Docker, resolved Compose, and the
managed security boundaries.

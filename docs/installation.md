# Installation

OpenPalm 0.14 is designed as a fresh install. Do not point it at a 0.13 or
legacy `OP_HOME`; follow the [0.14 transition guide](operations/migration-to-lean-stack.md)
instead.

## Requirements

- Docker Engine with Docker Compose v2;
- a non-root operator account;
- outbound access to an AI provider supported by OpenCode; and
- a client such as OpenCode, Claude Desktop, or another MCP client.

## Install

```bash
npm install --global openpalm
openpalm install
```

`openpalm install` creates the lean home, starts Assistant, checks for a usable
provider, and hands an interactive terminal to OpenCode's native sign-in flow
when authentication is needed. Setup is marked complete only after a real,
no-tool Assistant request succeeds.

Set `OP_HOME` before the command to use an absolute path other than
`~/.openpalm`. Use `--no-start` when preparing a home for review:

```bash
openpalm install --no-start
```

Assistant is the only default service. Guardian, Discord, and Slack are opt-in.
OpenPalm does not install a browser chat application or model server.

## Provider sign-in

The normal user chooses a provider in OpenCode's native sign-in flow. They do
not need to enter a base URL, select an SDK, edit JSON, or know a model ID.
Advanced OpenCode configuration remains available after setup.

Provider commands are also available directly:

```bash
openpalm provider list
openpalm provider login [provider]
openpalm provider key <provider> --key-file /private/path/to/key
openpalm provider test
openpalm provider logout <provider>
```

Use `--key-file -` to read an API key from standard input without putting it in
shell history. `provider test` sends a small real request and may incur normal
provider usage.

OpenPalm does not store a second copy of provider configuration. OpenCode owns
provider discovery, models, and the credential format. Its credential file is
mounted from:

```text
~/.openpalm/knowledge/secrets/auth.json
```

For a staged or headless install, write the home first and complete setup later:

```bash
openpalm install --no-start
openpalm provider key <provider> --key-file /run/secrets/provider-key
openpalm setup
```

`openpalm setup` is idempotent: it starts Assistant, verifies provider
readiness, and invokes the native interactive sign-in only when necessary.

## Import an older home

0.14 never upgrades an older home in place. Keep the old home stopped and
unchanged, choose a new `OP_HOME`, and import before completing setup:

```bash
export OP_HOME=/absolute/path/to/new-openpalm
openpalm install --no-start
openpalm import --from /absolute/path/to/old-openpalm --dry-run
openpalm import --from /absolute/path/to/old-openpalm --apply
openpalm setup
```

Provider authentication, user environment values, portal maps, and OAuth maps
require separate `--include-*` flags. Recreate named Guardian credentials
before importing a map that references them. Imported task files are staged
under `knowledge/imported-tasks/`. Only declarative `akm/command` prompt tasks
can be adopted; command and workflow tasks require manual recreation. Review
and adopt a prompt task in paused state with:

```bash
openpalm task adopt "$OP_HOME/knowledge/imported-tasks/example.yml"
openpalm task show example
openpalm task resume example
```

See [Moving to 0.14](operations/migration-to-lean-stack.md) for the full safety
contract.

## Connect a trusted local client

Assistant publishes the authenticated native OpenCode server on:

```text
http://127.0.0.1:3810
```

The username is `opencode`. The generated password is stored at:

```text
~/.openpalm/state/secrets/op_opencode_password
```

For the OpenCode TUI:

```bash
IFS= read -r OPENCODE_SERVER_PASSWORD < ~/.openpalm/state/secrets/op_opencode_password
export OPENCODE_SERVER_PASSWORD
opencode attach http://127.0.0.1:3810
unset OPENCODE_SERVER_PASSWORD
```

Native access is the trusted, full-fidelity path and bypasses Guardian. It is
plain HTTP and loopback-only by default. An advanced operator can select an
exact private address:

```bash
openpalm config assistant --bind 192.168.1.10 --port 3810
```

Use a private network or operator-managed TLS. Never publish it directly to
the internet.

## Add guarded MCP access

```bash
openpalm addon enable gateway
openpalm credential add personal-client read
openpalm credential show personal-client --show-key
```

Guardian listens at `http://127.0.0.1:3830/mcp`. Give each person or client a
separate named identity so its policy can be changed or revoked independently.

Use the [Claude Desktop extension](claude-desktop.md) for local Claude. Use the
[Remote MCP guide](remote-mcp.md) for a public HTTPS URL with an external OAuth
provider. Static bearer keys are appropriate for local and controlled machine
clients; a public connector should use OAuth identity mappings.

## Add a portal

Discord and Slack are optional adapters to the same Guardian identity model:

```bash
openpalm addon enable discord
openpalm credential add household read
openpalm credential map discord 123456789012345678 household
```

Configure the platform token and default-deny allowlist as described in the
[Discord](portals/discord-setup.md) or [Slack](portals/slack-setup.md) guide.

## Create recurring work

Ask the trusted Assistant in ordinary language, for example: “Every weekday at
8 AM, check the news about Northstar and save a concise report.” Assistant
confirms the schedule and uses the managed task helper. The equivalent explicit
commands are:

```bash
openpalm task create northstar-news \
  --schedule '0 8 * * 1-5' \
  --prompt 'Check the news about Northstar and save a concise report'
openpalm task run northstar-news
openpalm task history northstar-news
```

Scheduled tasks use a restricted unattended agent: it can read non-secret
knowledge/workspace data, fetch public web content, and write only below
`knowledge/inbox/`. AKM retains durable run history independently of portals.

## Verify readiness

```bash
openpalm doctor
openpalm doctor --readiness
openpalm status
openpalm logs
```

Before relying on the installation, verify all of the following:

1. the selected provider completes a real agent response;
2. the agent can store and retrieve a small piece of AKM knowledge;
3. a test recurring task runs and leaves a durable result;
4. the chosen local client reconnects after an Assistant restart; and
5. each enabled Guardian identity sees only its configured policy.

Provider readiness is automatic during setup and available later through
`provider test` or `doctor --readiness`. Knowledge recall and the contents of a
task result remain user-level acceptance checks because they depend on the
chosen provider and request.

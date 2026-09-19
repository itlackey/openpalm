# OpenPalm

OpenPalm is a single-install personal AI agent built on OpenCode.

It gives one person a private agent with durable AKM knowledge and recurring
work. OpenPalm handles the runtime, persistence, and safe access paths so the
user does not need to assemble containers, provider endpoints, model IDs, or
another chat application.

The 0.14 product path is deliberately small:

```text
install -> sign in to an AI provider -> verify -> use the agent -> schedule work
```

0.14 is a clean break from the older all-in-one stack. The maintained
documentation describes only this lean product path; older material is
historical reference.

## What is included

| Component | Default | Purpose |
|---|---:|---|
| Assistant | on | OpenCode agent, AKM knowledge, and recurring tasks |
| Guardian | off | Authenticated, policy-scoped MCP and hostile-input screening |
| Discord/Slack Portal | off | Platform adapters that use Guardian MCP |
| CLI | host | Install, configure, diagnose, back up, and run the stack |
| Admin | separate | Optional local setup and stack-management utility |
| Claude Desktop extension | separate | Local Claude-to-Guardian MCP bridge |

Assistant is the only default container. There is no bundled chat UI, model
server, OpenAI/Anthropic compatibility API, A2A server, voice stack, VPN, or
containerized administration plane.

## How users access the agent

```text
trusted OpenCode client -------------------------------> Assistant

MCP client / Claude Desktop ----> Guardian ------------> Assistant
Discord / Slack ----------------> Portal -> Guardian ---^
```

Trusted local clients use the complete native OpenCode interface. Guardian is
optional and provides the guarded path for MCP, remote, and portal traffic.
Each Guardian identity has a reusable `chat`, `read`, or `full` policy. Direct
MCP keys, OAuth users, Discord users, and Slack users all map to that same
credential registry.

Guardian is a full agent integration rather than a chat shim: clients can run
and resume work, inspect owned sessions and jobs, answer explicit interactions,
and use the workspace capabilities allowed by their policy.

## Install

Requirements:

- Docker Engine with Docker Compose v2;
- a non-root user; and
- an account with a provider supported by OpenCode.

```bash
npm install --global openpalm
openpalm install
```

From this repository:

```bash
bun install
bun run packages/cli/src/main-lean.ts install
```

OpenPalm installs to `~/.openpalm` unless `OP_HOME` names another absolute
path. Assistant listens on `http://127.0.0.1:3810` by default.

The installer starts Assistant, delegates sign-in to OpenCode's native provider
flow when needed, and completes only after a small real agent request succeeds.
Users can rerun that flow with `openpalm setup` or manage it explicitly with
`openpalm provider list|login|key|logout|test`. See
[Installation](docs/installation.md).

Useful lifecycle commands are:

```bash
openpalm status
openpalm doctor
openpalm logs
openpalm start
openpalm restart
openpalm stop
```

## Knowledge and recurring work

The agent's durable knowledge, skills, and task definitions live under
`~/.openpalm/knowledge`. Its working files live under
`~/.openpalm/workspace`. Restarts and ordinary updates preserve both.

The Assistant can translate an ordinary-language request such as “Every
weekday at 8, check the news about this project and add a summary to my inbox”
into a managed recurring task. `openpalm task` provides the equivalent explicit
list/create/show/pause/resume/run/history/remove interface. AKM retains every
run's result and the restricted scheduled agent may also write reports under
`knowledge/inbox/<task-id>/`.

## Optional guarded MCP

Enable Guardian and create a dedicated identity:

```bash
openpalm addon enable gateway
openpalm credential add claude-desktop read
openpalm credential show claude-desktop --show-key
```

Guardian listens on `http://127.0.0.1:3830/mcp` by default. Credential keys are
private files under:

```text
~/.openpalm/state/credentials/<username>/key
```

Policies are intentionally simple:

| Policy | Meaning |
|---|---|
| `chat` | converse without Assistant tools |
| `read` | add bounded non-secret knowledge/workspace reads |
| `full` | use Assistant permissions without additional Guardian tool denial |

For a local Claude Desktop connection, install the versioned `.mcpb` release
artifact and follow [Claude Desktop setup](docs/claude-desktop.md). For a
public URL, keep Guardian behind an operator-managed HTTPS reverse proxy,
enable its OAuth resource-server mode, and follow
[Remote MCP](docs/remote-mcp.md).

Do not expose the native OpenCode or Guardian HTTP listeners directly to the
public internet.

## Optional Discord and Slack access

```bash
openpalm addon enable discord
openpalm addon enable slack
openpalm credential add family read
openpalm credential map discord 123456789012345678 family
openpalm credential map slack U012ABCDEF family
```

Portal allowlists remain default-deny. An exact platform-user mapping selects
the same named credential and policy used by MCP; an unmapped allowed user gets
the portal's configured fallback identity.

## 0.14 is a clean break

0.14 does not perform an in-place upgrade of a 0.13 or legacy home. The safe
path is to keep the old home as a backup, install 0.14 into a new empty home,
preview an allowlisted import, and bring across only user-owned knowledge,
schedules, workspace files, and supported configuration.

Old Compose files, generated state, service databases, caches, and retired
feature settings do not migrate. Access credentials are recreated. Provider
credentials and other secrets require explicit import approval. Imported
schedules remain inactive until reviewed.

`openpalm import` previews the allowlisted copy by default and applies only with
`--apply`. It never mutates the old home, refuses conflicts and symlinks,
requires explicit flags for secrets and identity maps, and stages old task
sources outside the active scheduler until they are reviewed. See
[the 0.14 transition guide](docs/operations/migration-to-lean-stack.md).

## Development

```bash
bun install
bun run check
bun run test
bun run lint
```

The normative product and security boundary is
[OpenPalm 0.14 core principles](docs/technical/core-principles.md). The
maintained document map is [docs/README.md](docs/README.md).

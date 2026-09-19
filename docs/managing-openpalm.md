# Managing OpenPalm

Most users should need only the setup flow, their chosen client, and a few
lifecycle commands. File-level configuration is an advanced interface.

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

`stop` removes containers and networks without deleting volumes or user data.
The CLI has no purge command.

## Provider and readiness

OpenPalm uses OpenCode's provider support and credential store. The 0.14 setup
flow guides native provider sign-in and verifies a real agent request without
asking an ordinary user to configure a provider endpoint or model ID.

Provider auth persists at `knowledge/secrets/auth.json`. Advanced OpenCode
model preferences live in `config/assistant/opencode.json`.

Use these explicit controls when needed:

```bash
openpalm provider list
openpalm provider login [provider]
openpalm provider key <provider> --key-file <path|->
openpalm provider logout <provider>
openpalm provider test
```

Run `openpalm doctor` whenever the agent cannot answer. It distinguishes setup,
provider authentication, private files, task configuration, Docker, Compose,
and security-boundary failures. `openpalm doctor --readiness` also sends a
small real model request.

## Knowledge and recurring work

The user-facing contract is conversational. Examples:

- “Remember that my project is called Northstar.”
- “Every weekday at 8 AM, check the news about Northstar.”
- “Save each result to my inbox and send the short version to Slack.”
- “Pause that news check until next month.”

The trusted Assistant translates those requests into AKM knowledge and
schedules, confirms material side effects, and uses the managed task helper.
Every run retains durable AKM history independently of optional delivery; the
restricted scheduled agent can additionally save reports below
`knowledge/inbox/<task-id>/`.

The matching explicit CLI is:

```bash
openpalm task list
openpalm task create project-news --schedule '0 8 * * 1-5' \
  --prompt 'Check project news and save a concise report'
openpalm task show project-news
openpalm task run project-news
openpalm task history project-news
openpalm task pause project-news
openpalm task resume project-news
openpalm task remove project-news
```

`remove` unschedules the task but preserves its source under
`knowledge/disabled-tasks/`. Imported task sources begin outside the active
task directory and `openpalm task adopt <file>` installs one in paused state.

Advanced users may inspect AKM task sources under `knowledge/tasks/`, but they
do not need to edit YAML for the core experience. The CLI currently accepts a
cron expression; conversational scheduling translates ordinary time phrases
before invoking the same helper.

## Access choices

Use native OpenCode for a trusted local or private-network client. It is the
complete interface and bypasses Guardian screening.

Use Guardian for MCP, public connectors, Claude Desktop, Discord, Slack, or any
client that should receive an explicit policy. Guardian identities are managed
with:

```bash
openpalm credential list
openpalm credential add research read
openpalm credential set-policy research full
openpalm credential rotate research
openpalm credential show research --show-key
```

Use `openpalm connect opencode|mcp|claude|remote` to print the exact settings
for a client. Secrets are represented by private file paths unless their
explicit reveal flag is supplied.

Policies are:

| Policy | Capability |
|---|---|
| `chat` | agent conversation with tools denied |
| `read` | chat plus bounded non-secret knowledge/workspace reads |
| `full` | Assistant policy without additional Guardian tool denial |

A policy is an authorization choice, not merely a write toggle: a `read`
identity can see allowed knowledge and workspace content. Give people and
clients separate identities so access can be changed or revoked independently.

## Map identities to portals and OAuth

The same named credential can be used directly with MCP or selected by an exact
platform identity:

```bash
openpalm credential map discord 123456789012345678 research
openpalm credential map slack U012ABCDEF research
openpalm credential mappings discord
openpalm credential mappings slack
```

For OAuth, configure Guardian as a resource server and map the external
issuer/subject pair to an existing named credential:

```bash
openpalm config oauth \
  --resource https://agent.example/mcp \
  --issuer https://id.example/ \
  --jwks-url https://id.example/jwks.json \
  --audience https://agent.example/mcp \
  --scopes openpalm

openpalm credential map oauth https://id.example/ subject-123 research
```

Discord and Slack allowlists apply before credential mapping and remain
default-deny. Guardian never infers a policy from OAuth scopes or platform
roles.

## Advanced stack intent

`state/stack.json` is the only stack-intent document. Use the CLI rather than
editing it directly:

```bash
openpalm config show
openpalm config assistant --bind 127.0.0.1 --port 3810
openpalm config gateway --bind 127.0.0.1 --port 3830
openpalm addon list
openpalm addon enable gateway
openpalm addon disable gateway
```

The only user Compose extension is
`config/stack/custom.compose.yml`. It is an advanced escape hatch for a
separate integration service, not a way to replace core images or weaken
managed security boundaries.

## Backup and recovery

Create a portable recovery directory without stopping the agent:

```bash
openpalm backup --to /absolute/path/to/new-or-empty-backup
```

The backup copies the allowlisted `knowledge/`, `workspace/`, Assistant
preferences, and AKM configuration, records a SHA-256 integrity manifest, and
can be passed to `openpalm import --from`. Active task definitions are restored
into the review-required staging area. Restore verifies every recorded size and
checksum and refuses unrecorded allowlisted files. Symlinks and non-regular
files are reported rather than followed.

Provider authentication, user environment values, portal identity maps, and
OAuth configuration require explicit backup flags:

```bash
openpalm backup --to /absolute/path/to/private-backup \
  --include-provider-auth \
  --include-user-env \
  --include-portal-maps \
  --include-oauth
```

For a complete rollback snapshot of an old release, stop the old stack and use
your operating system's backup tool on its full `OP_HOME`. Do not treat
`system/`, `state/`, or `data/` as a portable configuration API.

0.14 recovery and migration use a fresh installation followed by an
allowlisted import. Provider credentials require an explicit secret import;
Guardian and portal access credentials are recreated. Imported schedules stay
inactive until reviewed. See [the 0.14 transition guide](operations/migration-to-0.14.md).

## Optional Admin

Admin wraps fresh installation and Assistant startup, stack configuration and lifecycle, provider
API-key readiness, credential creation/rotation/removal, Discord and Slack user
mapping, portal tokens and allowlists, backup/import, and bounded log viewing
in a local GUI. Interactive provider OAuth remains delegated to the CLI's
native OpenCode sign-in flow.

Admin is not the chat client, a web server, a background control plane, or a
requirement for headless installs. It uses the same filesystem and control-plane
library as the CLI. Sensitive inputs are password fields; bearer-key reveal is
an explicit confirmed action and remains masked until the operator chooses to
show it.

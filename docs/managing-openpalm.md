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

Stop the stack before taking a consistent whole-home backup. The most important
portable data is:

- `knowledge/`;
- `workspace/`; and
- selected operator files under `config/`.

Back up the full `OP_HOME` when rollback matters, but do not treat `system/`,
`state/`, or `data/` as a portable configuration API. They may include secrets,
generated values, version-specific databases, and caches.

0.14 recovery and migration use a fresh installation followed by an
allowlisted import. Provider credentials require an explicit secret import;
Guardian and portal access credentials are recreated. Imported schedules stay
inactive until reviewed. See [the 0.14 transition guide](operations/migration-to-lean-stack.md).

## Optional Admin

Admin may wrap the same setup, status, credential, backup/import, and lifecycle
operations in a local GUI. It must not become the chat client, a web server, a
background control plane, or a requirement for headless installs.

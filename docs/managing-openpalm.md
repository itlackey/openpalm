# Managing OpenPalm

Most users should need only the setup flow, their chosen client, and a few
lifecycle commands. File-level configuration is an advanced interface.

## Lifecycle

### Select an instance in Admin

Admin always launches to a welcome screen. **Open previous instance** (or
**Open default instance** on the first launch) opens that folder in one click.
The default choice remains available when it differs from the previous one.
**Recent instances** remembers up to 20 canonical folder paths, newest first;
**Open another folder…** uses the system folder picker.

Use **Switch instance** in the sidebar to return to the welcome screen. Setup
and error screens also offer **Choose another instance**. Switching confirms
discarding unsaved settings or provider sign-in steps and reloads Admin to
clear revealed keys and restore previews. Finish the current operation or
finish/cancel native remote setup first. Running stacks are not stopped.
Opening an instance shows its state; use the explicit start/stop controls to
change its lifecycle.

Folder paths are stored in `instances.json` in Electron's per-user Admin
application-data directory, not under any managed `OP_HOME`. That preference
contains no keys or account credentials. Invalid preferences do not prevent
opening the default or another folder. A moved/missing recent folder must be
selected at its new location; Admin does not recreate it automatically.

Remote instance management over SSH is not implemented yet.

### Find settings in Admin

Overview offers **Open OpenCode**, **Connect an app**, and concise service status.
In **Agent settings**, expand **Memory & recurring work** for automatic memory
and the scheduling timezone. In **Connections**, choose an app for its connection
instructions. Claude Desktop and other MCP apps expose **Guardian MCP settings**;
expand **Chat apps** to configure Discord or Slack alongside its tokens,
allowlist, and default access identity. Experimental **Remote coding agents**
and **Advanced network settings** are collapsed until needed. Missing-token
guidance opens the correct token form automatically. **System** groups portable
backups, installation details, and logs.

In **People & access**, choose **Manage** beside an identity to open its key
controls, or expand **Manage an existing access key** directly. **Load key**
and **Load password** retrieve the value but keep it masked; **Show** makes it
visible, and **Copy** copies it where offered. **Individual chat app access**
contains optional per-user policy mappings. Backup and restore keep sensitive
data opt-ins under **Include sensitive data (optional)**; they remain off by
default.

### Select an instance in CLI

Commands act on `OP_HOME` (default `~/.openpalm`), not whichever instance was
most recently installed. For a nondefault home, keep that selection explicit:

```bash
OP_HOME=/absolute/path/to/personal-openpalm openpalm status
```

A host-local alias/wrapper such as `openpalm-personal` may select a specific
home and CLI binary; it is a convenience configured on that host, not a product
subcommand. Inspect its target and verify the binary's `--version`, especially
while an old installation is retained for rollback. Without the alias, the
equivalent is `OP_HOME=<home> /absolute/path/to/verified-openpalm <command>`.

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

Automatic personal memory is enabled by default for trusted native OpenCode
`build`/`plan` conversations. An image-baked wrapper around the AKM OpenCode
plugin extracts a few explicitly stated long-term facts using the same
OpenCode provider you signed into, then saves them with `akm remember`.
Credential-bearing lines and secret-shaped values are filtered before model
extraction; source-supported facts are validated again before saving. These
filters reduce risk, but do not guarantee detection of every secret: never
paste credentials into a conversation. Guardian, scheduled, and internal
sessions do not automatically write personal memory.

Turn **Automatic personal memory** off in **Agent settings → Memory & recurring work**, or set
`assistant.automaticMemory` to `false` in `state/stack.json` and restart with
`openpalm start`. This stops new automatic capture, not explicit `remember`
requests, and does not erase existing memories. OpenCode's own conversation
history remains separate from knowledge; automatic capture stores facts, not
full transcripts. Capture failure does not interrupt conversation and can
retry on a later turn. Explicitly ask the agent to remember important facts
when immediate confirmation matters.

AKM 0.9.20's native `proposal extract` currently requires its own direct LLM
engine and cannot attach to the running OpenCode agent. OpenPalm disables that
plugin path rather than asking you to configure another provider credential or
endpoint. The wrapper keeps AKM's normal discovery, recall, and remember tools.

Schedules use the host timezone detected at installation. Set an IANA zone
such as `America/Chicago` in **Agent settings → Memory & recurring work** or
`assistant.timezone` in `state/stack.json`; `openpalm start` applies it. Daylight
saving follows that zone. After downtime, future schedule slots resume without
replaying missed runs. If the scheduler dies, the Assistant service restarts
with it; failed reconciliation marks service health degraded instead of
silently presenting schedules as ready.

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

For separate native Codex or Claude Code remote coding sessions, see
[optional native remote access](native-remote-access.md). These default-off
connections bypass Guardian and require the respective vendor's native sign-in.
The unreleased guided `openpalm remote enable claude|codex` flow combines stack
configuration, browser sign-in, explicit native trust/consent, and prerequisite
checks. Admin offers the same flow under **Connections → Remote coding agents**.

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

The backup copies the allowlisted `knowledge/`, `workspace/`, and validated
Assistant preferences, records a SHA-256 integrity manifest, and
can be passed to `openpalm import --from`. Active task definitions are restored
into the review-required staging area. Restore verifies every recorded size and
checksum and refuses unrecorded allowlisted files. Symlinks and non-regular
files are reported rather than followed.

This is a **portable-files backup**, not full runtime recovery. It does not
contain native OpenCode conversations, runtime snapshots, external binds/volumes
or symlink targets. That scope appears in Admin, CLI output and the manifest.
Restore previews make detected unrestored data prominent and require an explicit
acknowledgement before copying only portable files; copied hashes and the plan
are recorded privately in `state/import-receipts/`.

For native conversations, use `openpalm history export` and `history restore`
with the selected destination stopped, explicit workspace directory mappings
and same-instance confirmation. This also supports recovery after setup without
rerunning the portable importer against a live home. See the
[migration guide](operations/migration-to-0.14.md#native-conversation-recovery)
for private archives, collision checks, retry and separate acceptance of
transcripts versus resumable projects. These refinements are post-beta.1.

Generated `node_modules/` directories are omitted; reinstall dependencies from
project lockfiles after recovery. AKM runtime configuration under `config/akm/`
is not portable and may contain credentials, including in historical copies;
fresh installation regenerates managed scheduler settings. It must not be
staged in agent-searchable knowledge for reference.

Automatic portable Assistant configuration accepts only `$schema`, `model`,
`small_model`, and `provider`. Any additional top-level setting omits the whole
config with a warning, including when provider-auth is selected. Keep native
MCP/plugin/custom settings in a protected full-home backup and manually review
them before reintroduction; this portable-copy restriction does not remove
OpenCode's normal runtime customization. Literal provider credentials require
the provider-auth opt-in as well.

Provider authentication, user environment values, portal identity maps, and
OAuth configuration require explicit backup flags:

```bash
openpalm backup --to /absolute/path/to/private-backup \
  --include-provider-auth \
  --include-user-env \
  --include-portal-maps \
  --include-oauth
```

Provider-auth opt-in also includes safely contained provider
`{file:/stash/secrets/...}` references from validated Assistant configuration,
not arbitrary secret files or external paths. Protect the backup directory as
private credential-bearing data. After startup, OpenCode can refresh provider
authentication; an older snapshot's refresh token may no longer work and may
require native sign-in again.

For a complete rollback snapshot of an old release, stop the old stack and use
your operating system's backup tool on its full `OP_HOME` **and every separately
mounted volume or external data source**. Verify integrity, preserve ownership,
use sparse-aware archives where available, and keep the snapshot outside agent
mounts. Do not treat
`system/`, `state/`, or `data/` as a portable configuration API.

0.14 recovery and migration use a fresh installation followed by an
allowlisted import. Provider credentials require an explicit secret import;
Guardian and portal access credentials are recreated. Imported schedules stay
inactive until reviewed. See [the 0.14 transition guide](operations/migration-to-0.14.md).

## Optional Admin

Admin is the optional guided local interface for setup and maintenance. A new
user sees three stages: install locally, connect an AI provider, and choose a
client. Default installation does not ask for ports or bind addresses; those
choices remain under **Advanced network settings**. Admin does not report the
agent as ready until a real provider request succeeds.

After setup, five task-based views separate **Overview**, **Agent settings**,
**Connections**, **People & access**, and **System**. Optional settings and
technical explanations expand only when needed; important consent and access
warnings remain visible.
Admin supports API-key provider setup, detects existing OpenCode sign-ins,
creates and rotates named access keys, maps Discord and Slack identities,
configures portal allowlists and tokens, previews restores, creates portable
backups, and shows bounded diagnostics. Provider browser/OAuth sign-in remains
OpenCode's native flow: Admin calls the selected installation's authenticated
OpenCode authorize/callback endpoints, opens the returned HTTPS sign-in page,
and verifies a real response through OpenCode's default model for that selected
provider after completion.

The **Connections** view contains complete guided recipes for trusted OpenCode,
Claude Desktop, and generic Streamable HTTP MCP clients. Passwords and bearer
keys remain masked until an explicit reveal or copy action. Connection,
access-policy, and network forms save independently, and unrelated operations
preserve pending edits. Backup and restore paths can be chosen with the native
directory picker. Restore apply is bound to the exact content and conflict plan
shown during preview.

Admin is not the chat client, a web server, a background control plane, or a
requirement for headless installs. It uses the same filesystem and control-plane
library as the CLI. Sensitive inputs are password fields; bearer-key reveal is
an explicit confirmed action and remains masked until the operator chooses to
show it. Release and local acceptance steps are documented in the
[Admin setup verification runbook](operations/admin-setup-verification.md).

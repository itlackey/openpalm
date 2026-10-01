# OpenPalm 0.14 core principles

This is the living product, architecture, and security contract for OpenPalm.
It describes the 0.14 product we are building. A feature, package, container,
document, test, or release job that does not serve this contract is legacy,
optional, or a candidate for removal.

## The promise

OpenPalm is a single-install personal AI agent for people who do not want to
host or assemble an AI stack.

After installation, a user should be able to:

1. sign in to a supported AI provider without understanding endpoints, model
   IDs, containers, or credential files;
2. talk to one private personal agent from a client they already use;
3. give that agent durable knowledge that survives restarts and upgrades; and
4. ask it, in ordinary language, to perform recurring work such as checking
   the news and saving or delivering the result.

If OpenPalm cannot do those four things reliably, integration breadth and
administrative features do not make it complete.

## Product shape

The default installation has one runtime service: **Assistant**.

Assistant contains only what the personal agent needs:

- OpenCode for the agent runtime and provider ecosystem;
- AKM for durable knowledge, skills, and task definitions; and
- supercronic for recurring task execution.

OpenCode, Claude Code, and Codex load version-aligned AKM integrations. Native
Claude/Codex marketplace installers run during image build against one
checksum-verified upstream release. Startup seeds generated native defaults and
refreshes them only while untouched; it never installs software, overwrites
user configuration, or pre-trusts hooks. Real-harness image tests verify session
hooks and knowledge recall. AKM automatic learning and extraction remain off in
native Claude/Codex sessions.

Codex setup and Admin offer explicit AKM automatic-recall approval. They show
the native commands and use Codex's hook inventory and version-checked config
writer to persist only the exact reviewed AKM hook hashes. Changed definitions
require renewed review. Recall readiness is independent from account sign-in
and remote startup; opt-out and approval survive restarts. No separate trust
registry, pre-trust, unrelated-hook approval, or hook-trust bypass is added.

The Assistant image also bakes pinned Codex and Claude Code CLIs for optional
vendor-native remote coding sessions. Both startup switches default off. These
are separate trusted agents sharing `/work`, not OpenCode session transports or
Guardian clients. They add no service, profile, inbound port, or startup install.
Their own account sign-in and consent stay native; OpenPalm never copies host
logins or accepts workspace trust on the user's behalf. Both Codex and Claude
Code remote access remain experimental in 0.14.0; only a future release
with explicit end-to-end validation can promote them. Host support and
client/account availability are constraints, not core-agent readiness claims.

CLI and Admin share a guided native onboarding flow. It temporarily pauses the
selected remote worker, opens only allowlisted vendor sign-in/pairing URLs,
relays the user's explicit native prompt answers, and enables startup after
native setup succeeds. Cancellation, timeout, and prerequisite failure leave
that worker off without erasing account state. Codex sandbox intent is exactly
`workspace-write` or `read-only`, retains `on-request` approvals, and must pass a
real local sandbox probe before sign-in. The guide never changes host sysctls,
container privileges, or vendor settings to suppress trust/consent prompts.

The optional surfaces are:

- **Guardian**, an authenticated MCP security boundary for less-trusted or
  remote clients;
- **Portal**, one private adapter image for Discord and Slack;
- the **CLI**, the primary installer and lifecycle tool;
- **Admin**, an optional local setup and stack-management utility; and
- the **Claude Desktop extension**, a local bridge to Guardian MCP.

Admin is never a chat application, server, tray daemon, updater, or second
control plane. A user talks to the agent through OpenCode, an MCP client,
Claude Desktop, Discord, Slack, or another standards-based client.

## Experience contract

The normal path is:

```text
install -> provider sign-in -> readiness check -> use the agent -> add recurring work
```

The normal path must not ask the user for a provider base URL, API endpoint,
model identifier, Compose profile, port, JSON file, or environment variable.
Advanced users may opt into those controls.

The CLI and optional Admin expose the same guided operations for connection
settings, access credentials, portal scope, and portable recovery. Ordinary
portal setup must not require editing Compose YAML or writing secrets with shell
redirection.

Admin launches to a welcome screen with one-click previous/default selection,
recent instances, and a native folder picker. Recent local targets are a small
Admin preference, not a discovered fleet or a second stack registry. Opening
validates an existing 0.14 home or an empty setup folder without seeding it;
legacy and unrelated nonempty folders are rejected unchanged. `OP_HOME` defines
the default choice, not a forced auto-open. Selecting a folder does not start
or stop containers.

One instance is managed at a time. Switching reloads the renderer, confirms
discarding unsaved forms/sign-in steps, clears transient keys and previews,
and waits for in-flight operations or native remote setup to finish. Control
operations receive the selected home explicitly, never by changing global
`OP_HOME`. Target selection and operation dispatch stay separate so future
SSH management can reuse the UI; there is no SSH backend or remote credential
store in this release.

After selection, Admin presents explicit `not installed`, `setup incomplete`, and `ready`
phases. It starts in a loading state, hides infrastructure choices
behind advanced disclosures, prevents duplicate operations, and never presents
a failed provider-readiness result as success. Its post-setup navigation is
organized around user tasks rather than runtime components. A failed first
start remains recoverable in the setup flow; the operator can correct ports and
retry without reinstalling or editing files.

The interface is a compact operational utility using fwdslsh's restrained
charcoal and green-accent visual language, not a marketing page or a product
rebrand. It uses local assets and system fonts. Installation checks Docker
readiness before enabling its primary action. Setup progress and recovery
messages agree with actual service health; refresh does not obscure forms or
dismiss persistent errors. Narrow windows and zoom retain a compact setup
header rather than stacking decorative progress cards.

Admin chooses its initial window size once. Setup, refresh, navigation, and
instance switching never resize or maximize the window. Only explicit
user/agent window actions change it; responsive-layout tests resize their own
disposable test window, not the production application.

Connections is the single place to configure native remote coding agents,
clearly distinguished from Guardian-protected clients. Codex defaults to
workspace-write; other sandbox choices are advanced settings, not prerequisites
the user must understand. Native consent remains explicit. Startup intent and
unverified client connection status are never conflated.

Each client connection guide is task-complete. Direct OpenCode guidance shows
its URL, username, and explicitly requested password. Claude Desktop guidance
shows the extension, Guardian endpoint, named identity, and key. Generic MCP
guidance shows the Streamable HTTP endpoint and bearer-key contract together.
Secret values are hidden by default and enter the clipboard only after an
explicit local action.

Admin configuration saves are scoped to the visible task. Unsaved connection,
policy, or network edits survive unrelated lifecycle, credential, mapping, and
token operations. A restore can be applied only when the source-content digest
and destination plan still match the plan the user previewed.

OpenPalm delegates provider discovery, authentication, and model support to
OpenCode. It may guide and test OpenCode's native sign-in flow, but it must not
build a competing provider registry, model proxy, or credential format.
Browser sign-in in Admin calls OpenCode's authenticated provider OAuth
authorize/callback endpoints for the selected installation and then runs the
same real readiness check used by CLI setup. Readiness explicitly targets the
selected provider and OpenCode's reported default model for it; OpenPalm does
not maintain a separate model registry or force a nontechnical user to choose a
model.

Catalog providers without a custom authentication plugin still use OpenCode's
standard API-key flow. Authentication changes refresh the selected OpenCode
instance before readiness, so the test cannot use stale provider state.

An installation is not ready merely because containers are running. The setup
flow must verify that the selected provider can complete a small agent request
and explain any failure in user terms.

That verified provider/model also becomes the fresh Guardian moderator default.
An explicit operator-selected moderator model is never replaced.

Automatic personal memory uses the AKM CLI/plugin and the existing native
OpenCode provider. It is enabled for trusted local `build`/`plan` sessions only,
can be disabled, filters credential-bearing input, and retains validated facts
rather than copying transcripts into knowledge. Remote, scheduled, and internal
sessions never acquire an implicit memory-write capability. Until upstream
AKM extraction supports attached agent engines, the image-baked plugin wrapper
uses a no-tool OpenCode memory profile and `akm remember`; it never introduces a
second model endpoint, provider registry, or authentication format.

That automatic-capture boundary does not prohibit explicit nonsecret knowledge
saves or recurring-task management through a `full` Guardian credential. Shared
Assistant instructions must respect the selected chat/read/full profile rather
than describing every remote request as tool-restricted. Native tool approvals
still apply.

Recurring work is a user feature, not a YAML feature. A user should be able to
ask the agent to create, inspect, pause, resume, and remove a schedule in
ordinary language. AKM task files and cron expressions are implementation
details available to advanced users. Runs need durable history and a durable
result or inbox; Discord and Slack delivery are optional destinations, not the
only place a result exists.

Schedule intent includes an explicit IANA timezone, detected from the host by
default and configurable by the operator. Restart resumes future cron slots,
not missed work. Assistant health includes the scheduler and successful recent
task reconciliation, and an essential child process exiting restarts the
service rather than leaving an apparently working but unscheduled agent.

Optional native remote workers are not essential children. Vendor failures retry
with a five-minute backoff without interrupting OpenCode or scheduling. Local
process status must not be presented as successful remote-client readiness.
Pairing output stays private and bounded, separate from Docker and task logs.

## Interfaces and trust

OpenPalm has two agent access paths:

```text
trusted local client ---------------- native OpenCode ----------------> Assistant

MCP / Claude / Discord / Slack ------ Guardian policy --------------> Assistant
```

- Native OpenCode access is the trusted, full-fidelity path. It is
  authenticated, loopback-bound by default, and intentionally bypasses
  Guardian.
- Optional Codex and Claude Code remote access is also trusted native access,
  authenticated by the respective vendor rather than Guardian credentials.
  Native approvals remain enabled. The container remains nonroot with no Docker
  socket, additional capabilities, host-home mounts, or Guardian/portal keys.
- Guardian is the guarded path. It exposes MCP Streamable HTTP at `/mcp`,
  authenticates a named identity, screens untrusted input, applies that
  identity's policy, and preserves session ownership.
- Direct bearer keys, OAuth issuer/subject mappings, and exact Discord or
  Slack user mappings all resolve to the same credential registry.
- A credential has one `chat`, `read`, or `full` policy. The client cannot
  choose or elevate its own policy.

Guardian exposes useful agent operations, not a chat-only shim and not a raw
mirror of OpenCode. MCP clients must be able to run and resume agent work,
inspect owned sessions and jobs, respond to explicit interactions, and use
policy-allowed workspace capabilities.

## Security contract

Security choices are configurable; security boundaries are not accidental.

- Assistant receives no Docker socket, host control credential, Guardian key,
  portal key, or delegated Guardian OAuth access token. OpenCode provider auth
  and explicitly authorized native Codex/Claude account state remain local to
  their respective native agents.
- Published services bind to loopback unless the operator explicitly selects
  another exact address.
- Guardian fails closed on authentication, ownership, handle validation,
  moderation, and filesystem-containment errors.
- Guardian keys are private files. Portal adapters receive only the keys they
  need. `state/stack.env` never contains secrets.
- `chat` denies tools. `read` permits bounded non-secret reads. `full` removes
  Guardian's additional tool denial but never overrides Assistant policy.
- Portal allowlists are default-deny, independent of credential policy.
- Scheduled work runs with an explicit, least-privilege agent profile. Content
  fetched by a task is untrusted input and must not gain authority through the
  schedule.
- Managed services run as a non-root user with no added Linux capabilities.
- Images contain their dependencies; startup never installs software.
- Lifecycle code invokes Docker with argument arrays, never shell-built
  commands.

Detailed Guardian protocol rules live in [api-spec.md](api-spec.md). Those
details implement this contract; they do not expand the product boundary.

## Data contract

All persistent state lives under `OP_HOME`, normally `~/.openpalm`.

| Path | Meaning | Lifecycle rule |
|---|---|---|
| `knowledge/` | AKM knowledge, skills, schedules, and provider auth | user-owned and portable |
| `workspace/` | files the agent works with | user-owned and portable |
| `config/` | user choices and integration maps | seeded, then user-owned |
| `data/` | runtime databases, caches, logs, and run history | durable but release-specific |
| `state/` | generated intent, derived values, and delegated secrets | control-plane owned |
| `system/` | release-managed runtime files | reproducible from the release |

Updates never replace `knowledge/` or `workspace/`. No lifecycle command
deletes user data. Generated or release-specific state is not a portable API.

## The 0.14 boundary

0.14 is an intentional breaking release and fresh-install boundary. It does
not promise an automatic in-place upgrade from 0.13 or the retired large
stack.

The supported transition is:

1. stop the old installation and keep a complete backup;
2. install 0.14 into a new, empty `OP_HOME`;
3. preview an allowlisted import of user-owned data;
4. import selected knowledge, schedules, workspace files, and supported user
   configuration; and
5. recreate access credentials and verify provider sign-in before enabling
   scheduled or remote work.

The importer must never mutate the source installation, overwrite destination
files without explicit approval, activate imported schedules without review,
or silently carry forward old services. Provider credentials and other secrets
require an explicit opt-in. `system/`, generated `state/`, old Compose files,
service databases, caches, containers, and retired feature configuration are
not imported.

Old `config/akm/`, including historical copies, is neither portable-backup data
nor staged knowledge: it may contain credentials and managed scheduler intent.
Fresh installation regenerates the managed settings. Generated dependency
directories are omitted rather than copying partial linked trees. Provider-auth
opt-in may copy native provider file references only when safely contained
below `knowledge/secrets/`; it never grants an arbitrary secret-directory copy.
Automatic native configuration portability allows only `$schema`, `model`,
`small_model`, and `provider`; other top-level settings omit the entire config
for manual review rather than activating old MCP connections/plugins or
copying their credentials. Provider literals require secret opt-in. Runtime
OpenCode customization remains available; migration is not a second registry.

Migration chooses a distinct Compose project and explicitly re-establishes
network intent, client credentials, portal allowlists, and policy assignments.
Native OpenCode session databases and old external plugin/bundle mounts are
not automatically restored or activated. The acceptance check includes real
provider use, knowledge retrieval, durable scheduled results, and each enabled
client path—not merely healthy containers.

The old home remains the rollback artifact. OpenPalm does not maintain runtime
compatibility shims merely to reuse it.

See [the 0.14 transition contract](../operations/migration-to-0.14.md).

## Explicit non-goals

OpenPalm does not ship or own:

- a chat UI or general web application;
- an OpenAI-compatible, Anthropic-compatible, or A2A API;
- a model server, model catalog, or local-model lifecycle;
- a second provider abstraction or credential registry for model providers;
- voice services;
- VPN, tunnel, or discovery orchestration;
- a multi-agent control plane;
- a plugin marketplace or public portal SDK;
- a containerized admin service; or
- compatibility machinery for retired OpenPalm stacks.

These can be separate tools or future products. They do not belong in the
personal-agent core.

## Complexity test

A capability belongs in OpenPalm core only when it is required to install,
remember, schedule, secure, access, or recover the personal agent and a common
external tool cannot reasonably provide it.

Every addition must have one source of truth, a testable security boundary, a
clear owner, and less operational cost than the problem it solves. Otherwise,
prefer a standards-based integration, an operator-owned Compose extension, or
a separate project.

## Release test

Gitea is for early/private development. Ready source is pushed to GitHub,
where Actions builds and publishes the entire release: container images,
CLI binaries, Admin packages, the Claude Desktop extension, and the npm
bootstrap. Public metadata and downloads point to GitHub. Release workflows
never require a Gitea token or call a Gitea API.

0.14 is ready when a fresh user can complete the core path without editing a
configuration file, the agent remembers across restarts, recurring work runs
and leaves a durable result, both trusted OpenCode and guarded MCP access work,
and backup/import recovery succeeds without carrying the retired stack
forward.

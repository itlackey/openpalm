# AGENTS.md — OpenPalm

> Keep [docs/technical/core-principles.md](docs/technical/core-principles.md)
> aligned with the active architecture and security contract. It is a living
> decision record: change it with the implementation when the lean product is
> better served by a new boundary.
>
> OpenPalm 0.14 is a single-install personal agent with persistent knowledge,
> recurring work, and simple standards-based access. Remove or isolate
> complexity that does not serve that promise. Call out any remaining
> unjustified complexity.

## akm CLI

Search the local asset library before inventing a workflow:

1. `akm curate "<task>"`
2. `akm show <ref>`
3. `akm feedback <ref> --positive` when useful, or `--negative --reason "..."` when it fails

## Never delete user data without path-specific approval

This rule overrides an approved cleanup plan unless the user's current message names the exact path.

Never delete a file or directory that:

- the user did not explicitly name in the current message;
- is ignored and may hold secrets or state; or
- is outside an obviously generated build/cache path.

This includes `.dev*`, `.private`, `.env*`, `knowledge`, `data`, `state`, backups, `~/.openpalm`, `~/.config`, and credential-bearing directories.

For any other deletion:

1. list every exact path and why removal is safe;
2. wait for explicit approval for each path; and
3. use trash for untracked user data. Git history is recovery only for tracked files.

## Product boundary

OpenPalm is a single-install personal OpenCode agent for nontechnical users.
The normal path is provider sign-in, a real readiness check, persistent
knowledge, natural-language recurring work, and access from a familiar client.

- **Assistant** is the only default container. It includes OpenCode, AKM, and supercronic.
- **Guardian** is optional. It exposes only `/health` and MCP at `/mcp`.
- **Portal** is one private package/image with Discord and Slack adapters. Both call Guardian through MCP.
- **CLI** is the primary installer, importer, and host orchestrator.
- **Admin** is an optional local setup and management utility over the same
  lean library. It has no server, chat, updater, tray, or background control
  plane.
- **Claude Desktop MCPB** is an optional local stdio-to-Guardian bridge.

There is no active SvelteKit UI, browser chat, OpenAI/Anthropic compatibility edge, A2A server, voice/model service, Paperclip service, VPN, mDNS discovery, hardware profile matrix, or public extension package graph.

OpenCode owns model-provider discovery, authentication, and models. OpenPalm
guides that native flow and verifies it; do not add a second provider registry,
model proxy, or credential format. AKM task files are implementation detail:
the finished user path manages schedules in ordinary language and retains a
durable result for every run.

## Active repository surface

```text
packages/lib/        lean filesystem + Compose control plane
packages/cli/        install, import, configure, and lifecycle CLI
packages/guardian/   authenticated MCP security gateway
packages/portal/     unified Discord/Slack MCP adapters
packages/electron/   optional static local admin utility
packages/claude-desktop/ optional local MCPB bridge
packages/skeleton/   files selectively materialized into OP_HOME
containers/assistant/Dockerfile.lean
containers/assistant/openpalm-task.mjs
containers/guardian/Dockerfile
containers/portal/Dockerfile
```

Legacy source remains in the branch only because removal requires path-specific approval. It is absent from root workspaces, package exports, active TypeScript programs, image COPY lists, tests, CI, and release jobs. See `docs/technical/deletion-manifest.md`.

## Runtime architecture

```text
trusted OpenCode client ─────────────────────────> Assistant
external MCP client -> Guardian -> policy profile -> Assistant
Discord/Slack -> Portal -> Guardian MCP ─────────┘
CLI or optional Admin -> Docker Compose
AKM + supercronic -> recurring agent work ────────┘
```

The one managed Compose file is:

```text
packages/skeleton/system/stack/stack.compose.yml
```

The only user Compose file is:

```text
~/.openpalm/config/stack/custom.compose.yml
```

Profiles are exactly `gateway`, `discord`, and `slack`.

## Security invariants

- Assistant never receives the Docker socket or delegated Guardian/portal credentials.
- Assistant's authenticated native API is loopback-published by default; any
  other exact bind address must be explicit StackConfig intent.
- Native OpenCode access intentionally bypasses Guardian. Guarded external
  requests enter through authenticated Guardian MCP.
- Provider setup delegates to OpenCode and is complete only after a real,
  no-tool Assistant request succeeds.
- Guardian bearer credentials are named identities with private file-backed
  keys and independently configured `chat`, `read`, or `full` policies. The
  same identity may be used directly by MCP clients or mapped to Slack and
  Discord users.
- Session, message, job, and interaction handles are encrypted, authenticated, expiring,
  and credential-identity scoped. Guardian session ownership is independently
  bound in OpenCode metadata.
- Guardian workspace reads use its own read-only `/work` mount and reject
  canonical-path or opened-file-descriptor escapes.
- `chat` and `read` profiles begin with `permission: { "*": "deny" }`;
  `read` explicitly excludes managed knowledge secrets, knowledge environment,
  and `.env` reads. `full` inherits Assistant permissions. A credential cannot
  select its profile.
- Suspicious prompts and interaction answers escalate to a separate loopback moderator. Failure or an ambiguous `flag` verdict blocks the request.
- Recurring prompt tasks run through `openpalm-task` with the restricted
  `scheduled` profile, durable AKM history, and writes limited to
  `knowledge/inbox/`. Removed task definitions are preserved.
- Guardian protection cannot be disabled by a Compose flag.
- Portal allowlists are default-deny.
- Portal user maps are operator-owned per adapter. Each portal receives only a
  generated keyring containing its default and explicitly mapped credentials.
- Scheduled work uses an explicit least-privilege profile, treats fetched
  content as untrusted, and leaves durable history and results.
- No managed service runs as root. No service receives additional Linux capabilities.
- `state/stack.env` contains non-secret derived values only.
- Lifecycle operations never use shell-interpolated Docker commands.

## Filesystem contract

All persistent state lives under `OP_HOME` (default `~/.openpalm`):

| Tree | Owner | Lifecycle behavior |
|---|---|---|
| `system/` | release | selected managed files overwritten whole on update |
| `config/` | operator | seed missing files only |
| `knowledge/` | operator/AKM | portable; contains knowledge, provider auth, and tasks |
| `workspace/` | operator | portable; never replaced |
| `state/` | control plane | generated intent, derived env, delegated file secrets; not portable |
| `data/` | containers | durable release-specific state and logs; not portable |

`state/stack.json` is the core stack-intent schema. Per-user portal assignments
are operator-owned maps under `config/portal/`. `state/stack.env` and
`state/portal-credentials/` are derived runtime input. Updates copy an explicit
managed-file allowlist and never wholesale-sync or delete stale paths.

0.14 never upgrades an older home in place. `openpalm import` reads the old
home as a source, refuses conflicts and path escapes, and stages imported task
sources outside the active scheduler until reviewed.

0.14 is a fresh-install boundary. Do not add an in-place 0.13 compatibility
path. Import only an explicit allowlist of user-owned knowledge, disabled task
definitions, workspace files, and validated configuration. Secret import is
opt-in. Never infer new runtime intent from old `system/`, `state/`, `data/`,
Compose, container, or retired-feature state, and never mutate the source home.

## Commands

```bash
bun install
bun run check
bun run test
bun run lint

bun run packages/cli/src/main-lean.ts install --no-start
bun run packages/cli/src/main-lean.ts update --no-start

./scripts/dev-setup.sh --seed-env
bun run dev:build

bun run --cwd packages/cli build
bun run --cwd packages/electron bundle
```

Docker-dependent verification may be unavailable in restricted environments. `docker compose ... config --quiet` does not require a running daemon and should still be used when the Docker CLI exists.

## Code rules

- TypeScript strict mode; use `unknown` at trust boundaries.
- ES modules only; relative TS imports include `.js` in the lean packages.
- Prefer named imports and `import type`.
- Prefer Bun, Node, and Web Platform built-ins over dependencies.
- Transport handlers parse/authenticate/validate, then call small domain functions.
- Fail closed on authentication, handle validation, moderation, origin, and secret-boundary errors.
- Keep the active dependency graph narrow. Do not import the legacy `@openpalm/lib` barrel; use `@openpalm/lib/lean`.
- Do not add a legacy migration or compatibility shim to the 0.14 runtime;
  extend the previewable allowlisted importer when user-owned data is missing.
- Do not add another managed Compose overlay, another public protocol, or another runtime service without changing the core principles first.
- Use `execFile`/argument arrays for child processes, never shell strings.
- Do not install software at container startup.

## Verification before handoff

- `bun run check`
- `bun run test`
- `bun run lint`
- `bash -n` for changed shell entrypoints
- build the CLI and optional admin bundle when their source changes
- validate Compose with all three profiles
- run Guardian security tests for ingress or moderation changes
- verify no secret or privileged mount reaches Assistant

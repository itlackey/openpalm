# AGENTS.md — OpenPalm

> Keep [docs/technical/core-principles.md](docs/technical/core-principles.md)
> aligned with the active architecture and security contract. It is a living
> decision record: change it with the implementation when the lean product is
> better served by a new boundary.
>
> Remove or isolate complexity that cannot be justified by the lean product. Call out any remaining unjustified complexity.

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

OpenPalm is a self-hosted OpenCode agent with a deliberately narrow integration edge.

- **Assistant** is the only default container. It includes OpenCode, AKM, and supercronic.
- **Guardian** is optional. It exposes only `/health` and MCP at `/mcp`.
- **Portal** is one private package/image with Discord and Slack adapters. Both call Guardian through MCP.
- **CLI** is the primary host orchestrator.
- **Admin** is an optional static Electron utility. It has no server, chat, updater, tray, or background control plane.

There is no active SvelteKit UI, browser chat, OpenAI/Anthropic compatibility edge, A2A server, voice/model service, Paperclip service, VPN, mDNS discovery, hardware profile matrix, or public extension package graph.

## Active repository surface

```text
packages/lib/        lean filesystem + Compose control plane
packages/cli/        install, migrate, configure, and lifecycle CLI
packages/guardian/   authenticated MCP security gateway
packages/portal/     unified Discord/Slack MCP adapters
packages/electron/   optional static local admin utility
packages/skeleton/   files selectively materialized into OP_HOME
containers/assistant/Dockerfile.lean
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
- Guardian protection cannot be disabled by a Compose flag.
- Portal allowlists are default-deny.
- Portal user maps are operator-owned per adapter. Each portal receives only a
  generated keyring containing its default and explicitly mapped credentials.
- No managed service runs as root. No service receives additional Linux capabilities.
- `state/stack.env` contains non-secret derived values only.
- Lifecycle operations never use shell-interpolated Docker commands.

## Filesystem contract

All persistent state lives under `OP_HOME` (default `~/.openpalm`):

| Tree | Owner | Lifecycle behavior |
|---|---|---|
| `system/` | release | selected managed files overwritten whole on update |
| `config/` | operator | seed missing files only |
| `knowledge/` | operator/AKM | never replaced; contains provider auth and tasks |
| `workspace/` | operator | never replaced |
| `state/` | control plane | stack intent, derived env, delegated file secrets |
| `data/` | containers | durable service state and logs |

`state/stack.json` is the core stack-intent schema. Per-user portal assignments
are operator-owned maps under `config/portal/`. `state/stack.env` and
`state/portal-credentials/` are derived runtime input. Updates copy an explicit
managed-file allowlist and never wholesale-sync or delete stale paths.

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

# Package management

## One lock file

The repository has one dependency lock: root `bun.lock`. Package-local locks and `package-lock.json` are not committed.

```bash
bun install
bun install --frozen-lockfile
```

Dependency changes are made from the repository root so the workspace graph and lock remain one transaction.

## Active workspaces

| Workspace | Runtime dependencies | Release role |
|---|---|---|
| `@openpalm/lib` | none | private control-plane source bundled into consumers |
| `openpalm` | zero runtime dependencies in npm bootstrap | compiled standalone CLI + npm bootstrap |
| `@openpalm/guardian` | MCP server, OpenCode SDK, Zod | private Guardian image component |
| `@openpalm/portal` | MCP client, Discord, Slack SDKs | private unified portal image component |
| `@openpalm/electron` | Electron build dependencies | optional static admin artifact |
| `@openpalm/skeleton` | none | files embedded in the CLI |
| `@openpalm/claude-desktop` | MCP client/server | optional Claude Desktop MCPB |
| `@openpalm/assistant-tools` | OpenCode, AKM, and optional native Codex/Claude CLIs | Assistant image tool layer |
| `@openpalm/guardian-tools` | OpenCode | Guardian moderator tool layer |

The root `workspaces` list is the authoritative package list. Every tracked
package belongs to that list.

## Internal APIs

Active host consumers import only:

```ts
import { ... } from '@openpalm/lib';
```

The package root resolves to the same narrow API. Broad wildcard exports are
intentionally absent.

Guardian and Portal communicate through MCP. There is no published OpenPalm portal SDK and no workspace dependency between their packages.

## Image builds

Images install dependencies at build time from explicit pinned manifests and
the root lockfile:

- `containers/assistant/tools/package.json` — OpenCode, AKM CLI/plugin, native Codex/Claude Code CLIs;
- `containers/guardian/tools/package.json` — classifier OpenCode runtime;
- `packages/guardian/package.json` — Guardian application dependency;
- `packages/portal/package.json` — unified adapter dependencies.

AKM CLI is pinned to `0.9.20`; both platform plugins use release
`0.9.20202609302253`. OpenCode's declared CLI dependency matches, so no AKM
dependency override is needed.

Claude's plugin is source-distributed. The Assistant Dockerfile downloads its
immutable release commit with a SHA-256 check, then copies only the Claude
directory and upstream license into the image. `CLAUDE_CODE_PLUGIN_DIRS` points
Claude's native loader at that read-only directory in terminal and remote-worker
environments. It works with fresh or existing persistent homes without changing
user settings or installing a marketplace at startup. Image smoke checks validate
the manifest, native loading, and version alignment with OpenCode.
`BUN_OPTIONS=--no-env-file` prevents workspace dotenv loading in upstream hooks;
automatic learning and session extraction remain disabled by the existing AKM
environment defaults.

Entrypoints never run a package manager. Runtime package overrides are not supported.

Direct dependencies in image manifests use exact versions. Docker builds use
`--frozen-lockfile`; they cannot silently select a new transitive dependency.
When changing one, update `bun.lock`, run `bun audit`, and verify the
corresponding image.

## Release version

OpenPalm has one product version. `.github/release-manifest.json` is the
authoritative list stamped by `scripts/bump-release.mjs` and includes:

- root `package.json`
- skeleton
- library
- CLI
- Guardian
- Portal
- Claude Desktop extension
- optional Electron Admin

Compose image defaults are stamped in the same operation through the managed
`stack.compose.yml` entry in the release manifest.

Only the zero-dependency `openpalm` bootstrap is published to npm. Guardian
and Portal are delivered as signed container images. Admin is delivered as a
GitHub release artifact.

## Verification

```bash
bun install --frozen-lockfile
bun audit
bun run check
bun run test
bun run lint
bun run --cwd packages/cli build
bun run --cwd packages/claude-desktop pack
bun run --cwd packages/electron bundle
```

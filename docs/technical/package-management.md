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

AKM is pinned to `0.9.20`; the current `akm-opencode` publication is
`0.9.19202609301957`. Its manifest pins CLI `0.9.19`, so the root `akm-cli`
override keeps one patched `0.9.20` runtime in both the CLI and plugin graph.
The 0.9.20 upstream change fixes SDK server teardown without changing the
persisted/task schema. Memory and task acceptance cover this combination.
Remove the override when the current plugin's declared CLI pin reaches 0.9.20
or newer, updating both exact pins and the lockfile together.

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

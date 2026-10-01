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

AKM CLI is pinned to `0.9.20`; all three harness integrations use plugin release
`0.9.20202610010250`. OpenCode's declared CLI dependency matches, so no AKM
dependency override is needed.

Claude/Codex plugins are source-distributed from the same upstream directory.
The Assistant Dockerfile downloads an immutable release commit with a SHA-256
check and retains only native manifests, hooks, skills, commands, and license.
It runs the standard installers against that local marketplace:

```bash
claude plugin marketplace add /akm-marketplace
claude plugin install akm@akm-plugins
codex plugin marketplace add /akm-marketplace
codex plugin add akm@akm-plugins
```

Startup copies the installed caches and seeds generated native settings into
the persistent home. Untouched generated settings refresh on image upgrades;
user-edited configuration, additional installed plugins, accounts, and native
trust decisions are never overwritten. Codex also has native system defaults;
user configuration takes precedence. Operators who customize the native plugin
registry can use the corresponding native install/update command rather than
having OpenPalm merge a vendor-specific configuration format.

Codex hooks are installed but not pre-trusted. Guided Codex setup and Admin
explain and approve only the exact reviewed AKM definitions through Codex's
native hook/config APIs. Approval and opt-out persist in its normal configuration;
changed definitions require review again. No manual `/hooks` command, independent
trust store, approval bypass, or sandbox bypass is needed. Image smoke checks exercise all three real harnesses
with the real AKM CLI, confirming session hooks and successful fixture recall.
`BUN_OPTIONS=--no-env-file` prevents workspace dotenv loading in upstream hooks;
automatic learning and session extraction remain disabled by the existing AKM
environment defaults.

Containers and CI pin Bun `1.4.2`; Assistant uses real Node LTS `24.21.0`
ahead of Bun's Node compatibility shim. Update pins deliberately and rerun
image tests rather than introducing mutable `latest` tags or startup updates.

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

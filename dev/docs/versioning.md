# Versioning & Releases

OpenPalm supports both coordinated platform releases and independent component releases.

## Source of truth

| Target | Version source |
|---|---|
| Platform tag (`vX.Y.Z`) | `/package.json` |
| `assistant` | `/assistant/package.json` |
| `gateway` | `/gateway/package.json` |
| `admin` | `/packages/ui/package.json` |
| `channel-chat` | `/channels/chat/package.json` |
| `channel-discord` | `/channels/discord/package.json` |
| `channel-voice` | `/channels/voice/package.json` |
| `channel-telegram` | `/channels/telegram/package.json` |
| `cli` | `/packages/cli/package.json` (+ `/packages/cli/src/main.ts` `VERSION`) |

Tag conventions are unchanged:

- `v1.2.3` → full platform release (all images + CLI)
- `<component>/v1.2.3` → component-only release
- `cli/v1.2.3` → CLI-only publish

## CLI helper (`dev/version.ts`)

Run via root scripts in `/package.json`:

```bash
bun run ver:status
bun run ver current [target]
bun run ver:bump <target> <patch|minor|major>
bun run ver:release <target> <patch|minor|major>
```

Supported targets: `platform` (or `all`), `assistant`, `gateway`, `admin`, `channel-chat`, `channel-discord`, `channel-voice`, `channel-telegram`, `cli`.

### Command behavior

- `status`: reads versions from each package manifest
- `current`: prints one target version (used by release workflows)
- `bump`: updates one target (or all targets for `platform`)
- `set`: writes an exact semver (`X.Y.Z`)
- `sync`: sets every component to the root platform version
- `tag`: creates release tags from current manifest versions
- `release`: bump → commit → tag

## Workflows

Use these workflow files as the canonical implementation details:

- Direct release: [`.github/workflows/release.yml`](../../.github/workflows/release.yml)
- PR-based bump: [`.github/workflows/version-bump-pr.yml`](../../.github/workflows/version-bump-pr.yml)
- Docker publish: [`.github/workflows/publish-images.yml`](../../.github/workflows/publish-images.yml)
- CLI publish: [`.github/workflows/publish-cli.yml`](../../.github/workflows/publish-cli.yml)

### Typical paths

1. **Fast release**
   - Run the **Release** workflow (`component` + `bump`)
   - Workflow bumps manifest versions, commits, tags, and pushes
   - Tag triggers publish workflows

2. **Reviewed release**
   - Run **Version bump PR** workflow
   - Merge PR
   - Push matching tag (or run **Release** with same inputs)

## Required secrets/variables

| Name | Used by | Purpose |
|---|---|---|
| `RELEASE_TOKEN` | `release.yml`, `version-bump-pr.yml` | Push commits/tags and open PRs so downstream workflows run |
| `DOCKERHUB_USERNAME` | `publish-images.yml` | Docker Hub auth |
| `DOCKERHUB_TOKEN` | `publish-images.yml` | Docker Hub auth |
| `DOCKERHUB_NAMESPACE` (optional) | `publish-images.yml` | Image namespace (default `openpalm`) |

CLI publish uses npm trusted publishing (OIDC) in `publish-cli.yml` (no `NPM_TOKEN`). The `openpalm` package must exist on npmjs.com with a trusted publisher configured for this repo.

For token behavior details, see GitHub docs on [`GITHUB_TOKEN` workflow-trigger limits](https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication#using-the-github_token-in-a-workflow) and npm [trusted publishers](https://docs.npmjs.com/trusted-publishers/).

## Local workflow testing

Before pushing release-related changes, verify all workflows locally:

```bash
bun run test:workflows                      # Test all 7 workflows
./dev/test-workflows.sh publish-images      # Test Docker builds only
./dev/test-workflows.sh publish-cli         # Test CLI publish only
./dev/test-workflows.sh --dry-run           # Validate YAML only
```

Requires [act](https://github.com/nektos/act). See `./dev/test-workflows.sh --help` for all options.

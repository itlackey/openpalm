# Changesets Quickstart

Use Changesets to version and publish npm packages from this monorepo.

## When to add a changeset

Add one when your PR changes a publishable package:

- `packages/channels-sdk`
- `packages/assistant-tools`
- `packages/channel-chat`
- `packages/channel-api`
- `packages/channel-discord`

## Commands

```bash
# Create a changeset file for your package change
bun run changeset

# (Optional) Preview release plan locally
bun run changeset -- status

# (Maintainers) Apply versions locally
bun run version:packages
```

CI enforces that package changes include a `.changeset/*.md` file.
On merge to `main`, the `npm-release` workflow opens/updates a version PR or publishes changed packages.

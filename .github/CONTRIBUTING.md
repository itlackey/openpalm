# Contributing to OpenPalm

Read [core-principles.md](../docs/technical/core-principles.md) before changing
the runtime. OpenPalm accepts complexity only when it is necessary to run,
secure, integrate, or operate the hosted agent.

## Setup

```bash
git clone https://github.com/itlackey/openpalm.git
cd openpalm
bun install
./scripts/dev-setup.sh --seed-env
```

Use a non-root account. Docker Compose v2 is required for stack work.

## Active source

- `packages/lib`: lean host control plane
- `packages/cli`: primary lifecycle CLI
- `packages/guardian`: MCP security gateway
- `packages/portal`: unified Discord/Slack adapters
- `packages/electron`: optional static Admin
- `packages/skeleton`: selectively materialized runtime files
- `containers/*`: three image definitions

Legacy paths remain only pending exact deletion approval. Do not import or
extend them.

## Develop

```bash
bun run guardian:dev
PORTAL_ADAPTER=discord bun run packages/portal/src/index.ts
bun run packages/cli/src/main-lean.ts --help
bun run admin:dev
```

Prepare or build the local stack with:

```bash
bun run dev:setup
bun run dev:build
```

## Required checks

```bash
bun run check
bun run test
bun run lint
bun run --cwd packages/cli build
bun run --cwd packages/electron bundle
bash -n scripts/dev-setup.sh \
  containers/assistant/entrypoint.lean.sh \
  containers/guardian/entrypoint.lean.sh
```

Also validate Compose with all profiles and build the affected image when Docker
is available. See [testing-workflow.md](../docs/technical/testing-workflow.md).

## Design rules

- Keep Assistant free of Docker/admin credentials.
- Put remote traffic through authenticated Guardian MCP.
- Preserve wildcard tool denial for the remote and moderator profiles.
- Keep credentials in file secrets, never environment values.
- Use argument arrays for Docker processes.
- Add no boot-time installers.
- Keep `state/stack.json` the sole intent schema.
- Keep one managed Compose file and one operator overlay.
- Preserve operator files and data on install/update.
- Prefer a standard external client or a custom Compose service over a new core
  UI, protocol, model service, or addon system.

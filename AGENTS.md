# OpenPalm Agent Map (Root)

## Read Strategy (token-efficient)
- Start here, then follow only the most relevant scoped `AGENTS.md` for files you will touch.
- Delegate document scanning to smaller/faster models when possible.
- Build a returned context bundle as bullets containing:
  - file path
  - line range(s)
  - 1-3 most important rules/details
- Prefer progressive disclosure: open linked docs only when a local AGENTS file does not answer the task.
- Validate scope precedence: deeper `AGENTS.md` overrides broader ones.

## Highest-priority architecture rules
- Keep OpenPalm a thin wrapper around Docker Compose and Caddy generation.
- Keep one compose runner path; do not create parallel orchestration flows.
- Validate stack intent at boundary (`parseStackSpec`) and generated compose with `docker compose config`.
- Surface Docker errors directly; avoid custom recovery/orchestration systems.
- Keep channel ingress flowing through Gateway only.

## Documentation index
- Product/user docs:
  - `docs/concepts.md`
  - `docs/cli.md`
  - `docs/security.md`
  - `docs/maintenance.md`
  - `docs/troubleshooting.md`
  - `docs/host-system-reference.md`
- Developer docs:
  - `dev/docs/architecture.md`
  - `dev/docs/api-reference.md`
  - `dev/docs/testing-plan.md`
  - `dev/docs/release-quality-gates.md`
- Service docs:
  - `core/admin/README.md`
  - `core/gateway/README.md`
  - `core/assistant/README.md`
- Channel docs:
  - `channels/chat/README.md`

## Scoped AGENTS index
- Core:
  - `core/AGENTS.md`
  - `core/admin/AGENTS.md`
  - `core/gateway/AGENTS.md`
  - `core/gateway/opencode/AGENTS.md`
  - `core/assistant/AGENTS.md`
  - `core/assistant/extensions/AGENTS.md`
- Packages:
  - `packages/AGENTS.md`
  - `packages/lib/AGENTS.md`
  - `packages/cli/AGENTS.md`
  - `packages/ui/AGENTS.md`
- Channels:
  - `channels/AGENTS.md`
  - `channels/chat/AGENTS.md`

## Release-coupled component checklist
- When adding a new `core/<name>`, `channels/<name>`, or `packages/<name>` component, update:
  - `dev/version.ts`
  - `.github/workflows/publish-images.yml` (image components)
  - `.github/workflows/release.yml`
  - `.github/workflows/version-bump-pr.yml`

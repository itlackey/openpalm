# Architecture Remediation Status

Tracks implementation progress for issues listed in `ARCHITECTURE-REVIEW-HIGH-MEDIUM.md`.

## Completed so far

- H7: deduplicated `composeServiceName()` into `packages/lib/src/admin/service-name.ts` and reused it from stack manager/generator.
- H10: removed `signPayload` re-exports from channel server entrypoints; tests now import shared crypto utility directly.
- H12: removed dead branch logic in `resolveInContainerSocketPath()`.
- M1: changed shared `json()` helper to emit compact JSON (no pretty-print indentation).
- H5 (partial): removed `any` usage from chat/webhook request parsing and UI API result typing.
- M12 (partial): added metadata sanitization in `buildChannelMessage()` with depth/key limits and prototype-pollution key filtering.
- H3: deduplicated MCP/A2A JSON-RPC gateway wrapper logic into `packages/lib/src/shared/channel-adapter-server.ts` and updated both servers to use it.
- H4: aligned package/channel version values to `0.4.0` in `packages/lib/package.json`, `packages/ui/package.json`, `channels/mcp/channel.ts`, and `channels/a2a/channel.ts`.
- H6 (partial): removed gateway-local env parser and reused `parseRuntimeEnvContent()` from `packages/lib/src/admin/runtime-env.ts`.
- H8: updated all Dockerfiles from `oven/bun:1.3.5` to `oven/bun:1.3.9`.
- M8: renamed UI package to `@openpalm/ui`.
- M9: removed contradictory UI include entry from root `tsconfig.json` (UI remains excluded there intentionally).
- M10: removed deprecated `checkPort80()` from `packages/lib/src/preflight.ts`.
- M11: changed nonce cache persistence to debounced writes in `core/gateway/src/nonce-cache.ts`.
- M14: aligned `@playwright/test` version in `core/admin/package.json` with UI.

## Remaining issues

- H1, H2 (partial), H6 (partial), H9, H11
- H5 (remaining locations)
- M2, M3, M4, M5, M6, M7, M12 (remaining hardening), M13, M15

## Validation run

- `bun test channels/chat/server.test.ts channels/webhook/server.test.ts channels/voice/server.test.ts channels/telegram/server.test.ts channels/api/server.test.ts channels/mcp/server.test.ts channels/a2a/server.test.ts packages/lib/src/shared/channel-sdk.test.ts core/gateway/src/nonce-cache.test.ts core/gateway/src/server.test.ts`
- `bun run typecheck`

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
- H1 (partial): extracted shared HTTP ingress helpers in `packages/lib/src/shared/channel-http.ts` and refactored `chat`, `webhook`, `voice`, and `telegram` channel servers to use them.
- H6: centralized env parsing in `packages/lib/src/shared/env-parser.ts` and reused it from `packages/lib/src/env.ts` and `packages/lib/src/admin/runtime-env.ts`.
- H4: aligned package/channel version values to `0.4.0` in `packages/lib/package.json`, `packages/ui/package.json`, `channels/mcp/channel.ts`, and `channels/a2a/channel.ts`.
- H11: added graceful shutdown signal handling via `packages/lib/src/shared/shutdown.ts` and integrated it across all channel servers plus gateway.
- H8: updated all Dockerfiles from `oven/bun:1.3.5` to `oven/bun:1.3.9`.
- M8: renamed UI package to `@openpalm/ui`.
- M9: removed contradictory UI include entry from root `tsconfig.json` (UI remains excluded there intentionally).
- M10: removed deprecated `checkPort80()` from `packages/lib/src/preflight.ts`.
- M11: changed nonce cache persistence to debounced writes in `core/gateway/src/nonce-cache.ts`.
- M14: aligned `@playwright/test` version in `core/admin/package.json` with UI.
- M2: replaced fixed-window global limiter with sliding-window `RateLimiter` (`core/gateway/src/rate-limit.ts`) and scoped gateway usage to instance state in `createGatewayFetch()`.
- M3: improved audit rotation in `core/gateway/src/audit.ts` with retention and gzip-compressed archives.
- M5: replaced hand-rolled CLI flag parsing in `packages/cli/src/main.ts` with `node:util` `parseArgs()`.
- M6: reworked `confirm()` in `packages/lib/src/ui.ts` to use `node:readline/promises` and close the interface cleanly.
- M13: added retry/backoff for transient assistant failures in `core/gateway/src/assistant-client.ts`.
- M15: removed empty workspace member noise (root `package.json` no longer lists `core/assistant`).

## Remaining issues

- H1 (remaining full channel harness consolidation), H2 (partial), H9
- H5 (remaining locations)
- M4, M7, M12 (remaining hardening)

## Validation run

- `bun test channels/chat/server.test.ts channels/webhook/server.test.ts channels/voice/server.test.ts channels/telegram/server.test.ts channels/mcp/server.test.ts channels/a2a/server.test.ts core/gateway/src/server.test.ts core/gateway/src/nonce-cache.test.ts`
- `bun test packages/lib/src/admin/runtime-env.test.ts packages/cli/test/env.test.ts`
- `bun test core/gateway/src/rate-limit.test.ts core/gateway/src/audit.test.ts core/gateway/src/assistant-client.test.ts packages/cli/test/main.test.ts`
- `bun run typecheck`

# Architecture Remediation Status

Tracks implementation progress for issues listed in `ARCHITECTURE-REVIEW-HIGH-MEDIUM.md`.

## Completed in this iteration

- H7: deduplicated `composeServiceName()` into `packages/lib/src/admin/service-name.ts` and reused it from stack manager/generator.
- H10: removed `signPayload` re-exports from channel server entrypoints; tests now import shared crypto utility directly.
- H12: removed dead branch logic in `resolveInContainerSocketPath()`.
- M1: changed shared `json()` helper to emit compact JSON (no pretty-print indentation).
- H5 (partial): removed `any` usage from chat/webhook request parsing and UI API result typing.
- M12 (partial): added metadata sanitization in `buildChannelMessage()` with depth/key limits and prototype-pollution key filtering.

## Remaining issues

- H1, H2, H3, H4, H6, H8, H9, H11
- H5 (remaining locations)
- M2, M3, M4, M5, M6, M7, M8, M9, M10, M11, M13, M14, M15

## Validation run

- `bun test channels/chat/server.test.ts channels/webhook/server.test.ts channels/voice/server.test.ts channels/telegram/server.test.ts channels/api/server.test.ts channels/mcp/server.test.ts channels/a2a/server.test.ts packages/lib/src/shared/channel-sdk.test.ts`
- `bun run typecheck`

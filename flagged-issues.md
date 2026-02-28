# Flagged Issues — Quality Loop

Issues identified during the code quality sweep that are real but too risky or broad to fix in a quality pass. Each needs human review or a dedicated follow-up.

## 1. State mutation before Docker operations

**Severity:** Medium — potential inconsistency on Docker failure
**Files:** `core/admin/src/routes/admin/install/+server.ts`, `core/admin/src/routes/admin/channels/install/+server.ts`, `core/admin/src/routes/admin/services/start/+server.ts`, `core/admin/src/routes/admin/services/stop/+server.ts`, `core/admin/src/routes/admin/containers/pull/+server.ts`

Multiple routes update `state.services` and call `persistArtifacts()` *before* running `composeUp()` / `composeDown()`. If Docker fails, the in-memory state says the service is "running" (or "stopped") but the actual container state is different. The API response does include the Docker result, but the persisted state is already written.

**Suggested fix:** Move state mutation to after a successful Docker operation, or add rollback logic on failure.

## 2. fetchConnectionStatus silently succeeds on network error

**Severity:** Low — affects UI feedback only
**File:** `core/admin/src/lib/api.ts`

`fetchConnectionStatus()` catches network errors and returns `{ complete: true, missing: [] }`, making it appear that all connections are configured when the admin API is actually unreachable. The connections page would show a green status when it should show an error.

**Suggested fix:** Return an error state (e.g. `{ error: true }`) or re-throw so the caller can display a connection warning.

## 3. channels/chat has no test file

**Severity:** Low — coverage gap
**File:** `channels/chat/server.ts`

The api and discord channels both have test files (`server.test.ts`) but chat does not. Chat is the most complex channel (3 routes: `/v1/chat/completions`, `/v1/completions`, `/v1/messages`) and would benefit most from tests.

**Suggested fix:** Add `channels/chat/server.test.ts` following the same `createApiFetch()` pattern used by the api and discord channel tests.

## 4. extractChatText duplicated between channels

**Severity:** Low — code smell / DRY violation
**Files:** `channels/chat/server.ts`, `channels/api/server.ts`

Both channels contain a near-identical `extractChatText()` function that extracts the last user message from an OpenAI-format messages array. If the extraction logic needs to change (e.g. to handle tool calls or multi-modal content), both copies must be updated independently.

**Suggested fix:** Move `extractChatText()` into `packages/lib` (the shared channel SDK) and import from both channels.

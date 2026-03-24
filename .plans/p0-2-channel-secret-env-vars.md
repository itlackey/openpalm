# P0-2 Implementation Plan: Fix Channel Secret Env Variable Names in Addon Overlays

Source: `docs/reports/end-to-end-remediation-backlog-2026-03-24.md:45`

## Objective

Fix addon overlay env wiring so channel containers receive the exact secret variable names expected by the channels SDK (`CHANNEL_<NAME>_SECRET`), and add tests that prove correct-name success and wrong-name failure behavior.

Authoritative guardrails:

- `docs/technical/authoritative/core-principles.md` (guardian-only ingress and fail-closed behavior)
- `AGENTS.md` requirement to avoid unjustified complexity

## Current State Inspection (Overlays, SDK, Tests)

## A) Addon overlay references (affected)

- `.openpalm/stack/addons/chat/compose.yml:14` uses `CHANNEL_SECRET: ${CHANNEL_CHAT_SECRET:-}` (wrong key name exported into container env)
- `.openpalm/stack/addons/api/compose.yml:14` uses `CHANNEL_SECRET: ${CHANNEL_API_SECRET:-}` (wrong key name exported into container env)
- `.openpalm/stack/addons/discord/compose.yml:14` uses `CHANNEL_SECRET: ${CHANNEL_DISCORD_SECRET:-}` (wrong key name exported into container env)
- `.openpalm/stack/addons/slack/compose.yml:14` uses `CHANNEL_SECRET: ${CHANNEL_SLACK_SECRET:-}` (wrong key name exported into container env)
- `.openpalm/stack/addons/voice/compose.yml:14` already uses `CHANNEL_VOICE_SECRET: ${CHANNEL_VOICE_SECRET:-}` (correct; no change)

## B) SDK/runtime contract references (affected by mismatch)

- `packages/channels-sdk/src/channel-base.ts:44` documents `CHANNEL_<NAME>_SECRET`
- `packages/channels-sdk/src/channel-base.ts:48` resolves env key as `CHANNEL_${this.name.toUpperCase().replace(/-/g, "_")}_SECRET`
- `packages/channels-sdk/src/channel-base.ts:193` fails startup when resolved secret is empty
- `packages/channels-sdk/README.md:17` documents name-derived `CHANNEL_<NAME>_SECRET` expectation
- `core/channel/README.md:20` documents `CHANNEL_<NAME>_SECRET` for unified channel image

## C) Existing tests and current coverage gaps

- `packages/channel-discord/src/index.test.ts:975` has a basic env-resolution assertion for `CHANNEL_DISCORD_SECRET`
- `packages/channel-slack/src/index.test.ts:697` has a basic env-resolution assertion for `CHANNEL_SLACK_SECRET`
- `packages/channel-chat/src/index.test.ts` has no explicit env-key resolution assertion
- `packages/channel-api/src/index.test.ts` has no explicit env-key resolution assertion
- No current test asserts that addon `compose.yml` overlays export channel-specific env keys (vs generic `CHANNEL_SECRET`)
- No current negative test proves wrong env key name causes channel startup contract failure

## Planned Implementation Edits (Exact)

## 1) Fix overlay env variable names to SDK contract

File: `.openpalm/stack/addons/chat/compose.yml`

- Edit at `.openpalm/stack/addons/chat/compose.yml:14`
- Replace:
  - `CHANNEL_SECRET: ${CHANNEL_CHAT_SECRET:-}`
- With:
  - `CHANNEL_CHAT_SECRET: ${CHANNEL_CHAT_SECRET:-}`

File: `.openpalm/stack/addons/api/compose.yml`

- Edit at `.openpalm/stack/addons/api/compose.yml:14`
- Replace:
  - `CHANNEL_SECRET: ${CHANNEL_API_SECRET:-}`
- With:
  - `CHANNEL_API_SECRET: ${CHANNEL_API_SECRET:-}`

File: `.openpalm/stack/addons/discord/compose.yml`

- Edit at `.openpalm/stack/addons/discord/compose.yml:14`
- Replace:
  - `CHANNEL_SECRET: ${CHANNEL_DISCORD_SECRET:-}`
- With:
  - `CHANNEL_DISCORD_SECRET: ${CHANNEL_DISCORD_SECRET:-}`

File: `.openpalm/stack/addons/slack/compose.yml`

- Edit at `.openpalm/stack/addons/slack/compose.yml:14`
- Replace:
  - `CHANNEL_SECRET: ${CHANNEL_SLACK_SECRET:-}`
- With:
  - `CHANNEL_SLACK_SECRET: ${CHANNEL_SLACK_SECRET:-}`

Notes:

- Do not edit `.openpalm/stack/addons/voice/compose.yml:14` (already correct)
- Do not edit addon `.env.schema` files for chat/api/discord/slack (already declare correct keys)

## 2) Add overlay contract tests for shipped channel addons

File: `packages/cli/src/install-flow.test.ts`

- Add assertions in the tier-1 validation flow near existing compose-file checks (`packages/cli/src/install-flow.test.ts:207` and `packages/cli/src/install-flow.test.ts:212`)
- Read each seeded addon overlay and assert exact key names in file content:
  - `stack/addons/chat/compose.yml` contains `CHANNEL_CHAT_SECRET:` and does not contain `CHANNEL_SECRET:`
  - `stack/addons/api/compose.yml` contains `CHANNEL_API_SECRET:` and does not contain `CHANNEL_SECRET:`
  - `stack/addons/discord/compose.yml` contains `CHANNEL_DISCORD_SECRET:` and does not contain `CHANNEL_SECRET:`
  - `stack/addons/slack/compose.yml` contains `CHANNEL_SLACK_SECRET:` and does not contain `CHANNEL_SECRET:`

Rationale: install-flow test already validates seeded runtime assets and is the lowest-friction location to enforce overlay contract regressions.

## 3) Add channels SDK contract tests for positive/negative env-key behavior

File: `packages/channels-sdk/src/channel-base.test.ts`

- Add a new test block after existing forwarding tests (around `packages/channels-sdk/src/channel-base.test.ts:111`)
- Add positive scenario test:
  - Set `Bun.env.CHANNEL_TEST_SECRET = "named-secret"`
  - Instantiate `TestChannel` (`name = "test"`)
  - Assert `channel.secret === "named-secret"`
- Add negative scenario test:
  - Set only `Bun.env.CHANNEL_SECRET = "generic-secret"`
  - Ensure `Bun.env.CHANNEL_TEST_SECRET` is unset/empty
  - Instantiate `TestChannel`
  - Assert `channel.secret === ""` (proves no generic fallback)
- Add cleanup/reset in this test block to avoid env leakage across tests

Rationale: this is the canonical unit-level proof that startup secret resolution is name-scoped and fails closed for wrong key names.

## 4) Fill missing per-channel env-resolution assertions (chat/api)

File: `packages/channel-chat/src/index.test.ts`

- Add parity test in channel class behavior area (end of file near `packages/channel-chat/src/index.test.ts:123`):
  - `it("secret resolves from CHANNEL_CHAT_SECRET env", ...)`
  - Assert `typeof channel.secret === "string"` (same style as discord/slack tests)

File: `packages/channel-api/src/index.test.ts`

- Add parity test near health/class-level tests (after `packages/channel-api/src/index.test.ts:53`):
  - `it("secret resolves from CHANNEL_API_SECRET env", ...)`
  - Assert `typeof channel.secret === "string"`

Rationale: aligns chat/api with existing discord/slack coverage so all four affected addons have direct channel-level secret-resolution smoke tests.

## Verification Plan

Run from repo root unless noted.

1) Targeted unit tests for changed packages:

```bash
cd packages/channels-sdk && bun test src/channel-base.test.ts
cd packages/channel-chat && bun test src/index.test.ts
cd packages/channel-api && bun test src/index.test.ts
cd packages/cli && bun test src/install-flow.test.ts
```

2) Project guardrails from backlog checklist:

```bash
cd packages/admin && npm run check
cd core/guardian && bun test
```

3) Static regression check for forbidden generic key in shipped overlays:

```bash
rg -n "CHANNEL_SECRET:" .openpalm/stack/addons/{chat,api,discord,slack}/compose.yml
```

Expected: no matches.

4) Static confirmation for required channel-specific keys:

```bash
rg -n "CHANNEL_(CHAT|API|DISCORD|SLACK)_SECRET:" .openpalm/stack/addons/{chat,api,discord,slack}/compose.yml
```

Expected: one match per file at the environment block line.

## Positive/Negative Test Scenarios

Positive scenarios:

- Chat overlay exports `CHANNEL_CHAT_SECRET`, API exports `CHANNEL_API_SECRET`, Discord exports `CHANNEL_DISCORD_SECRET`, Slack exports `CHANNEL_SLACK_SECRET`
- `BaseChannel.secret` resolves when correct `CHANNEL_<NAME>_SECRET` exists
- Affected channel tests (chat/api/discord/slack) pass secret-resolution smoke assertions

Negative scenarios:

- Generic `CHANNEL_SECRET` alone does not satisfy SDK secret resolution (`channel.secret` remains empty)
- Overlay contract tests fail if any affected overlay reintroduces `CHANNEL_SECRET:` key
- Startup contract remains fail-closed via `BaseChannel.start()` when derived key is missing (`packages/channels-sdk/src/channel-base.ts:193`)

## Acceptance Criteria Mapping (P0-2)

- "All shipped channels read secrets from correctly named env vars": satisfied by overlay edits and overlay contract assertions in `packages/cli/src/install-flow.test.ts`
- "No startup failures due to missing secret env names when secrets exist": satisfied by matching overlay key names to SDK-derived names (`packages/channels-sdk/src/channel-base.ts:48`) and verified by unit tests

## Complexity Callout

- Current mixed naming (`CHANNEL_SECRET` in overlays vs `CHANNEL_<NAME>_SECRET` in SDK) is unjustified complexity and creates avoidable startup drift.
- This plan removes that drift at the source (overlay env key names) and locks it with low-cost tests.

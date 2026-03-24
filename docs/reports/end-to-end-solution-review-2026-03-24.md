# End-to-End Solution Review and Architecture Analysis

Date: 2026-03-24  
Branch: `feat/providers`

## Scope and Method

This review used:

- Authoritative project docs review, led by `docs/technical/authoritative/core-principles.md`.
- Multi-agent codebase analysis (three deep explore passes: control plane, ingress security, compose/mount contracts).
- FTA (Fast TypeScript Analyzer) runs over major implementation areas.
- External source checks against current Docker and Varlock docs.

Commands and tools used included AKM search/show, Task subagents, FTA CLI, and direct repo source reads.

## Executive Assessment

Overall verdict: the repository has a strong direction and many solid security patterns, but there are several high-impact contract and implementation misalignments that should be resolved before treating this architecture as stable.

Top priorities:

1. Fix guardian/channel secret wiring consistency (`guardian.env` vs `stack.env`) and channel env variable naming.
2. Remove guardian bypass behavior in voice channel fallback.
3. Enforce mount/data ownership boundaries for scheduler and reduce over-broad mounts.
4. Eliminate split orchestration/assembly logic paths and centralize them in `@openpalm/lib`.

## What Is Working Well

- Guardian implements HMAC verification with constant-time comparison and replay/timestamp checks in `core/guardian/src/server.ts`.
- Guardian ingress network boundary is explicit in compose (`.openpalm/stack/core.compose.yml:138`).
- Assistant has no Docker socket mount and mounts are mostly aligned with isolation goals (`.openpalm/stack/core.compose.yml:94`).
- Control-plane abstraction in `packages/lib` is substantial and already shared by multiple consumers.
- Docker command execution patterns generally avoid shell interpolation and use safer process APIs.

## Critical Findings

### 1) Channel secret contract split (`guardian.env` vs `stack.env`)

Severity: Critical

The runtime and docs indicate `vault/stack/guardian.env` as the channel secret source for guardian hot-reload and compose interpolation, but control-plane persistence still writes `CHANNEL_*_SECRET` into `stack.env`.

Evidence:

- Guardian reads mounted `guardian.env` and `GUARDIAN_SECRETS_PATH` in `.openpalm/stack/core.compose.yml:122` and `.openpalm/stack/core.compose.yml:132`.
- Compose env-file builder excludes `guardian.env` in `packages/lib/src/control-plane/config-persistence.ts:69`.
- Channel secrets are written into `stack.env` in `packages/lib/src/control-plane/config-persistence.ts:81` and `packages/lib/src/control-plane/config-persistence.ts:99`.
- Docs describe three compose env files including guardian secret file in `docs/technical/environment-and-mounts.md:42`.

Impact:

- Potential signature mismatch or complete guardian verification failure for channels.
- Operational drift between documented model and actual runtime behavior.

### 2) Channel secret env var name mismatch in multiple addons

Severity: High

The channels SDK expects `CHANNEL_<NAME>_SECRET`, but several addon overlays set `CHANNEL_SECRET`.

Evidence:

- SDK key derivation in `packages/channels-sdk/src/channel-base.ts:48`.
- Misnamed vars in `.openpalm/stack/addons/chat/compose.yml:14`, `.openpalm/stack/addons/api/compose.yml:14`, `.openpalm/stack/addons/discord/compose.yml:14`, `.openpalm/stack/addons/slack/compose.yml:14`.
- Voice overlay correctly uses `CHANNEL_VOICE_SECRET` at `.openpalm/stack/addons/voice/compose.yml:14`.

Impact:

- Channel startup failures or silent misconfiguration risk.

### 3) Guardian-only ingress invariant bypass in voice channel

Severity: Critical

Voice channel explicitly falls back to direct LLM calls when guardian forwarding fails.

Evidence:

- Fallback branch to direct `chatCompletion()` in `packages/channel-voice/src/index.ts:123` and `packages/channel-voice/src/index.ts:136`.

Impact:

- Violates guardian-only ingress and bypasses shared protections (HMAC, replay/rate controls, audit consistency).

### 4) Scheduler mount boundary drift from contract

Severity: Critical

Scheduler currently mounts broad writable host paths (`logs` and full `data`) instead of a narrow ownership-scoped mount plan.

Evidence:

- Scheduler mounts in `.openpalm/stack/core.compose.yml:164`, `.openpalm/stack/core.compose.yml:165`, `.openpalm/stack/core.compose.yml:166`.
- Contract language limiting cross-service data access in `docs/technical/authoritative/core-principles.md:120`.

Impact:

- Violates least-privilege/data ownership model.
- Expands blast radius of scheduler compromise.

## High Findings

### 5) Split control-plane logic outside `@openpalm/lib`

Severity: High

Significant orchestration logic remains duplicated in admin/CLI.

Evidence:

- Registry clone/pull/discovery implemented in admin-only module `packages/admin/src/lib/server/registry-sync.ts:1`.
- Compose startup and preflight wrapper in shell script `.openpalm/stack/start.sh:196` with independent behavior.
- Addon parsing and stack yaml handling in shell script `.openpalm/stack/start.sh:39` diverges from typed parser in `packages/lib/src/control-plane/stack-spec.ts:144`.

Impact:

- Behavior drift between CLI/admin/script paths.
- Harder to secure and test consistently.

### 6) Inconsistent stack spec model handling

Severity: High

`@openpalm/lib` enforces v2 spec parsing, while `start.sh` implements ad-hoc top-level list parsing.

Evidence:

- Strict v2 check in `packages/lib/src/control-plane/stack-spec.ts:156`.
- Manual list extraction logic in `.openpalm/stack/start.sh:49` and `.openpalm/stack/start.sh:75`.

Impact:

- Different addon selection behavior across entrypoints.

### 7) Assistant-token authorization is broad without explicit endpoint allowlist

Severity: Medium-High

`requireAuth` permits admin or assistant token globally; policy granularity by endpoint/action is not explicit.

Evidence:

- Token acceptance logic in `packages/admin/src/lib/server/helpers.ts:90`.

Impact:

- Policy drift risk against principle requiring authenticated and allowlisted assistant actions.

## Complexity and Maintainability Findings (FTA)

FTA was run on: `packages/lib`, `packages/cli`, `packages/admin`, `core/guardian`, `packages/channels-sdk`, `packages/scheduler`.

Highest-risk files:

- `packages/cli/src/setup-wizard/wizard.js` score 141.23 (Needs improvement).
- `packages/lib/src/control-plane/install-edge-cases.test.ts` score 75.62 (Needs improvement).
- `packages/admin/e2e/setup-wizard.test.ts` score 73.65 (Needs improvement).
- `core/guardian/src/server.ts` score 70.27 (Needs improvement).
- `packages/cli/src/commands/install.ts` score 66.74 (Needs improvement).
- `packages/lib/src/control-plane/scheduler.ts` score 65.08 (Needs improvement).

Key interpretation:

- Security-critical logic (guardian) and control-plane assembly paths are concentrated in large modules.
- Tests are also heavy/complex in places, suggesting scenarios are broad but possibly under-factored.

## Docker and Varlock Alignment Review

### Docker docs alignment highlights

Reviewed Docker docs:

- Compose merge rules: https://docs.docker.com/reference/compose-file/merge/
- Compose interpolation and env-file precedence: https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/
- Bind mount behavior and host authority: https://docs.docker.com/engine/storage/bind-mounts/

Observed repo alignment:

- Architecture correctly leans on native compose merge and interpolation patterns.
- The documented “host authority” principle aligns with bind mount obscuring behavior.

Gaps to address:

- Multiple orchestration paths compose different env-file sets (`guardian.env` omitted in default start script) at `.openpalm/stack/start.sh:8`.
- This undermines deterministic compose model resolution.

### Varlock docs alignment highlights

Reviewed Varlock docs:

- CLI reference (`load`, `run`, `scan`, `--path`): https://varlock.dev/reference/cli-commands/
- AI tools guidance and scan posture: https://varlock.dev/guides/ai-tools/
- Docker usage pattern: https://varlock.dev/guides/docker/

Observed repo alignment:

- Strong adoption of schema-driven validation and secret scanning posture.
- `--path` usage patterns and scan mindset are broadly aligned with current docs.

Potential improvement:

- Consider whether pinned varlock binary version in CLI (`packages/cli/src/lib/varlock.ts:5`) should be kept closer to upstream for security/feature parity, with a controlled upgrade policy and checksum update cadence.

## Simplification Opportunities (Highest ROI)

1. Create a single lib-owned channel secret backend API.
2. Standardize compose arg/env-file construction in `@openpalm/lib` and reuse everywhere.
3. Refactor guardian server into focused modules (`auth`, `replay`, `rate-limit`, `forwarding`, `audit`).
4. Remove direct-LLM fallback from channel voice and return explicit guardian-unavailable errors.
5. Move admin registry sync/discovery into shared lib.
6. Narrow scheduler mounts to minimum required directories.

## Recommended Remediation Plan

### Phase 0 (Immediate)

- Fix channel secret variable names in addon overlays.
- Remove guardian bypass path in voice channel.
- Include `guardian.env` consistently in compose env-file assembly.

### Phase 1 (Security and contract hardening)

- Implement a unified secret write/read/rotation path for channel secrets.
- Enforce single-orchestrator lock for mutating operations.
- Restrict scheduler mounts to ownership-scoped paths.

### Phase 2 (Complexity reduction)

- Consolidate start/apply/preflight behaviors into shared lib APIs.
- Decompose `core/guardian/src/server.ts`.
- Reduce setup-wizard complexity and split by concerns.

### Phase 3 (Policy and docs)

- Introduce explicit assistant-action allowlist policy enforcement.
- Align non-authoritative docs and helper scripts with authoritative contract.

## Risk Register Snapshot

- Critical: guardian/channel secret split; guardian bypass fallback; scheduler over-broad mounts.
- High: channel env var mismatch; split control-plane logic; stack spec parser divergence.
- Medium: broad assistant-token acceptance policy; high complexity concentration in core modules.

## Confidence and Limits

- Confidence: High on architectural and code-level findings listed with file evidence.
- Limits: Secret value files were not inspected (by design and tooling restrictions), so this review focuses on contract wiring and behavior paths rather than secret contents.

## Appendices

### A) Major files reviewed directly

- `docs/technical/authoritative/core-principles.md`
- `docs/technical/environment-and-mounts.md`
- `.openpalm/stack/core.compose.yml`
- `.openpalm/stack/start.sh`
- `.openpalm/stack/addons/chat/compose.yml`
- `.openpalm/stack/addons/api/compose.yml`
- `.openpalm/stack/addons/discord/compose.yml`
- `.openpalm/stack/addons/slack/compose.yml`
- `.openpalm/stack/addons/voice/compose.yml`
- `packages/lib/src/control-plane/config-persistence.ts`
- `packages/lib/src/control-plane/stack-spec.ts`
- `packages/admin/src/lib/server/helpers.ts`
- `packages/admin/src/lib/server/registry-sync.ts`
- `packages/channel-voice/src/index.ts`
- `packages/channels-sdk/src/channel-base.ts`
- `core/guardian/src/server.ts`

### B) Agent-assisted review domains

- Control-plane architecture and duplication analysis.
- Guardian/channel ingress and security invariant analysis.
- Compose/mount/filesystem contract alignment analysis.

# 0.13.0 Implementation Plan — Open Milestone Issues

> **HISTORICAL:** Pre-RC planning snapshot, not current architecture or release
> authority. Its `packages/client`, runtime-mode, port 3890, hosted-origin,
> remote-handshake, and expanded-offline assumptions were superseded. Use
> `docs/technical/architecture.md` and the 0.13.0 RC checklists.

_Prepared 2026-07-12 against `0.13.0-beta.3`. Ten issues remain open in the milestone:
#433 #435 #486 #488 #490 #491 #506 #511 #557 #563._

Each issue has a codebase-verified assessment brief in
[`assessments/`](./assessments/) documenting what is **already merged** in the betas
versus what actually remains. Several issues are 60–90% shipped already (notably
#433, #435, #486, #491, #511's build plumbing, and #557's CORS half); this plan
targets only the true deltas.

## Execution model (test-first + gated)

Every task runs the same six-stage pipeline, orchestrated by
[`.claude/workflows/implement-0-13-0.js`](../../../.claude/workflows/implement-0-13-0.js):

| Stage | Actor | Output | Gate |
|---|---|---|---|
| 1. Spec | **Fable** (max effort) | Implementation spec: exact file-level changes, test list (written first), acceptance mapping, out-of-scope | — |
| 2. Spec review | **Opus** | approve / revise verdict + required changes | Loop to stage 1 (≤2 revisions); on persistent rejection the task is **skipped and reported**, never implemented from an unapproved spec |
| 3. Tests first | **Sonnet** | Failing tests per spec, committed; each new test verified to fail for the intended reason before implementation exists | Tests must fail before impl (red) |
| 4. Implement | **Sonnet** | Code to make the tests pass, committed | Package tests + `bun run lint` + `bun run check` green |
| 5. Code review | **Opus** | Findings vs spec + issue acceptance criteria + repo hard rules | Approve or findings |
| 6. Fix loop | **Sonnet** | Fixes for findings, re-gated, re-reviewed | ≤3 rounds; unresolved → flagged in final report, not silently merged |

**Repo-wide verification gates** (run at stage 4 and after each fix round):

- `bun install` once at repo root (single lockfile rule)
- `bun run lint` (Biome, repo-wide)
- `bun run check` (svelte-check: ui + ui-kit + client)
- Targeted package tests, e.g. `cd packages/guardian && bun test --no-orphans`,
  `bun run lib:test`, `bun run client:build && bun run client:test`, `bun run cli:test`
- Full aggregate `bun run test` at the end of each phase
- Known sandbox flakes (root-uid ownership tests in lib) are compared against the
  pre-change baseline, not treated as regressions.

**Hard rules baked into every agent prompt** (from `AGENTS.md`,
`docs/technical/core-principles.md`, `code-quality-principles.md`, `bunjs-rules.md`,
`sveltekit-rules.md`, `ui-runtime-modes-plan.md` §8): no unjustified complexity;
strict TS, no `any` for untrusted data; control-plane logic only in `@openpalm/lib`;
`$effect` is a bug; `@openpalm/client` never depends on `@openpalm/lib` (CI purity
gate); secrets are files under `knowledge/secrets/`; fail closed on auth errors;
loopback-default posture unchanged; file assembly not templating; Bun built-ins
before new deps.

## Phases (dependency order)

Tasks are sequential within and across phases (they share one branch and
overlapping files); the phase grouping documents the dependency rationale and the
natural checkpoint boundaries.

### Phase 1 — Cleanups & foundation close-out (S+S)

1. **#490 — Remove `channel_lan` + `CHANNEL_NAME` marker.** Pure removal with a
   negative test pinning it, an overlay deprecation scan on upgrade/reconcile
   (review finding M7 made the "optional" scan near-mandatory since the migration
   framework was deleted), the `channel-` → `portal-` service-name rename in
   portal-sdk, and a reintroduction grep-gate in `cleanup-guardrails.test.ts`.
   No dependencies; lowest risk; validates the pipeline.
2. **#433 — Guardian state store close-out.** Phase 1 of the issue already
   shipped (`state-db.ts` principals registry IS the auth layer). Remaining: WAL
   mode (+ 0600 discipline on `-wal`/`-shm` sidecars), `PRAGMA user_version`
   migration bookkeeping (wrapping the existing kind-constraint migration as
   v0→v1), optional `DELETE /admin/principals/:id`, and a recorded decision on
   the deferred columns (add-on-consumer policy) coordinated with #435. Phase 2
   (ownership persistence) explicitly declined per the issue's own gating.

### Phase 2 — Guardian transport & LAN identity (M+M)

3. **#435 — mTLS adapter transport identity.** _DE-SCOPED 2026-07-21 —
   issue closed as not planned._ The mTLS passthrough built for this task was
   removed after the PR #564 review (`d105fa7`); TLS/mTLS is delegated to
   operator infrastructure per `docs/remote-access-tls.md`. The
   PolicyProvider seam was removed as unwired dead code (`904db50`). Only the
   Basic-auth `authenticate() → Principal` seam ships. The `assessments/435.md`
   and `specs/435.md` briefs (and review-564 c5/c6 findings) described the
   pre-revert state and have been deleted.
4. **#488 — mDNS self-advertisement.** New `packages/lib/src/control-plane/mdns-responder.ts`
   (node:dgram, pure encode/decode functions unit-tested without sockets),
   hosted in the HOST control-plane process (the guardian container cannot
   usefully multicast; d5a doc records this). Gate: guardian name only when
   `OP_BIND_ADDRESS` non-loopback, assistant name only when
   `OP_ASSISTANT_BIND_ADDRESS` non-loopback; names derived from
   `OP_PROJECT_NAME`. Admin UI surfaces the `.local` names via `/api/host/stack`.

### Phase 3 — Remote-access enablement (M+M)

5. **#557 — Guardian edge TLS guide + client HTTPS enforcement.** CORS half
   already shipped (allowlist + 9-case test suite). Remaining: the user-facing
   TLS guide (Tailscale `serve` default, Caddy alternative), optional compose
   overlay following the voice-overlay pattern, `validateConnectionUrl()` in
   `packages/client` refusing plain-HTTP non-loopback targets with a deep link
   to the guide, hosted-origin allowlist decision, coordination notes for
   #488/#435.
6. **#491 — Standalone portal packages.** portal-sdk extraction + publishing
   already done. Remaining: fix the `OPENCODE_BASE_URL` regression in
   `base-portal.ts` (env-driven base URL), client-side session-reuse fallback
   in portal-sdk (guardian hint header retained — the #433 coordination
   resolved server-side, so this is a standalone-mode fallback only), direct-env
   secret fallback (`readRequiredSecret` accepting non-`_FILE` vars),
   `SLACK_BOT_NAME` branding, `bin/` entrypoints, standalone READMEs with the
   mandated security framing, recorded Bun-runtime decision.

### Phase 4 — Client/remote install completion (M+L)

7. **#486 — Remote-only (client) install.** Mostly shipped. Remaining:
   stack-less `openpalm app` entry (serve client with no local install),
   wire-or-descope the `openpalm-client-api` kind selector in both connection
   forms, documented remote-credential provisioning flow (direct principal +
   CORS origin + `GUARDIAN_DIRECT_INGRESS`), an end-to-end remote-attach
   verification, and doc/issue close-out reflecting the ratified two-artifact
   split.
8. **#511 — PWA install paths.** PWA plumbing (manifest/workbox/icons/CSP,
   stable port 3890, `openpalm app`) already shipped. Remaining: hosted-origin
   CI deploy job, `/api/runtime` contract-version handshake with graceful
   degradation, paste-or-scan pairing (host mints QR/one-time code), HTTPS
   refusal UX (shared with #557), `clientDisplayMode` detection in the client
   artifact, install affordances (Electron menu / host-app button), offline
   Playwright e2e.

### Phase 5 — Composition layer (L)

9. **#563 — Network access presets.** Depends on #488 (guardian mDNS for the
   shared-network preset) and #486 framing. Pure preset resolver in lib
   (4 presets → env matrix), SetupSpec extension + validation (shared-guardian
   hard-pins assistant loopback), `OPENCODE_AUTH`/`OP_OPENCODE_PASSWORD` compose
   plumbing + guardian upstream Basic auth, wizard preset step with editable
   pre-filled password and explicit risk warning for open access, mDNS wiring
   per preset (post-overwrite file assembly for `opencode.jsonc`), bind-warning
   rewording, admin LAN-toggle reconciliation, #486 copy updates.

### Phase 6 — Design-language reconciliation (L) — MOVED OUT

> **2026-07-12:** #506 is removed from the automated implementation workflow.
> It will be re-scoped and handled in a separate coding session. The notes
> below are retained for that re-scoping.

10. **#506 — Wizard design language across normal modes.** Last because it
    touches every route the earlier phases modify. Wizard steps onto shared
    ui-kit components (absorbs #458), delete duplicated inline CSS,
    `/connections` restyle in **both** ui and client apps (prefer shared ui-kit
    components so they cannot drift), designed chat empty states, documented
    `wiz-*` vocabulary, ux-audit config extension, full gate:
    `npm run ux:audit` + width sweep 320–1440 light+dark + 3-judge panel per
    `ui-design-rubric.md` (all 10 categories PASS).

## Cross-cutting decisions to record during execution

- **#433×#435 schema:** deferred registry columns (protocols/persona/rate_policy,
  `cert_fingerprint`) are added by `ALTER TABLE` under `user_version` migrations
  only when their consumer ships (#435 mTLS may add `cert_fingerprint`).
- **#433×#491 session continuity:** resolved server-side (guardian
  `session-target.ts`); portal-sdk client map is a standalone-mode fallback, not
  the primary mechanism.
- **#557×#511 hosted origin:** `https://app.openpalm.dev` enters the compose CORS
  default only when the hosted deploy actually exists.
- **#563×#486 framing:** direct-to-assistant LAN access becomes a supported home
  preset; docs/copy updated accordingly.

## Milestone exit criteria

- All ten issues' remaining-work checklists complete (or explicitly descoped with
  a recorded decision in the issue).
- `bun run lint`, `bun run check`, `bun run test` green; guardian/lib/cli/client
  suites at or above the beta-3 baseline.
- Security posture unchanged by default: loopback-default binds, guardian-only
  portal ingress, fail-closed moderation, no secrets in env/stack.env.
- CHANGELOG `[Unreleased]` entries for every user-visible change.

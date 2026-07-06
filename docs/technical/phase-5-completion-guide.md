# Phase 5 Completion Guide — client split (P5c → P5e)

**Date:** 2026-07-06
**Branch:** `claude/ui-runtime-modes-phases-1-4`
**Status:** P5a + P5b DONE (gates passed). P5c, P5d, P5e + final sweep REMAIN.
**Plan:** `docs/technical/ui-runtime-modes-plan.md` (§6.9–§6.11, Phase 5, §8 rules, §1 simplicity guardrails)
**Decision record:** `docs/technical/ui-client-split-assessment.md`
**Tracking issues:** #555 (client extraction), #510 (assistant-container Slice A)

This file is the handoff for finishing Phase 5. It records exactly what is done,
what remains, the working discipline, and how to resume the interrupted workflow.

---

## 1. What is DONE on this branch

Phases 1–4 (+1.5) of the plan are complete (see plan §7/§10 — marked DONE with
as-built notes). For Phase 5:

### P5a — `packages/ui-kit` ✅ (gate passed 3/3 after 1 fix round)

- Raw-source private workspace package: `components/common/` (~21), `components/icons/`
  (64+), theme tokens (`src/lib/theme/tokens.css`). No build step; consuming apps compile it.
- Fix-round outcomes now enforced by tests: `Toast.svelte` decoupled from voice-state
  (ui-kit is presentational only); `svelte-check`-based `check` script + tsconfig added
  (0 errors / 0 warnings, 261 files).
- Hygiene test guarantees ui-kit imports no `$lib/api`, `$lib/server`, `@openpalm/lib`,
  or chat/connections stores.
- Key commits: `93fadfd` (extraction), `c7d53ab` (fix round).

### P5b — `packages/client` ✅ (gate passed; 1 blocking finding found and fixed)

`@openpalm/client` — the unprivileged chat/connections static SPA (plan §6.11):

- **Build:** SvelteKit 2 + Svelte 5, `adapter-static` SPA (`ssr=false`), consumes
  `@openpalm/ui-kit`. `build` → `svelte-kit sync && vite build && stamp-version`
  (stamps `.openpalm-client-version`). Root scripts: `client:build`, `client:check`,
  `client:test` wired in root `package.json`.
- **Transport** (`src/lib/transport/index.ts`): ONE module — direct fetch to a
  guardian/OpenCode base URL; Basic (username default `openpalm`) / Bearer;
  `credentials:'omit'` (no cookies ever); session list/create; message send; SSE frame
  parser (UTF-8 split-chunk safe); never-throws health probe mapped to the host app's
  RemoteStatus vocabulary. Injectable fetch for tests.
- **Connections** (`src/lib/connections/`): `ConnectionEntry` per plan §6.6; raw
  IndexedDB with a storage abstraction + in-memory twin for tests; `runtime-config.json`
  boot seeding (locked default connection; user selections and locked entries protected
  on re-seed); offline-readable; `secrets.ts` holds per-connection credentials.
- **Views:** `/chat`, `/connections`, `/connections/new`; landing: 0 connections →
  `/connections/new`, else `/chat` (`src/lib/resolve-landing.ts`).
- **Static server** (`bin/serve.mjs`): zero-dependency; loopback default (`--host` only
  where policy gates exposure); SPA fallback; serves `runtime-config.json` from beside
  the build; path-traversal-contained (verified with hostile requests); returns 400 on
  malformed percent-escapes (gate finding — fixed in `c036bba`, pinned by
  `tests/serve.test.ts`).
- **Purity, enforced:** zero runtime `dependencies`; no `src/lib/server/`; no
  `@openpalm/lib` anywhere; `tests/purity.test.ts` greps the BUILT bundle for
  `@openpalm/lib` and `/api/host` markers and fails on a missing build rather than skipping.
- **Tests:** 67 pass / 0 fail (transport request shaping, SSE, health, store CRUD +
  locked/active semantics, seeding idempotency, offline read, landing, purity, serve
  resilience). `client:check`: 0 errors / 0 warnings (312 files).
- Key commits: `424d091` + `e8e67b1` (red tests), `a049f06` (transport/store),
  `93cebe8` (app/serve/wiring), `c6f38a4` + `c036bba` (gate fix).

### Gate provenance for P5b (honesty note)

Three review lenses ran: simplicity (block → serve.mjs crash), correctness (block →
same single finding; everything else verified incl. test-honesty diff between red and
impl commits), plan/security (agent died at the spend limit AFTER verifying purity,
traversal, cookie hygiene and signaling green; its two residual checks — no runtime
deps / no `src/lib/server`, and the `private` flag — were completed manually).
The single blocking finding is fixed and test-pinned. Gate: **PASS**.

---

## 2. Carry-forward findings (non-blocking, assign to the right sub-phase)

1. **CI does not run the new suites** — neither root `test` nor `ci.yml` includes
   `client:test` / `client:check` / ui-kit check. → **P5e item 2/3** (already in spec).
2. **Chat streaming is partial** — the SSE parser is built and tested but the chat page
   awaits the full JSON response; live event subscription + history are labeled
   follow-up in the page. → chat-parity follow-up (before deleting `packages/ui` chat;
   not a P5c blocker).
3. **`pickStorage()` async failure gap** — only synchronous `indexedDB` access errors
   fall back to memory; an async `open()` failure (e.g. Firefox private mode) caches a
   rejected boot promise. → small fix, fold into P5c or the finalize sweep.
4. **Locked-entry lifecycle** — a locked connection removed from a future
   `runtime-config.json` can never be deleted by the user. → fold into P5d (the
   only writer of runtime-config.json) — decide: prune locked entries absent from the
   current config on seed.
5. **`createConnectionStore(options: { storage: unknown })`** weakens typing at the one
   construction site. → trivial, any sub-phase.
6. **`packages/client/package.json` has `private: true`** — must flip to publishable in
   **P5e** when it joins the npm publish DAG (mirror `@openpalm/ui`).

---

## 3. Working discipline (unchanged from Phases 1–4)

- **Test-first per sub-phase:** red tests committed before implementation
  (`test(p5x): red tests for #NNN`); genuine reds must fail for the right reason;
  characterization/hygiene tests labeled as such. Implementer never modifies red tests
  (exception: genuinely wrong test — fix + justify).
- **Gate per sub-phase:** three adversarial reviewers — (1) correctness + test honesty,
  (2) plan conformance + §8 security invariants (loopback defaults for every new
  listener; client never bundles `@openpalm/lib` or holds host credentials; capabilities
  server-enforced in `packages/ui`; harness contract untouched), (3) simplicity + scope
  (non-technical-user bias; no heavy deps; no drive-bys). Block → fix round → re-review;
  max 2 fix rounds; do not build the next sub-phase on a blocked gate.
- **Commits:** conventional style, reference #555 (or #510 for container work), end with:

  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01FetR7BttT1xBrA8fBwhui9
  ```

  Workflow agents never push; the supervising session pushes at sub-phase boundaries.

### Environment parity rule (judge every suite against this — container is uid-0 root, no docker daemon, Playwright downloads proxy-blocked)

| Suite | GREEN means |
|---|---|
| `bun run ui:check` / `client:check` / ui-kit `check` | 0 errors, 0 warnings (hard) |
| UI vitest (`cd packages/ui && npm run test:unit -- --run`) | ≥1082 passed, 0 failed in the node project; exit 1 from the 30 browser-project `*.svelte.vitest.ts` files (chromium blocked) is EXPECTED |
| `bun test --cwd packages/client` | 67+ pass, 0 fail (no env excuses) |
| `bun test --cwd packages/cli` | exactly 1 known fail (install-flow root-ownership under uid 0) |
| `bun test --cwd packages/lib` | exactly 17 known uid-0 fails (operator-ids ×8, volume-ownership ×3, ownership-reconcile ×5, rollback chmod-0400 ×1) + 10 docker skips |
| `bun run --cwd packages/electron test` | 88+ pass, 0 fail |
| `bun run lint` | no errors (16 pre-existing warnings + 1 info are baseline) |

Any NEW failure beyond this set is a regression the sub-phase must fix. Never "fix" the
known-failing tests.

---

## 4. Remaining work

### P5c — harness serves the client (#555)

1. **lib (`packages/lib`):** client-build resolution + seeding mirroring
   `ui-assets.ts` — `resolveClientBuildDir` / `seedClientBuild` /
   `checkAndUpdateClientBuild` for `@openpalm/client` (npm tarball integrity-verified
   via the existing `npm-bundle-updater`; `OPENPALM_REPO_ROOT` dev override included;
   version-stamp preference logic like the UI's). Thin sibling functions — do NOT fork
   the updater.
2. **CLI (`packages/cli`):** the supervisor that serves the UI also starts the client
   static server (`bin/serve.mjs` from the resolved client build) on
   `DEFAULT_CLIENT_PORT=3890`, loopback-only, supervised/respawned like the UI child.
   Both `openpalm admin` and the default serve path start it. Non-fatal if the client
   build is absent (log + skip).
3. **Electron (`packages/electron`):** main.ts starts the same client child after the
   UI server; when setup is complete, `resolveInitialUrl` loads
   `http://127.0.0.1:3890/chat`, FALLING BACK to the 3880 chat if the client child
   failed (keep the fallback dumb). `HARNESS_CONTRACT_VERSION` untouched — this is
   spawn-env/child work; keep `harness-contract-drift` tests green.
4. `packages/ui` chat is NOT deleted (parity confirmation needs a real browser — record
   as follow-up with carry-forward #2).

*Red tests:* lib resolve/seed (follow `ui-assets` test patterns); CLI spawn env/args +
skip-when-absent; Electron initial-URL preference + fallback (follow `main.test.ts`
patterns); drift tests stay green (characterization).

### P5d — assistant-container serves the client (#510 Slice A)

1. `containers/assistant/entrypoint.sh`: `install_runtime_artifacts` pulls
   `@openpalm/client` (`OP_CLIENT_VERSION` → `PLATFORM_VERSION` → hard error; keep the
   landed warn-and-continue when a previous artifact exists; skeleton pull unchanged).
2. Replace `start_ui` with `start_client`: write `runtime-config.json` beside the build
   FIRST (locked default connection pointing the BROWSER at the published OpenCode URL —
   default `http://127.0.0.1:${OP_ASSISTANT_PORT:-3800}`, override
   `OP_CLIENT_DEFAULT_ASSISTANT_URL`), then run `bin/serve.mjs` on `OP_CLIENT_PORT`
   (default 3000, bind 0.0.0.0 inside the container). This deletes the old
   `OPENCODE_API_URL` wiring bug path entirely.
3. Compose (`packages/skeleton/system/stack/`): publish the client port on the assistant
   service behind the existing `OP_BIND_ADDRESS` policy (mirror `OP_ASSISTANT_PORT`;
   loopback default). Wire `OP_CLIENT_PORT`/`OP_CLIENT_VERSION` into stack env plumbing.
4. Dockerfile: verify no `@openpalm/ui` co-process remnants; `PLATFORM_VERSION` arg
   already wired.
5. Decide carry-forward #4 (locked-entry pruning) here — the entrypoint owns
   runtime-config.json.
6. Docs: new env vars → `docs/technical/environment-and-mounts.md` /
   `consolidated-stack-env.md`.

*Red tests:* version-resolution (extend however `install_runtime_artifacts` is tested
today); repo test asserting no `OPENCODE_API_URL` export and no `@openpalm/ui` install
in entrypoint; compose assertion (yaml parse) for the port mapping + bind policy.
**No docker daemon here** — static verification only (`bash -n`, config asserts); say so
honestly in notes.

### P5e — release integration (#555)

1. Publish DAG (`platform-release.yml` — read it first): add `@openpalm/client`
   (exact-pin, mirror `@openpalm/ui` publish/stamp; **flip `private: true` off** —
   carry-forward #6). Verify nothing publishes `@openpalm/ui-kit`.
2. Root `package.json`: `client:check`/`client:test` + ui-kit check into the root
   check/test aggregates. **Wire them into `ci.yml`** (carry-forward #1).
3. CI purity gate: ensure `tests/purity.test.ts` (dist grep) actually runs in CI's test
   invocation and fails builds on violation.
4. Docs: `docs/technical/release-architecture.md` artifact table; plan §1 table row for
   client marked landed; `OP_CLIENT_VERSION`/`OP_CLIENT_PORT` in env/release docs.

*Red tests:* repo-hygiene test that root aggregates reference the client package;
YAML-parse test that the release workflow publishes `@openpalm/client` and not ui-kit.

### Final sweep

Run every suite (parity table above) + `client:build` + purity; fix only trivial
breakage; update `docs/technical/ui-runtime-modes-plan.md` §7/§10 marking Phase 5 DONE
with as-built notes (including: `packages/ui` chat NOT deleted — parity deferred;
Slice B settings shim not built); commit; push.

---

## 5. How to resume

**Option A — resume the workflow (preferred).** The interrupted run caches everything
through P5b's test author:

```
Workflow({
  scriptPath: "/root/.claude/projects/-home-user-openpalm/bd3d6dbd-40c3-5cff-8000-895d2d80f22b/workflows/scripts/ui-client-split-phase-5-wf_458bb49a-1ed.js",
  resumeFromRunId: "wf_458bb49a-1ed"
})
```

Caveats: the P5b implementer + gate reviewers were NOT journaled (they died / ran
out-of-band), so on resume they re-run — they will find the red tests already green and
should verify + return quickly; their re-review is redundant-but-harmless extra safety.
The workflow script's phases P5c/P5d/P5e run as specced (§4 above matches the script).
The session must push at each sub-phase boundary (workflow agents never push) — re-arm
the hourly check-in pattern via `send_later`.

**Option B — manual (this session or a fresh one).** Execute §4 sub-phase by sub-phase
under the §3 discipline: red tests → implement → 3-lens gate (spawn three reviewer
agents with the lens prompts in §3) → fix rounds → push → next.

**Watch out:** the monthly spend limit killed three agents on 2026-07-06 (two
implementers, one reviewer). If an agent dies mid-sub-phase: commit any uncommitted WIP
immediately (label it WIP, push), then resume — WIP commits are how P5b survived two
interruptions with zero lost work.

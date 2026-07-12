// Fixes the 18 review findings on PR #564 (itlackey/openpalm), clustered into 10
// tasks. Same gated, test-first pipeline as the milestone build:
//   Fable (max) writes a fix spec -> Opus reviews the spec (gate) -> Sonnet writes
//   failing tests first (red) -> Sonnet implements (green + lint/check gates) ->
//   Opus reviews the diff (gate) -> Sonnet fixes findings (<=3 rounds).
// Tasks run SEQUENTIALLY — they share one branch and several files overlap.
// The workflow NEVER pushes; review the report, then push from the main session.
//
// Run:  Workflow({ name: 'fix-pr-564-review' })
// Args (optional): { clusters: ['c3-network-preset-thispc', 'c9-lifecycle-guard'] }

export const meta = {
  name: 'fix-pr-564-review',
  description: 'Fix the 18 PR #564 review findings test-first, with opus spec + code review gates',
  whenToUse: 'Addressing the fwdslsh-dev review on PR #564 (findings in .github/roadmap/0.13.0/review-564/)',
  phases: [
    { title: 'c1 host username+auth' },
    { title: 'c2 guardian upstream auth' },
    { title: 'c3 network-preset this-pc' },
    { title: 'c4 home-password rerun' },
    { title: 'c5 tls-passthrough' },
    { title: 'c6 mtls server wiring' },
    { title: 'c7 mdns records' },
    { title: 'c8 pairing' },
    { title: 'c9 lifecycle guard' },
    { title: 'c10 bind-warning framing' },
  ],
}

const REPO = '/home/user/openpalm'
const DIR = `${REPO}/.github/roadmap/0.13.0/review-564`
const briefPath = (id) => `${DIR}/${id}.md`
const specPath = (id) => `${DIR}/specs/${id}.md`

// Ordered least-risk-first where independent; clusters sharing files stay ordered
// so the second sees the first's committed state.
const TASKS = [
  { id: 'c9-lifecycle-guard', phase: 'c9 lifecycle guard',
    gates: ['bun run lib:test'] },
  { id: 'c10-bind-warning', phase: 'c10 bind-warning framing',
    gates: ['bun run lib:test'] },
  { id: 'c3-network-preset-thispc', phase: 'c3 network-preset this-pc',
    gates: ['bun run lib:test'] },
  { id: 'c7-mdns-records', phase: 'c7 mdns records',
    gates: ['bun run lib:test'] },
  { id: 'c8-pairing', phase: 'c8 pairing',
    gates: ['bun run lib:test', 'bun run ui:check'] },
  { id: 'c1-host-username-auth', phase: 'c1 host username+auth',
    gates: ['bun run ui:check', 'cd packages/ui && npx vitest --run src/lib/server/endpoints.vitest.ts'] },
  { id: 'c2-guardian-upstream-auth', phase: 'c2 guardian upstream auth',
    gates: ['cd packages/guardian && bun test --no-orphans', 'bun run lib:test'] },
  { id: 'c4-home-password-rerun', phase: 'c4 home-password rerun',
    gates: ['bun run ui:check', 'cd packages/ui && npx vitest --run src/lib/setup/setup-state.vitest.ts'] },
  { id: 'c5-tls-passthrough', phase: 'c5 tls-passthrough',
    gates: ['cd packages/guardian && bun test --no-orphans'] },
  { id: 'c6-mtls-server-wiring', phase: 'c6 mtls server wiring',
    gates: ['cd packages/guardian && bun test --no-orphans'] },
]

const COMMON_GATES = ['bun run lint']

const RULES = `Hard rules (violations are review-blocking):
- Read ${REPO}/AGENTS.md and ${REPO}/docs/technical/core-principles.md before changing anything; also code-quality-principles.md, bunjs-rules.md (guardian/Bun), sveltekit-rules.md (UI).
- No unjustified complexity; prefer Bun/Web built-ins over ANY new dependency.
- Strict TypeScript; never \`any\` for untrusted data; relative imports include the .js extension.
- Portable control-plane logic lives ONLY in packages/lib (@openpalm/lib) — never duplicated into CLI/UI. Guardian (packages/guardian) is a standalone Bun service and does NOT import @openpalm/lib; a shared value between host UI and guardian is duplicated as a small local constant on each side, not force-shared across the package boundary.
- SvelteKit: $effect is treated as a bug; server-only code stays in $lib/server; validate all request data.
- Secrets are files under knowledge/secrets/ via *_FILE vars; nothing secret in env defaults or logs; fail closed on auth errors.
- Security posture unchanged by default: loopback-default binds, guardian-only portal ingress, fail-closed moderation.
- Preserve the fixes already on this branch — do not regress prior findings (28d1afb, 3825e00).
- Work on the CURRENT git branch. Commit with clear messages referencing the finding refs (e.g. "fix(guardian): ... (PR #564 r3566890023)"). NEVER push. NEVER create tags or PRs.`

const SPEC_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    per_finding: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          decision: { type: 'string', description: 'The chosen fix approach and why' },
          confirmed_real: { type: 'boolean', description: 'Whether the defect reproduces against the real current code' },
        },
        required: ['ref', 'decision', 'confirmed_real'],
      },
    },
    test_first_list: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'per_finding', 'test_first_list'],
}

const SPEC_REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['approve', 'revise'] },
    required_changes: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['verdict', 'required_changes'],
}

const TESTS_SCHEMA = {
  type: 'object',
  properties: {
    tests_added: { type: 'array', items: { type: 'string' } },
    red_confirmed: { type: 'boolean' },
    commit: { type: 'string' },
    notes: { type: 'string' },
  },
  required: ['tests_added', 'red_confirmed', 'commit'],
}

const IMPL_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    commits: { type: 'array', items: { type: 'string' } },
    gates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          status: { type: 'string', enum: ['pass', 'fail', 'baseline-flake', 'env-blocked'] },
          detail: { type: 'string' },
        },
        required: ['command', 'status'],
      },
    },
    deviations: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'commits', 'gates'],
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['approve', 'request_changes'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          file: { type: 'string' },
          summary: { type: 'string' },
          fix_hint: { type: 'string' },
        },
        required: ['severity', 'file', 'summary'],
      },
    },
    notes: { type: 'string' },
  },
  required: ['verdict', 'findings'],
}

const gatesFor = (t) => [...COMMON_GATES, ...t.gates].join('\n  - ')

const results = []
const selected =
  typeof args === 'object' && args && Array.isArray(args.clusters) && args.clusters.length
    ? args.clusters.map((id) => TASKS.find((t) => t.id === id)).filter(Boolean)
    : TASKS

for (const t of selected) {
  phase(t.phase)
  log(`${t.id}: writing fix spec`)

  // ── Stage 1+2: spec (fable, max) + spec review gate (opus) ─────────────────
  let specApproved = false
  let specFeedback = ''
  for (let round = 0; round < 3 && !specApproved; round++) {
    const spec = await agent(
      `You are the FIX SPEC AUTHOR for PR #564 review cluster ${t.id}.

Repo: ${REPO} (git branch: current checkout — do not switch). Read the finding brief at ${briefPath(t.id)} (verbatim reviewer text with file:line refs and prescribed fix directions), then explore the cited code to CONFIRM each defect reproduces against the real current source before designing a fix. The branch already carries earlier fixes (28d1afb, 3825e00) — verify against HEAD, not stale line numbers.

${RULES}

Produce an implementation-ready fix spec and WRITE IT to ${specPath(t.id)} (create the specs/ dir if needed; overwrite any prior version). Do NOT change any other file. The spec must contain:
1. Per finding: confirmed-real (reproduce against real code) or not; if you judge a finding wrong or already-fixed, say so with evidence rather than inventing a change. The chosen fix approach + rationale (where the reviewer offered options, DECIDE and justify).
2. TEST-FIRST PLAN: exact tests to write BEFORE the fix — file paths, test names, what each asserts, why each fails before the fix. Mirror the package's existing test idioms (cite fixture/pattern files). For defects hard to unit-test (e.g. socket timeouts), specify the most direct observable check and note anything genuinely untestable.
3. File-level changes: every file to create/modify with precise descriptions (signatures, constants, control flow). Keep fixes minimal and targeted — no drive-by refactors.
4. Verification gates the implementer must run green:
  - ${gatesFor(t)}
5. Out-of-scope / non-goals, and any coordination with sibling clusters (e.g. shared username default value).${specFeedback ? `\n\nA prior version of this spec was REJECTED by review. Address every required change:\n${specFeedback}` : ''}

Return summary + per_finding + test_first_list via the schema.`,
      { model: 'fable', effort: 'max', label: `spec:${t.id}:r${round}`, phase: t.phase, schema: SPEC_SCHEMA },
    )
    if (!spec) break

    const review = await agent(
      `You are the SPEC REVIEWER (gatekeeper) for PR #564 review cluster ${t.id}.

Repo: ${REPO}. Read the spec at ${specPath(t.id)}, the brief at ${briefPath(t.id)}, and ${REPO}/AGENTS.md + docs/technical/core-principles.md. Verify the spec against the ACTUAL codebase (read the cited files at HEAD). Do NOT modify anything.

Approve ONLY if ALL hold:
- Every finding in the brief is addressed: fixed, or documented as not-real/already-fixed with verifiable evidence (spot-check that evidence).
- Each chosen fix genuinely resolves the described failure mode without introducing a new one, and violates no hard rule (security posture, lib-only control plane vs standalone guardian, no new deps, $effect ban, secret boundary, fail-closed auth).
- The test-first plan is real: concrete paths + assertions that would fail before the fix, matching package idioms.
- The fixes are minimal (no unjustified refactor) and the listed gates are sufficient.
Otherwise return verdict "revise" with specific, actionable required_changes.`,
      { model: 'opus', effort: 'high', label: `spec-review:${t.id}:r${round}`, phase: t.phase, schema: SPEC_REVIEW_SCHEMA },
    )
    if (!review) break
    if (review.verdict === 'approve') specApproved = true
    else {
      specFeedback = review.required_changes.map((c, i) => `${i + 1}. ${c}`).join('\n')
      log(`${t.id}: spec revision requested (round ${round + 1})`)
    }
  }
  if (!specApproved) {
    results.push({ cluster: t.id, status: 'spec-rejected', detail: specFeedback || 'spec/review agent unavailable' })
    log(`${t.id}: SKIPPED — spec never approved`)
    continue
  }

  // ── Stage 3: tests first (sonnet) ──────────────────────────────────────────
  log(`${t.id}: spec approved — writing failing tests`)
  const tests = await agent(
    `You are the TEST AUTHOR for PR #564 review cluster ${t.id}.

Repo: ${REPO}. Work on the current git branch. Read the APPROVED spec at ${specPath(t.id)} and follow its TEST-FIRST PLAN exactly.

${RULES}

Write ONLY tests (and minimal fixtures/helpers) — no fix code. Run each new test and CONFIRM it fails for the intended reason (the described defect — not a typo/import error you introduced). Pre-existing suites in the touched package must still pass. If deps are missing, run 'bun install' at the repo root only. Then commit with message "test(PR #564 ${t.id}): <what the tests pin> (red)". NEVER push. Also commit the spec file ${specPath(t.id)} if untracked.

If the spec marked a finding not-real/already-fixed, add a regression test that PASSES today pinning the correct behavior instead of a red test. Report which tests are red vs regression-green in notes.

Report test list, red confirmation, and commit SHA via the schema.`,
    { model: 'sonnet', label: `tests:${t.id}`, phase: t.phase, schema: TESTS_SCHEMA },
  )
  if (!tests || !tests.red_confirmed) {
    results.push({ cluster: t.id, status: 'tests-first-failed', detail: tests ? tests.notes || 'red not confirmed' : 'agent unavailable' })
    log(`${t.id}: HALTED — failing tests not established`)
    continue
  }

  // ── Stage 4: implement (sonnet) ────────────────────────────────────────────
  log(`${t.id}: red confirmed — implementing`)
  const impl = await agent(
    `You are the IMPLEMENTER for PR #564 review cluster ${t.id}.

Repo: ${REPO}. Work on the current git branch. Read the APPROVED spec at ${specPath(t.id)} — it is your contract; do not redesign. The failing tests were committed as ${tests.commit}: make them pass without weakening them (editing a test is only allowed for a genuine spec error — record it as a deviation).

${RULES}

Steps:
1. Implement exactly the spec's file-level changes; keep the diff minimal.
2. Make the red tests pass.
3. Run every gate green and record each result:
  - ${gatesFor(t)}
  Pre-existing unrelated failures (root-uid ownership tests in packages/lib in this sandbox; IPv6 '::' bind failures in guardian; Playwright-browser downloads blocked) are "baseline-flake"/"env-blocked" — verify they fail identically on the pre-change commit before claiming that.
4. Update CHANGELOG.md [Unreleased] for any user-visible behavior change; update docs the spec names.
5. Commit in logical units referencing the finding refs. NEVER push.

Report summary, commit SHAs, per-gate status, deviations via the schema.`,
    { model: 'sonnet', label: `impl:${t.id}`, phase: t.phase, schema: IMPL_SCHEMA },
  )
  if (!impl) {
    results.push({ cluster: t.id, status: 'implementation-failed', detail: 'agent unavailable' })
    log(`${t.id}: HALTED — implementation agent failed`)
    continue
  }
  const failedGates = impl.gates.filter((g) => g.status === 'fail')
  if (failedGates.length) {
    results.push({ cluster: t.id, status: 'gates-failed', detail: failedGates.map((g) => `${g.command}: ${g.detail || 'fail'}`).join('; ') })
    log(`${t.id}: HALTED — ${failedGates.length} gate(s) failing`)
    continue
  }

  // ── Stage 5+6: code review gate (opus) + fix loop (sonnet) ────────────────
  let approved = false
  let openFindings = []
  for (let round = 0; round < 3 && !approved; round++) {
    const review = await agent(
      `You are the CODE REVIEWER (gatekeeper) for PR #564 review cluster ${t.id}.

Repo: ${REPO}. Do NOT modify anything. Review ALL work for this cluster: find its commits with \`git log --oneline --grep='${t.id}'\` (test commit ${tests.commit} onward) and inspect the full diff of the touched files. Read the approved spec ${specPath(t.id)}, the brief ${briefPath(t.id)}, and the hard-rule docs.

Judge:
1. Correctness — does each fix actually resolve the reviewer's described failure mode? Try to construct an input that still breaks it. Run targeted tests yourself if suspicious.
2. Completeness — every finding in the brief addressed (fixed or justified as not-real).
3. No regressions — prior branch fixes intact; tests were not weakened to pass (diff test files against ${tests.commit}); reported deviations (${JSON.stringify(impl.deviations || [])}) are justified.
4. Hard rules — security posture, lib-only vs standalone-guardian boundary, no unjustified deps/complexity, $effect ban, .js import extensions, fail-closed auth.

Severity: "blocker" = must not ship; "major" = should fix now; "minor" = note only. Verdict "approve" ONLY with zero blockers and zero majors. Be adversarial but report only findings you verified against the actual diff.`,
      { model: 'opus', effort: 'high', label: `review:${t.id}:r${round}`, phase: t.phase, schema: REVIEW_SCHEMA },
    )
    if (!review) break
    openFindings = review.findings.filter((f) => f.severity !== 'minor')
    if (review.verdict === 'approve') {
      approved = true
      if (review.findings.length) log(`${t.id}: approved with ${review.findings.length} minor note(s)`)
      break
    }
    log(`${t.id}: review round ${round + 1} — ${openFindings.length} blocking finding(s)`)
    if (round === 2) break
    const fix = await agent(
      `You are the FIXER for PR #564 review cluster ${t.id}.

Repo: ${REPO}. Work on the current git branch. The reviewer returned these findings on your cluster's changes (spec: ${specPath(t.id)}):

${JSON.stringify(review.findings, null, 2)}

${RULES}

Fix every blocker and major (minors too if trivial). If a finding is factually wrong, do not churn — explain why under deviations and leave it. Behavior changes get a test FIRST (red) then fix (green); never weaken existing assertions. Re-run all gates green and record results:
  - ${gatesFor(t)}
Commit referencing ${t.id}. NEVER push. Report via the schema.`,
      { model: 'sonnet', label: `fix:${t.id}:r${round}`, phase: t.phase, schema: IMPL_SCHEMA },
    )
    if (!fix) break
    if (fix.gates.filter((g) => g.status === 'fail').length) {
      log(`${t.id}: fix round ${round + 1} left gates failing`)
      break
    }
  }

  results.push({
    cluster: t.id,
    status: approved ? 'done' : 'unresolved-findings',
    detail: approved ? impl.summary : `open: ${openFindings.map((f) => `[${f.severity}] ${f.file}: ${f.summary}`).join(' | ') || 'review agent unavailable'}`,
    deviations: impl.deviations || [],
  })
  log(`${t.id}: ${approved ? 'DONE (review-approved)' : 'FINISHED WITH UNRESOLVED FINDINGS'}`)
}

return {
  note: 'commits are local — review then push from the main session',
  done: results.filter((r) => r.status === 'done').map((r) => r.cluster),
  needsAttention: results.filter((r) => r.status !== 'done'),
  results,
}

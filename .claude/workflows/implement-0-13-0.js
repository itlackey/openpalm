// Implements all open 0.13.0 milestone issues with a gated, test-first pipeline.
//
// Per task: Fable (max effort) writes the implementation spec -> Opus reviews the
// spec (gate) -> Sonnet writes failing tests first (red) -> Sonnet implements
// (green + lint/check gates) -> Opus reviews the diff (gate) -> Sonnet fixes
// findings (<=3 rounds). Tasks run sequentially in dependency order — they share
// one branch and overlapping files.
//
// Commits stay local: the workflow NEVER pushes. Review the final report, then
// push from the main session.
//
// Run:  Workflow({ name: 'implement-0-13-0' })
// Args (optional): { issues: [490, 433] } to run a subset, in the order given.

export const meta = {
  name: 'implement-0-13-0',
  description:
    'Implement all open 0.13.0 milestone issues: fable specs, sonnet test-first implementation, opus review gates',
  whenToUse: 'Executing the 0.13.0 milestone plan in .github/roadmap/0.13.0/implementation-plan.md',
  phases: [
    { title: '#490 channel_lan cleanup' },
    { title: '#433 state-store close-out' },
    { title: '#435 mTLS transport identity' },
    { title: '#488 mDNS responder' },
    { title: '#557 edge TLS + HTTPS enforcement' },
    { title: '#491 standalone portals' },
    { title: '#486 remote-only install' },
    { title: '#511 PWA install paths' },
    { title: '#563 network presets' },
    { title: '#506 design language' },
  ],
}

const REPO = '/home/user/openpalm'
const PLAN = `${REPO}/.github/roadmap/0.13.0/implementation-plan.md`
const briefPath = (n) => `${REPO}/.github/roadmap/0.13.0/assessments/${n}.md`
const specPath = (n) => `${REPO}/.github/roadmap/0.13.0/specs/${n}.md`

// Dependency-ordered tasks. `gates` are the targeted verification commands the
// implementer must run green (plus the common gates) before hand-off to review.
const TASKS = [
  {
    n: 490,
    phase: '#490 channel_lan cleanup',
    title: 'Remove deprecated channel_lan network + CHANNEL_NAME marker (portals rename cleanup)',
    gates: [
      'bun run lib:test',
      'bun test --no-orphans packages/portal-sdk portals/discord portals/slack',
    ],
  },
  {
    n: 433,
    phase: '#433 state-store close-out',
    title: 'Guardian state store close-out: WAL mode, user_version migrations, DELETE endpoint, column-policy decision',
    gates: ['cd packages/guardian && bun test --no-orphans'],
  },
  {
    n: 435,
    phase: '#435 mTLS transport identity',
    title: 'Guardian mTLS adapter transport identity (design note + opt-in TLS config on the direct listener only)',
    gates: ['cd packages/guardian && bun test --no-orphans', 'bun test --no-orphans scripts/'],
  },
  {
    n: 488,
    phase: '#488 mDNS responder',
    title: 'Guardian/assistant LAN mDNS self-advertisement (host control-plane Bun responder in @openpalm/lib)',
    gates: ['bun run lib:test', 'bun run cli:test', 'bun run ui:check'],
  },
  {
    n: 557,
    phase: '#557 edge TLS + HTTPS enforcement',
    title: 'Guardian edge TLS guide + client-side HTTPS refusal for non-loopback plain-HTTP targets',
    gates: [
      'bun run client:build && bun run client:test',
      'cd packages/guardian && bun test --no-orphans',
    ],
  },
  {
    n: 491,
    phase: '#491 standalone portals',
    title: 'Standalone OpenCode-compatible portal packages (OPENCODE_BASE_URL fix, session-reuse fallback, auth UX, branding, bin entrypoints, READMEs)',
    gates: ['bun test --no-orphans packages/portal-sdk portals/discord portals/slack'],
  },
  {
    n: 486,
    phase: '#486 remote-only install',
    title: 'Remote-only (client) install completion: stack-less openpalm app, connection-kind selector, remote-credential provisioning flow',
    gates: ['bun run cli:test', 'bun run client:build && bun run client:test', 'bun run ui:check'],
  },
  {
    n: 511,
    phase: '#511 PWA install paths',
    title: 'PWA install paths: hosted deploy job, runtime contract handshake, pairing UX, clientDisplayMode, install affordances, offline e2e',
    gates: [
      'bun run client:build && bun run client:test',
      'bun run ui:check',
      'bun run electron:test',
    ],
  },
  {
    n: 563,
    phase: '#563 network presets',
    title: 'Network access presets: resolver in lib, SetupSpec + validation, OPENCODE_AUTH plumbing, wizard step, per-preset mDNS, bind-warning rewording',
    gates: ['bun run lib:test', 'bun run cli:test', 'bun run ui:check', 'cd packages/guardian && bun test --no-orphans'],
  },
  {
    n: 506,
    phase: '#506 design language',
    title: 'Reconcile normal-mode routes to the setup-wizard design language (wizard components, /connections restyle in ui+client, chat empty states, documented wiz-* vocabulary)',
    gates: [
      'bun run check',
      'bun run client:build && bun run client:test',
      'bun test --cwd packages/ui-kit',
    ],
  },
]

const COMMON_GATES = ['bun run lint', 'bun run check']

const RULES = `Hard rules (violations are review-blocking):
- Read ${REPO}/AGENTS.md and ${REPO}/docs/technical/core-principles.md before changing anything; also docs/technical/code-quality-principles.md, bunjs-rules.md (Bun services), sveltekit-rules.md (UI).
- No unjustified complexity — call out any you find; prefer Bun/Web built-ins over ANY new dependency.
- Strict TypeScript; never \`any\` for untrusted data; relative imports include .js extension.
- Portable control-plane logic lives ONLY in packages/lib (@openpalm/lib) — never duplicated into CLI/UI.
- @openpalm/client NEVER depends on @openpalm/lib and never holds host credentials (CI purity gate).
- SvelteKit: $effect is treated as a bug; server-only code stays in $lib/server; capabilities via resolveCapabilities()/hasCapability() only; APIs enforce capabilities server-side.
- Secrets are files under knowledge/secrets/ via *_FILE vars; stack.env is non-secret; nothing secret in env defaults or logs.
- Security posture unchanged by default: loopback-default binds, guardian-only portal ingress, fail-closed moderation/auth.
- File assembly, not templating: whole-file writes; user-owned config/ is seed-missing-only.
- ONE lockfile: only \`bun install\` at repo root may mutate bun.lock.
- Work on the CURRENT git branch. Commit with clear messages referencing the issue (e.g. "feat(guardian): ... (#433)"). NEVER push. NEVER create tags or PRs.`

const SPEC_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    test_first_list: { type: 'array', items: { type: 'string' } },
    descoped: { type: 'array', items: { type: 'string' }, description: 'Remaining-work items deliberately descoped, with justification' },
  },
  required: ['summary', 'test_first_list'],
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
    red_confirmed: { type: 'boolean', description: 'Every new test was run and fails for the intended reason' },
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
    deviations: { type: 'array', items: { type: 'string' }, description: 'Any departure from the approved spec, with reason' },
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
  typeof args === 'object' && args && Array.isArray(args.issues) && args.issues.length
    ? args.issues.map((n) => TASKS.find((t) => t.n === n)).filter(Boolean)
    : TASKS

for (const t of selected) {
  phase(t.phase)
  log(`#${t.n}: writing implementation spec`)

  // ── Stage 1+2: spec (fable, max effort) + spec review gate (opus) ──────────
  let specApproved = false
  let specFeedback = ''
  for (let round = 0; round < 3 && !specApproved; round++) {
    const spec = await agent(
      `You are the SPEC AUTHOR for OpenPalm 0.13.0 issue #${t.n}: ${t.title}.

Repo: ${REPO} (git branch: current checkout — do not switch branches).
Read, in order: ${PLAN} (the milestone plan), ${briefPath(t.n)} (codebase-verified assessment: what is ALREADY merged vs the real remaining work — trust it but spot-check key claims against the source), and the rule docs below. Explore the codebase as deeply as you need.

${RULES}

Produce a complete, implementation-ready spec and WRITE IT to ${specPath(t.n)} (create the specs/ directory if needed; overwrite any previous version). Do NOT change any other file. The spec must contain:
1. Scope: exactly which remaining-work items from the assessment this task closes, and which are descoped with justification (descoping needs a real reason — e.g. requires external infrastructure like a hosted deploy target, or the issue itself marks it optional).
2. TEST-FIRST PLAN: the exact list of tests to write BEFORE implementation — file paths, test names, what each asserts, and why it must fail before the implementation exists. Follow the package's existing test idioms (cite the fixture/pattern files to mirror).
3. File-level changes: every file to create/modify with a precise description of the change (function signatures, schema/env names, config keys). Cite existing line references where the assessment provides them.
4. Acceptance mapping: each issue acceptance criterion -> the test or artifact that proves it.
5. Verification gates the implementer must run green:
  - ${gatesFor(t)}
6. Risks and how the design avoids them (from the assessment's risk list).
7. Explicit out-of-scope list.

Keep the spec proportionate — no invented complexity. Where the assessment offers a decision (e.g. option a vs b), DECIDE and record the rationale.${specFeedback ? `\n\nA prior version of this spec was REJECTED by review. Address every required change:\n${specFeedback}` : ''}

Return summary + the test-first list via the schema.`,
      { model: 'fable', effort: 'max', label: `spec:#${t.n}:r${round}`, phase: t.phase, schema: SPEC_SCHEMA },
    )
    if (!spec) break

    const review = await agent(
      `You are the SPEC REVIEWER (gatekeeper) for OpenPalm 0.13.0 issue #${t.n}: ${t.title}.

Repo: ${REPO}. Read the spec at ${specPath(t.n)}, the assessment at ${briefPath(t.n)}, the plan ${PLAN}, and ${REPO}/AGENTS.md + ${REPO}/docs/technical/core-principles.md. Verify the spec against the ACTUAL codebase (read the files it names). Do NOT modify anything.

Approve ONLY if ALL hold:
- Every remaining-work item from the assessment is either covered or explicitly descoped with a defensible reason.
- The test-first plan is real: tests are listed concretely (paths + assertions), would genuinely fail before implementation, and match the package's existing test idioms.
- File-level changes are correct against the current source (spot-check the cited files/lines) and violate no hard rule (security posture, lib-only control plane, client purity, no new deps without justification, $effect ban, secret boundary).
- The verification gates listed are sufficient for the touched packages.
- No invented complexity beyond what the issue needs.

Otherwise return verdict "revise" with specific, actionable required_changes.`,
      { model: 'opus', effort: 'high', label: `spec-review:#${t.n}:r${round}`, phase: t.phase, schema: SPEC_REVIEW_SCHEMA },
    )
    if (!review) break
    if (review.verdict === 'approve') {
      specApproved = true
    } else {
      specFeedback = review.required_changes.map((c, i) => `${i + 1}. ${c}`).join('\n')
      log(`#${t.n}: spec revision requested (round ${round + 1}): ${review.required_changes.length} changes`)
    }
  }
  if (!specApproved) {
    results.push({ issue: t.n, status: 'spec-rejected', detail: specFeedback || 'spec/review agent unavailable' })
    log(`#${t.n}: SKIPPED — spec never approved`)
    continue
  }

  // ── Stage 3: tests first (sonnet) ──────────────────────────────────────────
  log(`#${t.n}: spec approved — writing failing tests`)
  const tests = await agent(
    `You are the TEST AUTHOR for OpenPalm 0.13.0 issue #${t.n}: ${t.title}.

Repo: ${REPO}. Work on the current git branch. Read the APPROVED spec at ${specPath(t.n)} and follow its TEST-FIRST PLAN exactly.

${RULES}

Write ONLY tests (and minimal test fixtures/helpers) — no implementation code. If a test needs an export that does not exist yet, prefer a test that fails at runtime/assertion against the existing surface; only add a placeholder export stub when the spec explicitly says so. Run each new test and CONFIRM it fails for the intended reason (missing behavior — not a typo, import error you introduced, or broken harness). Pre-existing suites must still pass (run the nearest package suite to prove you broke nothing). If bun/npm deps are missing, run 'bun install' at the repo root only.

Then commit the tests with message "test(#${t.n}): <what the tests pin> (red)". NEVER push.

Also commit the spec file ${specPath(t.n)} in the same or a preceding commit if it is untracked.

Report the test list, red confirmation, and commit SHA via the schema. If a spec-listed test genuinely cannot be written first (e.g. requires the built artifact), say so in notes rather than faking it.`,
    { model: 'sonnet', label: `tests:#${t.n}`, phase: t.phase, schema: TESTS_SCHEMA },
  )
  if (!tests || !tests.red_confirmed) {
    results.push({ issue: t.n, status: 'tests-first-failed', detail: tests ? tests.notes || 'red not confirmed' : 'agent unavailable' })
    log(`#${t.n}: HALTED — failing tests not established`)
    continue
  }

  // ── Stage 4: implement (sonnet) ────────────────────────────────────────────
  log(`#${t.n}: red confirmed — implementing`)
  const impl = await agent(
    `You are the IMPLEMENTER for OpenPalm 0.13.0 issue #${t.n}: ${t.title}.

Repo: ${REPO}. Work on the current git branch. Read the APPROVED spec at ${specPath(t.n)} — it is your contract; do not redesign. The failing tests were committed as ${tests.commit} ("red"): make them pass.

${RULES}

Steps:
1. Implement exactly the file-level changes in the spec. If reality forces a deviation, keep it minimal and record it (you will report it; the reviewer will judge it).
2. Make the red tests pass WITHOUT weakening them (editing a test is only allowed for genuine spec errors — record any such edit as a deviation).
3. Run every gate green and record each result:
  - ${gatesFor(t)}
  Pre-existing failures unrelated to your change (e.g. root-uid ownership tests in packages/lib in sandboxes, Playwright-browser downloads blocked) are "baseline-flake"/"env-blocked" — verify they fail identically on the pre-change commit before claiming that.
4. Update CHANGELOG.md [Unreleased] for user-visible changes; update docs the spec names.
5. Commit in logical units with messages referencing #${t.n}. NEVER push.

Report via the schema: summary, commit SHAs, per-gate status, deviations.`,
    { model: 'sonnet', label: `impl:#${t.n}`, phase: t.phase, schema: IMPL_SCHEMA },
  )
  if (!impl) {
    results.push({ issue: t.n, status: 'implementation-failed', detail: 'agent unavailable' })
    log(`#${t.n}: HALTED — implementation agent failed`)
    continue
  }
  const failedGates = impl.gates.filter((g) => g.status === 'fail')
  if (failedGates.length) {
    results.push({ issue: t.n, status: 'gates-failed', detail: failedGates.map((g) => `${g.command}: ${g.detail || 'fail'}`).join('; ') })
    log(`#${t.n}: HALTED — ${failedGates.length} gate(s) failing`)
    continue
  }

  // ── Stage 5+6: code review gate (opus) + fix loop (sonnet) ────────────────
  let approved = false
  let openFindings = []
  for (let round = 0; round < 3 && !approved; round++) {
    const review = await agent(
      `You are the CODE REVIEWER (gatekeeper) for OpenPalm 0.13.0 issue #${t.n}: ${t.title}.

Repo: ${REPO}. Do NOT modify anything. Review ALL work for this issue on the current branch: find its commits with \`git log --oneline --grep='#${t.n}'\` (test commit ${tests.commit} onward) and inspect the full diff (\`git diff <first-commit>^..HEAD -- .\` scoped to the touched files; ignore commits for other issues). Read the approved spec ${specPath(t.n)}, the assessment ${briefPath(t.n)}, and the hard-rule docs (AGENTS.md, docs/technical/core-principles.md, code-quality-principles.md, bunjs-rules.md, sveltekit-rules.md).

Judge:
1. Correctness — real bugs, broken edge cases, failure modes. Run targeted tests yourself if suspicious.
2. Spec fidelity — implements the approved spec; reported deviations (${JSON.stringify(impl.deviations || [])}) are justified; tests were not weakened to pass (diff the test files against commit ${tests.commit}).
3. Acceptance — the issue's acceptance criteria covered per the spec's acceptance mapping.
4. Hard rules — security posture (loopback defaults, secret boundary, fail-closed auth), lib-only control plane, client purity, no unjustified deps/complexity, $effect ban, .js import extensions.
5. Tests — meaningful assertions (not tautologies), package idioms followed.

Severity: "blocker" = must not ship (bug, rule violation, acceptance gap); "major" = should fix now; "minor" = note only. Verdict "approve" ONLY with zero blockers and zero majors. Be adversarial — try to break it — but report only findings you verified against the actual diff.`,
      { model: 'opus', effort: 'high', label: `review:#${t.n}:r${round}`, phase: t.phase, schema: REVIEW_SCHEMA },
    )
    if (!review) break
    openFindings = review.findings.filter((f) => f.severity !== 'minor')
    if (review.verdict === 'approve') {
      approved = true
      if (review.findings.length) log(`#${t.n}: approved with ${review.findings.length} minor note(s)`)
      break
    }
    log(`#${t.n}: review round ${round + 1} — ${openFindings.length} blocking finding(s)`)
    if (round === 2) break
    const fix = await agent(
      `You are the FIXER for OpenPalm 0.13.0 issue #${t.n}: ${t.title}.

Repo: ${REPO}. Work on the current git branch. The code reviewer returned these findings on your team's changes for this issue (spec: ${specPath(t.n)}):

${JSON.stringify(review.findings, null, 2)}

${RULES}

Fix every blocker and major finding (minors too if trivial). If a finding is factually wrong, do not churn code — explain why in your report and leave it. Where a fix changes behavior, extend/adjust tests FIRST (red) then fix (green) — do not weaken existing assertions. Re-run all gates green and record results:
  - ${gatesFor(t)}
Commit with messages referencing #${t.n}. NEVER push. Report via the schema (list disputed findings under deviations).`,
      { model: 'sonnet', label: `fix:#${t.n}:r${round}`, phase: t.phase, schema: IMPL_SCHEMA },
    )
    if (!fix) break
    const fixFailed = fix.gates.filter((g) => g.status === 'fail')
    if (fixFailed.length) {
      log(`#${t.n}: fix round ${round + 1} left gates failing`)
      break
    }
  }

  results.push({
    issue: t.n,
    status: approved ? 'done' : 'unresolved-findings',
    detail: approved
      ? impl.summary
      : `open findings after fix rounds: ${openFindings.map((f) => `[${f.severity}] ${f.file}: ${f.summary}`).join(' | ') || 'review agent unavailable'}`,
    deviations: impl.deviations || [],
  })
  log(`#${t.n}: ${approved ? 'DONE (review-approved)' : 'FINISHED WITH UNRESOLVED FINDINGS — needs human attention'}`)
}

return {
  branch: 'commits are local — review then push from the main session',
  completed: results.filter((r) => r.status === 'done').map((r) => r.issue),
  needsAttention: results.filter((r) => r.status !== 'done'),
  results,
}

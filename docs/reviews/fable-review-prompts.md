# Fable Review Prompts — OpenPalm Foundations

A set of whole-system review prompts for use with a maximum-intelligence model
(e.g. Fable) to audit OpenPalm's most complex and important foundational pieces.

Adapted from Daniel Miessler's
[10 Prompts to Run When Fable Comes Back](https://danielmiessler.com/blog/prompts-to-run-when-fable-comes-back).

## How to use

When the strongest model is available only briefly, spend it on the **expensive,
whole-system reasoning** you can't get from a weaker model — not on line edits.
Each prompt asks the model to read the authoritative docs, reason across the
entire control plane at once, and produce a **prioritized findings list plus a
concrete remediation plan** you can execute later with a cheaper model. Run them
one at a time, in a session with repo access, and have the model write each
result to a file under `docs/reviews/`.

OpenPalm's own foundations map closely onto Miessler's themes: `AGENTS.md`'s
"remove all complexity you cannot justify" is the Bitter Lesson prompt; the
guardian is the prompt-injection surface; `core-principles.md`'s six security
invariants are the attack-surface map.

---

## 1 — Goal-alignment audit

> Read `AGENTS.md` and `docs/technical/core-principles.md` and characterize, in
> your own words, what OpenPalm is fundamentally trying to be: a *thin wrapper
> over Docker Compose and OpenCode*, "convention over configuration," "plain
> files all the way down," tooling as additive convenience rather than required
> infrastructure. Now audit `packages/lib/src/control-plane/` and
> `packages/cli/` against that goal. Find every place where the implementation
> works *against* it — bespoke orchestration that duplicates a native
> Compose/OpenCode feature, config that could be convention, a management path
> that a technical user could not reproduce by hand-editing files under
> `OP_HOME`. Rank findings by how far they pull the project from its stated
> identity, and give a remediation plan for the top ones.

## 2 — Bitter-Lesson / unjustified-complexity audit

> Study Richard Sutton's "The Bitter Lesson" and its application to
> over-engineering in tooling. Then do a full complexity sweep of
> `packages/lib/src/control-plane/` (start with `lifecycle.ts`, `deploy.ts`,
> `config-persistence.ts`, `docker.ts`, `ownership-reconcile.ts`,
> `migrations.ts`). For every non-trivial mechanism, ask: does this hand-code a
> heuristic or reimplement something Docker Compose, Compose profiles/merge, or
> OpenCode config already gives us for free? `AGENTS.md` says: "AVOID AND/OR
> REMOVE ALL COMPLEXITY THAT YOU CANNOT PROPERLY JUSTIFY." Produce a ranked list
> of complexity that cannot be justified, with the simpler general-mechanism
> replacement for each, and flag anything you're unsure about rather than
> dropping it.

## 3 — Guardian ingress & prompt-injection review

> The guardian is OpenPalm's only ingress trust boundary. Map *every* input
> avenue into it and exactly how each is handled: principal authentication
> (`auth.ts`), the `/oc/*` proxy allowlist and ownership checks (`proxy.ts`,
> `ownership.ts`, `proxy-policy`), rate limiting (`rate-limit.ts`), the optional
> fail-closed content-validation stage (`content-screen.ts`, `policy.ts`), the
> MCP gateway (`mcp.ts`), and the OpenAI/Anthropic-compatible edges
> (`openai-api*.ts`). For each, describe the untrusted data it accepts, the
> parsing/validation applied, and the failure mode. Identify where an
> attacker-controlled message could bypass a check, reach the assistant
> unscreened, or exploit fail-open behavior. Then write a long-term hardening
> plan to reduce prompt-injection and auth-bypass exposure across the whole
> guardian.

## 4 — Attack-surface & trust-boundary map

> Produce a complete attack-surface inventory of the running OpenPalm stack.
> Enumerate every ingress surface, host port binding (§ Service port
> assignments), container mount, secret grant, and cross-service trust edge —
> portals -> guardian -> assistant, scheduler co-process, admin host process,
> Docker socket. For each, record: what tech it is, how it authenticates, what
> it trusts, and the common security failure modes for that class of surface.
> Then verify the actual code against all six Security Invariants in
> `core-principles.md` (host-only orchestrator, guardian-only ingress, assistant
> isolation, host-only-by-default, scheduler scoping, admin host-only). Flag
> every place the implementation diverges from an invariant.

## 5 — Secret-boundary & lifecycle audit

> Audit OpenPalm's secret handling end to end against the § Addon secret
> lifecycle and § Secret boundary rules in `core-principles.md`. Read
> `secrets.ts`, `secrets-files.ts`, `secret-mappings.ts`, and the portal secret
> contract. Verify the hard rules: `stack.env` holds no secret-like keys; no
> Compose service uses a broad `env_file` for secrets; every secret reaches a
> container only as a `*_FILE` path via Compose `secrets:`; each service is
> granted *only* the secret files it needs (guardian != portal != assistant);
> per-principal secrets are generated and distributed correctly on addon
> install. Report any leak path, over-broad grant, or `0600` mode gap, and any
> way a secret could land in a log or client bundle.

## 6 — Non-destructive lifecycle & filesystem-contract fidelity

> `core-principles.md` guarantees automatic lifecycle operations *never* clobber
> user files under `config/` or `knowledge/env/user.env`, that config is managed
> by whole-file writes/targeted edits (no template rendering), and that apply
> uses validate-in-place with snapshot rollback. Trace
> install/update/startup-apply/upgrade through `lifecycle.ts`,
> `config-persistence.ts`, `migrations.ts`, and `deploy.ts`. Prove or disprove
> the non-destructive guarantee for each path — pay special attention to the
> layout-migration allowlist (the one path allowed to *remove* files) and the
> `SHIPPED_DEFAULT_HASHES` skip-if-user-modified logic. Verify the rollback
> snapshot scope matches § Rollback scope. Report any path that could overwrite,
> drop, or fail to restore a user file.

## 7 — Thin-harness boundary integrity

> OpenPalm's Electron app is a frozen "thin harness" that must run *zero*
> mutating control-plane logic — all state mutation happens in the
> self-updating `data/ui`. Read § Thin-harness boundary in `core-principles.md`,
> `packages/electron/src/harness-contract.ts`, `packages/electron/src/main.ts`,
> and `scripts/validate-thin-harness-boundary.sh`. Verify: the frozen bundle
> contains none of
> `ensureReleaseMigrated`/`RELEASE_MIGRATIONS`/`performUpgrade`/`applyTagChange`;
> `main.ts` imports only the bootstrap allowlist; the two version lines
> (`PLATFORM_VERSION` vs `HARNESS_CONTRACT_VERSION`) are used correctly and the
> self-update-vs-redownload gate (`minHarnessContract`) is sound. Find any leak
> of mutating logic into the frozen surface, or any change that *should* bump
> the harness contract but the CI guard wouldn't catch.

## 8 — Docs-vs-reality drift audit

> `core-principles.md` and `AGENTS.md` are the authoritative model of how
> OpenPalm works. Systematically compare that model against the actual code and
> find where reality has drifted from the documentation — invariants the docs
> assert that the code no longer enforces, mounts/ports/env vars documented
> differently than implemented, renamed concepts (e.g. channels->portals) left
> half-migrated, or "removed" mechanisms still present. Produce a drift list,
> each entry citing the doc claim and the contradicting code, and recommend
> whether to fix the code or update the doc.

## 9 — Failure-mode & resilience review

> Reason through what happens when OpenPalm's lifecycle operations fail
> *partway*. Read `deploy.ts`, `install-lock.ts`, `retry.ts`,
> `ownership-reconcile.ts`, and the rollback tests. Analyze: interrupted install
> (power loss mid-write), two orchestrators racing (CLI + admin UI), a
> `compose up` that half-succeeds, a health check that flaps, a rollback that
> itself fails, and volume-ownership reconciliation on a partially-migrated home
> dir. For each, state the resulting on-disk state and whether the system
> converges to a recoverable state or wedges. Prioritize the failure modes that
> could leave a user unable to start their stack, and propose the minimal
> guardrails.

## 10 — Foundational-direction review

> 0.12.0 is described as the "stabilization and hardening" release. Given
> everything you now understand about OpenPalm's architecture, identify the
> highest-leverage *foundational* investments for the next release — where
> complexity is quietly accreting, which subsystem is the biggest
> correctness/security risk relative to its test coverage, and which "thin
> wrapper" promises are closest to breaking. Rank by leverage (impact x how
> load-bearing the piece is), and for each give the smallest change that moves
> it. Call out anything that looks like it's growing into required
> infrastructure when it was meant to be optional convenience.

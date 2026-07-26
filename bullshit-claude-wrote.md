# bullshit-claude-wrote.md

Inventory of code, config, docs, tests, and *conventions* that should be deleted
or replaced with something simpler. Everything measured, not guessed.

**Repo totals at `0.13.0-beta.13`:**

| | lines |
|---|---|
| `packages/lib` source | 14,067 |
| `packages/lib` tests | **14,237** |
| `packages/ui` source | 47,413 |
| `packages/ui` tests | 30,879 |
| `packages/cli` source | 2,862 |
| `scripts/` | 4,292 |
| `docs/` | 19,992 (74 files) |
| `.github/roadmap/` | 22,333 (78 files) |

**42,325 lines of prose — three times the entire control plane.** Tests in `lib`
outnumber the code they test.

Running total of what this inventory says to delete: **~19,900 lines.**

---

## 1. Roadmap docs for versions that already shipped — 14,655 lines

| dir | lines | files | status |
|---|---|---|---|
| `0.10.0/` | 10,979 | 33 | shipped |
| `0.11.0/` | 2,971 | 7 | shipped |
| `0.12.0/` | 705 | 2 | shipped |
| `0.13.0/` | 7,156 | 33 | in progress — keep |
| `0.14.0/` | 522 | 3 | future — keep |

**Delete the first three.** Git history has them and nobody will look.

Beyond disk: they are full-text searchable and read as authoritative. Anyone —
human or agent — grepping for how something works finds a plan for how it was
*going* to work three versions ago.

## 2. `docs/technical/` is finished plans wearing a documentation costume — ~11,760 lines

44 files, 12,701 lines. **Exactly three declare themselves authoritative**
(`core-principles.md`, `design-intent.md`, `foundations.md` — 941 lines).

The rest are plans, proposals and reviews sitting in the same directory with the
same apparent weight:

| file | lines | what it is |
|---|---|---|
| `auth-and-proxy-refactor-plan.md` | 702 | a plan |
| `akm-host-assistant-integration-proposal.md` | 698 | a proposal |
| `rootless-containers-migration-plan.md` | 675 | a migration plan |
| `akm-integration-implementation-plan.md` | 503 | a plan |
| `runtime-npm-container-design.md` | 496 | a design |
| `install-update-rebuild-plan.md` | 418 | a plan |
| `local-ai-unified-container-plan.md` | 400 | a plan |
| `deployment-upgrade-ux-review.md` | 352 | a review |
| `akm-and-build-simplification-proposals.md` | 204 | proposals |

**This caused real damage.** These read as current and get built on.
`rootless-containers-migration-plan.md` is being used as a *decision record* — it
holds a signed-off decision about sudo that a later decision contradicts, with
nothing marking which one won.

**Fix:** keep the three authoritative docs and the genuine references
(`environment-and-mounts.md`, `api-spec.md`). Move plans and proposals to
`.github/roadmap/<version>/` where the path states their status, or delete them.
A document describing intent is not documentation of the system.

## 3. `docs/reviews/` — 1,469 lines of completed review cycles

`fable-remediation-plan.md` (631), `fable-security-remediation-plan.md` (390),
`fable-review-prompts.md` (158), `fable-3.3-proposed-release-yml-diff.md` (159),
`upgrade-migration-review-2026-07-06.md` (131).

Same problem as §2, and worse: these are *proposed diffs* and *prompts*. They
describe changes that either landed (making the doc redundant) or did not
(making it misleading). Delete the directory.

## 4. Tests that assert on file *text* instead of behavior — 1,932 lines minimum

`readFileSync` a source file, assert it contains a string. Seventeen files exist
for no other reason:

| file | lines | text asserts |
|---|---|---|
| `lib/control-plane/cleanup-guardrails.test.ts` | 355 | 15 |
| `ui/routes/(app)/chat/chat-frame-source.vitest.ts` | 209 | 67 |
| `ui/routes/(app)/connections/pairing-markup.vitest.ts` | 192 | 63 |
| `scripts/security-posture-doc-drift.test.ts` | 135 | 28 |
| `lib/control-plane/assistant-rootless-entrypoint.test.ts` | 127 | 47 |
| `ui/routes/(app)/advanced/page-coherence.vitest.ts` | 118 | 34 |
| `lib/control-plane/dead-surface-cleanup.test.ts` | 109 | 8 |
| `lib/control-plane/rootless-guardrail-script.test.ts` | 104 | 33 |
| `ui/routes/(app)/chat/page-imports.vitest.ts` | 94 | 7 |
| `ui/routes/(app)/connections/new/onboarding-source.vitest.ts` | 84 | 41 |
| `ui/lib/design-foundation.vitest.ts` | 75 | 18 |
| `lib/control-plane/guardian-rootless-entrypoint.test.ts` | 70 | 6 |
| `ui/lib/components/chrome/ChatNavbar.vitest.ts` | 66 | 29 |
| `lib/control-plane/moderation-doc-contract.test.ts` | 61 | 9 |
| `ui/lib/components/akm/akm-presentation.vitest.ts` | 52 | 16 |
| `lib/control-plane/assistant-rootless.test.ts` | 50 | 10 |
| `ui/lib/components/voice/VoiceClientSettings.source.vitest.ts` | 31 | 8 |

Counting every test file that *mixes in* this style, **10,307 lines** are
affected. The 1,932 above is the subset with no other purpose.

**Worse than no test:**

- **Fail on rewording.** `assistant-rootless-entrypoint.test.ts` asserts the
  shell script contains `'cp "$src" "$dest"'`. Rename a variable → red build,
  behavior unchanged.
- **Pass while broken.** `moderation-doc-contract.test.ts` asserted a docstring's
  strings while that docstring said something factually false about OpenCode.
  Green throughout.
- **Regex over prose.** `security-posture-doc-drift.test.ts` asserts `AGENTS.md`
  does not match `/HMAC-signed/` and `core-principles.md` matches `/3830/`. It
  cannot detect a wrong port, only a missing word.
- **Tombstones.** `dead-surface-cleanup.test.ts` asserts deleted exports are
  still deleted and a removed file is still removed. It can only fail if someone
  deliberately re-adds them.

**Fix:** delete all seventeen. Where one guards something real, replace it with a
behavior test — parse the config and check the resolved value, call the function
and check the result. If the behavior cannot be tested, the guardrail was never
real.

## 5. Shell scripts doing the same thing to build artifacts — ~720 lines

`scripts/validate-thin-harness-boundary.sh` (200) greps
`packages/electron/dist/main.js` for the string `performUpgrade` to "prove" an
architectural boundary, and greps `packages/ui/build/server/chunks/*` to prove
the symbol is present there instead. A symbol name in minified output is not a
boundary; it is a string.

Same family: `validate-registry.sh` (138), `rootless-ownership-smoke.sh` (227),
`rootless-smoke-fixture.sh` (157).

If the invariant is "the harness cannot mutate state", enforce it where it is
real — the harness should not import the module, which is a lint rule or a
dependency-graph check, not a grep of a bundle.

## 6. The "guardrail test" convention itself — the root cause of §4 and §5

The pattern is a house style, visible in the filenames: `*-guardrail*.test.ts`,
`*-doc-contract.test.ts`, `*-drift.test.ts`, `*-coherence.vitest.ts`,
`*-source.vitest.ts`, `*-markup.vitest.ts`, `validate-*.sh`.

The convention says: when something regresses, add a test that greps for the
string that would have caught it. That is how `lib` ends up with 14,237 lines of
test for 14,067 lines of source.

**It does not work.** The four real defects found this week —

- instruction files never loading (relative paths resolved from the wrong dir)
- permission rules matching nothing (`"sudo"` compiling to `^sudo$`)
- `auth.json` losing its inode on every host write
- fresh installs never being stamped, so the first launch re-swapped `system/`

— were caught by **none** of them. Every one is invisible to a string search and
obvious to a behavior test. The convention optimises for the wrong thing. Stop
extending it; delete instances as they are touched.

## 7. A hand-rolled npm client on the host — ~1,020 lines

`ui-assets.ts` (777) + `npm-bundle-updater.ts` (243) resolve a dist-tag, fetch a
registry manifest, download a tarball, verify sha512, extract, stage, back up,
swap, write a version stamp, compare stamps for staleness, and restore on
failure. That is `npm install <pkg>@<version> --prefix <dir>` — which the
assistant's entrypoint does in one line.

**Why it exists (checked):** the CLI is `bun build --compile`'d to a standalone
binary (`packages/cli/package.json:25`), so the host has no npm and no
`node_modules`. Not laziness.

**Why it can still go:** `bun build --compile` embeds files. The skeleton and UI
build are co-released with the CLI — one `PLATFORM_VERSION` drives all three.
Embed them and the fetch/verify/stage/swap half disappears; "update" becomes
"install the new binary", which is already how the CLI updates.

**Cost:** `OP_UI_VERSION` / `OP_SKELETON_VERSION` pin overrides need another
mechanism or go away. This changes release shape, so it needs a decision rather
than just deletion — the only item here that does.

## 8. Version stamp files — a symptom of §7

`.skeleton-version` and `.openpalm-ui-version` are hand-rolled version tracking
for npm packages. npm already writes `package.json` into every installed
package; embedded assets know their version at build time. These files exist
only because the custom client in §7 has nowhere else to record what it
installed — and one of this week's bugs was precisely that a fresh install
forgot to write one. Delete with §7.

---

## Checked, keeping

So nobody re-opens them.

- **`mdns-responder.ts` (537)** — looks like a reimplementation of OpenCode's
  native mDNS. It is not. OpenCode broadcasts from inside the container's network
  namespace; on a bridge network that multicast never reaches the LAN. The
  host-side responder is the only thing that works.
- **`install-lock.ts` (256)** — oversized for a lock, but it also backs the
  `openpalm unlock` command with inspect / force / stale-PID handling.
- **The two-env-file split** (`knowledge/env/stack.env` +
  `state/stack.state.env`) — looks like a hand-rolled merge. It is not: both are
  passed to Compose as `--env-file` flags and Compose does the merging, later
  file winning. Correct use of the tool. The only wart is that the function is
  named `legacyStackEnvFile` while still being the primary file — an unfinished
  rename, not a design problem.
- **`ui/lib/server/docker.ts` (81)** — looks like a duplicate of the control
  plane's `docker.ts` (947). It is a thin re-export that adds preflight
  enforcement.

## 9. Migrations that run on every deploy, forever

Four "migrate legacy X" functions, each invoked on **every deploy path** rather
than once against a recorded schema version:

| function | file |
|---|---|
| `migrateLegacyDefaultPorts` | `config-persistence.ts:65` |
| `migrateLegacyBindAddresses` | `config-persistence.ts:119` |
| `migrateLegacyAccessEnv` | `access-toggles.ts:220` |
| `migrateProfileOnlyAddonEnablement` | `addons.ts:425` |

Call sites include `cli-compose.ts:47-48`, `install.ts:277-278`, and
`port-contract.ts:37` — so every `openpalm` command that touches Compose reads
and rewrites the env files to fix a shape that was retired versions ago.

Nothing retires them. There is no schema version on the home directory, so each
one must run forever on the chance the install predates it. A fresh install
created today still pays for all four, permanently.

**Fix:** put a schema version in `state/` (it is already the app-written record
directory), run migrations once when the recorded version is behind, and delete
migrations older than the supported upgrade floor. Then a fresh install runs
none of them.

This also removes a real footgun: `migrateLegacyDefaultPorts` silently rewrites
port values, which is why `core.compose.yml`'s interpolation fallbacks were able
to sit inverted for so long — the migration hid the inconsistency on every
supported path, and only the manual `docker compose` path saw the truth.

## 10. Conventions in `core-principles.md` that manufacture work

The rules are treated as inviolable (`> Authoritative document. Do not edit
without a specific request`), and two of them cost more than they return.

**"No template rendering — manage configuration by copying whole files and
editing existing configuration files, not by string interpolation or code
generation."** (`core-principles.md:28`)

The intent is sound: a user should be able to read and hand-edit the real files.
But "edit existing files in place" is exactly what forces §9 — every value
change becomes a parse-mutate-rewrite migration instead of regenerating a file
from known inputs. `config-persistence.ts` is 548 lines of that. A generated file
with a "generated, do not edit" header and the inputs recorded next to it is
still readable and hand-editable, and needs no migration when its shape changes.

**"Core assistant extensions are baked into the assistant container and loaded
from a fixed OpenCode config directory."** (`core-principles.md:32`)

Not true, and the drift is load-bearing. Nothing is baked into the image at
`/etc/opencode`; it is a bind mount from `system/assistant`, and the one thing
that *was* baked (the repo-root `AGENTS.md`) was the contributor guide being
served to users as their assistant's global instruction file. The rule describes
a design that was abandoned, and the doc's authoritative framing kept it from
being questioned.

**The wider problem:** `foundations.md`, `design-intent.md` and
`core-principles.md` all open with "Authoritative document. Do not edit without
a specific request to do so, or direct approval." Combined with §2 — 11,760
lines of stale plans in the same directory — the result is that the wrong
documents are hard to change and the misleading ones are indistinguishable from
the right ones.

## 11. Dead and over-exported code in the control plane — 22 symbols

Exported from `packages/lib/src/control-plane/` with **no consumer anywhere**
outside tests:

`resetAvailabilityCache`, `nonSensitiveAddonEnvKeys`, `toDockerResult`,
`isProjectOurs`, `meetsComposeWaitFloor`, `collectComposeEnvOverrides`,
`resolveHome`, `detectRuntimeName`, `parseMarkdownTask`, `startMdnsResponder`,
`parseOllamaHostEnv`, `verifyNpmIntegrity`, `scanComposeForChannelLan`,
`validateSecretName`, `updateSystemSecretsEnv`, `buildOwnerEnvFromSetup`,
`buildAuthJsonFromSetup`, `persistAkmConfig`, `persistPortalCredentials`,
`seedDefaultAutomation`, `readUiBuildVersion`, `resolveChannelRef`.

Two distinct problems:

- **Genuinely dead, kept alive by a test.** `startMdnsResponder` has zero
  internal references and zero callers — its only remaining reason to exist is
  the test that imports it. Deleting the test deletes the function.
- **Over-exported internals.** `verifyNpmIntegrity`, `resolveChannelRef`,
  `parseMarkdownTask` are used only inside their own module. `export` was added
  so a test could reach them. That turns every private helper into public API
  and makes any refactor a breaking change.

**Fix:** delete the dead ones; drop `export` from the internal ones and test them
through the function that actually calls them. Where that is genuinely hard, it
usually means the calling function is doing too much — which is the real finding.

---

## Where to start

Ordered by (lines removed) ÷ (risk), highest first.

| # | item | lines | risk |
|---|---|---|---|
| 1 | Shipped roadmap dirs `0.10/0.11/0.12` | 14,655 | none — `git rm` |
| 3 | `docs/reviews/` | 1,469 | none — `git rm` |
| 2 | Plans/proposals out of `docs/technical/` | ~11,760 | none — move or delete |
| 4 | 17 text-assertion test files | 1,932 | low — they test nothing |
| 5 | Bundle-grep shell validators | ~720 | low — replace with a lint rule |
| 11 | Dead + over-exported symbols | 22 symbols | low — compiler catches mistakes |
| 9 | Migrations → schema version in `state/` | ~200 net | medium — needs the version record first |
| 7 | Embed skeleton + UI in the binary | ~1,020 | **decision** — changes release shape |
| 6 | Stop writing guardrail tests | — | convention change |
| 10 | Fix `core-principles.md` §28 and §32 | — | convention change |

**~30,500 lines** of the ~119,000 in this repo, and the first four rows —
**~29,800 lines** — are pure deletion with no behavior change at all.

The two convention items (§6, §10) matter more than any line count. They are why
the pile keeps growing: the rules reward adding a string-matching test and
forbid regenerating a file, so every fix accretes and none simplify.

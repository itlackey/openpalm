# bullshit-claude-wrote.md

Inventory of code, config, docs, tests, and *conventions* that should be deleted
or replaced with something simpler. Everything measured, not guessed.

Re-verified against the current tree. Everything already resolved has been
pruned. One item remains.

---

## 1. The "guardrail test" convention

The pattern is a house style, visible in the filenames: `*-guardrail*.test.ts`,
`*-doc-contract.test.ts`, `*-drift.test.ts`, `*-coherence.vitest.ts`,
`*-source.vitest.ts`, `*-markup.vitest.ts`, `validate-*.sh`.

The convention says: when something regresses, add a test that greps for the
string that would have caught it. Current instances:
`packages/lib/src/control-plane/skeleton-guardrail.test.ts`,
`packages/electron/test/harness-contract-drift.test.ts`,
`scripts/validate-rootless-guardrails.sh`. `packages/lib` still carries more
lines of test (16,435) than source (16,286).

**It does not work as a regression net.** The four real defects found in the
original pass —

- instruction files never loading (relative paths resolved from the wrong dir)
- permission rules matching nothing (`"sudo"` compiling to `^sudo$`)
- `auth.json` losing its inode on every host write
- fresh installs never being stamped, so the first launch re-swapped `system/`

— were caught by none of the string-matching tests that existed at the time.
Every one was invisible to a string search and obvious to a behavior test.

**Applies going forward, not as a deletion list.** Before adding a new
`*-guardrail*` / `*-drift*` / `validate-*.sh` check, write a behavior test
instead: parse the config and check the resolved value, call the function and
check the result. If the behavior cannot be tested, the guardrail was never
real. Not every file matching these names is bad —
`validate-thin-harness-boundary.sh` is a genuine source-level dependency check.
Read before touching.

---

## Closed since the last pass

**Dead code (§ previous "22 symbols") — resolved, one real deletion.**

`startMdnsResponder` was the only genuinely dead symbol: a five-line wrapper
around `createResponder` that nothing called. `reconcileMdnsResponder` — the
one production entry point — calls `createResponder` directly
(`mdns-responder.ts:517`). Deleted, and its eight tests were rewritten to drive
`reconcileMdnsResponder`, so the record-level coverage (A records, PTR with
SRV/TXT additionals, legacy-unicast routing, TTL-0 goodbyes, error tolerance)
now exercises the path production actually uses. `packages/lib`: 1073 tests
pass.

**The remaining 21 did not survive checking.** Nine had already been fixed
(`nonSensitiveAddonEnvKeys` and `updateSystemSecretsEnv` deleted;
`resolveHome`, `parseMarkdownTask`, `verifyNpmIntegrity`, `validateSecretName`,
`persistPortalCredentials`, `resolveChannelRef`, and `collectComposeEnvOverrides`
already unexported). The other twelve should stay as they are:

- `toDockerResult` has a real cross-package consumer
  (`packages/cli/src/lib/cli-compose.ts`).
- `resetAvailabilityCache` is a necessary test seam — it clears a
  process-lifetime cache so `addons.test.ts` cases don't leak state into each
  other. Its docstring already says "Test-only".
- The other ten (`isProjectOurs`, `meetsComposeWaitFloor`, `detectRuntimeName`,
  `parseOllamaHostEnv`, `scanComposeForChannelLan`, `buildOwnerEnvFromSetup`,
  `buildAuthJsonFromSetup`, `persistAkmConfig`, `seedDefaultAutomation`,
  `readUiBuildVersion`) are pure or self-contained helpers with table-driven
  unit tests — `detectRuntimeName("Server: OrbStack…") === "OrbStack"` is a
  good test. Reaching them through their callers would mean stubbing execFile
  and docker output: strictly more brittle, for no gain.

The premise of the original finding was also wrong. It claimed over-exporting
"turns every private helper into public API and makes any refactor a breaking
change" — but **none of these are in the `@openpalm/lib` barrel**
(`packages/lib/src/index.ts`). The barrel is the public API; these are
module-scope exports reachable only by deep subpath import inside the repo, so
no consumer contract is at stake and no refactor is breaking.

Same lesson as §5/§7/§8 in the original document: a symbol being exported and
only referenced by tests is a hypothesis, not a finding. Ten of twelve here
were load-bearing or correctly tested, and the reason was one file away.

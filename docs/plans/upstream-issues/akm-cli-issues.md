# Upstream issue drafts — `itlackey/akm`

These are ready to paste into <https://github.com/itlackey/akm/issues/new>. Each block has a suggested **title**, a body, and suggested **labels**. Source plan: `docs/plans/simplify-via-akm.md`.

> **Reality-checked against akm-cli 0.7.4 on 2026-05-06.** Most earlier proposals (memory inference, graph extraction, `akm events`, `akm history`, `akm feedback` on `memory:`/`vault:`, scope flags on `akm remember`) **already shipped**. Only the items below remain.

Selection criteria: features useful outside any specific host. Plugin-side asks live in `akm-plugins-issues.md`.

---

## 1. Harness-LLM passthrough hook for `akm index --enrich`

**Title:** Pluggable LLM proxy hook so embedding hosts can lend their provider connection to akm

**Labels:** `enhancement`, `llm`, `index`, `cli`

**Body:**

### Summary
A documented hook that lets a wrapping process (an agent harness, a CI runner, anything) supply an LLM backend to akm without configuring `akm.llm` directly.

### Today
`akm index --enrich` requires an LLM configured at the akm config layer (`akm.llm`). If the host harness — opencode, Claude Code, anything else — already has provider credentials, akm has no way to borrow them. Users either configure providers twice (once for their agent, once for akm) or skip enrichment.

### Proposal
A documented hook akm consults when no native `akm.llm` is configured:

- New env var `AKM_LLM_PROXY_CMD=<path-to-shim>` (and/or config key `akm.llm.proxy = "<path>"`).
- akm spawns the shim once per LLM call, sending a JSON request on stdin (model, messages, temperature, etc.) and reading a JSON response from stdout.
- Same JSON envelope conventions as the rest of akm.
- The shim is the host's responsibility — akm just defines the contract.

### Why CLI, not plugin
The contract has to live in akm so any harness (opencode, Claude Code, anything new) can implement the shim half. Without it, every harness reinvents wiring.

### Acceptance
- [ ] Documented JSON request / response shape.
- [ ] When `AKM_LLM_PROXY_CMD` is set and no `akm.llm` is configured, `akm index --enrich` uses the proxy.
- [ ] Native `akm.llm` config takes precedence over the proxy when both are set.
- [ ] Proxy failures surface clearly (don't silently degrade enrichment).

### Pairs with
A matching shim implementation in `itlackey/akm-plugins/opencode/` and `itlackey/akm-plugins/claude/` (filed as separate issues there).

---

## 2. Pluggable secret backends and rotation for `akm vault` *(future consideration)*

**Title:** Pluggable secret backends + rotation for `akm vault`

**Labels:** `enhancement`, `vault`, `discussion`

**Body:**

> Status: deferred / future consideration. Filed so the design is captured; not a near-term commitment. Tracks #190.

### Summary
Make `akm vault` a credible production secret store rather than a developer-laptop convenience.

### Today
Vault is `.env`-style files only; no rotation, no remote secret-manager integration.

### Proposal
A backend interface with built-in adapters and hooks for external managers:
- Built-in: OS keychain, age-encrypted files.
- External hooks: `pass`, 1Password CLI, AWS / GCP Secrets Manager, HashiCorp Vault.
- Rotation: `akm vault rotate <key>` (re-keys + re-encrypts in place).
- Backend selection: `akm vault backend set <name>`.

### Why
Production deployments need rotation and centralised secret management. Today users either pick `akm vault` and accept dev-only semantics or shell out to a different secret manager entirely.

### Acceptance (when picked up)
- [ ] Backend interface defined with at least one built-in alternative to `.env`.
- [ ] Rotation is atomic (no readers see a half-rotated key).
- [ ] Existing `.env` vaults migrate without breaking refs.

---

## 3. Bug: scope-flag inconsistency across `remember` / `search` / `show`

**Title:** Scope flag shape differs between `akm remember` and `akm search` / `akm show`

**Labels:** `bug`, `scoping`, `cli`, `dx`

**Body:**

### Summary
`akm remember` accepts direct scope flags (`--user`, `--agent`, `--run`, `--channel`); `akm search` requires `--filter <key>=<value>` and `akm show` requires `--scope <key>=<value>`. The asymmetry is undocumented and silently breaks integrations that assume a uniform shape.

### Repro
```sh
akm remember "test" --user alice                   # works
akm search "test" --user alice                     # unknown flag (or silently ignored, depending on argv parser)
akm show memory:<ref> --user alice                 # same
akm search "test" --filter user=alice              # works
akm show memory:<ref> --scope user=alice           # works
```

### Source pointers
- `src/commands/remember.ts` — direct flags.
- `src/commands/search.ts` — `parseScopeFilterFlags()` consuming `--filter <k>=<v>`.
- `src/commands/show.ts` — `--scope <k>=<v>`.

### Why this matters
The `akm-opencode` plugin uses a single `buildScopedArgs()` helper that pushes `--user`, `--agent`, etc. into argv for `remember`, `search`, **and** `show`. As a result, scope filtering on plugin-issued `search` / `show` calls silently fails today. Fixing the CLI fixes the plugin without a plugin release.

### Suggested fix
Pick one of:
- (a) Accept both shapes on all three verbs (probably easiest — direct flags translate internally to the filter shape).
- (b) Standardise on direct flags everywhere (simpler to use, harder for users with existing `--filter` callers).
- (c) Just document the asymmetry prominently; leave shapes alone.

### Acceptance
- [ ] All three verbs accept the same scope-flag shape, OR the asymmetry is called out in `docs/cli.md` with examples per verb.
- [ ] The akm-opencode plugin's `buildScopedArgs()` helper works against `search` / `show` after the fix (this can be verified in CI by spawning the CLI).

---

## Already shipped — no longer proposed

For maintainer reference, the following appeared in earlier drafts and have since landed:

- **`akm index --enrich`** (0.7.3) — covers metadata enrichment, memory inference, graph extraction.
- **`akm events list|tail`** (0.7.x) — durable `events.jsonl` with `--since`/`--type`/`--ref` and byte-offset cursors.
- **`akm history --include-proposals`** (0.7.x) — per-asset and stash-wide history.
- **`akm feedback`** accepting `memory:` and `vault:` refs (0.7.x).
- **Scope flags on `akm remember`** (`--user`, `--agent`, `--run`, `--channel`).
- **`akm proposal | reflect | propose | distill`** verbs (0.7.0) — write-staging queue and reflection workflow.
- **`lesson` asset type** (0.7.0).

## Explicitly **not** proposed

- **`akm serve` / any HTTP daemon** — the CLI is the only programmatic surface.
- **`akm workflow schedule` / cron triggers** — scheduling stays in the host.

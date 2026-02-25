# Rec 4 — Fix `bunfig.toml`: enforce frozen installs globally

## Problem

`bunfig.toml:6` sets `frozen = false`. This means any local `bun install` invocation —
by a developer or by a new CI step that omits `--frozen-lockfile` — silently resolves
packages from the registry and may write an updated `bun.lock`, producing
non-reproducible installs and masking lock-file drift.

Every CI workflow that calls `bun install` already passes `--frozen-lockfile` explicitly.
The `bunfig.toml` flag adds no safety at the CI layer; it only creates risk at the
developer layer.

## The change

**File:** `bunfig.toml`

| Line | Current value | New value |
|------|--------------|-----------|
| 6    | `frozen = false` | `frozen = true` |

Diff:

```diff
 [install]
 # Ensure reproducible installs
-frozen = false
+frozen = true
```

No other files need to change.

## CI workflow audit — all steps already pass `--frozen-lockfile`

The flag on the CLI overrides `bunfig.toml`, so existing CI behaviour is unchanged after
setting `frozen = true`. The table below lists every `bun install` invocation found
across all ten workflow files.

| Workflow file | Job / step | Line | Flag present? |
|---|---|---|---|
| `.github/workflows/test.yml` | `unit` | 19 | `--frozen-lockfile` |
| `.github/workflows/test-ui.yml` | `playwright` | 23 | `--frozen-lockfile` |
| `.github/workflows/release.yml` | `unit-tests` | 66 | `--frozen-lockfile` |
| `.github/workflows/release.yml` | `integration` | 76 | `--frozen-lockfile` |
| `.github/workflows/release.yml` | `contracts` | 85 | `--frozen-lockfile` |
| `.github/workflows/release.yml` | `security` | 94 | `--frozen-lockfile` |
| `.github/workflows/release.yml` | `release` / Install dependencies | 188 | `--frozen-lockfile` |
| `.github/workflows/publish-cli.yml` | `test` | 29 | `--frozen-lockfile` |
| `.github/workflows/publish-cli.yml` | `publish-npm` | 48 | `--frozen-lockfile` |
| `.github/workflows/publish-cli.yml` | `build-binaries` (matrix) | 147 | `--frozen-lockfile` |
| `.github/workflows/version-bump-pr.yml` | `create-pr` / Install dependencies | 70 | `--frozen-lockfile` |

Workflows that do **not** call `bun install` at all (no regression possible):

- `.github/workflows/publish-images.yml` — Docker-only, no Bun install step
- `.github/workflows/update-registry-index.yml` — shell + `jq` only, no Bun install step
- `.github/workflows/update-snippet-index.yml` — calls `bun dev/scripts/rebuild-snippet-index.js` directly without a prior `bun install`; Bun resolves the script from the checked-out workspace without installing
- `.github/workflows/validate-registry.yml` — shell + `jq` only, no Bun install step
- `.github/workflows/validate-snippets.yml` — shell + `yq` only, no Bun install step

**Conclusion:** Every CI `bun install` already carries `--frozen-lockfile`. Setting
`frozen = true` in `bunfig.toml` is a no-op for CI and purely a safety net for local
development.

## Edge cases for local development

### Adding a new dependency

With `frozen = true`, a plain `bun install` will fail if `bun.lock` does not already
reflect the requested packages. Developers need to use one of:

```bash
# Preferred — adds the package, updates bun.lock automatically
bun add <package>
bun add -d <package>          # dev dependency

# Acceptable — installs without the frozen constraint
bun install --no-frozen-lockfile
```

`bun add` internally performs an unfrozen install and updates `bun.lock`, so it is
unaffected by the `frozen` setting. This is the correct workflow for adding dependencies
and should be documented.

### Switching branches that have lock-file differences

If a developer checks out a branch where `bun.lock` differs from the working tree
dependencies (e.g., after a rebase or `git pull`), a plain `bun install` will error.
The fix is the same: `bun install --no-frozen-lockfile` to reconcile, then commit the
updated `bun.lock`.

### Running `bun install` in Docker builds

None of the Dockerfiles in this repo run `bun install` — they copy the source and use
`bun build` or `bun run` directly. This is not affected.

## Documentation that needs updating

### `dev/docs/development-workflow.md` — line 5

The first step in the "Boot a local dev environment" section is a bare `bun install`:

```
## 1) Boot a local dev environment
bun install          ← line 5
```

With `frozen = true` this will succeed on a clean checkout (lock file is committed and
consistent), but will fail if the developer has modified `package.json` before running
it. The line should be updated to note that `bun add <pkg>` is the correct way to
introduce new dependencies, or kept as-is with an explanatory note.

Recommended update:

```markdown
## 1) Boot a local dev environment
```bash
bun install          # installs from the committed lock file
bun run dev:setup
bun run dev:build
```

> To add a new dependency use `bun add <package>` instead of editing `package.json`
> directly, so that `bun.lock` is updated in the same step.
```

### `CONTRIBUTING.md`

`CONTRIBUTING.md` does not mention `bun install` directly (its quick-start section goes
straight to `bun run dev:setup`). No changes are strictly required, but the same note
about `bun add` vs. `bun install` could be added to the "Local development" section for
discoverability.

No other user-facing docs (`docs/*.md`) reference `bun install`.

## File references

| File | Relevant content | Line(s) |
|---|---|---|
| `bunfig.toml` | `frozen = false` — the line to change | 6 |
| `.github/workflows/test.yml` | `bun install --frozen-lockfile` | 19 |
| `.github/workflows/test-ui.yml` | `bun install --frozen-lockfile` | 23 |
| `.github/workflows/release.yml` | `bun install --frozen-lockfile` (unit-tests job) | 66 |
| `.github/workflows/release.yml` | `bun install --frozen-lockfile` (integration job) | 76 |
| `.github/workflows/release.yml` | `bun install --frozen-lockfile` (contracts job) | 85 |
| `.github/workflows/release.yml` | `bun install --frozen-lockfile` (security job) | 94 |
| `.github/workflows/release.yml` | `bun install --frozen-lockfile` (release job) | 188 |
| `.github/workflows/publish-cli.yml` | `bun install --frozen-lockfile` (test job) | 29 |
| `.github/workflows/publish-cli.yml` | `bun install --frozen-lockfile` (publish-npm job) | 48 |
| `.github/workflows/publish-cli.yml` | `bun install --frozen-lockfile` (build-binaries matrix) | 147 |
| `.github/workflows/version-bump-pr.yml` | `bun install --frozen-lockfile` (create-pr job) | 70 |
| `dev/docs/development-workflow.md` | Bare `bun install` in quick-start — should note `bun add` workflow | 5 |

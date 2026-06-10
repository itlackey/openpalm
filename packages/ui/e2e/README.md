# e2e directory

## TL;DR

**On-demand full-stack e2e** — spin up an isolated stack and run all browser tests in one command:

```bash
./scripts/dev-e2e-test.sh --skip-build --playwright
```

Unit/integration coverage (~1130 tests, no Docker required):
- `packages/ui/src/**/*.vitest.ts` — SvelteKit routes + server modules (mocked lib)
- `packages/lib/src/**/*.test.ts` — control-plane logic
- `packages/cli/src/*.test.ts`, `packages/channels-sdk/src/*.test.ts`, `core/guardian/src/*.test.ts`

## File conventions

### `*.pw.ts` — self-contained Playwright tests (default suite)

Collected by `testMatch: '*.pw.ts'`. Run via `bun run ui:test:e2e`.
Must pass with no live stack and no host-side env vars.

The only current file is `_placeholder.pw.ts` — exists so `npx playwright test`
doesn't exit non-zero with "no tests found". Replace it when a genuinely
self-contained browser test is added.

### `*.stack.ts` — stack integration tests (isolated environment)

Collected by Playwright **only** when `RUN_DOCKER_STACK_TESTS=1`. Require a
running isolated stack (managed by `dev-e2e-test.sh --playwright`). Each file
guards itself with `test.skip(!process.env.RUN_DOCKER_STACK_TESTS, ...)`.

Current stack tests:

| File | What it covers |
|------|---------------|
| `admin-health.stack.ts` | `/admin/health` auth + `/admin/providers` with live assistant + guardian liveness via proxy |
| `opencode-ui.stack.ts` | OpenCode web UI reachability on assistant port |
| `setup-wizard-api.stack.ts` | Full wizard API contract: reset → system-check → POST /complete → deploy poll |
| `setup-wizard-browser.stack.ts` | Wizard browser rendering: System Check step loads, Continue works |
| `chat-ui.stack.ts` | Chat page renders, message input accepts text, send button enabled |
| `install-flow.stack.ts` | Wizard walk-through to Review step; Install button present and enabled |
| `auth-boundary.stack.ts` | All critical admin endpoints: 401 without auth, 401 wrong cookie, 200 valid cookie |
| `secrets.stack.ts` | Vault CRUD: POST key → GET confirms in list → DELETE → GET confirms gone; input validation |
| `admin-panel-browser.stack.ts` | Browser smoke: Overview containers, Logs tab, Connections tab, Secrets tab; no raw error text |

Run all stack tests via the composite script:

```bash
# First time (builds UI + images from source, ~5 min):
./scripts/dev-e2e-test.sh --playwright

# Subsequent runs (reuses built images, ~60s):
./scripts/dev-e2e-test.sh --skip-build --playwright
```

Or run a single file against an already-running isolated stack:

```bash
RUN_DOCKER_STACK_TESTS=1 \
  ADMIN_URL=http://127.0.0.1:3890 \
  OP_HOME=.dev-e2e \
  OP_UI_LOGIN_PASSWORD=<token> \
  npm --prefix packages/ui run test:e2e -- e2e/chat-ui.stack.ts
```

### `*.manual.ts` — human-operated smoke checks

NOT collected by Playwright (neither `*.pw.ts` nor `*.stack.ts`). Scripts that
require special operator setup beyond the isolated stack (real voice hardware,
channel credentials, AKM stash configuration, etc.).

Current manual-only files: `voice.manual.ts`, `channel-guardian-pipeline.manual.ts`,
`scheduler.manual.ts`, `akm-config.manual.ts`.

## Wizard UX gate capture

The setup wizard has a dedicated UX audit config for the three-judge gate:

```bash
cd packages/ui
npm run ux:audit:wizard
```

It captures the full wizard sweep needed for review evidence: System Check,
Get Started, Providers (recommended + manual card-expanded), Models, Voice,
Options, and the real Review screen.

Repo-local guard coverage for this config lives in
`e2e/ux-audit.wizard.config.vitest.ts`, which now runs as part of
`npm run test:unit` / `bun run ui:test:unit` so config regressions fail fast
without needing the external audit runner.

The capture command itself still depends on the external AKM `web-ux`
`ux-dom-audit` skill at `${AKM_HOME:-$HOME/akm}/skills/web-ux/...`; if that
runner or its downstream judging/evidence pipeline is unavailable, that is an
external blocker rather than a missing repo-local wiring issue.

## Isolation guarantees

`dev-e2e-test.sh` creates a completely isolated environment:

- `COMPOSE_PROJECT_NAME=openpalm-e2e` — never touches user's running stack
- `OP_E2E_HOME=.dev-e2e` — never touches `.dev/` or `~/.openpalm/`
- Ports: UI=3890, assistant=3891, voice=8187 — offset from dev (9100/4800/9180)
- Cleanup trap removes containers + `.dev-e2e/` on exit (unless `--keep`)

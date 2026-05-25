# e2e directory

## TL;DR

There are currently **no automated browser tests** in this project.
Every stack-dependent script has been moved out of the default
Playwright suite (renamed `.pw.ts` → `.manual.ts`).

Real automated coverage lives in the vitest / bun-test suites:
- `packages/ui/src/**/*.vitest.ts` — SvelteKit route + server-module
  tests with `@openpalm/lib` mocked
- `packages/lib/src/**/*.test.ts` — control-plane logic
- `packages/cli/src/*.test.ts`, `packages/channels-sdk/src/*.test.ts`,
  `core/guardian/src/*.test.ts`

Together: ~1130 tests, run anywhere, no docker required, no
operator-provisioned environment.

## File conventions in this directory

### `*.pw.ts` — Playwright tests (default suite)

Collected by Playwright's default `testMatch: '*.pw.ts'`. Run via
`bun run ui:test:e2e`. **Must be self-contained** — no live stack,
no host-side env required to pass.

Today the only file matching is `_placeholder.pw.ts`, which exists
solely to keep `npx playwright test` from exiting non-zero with
"no tests found". When someone adds a genuinely self-contained
browser test (mocked docker, fixture data) it should be a new
`*.pw.ts` file and the placeholder can be deleted.

### `*.manual.ts` — scripted smoke checks for humans

NOT picked up by the default Playwright run. Reference scripts an
operator invokes by hand before a release to prove the live stack
actually works end-to-end (compose pull/up, real Docker daemon,
real openpalm-voice container, etc.). They are explicitly NOT
automated tests — they require the operator to provision the
preconditions (running dev stack on known ports, standalone UI
server listening on `ADMIN_URL`, sometimes a built voice image
cached locally).

Run a specific manual smoke:

```
cd packages/ui
RUN_DOCKER_STACK_TESTS=1 \
  OP_HOME=$(realpath ../../.dev) \
  OP_UI_LOGIN_PASSWORD=<password> \
  ADMIN_URL=http://localhost:9100 \
  npx playwright test e2e/setup-wizard-api.manual.ts
```

The header comment in each `.manual.ts` file describes its
preconditions and what it covers.

## Why the split

Automated tests should run anywhere with no operator setup. A test
that says "first manually start a Docker stack, then point this at
the right URL, then check the right env" is a scripted manual QA
checklist wearing a test framework — useful, but not a test.

Migrating each `.manual.ts` to a self-contained `.pw.ts` (or
absorbing its contract into vitest) is good follow-up work; the
rename surfaces the gap honestly rather than papering over it with
a `RUN_DOCKER_STACK_TESTS=1` gate that made the suite green-ish in
the default path while actually skipping every test.

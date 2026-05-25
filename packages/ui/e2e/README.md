# e2e directory

Two different file conventions in this directory:

## `*.pw.ts` — Playwright tests (default suite)

Collected by Playwright's default `testMatch: '*.pw.ts'`. These run as
part of `bun run ui:test:e2e` and gate on `RUN_DOCKER_STACK_TESTS=1` so
CI / lint runs skip them cleanly.

> **Today these files still require a running dev stack to actually
> pass** (legacy pattern). Treat their `RUN_DOCKER_STACK_TESTS=1` gate
> as documentation that they're stack-dependent — they should
> eventually migrate to be self-contained, either by mocking
> `@openpalm/lib` calls via vitest or by adopting `testcontainers`. The
> contract coverage they provide is largely duplicated by the
> `*.vitest.ts` route tests in `src/routes/admin/**/server.vitest.ts`.

## `*.manual.ts` — scripted smoke checks for humans

NOT picked up by the default Playwright run. These are reference
scripts an operator invokes by hand before a release to prove the live
stack actually works end-to-end (compose pull/up, real Docker daemon,
real openpalm-voice container, etc.). They are explicitly NOT
automated tests — they require the operator to provision the
preconditions (running dev stack on known ports, standalone UI server
listening on `ADMIN_URL`, sometimes a built voice image cached
locally).

Run a specific manual smoke:

```
cd packages/ui
RUN_DOCKER_STACK_TESTS=1 \
  OP_HOME=$(realpath ../../.dev) \
  OP_UI_LOGIN_PASSWORD=<password> \
  ADMIN_URL=http://localhost:9100 \
  npx playwright test e2e/setup-wizard-api.manual.ts
```

The header comment in each `.manual.ts` file describes its preconditions.

## Why the split

Automated tests should run anywhere with no operator setup. A test
that says "first manually start a Docker stack, then point this at
the right URL, then check the right env" is a scripted manual QA
checklist wearing a test framework — useful, but not a test.

Route-behavior coverage (compose orchestration, error translation,
env resolution) lives in `src/routes/**/server.vitest.ts` with
`@openpalm/lib` mocked. That's the real automated layer. The
`.manual.ts` files exist to verify the actual compose + docker
integration on demand.

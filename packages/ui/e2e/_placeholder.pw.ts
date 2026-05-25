/**
 * Placeholder so `npx playwright test` doesn't exit non-zero with
 * "No tests found" when every other file in this directory has been
 * intentionally renamed to `.manual.ts`.
 *
 * Real automated coverage of UI routes, lib helpers, CLI commands,
 * SDK, and guardian lives in the vitest / bun-test suites — those
 * exercise the same code paths without docker, without a live stack,
 * and without any operator-provisioned environment. See `e2e/README.md`
 * for the `.pw.ts` vs `.manual.ts` convention.
 *
 * If a future automated browser test is genuinely self-contained
 * (mocks docker via `@openpalm/lib` mocks, no real stack required),
 * add it as a new `*.pw.ts` file and delete this placeholder.
 */
import { test, expect } from '@playwright/test';

test('Playwright runner is wired (placeholder — see e2e/README.md)', () => {
  expect(1 + 1).toBe(2);
});

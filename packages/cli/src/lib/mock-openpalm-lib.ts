/**
 * Test-only helper (#690). Bun's `mock.module()` replaces the shared module
 * record for a specifier — including every OTHER specifier (bare or
 * relative) that resolves to the same file — and `mock.restore()` does NOT
 * undo it. A whole-module mock of `@openpalm/lib` left in place by one test
 * file therefore leaks into every later test file sharing the same `bun
 * test` process.
 *
 * Call `restoreRealOpenPalmLib()` from an `afterEach` (and/or `beforeEach`)
 * in any file that calls `mock.module('@openpalm/lib', ...)`, so the shared
 * registry is always pointed back at the real module before the next test —
 * in this file or another — runs.
 */
import { mock } from 'bun:test';
import * as realOpenPalmLib from '@openpalm/lib';

export function restoreRealOpenPalmLib(): void {
	mock.module('@openpalm/lib', () => ({ ...realOpenPalmLib }));
}

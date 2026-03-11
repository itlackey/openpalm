/**
 * Console error guard for browser component tests.
 *
 * Captures all console.error/console.warn calls and uncaught exceptions
 * during a test, then fails the test if any were detected. This ensures
 * that Svelte runtime errors (like TDZ violations) and other JS console
 * errors are caught by the test suite.
 *
 * Usage:
 *   import { useConsoleGuard } from '$lib/test-utils/console-guard';
 *   const guard = useConsoleGuard();
 *   // ... render component, interact ...
 *   guard.expectNoErrors();
 */
import { expect } from 'vitest';

export interface ConsoleGuard {
	/** Assert that no console errors or uncaught exceptions occurred. */
	expectNoErrors: () => void;
	/** Assert that no console warnings occurred. */
	expectNoWarnings: () => void;
	/** Return captured errors (for custom assertions). */
	getErrors: () => string[];
	/** Return captured warnings (for custom assertions). */
	getWarnings: () => string[];
	/** Cleanup — call in afterEach if not using the auto-cleanup pattern. */
	cleanup: () => void;
}

/**
 * Install console error/warning monitoring for the current test.
 * Call at the start of each test (or in beforeEach).
 */
export function useConsoleGuard(): ConsoleGuard {
	const errors: string[] = [];
	const warnings: string[] = [];

	const originalError = console.error;
	const originalWarn = console.warn;

	console.error = (...args: unknown[]) => {
		errors.push(args.map(String).join(' '));
		originalError.apply(console, args);
	};

	console.warn = (...args: unknown[]) => {
		warnings.push(args.map(String).join(' '));
		originalWarn.apply(console, args);
	};

	const errorHandler = (event: ErrorEvent) => {
		errors.push(`Uncaught: ${event.message}`);
	};

	const rejectionHandler = (event: PromiseRejectionEvent) => {
		errors.push(`Unhandled rejection: ${event.reason}`);
	};

	if (typeof window !== 'undefined') {
		window.addEventListener('error', errorHandler);
		window.addEventListener('unhandledrejection', rejectionHandler);
	}

	function cleanup(): void {
		console.error = originalError;
		console.warn = originalWarn;
		if (typeof window !== 'undefined') {
			window.removeEventListener('error', errorHandler);
			window.removeEventListener('unhandledrejection', rejectionHandler);
		}
	}

	return {
		expectNoErrors() {
			cleanup();
			if (errors.length > 0) {
				expect.fail(
					`${errors.length} console error(s) detected during test:\n` +
						errors.map((e, i) => `  ${i + 1}. ${e}`).join('\n')
				);
			}
			// One assertion to satisfy requireAssertions
			expect(errors).toHaveLength(0);
		},

		expectNoWarnings() {
			if (warnings.length > 0) {
				expect.fail(
					`${warnings.length} console warning(s) detected during test:\n` +
						warnings.map((w, i) => `  ${i + 1}. ${w}`).join('\n')
				);
			}
		},

		getErrors: () => [...errors],
		getWarnings: () => [...warnings],
		cleanup
	};
}

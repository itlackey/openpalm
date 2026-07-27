import { describe, expect, test } from 'vitest';
import {
	ACTIVATION_VETO,
	beginConnectionActivation,
	connectionActivationInProgress,
	emitConnectionActivated,
	onConnectionActivated
} from './connection-events.js';

describe('connection activation coordination', () => {
	test('tracks overlapping activation work until every operation releases', () => {
		const releaseFirst = beginConnectionActivation();
		const releaseSecond = beginConnectionActivation();
		expect(connectionActivationInProgress()).toBe(true);

		releaseFirst();
		expect(connectionActivationInProgress()).toBe(true);
		releaseFirst();
		expect(connectionActivationInProgress()).toBe(true);

		releaseSecond();
		expect(connectionActivationInProgress()).toBe(false);
	});

	test('propagates an activation listener refusal via the explicit veto sentinel', async () => {
		const unsubscribe = onConnectionActivated(() => ACTIVATION_VETO);
		try {
			await expect(emitConnectionActivated('beta')).rejects.toThrow(/refused/i);
		} finally {
			unsubscribe();
		}
	});

	test('a listener returning plain `false` does NOT veto activation (U1)', async () => {
		// Only the explicit ACTIVATION_VETO sentinel refuses activation — a
		// bare `false` (e.g. from a predicate-style listener) must not
		// silently abort it.
		// biome-ignore lint/suspicious/noConfusingVoidType: matching ActivationListener's own return type (see connection-events.ts).
		const unsubscribe = onConnectionActivated(() => false as unknown as void);
		try {
			await expect(emitConnectionActivated('beta')).resolves.toBeUndefined();
		} finally {
			unsubscribe();
		}
	});
});

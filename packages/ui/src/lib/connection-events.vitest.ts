import { describe, expect, test } from 'vitest';
import {
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

	test('propagates an activation listener refusal', async () => {
		const unsubscribe = onConnectionActivated(() => false);
		try {
			await expect(emitConnectionActivated('beta')).rejects.toThrow(/refused/i);
		} finally {
			unsubscribe();
		}
	});
});

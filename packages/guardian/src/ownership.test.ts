import { beforeEach, describe, expect, it } from 'bun:test';
import {
	_resetOwnershipForTest,
	OWNERSHIP_MAX_ENTRIES,
	permissionOwnerCount,
	recordPermissionOwner,
	recordSessionOwner,
	sessionOwnerCount
} from './ownership.ts';

const principal = { id: 'portal', kind: 'portal' as const, userId: 'user' };

beforeEach(() => {
	_resetOwnershipForTest();
});

describe('ownership resource bounds', () => {
	it('caps session and permission ownership maps', () => {
		for (let i = 0; i <= OWNERSHIP_MAX_ENTRIES; i++) {
			recordSessionOwner(`session-${i}`, principal);
			recordPermissionOwner(`permission-${i}`, principal);
		}
		expect(sessionOwnerCount()).toBe(OWNERSHIP_MAX_ENTRIES);
		expect(permissionOwnerCount()).toBe(OWNERSHIP_MAX_ENTRIES);
	});
});

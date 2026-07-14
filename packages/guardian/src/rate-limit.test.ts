import { beforeEach, describe, expect, it } from 'bun:test';
import {
	_rateLimiterSizesForTest,
	_resetRateLimitersForTest,
	activeRateLimiters,
	allow,
	allowPreAuth,
	PREAUTH_RATE_LIMIT,
	RATE_LIMIT_MAX_BUCKETS
} from './rate-limit.ts';

beforeEach(() => {
	_resetRateLimitersForTest();
});

describe('guardian fixed-window rate limiting', () => {
	it('rejects requests after a bucket reaches its limit', () => {
		expect(allow('user:test', 2, 60_000)).toBe(true);
		expect(allow('user:test', 2, 60_000)).toBe(true);
		expect(allow('user:test', 2, 60_000)).toBe(false);
	});

	it('applies a separate pre-auth source-IP budget', () => {
		for (let i = 0; i < PREAUTH_RATE_LIMIT; i++) {
			expect(allowPreAuth('192.0.2.10')).toBe(true);
		}
		expect(allowPreAuth('192.0.2.10')).toBe(false);
		expect(allowPreAuth('192.0.2.11')).toBe(true);
	});

	it('hard-caps attacker-controlled bucket keys', () => {
		for (let i = 0; i <= RATE_LIMIT_MAX_BUCKETS; i++) {
			expect(allow(`user:${i}`, 1, 60_000)).toBe(true);
			expect(allowPreAuth(`198.51.100.${i}`)).toBe(true);
		}
		expect(_rateLimiterSizesForTest()).toEqual({
			authenticated: RATE_LIMIT_MAX_BUCKETS,
			preAuth: RATE_LIMIT_MAX_BUCKETS
		});
	});

	it('reports active user and portal buckets separately', () => {
		allow('user:a', 2, 60_000);
		allow('user:b', 2, 60_000);
		allow('portal:a', 2, 60_000);
		expect(activeRateLimiters()).toEqual({
			activeUserLimiters: 2,
			activePortalLimiters: 1
		});
	});
});

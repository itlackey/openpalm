type Bucket = {
	start: number;
	count: number;
	windowMs: number;
};

export const USER_RATE_LIMIT = 120;
export const USER_RATE_WINDOW_MS = 60_000;
export const PORTAL_RATE_LIMIT = 200;
export const PORTAL_RATE_WINDOW_MS = 60_000;
export const PREAUTH_RATE_LIMIT = 600;
export const PREAUTH_RATE_WINDOW_MS = 60_000;
export const RATE_LIMIT_MAX_BUCKETS = 10_000;

const authenticatedBuckets = new Map<string, Bucket>();
const preAuthBuckets = new Map<string, Bucket>();

function pruneExpired(buckets: Map<string, Bucket>, now: number): void {
	for (const [key, bucket] of buckets) {
		if (now - bucket.start >= bucket.windowMs) buckets.delete(key);
	}
}

function allowInWindow(
	buckets: Map<string, Bucket>,
	key: string,
	limit: number,
	windowMs: number,
	now = Date.now()
): boolean {
	const current = buckets.get(key);
	if (current && now - current.start < current.windowMs) {
		if (current.count >= limit) return false;
		current.count += 1;
		return true;
	}

	if (!current && buckets.size >= RATE_LIMIT_MAX_BUCKETS) pruneExpired(buckets, now);
	if (!current && buckets.size >= RATE_LIMIT_MAX_BUCKETS) {
		const oldest = buckets.keys().next().value;
		if (oldest !== undefined) buckets.delete(oldest);
	}
	buckets.set(key, { start: now, count: 1, windowMs });
	return true;
}

export function allow(key: string, limit: number, windowMs: number): boolean {
	return allowInWindow(authenticatedBuckets, key, limit, windowMs);
}

export function allowPreAuth(clientIp: string): boolean {
	if (!clientIp) return true;
	return allowInWindow(
		preAuthBuckets,
		`ip:${clientIp}`,
		PREAUTH_RATE_LIMIT,
		PREAUTH_RATE_WINDOW_MS
	);
}

export function activeRateLimiters(): {
	activeUserLimiters: number;
	activePortalLimiters: number;
} {
	const now = Date.now();
	pruneExpired(authenticatedBuckets, now);
	let activeUserLimiters = 0;
	let activePortalLimiters = 0;
	for (const key of authenticatedBuckets.keys()) {
		if (key.startsWith('user:')) activeUserLimiters += 1;
		else if (key.startsWith('portal:')) activePortalLimiters += 1;
	}
	return { activeUserLimiters, activePortalLimiters };
}

export function _resetRateLimitersForTest(): void {
	authenticatedBuckets.clear();
	preAuthBuckets.clear();
}

export function _rateLimiterSizesForTest(): { authenticated: number; preAuth: number } {
	return { authenticated: authenticatedBuckets.size, preAuth: preAuthBuckets.size };
}

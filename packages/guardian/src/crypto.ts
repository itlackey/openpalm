import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string comparison via the stdlib primitive.
 *
 * `timingSafeEqual` requires equal-length buffers, so both inputs are hashed to
 * fixed-length (32-byte) SHA-256 digests first — that keeps the comparison
 * constant-time AND avoids leaking either secret's length through an early
 * length-mismatch return.
 *
 * This is the single shared implementation for Guardian bearer credentials and
 * signed conversation handles.
 */
export function constantTimeEqual(a: string, b: string): boolean {
	const ha = createHash('sha256').update(a, 'utf8').digest();
	const hb = createHash('sha256').update(b, 'utf8').digest();
	return timingSafeEqual(ha, hb);
}

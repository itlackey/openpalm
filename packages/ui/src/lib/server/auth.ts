import { timingSafeEqual } from 'node:crypto';
import { ADMIN_TOKEN, DEFAULT_INSECURE_TOKEN } from './config.ts';

export function verifyAdminToken(token: string): boolean {
	if (ADMIN_TOKEN === DEFAULT_INSECURE_TOKEN) return false;
	if (token.length !== ADMIN_TOKEN.length) return false;
	return timingSafeEqual(Buffer.from(token, 'utf8'), Buffer.from(ADMIN_TOKEN, 'utf8'));
}

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

import { constantTimeEqual } from './crypto.js';
import { isCredentialId, type CredentialClass } from './credentials.js';

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,256}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,512}$/;
const HANDLE_PREFIX = 'op2';
const HANDLE_AAD = Buffer.from('openpalm-guardian-handle-v2', 'utf8');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_JOB_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_INTERACTION_TTL_MS = 60 * 60 * 1_000;

type BasePayload = {
	v: 2;
	principal: CredentialClass;
	expiresAt: number;
};

type SessionPayload = BasePayload & {
	kind: 'session';
	sessionId: string;
};

type MessagePayload = BasePayload & {
	kind: 'message';
	sessionId: string;
	messageId: string;
};

export type JobPayload = BasePayload & {
	kind: 'job';
	sessionId: string;
	startedAt: number;
	messageId: string;
};

export type InteractionKind = 'permission' | 'question';

export type InteractionPayload = BasePayload & {
	kind: 'interaction';
	sessionId: string;
	requestId: string;
	interaction: InteractionKind;
};

type HandlePayload = SessionPayload | MessagePayload | JobPayload | InteractionPayload;

export type HandleError =
	| 'invalid_handle'
	| 'expired_handle'
	| 'wrong_principal'
	| 'wrong_handle_kind';

export type HandleResult<T> = { ok: true; value: T } | { ok: false; error: HandleError };

export type ConversationResult =
	| { ok: true; sessionId: string }
	| { ok: false; error: 'invalid_conversation' | 'expired_conversation' | 'wrong_principal' };

export type GuardianOwnership = {
	v: 1;
	principal: CredentialClass;
	proof: string;
};

function encryptionKey(secret: string): Buffer {
	return createHash('sha256')
		.update('openpalm-guardian-handle-key\0', 'utf8')
		.update(secret, 'utf8')
		.digest();
}

function ownershipProof(sessionId: string, principal: CredentialClass, secret: string): string {
	return createHmac('sha256', secret)
		.update('openpalm-guardian-session-owner\0', 'utf8')
		.update(principal, 'utf8')
		.update('\0', 'utf8')
		.update(sessionId, 'utf8')
		.digest('base64url');
}

function validExpiry(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function seal(payload: HandlePayload, secret: string): string {
	if (!secret) throw new Error('Guardian handle key is unavailable');
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
	cipher.setAAD(HANDLE_AAD);
	const ciphertext = Buffer.concat([
		cipher.update(JSON.stringify(payload), 'utf8'),
		cipher.final()
	]);
	const tag = cipher.getAuthTag();
	return `${HANDLE_PREFIX}.${Buffer.concat([iv, tag, ciphertext]).toString('base64url')}`;
}

function payloadShape(value: unknown): HandlePayload | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const candidate = value as Partial<HandlePayload>;
	if (
		candidate.v !== 2 ||
		!isCredentialId(candidate.principal) ||
		!validExpiry(candidate.expiresAt) ||
		typeof candidate.sessionId !== 'string' ||
		!SESSION_ID_RE.test(candidate.sessionId)
	) {
		return null;
	}
	if (candidate.kind === 'session') return candidate as SessionPayload;
	if (
		candidate.kind === 'message' &&
		typeof candidate.messageId === 'string' &&
		REQUEST_ID_RE.test(candidate.messageId)
	) {
		return candidate as MessagePayload;
	}
	if (
		candidate.kind === 'job' &&
		typeof candidate.startedAt === 'number' &&
		Number.isSafeInteger(candidate.startedAt) &&
		candidate.startedAt > 0 &&
		typeof candidate.messageId === 'string' &&
		REQUEST_ID_RE.test(candidate.messageId)
	) {
		return candidate as JobPayload;
	}
	if (
		candidate.kind === 'interaction' &&
		typeof candidate.requestId === 'string' &&
		REQUEST_ID_RE.test(candidate.requestId) &&
		(candidate.interaction === 'permission' || candidate.interaction === 'question')
	) {
		return candidate as InteractionPayload;
	}
	return null;
}

function open(
	handle: string,
	principal: CredentialClass,
	secret: string,
	now: number
): HandleResult<HandlePayload> {
	if (!secret || handle.length > 4_096) return { ok: false, error: 'invalid_handle' };
	const [prefix, encoded, extra] = handle.split('.');
	if (prefix !== HANDLE_PREFIX || !encoded || extra) return { ok: false, error: 'invalid_handle' };

	let payload: HandlePayload | null = null;
	try {
		const raw = Buffer.from(encoded, 'base64url');
		if (raw.length <= IV_BYTES + TAG_BYTES) return { ok: false, error: 'invalid_handle' };
		const iv = raw.subarray(0, IV_BYTES);
		const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
		const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);
		const decipher = createDecipheriv('aes-256-gcm', encryptionKey(secret), iv);
		decipher.setAAD(HANDLE_AAD);
		decipher.setAuthTag(tag);
		const cleartext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
			'utf8'
		);
		payload = payloadShape(JSON.parse(cleartext));
	} catch {
		return { ok: false, error: 'invalid_handle' };
	}
	if (!payload) return { ok: false, error: 'invalid_handle' };
	if (payload.principal !== principal) return { ok: false, error: 'wrong_principal' };
	if (payload.expiresAt <= now) return { ok: false, error: 'expired_handle' };
	return { ok: true, value: payload };
}

function readKind<T extends HandlePayload['kind']>(
	handle: string,
	kind: T,
	principal: CredentialClass,
	secret: string,
	now = Date.now()
): HandleResult<Extract<HandlePayload, { kind: T }>> {
	const result = open(handle, principal, secret, now);
	if (!result.ok) return result;
	if (result.value.kind !== kind) return { ok: false, error: 'wrong_handle_kind' };
	return { ok: true, value: result.value as Extract<HandlePayload, { kind: T }> };
}

function readLegacySessionHandle(
	handle: string,
	principal: CredentialClass,
	secret: string,
	now: number
): HandleResult<{ sessionId: string }> {
	if (!secret || handle.length > 4_096) return { ok: false, error: 'invalid_handle' };
	const [encoded, supplied, extra] = handle.split('.');
	if (!encoded || !supplied || extra) return { ok: false, error: 'invalid_handle' };
	const expected = createHmac('sha256', secret).update(encoded).digest('base64url');
	if (!constantTimeEqual(supplied, expected)) return { ok: false, error: 'invalid_handle' };
	let value: unknown;
	try {
		value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
	} catch {
		return { ok: false, error: 'invalid_handle' };
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return { ok: false, error: 'invalid_handle' };
	}
	const payload = value as {
		v?: unknown;
		principal?: unknown;
		sessionId?: unknown;
		expiresAt?: unknown;
	};
	if (
		payload.v !== 1 ||
		typeof payload.sessionId !== 'string' ||
		!SESSION_ID_RE.test(payload.sessionId) ||
		!validExpiry(payload.expiresAt)
	) {
		return { ok: false, error: 'invalid_handle' };
	}
	if (payload.principal !== principal) return { ok: false, error: 'wrong_principal' };
	if (payload.expiresAt <= now) return { ok: false, error: 'expired_handle' };
	return { ok: true, value: { sessionId: payload.sessionId } };
}

export function createSessionHandle(
	sessionId: string,
	principal: CredentialClass,
	secret: string,
	now = Date.now(),
	ttlMs = DEFAULT_SESSION_TTL_MS
): string {
	if (!SESSION_ID_RE.test(sessionId)) throw new Error('invalid assistant session id');
	return seal({ v: 2, kind: 'session', principal, sessionId, expiresAt: now + ttlMs }, secret);
}

export function readSessionHandle(
	handle: string,
	principal: CredentialClass,
	secret: string,
	now = Date.now()
): HandleResult<{ sessionId: string }> {
	if (!handle.startsWith(`${HANDLE_PREFIX}.`)) {
		return readLegacySessionHandle(handle, principal, secret, now);
	}
	const result = readKind(handle, 'session', principal, secret, now);
	return result.ok ? { ok: true, value: { sessionId: result.value.sessionId } } : result;
}

export function createMessageHandle(
	input: { sessionId: string; messageId: string },
	principal: CredentialClass,
	secret: string,
	now = Date.now(),
	ttlMs = DEFAULT_SESSION_TTL_MS
): string {
	if (!SESSION_ID_RE.test(input.sessionId) || !REQUEST_ID_RE.test(input.messageId)) {
		throw new Error('invalid message identity');
	}
	return seal(
		{
			v: 2,
			kind: 'message',
			principal,
			sessionId: input.sessionId,
			messageId: input.messageId,
			expiresAt: now + ttlMs
		},
		secret
	);
}

export function readMessageHandle(
	handle: string,
	principal: CredentialClass,
	secret: string,
	now = Date.now()
): HandleResult<{ sessionId: string; messageId: string }> {
	const result = readKind(handle, 'message', principal, secret, now);
	return result.ok
		? {
				ok: true,
				value: { sessionId: result.value.sessionId, messageId: result.value.messageId }
			}
		: result;
}

export function createJobHandle(
	input: {
		sessionId: string;
		startedAt: number;
		messageId: string;
	},
	principal: CredentialClass,
	secret: string,
	now = Date.now(),
	ttlMs = DEFAULT_JOB_TTL_MS
): string {
	if (!SESSION_ID_RE.test(input.sessionId)) throw new Error('invalid assistant session id');
	if (!Number.isSafeInteger(input.startedAt) || input.startedAt <= 0) {
		throw new Error('invalid job start time');
	}
	if (!REQUEST_ID_RE.test(input.messageId)) {
		throw new Error('invalid job message id');
	}
	return seal(
		{
			v: 2,
			kind: 'job',
			principal,
			sessionId: input.sessionId,
			startedAt: input.startedAt,
			messageId: input.messageId,
			expiresAt: now + ttlMs
		},
		secret
	);
}

export function readJobHandle(
	handle: string,
	principal: CredentialClass,
	secret: string,
	now = Date.now()
): HandleResult<Omit<JobPayload, 'v' | 'kind' | 'principal' | 'expiresAt'>> {
	const result = readKind(handle, 'job', principal, secret, now);
	if (!result.ok) return result;
	return {
		ok: true,
		value: {
			sessionId: result.value.sessionId,
			startedAt: result.value.startedAt,
			messageId: result.value.messageId
		}
	};
}

export function createInteractionHandle(
	input: { sessionId: string; requestId: string; interaction: InteractionKind },
	principal: CredentialClass,
	secret: string,
	now = Date.now(),
	ttlMs = DEFAULT_INTERACTION_TTL_MS
): string {
	if (!SESSION_ID_RE.test(input.sessionId) || !REQUEST_ID_RE.test(input.requestId)) {
		throw new Error('invalid interaction identity');
	}
	return seal(
		{
			v: 2,
			kind: 'interaction',
			principal,
			sessionId: input.sessionId,
			requestId: input.requestId,
			interaction: input.interaction,
			expiresAt: now + ttlMs
		},
		secret
	);
}

export function readInteractionHandle(
	handle: string,
	principal: CredentialClass,
	secret: string,
	now = Date.now()
): HandleResult<Omit<InteractionPayload, 'v' | 'kind' | 'principal' | 'expiresAt'>> {
	const result = readKind(handle, 'interaction', principal, secret, now);
	if (!result.ok) return result;
	return {
		ok: true,
		value: {
			sessionId: result.value.sessionId,
			requestId: result.value.requestId,
			interaction: result.value.interaction
		}
	};
}

export function createGuardianOwnership(
	sessionId: string,
	principal: CredentialClass,
	secret: string
): GuardianOwnership {
	if (!secret || !SESSION_ID_RE.test(sessionId)) throw new Error('invalid ownership input');
	return { v: 1, principal, proof: ownershipProof(sessionId, principal, secret) };
}

export function hasGuardianOwnership(
	metadata: Record<string, unknown> | undefined,
	sessionId: string,
	principal: CredentialClass,
	secret: string
): boolean {
	if (!secret || !metadata) return false;
	const value = metadata.openpalmGuardian;
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const candidate = value as Partial<GuardianOwnership>;
	return (
		candidate.v === 1 &&
		candidate.principal === principal &&
		typeof candidate.proof === 'string' &&
		constantTimeEqual(candidate.proof, ownershipProof(sessionId, principal, secret))
	);
}

// Compatibility names keep existing Portal conversation rows usable at the API
// boundary while newly issued values use encrypted session handles.
export function createConversationHandle(
	sessionId: string,
	principal: CredentialClass,
	secret: string,
	now = Date.now(),
	ttlMs = DEFAULT_SESSION_TTL_MS
): string {
	return createSessionHandle(sessionId, principal, secret, now, ttlMs);
}

export function readConversationHandle(
	handle: string,
	principal: CredentialClass,
	secret: string,
	now = Date.now()
): ConversationResult {
	const result = readSessionHandle(handle, principal, secret, now);
	if (result.ok) return { ok: true, sessionId: result.value.sessionId };
	if (result.error === 'expired_handle') return { ok: false, error: 'expired_conversation' };
	if (result.error === 'wrong_principal') return { ok: false, error: 'wrong_principal' };
	return { ok: false, error: 'invalid_conversation' };
}

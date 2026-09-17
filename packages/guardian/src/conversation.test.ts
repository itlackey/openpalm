import { describe, expect, it } from 'bun:test';
import { createHmac } from 'node:crypto';

import {
	createConversationHandle,
	createGuardianOwnership,
	createInteractionHandle,
	createJobHandle,
	createMessageHandle,
	hasGuardianOwnership,
	readConversationHandle,
	readInteractionHandle,
	readJobHandle,
	readMessageHandle
} from './conversation.ts';

describe('opaque Guardian handles', () => {
	it('round trips within the credential class', () => {
		const principal = `cred_${'a'.repeat(32)}`;
		const handle = createConversationHandle('ses_abc', principal, 'secret', 100, 1_000);
		expect(readConversationHandle(handle, principal, 'secret', 200)).toEqual({
			ok: true,
			sessionId: 'ses_abc'
		});
	});

	it('rejects tampering, expiry, and cross-token reuse', () => {
		const handle = createConversationHandle('ses_abc', 'discord', 'secret', 100, 1_000);
		expect(readConversationHandle(`${handle}x`, 'discord', 'secret', 200)).toEqual({
			ok: false,
			error: 'invalid_conversation'
		});
		expect(readConversationHandle(handle, 'slack', 'secret', 200)).toEqual({
			ok: false,
			error: 'wrong_principal'
		});
		expect(readConversationHandle(handle, 'discord', 'secret', 1_100)).toEqual({
			ok: false,
			error: 'expired_conversation'
		});
	});

	it('encrypts job and interaction identity and enforces handle kind', () => {
		const job = createJobHandle(
			{
				sessionId: 'ses_abc',
				startedAt: 100,
				messageId: 'msg_request'
			},
			'owner',
			'secret',
			100,
			1_000
		);
		expect(job).not.toContain('ses_abc');
		expect(readJobHandle(job, 'owner', 'secret', 200)).toMatchObject({
			ok: true,
			value: {
				sessionId: 'ses_abc',
				startedAt: 100,
				messageId: 'msg_request'
			}
		});
		expect(readInteractionHandle(job, 'owner', 'secret', 200)).toEqual({
			ok: false,
			error: 'wrong_handle_kind'
		});

		const message = createMessageHandle(
			{ sessionId: 'ses_abc', messageId: 'msg_abc' },
			'owner',
			'secret',
			100,
			1_000
		);
		expect(message).not.toContain('msg_abc');
		expect(readMessageHandle(message, 'owner', 'secret', 200)).toMatchObject({
			ok: true,
			value: { sessionId: 'ses_abc', messageId: 'msg_abc' }
		});

		const interaction = createInteractionHandle(
			{ sessionId: 'ses_abc', requestId: 'question_1', interaction: 'question' },
			'owner',
			'secret',
			100,
			1_000
		);
		expect(interaction).not.toContain('question_1');
		expect(readInteractionHandle(interaction, 'owner', 'secret', 200)).toMatchObject({
			ok: true,
			value: { requestId: 'question_1', interaction: 'question' }
		});
	});

	it('binds session ownership metadata to both session and principal', () => {
		const ownership = createGuardianOwnership('ses_abc', 'owner', 'secret');
		const metadata = { openpalmGuardian: ownership };
		expect(hasGuardianOwnership(metadata, 'ses_abc', 'owner', 'secret')).toBe(true);
		expect(hasGuardianOwnership(metadata, 'ses_other', 'owner', 'secret')).toBe(false);
		expect(hasGuardianOwnership(metadata, 'ses_abc', 'discord', 'secret')).toBe(false);
	});

	it('accepts an authentic legacy session handle during migration', () => {
		const encoded = Buffer.from(
			JSON.stringify({
				v: 1,
				principal: 'owner',
				sessionId: 'ses_legacy',
				expiresAt: 2_000
			}),
			'utf8'
		).toString('base64url');
		const signature = createHmac('sha256', 'secret').update(encoded).digest('base64url');
		expect(readConversationHandle(`${encoded}.${signature}`, 'owner', 'secret', 1_000)).toEqual({
			ok: true,
			sessionId: 'ses_legacy'
		});
	});
});

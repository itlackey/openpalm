import { expect, test } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Channel -> Guardian -> Assistant Full-Chain Integration Tests
 *
 * Exercises the COMPLETE message flow that real channel adapters use:
 *   1. Build a ChannelPayload (userId, channel, text, nonce, timestamp)
 *   2. HMAC-SHA256 sign it with the channel secret
 *   3. POST to guardian /channel/inbound (via gateway proxy)
 *   4. Guardian verifies HMAC, checks nonce/replay, checks rate limit
 *   5. Guardian forwards to the assistant (OpenCode)
 *   6. Response flows back: assistant -> guardian -> test client
 *
 * This closes the test coverage gap where assistant-pipeline.test.ts talks
 * to OpenCode directly (bypassing guardian) and server.test.ts uses a mock
 * assistant (never hitting the real one).
 *
 * Prerequisites:
 *   - Running compose stack (RUN_DOCKER_STACK_TESTS=1)
 *   - LLM provider configured for message tests (RUN_LLM_TESTS=1)
 *
 * Run with:
 *   RUN_DOCKER_STACK_TESTS=1 bun run admin:test:e2e
 *   RUN_DOCKER_STACK_TESTS=1 RUN_LLM_TESTS=1 bun run admin:test:e2e
 */

// ── Config ───────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const STACK_ENV_PATH = resolve(REPO_ROOT, '.dev/vault/stack/stack.env');

/**
 * Guardian URL: Gateway proxies /guardian/* to guardian:8080 (stripping prefix).
 * The ingress port defaults to 8080 via OP_INGRESS_PORT in stack.env.
 */
const GATEWAY_BASE = `http://localhost:${process.env.OP_INGRESS_PORT ?? '8080'}`;
const GUARDIAN_URL = `${GATEWAY_BASE}/guardian`;

const TEST_CHANNEL = 'e2etest';
const TEST_SECRET = `e2e-test-secret-${Date.now()}`;

// ── HMAC helpers (pure Node.js — no Bun dependency) ─────────────────────

function signPayload(secret: string, body: string): string {
	return createHmac('sha256', secret).update(body).digest('hex');
}

function makePayload(overrides: Record<string, unknown> = {}) {
	return {
		userId: `e2e-user-${Date.now()}`,
		channel: TEST_CHANNEL,
		text: 'hello from e2e channel test',
		nonce: randomUUID(),
		timestamp: Date.now(),
		...overrides
	};
}

// ── Stack.env secret management ─────────────────────────────────────────

let originalStackEnv: string | null = null;

/**
 * Seeds CHANNEL_E2ETEST_SECRET into stack.env so the guardian can verify
 * our test messages. The guardian re-reads the file on each request
 * (via GUARDIAN_SECRETS_PATH), so no container restart is needed.
 *
 * IMPORTANT: Uses appendFileSync (not writeFileSync) to preserve the
 * same inode. Docker bind mounts track the inode — if the admin container
 * did an atomic write (temp+rename) to stack.env, a writeFileSync here
 * would create yet another inode, invisible to the guardian container.
 * Appending modifies the existing file in-place, keeping the inode.
 */
function seedTestSecret(): boolean {
	try {
		originalStackEnv = readFileSync(STACK_ENV_PATH, 'utf8');
		const secretLine = `CHANNEL_E2ETEST_SECRET=${TEST_SECRET}`;
		if (originalStackEnv.includes('CHANNEL_E2ETEST_SECRET=')) {
			// Replace existing — must rewrite, but use truncate+write to keep inode
			const fd = require('node:fs').openSync(STACK_ENV_PATH, 'r+');
			const updated = originalStackEnv.replace(
				/^CHANNEL_E2ETEST_SECRET=.*$/m,
				secretLine
			);
			require('node:fs').ftruncateSync(fd, 0);
			require('node:fs').writeSync(fd, updated, 0);
			require('node:fs').closeSync(fd);
		} else {
			// Append in-place — preserves inode
			appendFileSync(STACK_ENV_PATH, '\n' + secretLine + '\n');
		}
		return true;
	} catch {
		return false;
	}
}

function restoreStackEnv(): void {
	if (originalStackEnv !== null) {
		try {
			// Truncate+write to preserve inode (Docker bind mount compatibility)
			const fd = require('node:fs').openSync(STACK_ENV_PATH, 'r+');
			require('node:fs').ftruncateSync(fd, 0);
			require('node:fs').writeSync(fd, originalStackEnv, 0);
			require('node:fs').closeSync(fd);
		} catch {
			// Best-effort restore
		}
	}
}

// ── Tests ────────────────────────────────────────────────────────────────

test.describe('Channel -> Guardian -> Assistant Pipeline', () => {
	const SKIP = !process.env.RUN_DOCKER_STACK_TESTS;
	test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running compose stack');

	let secretSeeded = false;

	test.beforeAll(() => {
		secretSeeded = seedTestSecret();
	});

	test.afterAll(() => {
		restoreStackEnv();
	});

	// ── Group 1: Guardian reachability (no LLM needed) ──────────────

	test('guardian health check responds via gateway proxy', async ({ request }) => {
		const res = await request.get(`${GUARDIAN_URL}/health`, { timeout: 10_000 });
		expect(res.ok(), `Guardian health check failed: ${res.status()}`).toBeTruthy();
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.service).toBe('guardian');
	});

	test('test channel secret is seeded in stack.env', () => {
		expect(secretSeeded).toBe(true);
	});

	// ── Group 2: HMAC verification (no LLM needed) ──────────────────

	test('valid HMAC-signed message is accepted by guardian', async ({ request }) => {
		test.skip(!secretSeeded, 'Could not seed test secret');
		test.setTimeout(130_000);

		const payload = makePayload();
		const body = JSON.stringify(payload);
		const signature = signPayload(TEST_SECRET, body);

		const res = await request.post(`${GUARDIAN_URL}/channel/inbound`, {
			headers: {
				'content-type': 'application/json',
				'x-channel-signature': signature
			},
			data: body,
			timeout: 125_000
		});

		// Guardian should accept the message. If assistant is unavailable we get 502,
		// but the HMAC verification itself passed (would be 403 otherwise).
		expect(
			[200, 502].includes(res.status()),
			`Expected 200 (success) or 502 (assistant unavailable), got ${res.status()}: ${await res.text()}`
		).toBeTruthy();

		if (res.status() === 200) {
			const data = await res.json();
			expect(data.userId).toBe(payload.userId);
			expect(typeof data.sessionId).toBe('string');
			expect(typeof data.answer).toBe('string');
			expect(data.answer.length).toBeGreaterThan(0);
		}
	});

	test('invalid HMAC signature is rejected with 403', async ({ request }) => {
		test.skip(!secretSeeded, 'Could not seed test secret');

		const payload = makePayload();
		const body = JSON.stringify(payload);

		const res = await request.post(`${GUARDIAN_URL}/channel/inbound`, {
			headers: {
				'content-type': 'application/json',
				'x-channel-signature': 'deadbeef0000111122223333444455556666777788889999aaaabbbbccccdddd'
			},
			data: body,
			timeout: 10_000
		});

		expect(res.status()).toBe(403);
		const data = await res.json();
		expect(data.error).toBe('invalid_signature');
	});

	test('missing signature header is rejected with 403', async ({ request }) => {
		test.skip(!secretSeeded, 'Could not seed test secret');

		const payload = makePayload();

		const res = await request.post(`${GUARDIAN_URL}/channel/inbound`, {
			headers: { 'content-type': 'application/json' },
			data: JSON.stringify(payload),
			timeout: 10_000
		});

		expect(res.status()).toBe(403);
		const data = await res.json();
		expect(data.error).toBe('invalid_signature');
	});

	// ── Group 3: Nonce replay protection (no LLM needed) ───────────

	test('replayed nonce is rejected with 409', async ({ request }) => {
		test.skip(!secretSeeded, 'Could not seed test secret');
		test.setTimeout(130_000);

		const nonce = randomUUID();
		const payload1 = makePayload({ nonce });
		const body1 = JSON.stringify(payload1);
		const sig1 = signPayload(TEST_SECRET, body1);

		// First request should succeed (or 502 if assistant is down)
		const res1 = await request.post(`${GUARDIAN_URL}/channel/inbound`, {
			headers: {
				'content-type': 'application/json',
				'x-channel-signature': sig1
			},
			data: body1,
			timeout: 125_000
		});
		expect(
			[200, 502].includes(res1.status()),
			`First request: expected 200 or 502, got ${res1.status()}`
		).toBeTruthy();

		// Second request with same nonce should be rejected as replay
		const payload2 = makePayload({ nonce, userId: payload1.userId });
		const body2 = JSON.stringify(payload2);
		const sig2 = signPayload(TEST_SECRET, body2);

		const res2 = await request.post(`${GUARDIAN_URL}/channel/inbound`, {
			headers: {
				'content-type': 'application/json',
				'x-channel-signature': sig2
			},
			data: body2,
			timeout: 10_000
		});
		expect(res2.status()).toBe(409);
		const data = await res2.json();
		expect(data.error).toBe('replay_detected');
	});

	test('expired timestamp is rejected with 409', async ({ request }) => {
		test.skip(!secretSeeded, 'Could not seed test secret');

		const payload = makePayload({ timestamp: Date.now() - 6 * 60 * 1000 });
		const body = JSON.stringify(payload);
		const signature = signPayload(TEST_SECRET, body);

		const res = await request.post(`${GUARDIAN_URL}/channel/inbound`, {
			headers: {
				'content-type': 'application/json',
				'x-channel-signature': signature
			},
			data: body,
			timeout: 10_000
		});
		expect(res.status()).toBe(409);
		const data = await res.json();
		expect(data.error).toBe('replay_detected');
	});

	// ── Group 4: Payload validation (no LLM needed) ─────────────────

	test('missing required fields returns 400', async ({ request }) => {
		test.skip(!secretSeeded, 'Could not seed test secret');

		const incomplete = { userId: 'u1' };
		const body = JSON.stringify(incomplete);
		const signature = signPayload(TEST_SECRET, body);

		const res = await request.post(`${GUARDIAN_URL}/channel/inbound`, {
			headers: {
				'content-type': 'application/json',
				'x-channel-signature': signature
			},
			data: body,
			timeout: 10_000
		});
		expect(res.status()).toBe(400);
		const data = await res.json();
		expect(data.error).toBe('invalid_payload');
	});

	test('invalid JSON body returns 400', async ({ request }) => {
		// Playwright's request.post with data: string sends it raw.
		// The guardian should return 400 with either invalid_json (unparseable)
		// or invalid_payload (parseable but missing required fields).
		const res = await request.post(`${GUARDIAN_URL}/channel/inbound`, {
			headers: {
				'content-type': 'application/json',
				'x-channel-signature': 'anything'
			},
			data: 'not valid json{{{',
			timeout: 10_000
		});
		expect(res.status()).toBe(400);
		const data = await res.json();
		expect(['invalid_json', 'invalid_payload']).toContain(data.error);
	});

	// ── Group 5: Full pipeline with LLM (needs RUN_LLM_TESTS=1) ────

	test('HMAC-signed message gets LLM response through full chain', async ({ request }) => {
		const SKIP_LLM = !process.env.RUN_LLM_TESTS;
		test.skip(!!SKIP_LLM, 'Requires RUN_LLM_TESTS=1 (LLM inference through guardian)');
		test.skip(!secretSeeded, 'Could not seed test secret');
		test.setTimeout(180_000);

		const payload = makePayload({
			text: 'Reply with exactly the word "channel-pipeline-ok". Nothing else.'
		});
		const body = JSON.stringify(payload);
		const signature = signPayload(TEST_SECRET, body);

		const res = await request.post(`${GUARDIAN_URL}/channel/inbound`, {
			headers: {
				'content-type': 'application/json',
				'x-channel-signature': signature
			},
			data: body,
			timeout: 175_000
		});

		expect(res.status()).toBe(200);
		const data = await res.json();
		expect(data.userId).toBe(payload.userId);
		expect(typeof data.sessionId).toBe('string');
		expect(data.sessionId.length).toBeGreaterThan(0);
		expect(typeof data.answer).toBe('string');
		expect(data.answer.length).toBeGreaterThan(0);
		expect(typeof data.requestId).toBe('string');
	});
});

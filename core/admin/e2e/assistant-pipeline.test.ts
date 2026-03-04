import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * Assistant Pipeline Verification Tests
 *
 * Validates the OpenCode server API, OpenMemory CRUD, and the full
 * assistant message pipeline end-to-end. Tests are organized into
 * 4 tiers of graceful degradation:
 *
 *   1. Stack not running → entire file skipped (RUN_DOCKER_STACK_TESTS)
 *   2. LLM not opted in  → Groups 5-6 skip without RUN_LLM_TESTS=1
 *   3. Embedding provider down → Group 4 CRUD skips inline when add fails
 *   4. Endpoint version mismatch → handle 404 from /providers gracefully
 *
 * Run with:
 *   RUN_DOCKER_STACK_TESTS=1 npx playwright test assistant-pipeline
 *   RUN_DOCKER_STACK_TESTS=1 RUN_LLM_TESTS=1 npx playwright test assistant-pipeline
 */

const OPENCODE_URL = 'http://localhost:4096';
const OPENMEMORY_URL = 'http://localhost:8765';
const OPENMEMORY_USER_ID = process.env.OPENMEMORY_USER_ID ?? 'default_user';
const E2E_TAG = 'e2e-test';

// ── Helper Functions ─────────────────────────────────────────────────────

/** Build OpenCode auth headers (matches guardian/src/server.ts:140-144). */
function openCodeHeaders(): Record<string, string> {
	const h: Record<string, string> = { 'content-type': 'application/json' };
	const pw = process.env.OPENCODE_SERVER_PASSWORD;
	if (pw) {
		const user = process.env.OPENCODE_SERVER_USERNAME ?? 'opencode';
		h['authorization'] = `Basic ${Buffer.from(`${user}:${pw}`).toString('base64')}`;
	}
	return h;
}

/** Check if OpenCode has LLM providers configured. */
async function hasLlmProvider(request: APIRequestContext): Promise<boolean> {
	try {
		const res = await request.get(`${OPENCODE_URL}/providers`, { timeout: 10_000 });
		if (!res.ok()) return false;
		const data = await res.json();
		return Array.isArray(data) && data.length > 0;
	} catch {
		return false;
	}
}

/** Create an OpenCode session (mirrors guardian/src/server.ts:151-169). */
async function createSession(
	request: APIRequestContext,
	title: string
): Promise<{ id: string }> {
	const res = await request.post(`${OPENCODE_URL}/session`, {
		headers: openCodeHeaders(),
		data: { title },
		timeout: 10_000
	});
	expect(res.ok(), `POST /session failed: ${res.status()}`).toBeTruthy();
	const session = await res.json();
	expect(session.id).toBeTruthy();
	expect(session.id).toMatch(/^[a-zA-Z0-9_-]+$/);
	return session;
}

/** Send a message to an OpenCode session (mirrors guardian/src/server.ts:174-199). */
async function sendMessage(
	request: APIRequestContext,
	sessionId: string,
	text: string,
	timeoutMs = 120_000
): Promise<{ parts: Array<{ type: string; text?: string; content?: string }> }> {
	const res = await request.post(`${OPENCODE_URL}/session/${sessionId}/message`, {
		headers: openCodeHeaders(),
		data: { parts: [{ type: 'text', text }] },
		timeout: timeoutMs
	});
	expect(res.ok(), `POST /session/${sessionId}/message failed: ${res.status()}`).toBeTruthy();
	return await res.json();
}

/** Extract text content from OpenCode response parts. */
function extractText(parts: Array<{ type: string; text?: string; content?: string }>): string {
	const texts: string[] = [];
	for (const part of parts ?? []) {
		if (part.type === 'text' && part.text) texts.push(part.text);
	}
	return texts.join('\n');
}

/** Search memories via OpenMemory API (mirrors assistant-tools memory-search.ts). */
async function searchMemories(
	request: APIRequestContext,
	query: string
): Promise<{ results: Array<{ id: string; memory: string; metadata?: Record<string, unknown> }> }> {
	const res = await request.post(`${OPENMEMORY_URL}/api/v1/memories/filter`, {
		headers: { 'content-type': 'application/json' },
		data: { user_id: OPENMEMORY_USER_ID, search_query: query, page: 1, size: 20 },
		timeout: 30_000
	});
	expect(res.ok(), `POST /api/v1/memories/filter failed: ${res.status()}`).toBeTruthy();
	return await res.json();
}

/** Add a memory via OpenMemory API (mirrors assistant-tools memory-add.ts). */
async function addMemory(
	request: APIRequestContext,
	text: string,
	metadata: Record<string, unknown> = {}
): Promise<{ results: Array<{ id: string; memory: string; event: string }> }> {
	const res = await request.post(`${OPENMEMORY_URL}/api/v1/memories/`, {
		headers: { 'content-type': 'application/json' },
		data: {
			user_id: OPENMEMORY_USER_ID,
			text,
			app: 'openpalm-e2e-test',
			metadata: { ...metadata, category: 'semantic', source: E2E_TAG },
			infer: true
		},
		timeout: 60_000
	});
	return { results: [], ...(await res.json().catch(() => ({}))), _status: res.status() } as any;
}

/** Delete memories via OpenMemory API (mirrors assistant-tools memory-delete.ts). */
async function deleteMemories(
	request: APIRequestContext,
	memoryIds: string[]
): Promise<void> {
	if (memoryIds.length === 0) return;
	await request.delete(`${OPENMEMORY_URL}/api/v1/memories/`, {
		headers: { 'content-type': 'application/json' },
		data: { memory_ids: memoryIds, user_id: OPENMEMORY_USER_ID },
		timeout: 30_000
	}).catch(() => {});
}

/** Find and delete all e2e-tagged test memories. */
async function cleanupTestMemories(request: APIRequestContext): Promise<void> {
	try {
		const data = await searchMemories(request, E2E_TAG);
		const ids = (data.results ?? [])
			.filter((r) => r.metadata?.source === E2E_TAG)
			.map((r) => r.id);
		await deleteMemories(request, ids);
	} catch {
		// Best-effort cleanup
	}
}

// ── Group 1: OpenCode Server Health (no LLM needed) ─────────────────────

test.describe('OpenCode Server Health', () => {
	const SKIP = !process.env.RUN_DOCKER_STACK_TESTS;
	test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running compose stack');

	test('HTTP health check responds', async ({ request }) => {
		const res = await request.get(OPENCODE_URL, { timeout: 10_000 });
		expect(res.status()).toBeLessThan(500);
		const body = await res.text();
		expect(body.length).toBeGreaterThan(0);
	});

	test('providers endpoint returns configured providers', async ({ request }) => {
		const res = await request.get(`${OPENCODE_URL}/providers`, { timeout: 10_000 });
		// /providers may not exist in all OpenCode versions
		if (res.status() === 404) {
			test.skip(true, '/providers endpoint not available');
			return;
		}
		expect(res.ok()).toBeTruthy();
		const data = await res.json();
		expect(Array.isArray(data)).toBe(true);
	});
});

// ── Group 2: OpenCode Session API (no LLM needed) ───────────────────────

test.describe('OpenCode Session API', () => {
	const SKIP = !process.env.RUN_DOCKER_STACK_TESTS;
	test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running compose stack');

	test('session creation returns valid ID', async ({ request }) => {
		const session = await createSession(request, 'e2e-test/session-api');
		expect(session.id).toBeTruthy();
		expect(session.id).toMatch(/^[a-zA-Z0-9_-]+$/);
	});
});

// ── Group 3: OpenMemory Direct API (no LLM needed) ──────────────────────

test.describe('OpenMemory Direct API', () => {
	const SKIP = !process.env.RUN_DOCKER_STACK_TESTS;
	test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running compose stack');

	test('docs endpoint responds', async ({ request }) => {
		const res = await request.get(`${OPENMEMORY_URL}/docs`, { timeout: 10_000 });
		expect(res.ok()).toBeTruthy();
	});

	test('stats endpoint returns valid response', async ({ request }) => {
		const res = await request.get(
			`${OPENMEMORY_URL}/api/v1/stats/?user_id=${OPENMEMORY_USER_ID}`,
			{ timeout: 10_000 }
		);
		expect(res.ok()).toBeTruthy();
		const data = await res.json();
		expect(data).toBeDefined();
	});
});

// ── Group 4: OpenMemory CRUD Cycle (needs embedding provider) ───────────

test.describe('OpenMemory CRUD Cycle', () => {
	const SKIP = !process.env.RUN_DOCKER_STACK_TESTS;
	test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running compose stack');

	test.describe.configure({ mode: 'serial' });

	let createdMemoryIds: string[] = [];
	const testText = `E2E test memory created at ${new Date().toISOString()} — canary: ${E2E_TAG}-crud-${Date.now()}`;

	test('add memory', async ({ request }) => {
		const result = await addMemory(request, testText);
		// If embedding provider is down, the add will fail — skip the rest
		if ((result as any)._status !== 200) {
			test.skip(true, `OpenMemory add failed (status ${(result as any)._status}) — embedding provider may be down`);
			return;
		}
		const ids = (result.results ?? []).map((r) => r.id).filter(Boolean);
		expect(ids.length).toBeGreaterThan(0);
		createdMemoryIds = ids;
	});

	test('search memory', async ({ request }) => {
		if (createdMemoryIds.length === 0) {
			test.skip(true, 'No memory was created — skipping search');
			return;
		}
		const data = await searchMemories(request, E2E_TAG);
		const found = (data.results ?? []).some(
			(r) => createdMemoryIds.includes(r.id) || r.memory.includes(E2E_TAG)
		);
		expect(found).toBe(true);
	});

	test('delete memory', async ({ request }) => {
		if (createdMemoryIds.length === 0) {
			test.skip(true, 'No memory was created — skipping delete');
			return;
		}
		await deleteMemories(request, createdMemoryIds);
		// Verify deletion
		const data = await searchMemories(request, E2E_TAG);
		const stillExists = (data.results ?? []).some((r) => createdMemoryIds.includes(r.id));
		expect(stillExists).toBe(false);
	});

	test.afterAll(async ({ request }) => {
		await cleanupTestMemories(request);
	});
});

// ── Group 5: Assistant Message Pipeline (needs RUN_LLM_TESTS=1) ─────────

test.describe('Assistant Message Pipeline', () => {
	const SKIP_STACK = !process.env.RUN_DOCKER_STACK_TESTS;
	const SKIP_LLM = !process.env.RUN_LLM_TESTS;
	test.skip(!!SKIP_STACK, 'Requires RUN_DOCKER_STACK_TESTS=1 and running compose stack');
	test.skip(!!SKIP_LLM, 'Requires RUN_LLM_TESTS=1 (LLM inference)');

	test('send message and get response', async ({ request }) => {
		test.setTimeout(120_000);
		const session = await createSession(request, 'e2e-test/message-pipeline');
		const data = await sendMessage(
			request,
			session.id,
			'Reply with exactly: "pipeline-ok". Nothing else.',
			120_000
		);
		expect(data.parts).toBeDefined();
		expect(Array.isArray(data.parts)).toBe(true);
		const text = extractText(data.parts);
		expect(text.length).toBeGreaterThan(0);
	});
});

// ── Group 6: Memory Integration End-to-End (needs RUN_LLM_TESTS=1) ─────

test.describe('Memory Integration E2E', () => {
	const SKIP_STACK = !process.env.RUN_DOCKER_STACK_TESTS;
	const SKIP_LLM = !process.env.RUN_LLM_TESTS;
	test.skip(!!SKIP_STACK, 'Requires RUN_DOCKER_STACK_TESTS=1 and running compose stack');
	test.skip(!!SKIP_LLM, 'Requires RUN_LLM_TESTS=1 (LLM inference + memory tools)');

	test.describe.configure({ mode: 'serial' });

	const canary = `e2e-canary-${Date.now()}`;
	let sessionId: string;
	let foundMemoryIds: string[] = [];

	test('assistant records a memory via tool call', async ({ request }) => {
		test.setTimeout(180_000);

		// 1. Create session
		const session = await createSession(request, 'e2e-test/memory-integration');
		sessionId = session.id;

		// 2. Ask the assistant to remember a unique fact
		const data = await sendMessage(
			request,
			sessionId,
			`Please remember this fact for me: "The E2E test canary value is ${canary}". Use your memory tool to store it.`,
			180_000
		);

		// 3. Verify we got a response (confirms assistant processed the request)
		expect(data.parts).toBeDefined();
		const text = extractText(data.parts);
		expect(text.length).toBeGreaterThan(0);
	});

	test('memory was stored in OpenMemory', async ({ request }) => {
		test.setTimeout(30_000);

		if (!sessionId) {
			test.skip(true, 'Session was not created — skipping memory verification');
			return;
		}

		// Give OpenMemory a moment to process the embedding
		await new Promise((r) => setTimeout(r, 3000));

		// Search for our canary value
		const data = await searchMemories(request, canary);
		const matches = (data.results ?? []).filter(
			(r) => r.memory.includes(canary) || r.memory.includes('canary')
		);
		expect(matches.length).toBeGreaterThan(0);
		foundMemoryIds = matches.map((r) => r.id);
	});

	test('cleanup test memories', async ({ request }) => {
		if (foundMemoryIds.length === 0) {
			test.skip(true, 'No memories to clean up');
			return;
		}
		await deleteMemories(request, foundMemoryIds);
	});

	test.afterAll(async ({ request }) => {
		// Best-effort cleanup of any orphaned e2e memories
		await cleanupTestMemories(request);
	});
});

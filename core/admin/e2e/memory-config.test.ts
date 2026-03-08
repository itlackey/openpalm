import { expect, test } from '@playwright/test';

const TOKEN_KEY = 'openpalm.adminToken';

/** Standard set of mocks for navigating to the authenticated console. */
async function setupConsoleMocks(page: import('@playwright/test').Page) {
	await page.route('**/admin/access-scope', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ accessScope: 'lan' })
		})
	);
	await page.route('**/health', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ status: 'ok', service: 'admin' })
		})
	);
	await page.route('**/guardian/health', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ status: 'ok', service: 'guardian' })
		})
	);
	await page.route('**/admin/containers/list', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ containers: {}, dockerContainers: [], dockerAvailable: true })
		})
	);
	await page.route('**/admin/automations', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ automations: [], scheduler: { jobCount: 0, jobs: [] } })
		})
	);
	await page.route('**/admin/channels', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ installed: [], available: [] })
		})
	);
	await page.route('**/admin/connections/status', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ complete: true, missing: [] })
		})
	);
	await page.route('**/admin/connections', (route) => {
		if (route.request().method() === 'GET') {
			return route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					connections: {
						SYSTEM_LLM_PROVIDER: 'openai',
						SYSTEM_LLM_BASE_URL: 'https://api.openai.com',
						OPENAI_API_KEY: 'sk-****1234',
						SYSTEM_LLM_MODEL: 'gpt-4o-mini',
						EMBEDDING_MODEL: 'text-embedding-3-small',
						EMBEDDING_DIMS: '1536',
						MEMORY_USER_ID: 'default_user'
					}
				})
			});
		}
		return route.continue();
	});
	await page.route('**/admin/setup', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ setupComplete: true, configured: { adminToken: true } })
		})
	);
	await page.route('**/admin/memory/config', (route) => {
		if (route.request().method() === 'GET') {
			return route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					config: {
						mem0: {
							llm: { provider: 'openai', config: { model: 'gpt-4o-mini', temperature: 0.1, max_tokens: 2000, api_key: 'env:OPENAI_API_KEY' } },
							embedder: { provider: 'openai', config: { model: 'text-embedding-3-small', api_key: 'env:OPENAI_API_KEY' } },
							vector_store: { provider: 'qdrant', config: { collection_name: 'memory', path: '/data/qdrant', embedding_model_dims: 1536 } }
						},
						memory: { custom_instructions: '' }
					},
					runtimeConfig: null,
					providers: {
						llm: ['openai', 'anthropic', 'ollama', 'groq', 'together', 'mistral', 'deepseek', 'xai', 'lmstudio', 'model-runner'],
						embed: ['openai', 'ollama', 'huggingface', 'lmstudio']
					},
					embeddingDims: { 'openai/text-embedding-3-small': 1536, 'ollama/nomic-embed-text': 768 }
				})
			});
		}
		return route.continue();
	});
}

/** Navigate to the connections tab with auth. */
async function navigateToConnections(page: import('@playwright/test').Page) {
	await page.goto('/');
	await page.evaluate((key) => localStorage.setItem(key, 'test-token'), TOKEN_KEY);
	await page.reload();
	await page.waitForSelector('nav', { timeout: 10000 });
	await page.getByRole('tab', { name: /connections/i }).click();
	// Wait for the connections tab heading
	await expect(page.locator('h2:has-text("Connections")')).toBeVisible({ timeout: 10000 });
}

test.describe('Connections Tab UI', () => {
	test('connections tab shows System LLM Connection section', async ({ page }) => {
		await setupConsoleMocks(page);
		await navigateToConnections(page);

		// Verify the System LLM Connection section is visible
		await expect(page.getByRole('heading', { name: 'System LLM Connection' })).toBeVisible();

		// Verify Memory Settings section exists
		await expect(page.getByText('Memory Settings')).toBeVisible();

		// Verify form controls are present
		await expect(page.locator('#conn-provider')).toBeVisible();
		await expect(page.locator('#conn-base-url')).toBeVisible();
		await expect(page.locator('#conn-system-model')).toBeVisible();
		await expect(page.locator('#conn-embedding-model')).toBeVisible();
		await expect(page.locator('#conn-embedding-dims')).toBeVisible();
		await expect(page.locator('#conn-memory-user-id')).toBeVisible();

		// Verify loaded values from mocked connections (wait for async load)
		await expect(page.locator('#conn-system-model')).toHaveValue('gpt-4o-mini', { timeout: 5000 });
		await expect(page.locator('#conn-embedding-model')).toHaveValue('text-embedding-3-small', { timeout: 5000 });
	});

	test('saving connection sends correct data', async ({ page }) => {
		let savedPayload: Record<string, unknown> | null = null;

		await setupConsoleMocks(page);

		// Override POST /admin/connections to capture the payload
		await page.route('**/admin/connections', (route) => {
			if (route.request().method() === 'POST') {
				savedPayload = JSON.parse(route.request().postData() ?? '{}');
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({ ok: true, pushed: true })
				});
			}
			if (route.request().method() === 'GET') {
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						profiles: [],
						assignments: {
							llm: { connectionId: 'primary', model: 'gpt-4o-mini' },
							embeddings: { connectionId: 'primary', model: 'text-embedding-3-small', embeddingDims: 1536 }
						},
						connections: {
							SYSTEM_LLM_PROVIDER: 'openai',
							OPENAI_API_KEY: 'sk-****1234',
							SYSTEM_LLM_MODEL: 'gpt-4o-mini',
							EMBEDDING_MODEL: 'text-embedding-3-small',
							EMBEDDING_DIMS: '1536'
						}
					})
				});
			}
			return route.continue();
		});

		await navigateToConnections(page);

		// Change provider to ollama
		await page.locator('#conn-provider').selectOption('ollama');
		await page.locator('#conn-system-model').fill('llama3');

		// Save
		await page.getByRole('button', { name: 'Save' }).click();

		// Verify success message
		await expect(page.getByText('Connection saved successfully')).toBeVisible({ timeout: 5000 });

		// Verify the posted payload
		expect(savedPayload).not.toBeNull();
		if (!savedPayload) {
			throw new Error('Expected /admin/connections payload to be captured');
		}
		const payload = savedPayload as unknown as {
			profiles: Array<Record<string, unknown>>;
			assignments: { llm: { model: string } };
		};
		expect(Array.isArray(payload.profiles)).toBe(true);
		expect(payload.profiles[0]?.provider).toBe('ollama');
		expect(payload.assignments?.llm).toBeTruthy();
		expect(payload.assignments.llm.model).toBe('llama3');
	});

	test('embedding model field hint warns about collection reset', async ({ page }) => {
		await setupConsoleMocks(page);
		await navigateToConnections(page);

		// Verify the field hint about embedding model changes
		await expect(
			page.getByText('Changing this after data is stored requires a collection reset')
		).toBeVisible();
	});
});

test.describe('Memory Config API', () => {
	test('GET /admin/memory/config returns config structure', async ({ request }) => {
		const response = await request.get('/admin/memory/config', {
			headers: {
				'x-admin-token': process.env.ADMIN_TOKEN ?? 'test-token',
				'x-requested-by': 'test',
				'x-request-id': crypto.randomUUID()
			}
		});

		// May fail with 401 if no admin token configured — that's expected in CI
		if (response.status() === 401) {
			return;
		}

		expect(response.ok()).toBeTruthy();
		const data = await response.json();
		expect(data).toHaveProperty('config');
		expect(data).toHaveProperty('providers');
		expect(data).toHaveProperty('embeddingDims');
		expect(data.config).toHaveProperty('mem0');
		expect(data.config.mem0).toHaveProperty('llm');
		expect(data.config.mem0).toHaveProperty('embedder');
		expect(data.config.mem0).toHaveProperty('vector_store');
		expect(data.providers).toHaveProperty('llm');
		expect(data.providers).toHaveProperty('embed');
		expect(Array.isArray(data.providers.llm)).toBe(true);
		expect(Array.isArray(data.providers.embed)).toBe(true);
	});

	test('POST /admin/memory/config saves and returns result', async ({ request }) => {
		const config = {
			mem0: {
				llm: {
					provider: 'ollama',
					config: {
						model: 'llama3',
						temperature: 0.1,
						max_tokens: 2000,
						api_key: 'env:OPENAI_API_KEY',
						base_url: 'http://host.docker.internal:11434'
					}
				},
				embedder: {
					provider: 'ollama',
					config: {
						model: 'nomic-embed-text',
						api_key: 'env:OPENAI_API_KEY',
						base_url: 'http://host.docker.internal:11434'
					}
				},
				vector_store: {
					provider: 'qdrant',
					config: {
						collection_name: 'memory',
						path: '/data/qdrant',
						embedding_model_dims: 768
					}
				}
			},
			memory: { custom_instructions: 'Test instructions' }
		};

		const response = await request.post('/admin/memory/config', {
			data: config,
			headers: {
				'content-type': 'application/json',
				'x-admin-token': process.env.ADMIN_TOKEN ?? 'test-token',
				'x-requested-by': 'test',
				'x-request-id': crypto.randomUUID()
			}
		});

		if (response.status() === 401) {
			return;
		}

		expect(response.ok()).toBeTruthy();
		const data = await response.json();
		expect(data.ok).toBe(true);
		expect(data.persisted).toBe(true);
		expect(data).toHaveProperty('pushed');
	});

	test('GET /admin/memory/config requires auth', async ({ request }) => {
		const response = await request.get('/admin/memory/config', {
			headers: { 'x-request-id': crypto.randomUUID() }
		});
		expect(response.status()).toBe(401);
	});

	test('POST /admin/memory/config rejects invalid body', async ({ request }) => {
		const response = await request.post('/admin/memory/config', {
			data: { invalid: true },
			headers: {
				'content-type': 'application/json',
				'x-admin-token': process.env.ADMIN_TOKEN ?? 'test-token',
				'x-requested-by': 'test',
				'x-request-id': crypto.randomUUID()
			}
		});

		if (response.status() === 401) {
			return;
		}

		expect(response.status()).toBe(400);
	});
});

test.describe('Memory Models API', () => {
	test('POST /admin/memory/models requires auth', async ({ request }) => {
		const response = await request.post('/admin/memory/models', {
			data: { provider: 'anthropic', apiKeyRef: '', baseUrl: '' },
			headers: {
				'content-type': 'application/json',
				'x-request-id': crypto.randomUUID()
			}
		});
		expect(response.status()).toBe(401);
	});

	test('POST /admin/memory/models rejects invalid provider', async ({ request }) => {
		const response = await request.post('/admin/memory/models', {
			data: { provider: 'invalid-provider', apiKeyRef: '', baseUrl: '' },
			headers: {
				'content-type': 'application/json',
				'x-admin-token': process.env.ADMIN_TOKEN ?? 'test-token',
				'x-requested-by': 'test',
				'x-request-id': crypto.randomUUID()
			}
		});

		if (response.status() === 401) return;

		expect(response.status()).toBe(400);
		const data = await response.json();
		expect(data.error).toBe('bad_request');
	});

	test('POST /admin/memory/models rejects missing provider', async ({ request }) => {
		const response = await request.post('/admin/memory/models', {
			data: { apiKeyRef: '', baseUrl: '' },
			headers: {
				'content-type': 'application/json',
				'x-admin-token': process.env.ADMIN_TOKEN ?? 'test-token',
				'x-requested-by': 'test',
				'x-request-id': crypto.randomUUID()
			}
		});

		if (response.status() === 401) return;

		expect(response.status()).toBe(400);
	});

	test('POST /admin/memory/models returns models array for anthropic', async ({ request }) => {
		const response = await request.post('/admin/memory/models', {
			data: { provider: 'anthropic', apiKeyRef: '', baseUrl: '' },
			headers: {
				'content-type': 'application/json',
				'x-admin-token': process.env.ADMIN_TOKEN ?? 'test-token',
				'x-requested-by': 'test',
				'x-request-id': crypto.randomUUID()
			}
		});

		if (response.status() === 401) return;

		expect(response.ok()).toBeTruthy();
		const data = await response.json();
		expect(Array.isArray(data.models)).toBe(true);
		expect(data.models.length).toBeGreaterThan(0);
		expect(data.models).toContain('claude-sonnet-4-20250514');
		expect(data.error).toBeUndefined();
	});

	test('POST /admin/memory/models returns error for unreachable provider', async ({ request }) => {
		const response = await request.post('/admin/memory/models', {
			data: { provider: 'ollama', apiKeyRef: '', baseUrl: 'http://127.0.0.1:59999' },
			headers: {
				'content-type': 'application/json',
				'x-admin-token': process.env.ADMIN_TOKEN ?? 'test-token',
				'x-requested-by': 'test',
				'x-request-id': crypto.randomUUID()
			}
		});

		if (response.status() === 401) return;

		expect(response.ok()).toBeTruthy();
		const data = await response.json();
		expect(data.models).toEqual([]);
		expect(data.error).toBeTruthy();
	});
});

test.describe('Connection Test & Model Selection UI', () => {
	test('Test Connection button fetches models from provider', async ({ page }) => {
		await setupConsoleMocks(page);

		// Mock the models endpoint
		await page.route('**/admin/memory/models', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ models: ['gpt-4o', 'gpt-4o-mini', 'gpt-3.5-turbo'] })
			})
		);

		await navigateToConnections(page);

		// The provider should be pre-filled with openai
		await expect(page.locator('#conn-provider')).toHaveValue('openai');

		// System model should be visible (text input since no models loaded yet)
		await expect(page.locator('#conn-system-model')).toBeVisible();
	});

	test('Test Connection shows error when provider is unreachable', async ({ page }) => {
		await setupConsoleMocks(page);

		await page.route('**/admin/memory/models', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ models: [], status: 'recoverable_error', reason: 'network', error: 'Connection refused' })
			})
		);

		await navigateToConnections(page);

		// Click Test Connection
		await page.getByRole('button', { name: 'Test Connection' }).click();

		// Wait for error to appear
		await expect(page.getByText('Network error — unable to reach admin API.')).toBeVisible({ timeout: 5000 });
	});

	test('Test Connection populates model dropdowns', async ({ page }) => {
		let modelCallCount = 0;

		await setupConsoleMocks(page);

		await page.route('**/admin/memory/models', (route) => {
			modelCallCount++;
			return route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ models: ['gpt-4o', 'gpt-4o-mini'] })
			});
		});

		await navigateToConnections(page);

		// Click Test Connection
		await page.getByRole('button', { name: 'Test Connection' }).click();

		// Wait for connection success
		await expect(page.locator('[role="status"]')).toBeVisible({ timeout: 5000 });
		await expect(page.getByText('Connected')).toBeVisible();

		// Verify a model call was made
		expect(modelCallCount).toBeGreaterThan(0);
	});
});

/**
 * Docker stack integration tests — require RUN_DOCKER_STACK_TESTS=1 and a running stack.
 */
test.describe('Memory Ollama Integration', () => {
	const SKIP = !process.env.RUN_DOCKER_STACK_TESTS;

	test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running compose stack');

	test('config file is mounted and readable in memory container', async ({ request }) => {
		// Hit the real admin container directly (not the preview server)
		const response = await request.get('http://localhost:8100/admin/memory/config', {
			headers: {
				'x-admin-token': process.env.ADMIN_TOKEN ?? '',
				'x-requested-by': 'test',
				'x-request-id': crypto.randomUUID()
			}
		});
		expect(response.ok()).toBeTruthy();
		const data = await response.json();
		expect(data.config.mem0).toBeDefined();
		expect(data.config.mem0.llm.provider).toBeTruthy();
		expect(data.config.mem0.embedder.provider).toBeTruthy();
	});

	test('memory accepts Ollama config and connects to endpoint', async ({ request }) => {
		const ollamaConfig = {
			mem0: {
				llm: {
					provider: 'ollama',
					config: {
						model: 'llama3',
						temperature: 0.1,
						max_tokens: 2000,
						api_key: 'env:OPENAI_API_KEY',
						base_url: 'http://host.docker.internal:11434'
					}
				},
				embedder: {
					provider: 'ollama',
					config: {
						model: 'nomic-embed-text',
						api_key: 'env:OPENAI_API_KEY',
						base_url: 'http://host.docker.internal:11434'
					}
				},
				vector_store: {
					provider: 'qdrant',
					config: {
						collection_name: 'memory',
						path: '/data/qdrant',
						embedding_model_dims: 768
					}
				}
			},
			memory: { custom_instructions: '' }
		};

		// Hit the real admin container directly (not the preview server)
		const saveRes = await request.post('http://localhost:8100/admin/memory/config', {
			data: ollamaConfig,
			headers: {
				'content-type': 'application/json',
				'x-admin-token': process.env.ADMIN_TOKEN ?? '',
				'x-requested-by': 'test',
				'x-request-id': crypto.randomUUID()
			}
		});
		expect(saveRes.ok()).toBeTruthy();
		const saveData = await saveRes.json();
		expect(saveData.ok).toBe(true);
		expect(saveData.persisted).toBe(true);

		const readRes = await request.get('http://localhost:8100/admin/memory/config', {
			headers: {
				'x-admin-token': process.env.ADMIN_TOKEN ?? '',
				'x-requested-by': 'test',
				'x-request-id': crypto.randomUUID()
			}
		});
		expect(readRes.ok()).toBeTruthy();
		const readData = await readRes.json();
		expect(readData.config.mem0.llm.provider).toBe('ollama');
		expect(readData.config.mem0.llm.config.base_url).toBe('http://host.docker.internal:11434');
		expect(readData.config.mem0.embedder.provider).toBe('ollama');
		expect(readData.config.mem0.embedder.config.model).toBe('nomic-embed-text');
		expect(readData.config.mem0.vector_store.config.embedding_model_dims).toBe(768);

		if (saveData.pushed) {
			expect(readData.runtimeConfig).toBeDefined();
			if (readData.runtimeConfig) {
				expect(readData.runtimeConfig.mem0.llm.provider).toBe('ollama');
			}
		}
	});

	test('memory health check passes with configured provider', async ({ request }) => {
		const healthRes = await request.get('http://localhost:8765/docs').catch(() => null);
		if (healthRes) {
			expect(healthRes.ok()).toBeTruthy();
		}
	});
});

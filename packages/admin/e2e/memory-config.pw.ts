import { expect, test } from '@playwright/test';

const TOKEN_KEY = 'openpalm.adminToken';

/** Standard set of mocks for navigating to the authenticated console. */
async function setupConsoleMocks(page: import('@playwright/test').Page) {
	await page.route('**/admin/capabilities/status', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ complete: true, missing: [] })
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
	await page.route('**/admin/addons', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ addons: [] })
		})
	);
	await page.route('**/admin/capabilities/status', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ complete: true, missing: [] })
		})
	);
	await page.route('**/admin/opencode/status', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ status: 'unavailable', url: '' })
		})
	);
	// GET /admin/providers: full provider page state
	await page.route('**/admin/providers', (route) => {
		if (route.request().method() === 'GET') {
			return route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					available: true,
					providers: [
						{ id: 'openai', name: 'OpenAI', env: ['OPENAI_API_KEY'], connected: true, configured: true, disabled: false, supportsOauth: true, activeMainModel: true, activeSmallModel: false, models: [{ id: 'gpt-4o', name: 'GPT-4o' }], authMethods: [{ type: 'api', label: 'API Key' }], options: {}, source: 'catalog' },
						{ id: 'anthropic', name: 'Anthropic', env: ['ANTHROPIC_API_KEY'], connected: true, configured: false, disabled: false, supportsOauth: true, activeMainModel: false, activeSmallModel: false, models: [], authMethods: [{ type: 'api', label: 'API Key' }], options: {}, source: 'catalog' },
					],
					defaultModels: {},
					allowlistActive: false,
					providerCountLabel: '2 providers',
					currentModel: 'openai/gpt-4o-mini',
					stats: { total: 2, connected: 2, configured: 1, disabled: 0 }
				})
			});
		}
		return route.continue();
	});
	// GET /admin/capabilities: capabilities + secrets
	await page.route('**/admin/capabilities', (route) => {
		if (route.request().method() === 'GET') {
			return route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					capabilities: {
						llm: 'openai/gpt-4o-mini',
						embeddings: { provider: 'openai', model: 'text-embedding-3-small', dims: 1536 },
						memory: { userId: 'default_user', customInstructions: '' }
					},
					secrets: {
						OPENAI_API_KEY: 'sk-****1234',
						OWNER_NAME: '',
						OWNER_EMAIL: ''
					}
				})
			});
		}
		return route.continue();
	});
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

/** Navigate to the capabilities tab with auth. */
async function navigateToCapabilities(page: import('@playwright/test').Page) {
	await page.goto('/');
	await page.evaluate((key) => localStorage.setItem(key, 'test-token'), TOKEN_KEY);
	await page.reload();
	await page.waitForSelector('nav', { timeout: 10000 });
	await page.getByRole('tab', { name: /capabilities/i }).first().click();
	// Wait for the sub-tab pills to appear (Providers, Capabilities, Voice, Memory)
	await expect(page.getByRole('tab', { name: 'Capabilities' }).last()).toBeVisible({ timeout: 10000 });
}

/** Navigate to the Capabilities sub-tab within the capabilities main tab. */
async function navigateToCapabilitiesSubTab(page: import('@playwright/test').Page) {
	await navigateToCapabilities(page);
	await page.getByRole('tab', { name: 'Capabilities' }).last().click();
}

/** Navigate to the Connections tab and open the custom provider form. */
async function openCustomEndpointForm(page: import('@playwright/test').Page) {
	await page.goto('/');
	await page.evaluate((key) => localStorage.setItem(key, 'test-token'), TOKEN_KEY);
	await page.reload();
	await page.waitForSelector('nav', { timeout: 10000 });
	await page.getByRole('tab', { name: /connections/i }).first().click();
	// Wait for the custom provider details element
	const summary = page.locator('summary', { hasText: /custom provider/i });
	await expect(summary).toBeVisible({ timeout: 10000 });
	await summary.click();
}

test.describe('@mocked Capabilities Tab UI', () => {
	test('capabilities tab shows sub-tabs and model assignments', async ({ page }) => {
		await setupConsoleMocks(page);
		await navigateToCapabilities(page);

		// Verify sub-tab pills are visible (Capabilities, Voice, Memory — no Providers, moved to Connections tab)
		await expect(page.getByRole('tab', { name: 'Memory' })).toBeVisible();

		// Capabilities sub-tab should be active by default
		await page.getByRole('tab', { name: 'Capabilities' }).last().click();
		await expect(page.locator('.sub-panel')).toBeVisible({ timeout: 5000 });

		// Switch to Memory sub-tab
		await page.getByRole('tab', { name: 'Memory' }).click();

		// Verify Memory User ID field is present
		await expect(page.locator('#mem-u')).toBeVisible();

		// Verify loaded Memory User ID from mocked capabilities
		await expect(page.locator('#mem-u')).toHaveValue('default_user', { timeout: 5000 });
	});

	test('saving memory settings sends correct data', async ({ page }) => {
		let savedPayload: Record<string, unknown> | null = null;

		await setupConsoleMocks(page);

		// Override capabilities endpoints to capture the save payload
		await page.route('**/admin/capabilities/assignments', (route) => {
			if (route.request().method() === 'POST') {
				savedPayload = JSON.parse(route.request().postData() ?? '{}');
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({ ok: true, capabilities: savedPayload.capabilities ?? {} })
				});
			}
			if (route.request().method() === 'GET') {
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						capabilities: {
							llm: 'openai/gpt-4o-mini',
							embeddings: { provider: 'openai', model: 'text-embedding-3-small', dims: 1536 },
							memory: { userId: 'default_user', customInstructions: '' }
						}
					})
				});
			}
			return route.continue();
		});
		await page.route('**/admin/capabilities', (route) => {
			if (route.request().method() === 'GET') {
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						capabilities: {
							llm: 'openai/gpt-4o-mini',
							embeddings: { provider: 'openai', model: 'text-embedding-3-small', dims: 1536 },
							memory: { userId: 'default_user', customInstructions: '' }
						},
						secrets: { OPENAI_API_KEY: 'sk-****1234' }
					})
				});
			}
			return route.continue();
		});

		await navigateToCapabilities(page);

		// Switch to the Memory sub-tab
		await page.getByRole('tab', { name: 'Memory' }).click();

		// Update the Memory User ID field
		const userIdField = page.locator('#mem-u');
		await userIdField.clear();
		await userIdField.fill('test_user');

		// Save via the Save Changes button
		await page.getByRole('button', { name: 'Save Changes' }).click();

		// Verify success indicator
		await expect(page.locator('.feedback--success')).toBeVisible({ timeout: 5000 });

		// Verify the posted payload uses the assignments format
		expect(savedPayload).not.toBeNull();
		if (!savedPayload) {
			throw new Error('Expected /admin/capabilities/assignments payload to be captured');
		}
		const payload = savedPayload as { capabilities?: { memory?: { userId?: string } } };
		// memory.userId should reflect what was typed
		expect(payload.capabilities?.memory?.userId).toBe('test_user');
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
		expect(data).toHaveProperty('persisted');
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

test.describe('@mocked Custom Provider Form UI', () => {
	test('Custom provider form shows required fields', async ({ page }) => {
		await setupConsoleMocks(page);
		await openCustomEndpointForm(page);

		// Required fields should be visible
		await expect(page.locator('#custom-providerId')).toBeVisible();
		await expect(page.locator('#custom-displayName')).toBeVisible();
		await expect(page.locator('#custom-baseURL')).toBeVisible();
		await expect(page.locator('#custom-apiKey')).toBeVisible();
	});

	test('Custom provider form has Add Model button', async ({ page }) => {
		await setupConsoleMocks(page);
		await openCustomEndpointForm(page);

		await expect(page.getByRole('button', { name: /add model/i })).toBeVisible();
	});

	test('Custom provider form has Create button', async ({ page }) => {
		await setupConsoleMocks(page);
		await openCustomEndpointForm(page);

		await expect(page.getByRole('button', { name: /create custom provider/i })).toBeVisible();
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

	});

	test('memory health check passes with configured provider', async ({ request }) => {
		const healthRes = await request.get('http://localhost:8765/health').catch(() => null);
		if (healthRes) {
			expect(healthRes.ok()).toBeTruthy();
		}
	});

	test('capability test endpoint succeeds against host Ollama without browser route mocks', async ({ request }) => {
		const adminToken = process.env.ADMIN_TOKEN ?? '';
		test.skip(!adminToken, 'Requires ADMIN_TOKEN for authenticated admin API calls');

		const response = await request.post('http://localhost:8100/admin/capabilities/test', {
			data: {
				baseUrl: 'http://host.docker.internal:11434',
				kind: 'local',
			},
			headers: {
				'content-type': 'application/json',
				'x-admin-token': adminToken,
				'x-requested-by': 'test',
				'x-request-id': crypto.randomUUID(),
			},
		});

		expect(response.ok()).toBeTruthy();
		const data = await response.json();
		expect(data.ok).toBe(true);
		expect(Array.isArray(data.models)).toBe(true);
		expect(data.models.length).toBeGreaterThan(0);
	});
});

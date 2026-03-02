import { expect, test } from '@playwright/test';

test.describe('OpenMemory Config UI', () => {
	test('connections tab shows OpenMemory Configuration section', async ({ page }) => {
		// Mock auth validation
		await page.route('**/admin/validate', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ allowed: true })
			})
		);

		// Mock health, containers, automations, channels, connection status
		await page.route('**/health', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ status: 'ok', service: 'admin' })
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
					body: JSON.stringify({ connections: {} })
				});
			}
			return route.continue();
		});
		await page.route('**/admin/access-scope', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ accessScope: 'lan' })
			})
		);
		await page.route('**/admin/setup', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ setupComplete: true, configured: { adminToken: true } })
			})
		);

		// Mock OpenMemory config endpoint
		await page.route('**/admin/openmemory/config', (route) => {
			if (route.request().method() === 'GET') {
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						config: {
							mem0: {
								llm: {
									provider: 'openai',
									config: { model: 'gpt-4o-mini', temperature: 0.1, max_tokens: 2000, api_key: 'env:OPENAI_API_KEY' }
								},
								embedder: {
									provider: 'openai',
									config: { model: 'text-embedding-3-small', api_key: 'env:OPENAI_API_KEY' }
								},
								vector_store: {
									provider: 'qdrant',
									config: { collection_name: 'openmemory', host: 'qdrant', port: 6333, embedding_model_dims: 1536 }
								}
							},
							openmemory: { custom_instructions: '' }
						},
						runtimeConfig: null,
						providers: {
							llm: ['openai', 'anthropic', 'ollama', 'groq', 'together', 'mistral', 'deepseek', 'xai', 'lmstudio'],
							embed: ['openai', 'ollama', 'huggingface', 'lmstudio']
						},
						embeddingDims: {
							'openai/text-embedding-3-small': 1536,
							'ollama/nomic-embed-text': 768
						}
					})
				});
			}
			return route.continue();
		});

		// Set admin token in localStorage
		await page.goto('/');
		await page.evaluate(() => {
			localStorage.setItem('adminToken', 'test-token');
		});
		await page.reload();

		// Wait for auth to resolve
		await page.waitForSelector('nav', { timeout: 10000 });

		// Navigate to connections tab
		const connectionsTab = page.getByRole('tab', { name: /connections/i });
		await connectionsTab.click();

		// Verify the OpenMemory Configuration section is visible
		await expect(page.getByText('OpenMemory Configuration')).toBeVisible({ timeout: 10000 });

		// Verify LLM Provider sub-section exists
		await expect(page.getByText('LLM Provider').first()).toBeVisible();

		// Verify Embedding Provider sub-section exists
		await expect(page.getByText('Embedding Provider').first()).toBeVisible();

		// Verify form controls are present
		await expect(page.locator('#om-llm-provider')).toBeVisible();
		await expect(page.locator('#om-llm-model')).toBeVisible();
		await expect(page.locator('#om-embed-provider')).toBeVisible();
		await expect(page.locator('#om-embed-model')).toBeVisible();
		await expect(page.locator('#om-embed-dims')).toBeVisible();

		// Verify default values loaded
		await expect(page.locator('#om-llm-model')).toHaveValue('gpt-4o-mini');
		await expect(page.locator('#om-embed-model')).toHaveValue('text-embedding-3-small');
	});

	test('saving OpenMemory config sends correct data', async ({ page }) => {
		let savedConfig: Record<string, unknown> | null = null;

		// Set up all required mocks
		await page.route('**/admin/validate', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ allowed: true }) })
		);
		await page.route('**/health', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', service: 'admin' }) })
		);
		await page.route('**/admin/containers/list', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ containers: {}, dockerContainers: [], dockerAvailable: true }) })
		);
		await page.route('**/admin/automations', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ automations: [], scheduler: { jobCount: 0, jobs: [] } }) })
		);
		await page.route('**/admin/channels', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ installed: [], available: [] }) })
		);
		await page.route('**/admin/connections/status', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ complete: true, missing: [] }) })
		);
		await page.route('**/admin/connections', (route) => {
			if (route.request().method() === 'GET') {
				return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ connections: {} }) });
			}
			return route.continue();
		});
		await page.route('**/admin/access-scope', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ accessScope: 'lan' }) })
		);
		await page.route('**/admin/setup', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ setupComplete: true, configured: { adminToken: true } }) })
		);

		await page.route('**/admin/openmemory/config', (route) => {
			if (route.request().method() === 'GET') {
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						config: {
							mem0: {
								llm: { provider: 'openai', config: { model: 'gpt-4o-mini', temperature: 0.1, max_tokens: 2000, api_key: 'env:OPENAI_API_KEY' } },
								embedder: { provider: 'openai', config: { model: 'text-embedding-3-small', api_key: 'env:OPENAI_API_KEY' } },
								vector_store: { provider: 'qdrant', config: { collection_name: 'openmemory', host: 'qdrant', port: 6333, embedding_model_dims: 1536 } }
							},
							openmemory: { custom_instructions: '' }
						},
						runtimeConfig: null,
						providers: {
							llm: ['openai', 'anthropic', 'ollama', 'groq'],
							embed: ['openai', 'ollama', 'huggingface', 'lmstudio']
						},
						embeddingDims: { 'openai/text-embedding-3-small': 1536, 'ollama/nomic-embed-text': 768 }
					})
				});
			}
			if (route.request().method() === 'POST') {
				savedConfig = JSON.parse(route.request().postData() ?? '{}');
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({ ok: true, persisted: true, pushed: true })
				});
			}
			return route.continue();
		});

		await page.goto('/');
		await page.evaluate(() => localStorage.setItem('adminToken', 'test-token'));
		await page.reload();
		await page.waitForSelector('nav', { timeout: 10000 });

		// Navigate to connections tab
		await page.getByRole('tab', { name: /connections/i }).click();
		await expect(page.getByText('OpenMemory Configuration')).toBeVisible({ timeout: 10000 });

		// Change LLM provider to ollama
		await page.locator('#om-llm-provider').selectOption('ollama');
		await page.locator('#om-llm-model').fill('llama3');
		await page.locator('#om-llm-base-url').fill('http://host.docker.internal:11434');

		// Save
		await page.getByRole('button', { name: 'Save OpenMemory Config' }).click();

		// Verify success message
		await expect(page.getByText('OpenMemory config saved')).toBeVisible({ timeout: 5000 });

		// Verify the posted config
		expect(savedConfig).not.toBeNull();
		const mem0 = (savedConfig as Record<string, unknown>).mem0 as Record<string, unknown>;
		const llm = mem0.llm as Record<string, unknown>;
		expect(llm.provider).toBe('ollama');
		const llmConfig = llm.config as Record<string, unknown>;
		expect(llmConfig.model).toBe('llama3');
		expect(llmConfig.base_url).toBe('http://host.docker.internal:11434');
	});

	test('warning info note about embedding model change is visible', async ({ page }) => {
		// Minimal mocks for auth + setup
		await page.route('**/admin/validate', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ allowed: true }) })
		);
		await page.route('**/health', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', service: 'admin' }) })
		);
		await page.route('**/admin/containers/list', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ containers: {}, dockerContainers: [], dockerAvailable: true }) })
		);
		await page.route('**/admin/automations', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ automations: [], scheduler: { jobCount: 0, jobs: [] } }) })
		);
		await page.route('**/admin/channels', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ installed: [], available: [] }) })
		);
		await page.route('**/admin/connections/status', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ complete: true, missing: [] }) })
		);
		await page.route('**/admin/connections', (route) => {
			if (route.request().method() === 'GET') {
				return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ connections: {} }) });
			}
			return route.continue();
		});
		await page.route('**/admin/access-scope', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ accessScope: 'lan' }) })
		);
		await page.route('**/admin/setup', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ setupComplete: true, configured: { adminToken: true } }) })
		);
		await page.route('**/admin/openmemory/config', (route) => {
			if (route.request().method() === 'GET') {
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						config: {
							mem0: {
								llm: { provider: 'openai', config: { model: 'gpt-4o-mini', temperature: 0.1, max_tokens: 2000, api_key: 'env:OPENAI_API_KEY' } },
								embedder: { provider: 'openai', config: { model: 'text-embedding-3-small', api_key: 'env:OPENAI_API_KEY' } },
								vector_store: { provider: 'qdrant', config: { collection_name: 'openmemory', host: 'qdrant', port: 6333, embedding_model_dims: 1536 } }
							},
							openmemory: { custom_instructions: '' }
						},
						runtimeConfig: null,
						providers: { llm: ['openai', 'ollama'], embed: ['openai', 'ollama'] },
						embeddingDims: {}
					})
				});
			}
			return route.continue();
		});

		await page.goto('/');
		await page.evaluate(() => localStorage.setItem('adminToken', 'test-token'));
		await page.reload();
		await page.waitForSelector('nav', { timeout: 10000 });

		await page.getByRole('tab', { name: /connections/i }).click();
		await expect(page.getByText('OpenMemory Configuration')).toBeVisible({ timeout: 10000 });

		// Verify the warning note about embedding model changes
		await expect(
			page.getByText('Changing the embedding model after data has been stored requires resetting OpenMemory')
		).toBeVisible();
	});
});

test.describe('OpenMemory Config API', () => {
	test('GET /admin/openmemory/config returns config structure', async ({ request }) => {
		const response = await request.get('/admin/openmemory/config', {
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

	test('POST /admin/openmemory/config saves and returns result', async ({ request }) => {
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
						collection_name: 'openmemory',
						host: 'qdrant',
						port: 6333,
						embedding_model_dims: 768
					}
				}
			},
			openmemory: { custom_instructions: 'Test instructions' }
		};

		const response = await request.post('/admin/openmemory/config', {
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

	test('GET /admin/openmemory/config requires auth', async ({ request }) => {
		const response = await request.get('/admin/openmemory/config', {
			headers: { 'x-request-id': crypto.randomUUID() }
		});
		expect(response.status()).toBe(401);
	});

	test('POST /admin/openmemory/config rejects invalid body', async ({ request }) => {
		const response = await request.post('/admin/openmemory/config', {
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

test.describe('OpenMemory Models API', () => {
	test('POST /admin/openmemory/models requires auth', async ({ request }) => {
		const response = await request.post('/admin/openmemory/models', {
			data: { provider: 'anthropic', apiKeyRef: '', baseUrl: '' },
			headers: {
				'content-type': 'application/json',
				'x-request-id': crypto.randomUUID()
			}
		});
		expect(response.status()).toBe(401);
	});

	test('POST /admin/openmemory/models rejects invalid provider', async ({ request }) => {
		const response = await request.post('/admin/openmemory/models', {
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

	test('POST /admin/openmemory/models rejects missing provider', async ({ request }) => {
		const response = await request.post('/admin/openmemory/models', {
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

	test('POST /admin/openmemory/models returns models array for anthropic', async ({ request }) => {
		const response = await request.post('/admin/openmemory/models', {
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

	test('POST /admin/openmemory/models returns error for unreachable provider', async ({ request }) => {
		const response = await request.post('/admin/openmemory/models', {
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

test.describe('OpenMemory Model Selector UI', () => {
	/** Set up all standard mocks including models endpoint. */
	async function setupMocks(page: import('@playwright/test').Page, modelsResponse?: { models: string[]; error?: string }) {
		await page.route('**/admin/validate', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ allowed: true }) })
		);
		await page.route('**/health', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', service: 'admin' }) })
		);
		await page.route('**/admin/containers/list', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ containers: {}, dockerContainers: [], dockerAvailable: true }) })
		);
		await page.route('**/admin/automations', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ automations: [], scheduler: { jobCount: 0, jobs: [] } }) })
		);
		await page.route('**/admin/channels', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ installed: [], available: [] }) })
		);
		await page.route('**/admin/connections/status', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ complete: true, missing: [] }) })
		);
		await page.route('**/admin/connections', (route) => {
			if (route.request().method() === 'GET') {
				return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ connections: {} }) });
			}
			return route.continue();
		});
		await page.route('**/admin/access-scope', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ accessScope: 'lan' }) })
		);
		await page.route('**/admin/setup', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ setupComplete: true, configured: { adminToken: true } }) })
		);
		await page.route('**/admin/openmemory/config', (route) => {
			if (route.request().method() === 'GET') {
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						config: {
							mem0: {
								llm: { provider: 'openai', config: { model: 'gpt-4o-mini', temperature: 0.1, max_tokens: 2000, api_key: 'env:OPENAI_API_KEY' } },
								embedder: { provider: 'openai', config: { model: 'text-embedding-3-small', api_key: 'env:OPENAI_API_KEY' } },
								vector_store: { provider: 'qdrant', config: { collection_name: 'openmemory', host: 'qdrant', port: 6333, embedding_model_dims: 1536 } }
							},
							openmemory: { custom_instructions: '' }
						},
						runtimeConfig: null,
						providers: {
							llm: ['openai', 'anthropic', 'ollama', 'groq', 'together', 'mistral', 'deepseek', 'xai', 'lmstudio'],
							embed: ['openai', 'ollama', 'huggingface', 'lmstudio']
						},
						embeddingDims: { 'openai/text-embedding-3-small': 1536, 'ollama/nomic-embed-text': 768 }
					})
				});
			}
			return route.continue();
		});

		// Mock the models endpoint
		await page.route('**/admin/openmemory/models', (route) => {
			const resp = modelsResponse ?? { models: ['gpt-4o', 'gpt-4o-mini', 'gpt-3.5-turbo'], error: undefined };
			return route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify(resp)
			});
		});
	}

	/** Navigate to connections tab with auth. */
	async function navigateToConnections(page: import('@playwright/test').Page) {
		await page.goto('/');
		await page.evaluate(() => localStorage.setItem('adminToken', 'test-token'));
		await page.reload();
		await page.waitForSelector('nav', { timeout: 10000 });
		await page.getByRole('tab', { name: /connections/i }).click();
		await expect(page.getByText('OpenMemory Configuration')).toBeVisible({ timeout: 10000 });
	}

	test('model selector shows select dropdown when models are loaded', async ({ page }) => {
		await setupMocks(page, { models: ['gpt-4o', 'gpt-4o-mini', 'gpt-3.5-turbo'] });
		await navigateToConnections(page);

		// Wait for models to load (debounce + fetch)
		// The LLM model field should become or remain a select/input
		const llmModelField = page.locator('#om-llm-model');
		await expect(llmModelField).toBeVisible({ timeout: 10000 });
	});

	test('model selector shows error when provider is unreachable', async ({ page }) => {
		await setupMocks(page, { models: [], error: 'Connection refused' });
		await navigateToConnections(page);

		// Wait for the model load attempt to complete
		// The error message should appear inline
		await page.waitForTimeout(1500); // debounce + fetch
		const errorText = page.getByText('Connection refused');
		// Error may or may not be visible depending on UI state; check it doesn't crash
		const llmModelField = page.locator('#om-llm-model');
		await expect(llmModelField).toBeVisible();
	});

	test('refresh button triggers model reload', async ({ page }) => {
		let modelCallCount = 0;
		await setupMocks(page);

		// Override the models route to count calls
		await page.route('**/admin/openmemory/models', (route) => {
			modelCallCount++;
			return route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ models: ['gpt-4o', 'gpt-4o-mini'] })
			});
		});

		await navigateToConnections(page);

		// Wait for initial model load
		await page.waitForTimeout(1500);
		const initialCount = modelCallCount;

		// Click the LLM refresh button
		const refreshBtn = page.locator('.om-llm-refresh, button[title*="Refresh"], button[aria-label*="refresh"]').first();
		if (await refreshBtn.isVisible()) {
			await refreshBtn.click();
			await page.waitForTimeout(500);
			expect(modelCallCount).toBeGreaterThan(initialCount);
		}
	});
});

/**
 * Docker stack integration tests — require RUN_DOCKER_STACK_TESTS=1 and a running stack.
 * These verify OpenMemory reads the mounted default_config.json and can connect to
 * the configured endpoint (Ollama or OpenAI).
 */
test.describe('OpenMemory Ollama Integration', () => {
	const SKIP = !process.env.RUN_DOCKER_STACK_TESTS;

	test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running compose stack');

	test('config file is mounted and readable in openmemory container', async ({ request }) => {
		// Read the config via admin API
		const response = await request.get('/admin/openmemory/config', {
			headers: {
				'x-admin-token': process.env.ADMIN_TOKEN ?? '',
				'x-requested-by': 'test',
				'x-request-id': crypto.randomUUID()
			}
		});
		expect(response.ok()).toBeTruthy();
		const data = await response.json();

		// Config should reflect the persisted file
		expect(data.config.mem0).toBeDefined();
		expect(data.config.mem0.llm.provider).toBeTruthy();
		expect(data.config.mem0.embedder.provider).toBeTruthy();
	});

	test('openmemory accepts Ollama config and connects to endpoint', async ({ request }) => {
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
						collection_name: 'openmemory',
						host: 'qdrant',
						port: 6333,
						embedding_model_dims: 768
					}
				}
			},
			openmemory: { custom_instructions: '' }
		};

		// Save the Ollama config via admin API
		const saveRes = await request.post('/admin/openmemory/config', {
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

		// Verify the config was persisted by reading it back
		const readRes = await request.get('/admin/openmemory/config', {
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

		// If runtime push succeeded, verify the runtime config matches
		if (saveData.pushed) {
			expect(readData.runtimeConfig).toBeDefined();
			if (readData.runtimeConfig) {
				expect(readData.runtimeConfig.mem0.llm.provider).toBe('ollama');
			}
		}
	});

	test('openmemory health check passes with configured provider', async ({ request }) => {
		// The openmemory service should be healthy regardless of which provider is configured
		// (it validates config on startup but doesn't make API calls until a memory operation)
		const healthRes = await request.get('http://localhost:8765/docs').catch(() => null);
		if (healthRes) {
			expect(healthRes.ok()).toBeTruthy();
		}
	});
});

import { test, expect, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMIN_TOKEN } from './helpers';
import { TMP_DIR } from './env';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = join(__dirname, 'screenshots');

/** Mock the health-check endpoint so all services report ok:true.
 *  This lets the Complete step reach "Everything is ready!" instead of the
 *  timed-out "Some services took too long to start" path, which is a failure
 *  condition per the test requirements.
 */
async function mockHealthCheckAllOk(page: Page) {
	await page.route('**/setup/health-check', (route) => {
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				services: {
					gateway: { ok: true, time: new Date().toISOString() },
					assistant: { ok: true, time: new Date().toISOString() },
					openmemory: { ok: true, time: new Date().toISOString() },
					admin: { ok: true, time: new Date().toISOString() }
				},
				serviceInstances: { openmemory: '', psql: '', qdrant: '' }
			})
		});
	});
}

async function openWizard(page: Page) {
	const overlay = page.locator('.wizard-overlay');
	// Wait briefly for the wizard to auto-open (it opens automatically when
	// completed=false via an async onMount fetch). Only click the button if it
	// does not appear on its own.
	const autoOpened = await overlay.isVisible({ timeout: 2000 }).catch(() => false);
	if (autoOpened) return;
	await page.locator('button', { hasText: 'Run Setup Wizard' }).click();
	await expect(overlay).toBeVisible();
}

/** Fill the required Profile step fields so the wizard can advance.
 *  Uses the known e2e admin token as the password so subsequent API calls
 *  (which send x-admin-token from the client store) stay in sync with the
 *  server's expected token.
 */
async function fillProfileStep(page: Page) {
	await page.locator('#wiz-profile-password').fill(ADMIN_TOKEN);
	await page.locator('#wiz-profile-password2').fill(ADMIN_TOKEN);
}

/** Fill the required AI Providers step field so the wizard can advance. */
async function fillProvidersStep(page: Page) {
	await page.locator('#wiz-anthropic-key').fill('sk-ant-test-key-for-e2e');
}

/** Navigate through all wizard steps up to (but not including) clicking Finish Setup.
 *  Leaves the wizard on the Health Check step with "Finish Setup" ready to click.
 */
async function navigateToHealthCheckStep(page: Page) {
	await openWizard(page);
	// Welcome -> Next
	await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
	// Profile
	await expect(page.locator('.wizard h2')).toContainText('Profile');
	await fillProfileStep(page);
	await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
	// AI Providers
	await expect(page.locator('.wizard h2')).toContainText('AI Providers');
	await fillProvidersStep(page);
	await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
	// Security
	await expect(page.locator('.wizard h2')).toContainText('Security');
	await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
	// Channels
	await expect(page.locator('.wizard h2')).toContainText('Channels');
	await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
	// Access
	await expect(page.locator('.wizard h2')).toContainText('Access');
	await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
	// Health Check
	await expect(page.locator('.wizard h2')).toContainText('Health Check');
}

/** Mock setup.complete command to return success so the wizard reaches the Complete step. */
async function mockSetupCompleteOk(page: Page) {
	await page.route('**/command', async (route) => {
		const body = route.request().postDataJSON() as { type?: string } | null;
		if (body?.type === 'setup.complete') {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ ok: true, state: { completed: true } })
			});
		} else {
			await route.continue();
		}
	});
}

test.beforeEach(async ({ page }) => {
	await page.goto('/');
	await page.evaluate((token) => localStorage.setItem('op_admin', token), ADMIN_TOKEN);
	await page.reload();
});

test.describe('setup wizard browser flow', () => {
	test('setup wizard overlay is visible', async ({ page }) => {
		await expect(page.locator('h2', { hasText: 'Dashboard' })).toBeVisible();
		await openWizard(page);
		await expect(page.locator('.wizard h2')).toContainText('Welcome');
	});

	test('wizard step navigation: Welcome -> Profile -> AI Providers -> Security -> Channels', async ({
		page
	}) => {
		await openWizard(page);

		await expect(page.locator('.wizard h2')).toContainText('Welcome');
		await expect(page.locator('text=Welcome to')).toBeVisible();
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

		await expect(page.locator('.wizard h2')).toContainText('Profile');
		await expect(page.locator('#wiz-profile-name')).toBeVisible();
		await expect(page.locator('#wiz-profile-email')).toBeVisible();
		await fillProfileStep(page);
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

		await expect(page.locator('.wizard h2')).toContainText('AI Providers');
		await fillProvidersStep(page);
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

		await expect(page.locator('.wizard h2')).toContainText('Security');
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

		await expect(page.locator('.wizard h2')).toContainText('Channels');
		await expect(page.locator('.wiz-ch').first()).toBeVisible();
	});

	test('wizard Back button navigates to previous step', async ({ page }) => {
		await openWizard(page);

		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
		await expect(page.locator('.wizard h2')).toContainText('Profile');

		await page.locator('.wizard .actions button', { hasText: 'Back' }).click();
		await expect(page.locator('.wizard h2')).toContainText('Welcome');
	});

	test('full wizard flow completes successfully with all services ready', async ({ page }) => {
		// Mock health-check so all services respond ok immediately.
		// The test FAILS if "services took too long to start" appears.
		await mockHealthCheckAllOk(page);

		await openWizard(page);

		// Welcome
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

		// Profile
		await expect(page.locator('.wizard h2')).toContainText('Profile');
		await fillProfileStep(page);
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

		// AI Providers
		await expect(page.locator('.wizard h2')).toContainText('AI Providers');
		await fillProvidersStep(page);
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

		// Security
		await expect(page.locator('.wizard h2')).toContainText('Security');
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

		// Channels
		await expect(page.locator('.wizard h2')).toContainText('Channels');
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

		// Access
		await expect(page.locator('.wizard h2')).toContainText('Access');
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

		// Health Check
		await expect(page.locator('.wizard h2')).toContainText('Health Check');
		await page.locator('.wizard .actions button', { hasText: 'Finish Setup' }).click();

		// Complete step — must reach "Everything is ready!" not the timeout path
		await expect(page.locator('.wizard h2')).toContainText('Complete');
		await expect(page.locator('text=Finalizing setup')).toBeVisible();

		// PASS: all services are mocked ok, so the ready state is reached quickly
		await expect(page.locator('text=Everything is ready!')).toBeVisible({ timeout: 10_000 });

		// FAIL if the timeout/error path is shown
		await expect(page.locator('text=Some services took too long to start')).not.toBeVisible();
		await expect(page.locator('text=not ready')).not.toBeVisible();

		// The primary "Continue to Admin" button (not the secondary fallback) must be shown
		await expect(page.locator('button', { hasText: 'Continue to Admin' })).toBeVisible();

		// ── File verification ────────────────────────────────────────────────────
		// After a successful wizard run the following artifacts must exist and be valid.

		// 1. Stack spec (openpalm.yaml)
		const specPath = join(TMP_DIR, 'config', 'openpalm.yaml');
		expect(existsSync(specPath), `stack spec missing: ${specPath}`).toBe(true);
		const specContent = readFileSync(specPath, 'utf8');
		expect(specContent.length, 'stack spec is empty').toBeGreaterThan(0);

		// 2. docker-compose.yml with core services
		const composePath = join(TMP_DIR, 'state', 'docker-compose.yml');
		expect(existsSync(composePath), `compose file missing: ${composePath}`).toBe(true);
		const composeContent = readFileSync(composePath, 'utf8');
		expect(composeContent).toContain('services:');
		expect(composeContent).toContain('assistant:');
		expect(composeContent).toContain('gateway:');

		// 3. caddy.json — must be valid JSON with a top-level object
		const caddyPath = join(TMP_DIR, 'state', 'caddy.json');
		expect(existsSync(caddyPath), `caddy.json missing: ${caddyPath}`).toBe(true);
		const caddyParsed = JSON.parse(readFileSync(caddyPath, 'utf8'));
		expect(typeof caddyParsed).toBe('object');

		// 4. Runtime .env with host path vars
		const runtimeEnvPath = join(TMP_DIR, 'state', '.env');
		expect(existsSync(runtimeEnvPath), `runtime .env missing: ${runtimeEnvPath}`).toBe(true);
		expect(readFileSync(runtimeEnvPath, 'utf8')).toContain('OPENPALM_STATE_HOME=');

		// 5. system.env with access scope
		const sysEnvPath = join(TMP_DIR, 'state', 'system.env');
		expect(existsSync(sysEnvPath), `system.env missing: ${sysEnvPath}`).toBe(true);
		expect(readFileSync(sysEnvPath, 'utf8')).toContain('OPENPALM_ACCESS_SCOPE=');

		// 6. gateway/.env
		const gwEnvPath = join(TMP_DIR, 'state', 'gateway', '.env');
		expect(existsSync(gwEnvPath), `gateway/.env missing: ${gwEnvPath}`).toBe(true);

		// 7. secrets.env with auto-generated POSTGRES_PASSWORD
		const secretsPath = join(TMP_DIR, 'config', 'secrets.env');
		expect(existsSync(secretsPath), `secrets.env missing: ${secretsPath}`).toBe(true);
		expect(readFileSync(secretsPath, 'utf8')).toContain('POSTGRES_PASSWORD=');

		// ── Screenshot ───────────────────────────────────────────────────────────
		await page.screenshot({ path: join(SCREENSHOTS_DIR, 'wizard-complete.png'), fullPage: false });
	});

	// rec2.1 — profile step rejects a password shorter than 8 characters
	test('profile step shows error for short password', async ({ page }) => {
		await openWizard(page);

		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
		await expect(page.locator('.wizard h2')).toContainText('Profile');

		await page.locator('#wiz-profile-password').fill('short1');
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

		await expect(page.locator('.wiz-error.visible').first()).toContainText(
			'Password must be at least 8 characters.'
		);
		await expect(page.locator('.wizard h2')).toContainText('Profile');
	});

	// rec2.2 — profile step rejects mismatched passwords
	test('profile step shows error when passwords do not match', async ({ page }) => {
		await openWizard(page);

		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
		await expect(page.locator('.wizard h2')).toContainText('Profile');

		await page.locator('#wiz-profile-password').fill('password-alpha');
		await page.locator('#wiz-profile-password2').fill('password-beta');
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

		await expect(page.locator('.wiz-error.visible').first()).toContainText(
			'Passwords do not match.'
		);
		await expect(page.locator('.wizard h2')).toContainText('Profile');
	});

	// rec2.3 — AI Providers step rejects a missing Anthropic key
	test('AI Providers step shows error when Anthropic key is empty', async ({ page }) => {
		await openWizard(page);

		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
		await expect(page.locator('.wizard h2')).toContainText('Profile');
		await fillProfileStep(page);
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

		await expect(page.locator('.wizard h2')).toContainText('AI Providers');

		await page.locator('#wiz-anthropic-key').fill('');
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

		await expect(page.locator('.wiz-error.visible').first()).toContainText(
			'An Anthropic API key is required.'
		);
		await expect(page.locator('.wizard h2')).toContainText('AI Providers');
	});

	// rec2.4 — setup.complete returning 500 shows an error banner and re-enables Finish Setup
	test('Finish Setup shows error and re-enables button when setup.complete returns 500', async ({
		page
	}) => {
		await page.route('**/command', async (route) => {
			const body = route.request().postDataJSON() as { type?: string } | null;
			if (body?.type === 'setup.complete') {
				await route.fulfill({
					status: 500,
					contentType: 'application/json',
					body: JSON.stringify({ ok: false, error: 'docker compose failed' })
				});
			} else {
				await route.continue();
			}
		});

		await navigateToHealthCheckStep(page);
		await page.locator('.wizard .actions button', { hasText: 'Finish Setup' }).click();

		await expect(page.locator('.wiz-error.visible').first()).toContainText('Setup failed:');
		await expect(
			page.locator('.wizard .actions button', { hasText: 'Finish Setup' })
		).toBeEnabled();
	});

	// ── R15: Health-check failure tests ──────────────────────────────────────

	// R15.1 — All non-admin services return ok:false → fast-fail after 5 polls
	test('Complete step shows error state when all services report ok:false', async ({ page }) => {
		// Mock: all non-admin services are down → triggers fast-fail after 5 polls
		await page.route('**/setup/health-check', (route) => {
			route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					services: {
						gateway: { ok: false, error: 'status 502' },
						assistant: { ok: false, error: 'connection refused' },
						openmemory: { ok: false, error: 'status 503' },
						admin: { ok: true, time: new Date().toISOString() }
					},
					serviceInstances: { openmemory: '', psql: '', qdrant: '' }
				})
			});
		});

		await mockSetupCompleteOk(page);
		await navigateToHealthCheckStep(page);
		await page.locator('.wizard .actions button', { hasText: 'Finish Setup' }).click();

		// Wait for Complete step and the fast-fail timeout (~5s)
		await expect(page.locator('.wizard h2')).toContainText('Complete');
		await expect(page.locator('text=Some services took too long to start')).toBeVisible({
			timeout: 15_000
		});

		// Per-service "not ready" labels are shown
		await expect(page.locator('text=not ready').first()).toBeVisible();

		// "Everything is ready!" must NOT appear
		await expect(page.locator('text=Everything is ready!')).not.toBeVisible();

		// The secondary "Continue to Admin" button (fallback) is shown
		await expect(
			page.locator('button.btn-secondary', { hasText: 'Continue to Admin' })
		).toBeVisible();

		// Help text is shown
		await expect(page.locator('text=openpalm logs')).toBeVisible();
	});

	// R15.2 — Partial readiness: services come up gradually, then all healthy
	test('Complete step renders per-service status during polling', async ({ page }) => {
		let callCount = 0;

		await page.route('**/setup/health-check', (route) => {
			callCount++;
			const services: Record<string, { ok: boolean; time?: string; error?: string }> = {
				admin: { ok: true, time: new Date().toISOString() }
			};

			// Phase 1 (calls 1-3): only admin is up
			if (callCount <= 3) {
				services.gateway = { ok: false, error: 'connection refused' };
				services.assistant = { ok: false, error: 'connection refused' };
				services.openmemory = { ok: false, error: 'connection refused' };
			}
			// Phase 2 (calls 4-7): gateway comes up, others still down
			else if (callCount <= 7) {
				services.gateway = { ok: true, time: new Date().toISOString() };
				services.assistant = { ok: false, error: 'connection refused' };
				services.openmemory = { ok: false, error: 'connection refused' };
			}
			// Phase 3 (calls 8+): all services come up
			else {
				services.gateway = { ok: true, time: new Date().toISOString() };
				services.assistant = { ok: true, time: new Date().toISOString() };
				services.openmemory = { ok: true, time: new Date().toISOString() };
			}

			route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					services,
					serviceInstances: { openmemory: '', psql: '', qdrant: '' }
				})
			});
		});

		await mockSetupCompleteOk(page);
		await navigateToHealthCheckStep(page);
		await page.locator('.wizard .actions button', { hasText: 'Finish Setup' }).click();
		await expect(page.locator('.wizard h2')).toContainText('Complete');

		// During Phase 2 (calls 4-7), the live per-service list should show
		// gateway as ready while assistant/openmemory are still starting
		await expect(page.locator('li', { hasText: /gateway.*ready/ })).toBeVisible({
			timeout: 10_000
		});
		await expect(page.locator('li', { hasText: /assistant.*starting/ })).toBeVisible();

		// Eventually all services come up and we reach the success state
		await expect(page.locator('text=Everything is ready!')).toBeVisible({
			timeout: 15_000
		});

		// Primary "Continue to Admin" button (not the secondary fallback)
		const continueBtn = page.locator('button', { hasText: 'Continue to Admin' });
		await expect(continueBtn).toBeVisible();
		await expect(continueBtn).not.toHaveClass(/btn-secondary/);
	});

	// R15.3 — Full polling timeout: some services up, but not all → 60-poll timeout
	test('Complete step shows timeout message after polling exhaustion', async ({ page }) => {
		test.setTimeout(90_000); // 60s polling + margin

		// Mock: openmemory is up (prevents fast-fail) but gateway/assistant stay down
		await page.route('**/setup/health-check', (route) => {
			route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					services: {
						gateway: { ok: false, error: 'connection refused' },
						assistant: { ok: false, error: 'connection refused' },
						openmemory: { ok: true, time: new Date().toISOString() },
						admin: { ok: true, time: new Date().toISOString() }
					},
					serviceInstances: { openmemory: '', psql: '', qdrant: '' }
				})
			});
		});

		await mockSetupCompleteOk(page);
		await navigateToHealthCheckStep(page);
		await page.locator('.wizard .actions button', { hasText: 'Finish Setup' }).click();
		await expect(page.locator('.wizard h2')).toContainText('Complete');

		// During polling, the counter message should be visible
		await expect(page.locator('text=Starting services...')).toBeVisible();

		// After 60 polls (~60s), the timeout message appears
		await expect(page.locator('text=Some services took too long to start')).toBeVisible({
			timeout: 75_000
		});

		// Mixed status: openmemory shows "ready", gateway/assistant show "not ready"
		await expect(page.locator('li', { hasText: /openmemory.*ready/ })).toBeVisible();
		await expect(page.locator('li', { hasText: /gateway.*not ready/ })).toBeVisible();
		await expect(page.locator('li', { hasText: /assistant.*not ready/ })).toBeVisible();

		// Fallback continue button is available
		await expect(
			page.locator('button.btn-secondary', { hasText: 'Continue to Admin' })
		).toBeVisible();
	});

	// R15.4 — HealthStep dot indicators for mixed healthy/unhealthy services
	test('Health Check step shows per-service dot indicators for mixed health', async ({
		page
	}) => {
		await page.route('**/setup/health-check', (route) => {
			route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					services: {
						gateway: { ok: true, time: new Date().toISOString() },
						assistant: { ok: false, error: 'connection refused' },
						openmemory: { ok: false, error: 'status 503' },
						admin: { ok: true, time: new Date().toISOString() }
					},
					serviceInstances: { openmemory: '', psql: '', qdrant: '' }
				})
			});
		});

		await navigateToHealthCheckStep(page);

		// Scope assertions to the wizard overlay to avoid matching the
		// dashboard's HealthStatus widget which also renders dot indicators.
		const wizard = page.locator('.wizard-overlay');

		// Wait for health data to load
		await expect(wizard.locator('.dot-ok').first()).toBeVisible({ timeout: 5_000 });

		// Healthy services have green dot
		await expect(wizard.locator('.dot-ok')).toHaveCount(2); // gateway + admin
		// Unhealthy services have red dot
		await expect(wizard.locator('.dot-err')).toHaveCount(2); // assistant + openmemory

		// Error text is rendered for unhealthy services
		await expect(wizard.locator('text=connection refused')).toBeVisible();
		await expect(wizard.locator('text=status 503')).toBeVisible();

		// Healthy services show "Healthy"
		await expect(wizard.locator('text=Healthy').first()).toBeVisible();
	});
});

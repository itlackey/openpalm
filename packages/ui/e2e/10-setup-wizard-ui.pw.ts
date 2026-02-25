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

		await openWizard(page);

		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
		await expect(page.locator('.wizard h2')).toContainText('Profile');
		await fillProfileStep(page);
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
		await expect(page.locator('.wizard h2')).toContainText('AI Providers');
		await fillProvidersStep(page);
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
		await expect(page.locator('.wizard h2')).toContainText('Security');
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
		await expect(page.locator('.wizard h2')).toContainText('Channels');
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
		await expect(page.locator('.wizard h2')).toContainText('Access');
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
		await expect(page.locator('.wizard h2')).toContainText('Health Check');

		await page.locator('.wizard .actions button', { hasText: 'Finish Setup' }).click();

		await expect(page.locator('.wiz-error.visible').first()).toContainText('Setup failed:');
		await expect(
			page.locator('.wizard .actions button', { hasText: 'Finish Setup' })
		).toBeEnabled();
	});
});

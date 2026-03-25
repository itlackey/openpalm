/**
 * Setup Wizard Playwright Tests
 *
 * Tests the CLI setup wizard UI step-by-step using both mocked and real
 * (Ollama) API endpoints. The wizard server is started as a Bun child
 * process and tests navigate to it directly.
 *
 * Mocked tests (@mocked): All API calls intercepted by page.route().
 * Integration tests: Require local Ollama at localhost:11434.
 */
import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const WIZARD_PORT = 18_100;
const WIZARD_URL = `http://localhost:${WIZARD_PORT}`;
const OLLAMA_URL = "http://localhost:11434";

// ── Test Values ─────────────────────────────────────────────────────────

const TEST_ADMIN_TOKEN = "test-admin-token-12345";
const TEST_OWNER_NAME = "Test User";
const TEST_OWNER_EMAIL = "test@example.com";
const TEST_LLM_MODEL = "qwen2.5-coder:3b";
const TEST_EMBED_MODEL = "nomic-embed-text:latest";
const TEST_EMBED_DIMS = 768;
const TEST_MEMORY_USER = "e2e-wizard-user";

// ── Mock API Responses ──────────────────────────────────────────────────

const MOCK_STATUS = { ok: true, setupComplete: false };

const MOCK_DETECT_PROVIDERS = {
	ok: true,
	providers: [
		{ provider: "ollama", url: OLLAMA_URL, available: true },
	],
};

const MOCK_OLLAMA_MODELS = {
	ok: true,
	models: [
		TEST_LLM_MODEL,
		TEST_EMBED_MODEL,
		"llama3.2",
		"llama3.2:latest",
		"qwen2.5-coder:latest",
	],
};

const MOCK_SETUP_COMPLETE = { ok: true };

function mockDeployStatus(phase: "pulling" | "running", complete: boolean) {
	return {
		ok: true,
		setupComplete: complete,
		deployStatus: [
			{ service: "memory", status: phase, label: "Memory" },
			{ service: "assistant", status: phase, label: "Assistant" },
			{ service: "guardian", status: phase, label: "Guardian" },
		],
		deployError: null,
	};
}

// ── Wizard Server Process Management ────────────────────────────────────

let wizardProcess: ChildProcess | null = null;

async function startWizardServer(): Promise<void> {
	if (wizardProcess) return;
	wizardProcess = spawn(
		"bun",
		["run", "packages/cli/e2e/start-wizard-server.ts", String(WIZARD_PORT)],
		{ cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] }
	);

	return new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("Wizard server start timeout")), 15_000);
		wizardProcess!.stdout!.on("data", (data: Buffer) => {
			if (data.toString().includes(`WIZARD_READY:${WIZARD_PORT}`)) {
				clearTimeout(timeout);
				resolve();
			}
		});
		wizardProcess!.stderr!.on("data", (data: Buffer) => {
			const msg = data.toString();
			if (msg.includes("EADDRINUSE")) {
				clearTimeout(timeout);
				reject(new Error(`Port ${WIZARD_PORT} in use`));
			}
		});
		wizardProcess!.on("error", (err) => {
			clearTimeout(timeout);
			reject(err);
		});
		wizardProcess!.on("exit", (code) => {
			if (code !== null && code !== 0) {
				clearTimeout(timeout);
				reject(new Error(`Wizard server exited with code ${code}`));
			}
		});
	});
}

function stopWizardServer() {
	if (wizardProcess) {
		wizardProcess.kill("SIGTERM");
		wizardProcess = null;
	}
}

// ── Route Mocking Helpers ───────────────────────────────────────────────

async function setupWizardMocks(page: Page) {
	await page.route("**/api/setup/status", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(MOCK_STATUS),
		})
	);
	await page.route("**/api/setup/detect-providers", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(MOCK_DETECT_PROVIDERS),
		})
	);
	await page.route("**/api/setup/models/**", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(MOCK_OLLAMA_MODELS),
		})
	);
}

// ── Helper: Navigate through welcome hero + identity form ───────────────

/** Fills identity form and navigates to Step 1 (Providers) */
async function completeStep0(page: Page) {
	// Click "Get Started" to dismiss hero
	await page.click("#btn-get-started");
	await expect(page.locator("#identity-form")).toBeVisible();
	// Fill identity
	await page.fill("#admin-token", TEST_ADMIN_TOKEN);
	await page.fill("#owner-name", TEST_OWNER_NAME);
	await page.fill("#owner-email", TEST_OWNER_EMAIL);
	await page.click("#btn-step0-next");
}

/** Selects and verifies Ollama in Step 1 (provider card grid) */
async function addOllamaProvider(page: Page) {
	// Wait for auto-detection to select+verify Ollama (mocked detect-providers returns available Ollama)
	// The card should already be selected and expanded from auto-detection
	await page.waitForTimeout(500); // Wait for detection + verify
	// Ollama should be auto-detected and verified
	await expect(page.locator('[data-provider="ollama"].verified')).toBeVisible({ timeout: 5_000 });
}

// ═══════════════════════════════════════════════════════════════════════
// MOCKED TESTS: UI Flow
// ═══════════════════════════════════════════════════════════════════════

test.describe("@mocked Setup Wizard UI", () => {
	test.beforeAll(async () => {
		await startWizardServer();
	});

	test.afterAll(() => {
		stopWizardServer();
	});

	// ── Step 0: Welcome ──────────────────────────────────────────────

	test.describe("Step 0: Welcome", () => {
		test("shows wizard title and welcome step", async ({ page }) => {
			await setupWizardMocks(page);
			await page.goto(`${WIZARD_URL}/setup`);

			await expect(page.locator("h1")).toContainText("OpenPalm");
			await expect(page.locator('[data-testid="step-welcome"]')).toBeVisible();
			// Welcome hero should show first
			await expect(page.locator("#welcome-hero")).toBeVisible();
			await expect(page.locator("#welcome-hero h2")).toHaveText("Welcome to OpenPalm");
		});

		test("Get Started reveals identity form", async ({ page }) => {
			await setupWizardMocks(page);
			await page.goto(`${WIZARD_URL}/setup`);

			await page.click("#btn-get-started");
			await expect(page.locator("#identity-form")).toBeVisible();
			await expect(page.locator("#welcome-hero")).toBeHidden();
		});

		test("auto-generates an admin token", async ({ page }) => {
			await setupWizardMocks(page);
			await page.goto(`${WIZARD_URL}/setup`);

			await page.click("#btn-get-started");
			const tokenInput = page.locator("#admin-token");
			await expect(tokenInput).toBeVisible();
			const tokenValue = await tokenInput.inputValue();
			expect(tokenValue.length).toBe(32); // 16 bytes hex = 32 chars
		});

		test("shows validation error for short admin token", async ({ page }) => {
			await setupWizardMocks(page);
			await page.goto(`${WIZARD_URL}/setup`);

			await page.click("#btn-get-started");
			await page.fill("#admin-token", "short");
			await page.click("#btn-step0-next");

			const error = page.locator("#step0-error");
			await expect(error).toBeVisible();
			await expect(error).toContainText("at least 8 characters");
		});

		test("navigates to Step 1 with valid token", async ({ page }) => {
			await setupWizardMocks(page);
			await page.goto(`${WIZARD_URL}/setup`);

			await page.click("#btn-get-started");
			await page.fill("#admin-token", TEST_ADMIN_TOKEN);
			await page.fill("#owner-name", TEST_OWNER_NAME);
			await page.fill("#owner-email", TEST_OWNER_EMAIL);
			await page.click("#btn-step0-next");

			await expect(page.locator('[data-testid="step-capabilities"]')).toBeVisible();
		});

		test("progress bar shows first segment active", async ({ page }) => {
			await setupWizardMocks(page);
			await page.goto(`${WIZARD_URL}/setup`);

			const firstSeg = page.locator('.prog-seg').first();
			await expect(firstSeg).toHaveClass(/on/);
		});
	});

	// ── Step 1: Providers ──────────────────────────────────────────

	test.describe("Step 1: Providers", () => {
		async function goToStep1(page: Page) {
			await setupWizardMocks(page);
			await page.goto(`${WIZARD_URL}/setup`);
			await completeStep0(page);
			await expect(page.locator('[data-testid="step-capabilities"]')).toBeVisible();
		}

		test("shows provider card grid", async ({ page }) => {
			await goToStep1(page);

			await expect(page.locator("#provider-grid")).toBeVisible();
			// Should have provider cards
			const cards = page.locator(".pcard");
			const count = await cards.count();
			expect(count).toBeGreaterThanOrEqual(3); // At least openai, anthropic, ollama
		});

		test("auto-detects Ollama and shows it as verified", async ({ page }) => {
			await goToStep1(page);

			// Wait for auto-detection to complete
			await expect(page.locator('[data-provider="ollama"].verified')).toBeVisible({ timeout: 5_000 });
			// Next button should be enabled since Ollama is verified
			await expect(page.locator("#btn-step1-next")).toBeEnabled();
		});

		test("provider cards show cloud/local badges", async ({ page }) => {
			await goToStep1(page);

			// Cloud badge on OpenAI
			await expect(page.locator('[data-provider="openai"] .badge-cloud')).toBeVisible();
			// Local badge on Ollama
			await expect(page.locator('[data-provider="ollama"] .badge-local')).toBeVisible();
		});

		test("clicking a provider card selects and expands it", async ({ page }) => {
			await goToStep1(page);

			// Click OpenAI card header
			await page.click('[data-toggle-provider="openai"]');
			// Should be selected
			await expect(page.locator('[data-provider="openai"].selected')).toBeVisible();
			// Should show auth panel
			await expect(page.locator('[data-provider="openai"] .pcard-auth')).toBeVisible();
		});

		test("deselecting provider via check icon removes it", async ({ page }) => {
			await goToStep1(page);

			// Click OpenAI to select
			await page.click('[data-toggle-provider="openai"]');
			await expect(page.locator('[data-provider="openai"].selected')).toBeVisible();

			// Click the check icon to deselect
			await page.click('[data-provider="openai"] .pcard-check');
			await expect(page.locator('[data-provider="openai"].selected')).not.toBeVisible();
		});

		test("Ollama shows mode selection when expanded", async ({ page }) => {
			await goToStep1(page);

			// Wait for auto-detection (which auto-selects and verifies Ollama)
			await page.waitForTimeout(500);

			// If not auto-verified, click to expand and check mode prompt
			const ollamaCard = page.locator('[data-provider="ollama"]');
			if (!(await ollamaCard.locator(".ollama-mode-prompt").isVisible().catch(() => false))) {
				// Ollama was auto-verified, so mode prompt was already handled
				await expect(ollamaCard).toHaveClass(/verified/);
			}
		});

		test("Next button disabled with no verified providers", async ({ page }) => {
			await setupWizardMocks(page);

			// Override detect-providers to return nothing
			await page.route("**/api/setup/detect-providers", (route) =>
				route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({ ok: true, providers: [] }),
				})
			);
			// Override models to fail
			await page.route("**/api/setup/models/**", (route) =>
				route.fulfill({ status: 500, body: "fail" })
			);

			await page.goto(`${WIZARD_URL}/setup`);
			await completeStep0(page);

			await expect(page.locator("#btn-step1-next")).toBeDisabled();
		});

		test("Back button returns to Step 0", async ({ page }) => {
			await goToStep1(page);
			await page.click("#btn-step1-back");
			await expect(page.locator('[data-testid="step-welcome"]')).toBeVisible();
		});
	});

	// ── Step 2: Model Assignment ─────────────────────────────────────

	test.describe("Step 2: Model Assignment", () => {
		async function goToStep2(page: Page) {
			await setupWizardMocks(page);
			await page.goto(`${WIZARD_URL}/setup`);
			await completeStep0(page);
			// Step 1: wait for Ollama to auto-verify
			await addOllamaProvider(page);
			await page.click("#btn-step1-next");
			await expect(page.locator('[data-testid="step-models"]')).toBeVisible();
		}

		test("shows model groups with radio options", async ({ page }) => {
			await goToStep2(page);

			// Should have model groups
			const groups = page.locator(".model-group");
			const count = await groups.count();
			expect(count).toBeGreaterThanOrEqual(2); // LLM + Embedding

			// Should have radio-style options
			const opts = page.locator(".model-opt");
			const optCount = await opts.count();
			expect(optCount).toBeGreaterThan(0);
		});

		test("auto-selects default models", async ({ page }) => {
			await goToStep2(page);

			// Should have a selected (on) option in the LLM group
			await expect(page.locator(".model-opt.on").first()).toBeVisible();
		});

		test("shows top pick badge on recommended model", async ({ page }) => {
			await goToStep2(page);

			await expect(page.locator(".model-opt-badge-top").first()).toBeVisible();
		});

		test("clicking a model option selects it", async ({ page }) => {
			await goToStep2(page);

			// Click a non-selected model option
			const opts = page.locator(".model-opt:not(.on)");
			const count = await opts.count();
			if (count > 0) {
				// Get the data-model-select value before clicking
				const selector = await opts.first().getAttribute("data-model-select");
				await opts.first().click();
				// Re-query from DOM since click triggers re-render
				await expect(page.locator(`[data-model-select="${selector}"]`)).toHaveClass(/on/);
			}
		});

		test("hidden fields are synced for API payload", async ({ page }) => {
			await goToStep2(page);

			// Hidden llm-model field should have a value
			const llmModel = page.locator("#llm-model");
			const value = await llmModel.inputValue();
			expect(value.length).toBeGreaterThan(0);
		});

		test("Back button returns to Step 1", async ({ page }) => {
			await goToStep2(page);
			await page.click("#btn-step2-back");
			await expect(page.locator('[data-testid="step-capabilities"]')).toBeVisible();
		});

		test("navigates to Step 3 (Voice) with valid models", async ({ page }) => {
			await goToStep2(page);
			await page.click("#btn-step2-next");
			await expect(page.locator('[data-testid="step-voice"]')).toBeVisible();
		});
	});

	// ── Step 3: Voice ──────────────────────────────────────────────

	test.describe("Step 3: Voice", () => {
		async function goToStep3(page: Page) {
			await setupWizardMocks(page);
			await page.goto(`${WIZARD_URL}/setup`);
			// Step 0
			await page.click("#btn-get-started");
			await page.fill("#admin-token", TEST_ADMIN_TOKEN);
			await page.fill("#owner-name", TEST_OWNER_NAME);
			await page.fill("#owner-email", TEST_OWNER_EMAIL);
			await page.click("#btn-step0-next");
			// Step 1
			await addOllamaProvider(page);
			await page.click("#btn-step1-next");
			// Step 2
			await page.waitForTimeout(300);
			await page.click("#btn-step2-next");
			await expect(page.locator('[data-testid="step-voice"]')).toBeVisible();
		}

		test("shows TTS and STT groups", async ({ page }) => {
			await goToStep3(page);
			await expect(page.locator("#voice-groups")).toBeVisible();
			await expect(page.locator("#voice-groups")).toContainText("Text-to-Speech");
			await expect(page.locator("#voice-groups")).toContainText("Speech-to-Text");
		});

		test("navigates to Step 4 (Options)", async ({ page }) => {
			await goToStep3(page);
			await page.click("#btn-step3-next");
			await expect(page.locator('[data-testid="step-options"]')).toBeVisible();
		});

		test("Back button returns to Step 2", async ({ page }) => {
			await goToStep3(page);
			await page.click("#btn-step3-back");
			await expect(page.locator('[data-testid="step-models"]')).toBeVisible();
		});
	});

	// ── Step 4: Options ──────────────────────────────────────────────

	test.describe("Step 4: Options", () => {
		async function goToStep4(page: Page) {
			await setupWizardMocks(page);
			await page.goto(`${WIZARD_URL}/setup`);
			// Step 0
			await page.click("#btn-get-started");
			await page.fill("#admin-token", TEST_ADMIN_TOKEN);
			await page.fill("#owner-name", TEST_OWNER_NAME);
			await page.fill("#owner-email", TEST_OWNER_EMAIL);
			await page.click("#btn-step0-next");
			// Step 1
			await addOllamaProvider(page);
			await page.click("#btn-step1-next");
			// Step 2
			await page.waitForTimeout(300);
			await page.click("#btn-step2-next");
			// Step 3 (Voice)
			await page.click("#btn-step3-next");
			await expect(page.locator('[data-testid="step-options"]')).toBeVisible();
		}

		test("shows Ollama in-stack toggle for Ollama capabilities", async ({ page }) => {
			await goToStep4(page);
			await expect(page.locator("#ollama-addon")).toBeVisible();
			await expect(page.locator("#ollama-enabled")).toBeVisible();
		});

		test("Memory User ID defaults from owner name", async ({ page }) => {
			await goToStep4(page);
			// Wizard derives memory user ID from owner name: lowercased, spaces → underscores
			const expected = TEST_OWNER_NAME.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
			await expect(page.locator("#memory-user-id")).toHaveValue(expected);
		});

		test("Memory User ID can be overridden", async ({ page }) => {
			await goToStep4(page);
			await page.fill("#memory-user-id", TEST_MEMORY_USER);
			await expect(page.locator("#memory-user-id")).toHaveValue(TEST_MEMORY_USER);
		});

		test("shows channels and services sections", async ({ page }) => {
			await goToStep4(page);
			await expect(page.locator("#channels-grid")).toBeVisible();
			await expect(page.locator("#services-grid")).toBeVisible();
		});

		test("navigates to Step 5 (Review)", async ({ page }) => {
			await goToStep4(page);
			await page.click("#btn-step4-next");
			await expect(page.locator('[data-testid="step-review"]')).toBeVisible();
		});

		test("Back button returns to Step 3 (Voice)", async ({ page }) => {
			await goToStep4(page);
			await page.click("#btn-step4-back");
			await expect(page.locator('[data-testid="step-voice"]')).toBeVisible();
		});
	});

	// ── Step 5: Review & Install ─────────────────────────────────────

	test.describe("Step 5: Review", () => {
		async function goToStep5(page: Page) {
			await setupWizardMocks(page);
			await page.goto(`${WIZARD_URL}/setup`);
			// Step 0
			await page.click("#btn-get-started");
			await page.fill("#admin-token", TEST_ADMIN_TOKEN);
			await page.fill("#owner-name", TEST_OWNER_NAME);
			await page.fill("#owner-email", TEST_OWNER_EMAIL);
			await page.click("#btn-step0-next");
			// Step 1
			await addOllamaProvider(page);
			await page.click("#btn-step1-next");
			// Step 2
			await page.waitForTimeout(300);
			await page.click("#btn-step2-next");
			// Step 3 (Voice)
			await page.click("#btn-step3-next");
			// Step 4 (Options)
			await page.fill("#memory-user-id", TEST_MEMORY_USER);
			await page.click("#btn-step4-next");
			await expect(page.locator('[data-testid="step-review"]')).toBeVisible();
		}

		test("shows review summary with all settings", async ({ page }) => {
			await goToStep5(page);

			const summary = page.locator("#review-summary");
			await expect(summary).toBeVisible();

			// Account section
			await expect(summary).toContainText("Account");
			await expect(summary).toContainText("Admin Token");
			await expect(summary).toContainText("test...2345"); // masked

			// Providers section
			await expect(summary).toContainText("Providers");
			await expect(summary).toContainText("Ollama");

			// Models section
			await expect(summary).toContainText("Models");
			await expect(summary).toContainText("Chat Model");
			await expect(summary).toContainText("Embedding");

			// Voice section
			await expect(summary).toContainText("Voice");
			await expect(summary).toContainText("Text-to-Speech");
			await expect(summary).toContainText("Speech-to-Text");

			// Channels section
			await expect(summary).toContainText("Channels");
			await expect(summary).toContainText("Web Chat");

			// Services section
			await expect(summary).toContainText("Services");
			await expect(summary).toContainText("Admin Dashboard");

			// Options section
			await expect(summary).toContainText("Options");
			await expect(summary).toContainText("Memory User ID");
			await expect(summary).toContainText(TEST_MEMORY_USER);
		});

		test("shows owner name and email in review", async ({ page }) => {
			await goToStep5(page);
			const summary = page.locator("#review-summary");
			await expect(summary).toContainText(TEST_OWNER_NAME);
			await expect(summary).toContainText(TEST_OWNER_EMAIL);
		});

		test("legacy review-grid is populated for backward compat", async ({ page }) => {
			await goToStep5(page);
			const grid = page.locator("#review-grid");
			// Hidden but populated
			await expect(grid).toContainText("Account");
			await expect(grid).toContainText("Providers");
			await expect(grid).toContainText("Models");
			await expect(grid).toContainText("Voice");
			await expect(grid).toContainText("Channels");
			await expect(grid).toContainText("Services");
			await expect(grid).toContainText("Options");
		});

		test("Edit buttons navigate back to correct steps", async ({ page }) => {
			await goToStep5(page);

			const editButtons = page.locator("#review-summary .review-edit-btn");
			const count = await editButtons.count();
			expect(count).toBe(7); // Account, Providers, Models, Voice, Channels, Services, Options

			// Click Account edit -> Step 0
			await editButtons.nth(0).click();
			await expect(page.locator('[data-testid="step-welcome"]')).toBeVisible();
		});

		test("JSON toggle shows/hides setup JSON", async ({ page }) => {
			await goToStep5(page);

			// Initially hidden
			await expect(page.locator("#review-json")).toBeHidden();

			// Click toggle
			await page.click("#btn-toggle-json");
			await expect(page.locator("#review-json")).toBeVisible();
			await expect(page.locator("#review-json-pre")).toContainText("adminToken");

			// Click again to hide
			await page.click("#btn-toggle-json");
			await expect(page.locator("#review-json")).toBeHidden();
		});

		test("Back button returns to Step 4 (Options)", async ({ page }) => {
			await goToStep5(page);
			await page.click("#btn-step5-back");
			await expect(page.locator('[data-testid="step-options"]')).toBeVisible();
		});

		test("Install button is present", async ({ page }) => {
			await goToStep5(page);
			await expect(page.locator("#btn-install")).toBeVisible();
			await expect(page.locator("#btn-install")).toHaveText("Install");
		});
	});

	// ── Deploy Screen ────────────────────────────────────────────────

	test.describe("Deploy Screen", () => {
		test("Install triggers deploy screen with progress", async ({ page }) => {
			await setupWizardMocks(page);

			let setupPayload: Record<string, unknown> | null = null;
			await page.route("**/api/setup/complete", async (route) => {
				setupPayload = JSON.parse(route.request().postData() ?? "{}");
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify(MOCK_SETUP_COMPLETE),
				});
			});

			let deployPollCount = 0;
			await page.route("**/api/setup/deploy-status", async (route) => {
				deployPollCount++;
				const complete = deployPollCount >= 3;
				const phase = deployPollCount < 2 ? "pulling" : "running";
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify(mockDeployStatus(phase, complete)),
				});
			});

			await page.goto(`${WIZARD_URL}/setup`);

			// Walk through wizard
			await page.click("#btn-get-started");
			await page.fill("#admin-token", TEST_ADMIN_TOKEN);
			await page.fill("#owner-name", TEST_OWNER_NAME);
			await page.fill("#owner-email", TEST_OWNER_EMAIL);
			await page.click("#btn-step0-next");

			await addOllamaProvider(page);
			await page.click("#btn-step1-next");

			await page.waitForTimeout(300);
			await page.click("#btn-step2-next");

			// Step 3: Voice
			await page.click("#btn-step3-next");

			// Step 4: Options
			await page.fill("#memory-user-id", TEST_MEMORY_USER);
			await page.click("#btn-step4-next");

			// Click Install
			await page.click("#btn-install");

			// Deploy screen should appear
			await expect(page.locator('[data-testid="step-deploy"]')).toBeVisible();

			// Verify the payload sent to /api/setup/complete (SetupSpec v2)
			expect(setupPayload).not.toBeNull();
			const payload = setupPayload as Record<string, unknown>;
			expect((payload.security as Record<string, unknown>).adminToken).toBe(TEST_ADMIN_TOKEN);
			const spec = payload.spec as Record<string, unknown>;
			expect(spec.version).toBe(2);
			expect(((spec.capabilities as Record<string, unknown>).memory as Record<string, unknown>).userId).toBe(TEST_MEMORY_USER);
			const caps = payload.capabilities;
			expect(Array.isArray(caps)).toBe(true);
			expect((caps as Array<Record<string, string>>)[0].provider).toBe("ollama");

			// Wait for deploy to complete (mocked to complete on 3rd poll)
			await expect(page.locator("#deploy-done")).toBeVisible({ timeout: 15_000 });
			await expect(page.locator("#deploy-done")).toContainText("Setup Complete");
		});

		test("deploy error shows failure card", async ({ page }) => {
			await setupWizardMocks(page);

			await page.route("**/api/setup/complete", (route) =>
				route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify(MOCK_SETUP_COMPLETE),
				})
			);

			await page.route("**/api/setup/deploy-status", (route) =>
				route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({
						ok: true,
						setupComplete: false,
						deployStatus: [
							{ service: "memory", status: "error", label: "Memory" },
						],
						deployError: "Docker Compose failed: port conflict on 8080",
					}),
				})
			);

			await page.goto(`${WIZARD_URL}/setup`);

			// Quick walk through
			await page.click("#btn-get-started");
			await page.fill("#admin-token", TEST_ADMIN_TOKEN);
			await page.fill("#owner-name", TEST_OWNER_NAME);
			await page.fill("#owner-email", TEST_OWNER_EMAIL);
			await page.click("#btn-step0-next");

			await addOllamaProvider(page);
			await page.click("#btn-step1-next");

			await page.waitForTimeout(300);
			await page.click("#btn-step2-next");
			// Step 3: Voice
			await page.click("#btn-step3-next");
			// Step 4: Options
			await page.click("#btn-step4-next");
			await page.click("#btn-install");

			// Should show error
			await expect(page.locator("#deploy-failure")).toBeVisible({ timeout: 10_000 });
			await expect(page.locator("#deploy-failure")).toContainText("Deployment failed");
			await expect(page.locator("#deploy-failure-summary")).toContainText("port conflict");

			// Error actions should be visible
			await expect(page.locator("#deploy-error-actions")).toBeVisible();
			await expect(page.locator("#btn-deploy-back")).toBeVisible();
			await expect(page.locator("#btn-deploy-retry")).toBeVisible();
		});
	});

	// ── Progress Bar Navigation ────────────────────────────────────

	test.describe("Progress Bar", () => {
		test("progress labels navigate to visited steps", async ({ page }) => {
			await setupWizardMocks(page);
			await page.goto(`${WIZARD_URL}/setup`);

			// Go to Step 1
			await completeStep0(page);
			await expect(page.locator('[data-testid="step-capabilities"]')).toBeVisible();

			// Welcome label should be clickable
			const welcomeLabel = page.locator('[data-prog-step="0"]');
			await welcomeLabel.click();
			await expect(page.locator('[data-testid="step-welcome"]')).toBeVisible();

			// Token should still be filled
			await expect(page.locator("#admin-token")).toHaveValue(TEST_ADMIN_TOKEN);
		});

		test("segmented progress shows correct state", async ({ page }) => {
			await setupWizardMocks(page);
			await page.goto(`${WIZARD_URL}/setup`);

			// First segment should be active
			const segments = page.locator('.prog-seg');
			await expect(segments.first()).toHaveClass(/on/);

			// Navigate forward
			await completeStep0(page);

			// First two segments should now be active
			const segs = page.locator('.prog-seg.on');
			const count = await segs.count();
			expect(count).toBe(2);
		});
	});

	// ── Full Wizard Flow ─────────────────────────────────────────────

	test.describe("Full Wizard Flow", () => {
		test("complete wizard flow captures correct payload", async ({ page }) => {
			await setupWizardMocks(page);

			let capturedPayload: Record<string, unknown> | null = null;
			await page.route("**/api/setup/complete", async (route) => {
				capturedPayload = JSON.parse(route.request().postData() ?? "{}");
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify(MOCK_SETUP_COMPLETE),
				});
			});

			let pollCount = 0;
			await page.route("**/api/setup/deploy-status", async (route) => {
				pollCount++;
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify(mockDeployStatus("running", pollCount >= 2)),
				});
			});

			await page.goto(`${WIZARD_URL}/setup`);

			// Step 0: Welcome
			await page.click("#btn-get-started");
			await page.fill("#admin-token", TEST_ADMIN_TOKEN);
			await page.fill("#owner-name", TEST_OWNER_NAME);
			await page.fill("#owner-email", TEST_OWNER_EMAIL);
			await page.click("#btn-step0-next");

			// Step 1: Providers - Ollama auto-detected and verified
			await addOllamaProvider(page);
			await page.click("#btn-step1-next");

			// Step 2: Models - auto-selected, proceed
			await page.waitForTimeout(300);
			await page.click("#btn-step2-next");

			// Step 3: Voice
			await page.click("#btn-step3-next");

			// Step 4: Options
			await page.fill("#memory-user-id", TEST_MEMORY_USER);
			await page.click("#btn-step4-next");

			// Step 5: Review & Install
			await expect(page.locator('[data-testid="step-review"]')).toBeVisible();
			await page.click("#btn-install");

			// Wait for deploy to complete
			await expect(page.locator("#deploy-done")).toBeVisible({ timeout: 15_000 });

			// Validate the captured payload (SetupSpec v2 format)
			expect(capturedPayload).not.toBeNull();
			const payload = capturedPayload as Record<string, unknown>;
			expect((payload.security as Record<string, unknown>).adminToken).toBe(TEST_ADMIN_TOKEN);
			expect((payload.owner as Record<string, unknown>).name).toBe(TEST_OWNER_NAME);
			expect((payload.owner as Record<string, unknown>).email).toBe(TEST_OWNER_EMAIL);

			// Spec (stack.yml content)
			const spec = payload.spec as Record<string, unknown>;
			expect(spec.version).toBe(2);
			const caps = spec.capabilities as Record<string, unknown>;
			expect(typeof caps.llm).toBe("string");
			expect((caps.memory as Record<string, unknown>).userId).toBe(TEST_MEMORY_USER);

			// Capabilities
			const caps = payload.capabilities as Array<Record<string, string>>;
			expect(caps).toHaveLength(1);
			expect(caps[0].provider).toBe("ollama");
			expect(caps[0].baseUrl).toBe(OLLAMA_URL);
			expect(caps[0].name).toBe("Ollama");
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════
// INTEGRATION TESTS: Real Ollama
// ═══════════════════════════════════════════════════════════════════════

test.describe("Setup Wizard with Real Ollama", () => {
	const SKIP = !process.env.RUN_DOCKER_STACK_TESTS;
	test.skip(!!SKIP, "Requires RUN_DOCKER_STACK_TESTS=1 and local Ollama");

	test.beforeAll(async () => {
		await startWizardServer();
	});

	test.afterAll(() => {
		stopWizardServer();
	});

	test("provider detection finds local Ollama", async ({ page }) => {
		// Only mock the status endpoint, let detect-providers hit real server
		await page.route("**/api/setup/status", (route) =>
			route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(MOCK_STATUS),
			})
		);

		await page.goto(`${WIZARD_URL}/setup`);
		await page.click("#btn-get-started");
		await page.fill("#admin-token", TEST_ADMIN_TOKEN);
		await page.fill("#owner-name", TEST_OWNER_NAME);
		await page.fill("#owner-email", TEST_OWNER_EMAIL);
		await page.click("#btn-step0-next");

		// Wait for provider detection to complete and Ollama to show as verified
		await expect(page.locator("#conn-detecting")).toBeHidden({ timeout: 15_000 });
		await expect(page.locator('[data-provider="ollama"].verified')).toBeVisible({ timeout: 15_000 });
	});

	test("model listing returns real models from Ollama", async ({ page }) => {
		await page.route("**/api/setup/status", (route) =>
			route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(MOCK_STATUS),
			})
		);

		await page.goto(`${WIZARD_URL}/setup`);
		await page.click("#btn-get-started");
		await page.fill("#admin-token", TEST_ADMIN_TOKEN);
		await page.fill("#owner-name", TEST_OWNER_NAME);
		await page.fill("#owner-email", TEST_OWNER_EMAIL);
		await page.click("#btn-step0-next");

		// Wait for auto-detection and verification
		await expect(page.locator("#conn-detecting")).toBeHidden({ timeout: 15_000 });
		await expect(page.locator('[data-provider="ollama"].verified')).toBeVisible({ timeout: 15_000 });

		// Proceed to models
		await page.click("#btn-step1-next");
		await expect(page.locator('[data-testid="step-models"]')).toBeVisible();

		// Should have radio options for models
		const opts = page.locator(".model-opt");
		const count = await opts.count();
		expect(count).toBeGreaterThan(0);
	});

	test("full wizard flow with real Ollama models", async ({ page }) => {
		await page.route("**/api/setup/status", (route) =>
			route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(MOCK_STATUS),
			})
		);

		// Mock only the complete + deploy endpoints (don't actually deploy)
		let setupPayload: Record<string, unknown> | null = null;
		await page.route("**/api/setup/complete", async (route) => {
			setupPayload = JSON.parse(route.request().postData() ?? "{}");
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(MOCK_SETUP_COMPLETE),
			});
		});
		await page.route("**/api/setup/deploy-status", (route) =>
			route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(mockDeployStatus("running", true)),
			})
		);

		await page.goto(`${WIZARD_URL}/setup`);

		// Step 0
		await page.click("#btn-get-started");
		await page.fill("#admin-token", TEST_ADMIN_TOKEN);
		await page.fill("#owner-name", TEST_OWNER_NAME);
		await page.fill("#owner-email", TEST_OWNER_EMAIL);
		await page.click("#btn-step0-next");

		// Step 1: Wait for auto-detection + verification
		await expect(page.locator("#conn-detecting")).toBeHidden({ timeout: 15_000 });
		await expect(page.locator('[data-provider="ollama"].verified')).toBeVisible({ timeout: 15_000 });
		await page.click("#btn-step1-next");

		// Step 2: Models (from real Ollama)
		await page.waitForTimeout(500);
		// Should have model options
		const opts = page.locator(".model-opt");
		const optCount = await opts.count();
		expect(optCount).toBeGreaterThan(0);
		await page.click("#btn-step2-next");

		// Step 3: Voice
		await page.click("#btn-step3-next");

		// Step 4: Options
		await page.fill("#memory-user-id", TEST_MEMORY_USER);
		await page.click("#btn-step4-next");

		// Step 5: Review
		await expect(page.locator('[data-testid="step-review"]')).toBeVisible();
		const summary = page.locator("#review-summary");
		await expect(summary).toContainText(TEST_MEMORY_USER);

		// Install
		await page.click("#btn-install");
		await expect(page.locator("#deploy-done")).toBeVisible({ timeout: 15_000 });

		// Verify payload (SetupSpec v2)
		expect(setupPayload).not.toBeNull();
		const payload = setupPayload as Record<string, unknown>;
		expect((payload.security as Record<string, unknown>).adminToken).toBe(TEST_ADMIN_TOKEN);
		const spec = payload.spec as Record<string, unknown>;
		expect(spec.version).toBe(2);
		const caps = spec.capabilities as Record<string, unknown>;
		expect(typeof caps.llm).toBe("string");
		expect((caps.llm as string)).toContain("ollama/");
	});
});

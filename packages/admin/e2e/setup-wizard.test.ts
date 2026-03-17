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
			{ service: "caddy", status: phase, label: "Reverse Proxy" },
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

			await expect(page.locator("h1")).toHaveText("OpenPalm Setup");
			await expect(page.locator('[data-testid="step-welcome"]')).toBeVisible();
			await expect(page.locator("h2").first()).toHaveText("Welcome");
		});

		test("auto-generates an admin token", async ({ page }) => {
			await setupWizardMocks(page);
			await page.goto(`${WIZARD_URL}/setup`);

			const tokenInput = page.locator("#admin-token");
			await expect(tokenInput).toBeVisible();
			const tokenValue = await tokenInput.inputValue();
			expect(tokenValue.length).toBe(32); // 16 bytes hex = 32 chars
		});

		test("shows validation error for short admin token", async ({ page }) => {
			await setupWizardMocks(page);
			await page.goto(`${WIZARD_URL}/setup`);

			await page.fill("#admin-token", "short");
			await page.click("#btn-step0-next");

			const error = page.locator("#step0-error");
			await expect(error).toBeVisible();
			await expect(error).toContainText("at least 8 characters");
		});

		test("navigates to Step 1 with valid token", async ({ page }) => {
			await setupWizardMocks(page);
			await page.goto(`${WIZARD_URL}/setup`);

			await page.fill("#admin-token", TEST_ADMIN_TOKEN);
			await page.fill("#owner-name", TEST_OWNER_NAME);
			await page.fill("#owner-email", TEST_OWNER_EMAIL);
			await page.click("#btn-step0-next");

			await expect(page.locator('[data-testid="step-connections"]')).toBeVisible();
		});

		test("step indicators show step 1 as active", async ({ page }) => {
			await setupWizardMocks(page);
			await page.goto(`${WIZARD_URL}/setup`);

			const step1Dot = page.locator('.step-dot[data-step="0"]');
			await expect(step1Dot).toHaveClass(/active/);
		});
	});

	// ── Step 1: Connections ──────────────────────────────────────────

	test.describe("Step 1: Connections", () => {
		async function goToStep1(page: Page) {
			await setupWizardMocks(page);
			await page.goto(`${WIZARD_URL}/setup`);
			await page.fill("#admin-token", TEST_ADMIN_TOKEN);
			await page.click("#btn-step0-next");
			await expect(page.locator('[data-testid="step-connections"]')).toBeVisible();
		}

		test("shows empty state with no connections", async ({ page }) => {
			await goToStep1(page);

			await expect(page.locator("#conn-hub-empty")).toBeVisible();
			await expect(page.locator("#conn-hub-empty")).toContainText("No connections yet");
			await expect(page.locator("#btn-step1-next")).toBeDisabled();
		});

		test("Add Connection button shows type chooser", async ({ page }) => {
			await goToStep1(page);

			await page.click("#btn-step1-add");
			await expect(page.locator("#conn-type-chooser")).toBeVisible();
			await expect(page.locator("#btn-add-cloud")).toBeVisible();
			await expect(page.locator("#btn-add-local")).toBeVisible();
		});

		test("selecting Local Provider shows detected Ollama", async ({ page }) => {
			await goToStep1(page);
			await page.click("#btn-step1-add");
			await page.click("#btn-add-local");

			// The connection form should appear
			await expect(page.locator("#conn-detail-form")).toBeVisible();
			// Badge should say "Local"
			await expect(page.locator("#conn-mode-badge")).toHaveText("Local");
			// Detected Ollama should be listed
			await expect(page.locator("#local-provider-list")).toBeVisible();
			await expect(page.locator(".provider-option")).toHaveCount(1);
			await expect(page.locator(".provider-option")).toContainText("Ollama");
		});

		test("clicking detected Ollama fills connection fields", async ({ page }) => {
			await goToStep1(page);
			await page.click("#btn-step1-add");
			await page.click("#btn-add-local");

			// Click the detected Ollama provider
			await page.click(".provider-option");

			await expect(page.locator("#conn-name")).toHaveValue("Ollama");
			await expect(page.locator("#conn-base-url")).toHaveValue(OLLAMA_URL);
		});

		test("Test button shows success with mocked models", async ({ page }) => {
			await goToStep1(page);
			await page.click("#btn-step1-add");
			await page.click("#btn-add-local");
			await page.click(".provider-option");
			await page.click("#btn-conn-test");

			await expect(page.locator("#conn-test-success")).toBeVisible();
			await expect(page.locator("#conn-test-msg")).toContainText("Connected");
			await expect(page.locator("#conn-test-msg")).toContainText("model");
		});

		test("Save Connection adds entry to connection list", async ({ page }) => {
			await goToStep1(page);
			await page.click("#btn-step1-add");
			await page.click("#btn-add-local");
			await page.click(".provider-option");
			await page.click("#btn-conn-save");

			// Connection list should now be visible
			await expect(page.locator("#conn-hub-list")).toBeVisible();
			await expect(page.locator(".hub-row")).toHaveCount(1);
			await expect(page.locator(".hub-row-name")).toContainText("Ollama");
			// Next button should be enabled
			await expect(page.locator("#btn-step1-next")).toBeEnabled();
		});

		test("Cancel button returns to hub without saving", async ({ page }) => {
			await goToStep1(page);
			await page.click("#btn-step1-add");
			await page.click("#btn-add-local");
			await page.click("#btn-conn-cancel");

			await expect(page.locator("#conn-hub-empty")).toBeVisible();
			await expect(page.locator("#btn-step1-next")).toBeDisabled();
		});

		test("Edit button re-opens form with saved values", async ({ page }) => {
			await goToStep1(page);

			// Add a connection first
			await page.click("#btn-step1-add");
			await page.click("#btn-add-local");
			await page.click(".provider-option");
			await page.click("#btn-conn-save");

			// Click Edit
			await page.click('[data-action="edit"]');

			await expect(page.locator("#conn-detail-form")).toBeVisible();
			await expect(page.locator("#conn-name")).toHaveValue("Ollama");
			await expect(page.locator("#conn-base-url")).toHaveValue(OLLAMA_URL);
		});

		test("Remove button removes connection from list", async ({ page }) => {
			await goToStep1(page);

			// Add a connection
			await page.click("#btn-step1-add");
			await page.click("#btn-add-local");
			await page.click(".provider-option");
			await page.click("#btn-conn-save");
			await expect(page.locator(".hub-row")).toHaveCount(1);

			// Remove it
			await page.click('[data-action="remove"]');
			await expect(page.locator("#conn-hub-empty")).toBeVisible();
			await expect(page.locator("#btn-step1-next")).toBeDisabled();
		});

		test("cloud provider shows API key field and provider chips", async ({ page }) => {
			await goToStep1(page);
			await page.click("#btn-step1-add");
			await page.click("#btn-add-cloud");

			await expect(page.locator("#conn-detail-form")).toBeVisible();
			await expect(page.locator("#conn-mode-badge")).toHaveText("Cloud");
			await expect(page.locator("#conn-apikey-group")).toBeVisible();
			await expect(page.locator("#cloud-provider-picks")).toBeVisible();
			// Should have provider chips
			const chips = page.locator(".provider-chip");
			await expect(chips.first()).toBeVisible();
		});

		test("Save requires connection name", async ({ page }) => {
			await goToStep1(page);
			await page.click("#btn-step1-add");
			await page.click("#btn-add-local");
			await page.fill("#conn-name", "");
			await page.fill("#conn-base-url", OLLAMA_URL);
			await page.click("#btn-conn-save");

			await expect(page.locator("#conn-detail-error")).toBeVisible();
			await expect(page.locator("#conn-detail-error")).toContainText("name is required");
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
			// Step 0
			await page.fill("#admin-token", TEST_ADMIN_TOKEN);
			await page.click("#btn-step0-next");
			// Step 1: add Ollama connection
			await page.click("#btn-step1-add");
			await page.click("#btn-add-local");
			await page.click(".provider-option");
			await page.click("#btn-conn-save");
			await page.click("#btn-step1-next");
			await expect(page.locator('[data-testid="step-models"]')).toBeVisible();
		}

		test("connection dropdowns are populated with saved connection", async ({ page }) => {
			await goToStep2(page);

			const llmConn = page.locator("#llm-connection");
			const embConn = page.locator("#emb-connection");
			await expect(llmConn).toBeVisible();
			await expect(embConn).toBeVisible();

			// Should have the Ollama connection as an option
			const llmOptions = llmConn.locator("option:not([disabled])");
			await expect(llmOptions).toHaveCount(1);
			await expect(llmOptions.first()).toContainText("Ollama");
		});

		test("model lists are populated from mocked API", async ({ page }) => {
			await goToStep2(page);

			// Wait for models to load (option with our test model appears)
			const llmModel = page.locator("#llm-model");
			await expect(llmModel.locator(`option[value="${TEST_LLM_MODEL}"]`)).toBeAttached({ timeout: 5_000 });

			// Should have our mocked models as selectable options
			const options = llmModel.locator("option");
			const count = await options.count();
			expect(count).toBeGreaterThanOrEqual(2);
		});

		test("embedding dims auto-filled for nomic-embed-text", async ({ page }) => {
			await goToStep2(page);

			// Wait for models to load, then check emb-model has nomic-embed-text
			const embModel = page.locator("#emb-model");
			await page.waitForTimeout(500); // Wait for model fetch

			// Select nomic-embed-text if not already selected
			const embModelValue = await embModel.inputValue();
			if (embModelValue !== TEST_EMBED_MODEL) {
				await embModel.selectOption(TEST_EMBED_MODEL);
			}

			// Dims should be auto-filled to 768
			await expect(page.locator("#emb-dims")).toHaveValue(String(TEST_EMBED_DIMS));
		});

		test("validation requires chat model selection", async ({ page }) => {
			await goToStep2(page);

			// Clear the LLM model selection
			const llmModel = page.locator("#llm-model");
			await page.waitForTimeout(300);
			// Try to select empty value
			await llmModel.evaluate((el: HTMLSelectElement) => {
				el.value = "";
			});
			await page.click("#btn-step2-next");

			await expect(page.locator("#step2-error")).toBeVisible();
		});

		test("Back button returns to Step 1", async ({ page }) => {
			await goToStep2(page);
			await page.click("#btn-step2-back");
			await expect(page.locator('[data-testid="step-connections"]')).toBeVisible();
		});

		test("navigates to Step 3 with valid models", async ({ page }) => {
			await goToStep2(page);
			await page.waitForTimeout(500); // Wait for model fetch
			await page.click("#btn-step2-next");
			await expect(page.locator('[data-testid="step-options"]')).toBeVisible();
		});
	});

	// ── Step 3: Options ──────────────────────────────────────────────

	test.describe("Step 3: Options", () => {
		async function goToStep3(page: Page) {
			await setupWizardMocks(page);
			await page.goto(`${WIZARD_URL}/setup`);
			// Step 0
			await page.fill("#admin-token", TEST_ADMIN_TOKEN);
			await page.fill("#owner-email", TEST_OWNER_EMAIL);
			await page.click("#btn-step0-next");
			// Step 1
			await page.click("#btn-step1-add");
			await page.click("#btn-add-local");
			await page.click(".provider-option");
			await page.click("#btn-conn-save");
			await page.click("#btn-step1-next");
			// Step 2
			await page.waitForTimeout(500);
			await page.click("#btn-step2-next");
			await expect(page.locator('[data-testid="step-options"]')).toBeVisible();
		}

		test("shows Ollama in-stack toggle for Ollama connections", async ({ page }) => {
			await goToStep3(page);
			await expect(page.locator("#ollama-addon")).toBeVisible();
			await expect(page.locator("#ollama-enabled")).toBeVisible();
		});

		test("Memory User ID defaults from email", async ({ page }) => {
			await goToStep3(page);
			await expect(page.locator("#memory-user-id")).toHaveValue(TEST_OWNER_EMAIL);
		});

		test("Memory User ID can be overridden", async ({ page }) => {
			await goToStep3(page);
			await page.fill("#memory-user-id", TEST_MEMORY_USER);
			await expect(page.locator("#memory-user-id")).toHaveValue(TEST_MEMORY_USER);
		});

		test("navigates to Step 4 (Review)", async ({ page }) => {
			await goToStep3(page);
			await page.click("#btn-step3-next");
			await expect(page.locator('[data-testid="step-review"]')).toBeVisible();
		});

		test("Back button returns to Step 2", async ({ page }) => {
			await goToStep3(page);
			await page.click("#btn-step3-back");
			await expect(page.locator('[data-testid="step-models"]')).toBeVisible();
		});
	});

	// ── Step 4: Review & Install ─────────────────────────────────────

	test.describe("Step 4: Review", () => {
		async function goToStep4(page: Page) {
			await setupWizardMocks(page);
			await page.goto(`${WIZARD_URL}/setup`);
			// Step 0
			await page.fill("#admin-token", TEST_ADMIN_TOKEN);
			await page.fill("#owner-name", TEST_OWNER_NAME);
			await page.fill("#owner-email", TEST_OWNER_EMAIL);
			await page.click("#btn-step0-next");
			// Step 1
			await page.click("#btn-step1-add");
			await page.click("#btn-add-local");
			await page.click(".provider-option");
			await page.click("#btn-conn-save");
			await page.click("#btn-step1-next");
			// Step 2
			await page.waitForTimeout(500);
			await page.click("#btn-step2-next");
			// Step 3
			await page.fill("#memory-user-id", TEST_MEMORY_USER);
			await page.click("#btn-step3-next");
			await expect(page.locator('[data-testid="step-review"]')).toBeVisible();
		}

		test("shows review grid with all settings", async ({ page }) => {
			await goToStep4(page);

			const grid = page.locator("#review-grid");
			await expect(grid).toBeVisible();

			// Account section
			await expect(grid).toContainText("Account");
			await expect(grid).toContainText("Admin Token");
			// Token should be masked (showing first 4 and last 4)
			await expect(grid).toContainText("test...2345");

			// Connections section
			await expect(grid).toContainText("Connections");
			await expect(grid).toContainText("Ollama");

			// Models section
			await expect(grid).toContainText("Models");
			await expect(grid).toContainText("Chat Model");
			await expect(grid).toContainText("Embedding Model");
			await expect(grid).toContainText("Embedding Dims");

			// Options section
			await expect(grid).toContainText("Options");
			await expect(grid).toContainText("Memory User ID");
			await expect(grid).toContainText(TEST_MEMORY_USER);
		});

		test("shows owner name and email in review", async ({ page }) => {
			await goToStep4(page);
			const grid = page.locator("#review-grid");
			await expect(grid).toContainText(TEST_OWNER_NAME);
			await expect(grid).toContainText(TEST_OWNER_EMAIL);
		});

		test("Edit buttons navigate back to correct steps", async ({ page }) => {
			await goToStep4(page);

			const editButtons = page.locator(".review-edit-btn");
			const count = await editButtons.count();
			expect(count).toBe(4); // Account, Connections, Models, Options

			// Click Account edit → Step 0
			await editButtons.nth(0).click();
			await expect(page.locator('[data-testid="step-welcome"]')).toBeVisible();
		});

		test("Back button returns to Step 3", async ({ page }) => {
			await goToStep4(page);
			await page.click("#btn-step4-back");
			await expect(page.locator('[data-testid="step-options"]')).toBeVisible();
		});

		test("Install button is present", async ({ page }) => {
			await goToStep4(page);
			await expect(page.locator("#btn-install")).toBeVisible();
			await expect(page.locator("#btn-install")).toHaveText("Install");
		});
	});

	// ── Deploy Screen ────────────────────────────────────────────────

	test.describe("Deploy Screen", () => {
		test("Install triggers deploy screen with progress", async ({ page }) => {
			await setupWizardMocks(page);

			// Mock the complete and deploy-status endpoints
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
			await page.fill("#admin-token", TEST_ADMIN_TOKEN);
			await page.fill("#owner-name", TEST_OWNER_NAME);
			await page.click("#btn-step0-next");

			await page.click("#btn-step1-add");
			await page.click("#btn-add-local");
			await page.click(".provider-option");
			await page.click("#btn-conn-save");
			await page.click("#btn-step1-next");

			await page.waitForTimeout(500);
			await page.click("#btn-step2-next");

			await page.fill("#memory-user-id", TEST_MEMORY_USER);
			await page.click("#btn-step3-next");

			// Click Install
			await page.click("#btn-install");

			// Deploy screen should appear
			await expect(page.locator('[data-testid="step-deploy"]')).toBeVisible();

			// Verify the payload sent to /api/setup/complete
			expect(setupPayload).not.toBeNull();
			expect((setupPayload as Record<string, unknown>).adminToken).toBe(TEST_ADMIN_TOKEN);
			expect((setupPayload as Record<string, unknown>).memoryUserId).toBe(TEST_MEMORY_USER);
			const conns = (setupPayload as Record<string, unknown>).connections;
			expect(Array.isArray(conns)).toBe(true);
			expect((conns as Array<Record<string, string>>)[0].provider).toBe("ollama");

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
							{ service: "caddy", status: "error", label: "Reverse Proxy" },
						],
						deployError: "Docker Compose failed: port conflict on 8080",
					}),
				})
			);

			await page.goto(`${WIZARD_URL}/setup`);

			// Quick walk through
			await page.fill("#admin-token", TEST_ADMIN_TOKEN);
			await page.click("#btn-step0-next");
			await page.click("#btn-step1-add");
			await page.click("#btn-add-local");
			await page.click(".provider-option");
			await page.click("#btn-conn-save");
			await page.click("#btn-step1-next");
			await page.waitForTimeout(500);
			await page.click("#btn-step2-next");
			await page.click("#btn-step3-next");
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

	// ── Step Indicator Navigation ────────────────────────────────────

	test.describe("Step Indicators", () => {
		test("step dots navigate to visited steps", async ({ page }) => {
			await setupWizardMocks(page);
			await page.goto(`${WIZARD_URL}/setup`);

			// Go to Step 1
			await page.fill("#admin-token", TEST_ADMIN_TOKEN);
			await page.click("#btn-step0-next");
			await expect(page.locator('[data-testid="step-connections"]')).toBeVisible();

			// Step 0 dot should be clickable (completed)
			const step0Dot = page.locator('.step-dot[data-step="0"]');
			await expect(step0Dot).toHaveClass(/completed/);
			await step0Dot.click();
			await expect(page.locator('[data-testid="step-welcome"]')).toBeVisible();

			// Token should still be filled
			await expect(page.locator("#admin-token")).toHaveValue(TEST_ADMIN_TOKEN);
		});

		test("future step dots are disabled", async ({ page }) => {
			await setupWizardMocks(page);
			await page.goto(`${WIZARD_URL}/setup`);

			const step2Dot = page.locator('.step-dot[data-step="2"]');
			await expect(step2Dot).toBeDisabled();
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
			await page.fill("#admin-token", TEST_ADMIN_TOKEN);
			await page.fill("#owner-name", TEST_OWNER_NAME);
			await page.fill("#owner-email", TEST_OWNER_EMAIL);
			await page.click("#btn-step0-next");

			// Step 1: Add Ollama connection
			await page.click("#btn-step1-add");
			await page.click("#btn-add-local");
			await page.click(".provider-option");
			await page.click("#btn-conn-save");
			await page.click("#btn-step1-next");

			// Step 2: Models — wait for models to load, then select specific ones
			const llmModel = page.locator("#llm-model");
			await expect(llmModel.locator(`option[value="${TEST_LLM_MODEL}"]`)).toBeAttached({ timeout: 5_000 });
			await llmModel.selectOption(TEST_LLM_MODEL);

			const embModel = page.locator("#emb-model");
			await expect(embModel.locator(`option[value="${TEST_EMBED_MODEL}"]`)).toBeAttached({ timeout: 5_000 });
			await embModel.selectOption(TEST_EMBED_MODEL);
			// Wait for dims auto-fill
			await page.waitForTimeout(200);
			await page.click("#btn-step2-next");

			// Step 3: Options
			await page.fill("#memory-user-id", TEST_MEMORY_USER);
			await page.click("#btn-step3-next");

			// Step 4: Review & Install
			await expect(page.locator('[data-testid="step-review"]')).toBeVisible();
			await page.click("#btn-install");

			// Wait for deploy to complete
			await expect(page.locator("#deploy-done")).toBeVisible({ timeout: 15_000 });

			// Validate the captured payload
			expect(capturedPayload).not.toBeNull();
			const payload = capturedPayload as Record<string, unknown>;
			expect(payload.adminToken).toBe(TEST_ADMIN_TOKEN);
			expect(payload.ownerName).toBe(TEST_OWNER_NAME);
			expect(payload.ownerEmail).toBe(TEST_OWNER_EMAIL);
			expect(payload.memoryUserId).toBe(TEST_MEMORY_USER);

			// Connections
			const conns = payload.connections as Array<Record<string, string>>;
			expect(conns).toHaveLength(1);
			expect(conns[0].provider).toBe("ollama");
			expect(conns[0].baseUrl).toBe(OLLAMA_URL);
			expect(conns[0].name).toBe("Ollama");

			// Assignments
			const assignments = payload.assignments as Record<string, Record<string, unknown>>;
			expect(assignments.llm.connectionId).toBe(conns[0].id);
			expect(assignments.llm.model).toBe(TEST_LLM_MODEL);
			expect(assignments.embeddings.connectionId).toBe(conns[0].id);
			expect(assignments.embeddings.model).toBe(TEST_EMBED_MODEL);
			expect(assignments.embeddings.embeddingDims).toBe(TEST_EMBED_DIMS);
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
		await page.fill("#admin-token", TEST_ADMIN_TOKEN);
		await page.click("#btn-step0-next");

		// Wait for provider detection to complete (probes can take 6-9s if
		// unreachable endpoints like ollama:11434 timeout at 3s each)
		await expect(page.locator("#conn-detecting")).toBeHidden({ timeout: 15_000 });
		await page.click("#btn-step1-add");
		await page.click("#btn-add-local");

		// Should detect Ollama
		const ollamaOption = page.locator(".provider-option").filter({ hasText: "Ollama" });
		await expect(ollamaOption).toBeVisible({ timeout: 10_000 });
		await expect(ollamaOption).toContainText("Detected at");
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
		await page.fill("#admin-token", TEST_ADMIN_TOKEN);
		await page.click("#btn-step0-next");

		// Wait for provider detection to complete
		await expect(page.locator("#conn-detecting")).toBeHidden({ timeout: 15_000 });
		await page.click("#btn-step1-add");
		await page.click("#btn-add-local");

		// Select Ollama
		const ollamaOption = page.locator(".provider-option").filter({ hasText: "Ollama" });
		await ollamaOption.click();

		// Test connection - hits real Ollama
		await page.click("#btn-conn-test");

		// Should find real models
		await expect(page.locator("#conn-test-success")).toBeVisible({ timeout: 15_000 });
		await expect(page.locator("#conn-test-msg")).toContainText("Connected");
		await expect(page.locator("#conn-test-msg")).toContainText("model");
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
		await page.fill("#admin-token", TEST_ADMIN_TOKEN);
		await page.fill("#owner-name", TEST_OWNER_NAME);
		await page.fill("#owner-email", TEST_OWNER_EMAIL);
		await page.click("#btn-step0-next");

		// Step 1: Add Ollama (let detect + model list hit real Ollama)
		await expect(page.locator("#conn-detecting")).toBeHidden({ timeout: 15_000 });
		await page.click("#btn-step1-add");
		await page.click("#btn-add-local");
		const ollamaOption = page.locator(".provider-option").filter({ hasText: "Ollama" });
		await ollamaOption.click({ timeout: 10_000 });

		// Test connection against real Ollama
		await page.click("#btn-conn-test");
		await expect(page.locator("#conn-test-success")).toBeVisible({ timeout: 15_000 });

		// Save and proceed
		await page.click("#btn-conn-save");
		await page.click("#btn-step1-next");

		// Step 2: Models (fetched from real Ollama)
		await page.waitForTimeout(2000);

		// Verify real models appeared
		const llmModel = page.locator("#llm-model");
		const modelOptions = llmModel.locator("option");
		const optionCount = await modelOptions.count();
		expect(optionCount).toBeGreaterThan(0);

		// Select specific models we know exist
		await llmModel.selectOption(TEST_LLM_MODEL);
		const embModel = page.locator("#emb-model");
		await embModel.selectOption(TEST_EMBED_MODEL);
		await page.click("#btn-step2-next");

		// Step 3: Options
		await page.fill("#memory-user-id", TEST_MEMORY_USER);
		await page.click("#btn-step3-next");

		// Step 4: Review
		await expect(page.locator('[data-testid="step-review"]')).toBeVisible();
		const grid = page.locator("#review-grid");
		await expect(grid).toContainText(TEST_LLM_MODEL);
		await expect(grid).toContainText(TEST_EMBED_MODEL);
		await expect(grid).toContainText(TEST_MEMORY_USER);

		// Install
		await page.click("#btn-install");
		await expect(page.locator("#deploy-done")).toBeVisible({ timeout: 15_000 });

		// Verify payload
		expect(setupPayload).not.toBeNull();
		const payload = setupPayload as Record<string, unknown>;
		expect(payload.adminToken).toBe(TEST_ADMIN_TOKEN);
		const assignments = payload.assignments as Record<string, Record<string, unknown>>;
		expect(assignments.llm.model).toBe(TEST_LLM_MODEL);
		expect(assignments.embeddings.model).toBe(TEST_EMBED_MODEL);
		expect(assignments.embeddings.embeddingDims).toBe(TEST_EMBED_DIMS);
	});
});

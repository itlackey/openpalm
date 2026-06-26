import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as dotenvParse } from "dotenv";
// Pure secrets module (node:fs/path only — no Bun.env): single source of truth
// for the secret path/read, safe under the Playwright (node) runner.
import { readSecret } from "@openpalm/lib/control-plane/secrets-files";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
// STACK_ENV_PATH allows pointing at a test-isolated stack (e.g. .dev-test/knowledge/env/stack.env)
// so Playwright tests don't accidentally target a developer's running dev stack.
const STACK_ENV = process.env.STACK_ENV_PATH ?? resolve(REPO_ROOT, ".dev/knowledge/env/stack.env");
const OP_HOME_DIR = process.env.OP_HOME ?? resolve(REPO_ROOT, ".dev");
const BACKUP = `${STACK_ENV}.e2e-backup`;


export default async function globalSetup() {
	// Backfill the admin login from the file-based stack secret (via lib's
	// readSecret — the single source of truth for the secret path).
	if (!process.env.OP_UI_LOGIN_PASSWORD) {
		const password = readSecret(resolve(OP_HOME_DIR, "config/stack"), "op_ui_login_password");
		if (password) process.env.OP_UI_LOGIN_PASSWORD = password.trimEnd();
	}

	if (!existsSync(STACK_ENV)) return;
	const content = readFileSync(STACK_ENV, "utf8");

	// Load stack.env vars into process.env (backfill only) so integration
	// tests can use OP_HOST_UI_PORT, OP_ASSISTANT_PORT, etc.
	const stackVars = dotenvParse(content);
	for (const [key, value] of Object.entries(stackVars)) {
		if (!process.env[key] && value) {
			process.env[key] = value;
		}
	}

	// Build URL env vars from stack.env port vars so test files can use
	// process.env.ADMIN_URL without repeating port logic.
	if (!process.env.ADMIN_URL) {
		const adminPort = stackVars.OP_HOST_UI_PORT;
		if (adminPort) process.env.ADMIN_URL = `http://127.0.0.1:${adminPort}`;
	}
	if (!process.env.ASSISTANT_URL && stackVars.OP_ASSISTANT_PORT) {
		process.env.ASSISTANT_URL = `http://localhost:${stackVars.OP_ASSISTANT_PORT}`;
	}

	// Backup stack.env so global-teardown can restore it if any test mutates it.
	// (Pre-v0.11.0 this also flipped OP_SETUP_COMPLETE=false for wizard tests;
	// those tests were removed when the setup wizard migrated into SvelteKit,
	// so the override is no longer necessary and broke post-setup tests by
	// triggering the setup guard's redirect to /setup.)
	writeFileSync(BACKUP, content);
}

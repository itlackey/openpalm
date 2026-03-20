import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as dotenvParse } from "dotenv";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const STACK_ENV = resolve(REPO_ROOT, ".dev/vault/system.env");
const SECRETS_ENV = resolve(REPO_ROOT, ".dev/vault/user.env");
const BACKUP = `${STACK_ENV}.e2e-backup`;

export default async function globalSetup() {
	// Load user.env into process.env so integration tests can use
	// MEMORY_AUTH_TOKEN, MEMORY_USER_ID, etc. without manual env setup.
	// Only backfills — does not overwrite values already set by the caller.
	if (existsSync(SECRETS_ENV)) {
		const secrets = dotenvParse(readFileSync(SECRETS_ENV, "utf8"));
		for (const [key, value] of Object.entries(secrets)) {
			if (!process.env[key] && value) {
				process.env[key] = value;
			}
		}
	}

	if (!existsSync(STACK_ENV)) return;
	const content = readFileSync(STACK_ENV, "utf8");
	writeFileSync(BACKUP, content);
	writeFileSync(
		STACK_ENV,
		content.replace(
			/^OP_SETUP_COMPLETE=true$/m,
			"OP_SETUP_COMPLETE=false"
		)
	);
}

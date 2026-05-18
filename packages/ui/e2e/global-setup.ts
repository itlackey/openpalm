import { readFileSync, writeFileSync, existsSync, openSync, ftruncateSync, writeSync, closeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as dotenvParse } from "dotenv";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const STACK_ENV = resolve(REPO_ROOT, ".dev/config/stack/stack.env");
const SECRETS_ENV = resolve(REPO_ROOT, ".dev/stash/vaults/user.env");
const BACKUP = `${STACK_ENV}.e2e-backup`;

/**
 * Write to a file in-place (truncate + write) to preserve the inode.
 * Docker bind mounts track the inode — writeFileSync creates a new file
 * with a new inode, making the mounted file invisible to containers.
 * This function modifies the existing file, keeping the same inode so
 * containers with bind mounts continue to see the updated content.
 */
function writeInPlace(path: string, data: string): void {
	const fd = openSync(path, "r+");
	try {
		ftruncateSync(fd, 0);
		writeSync(fd, data, 0);
	} finally {
		closeSync(fd);
	}
}

export default async function globalSetup() {
	// Load user.env into process.env so integration tests can read user-managed
	// secrets without manual env setup.
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

	// Load stack.env vars into process.env (backfill only) so integration
	// tests can use OP_GUARDIAN_PORT, OP_ADMIN_PORT, etc.
	const stackVars = dotenvParse(content);
	for (const [key, value] of Object.entries(stackVars)) {
		if (!process.env[key] && value) {
			process.env[key] = value;
		}
	}

	// Backup stack.env so global-teardown can restore it if any test mutates it.
	// (Pre-v0.11.0 this also flipped OP_SETUP_COMPLETE=false for wizard tests;
	// those tests were removed when the setup wizard migrated into SvelteKit,
	// so the override is no longer necessary and broke post-setup tests by
	// triggering the setup guard's redirect to /setup.)
	writeFileSync(BACKUP, content);
}

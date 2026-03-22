import { readFileSync, writeFileSync, existsSync, openSync, ftruncateSync, writeSync, closeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as dotenvParse } from "dotenv";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const STACK_ENV = resolve(REPO_ROOT, ".dev/vault/stack/stack.env");
const SECRETS_ENV = resolve(REPO_ROOT, ".dev/vault/user/user.env");
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

	// Load stack.env vars into process.env (backfill only) so integration
	// tests can use OP_GUARDIAN_PORT, OP_ADMIN_PORT, etc.
	const stackVars = dotenvParse(content);
	for (const [key, value] of Object.entries(stackVars)) {
		if (!process.env[key] && value) {
			process.env[key] = value;
		}
	}

	writeFileSync(BACKUP, content);
	// Use in-place write to preserve the file inode. Docker bind mounts
	// (guardian secrets) reference the original inode — a regular
	// writeFileSync would create a new file invisible to the container.
	writeInPlace(
		STACK_ENV,
		content.replace(
			/^OP_SETUP_COMPLETE=true$/m,
			"OP_SETUP_COMPLETE=false"
		)
	);
}

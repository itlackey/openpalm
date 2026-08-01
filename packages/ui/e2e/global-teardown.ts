import { readFileSync, existsSync, unlinkSync, openSync, ftruncateSync, writeSync, closeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const STACK_ENV = process.env.STACK_ENV_PATH ?? resolve(REPO_ROOT, ".dev/state/stack.env");
const BACKUP = `${STACK_ENV}.e2e-backup`;
const OP_HOME_DIR = process.env.OP_HOME ?? resolve(REPO_ROOT, ".dev");
const STATE_ENV = resolve(OP_HOME_DIR, "state/stack.env");
const STATE_BACKUP = `${STATE_ENV}.e2e-backup`;
const WIZARD_BACKUP = `${STATE_ENV}.wizard-test-backup`;

/**
 * Write to a file in-place (truncate + write) to preserve the inode.
 * Docker bind mounts track the inode — writeFileSync creates a new file
 * with a new inode, making the mounted file invisible to containers.
 */
function writeInPlace(path: string, data: string): void {
	const fd = openSync(path, existsSync(path) ? "r+" : "w");
	try {
		ftruncateSync(fd, 0);
		writeSync(fd, data, 0);
	} finally {
		closeSync(fd);
	}
}

export default async function globalTeardown() {
	if (process.env.RUN_DOCKER_STACK_TESTS !== "1") return;

	// Recover state even when Playwright interrupts a wizard file before its
	// afterAll hook can restore the shared stack record.
	if (existsSync(WIZARD_BACKUP)) {
		writeInPlace(STATE_ENV, readFileSync(WIZARD_BACKUP, "utf8"));
		unlinkSync(WIZARD_BACKUP);
	}
	if (existsSync(BACKUP)) {
		// Restore stack.env in-place to preserve the file inode for
		// Docker bind mounts (guardian secrets file).
		writeInPlace(STACK_ENV, readFileSync(BACKUP, "utf8"));
		unlinkSync(BACKUP);
	}
	if (existsSync(STATE_BACKUP)) {
		writeInPlace(STATE_ENV, readFileSync(STATE_BACKUP, "utf8"));
		unlinkSync(STATE_BACKUP);
	}
}

import { readFileSync, existsSync, unlinkSync, openSync, ftruncateSync, writeSync, closeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const STACK_ENV = resolve(REPO_ROOT, ".dev/vault/stack/stack.env");
const BACKUP = `${STACK_ENV}.e2e-backup`;

/**
 * Write to a file in-place (truncate + write) to preserve the inode.
 * Docker bind mounts track the inode — writeFileSync creates a new file
 * with a new inode, making the mounted file invisible to containers.
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

export default async function globalTeardown() {
	if (!existsSync(BACKUP)) return;
	// Restore stack.env in-place to preserve the file inode for
	// Docker bind mounts (guardian secrets file).
	writeInPlace(STACK_ENV, readFileSync(BACKUP, "utf8"));
	unlinkSync(BACKUP);
}

import {
	closeSync,
	constants,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	writeSync
} from 'node:fs';
import { join } from 'node:path';

export type LeanLock = { path: string };

function holderIsAlive(path: string): boolean {
	try {
		const pid = Number.parseInt(readFileSync(path, 'utf8').split(/\r?\n/, 1)[0] ?? '', 10);
		if (!Number.isInteger(pid) || pid <= 0) return true;
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== 'ESRCH';
	}
}

function create(path: string): boolean {
	try {
		const descriptor = openSync(
			path,
			constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
			0o600
		);
		try {
			writeSync(descriptor, `${process.pid}\n${Date.now()}\n`);
		} finally {
			closeSync(descriptor);
		}
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
		throw error;
	}
}

export function acquireLeanLock(dataDir: string): LeanLock | null {
	mkdirSync(dataDir, { recursive: true });
	const path = join(dataDir, '.lifecycle.lock');
	if (create(path)) return { path };
	if (holderIsAlive(path)) return null;
	// Lifecycle lock files are generated coordination state, never user data.
	rmSync(path, { force: true });
	return create(path) ? { path } : null;
}

export function releaseLeanLock(lock: LeanLock | null): void {
	if (lock) rmSync(lock.path, { force: true });
}

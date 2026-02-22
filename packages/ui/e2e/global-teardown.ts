/**
 * Playwright global teardown: removes the temp directory created by env.ts.
 */
import { rmSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, '.e2e-state.json');

export default function globalTeardown() {
	if (!existsSync(STATE_FILE)) return;
	try {
		const { tmpDir } = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
		if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// best-effort cleanup
	}
	try {
		rmSync(STATE_FILE, { force: true });
	} catch {
		// ignore
	}
}

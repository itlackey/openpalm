import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string })
	.version;
const artifacts = join(root, 'artifacts');
mkdirSync(artifacts, { recursive: true });
const destination = join(artifacts, `openpalm-claude-desktop-${version}.mcpb`);

const process = Bun.spawn(['bun', 'run', 'mcpb', 'pack', 'dist', destination], {
	cwd: root,
	stdout: 'inherit',
	stderr: 'inherit'
});
const exitCode = await process.exited;
if (exitCode !== 0) throw new Error(`mcpb pack failed with exit code ${exitCode}`);
if (!existsSync(destination)) throw new Error(`mcpb did not create ${destination}`);
console.log(destination);

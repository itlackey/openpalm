import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const output = join(root, 'dist');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
	version: string;
};
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as Record<
	string,
	unknown
>;

rmSync(output, { recursive: true, force: true });
mkdirSync(join(output, 'server'), { recursive: true });

const result = await Bun.build({
	entrypoints: [join(root, 'src', 'index.ts')],
	target: 'node',
	format: 'esm',
	minify: true,
	sourcemap: 'none',
	outdir: join(output, 'server')
});
if (!result.success) {
	throw new Error(result.logs.map((entry) => entry.message).join('\n'));
}

manifest.version = packageJson.version;
writeFileSync(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
cpSync(join(root, 'README.md'), join(output, 'README.md'));

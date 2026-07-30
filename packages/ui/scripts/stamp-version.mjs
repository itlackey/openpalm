// Writes the package version and process-runtime-config capability marker into
// the UI build root.
// This stamp travels with the build wherever it goes — bundled into the Electron
// AppImage (extraResources) and materialized into OP_HOME/data/ui — so callers
// can confirm which UI build is actually on disk (see ui-assets.ts).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = join(pkgRoot, 'build');
if (!existsSync(buildDir)) {
  console.error(`[stamp-version] build dir not found at ${buildDir} — run the build first`);
  process.exit(1);
}
const { version } = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf-8'));
writeFileSync(join(buildDir, '.openpalm-ui-version'), `${version}\n`);
writeFileSync(join(buildDir, '.openpalm-runtime-config-endpoint-v1'), '1\n');
console.log(`[stamp-version] stamped UI build as ${version}`);

// Writes the package version into the UI build root as `.openpalm-ui-version`.
// This stamp travels with the build wherever it goes — bundled into the Electron
// AppImage (extraResources) and copied/extracted into OP_HOME/data/ui by
// seedUiBuild — so resolveUiBuildDir() can pick the NEWER of the two channels
// (see ui-assets.ts UI_VERSION_STAMP / resolveUiBuildDir).
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
console.log(`[stamp-version] stamped UI build as ${version}`);

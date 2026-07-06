// Writes the package version into the client build root as
// `.openpalm-client-version` — same pattern as packages/ui's stamp
// (`.openpalm-ui-version`): the stamp travels with the static bundle
// wherever it is copied/extracted so hosts can compare delivery channels
// by version (plan §3 exact-pin delivery; P5b, #555).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = join(pkgRoot, 'build');
if (!existsSync(buildDir)) {
  console.error(`[stamp-version] build dir not found at ${buildDir} — run the build first`);
  process.exit(1);
}
const { version } = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf-8'));
writeFileSync(join(buildDir, '.openpalm-client-version'), `${version}\n`);
console.log(`[stamp-version] stamped client build as ${version}`);

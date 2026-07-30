import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { c as createTar, x as extractTar } from 'tar';
import { PLATFORM_VERSION } from '@openpalm/lib';
import { materializeEmbeddedSkeleton, materializeEmbeddedUi } from './embedded-assets.ts';

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Build a real fixture tar.gz (a real file on disk — not `/$bunfs/`) with the given top-level entries. */
async function fixtureArchive(build: (sourceDir: string) => void): Promise<string> {
  const sourceDir = tempDir('embedded-fixture-src-');
  build(sourceDir);
  const archivePath = join(tempDir('embedded-fixture-out-'), 'fixture.tar.gz');
  await createTar(
    { gzip: true, file: archivePath, cwd: sourceDir, portable: true, noMtime: true, dot: true },
    readdirSync(sourceDir),
  );
  return archivePath;
}

describe('materializeEmbeddedUi', () => {
  test('extracts the embedded build into dataDir/ui when the stamp differs, stamping PLATFORM_VERSION', async () => {
    const archivePath = await fixtureArchive((src) => {
      writeFileSync(join(src, 'index.js'), 'export {};\n');
      writeFileSync(join(src, '.openpalm-ui-version'), `${PLATFORM_VERSION}\n`);
    });
    const dataDir = tempDir('embedded-ui-data-');

    const updated = await materializeEmbeddedUi(dataDir, archivePath);

    expect(updated).toBe(true);
    expect(existsSync(join(dataDir, 'ui', 'index.js'))).toBe(true);
    expect(readFileSync(join(dataDir, 'ui', '.openpalm-ui-version'), 'utf8').trim()).toBe(PLATFORM_VERSION);
  });

  test('no-ops when the existing stamp already matches PLATFORM_VERSION', async () => {
    const archivePath = await fixtureArchive((src) => {
      writeFileSync(join(src, 'index.js'), 'export { marker: "should not appear" };\n');
      writeFileSync(join(src, '.openpalm-ui-version'), `${PLATFORM_VERSION}\n`);
    });
    const dataDir = tempDir('embedded-ui-current-');
    mkdirSync(join(dataDir, 'ui'), { recursive: true });
    writeFileSync(join(dataDir, 'ui', 'index.js'), 'export { marker: "existing" };\n');
    writeFileSync(join(dataDir, 'ui', '.openpalm-ui-version'), `${PLATFORM_VERSION}\n`);

    const updated = await materializeEmbeddedUi(dataDir, archivePath);

    expect(updated).toBe(false);
    expect(readFileSync(join(dataDir, 'ui', 'index.js'), 'utf8')).toContain('existing');
  });

  test('a stale stamp is unconditionally replaced by the embedded copy — no backup, no rollback', async () => {
    const archivePath = await fixtureArchive((src) => {
      writeFileSync(join(src, 'index.js'), 'export { marker: "new" };\n');
      writeFileSync(join(src, '.openpalm-ui-version'), `${PLATFORM_VERSION}\n`);
    });
    const dataDir = tempDir('embedded-ui-stale-');
    mkdirSync(join(dataDir, 'ui'), { recursive: true });
    writeFileSync(join(dataDir, 'ui', 'index.js'), 'export { marker: "old" };\n');
    writeFileSync(join(dataDir, 'ui', '.openpalm-ui-version'), '0.0.1\n');

    const updated = await materializeEmbeddedUi(dataDir, archivePath);

    expect(updated).toBe(true);
    expect(readFileSync(join(dataDir, 'ui', 'index.js'), 'utf8')).toContain('new');
    expect(existsSync(join(dataDir, 'data', 'backups'))).toBe(false);
  });

  test('no-ops (does not throw) and leaves no partial directory when the archive is a dev placeholder (no index.js)', async () => {
    const archivePath = await fixtureArchive((src) => {
      writeFileSync(join(src, '.placeholder'), '');
    });
    const dataDir = tempDir('embedded-ui-placeholder-');

    const updated = await materializeEmbeddedUi(dataDir, archivePath);

    expect(updated).toBe(false);
    expect(existsSync(join(dataDir, 'ui'))).toBe(false);
    expect(readdirSync(dataDir)).toEqual([]);
  });

  test('leaves no partial directory when extraction fails outright', async () => {
    const badArchive = join(tempDir('embedded-ui-corrupt-'), 'corrupt.tar.gz');
    writeFileSync(badArchive, 'not a real gzip archive');
    const dataDir = tempDir('embedded-ui-corrupt-data-');
    mkdirSync(join(dataDir, 'ui'), { recursive: true });
    writeFileSync(join(dataDir, 'ui', 'index.js'), 'export { marker: "untouched" };\n');

    const updated = await materializeEmbeddedUi(dataDir, badArchive);

    expect(updated).toBe(false);
    // The pre-existing build is left exactly as it was...
    expect(readFileSync(join(dataDir, 'ui', 'index.js'), 'utf8')).toContain('untouched');
    // ...and no `.ui-embedded-*` scratch directory is left behind.
    expect(readdirSync(dataDir)).toEqual(['ui']);
  });
});

describe('materializeEmbeddedSkeleton', () => {
  test('extracts the embedded skeleton into a fresh directory', async () => {
    const archivePath = await fixtureArchive((src) => {
      mkdirSync(join(src, 'system', 'stack'), { recursive: true });
      writeFileSync(join(src, 'system', 'stack', 'core.compose.yml'), 'services: {}\n');
    });

    const extracted = await materializeEmbeddedSkeleton(archivePath);

    expect(extracted).not.toBeNull();
    if (extracted) {
      tempDirs.push(extracted);
      expect(existsSync(join(extracted, 'system', 'stack', 'core.compose.yml'))).toBe(true);
    }
  });

  test('returns null for a dev placeholder archive (no system/)', async () => {
    const archivePath = await fixtureArchive((src) => {
      writeFileSync(join(src, '.placeholder'), '');
    });

    expect(await materializeEmbeddedSkeleton(archivePath)).toBeNull();
  });

  test('returns null (does not throw) when extraction fails outright', async () => {
    const badArchive = join(tempDir('embedded-skel-corrupt-'), 'corrupt.tar.gz');
    writeFileSync(badArchive, 'not a real gzip archive');

    expect(await materializeEmbeddedSkeleton(badArchive)).toBeNull();
  });
});

// `bun run pack:embedded` overwrites the committed placeholders in place, so a
// developer who builds a binary locally is one `git add` away from committing a
// multi-megabyte real archive. These stay placeholders in git; release builds
// pack them on the fly (see scripts/pack-embedded-assets.ts).
describe('committed embedded archives', () => {
  const embeddedDir = join(import.meta.dir, '..', '..', 'embedded');

  for (const name of ['ui-build.tar.gz', 'skeleton.tar.gz']) {
    test(`${name} is still the placeholder, not a packed release archive`, async () => {
      const extracted = tempDir('embedded-committed-');
      await extractTar({ file: join(embeddedDir, name), cwd: extracted, strict: true });

      expect(readdirSync(extracted)).toEqual(['.placeholder']);
    });
  }
});

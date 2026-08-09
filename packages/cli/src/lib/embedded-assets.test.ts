import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { c as createTar } from 'tar';
import { PLATFORM_VERSION } from '@openpalm/lib';
import { materializeEmbeddedSkeleton, materializeEmbeddedUi, seedSkeletonFromEmbedded } from './embedded-assets.ts';

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

  test('no-ops (does not throw) and leaves no partial directory when the archive holds no index.js', async () => {
    const archivePath = await fixtureArchive((src) => {
      writeFileSync(join(src, 'stray.txt'), '');
    });
    const dataDir = tempDir('embedded-ui-no-index-');

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
  test('extracts the embedded skeleton into the persistent dataDir/skeleton, stamped with PLATFORM_VERSION', async () => {
    const archivePath = await fixtureArchive((src) => {
      mkdirSync(join(src, 'system', 'stack'), { recursive: true });
      writeFileSync(join(src, 'system', 'stack', 'core.compose.yml'), 'services: {}\n');
    });
    const dataDir = tempDir('embedded-skel-data-');

    const skeletonDir = await materializeEmbeddedSkeleton(dataDir, archivePath);

    expect(skeletonDir).toBe(join(dataDir, 'skeleton'));
    expect(existsSync(join(dataDir, 'skeleton', 'system', 'stack', 'core.compose.yml'))).toBe(true);
    expect(readFileSync(join(dataDir, 'skeleton', '.openpalm-skeleton-version'), 'utf8').trim()).toBe(PLATFORM_VERSION);
  });

  test('a matching stamp reuses the persistent dir without re-extracting', async () => {
    const archivePath = await fixtureArchive((src) => {
      mkdirSync(join(src, 'system'), { recursive: true });
      writeFileSync(join(src, 'system', 'first.txt'), 'first\n');
    });
    const dataDir = tempDir('embedded-skel-reuse-');
    await materializeEmbeddedSkeleton(dataDir, archivePath);
    // A sentinel the archive does not contain: it survives only if the second
    // call skips extraction entirely.
    writeFileSync(join(dataDir, 'skeleton', 'sentinel.txt'), 'kept\n');
    const differentArchive = await fixtureArchive((src) => {
      mkdirSync(join(src, 'system'), { recursive: true });
      writeFileSync(join(src, 'system', 'second.txt'), 'second\n');
    });

    const skeletonDir = await materializeEmbeddedSkeleton(dataDir, differentArchive);

    expect(skeletonDir).toBe(join(dataDir, 'skeleton'));
    expect(existsSync(join(dataDir, 'skeleton', 'sentinel.txt'))).toBe(true);
    expect(existsSync(join(dataDir, 'skeleton', 'system', 'second.txt'))).toBe(false);
  });

  test('a stale stamp re-extracts and atomically replaces the persistent dir', async () => {
    const archivePath = await fixtureArchive((src) => {
      mkdirSync(join(src, 'system'), { recursive: true });
      writeFileSync(join(src, 'system', 'fresh.txt'), 'fresh\n');
    });
    const dataDir = tempDir('embedded-skel-stale-');
    mkdirSync(join(dataDir, 'skeleton', 'system'), { recursive: true });
    writeFileSync(join(dataDir, 'skeleton', 'system', 'stale.txt'), 'stale\n');
    writeFileSync(join(dataDir, 'skeleton', '.openpalm-skeleton-version'), '0.0.1\n');

    const skeletonDir = await materializeEmbeddedSkeleton(dataDir, archivePath);

    expect(skeletonDir).toBe(join(dataDir, 'skeleton'));
    expect(existsSync(join(dataDir, 'skeleton', 'system', 'fresh.txt'))).toBe(true);
    expect(existsSync(join(dataDir, 'skeleton', 'system', 'stale.txt'))).toBe(false);
    // No `.previous-*` swap droppings survive a successful replacement.
    expect(readdirSync(dataDir)).toEqual(['skeleton']);
  });

  test('returns null for an archive that holds no system/ tree, leaving dataDir clean', async () => {
    const archivePath = await fixtureArchive((src) => {
      writeFileSync(join(src, 'stray.txt'), '');
    });
    const dataDir = tempDir('embedded-skel-no-system-');

    expect(await materializeEmbeddedSkeleton(dataDir, archivePath)).toBeNull();
    expect(existsSync(join(dataDir, 'skeleton'))).toBe(false);
  });

  test('returns null (does not throw) when extraction fails outright', async () => {
    const badArchive = join(tempDir('embedded-skel-corrupt-'), 'corrupt.tar.gz');
    writeFileSync(badArchive, 'not a real gzip archive');
    const dataDir = tempDir('embedded-skel-corrupt-data-');

    expect(await materializeEmbeddedSkeleton(dataDir, badArchive)).toBeNull();
  });
});

// Nothing is compiled in under `bun test` (packages/cli/embedded/ is generated
// by the release build and gitignored), so the default-argument calls below are
// the fresh-clone path: the dynamic `import(...)` of an absent asset must be
// caught, leaving local resolution to serve the UI/skeleton instead.
describe('with no archives compiled in', () => {
  test('materializeEmbeddedUi no-ops instead of throwing', async () => {
    const dataDir = tempDir('embedded-none-ui-');

    expect(await materializeEmbeddedUi(dataDir)).toBe(false);
    expect(existsSync(join(dataDir, 'ui'))).toBe(false);
  });

  test('materializeEmbeddedSkeleton returns null instead of throwing', async () => {
    expect(await materializeEmbeddedSkeleton(tempDir('embedded-none-skel-'))).toBeNull();
  });
});

describe('seedSkeletonFromEmbedded', () => {
  test('with nothing embedded, runs the seed callback under the ambient env and returns null', async () => {
    const calls: string[][] = [];
    const before = process.env.OPENPALM_SKELETON_DIR;

    const result = await seedSkeletonFromEmbedded(
      async (repoRef, homeDir, configDir, dataDir) => {
        calls.push([repoRef, homeDir, configDir, dataDir, process.env.OPENPALM_SKELETON_DIR ?? '<unset>']);
      },
      '/home-x', '/config-x', tempDir('embedded-seed-none-'),
    );

    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe(PLATFORM_VERSION);
    // Env untouched on the fallback path.
    expect(calls[0]?.[4]).toBe(before ?? '<unset>');
    expect(process.env.OPENPALM_SKELETON_DIR).toBe(before as string | undefined);
  });
});

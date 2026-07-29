import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');

describe('release asset contract', () => {
  test('the validator requires one complete product asset set', () => {
    const source = readFileSync(join(ROOT, 'scripts/validate-release-assets.mjs'), 'utf8');
    expect(source).toContain('openpalm-host-assets-${version}.tar.gz');
    expect(source).toContain('checksums-sha256.txt');
    expect(source).toContain('release-assets-manifest.json');
    expect(source).toContain('createHash');
  });
});
